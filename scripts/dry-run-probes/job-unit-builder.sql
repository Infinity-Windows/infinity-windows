-- Probe for 20261130100000_job_unit_builder.sql (docs/db-dry-run.md).
--
-- That migration lets a foreman or above create a DEFINED unit and confirm a
-- field placeholder, which is what the Unit Builder's Finish step relies on:
-- Finish calls save_unit_details once per unit with placeholder:false. It also
-- keeps the rule that a placeholder carries a floor and a type.
--
-- Everything is called as the QA installer and QA foreman on the sandbox job,
-- and the whole run is rolled back.
do $$
declare
  installer uuid;
  foreman uuid;
  job uuid;
  defined_unit uuid := gen_random_uuid();
  placeholder uuid := gen_random_uuid();
  create_id uuid := gen_random_uuid();
  placeholder_id uuid := gen_random_uuid();
  tag text := left(defined_unit::text, 8);
  defined_code text := 'QA-' || left(defined_unit::text, 8) || '-1';
  placeholder_code text := 'PH-QA-' || left(placeholder::text, 8);
  defined jsonb := '{"placeholder":false,"kind":"window","floor":"2","width":40,"height":60,"basis":"drawing","configuration":"Fixed","material":"Aluminum"}';
  field jsonb := '{"placeholder":true,"floor":"2","kind":"door"}';
  confirmed_details jsonb := '{"placeholder":false,"floor":"2","kind":"door","configuration":"Swing door"}';
  set_aside jsonb := '{"placeholder":true,"floor":"2","kind":"door","builderDeferred":true}';
  created boolean;
begin
  perform pg_temp.dry_run_as_system();
  installer := pg_temp.dry_run_pick('installer');
  foreman := pg_temp.dry_run_pick('foreman');
  job := pg_temp.dry_run_sandbox_job();

  -- A foreman finishing an import: one defined unit, then the same call again
  -- the way a retry after a dropped connection sends it.
  perform pg_temp.dry_run_act_as(foreman);
  created := public.save_unit_details(job, defined_unit, true, defined_code, defined, null, '{}'::jsonb, create_id,
    'Imported from drawings: plan mark QA, plan sheet 4; CAD sheet 2: W1');
  perform pg_temp.dry_run_check('foreman creates a defined unit', created, 'expected true, got ' || coalesce(created::text, 'null'));
  created := public.save_unit_details(job, defined_unit, true, defined_code, defined, null, '{}'::jsonb, create_id,
    'Imported from drawings: plan mark QA, plan sheet 4; CAD sheet 2: W1');
  perform pg_temp.dry_run_check('the same create again adds nothing', not created, 'expected false, got ' || coalesce(created::text, 'null'));
  perform pg_temp.dry_run_check('foreman creates a curtain wall unit',
    public.save_unit_details(job, gen_random_uuid(), true, 'QA-' || tag || '-CW',
      '{"placeholder":false,"kind":"curtain_wall","floor":"1"}', null, '{}'::jsonb, gen_random_uuid()), 'expected true');
  perform pg_temp.dry_run_expect_error('a unit type outside the list is refused',
    format('select public.save_unit_details(%L, %L, true, %L, %L, null, %L, %L)',
      job, gen_random_uuid(), 'QA-' || tag || '-SK', '{"placeholder":false,"kind":"skylight"}', '{}', gen_random_uuid()),
    'Enter a unit number');
  perform pg_temp.dry_run_expect_error('a second unit with the same number is refused',
    format('select public.save_unit_details(%L, %L, true, %L, %L, null, %L, %L)',
      job, gen_random_uuid(), defined_code, defined, '{}', gen_random_uuid()), null);
  perform pg_temp.dry_run_expect_error('a defined unit without a type is refused',
    format('select public.save_unit_details(%L, %L, true, %L, %L, null, %L, %L)',
      job, gen_random_uuid(), 'QA-' || tag || '-2', '{"placeholder":false,"floor":"2"}', '{}', gen_random_uuid()),
    'Enter a unit number');

  -- An installer may add a placeholder, with its floor and type, and nothing more.
  perform pg_temp.dry_run_act_as(installer);
  perform pg_temp.dry_run_expect_error('an installer cannot create a defined unit',
    format('select public.save_unit_details(%L, %L, true, %L, %L, null, %L, %L)',
      job, gen_random_uuid(), 'QA-' || tag || '-3', defined, '{}', gen_random_uuid()),
    'Enter a unit number');
  perform pg_temp.dry_run_expect_error('a placeholder without a floor is refused',
    format('select public.save_unit_details(%L, %L, true, %L, %L, null, %L, %L)',
      job, gen_random_uuid(), placeholder_code || '-X', '{"placeholder":true,"kind":"door"}', '{}', gen_random_uuid()),
    'floor');
  created := public.save_unit_details(job, placeholder, true, placeholder_code, field, null, '{}'::jsonb, placeholder_id);
  perform pg_temp.dry_run_check('installer creates a placeholder with floor and type', created,
    'expected true, got ' || coalesce(created::text, 'null'));
  perform pg_temp.dry_run_expect_error('an installer cannot confirm a placeholder',
    format('select public.save_unit_details(%L, %L, false, %L, %L, %L, %L, %L)',
      job, placeholder, placeholder_code, confirmed_details, placeholder_code, field, gen_random_uuid()),
    'Only a foreman');
  perform pg_temp.dry_run_expect_error('an installer cannot set a placeholder aside',
    format('select public.save_unit_details(%L, %L, false, %L, %L, %L, %L, %L)',
      job, placeholder, placeholder_code, set_aside, placeholder_code, field, gen_random_uuid()),
    'Only a foreman');

  -- The foreman reviews that placeholder: sets it aside, brings it back, confirms it.
  perform pg_temp.dry_run_act_as(foreman);
  perform public.save_unit_details(job, placeholder, false, placeholder_code, set_aside, placeholder_code, field,
    gen_random_uuid(), 'Disregarded in Unit Builder review');
  perform public.save_unit_details(job, placeholder, false, placeholder_code, field, placeholder_code, set_aside,
    gen_random_uuid(), 'Returned to Unit Builder review');
  perform public.save_unit_details(job, placeholder, false, placeholder_code, confirmed_details, placeholder_code, field,
    gen_random_uuid(), 'Defined field placeholder');

  perform pg_temp.dry_run_as_system();
  perform pg_temp.dry_run_check('the defined unit is on the job as written',
    exists (select 1 from public.project_openings
      where id = defined_unit and project_id = job and opening_code = defined_code
        and unit_details = defined and removed_at is null), defined_unit::text);
  perform pg_temp.dry_run_check('the retry left one history row for the create',
    (select count(*) from public.unit_detail_edit_history where opening_id = defined_unit) = 1,
    (select count(*) from public.unit_detail_edit_history where opening_id = defined_unit) || ' row(s), expected 1');
  perform pg_temp.dry_run_check('confirming kept the placeholder''s own row',
    exists (select 1 from public.project_openings
      where id = placeholder and project_id = job and opening_code = placeholder_code and unit_details = confirmed_details),
    placeholder::text);
  perform pg_temp.dry_run_check('placeholder history: create, set aside, return, confirm',
    (select count(*) from public.unit_detail_edit_history where opening_id = placeholder) = 4,
    (select count(*) from public.unit_detail_edit_history where opening_id = placeholder) || ' row(s), expected 4');
end $$;
