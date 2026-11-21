-- Job plans are counted against the person who last saved them
-- (20261130160000_person_counts_job_plans.sql).
-- The harness always rolls this probe back.
do $$
declare
  job uuid;
  foreman uuid;
  before_count bigint;
  after_count bigint;
begin
  perform pg_temp.dry_run_as_system();
  job := pg_temp.dry_run_sandbox_job();
  foreman := pg_temp.dry_run_pick('foreman');
  before_count := (public.person_record_counts(foreman) ->> 'installer_job_plans.updated_by')::bigint;
  perform pg_temp.dry_run_check('the count answers with the new key',
    before_count is not null, coalesce(before_count::text, 'missing'));

  -- Make the sandbox job's plan theirs, whether or not it has one yet.
  insert into public.installer_job_plans (project_id, updated_by) values (job, foreman)
    on conflict (project_id) do update set updated_by = excluded.updated_by
    where public.installer_job_plans.updated_by is distinct from excluded.updated_by;
  after_count := (public.person_record_counts(foreman) ->> 'installer_job_plans.updated_by')::bigint;
  perform pg_temp.dry_run_check('a plan they last saved is counted',
    after_count >= 1 and after_count >= before_count, after_count::text);
  perform pg_temp.dry_run_check('every earlier key is still answered',
    public.person_record_counts(foreman) ? 'time_shifts.profile_id'
      and public.person_record_counts(foreman) ? 'workflow_plans.created_by', '');
end $$;
