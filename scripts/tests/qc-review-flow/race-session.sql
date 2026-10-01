-- psql variables supplied by the disposable shell harness, never live input.
set lock_timeout = '12s';
set statement_timeout = '20s';
select set_config('application_name', :'session', false);
select set_config('request.jwt.claim.sub', :'actor', false);
select set_config('fixture.qc_case', :'scenario', false);
select set_config('fixture.qc_request', :'request', false);
select set_config('fixture.qc_stale', :'stale', false);
set role authenticated;
begin;
\if :legacy_insert
  insert into qc_checks(project_opening_id,status,note)
    select opening,'callback','legacy winner' from qc_race_cases where name=current_setting('fixture.qc_case');
\elif :legacy_update
  -- This is the legacy writer's natural QC-first lock order, before its AFTER
  -- trigger inserts history and acquires the opening's implicit FK KEY SHARE.
  select q.id from qc_checks q join qc_race_cases c on c.opening=q.project_opening_id
    where c.name=current_setting('fixture.qc_case') for update of q;
\else
  do $$
  declare c qc_race_cases; receipt uuid;
  begin
    select * into strict c from qc_race_cases where name=current_setting('fixture.qc_case');
    if current_setting('fixture.qc_stale') = 'true' then
      begin
        perform record_qc_review_decision(current_setting('fixture.qc_request')::uuid,
          '00000000-0000-4000-8000-000000000202',c.opening,'passed',c.expected,'guarded review');
        raise exception 'Expected a stale QC refusal, but the write succeeded.';
      exception when serialization_failure then
        if position('QC changed' in sqlerrm) = 0 then raise; end if;
        insert into qc_race_results values(current_setting('application_name'),'stale');
      end;
    else
      receipt := record_qc_review_decision(current_setting('fixture.qc_request')::uuid,
        '00000000-0000-4000-8000-000000000202',c.opening,'passed',c.expected,'guarded review');
      if receipt is distinct from current_setting('fixture.qc_request')::uuid then
        raise exception 'Wrong saved receipt';
      end if;
      insert into qc_race_results values(current_setting('application_name'),'saved');
    end if;
  end $$;
\endif

\if :hold
  -- Deterministic gate inside this disposable container. The controlling
  -- process observes the second session's database lock wait before release.
  -- Bounded even if the controller fails; container cleanup is also trapped.
  \! touch /tmp/qc-race-ready
  \! n=0; while [ ! -f /tmp/qc-race-release ] && [ "$n" -lt 300 ]; do n=$((n+1)); sleep 0.05; done
\endif

\if :legacy_update
  update qc_checks set status='passed',note='legacy winner'
    where project_opening_id=(select opening from qc_race_cases where name=current_setting('fixture.qc_case'));
  insert into qc_race_results values(current_setting('application_name'),'legacy');
\elif :legacy_insert
  insert into qc_race_results values(current_setting('application_name'),'legacy');
\endif
commit;
