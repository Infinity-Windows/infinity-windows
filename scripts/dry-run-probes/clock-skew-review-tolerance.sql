-- Clock skew is not a discrepancy (20261130290000_clock_skew_review_tolerance.sql).
-- The harness always rolls this probe back.
--
-- The rule is a trigger on the shift, so the probe closes shifts as the
-- system and reads what the trigger did to the activities on them: an
-- activity that ended seconds after its clock-out is left alone, one that
-- ended minutes after is still marked, and one still running is closed at the
-- clock-out without a mark.
do $$
declare
  job uuid;
  installer uuid;
  day_start timestamptz := '2001-02-05 08:00:00 America/Denver';
  near_shift uuid := gen_random_uuid();
  far_shift uuid := gen_random_uuid();
  open_shift uuid := gen_random_uuid();
  early_shift uuid := gen_random_uuid();
  near_session uuid := gen_random_uuid();
  far_session uuid := gen_random_uuid();
  open_session uuid := gen_random_uuid();
  early_session uuid := gen_random_uuid();
  flagged boolean;
  ended timestamptz;
begin
  perform pg_temp.dry_run_as_system();
  job := pg_temp.dry_run_sandbox_job();
  installer := pg_temp.dry_run_pick('installer');

  -- Four days, one shift each, so no two of this person's shifts overlap.
  insert into public.time_shifts(id, profile_id, project_id, clock_in_at, clock_out_at, status, break_seconds) values
    (near_shift, installer, job, day_start, null, 'open', 0),
    (far_shift, installer, job, day_start + interval '1 day', null, 'open', 0),
    (open_shift, installer, job, day_start + interval '2 days', null, 'open', 0),
    (early_shift, installer, job, day_start + interval '3 days', null, 'open', 0);
  insert into public.custom_work_sessions(id, profile_id, shift_id, project_id, unit_id, kind, stage,
      description, started_at, ended_at) values
    -- The phone, 30 s fast, ended the activity at "10:00:00"; the server will say 9:59:30.
    (near_session, installer, near_shift, job, null, 'idle', 'Idle time', 'Staging',
      day_start + interval '1 hour', day_start + interval '2 hours'),
    -- Ended ten minutes after the clock-out: a real discrepancy.
    (far_session, installer, far_shift, job, null, 'idle', 'Idle time', 'Staging',
      day_start + interval '1 day 1 hour', day_start + interval '1 day 2 hours 10 minutes'),
    (open_session, installer, open_shift, job, null, 'idle', 'Idle time', 'Staging',
      day_start + interval '2 days 1 hour', null),
    -- The phone, 20 s slow, started the activity "before" the corrected clock-in.
    (early_session, installer, early_shift, job, null, 'idle', 'Idle time', 'Staging',
      day_start + interval '3 days' - interval '20 seconds', day_start + interval '3 days 1 hour');

  update public.time_shifts set clock_out_at = day_start + interval '2 hours' - interval '30 seconds', status = 'submitted'
    where id = near_shift;
  update public.time_shifts set clock_out_at = day_start + interval '1 day 2 hours', status = 'submitted'
    where id = far_shift;
  update public.time_shifts set clock_out_at = day_start + interval '2 days 2 hours', status = 'submitted'
    where id = open_shift;
  update public.time_shifts set clock_out_at = day_start + interval '3 days 2 hours', status = 'submitted'
    where id = early_shift;

  select review_required into flagged from public.custom_work_sessions where id = near_session;
  perform pg_temp.dry_run_check('an activity that ended 30 seconds after its clock-out is not marked',
    flagged = false, 'review_required ' || flagged);
  select review_required into flagged from public.custom_work_sessions where id = far_session;
  perform pg_temp.dry_run_check('an activity that ended 10 minutes after its clock-out is still marked',
    flagged = true, 'review_required ' || flagged);
  select review_required, ended_at into flagged, ended from public.custom_work_sessions where id = open_session;
  perform pg_temp.dry_run_check('an activity still running is closed at the clock-out, unmarked',
    flagged = false and ended = day_start + interval '2 days 2 hours', 'review_required ' || flagged);
  select review_required into flagged from public.custom_work_sessions where id = early_session;
  perform pg_temp.dry_run_check('an activity that started 20 seconds before its clock-in is not marked',
    flagged = false, 'review_required ' || flagged);
end $$;
