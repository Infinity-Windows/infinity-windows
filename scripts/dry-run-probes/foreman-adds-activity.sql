-- A foreman adds an activity for a person (20261130210000_foreman_adds_activity.sql).
-- The harness always rolls this probe back.
do $$
declare
  job uuid;
  installer uuid;
  foreman uuid;
  the_shift uuid := gen_random_uuid();
  unit_a uuid := gen_random_uuid();
  unit_b uuid := gen_random_uuid();
  unit_c uuid := gen_random_uuid();
  general_id uuid := gen_random_uuid();
  split_id uuid := gen_random_uuid();
  day_start timestamptz := '2001-01-04 08:00:00 America/Denver';
  shift_before jsonb;
  rev integer;
begin
  perform pg_temp.dry_run_as_system();
  job := pg_temp.dry_run_sandbox_job();
  installer := pg_temp.dry_run_pick('installer');
  foreman := pg_temp.dry_run_pick('foreman');
  insert into public.time_shifts(id, profile_id, project_id, clock_in_at, clock_out_at, status, break_seconds)
    values (the_shift, installer, job, day_start, day_start + interval '4 hours', 'submitted', 0);
  insert into public.custom_work_units(id, project_id, created_by, label, facts) values
    (unit_a, job, installer, 'Dry run add A', '{}'),
    (unit_b, job, installer, 'Dry run add B', '{}'),
    (unit_c, job, installer, 'Dry run add C', '{}');
  select to_jsonb(s) into shift_before from public.time_shifts s where s.id = the_shift;

  perform pg_temp.dry_run_act_as(installer);
  perform pg_temp.dry_run_expect_error('an installer cannot add an activity for someone',
    format('select public.save_crew_activity(%L, %L::jsonb)', gen_random_uuid(), jsonb_build_object(
      'profile_id', installer, 'project_id', job, 'activity', 'Setup',
      'started_at', day_start, 'ended_at', day_start + interval '30 minutes')),
    'Only foremen and above');

  perform pg_temp.dry_run_act_as(foreman);
  perform pg_temp.dry_run_expect_error('time outside the clocked hours is refused',
    format('select public.save_crew_activity(%L, %L::jsonb)', gen_random_uuid(), jsonb_build_object(
      'profile_id', installer, 'project_id', job, 'activity', 'Setup',
      'started_at', day_start - interval '1 hour', 'ended_at', day_start + interval '30 minutes')),
    'outside the hours');

  -- Job work with no unit, sent twice: added once.
  perform public.save_crew_activity(general_id, jsonb_build_object(
    'profile_id', installer, 'project_id', job, 'activity', 'Setup', 'note', 'Dry run',
    'started_at', day_start, 'ended_at', day_start + interval '30 minutes'));
  perform public.save_crew_activity(general_id, jsonb_build_object(
    'profile_id', installer, 'project_id', job, 'activity', 'Setup', 'note', 'Dry run',
    'started_at', day_start, 'ended_at', day_start + interval '30 minutes'));
  perform pg_temp.dry_run_expect_error('time over other recorded work is refused',
    format('select public.save_crew_activity(%L, %L::jsonb)', gen_random_uuid(), jsonb_build_object(
      'profile_id', installer, 'project_id', job, 'activity', 'Hauling',
      'started_at', day_start + interval '10 minutes', 'ended_at', day_start + interval '50 minutes')),
    'overlaps other work');

  -- Unit work over 90 minutes on three units: three 30 minute activities.
  perform public.save_crew_activity(split_id, jsonb_build_object(
    'profile_id', installer, 'project_id', job, 'activity', 'Flashing',
    'started_at', day_start + interval '1 hour', 'ended_at', day_start + interval '150 minutes',
    'units', jsonb_build_array(
      jsonb_build_object('unit_id', unit_a, 'finished', true),
      jsonb_build_object('unit_id', unit_b, 'finished', false),
      jsonb_build_object('unit_id', unit_c, 'finished', true))));

  -- Units on the existing Setup activity: it becomes Flashing on two units.
  select revision into rev from public.custom_work_sessions where id = general_id;
  perform public.save_crew_activity(gen_random_uuid(), jsonb_build_object(
    'replace_id', general_id, 'revision', rev, 'activity', 'Sealing',
    'units', jsonb_build_array(
      jsonb_build_object('unit_id', unit_a, 'finished', true),
      jsonb_build_object('unit_id', unit_b, 'finished', true))));

  perform pg_temp.dry_run_as_system();
  perform pg_temp.dry_run_check('unit work is shared evenly, one activity per unit',
    (select count(*) = 3 and min(ended_at - started_at) = interval '30 minutes'
        and max(ended_at - started_at) = interval '30 minutes'
        and min(started_at) = day_start + interval '1 hour' and max(ended_at) = day_start + interval '150 minutes'
        and count(*) filter (where outcome = 'finished') = 2 and count(*) filter (where outcome = 'partial') = 1
      from public.custom_work_sessions where profile_id = installer and shift_id = the_shift and stage = 'Flashing'),
    split_id::text);
  perform pg_temp.dry_run_check('an existing activity is shared between the units it is given',
    (select count(*) = 2 and min(started_at) = day_start and max(ended_at) = day_start + interval '30 minutes'
        and bool_and(kind = 'unit' and outcome = 'finished' and ended_at - started_at = interval '15 minutes')
        and bool_or(id = general_id and description = 'Dry run')
      from public.custom_work_sessions where profile_id = installer and shift_id = the_shift and stage = 'Sealing'),
    general_id::text);
  perform pg_temp.dry_run_check('nothing recorded for this person overlaps',
    not exists (select 1 from public.custom_work_sessions a join public.custom_work_sessions b
      on a.profile_id = b.profile_id and a.id < b.id and a.started_at < b.ended_at and b.started_at < a.ended_at
      where a.shift_id = the_shift), the_shift::text);
  perform pg_temp.dry_run_check('every added activity is in the history',
    (select count(*) from public.custom_work_history h join public.custom_work_sessions s on s.id = h.entity_id
      where s.shift_id = the_shift and h.actor_id = foreman and h.action in ('added', 'session')) = 6, the_shift::text);
  perform pg_temp.dry_run_check('adding activities leaves the paid shift untouched',
    shift_before = (select to_jsonb(s) from public.time_shifts s where s.id = the_shift), the_shift::text);
end $$;
