-- The harness always rolls this probe back.
do $$
declare
  job uuid;
  installer uuid;
  foreman uuid;
  shift_id uuid := gen_random_uuid();
  unit_id uuid := gen_random_uuid();
  session_id uuid := gen_random_uuid();
  command_id uuid := gen_random_uuid();
  day_start timestamptz := '2001-01-02 08:00:00 America/Denver';
  shift_before jsonb;
  revision_before integer;
  fix jsonb;
begin
  perform pg_temp.dry_run_as_system();
  job := pg_temp.dry_run_job('FORGE-TRAIN-1103');
  if not public.is_sandbox_project(job)
      or not exists (select 1 from public.projects where id = job and is_test) then
    raise exception 'dry run: training job must be on the sandbox allowlist';
  end if;
  installer := pg_temp.dry_run_pick('installer');
  foreman := pg_temp.dry_run_pick('foreman');
  insert into public.time_shifts(id, profile_id, project_id, clock_in_at, clock_out_at, status, break_seconds)
    values (shift_id, installer, job, day_start, day_start + interval '1 hour', 'submitted', 0);
  insert into public.custom_work_units(id, project_id, created_by, label, facts)
    values (unit_id, job, installer, 'QA activity correction', '{}');
  insert into public.custom_work_sessions(id, profile_id, shift_id, project_id, unit_id, kind, stage,
      started_at, ended_at, outcome, workday_done_at, workday_machinery_ms)
    values (session_id, installer, shift_id, job, unit_id, 'unit', 'Flashing',
      day_start, day_start + interval '30 minutes', 'finished', day_start + interval '20 minutes', 120000);
  select to_jsonb(s) into shift_before from public.time_shifts s where s.id = shift_id;
  select revision into revision_before from public.custom_work_sessions where id = session_id;
  fix := jsonb_build_object('id', session_id, 'revision', revision_before,
    'description', 'Reviewed crew notes', 'outcome', 'partial', 'reason', 'Verified against the test activity');
  perform pg_temp.dry_run_act_as(foreman);
  perform public.custom_work_command(command_id, 'session', fix);
  perform public.custom_work_command(command_id, 'session', fix);
  perform pg_temp.dry_run_act_as(installer);
  perform public.save_workday_activity(gen_random_uuid(),
    jsonb_build_object('id', session_id, 'done', true, 'note', 'Older offline note', 'at', day_start + interval '20 minutes'));
  perform pg_temp.dry_run_as_system();
  perform pg_temp.dry_run_check('correction wins over replayed done tap and retains machinery evidence',
    exists (select 1 from public.custom_work_sessions where id = session_id and outcome = 'partial'
      and description = 'Reviewed crew notes' and workday_done_at is null and workday_machinery_ms = 120000), session_id::text);
  perform pg_temp.dry_run_check('one correction history row preserves attribution and original evidence',
    (select count(*) from public.custom_work_history where entity_id = session_id and action = 'session') = 1
    and exists (select 1 from public.custom_work_history where entity_id = session_id and actor_id = foreman
      and before_value->>'outcome' = 'finished' and after_value->>'outcome' = 'partial'), session_id::text);
  perform pg_temp.dry_run_check('activity correction leaves the paid shift untouched',
    shift_before = (select to_jsonb(s) from public.time_shifts s where s.id = shift_id), shift_id::text);
end $$;
