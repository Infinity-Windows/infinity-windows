-- Machine timers kept per activity (20261130150000_machine_timers.sql).
-- The harness always rolls this probe back.
do $$
declare
  job uuid;
  installer uuid;
  foreman uuid;
  shift_id uuid := gen_random_uuid();
  session_id uuid := gen_random_uuid();
  day_start timestamptz := '2001-01-03 08:00:00 America/Denver';
  receipt uuid := gen_random_uuid();
  spans jsonb;
begin
  perform pg_temp.dry_run_as_system();
  job := pg_temp.dry_run_sandbox_job();
  installer := pg_temp.dry_run_pick('installer');
  foreman := pg_temp.dry_run_pick('foreman');
  insert into public.time_shifts(id, profile_id, project_id, clock_in_at, clock_out_at, status, break_seconds)
    values (shift_id, installer, job, day_start, day_start + interval '2 hours', 'submitted', 0);
  -- Still running: the installer switches the machine while the activity is open.
  insert into public.custom_work_sessions(id, profile_id, shift_id, project_id, unit_id, kind, stage,
      description, started_at, ended_at)
    values (session_id, installer, shift_id, job, null, 'idle', 'Idle time', 'Staging', day_start, null);

  perform pg_temp.dry_run_act_as(installer);
  perform public.save_workday_activity(gen_random_uuid(), jsonb_build_object(
    'id', session_id, 'at', day_start + interval '10 minutes', 'machinery_ms', 0, 'machinery_running', true));
  perform public.save_workday_activity(gen_random_uuid(), jsonb_build_object(
    'id', session_id, 'at', day_start + interval '14 minutes', 'machinery_ms', 240000, 'machinery_running', false));
  perform public.save_workday_activity(gen_random_uuid(), jsonb_build_object(
    'id', session_id, 'at', day_start + interval '30 minutes', 'machinery_ms', 240000, 'machinery_running', true));
  perform pg_temp.dry_run_as_system();
  select workday_machinery_spans into spans from public.custom_work_sessions where id = session_id;
  perform pg_temp.dry_run_check('two switch-ons make two machine timers, the first closed at its off tap',
    jsonb_array_length(spans) = 2
      and (spans->0->>'on')::timestamptz = day_start + interval '10 minutes'
      and (spans->0->>'off')::timestamptz = day_start + interval '14 minutes'
      and (spans->1->>'on')::timestamptz = day_start + interval '30 minutes'
      and spans->1->>'off' is null, spans::text);

  -- The activity ends with the machine running: the open timer closes with it.
  update public.custom_work_sessions set ended_at = day_start + interval '40 minutes' where id = session_id;
  select workday_machinery_spans into spans from public.custom_work_sessions where id = session_id;
  perform pg_temp.dry_run_check('ending the activity closes the running machine timer at the activity''s end',
    (spans->1->>'off')::timestamptz = day_start + interval '40 minutes'
      and (select workday_machinery_ms = 14 * 60 * 1000 and workday_machinery_started_at is null
           from public.custom_work_sessions where id = session_id), spans::text);

  perform pg_temp.dry_run_act_as(installer);
  perform pg_temp.dry_run_expect_error('an installer cannot correct machine timers',
    format('select public.correct_workday_machinery(%L, %L)', gen_random_uuid(),
      jsonb_build_object('id', session_id, 'reason', 'left running', 'spans', '[]'::jsonb)), 'foremen');

  perform pg_temp.dry_run_act_as(foreman);
  perform pg_temp.dry_run_expect_error('a machine timer cannot run past its activity',
    format('select public.correct_workday_machinery(%L, %L)', gen_random_uuid(),
      jsonb_build_object('id', session_id, 'reason', 'left running', 'spans', jsonb_build_array(
        jsonb_build_object('on', day_start + interval '30 minutes', 'off', day_start + interval '50 minutes')))), 'inside its activity');
  perform pg_temp.dry_run_expect_error('two machine timers cannot overlap',
    format('select public.correct_workday_machinery(%L, %L)', gen_random_uuid(),
      jsonb_build_object('id', session_id, 'reason', 'left running', 'spans', jsonb_build_array(
        jsonb_build_object('on', day_start + interval '10 minutes', 'off', day_start + interval '20 minutes'),
        jsonb_build_object('on', day_start + interval '15 minutes', 'off', day_start + interval '25 minutes')))), 'overlap');
  perform pg_temp.dry_run_expect_error('a correction needs a reason',
    format('select public.correct_workday_machinery(%L, %L)', gen_random_uuid(),
      jsonb_build_object('id', session_id, 'reason', '', 'spans', '[]'::jsonb)), 'reason');

  -- The foreman shortens the second timer; sent twice, as a retry would.
  perform public.correct_workday_machinery(receipt, jsonb_build_object('id', session_id, 'reason', 'left running at lunch',
    'spans', jsonb_build_array(
      jsonb_build_object('on', day_start + interval '30 minutes', 'off', day_start + interval '33 minutes'),
      jsonb_build_object('on', day_start + interval '10 minutes', 'off', day_start + interval '14 minutes'))));
  perform public.correct_workday_machinery(receipt, jsonb_build_object('id', session_id, 'reason', 'left running at lunch',
    'spans', '[]'::jsonb));
  perform pg_temp.dry_run_as_system();
  select workday_machinery_spans into spans from public.custom_work_sessions where id = session_id;
  perform pg_temp.dry_run_check('the corrected timers are saved in order and the total follows',
    jsonb_array_length(spans) = 2
      and (spans->0->>'on')::timestamptz = day_start + interval '10 minutes'
      and (spans->1->>'off')::timestamptz = day_start + interval '33 minutes'
      and (select workday_machinery_ms = 7 * 60 * 1000 from public.custom_work_sessions where id = session_id), spans::text);
  perform pg_temp.dry_run_check('the correction is in the activity''s history once, with its reason',
    (select count(*) from public.custom_work_history
      where entity_id = session_id and action = 'session' and actor_id = foreman and reason = 'left running at lunch') = 1,
    session_id::text);

  -- A machinery tap that was waiting on the phone from before the correction.
  perform pg_temp.dry_run_act_as(installer);
  perform public.save_workday_activity(gen_random_uuid(), jsonb_build_object(
    'id', session_id, 'at', day_start + interval '39 minutes', 'machinery_ms', 999000, 'machinery_running', false));
  perform pg_temp.dry_run_as_system();
  perform pg_temp.dry_run_check('a late machinery tap does not undo the correction',
    (select workday_machinery_ms = 7 * 60 * 1000 and jsonb_array_length(workday_machinery_spans) = 2
     from public.custom_work_sessions where id = session_id), session_id::text);
end $$;
