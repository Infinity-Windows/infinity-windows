-- Probe for 20261130090000_unit_details_optional_floor.sql (docs/db-dry-run.md).
--
-- That migration restates save_unit_details so a floor, when given, must be a
-- whole number. Whether a placeholder may be saved with no floor at all is
-- decided by the migration after it (20261130100000, tried by
-- job-unit-builder.sql); this probe checks the floor format rule and that an
-- ordinary placeholder still saves, as the QA installer on the sandbox job.
do $$
declare
  installer uuid;
  job uuid;
  opening uuid := gen_random_uuid();
  code text := 'PH-QA-' || left(opening::text, 8);
begin
  perform pg_temp.dry_run_as_system();
  installer := pg_temp.dry_run_pick('installer');
  job := pg_temp.dry_run_sandbox_job();
  perform pg_temp.dry_run_act_as(installer);
  perform pg_temp.dry_run_check('an installer saves a placeholder with a floor and a type',
    public.save_unit_details(job, opening, true, code, '{"placeholder":true,"floor":"2","kind":"window"}',
      null, '{}'::jsonb, gen_random_uuid()), opening::text);
  perform pg_temp.dry_run_expect_error('a floor that is not a whole number is refused',
    format('select public.save_unit_details(%L, %L, true, %L, %L, null, %L, %L)',
      job, gen_random_uuid(), code || '-F', '{"placeholder":true,"floor":"two","kind":"window"}', '{}', gen_random_uuid()),
    'Enter a unit number');
  perform pg_temp.dry_run_expect_error('a placeholder without a type is refused',
    format('select public.save_unit_details(%L, %L, true, %L, %L, null, %L, %L)',
      job, gen_random_uuid(), code || '-T', '{"placeholder":true,"floor":"2"}', '{}', gen_random_uuid()),
    'Enter a unit number');
  perform pg_temp.dry_run_as_system();
  perform pg_temp.dry_run_check('the placeholder is on the job as a field-added unit',
    exists (select 1 from public.project_openings where id = opening and project_id = job and field_added), opening::text);
end $$;
