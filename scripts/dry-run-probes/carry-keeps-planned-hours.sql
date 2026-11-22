-- Carried plan work keeps its planned hours (20261130130000_carry_keeps_planned_hours.sql).
-- The harness always rolls this probe back.
do $$
declare
  job uuid;
  installer uuid;
  unit_a uuid := gen_random_uuid();
  unit_b uuid := gen_random_uuid();
  unit_c uuid := gen_random_uuid();
  day date := date '2026-11-16';
  timed uuid := gen_random_uuid();
  legacy uuid := gen_random_uuid();
  overnight uuid := gen_random_uuid();
  carried jsonb;
begin
  perform pg_temp.dry_run_as_system();
  job := pg_temp.dry_run_sandbox_job();
  installer := pg_temp.dry_run_pick('installer');
  insert into public.project_openings (id, project_id, opening_code)
  values (unit_a, job, 'Carry probe ' || unit_a::text), (unit_b, job, 'Carry probe ' || unit_b::text),
    (unit_c, job, 'Carry probe ' || unit_c::text);
  insert into public.installer_job_plans (project_id, published) values (job, jsonb_build_array(
    -- Planned 13:00-17:00 two days ago.
    jsonb_build_object('id', timed, 'kind', 'unit', 'activity', 'Flashing', 'start', day - 2, 'end', day - 2,
      'startMinute', 780, 'endMinute', 1020, 'openingIds', jsonb_build_array(unit_a), 'installerIds', jsonb_build_array(installer)),
    -- An older card saved as "PM" with no minutes.
    jsonb_build_object('id', legacy, 'kind', 'unit', 'activity', 'Sealing', 'start', day - 2, 'end', day - 2,
      'startPeriod', 'PM', 'endPeriod', 'PM', 'openingIds', jsonb_build_array(unit_b), 'installerIds', jsonb_build_array(installer)),
    -- 14:00 one day to 10:00 the next: one day long, it would end before it starts.
    jsonb_build_object('id', overnight, 'kind', 'unit', 'activity', 'Setting frame', 'start', day - 3, 'end', day - 2,
      'startMinute', 840, 'endMinute', 600, 'dailyEndMinute', 960, 'openingIds', jsonb_build_array(unit_c), 'installerIds', jsonb_build_array(installer))))
    on conflict (project_id) do update set published = excluded.published;

  perform pg_temp.dry_run_act_as(installer);
  select jsonb_object_agg(b->>'id', b) into carried
  from jsonb_array_elements(public.get_my_installer_plan_window(day, day + 1)) j
  cross join lateral jsonb_array_elements(j->'blocks') b
  where j->>'projectId' = job::text;
  perform pg_temp.dry_run_as_system();

  perform pg_temp.dry_run_check('all three cards are carried onto the day',
    (select count(*) from jsonb_each(coalesce(carried, '{}'::jsonb)) c where c.value->>'start' = day::text and c.value->>'end' = day::text) = 3,
    coalesce(jsonb_pretty(carried), 'nothing returned'));
  perform pg_temp.dry_run_check('a carried card keeps its planned hours',
    carried->timed::text->>'startMinute' = '780' and carried->timed::text->>'endMinute' = '1020', timed::text);
  perform pg_temp.dry_run_check('an older PM card is carried as the afternoon',
    carried->legacy::text->>'startMinute' = '720' and carried->legacy::text->>'endMinute' = '1140', legacy::text);
  perform pg_temp.dry_run_check('an overnight card runs to its daily cutoff',
    carried->overnight::text->>'startMinute' = '840' and carried->overnight::text->>'endMinute' = '960', overnight::text);
end $$;
