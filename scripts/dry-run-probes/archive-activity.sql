-- A foreman archives an activity (20261130220000_archive_activity.sql).
-- The harness always rolls this probe back.
do $$
declare
  job uuid;
  installer uuid;
  foreman uuid;
  the_shift uuid := gen_random_uuid();
  first_id uuid := gen_random_uuid();
  second_id uuid := gen_random_uuid();
  day_start timestamptz := '2001-01-05 08:00:00 America/Denver';
  shift_before jsonb;
  rev integer;
  setup jsonb;
begin
  perform pg_temp.dry_run_as_system();
  job := pg_temp.dry_run_sandbox_job();
  installer := pg_temp.dry_run_pick('installer');
  foreman := pg_temp.dry_run_pick('foreman');
  insert into public.time_shifts(id, profile_id, project_id, clock_in_at, clock_out_at, status, break_seconds)
    values (the_shift, installer, job, day_start, day_start + interval '2 hours', 'submitted', 0);
  select to_jsonb(s) into shift_before from public.time_shifts s where s.id = the_shift;
  setup := jsonb_build_object('profile_id', installer, 'project_id', job, 'activity', 'Setup',
    'started_at', day_start, 'ended_at', day_start + interval '30 minutes');

  perform pg_temp.dry_run_act_as(foreman);
  perform public.save_crew_activity(first_id, setup);
  select revision into rev from public.custom_work_sessions where id = first_id;

  perform pg_temp.dry_run_act_as(installer);
  perform pg_temp.dry_run_expect_error('an installer cannot archive an activity',
    format('select public.archive_crew_activity(%L, %L::jsonb)', gen_random_uuid(),
      jsonb_build_object('id', first_id, 'revision', rev, 'reason', 'Dry run')),
    'Only foremen and above');

  perform pg_temp.dry_run_act_as(foreman);
  perform pg_temp.dry_run_expect_error('archiving needs a reason',
    format('select public.archive_crew_activity(%L, %L::jsonb)', gen_random_uuid(),
      jsonb_build_object('id', first_id, 'revision', rev)),
    'Say why');
  perform public.archive_crew_activity(gen_random_uuid(), jsonb_build_object('id', first_id, 'revision', rev, 'reason', 'Dry run duplicate'));
  -- Sent again with the old revision: already archived, so nothing changes and nothing is refused.
  perform public.archive_crew_activity(gen_random_uuid(), jsonb_build_object('id', first_id, 'revision', rev, 'reason', 'Dry run duplicate'));
  -- The archived activity no longer holds its time.
  perform public.save_crew_activity(second_id, setup);
  select revision into rev from public.custom_work_sessions where id = first_id;
  perform pg_temp.dry_run_expect_error('an activity cannot be restored over newer work',
    format('select public.archive_crew_activity(%L, %L::jsonb)', gen_random_uuid(),
      jsonb_build_object('id', first_id, 'revision', rev, 'reason', 'Dry run restore', 'restore', true)),
    'cannot be restored');

  perform pg_temp.dry_run_as_system();
  perform pg_temp.dry_run_check('the activity is archived once, by the foreman',
    (select archived_at is not null and archived_by = foreman from public.custom_work_sessions where id = first_id)
    and (select count(*) from public.custom_work_history where entity_id = first_id and action = 'archived'
      and before_value->>'archived_at' is null and reason = 'Dry run duplicate') = 1, first_id::text);
  perform pg_temp.dry_run_check('new work can take an archived activity''s time',
    exists (select 1 from public.custom_work_sessions where id = second_id and archived_at is null), second_id::text);
  perform pg_temp.dry_run_check('archiving leaves the paid shift untouched',
    shift_before = (select to_jsonb(s) from public.time_shifts s where s.id = the_shift), the_shift::text);
end $$;
