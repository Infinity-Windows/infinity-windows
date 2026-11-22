-- The dry-run harness applies the migration and rolls back this installer probe.
do $$
declare
  installer uuid;
  job uuid;
  opening uuid := gen_random_uuid();
  creation_id uuid := gen_random_uuid();
  correction_id uuid := gen_random_uuid();
  follow_up_id uuid := gen_random_uuid();
  code text := 'PH-QA-' || left(opening::text, 8);
  details jsonb := '{"placeholder":true,"floor":"2","kind":"window"}';
  correction jsonb := details || '{"inset":"outset","face":"S"}'::jsonb;
begin
  perform pg_temp.dry_run_as_system();
  installer := pg_temp.dry_run_pick('installer');
  job := pg_temp.dry_run_job('FORGE-TRAIN-1103');
  if not exists (select 1 from public.projects where id = job and is_test)
     or not public.is_sandbox_project(job) then
    raise exception 'dry run: FORGE-TRAIN-1103 must be a testing project on the sandbox allowlist';
  end if;
  perform pg_temp.dry_run_act_as(installer);
  perform public.save_unit_details(job, opening, true, code, details, null, '{}'::jsonb, creation_id);
  perform pg_temp.dry_run_check('placeholder save restores the opening-create guard',
    coalesce(current_setting('app.field_unit_add', true), '') <> 'on');
  perform pg_temp.dry_run_expect_error('placeholder save does not authorize arbitrary opening inserts',
    format('insert into public.project_openings(id, project_id, opening_code) values (%L, %L, %L)',
      gen_random_uuid(), job, code || '-unauthorized'), 'Only a foreman');
  perform public.save_unit_details(job, opening, true, code, details, null, '{}'::jsonb, creation_id);
  perform public.save_unit_details(job, opening, false, code || '-A', correction, code, details,
    correction_id, 'Checked from the south elevation');
  perform public.save_unit_details(job, opening, false, code || '-A', correction, code, details,
    correction_id, 'Checked from the south elevation');
  perform public.save_unit_details(job, opening, false, code || '-C', correction, code || '-A', correction, follow_up_id);
  perform pg_temp.dry_run_check('a retry after a subsequent edit returns without reapplying',
    not public.save_unit_details(job, opening, false, code || '-A', correction, code, details,
      correction_id, 'Checked from the south elevation'), opening::text);
  perform pg_temp.dry_run_expect_error('a stale correction is refused',
    format('select public.save_unit_details(%L, %L, false, %L, %L, %L, %L, %L)',
      job, opening, code || '-B', correction, code, details, gen_random_uuid()), 'changed elsewhere');
  perform pg_temp.dry_run_check('installer can create and correct one opening in place',
    exists (select 1 from public.project_openings
      where id = opening and project_id = job and opening_code = code || '-C'
        and unit_details = correction and field_added and window_type_id is null
        and planset_id is null and pin_x is null and pin_y is null), opening::text);
  perform pg_temp.dry_run_as_system();
  perform pg_temp.dry_run_check('history records exactly one row per successful change',
    (select count(*) from public.unit_detail_edit_history where opening_id = opening) = 3, opening::text);
  perform pg_temp.dry_run_check('history captures actor, server time, reason, and changed values',
    exists (select 1 from public.unit_detail_edit_history
      where edit_id = correction_id and actor_id = installer and saved_at is not null
        and reason = 'Checked from the south elevation'
        and before_values = jsonb_build_object('opening_code', code, 'unit_details', details)
        and after_values = jsonb_build_object('opening_code', code || '-A', 'unit_details', correction))
    and exists (select 1 from public.unit_detail_edit_history
      where edit_id = creation_id and before_values is null and reason is null), opening::text);
end $$;
