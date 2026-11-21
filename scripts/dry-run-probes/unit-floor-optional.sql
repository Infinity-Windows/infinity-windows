-- Probe for 20261130170000_unit_floor_optional.sql and
-- 20261130180000_plan_table_fences.sql (docs/db-dry-run.md).
--
-- As the QA installer on the sandbox job: a placeholder saves with no floor,
-- a bad floor and a missing type are still refused, and the person can still
-- read the receipt of their own edit after the partner wall is added.
do $$
declare
  installer uuid;
  job uuid;
  opening uuid := gen_random_uuid();
  edit uuid := gen_random_uuid();
  code text := 'PH-QA-' || left(opening::text, 8);
begin
  perform pg_temp.dry_run_as_system();
  installer := pg_temp.dry_run_pick('installer');
  job := pg_temp.dry_run_sandbox_job();
  perform pg_temp.dry_run_act_as(installer);
  perform pg_temp.dry_run_check('an installer saves a placeholder with no floor',
    public.save_unit_details(job, opening, true, code, '{"placeholder":true,"kind":"door"}',
      null, '{}'::jsonb, edit), opening::text);
  perform pg_temp.dry_run_expect_error('a floor that is not a whole number is still refused',
    format('select public.save_unit_details(%L, %L, true, %L, %L, null, %L, %L)',
      job, gen_random_uuid(), code || '-F', '{"placeholder":true,"floor":"two","kind":"door"}', '{}', gen_random_uuid()),
    'Enter a unit number');
  perform pg_temp.dry_run_expect_error('a placeholder without a type is still refused',
    format('select public.save_unit_details(%L, %L, true, %L, %L, null, %L, %L)',
      job, gen_random_uuid(), code || '-T', '{"placeholder":true}', '{}', gen_random_uuid()),
    'Enter a unit number');
  perform pg_temp.dry_run_check('the installer can read the receipt of their own edit',
    exists (select 1 from public.unit_detail_edit_history where edit_id = edit and actor_id = installer), edit::text);
  perform pg_temp.dry_run_as_system();
  perform pg_temp.dry_run_check('the floorless placeholder is on the job',
    exists (select 1 from public.project_openings where id = opening and project_id = job
      and field_added and unit_details->>'floor' is null), opening::text);
  perform pg_temp.dry_run_check('the sandbox guard is on all four tables',
    (select count(distinct c.relname) from pg_trigger t join pg_class c on c.oid = t.tgrelid
      where not t.tgisinternal and c.relnamespace = 'public'::regnamespace
        and c.relname in ('installer_job_plans', 'plan_activity_done_marks', 'plan_unit_lead_changes', 'unit_detail_edit_history')
        and t.tgname ilike '%sandbox%') = 4,
    (select coalesce(string_agg(distinct c.relname, ', '), 'none') from pg_trigger t join pg_class c on c.oid = t.tgrelid
      where not t.tgisinternal and c.relnamespace = 'public'::regnamespace
        and c.relname in ('installer_job_plans', 'plan_activity_done_marks', 'plan_unit_lead_changes', 'unit_detail_edit_history')
        and t.tgname ilike '%sandbox%'));
end $$;
