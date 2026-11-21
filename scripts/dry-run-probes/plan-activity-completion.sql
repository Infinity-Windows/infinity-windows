-- Runs in the rollback harness, against the designated training job only.
do $$
declare
  job uuid;
  installer uuid;
  foreman uuid;
  left_open uuid := gen_random_uuid();
  other_open uuid := gen_random_uuid();
  receipt uuid := gen_random_uuid();
  day date := date '2026-11-16';
  block jsonb;
  body jsonb;
  future jsonb;
begin
  perform pg_temp.dry_run_as_system();
  job := pg_temp.dry_run_job('FORGE-TRAIN-1103');
  if not public.is_sandbox_project(job)
      or not exists (select 1 from public.projects where id = job and is_test) then
    raise exception 'dry run: FORGE-TRAIN-1103 must be a testing project on the sandbox allowlist';
  end if;
  installer := pg_temp.dry_run_pick('installer');
  foreman := pg_temp.dry_run_pick('foreman');
  insert into public.project_openings (id, project_id, opening_code)
  values (left_open, job, 'Phase 3 probe ' || left_open::text),
    (other_open, job, 'Phase 3 probe ' || other_open::text);
  block := jsonb_build_object('id', gen_random_uuid(), 'kind', 'unit', 'activity', 'Flashing',
    'start', day - 2, 'end', day - 2, 'startMinute', 780, 'endMinute', 1020,
    'openingIds', jsonb_build_array(left_open, other_open), 'installerIds', jsonb_build_array(installer));
  insert into public.installer_job_plans (project_id, published) values (job, jsonb_build_array(block))
    on conflict (project_id) do update set published = excluded.published;
  body := jsonb_build_object('project_id', job, 'opening_id', left_open, 'activity', 'Flashing');

  perform pg_temp.dry_run_act_as(installer);
  perform pg_temp.dry_run_expect_error('installer cannot mark activity in Plan',
    format('select public.mark_plan_activity_done(%L, %L)', receipt, body), 'cannot manage');
  perform pg_temp.dry_run_act_as(foreman);
  perform public.mark_plan_activity_done(receipt, body);
  perform public.mark_plan_activity_done(receipt, body);

  perform pg_temp.dry_run_act_as(installer);
  perform pg_temp.dry_run_check('installer can read the foreman completion',
    jsonb_array_length(public.get_plan_activity_done(job)) >= 1, left_open::text);
  -- 20261130130000: the carried card keeps its planned hours (13:00-17:00).
  perform pg_temp.dry_run_check('remaining unit is carried at its planned hours, with the finished unit excluded',
    exists (
      select 1 from jsonb_array_elements(public.get_my_installer_plan_window(day, day + 1)) j
      cross join lateral jsonb_array_elements(j->'blocks') b
      where j->>'projectId' = job::text and b->>'id' = block->>'id'
        and b->>'startMinute' = '780' and b->>'endMinute' = '1020'
        and b->'openingIds' = jsonb_build_array(other_open)
    ), other_open::text);
  future := block || jsonb_build_object('id', gen_random_uuid(), 'start', day + 1, 'end', day + 1,
    'openingIds', jsonb_build_array(other_open));
  perform pg_temp.dry_run_as_system();
  update public.installer_job_plans set published = jsonb_build_array(block, future) where project_id = job;
  perform pg_temp.dry_run_act_as(installer);
  perform pg_temp.dry_run_check('rescheduling replaces the overdue projection, without a duplicate',
    exists (
      select 1 from jsonb_array_elements(public.get_my_installer_plan_window(day, day + 1)) j
      where j->>'projectId' = job::text and jsonb_array_length(j->'blocks') = 1
        and j->'blocks'->0->>'id' = future->>'id'
    ), other_open::text);
  perform pg_temp.dry_run_as_system();
  update public.installer_job_plans set published = jsonb_build_array(block) where project_id = job;
  perform pg_temp.dry_run_act_as(foreman);
  perform public.mark_plan_activity_done(gen_random_uuid(), body || jsonb_build_object('opening_id', other_open));
  perform pg_temp.dry_run_act_as(installer);
  perform pg_temp.dry_run_check('completed schedule no longer projects forward',
    not exists (
      select 1 from jsonb_array_elements(public.get_my_installer_plan_window(day, day + 1)) j
      where j->>'projectId' = job::text
    ), job::text);
  perform pg_temp.dry_run_as_system();
  perform pg_temp.dry_run_check('retry writes one untimed mark and creates no timer or work unit',
    (select count(*) from public.plan_activity_done_marks where opening_id = left_open) = 1
    and not exists (select 1 from public.custom_work_units where opening_id in (left_open, other_open)), receipt::text);
end $$;
