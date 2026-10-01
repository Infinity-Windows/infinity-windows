do $$
declare c qc_race_cases; n integer; s text; v text;
begin
  if (select count(*) from qc_race_results) <> 9 then raise exception 'Expected all 9 session receipts'; end if;
  if (select count(*) from qc_race_results where outcome='stale') <> 3 then raise exception 'Expected 3 stale refusals'; end if;
  if (select count(*) from qc_race_results where outcome='saved') <> 4 then raise exception 'Expected 4 saved/replayed receipts'; end if;
  if exists(select 1 from qc_decision_events where id in (
    '00000000-0000-4000-8000-000000000911',
    '00000000-0000-4000-8000-000000000912',
    '00000000-0000-4000-8000-000000000914')) then
    raise exception 'A losing request left an event behind';
  end if;
  for c in select * from qc_race_cases loop
    select count(*) into n from qc_decision_events where project_opening_id=c.opening;
    if n <> (case when c.name in ('legacy-update','guarded') then 2 else 1 end) then
      raise exception 'Wrong history count for %: %',c.name,n;
    end if;
    select status,review_version::text into s,v from qc_checks where project_opening_id=c.opening;
    if s <> (case when c.name='legacy-insert' then 'callback' else 'passed' end) then
      raise exception 'Winning decision lost on %',c.name;
    end if;
    if v=c.expected or v is null then raise exception 'Winner failed to rotate version on %',c.name; end if;
    select status into s from points_ledger where ref=c.opening::text;
    if s <> (case when c.name in ('legacy-insert','legacy-update') then 'pending' else 'confirmed' end) then
      raise exception 'Losing/repeated command changed points on %',c.name;
    end if;
  end loop;
end $$;
