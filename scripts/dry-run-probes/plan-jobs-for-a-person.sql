-- Plan jobs for a person (20261130270000_plan_jobs_for_a_person.sql).
-- The harness always rolls this probe back.
--
-- A foreman asking about an installer gets the job whose Plan names them, an
-- installer asking about someone else gets nothing, and a person nobody
-- planned gets an empty list.
do $$
declare
  job uuid;
  foreman uuid;
  installer uuid;
  block_id text := 'dry-run-plan-jobs-' || gen_random_uuid();
  found jsonb;
begin
  perform pg_temp.dry_run_as_system();
  job := pg_temp.dry_run_sandbox_job();
  foreman := pg_temp.dry_run_pick('foreman');
  installer := pg_temp.dry_run_pick('installer');
  insert into public.installer_job_plans(project_id) values (job) on conflict do nothing;
  -- One block for each of the two, so "nothing" further down is the fence and
  -- not an empty Plan.
  update public.installer_job_plans set published = published || jsonb_build_array(
      jsonb_build_object(
        'id', block_id, 'kind', 'general', 'activity', 'Dry run plan jobs',
        'start', '2099-01-05', 'end', '2099-01-05', 'startMinute', 420, 'endMinute', 900,
        'openingIds', '[]'::jsonb, 'installerIds', jsonb_build_array(installer)),
      jsonb_build_object(
        'id', block_id || '-f', 'kind', 'general', 'activity', 'Dry run plan jobs',
        'start', '2099-01-06', 'end', '2099-01-06', 'startMinute', 420, 'endMinute', 900,
        'openingIds', '[]'::jsonb, 'installerIds', jsonb_build_array(foreman)))
    where project_id = job;

  perform pg_temp.dry_run_act_as(foreman);
  found := public.list_installer_plan_jobs(installer);
  perform pg_temp.dry_run_check('a foreman finds the job that plans an installer',
    exists (select 1 from jsonb_array_elements(found) j where j->>'projectId' = job::text
      and j->>'jobCode' is not null), jsonb_array_length(found) || ' job(s)');
  perform pg_temp.dry_run_check('the blocks for that job still come back for the installer',
    exists (select 1 from jsonb_array_elements(public.get_published_installer_plan(job, installer)) b
      where b->>'id' = block_id), block_id);
  found := public.list_installer_plan_jobs(gen_random_uuid());
  perform pg_temp.dry_run_check('a person nobody planned has no jobs',
    found = '[]'::jsonb, jsonb_array_length(found) || ' job(s)');

  perform pg_temp.dry_run_act_as(installer);
  found := public.list_installer_plan_jobs(installer);
  perform pg_temp.dry_run_check('an installer finds their own planned job',
    exists (select 1 from jsonb_array_elements(found) j where j->>'projectId' = job::text),
    jsonb_array_length(found) || ' job(s)');
  found := public.list_installer_plan_jobs(foreman);
  perform pg_temp.dry_run_check('an installer asking about someone else gets nothing',
    found = '[]'::jsonb, jsonb_array_length(found) || ' job(s)');
  perform pg_temp.dry_run_as_system();
end $$;
