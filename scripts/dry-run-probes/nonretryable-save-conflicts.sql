-- Stale saves answer 409, not a retryable 40001 (20261130240000_nonretryable_save_conflicts.sql).
-- The one write is to the QA sandbox job's location; the harness always rolls this back.
do $$
declare
  job uuid;
  foreman uuid;
  fn record;
  seen integer := 0;
  bad text := '';
  code text;
begin
  perform pg_temp.dry_run_as_system();
  foreman := pg_temp.dry_run_pick('foreman');
  job := pg_temp.dry_run_sandbox_job();

  -- The migration patches the installed bodies in place, so read them back:
  -- nothing else proves what the live functions say after it.
  for fn in
    select p.oid, p.proname, p.prosecdef, pg_get_functiondef(p.oid) as def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f'
      and p.proname in ('set_project_location', 'file_daily_log', 'correct_stage_contributors',
                        'workflow_save_draft', 'workflow_publish_plan')
  loop
    seen := seen + 1;
    if fn.def ~* $re$errcode\s*=\s*'40001'$re$ or fn.def !~ $re$'PT409'$re$
       or not fn.prosecdef or fn.def !~* 'set search_path'
       or not has_function_privilege('authenticated', fn.oid, 'EXECUTE')
       or has_function_privilege('anon', fn.oid, 'EXECUTE') then
      bad := bad || fn.proname || ' ';
    end if;
  end loop;
  perform pg_temp.dry_run_check('all five conflict functions were found', seen = 5, seen::text);
  perform pg_temp.dry_run_check('each raises PT409, never 40001, and kept its definer, search path and grants',
    bad = '', bad);

  -- And one of them asked for real: a save made from an old copy of the job.
  perform pg_temp.dry_run_act_as(foreman);
  begin
    perform public.set_project_location(job, 'stale save', null, null,
      'an address this job never had ' || gen_random_uuid(), null, null);
    code := 'no error';
  exception when others then
    code := sqlstate;
  end;
  perform pg_temp.dry_run_check('a stale location save is refused with PT409', code = 'PT409', code);
end $$;
