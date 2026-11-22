-- Machinery time on a general activity (20261130120000_machinery_any_activity.sql).
-- The harness always rolls this probe back.
do $$
declare
  job uuid;
  installer uuid;
  shift_id uuid := gen_random_uuid();
  session_id uuid := gen_random_uuid();
  day_start timestamptz := '2001-01-03 08:00:00 America/Denver';
begin
  perform pg_temp.dry_run_as_system();
  job := pg_temp.dry_run_sandbox_job();
  installer := pg_temp.dry_run_pick('installer');
  insert into public.time_shifts(id, profile_id, project_id, clock_in_at, clock_out_at, status, break_seconds)
    values (shift_id, installer, job, day_start, day_start + interval '1 hour', 'submitted', 0);
  -- A general activity: no unit.
  insert into public.custom_work_sessions(id, profile_id, shift_id, project_id, unit_id, kind, stage,
      description, started_at, ended_at)
    values (session_id, installer, shift_id, job, null, 'idle', 'Idle time',
      'Staging', day_start, day_start + interval '30 minutes');

  perform pg_temp.dry_run_act_as(installer);
  perform public.save_workday_activity(gen_random_uuid(), jsonb_build_object(
    'id', session_id, 'at', day_start + interval '10 minutes', 'machinery_ms', 240000, 'machinery_running', false));
  perform pg_temp.dry_run_as_system();
  perform pg_temp.dry_run_check('machinery time is kept on an activity with no unit',
    exists (select 1 from public.custom_work_sessions where id = session_id
      and workday_machinery_ms = 240000 and workday_machinery_started_at is null), session_id::text);

  perform pg_temp.dry_run_act_as(installer);
  perform public.save_workday_activity(gen_random_uuid(), jsonb_build_object(
    'id', session_id, 'at', day_start + interval '20 minutes', 'machinery_ms', 99999999, 'machinery_running', false));
  perform public.save_workday_activity(gen_random_uuid(), jsonb_build_object(
    'id', session_id, 'at', day_start + interval '25 minutes', 'done', true));
  perform pg_temp.dry_run_as_system();
  perform pg_temp.dry_run_check('machinery time never exceeds the activity''s own time',
    (select workday_machinery_ms from public.custom_work_sessions where id = session_id) = 20 * 60 * 1000, session_id::text);
  perform pg_temp.dry_run_check('"done" is still only for unit work',
    (select workday_done_at is null from public.custom_work_sessions where id = session_id), session_id::text);
end $$;
