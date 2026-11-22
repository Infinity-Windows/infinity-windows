-- Take lead from Workday (20261130110000_plan_unit_lead.sql).
-- The harness always rolls this probe back.
do $$
declare
  job uuid;
  installer uuid;
  foreman uuid;
  opening uuid;
  command_id uuid := gen_random_uuid();
  block_id text := 'dry-run-lead-' || gen_random_uuid();
  other_lead text := gen_random_uuid()::text;
  revision_before integer;
  saved jsonb;
begin
  perform pg_temp.dry_run_as_system();
  job := pg_temp.dry_run_sandbox_job();
  installer := pg_temp.dry_run_pick('installer');
  foreman := pg_temp.dry_run_pick('foreman');
  select id into opening from public.project_openings
    where project_id = job and removed_at is null order by opening_code limit 1;
  if opening is null then
    raise exception 'dry run: the sandbox job needs at least one opening to take lead on';
  end if;

  -- A block the installer is not on, led by someone else, with one crew member.
  insert into public.installer_job_plans(project_id) values (job) on conflict do nothing;
  update public.installer_job_plans set published = published || jsonb_build_array(jsonb_build_object(
      'id', block_id, 'kind', 'unit', 'activity', 'Dry run lead', 'unitCrewOnly', true,
      'start', '2099-01-05', 'end', '2099-01-05', 'startMinute', 420, 'endMinute', 900,
      'openingIds', jsonb_build_array(opening), 'installerIds', jsonb_build_array(other_lead),
      'openingCrew', jsonb_build_object(opening::text, jsonb_build_object('leadId', other_lead, 'crewIds', '[]'::jsonb))))
    where project_id = job;
  select revision into revision_before from public.installer_job_plans where project_id = job;

  perform pg_temp.dry_run_act_as(installer);
  perform public.take_plan_unit_lead(command_id,
    jsonb_build_object('project_id', job, 'opening_id', opening, 'activity', 'Dry run lead'));
  -- The phone's queue may send the same change twice.
  perform public.take_plan_unit_lead(command_id,
    jsonb_build_object('project_id', job, 'opening_id', opening, 'activity', 'Dry run lead'));
  saved := public.get_published_installer_plan(job);

  perform pg_temp.dry_run_as_system();
  perform pg_temp.dry_run_check('the installer is lead in the Plan, the earlier lead stays as crew',
    exists (select 1 from public.installer_job_plans plan, jsonb_array_elements(plan.published) block
      where plan.project_id = job and block->>'id' = block_id
        and block->'openingCrew'->(opening::text)->>'leadId' = installer::text
        and block->'openingCrew'->(opening::text)->'crewIds' = jsonb_build_array(other_lead)
        and block->'installerIds' ? installer::text and block->'installerIds' ? other_lead), block_id);
  perform pg_temp.dry_run_check('a repeated request changes the Plan once',
    (select revision from public.installer_job_plans where project_id = job) = revision_before + 1
    and (select count(*) from public.plan_unit_lead_changes where id = command_id
      and lead_id = installer and previous_lead_id = other_lead::uuid) = 1,
    'expected revision ' || (revision_before + 1) || ', got '
      || (select revision from public.installer_job_plans where project_id = job));
  perform pg_temp.dry_run_check('the installer''s Workday now shows the unit with them as lead',
    exists (select 1 from jsonb_array_elements(saved) block
      where block->>'id' = block_id and block->'openingCrew'->(opening::text)->>'leadId' = installer::text), block_id);

  perform pg_temp.dry_run_act_as(installer);
  perform pg_temp.dry_run_expect_error('an activity that is not on the Plan is refused',
    format('select public.take_plan_unit_lead(gen_random_uuid(), %L::jsonb)',
      jsonb_build_object('project_id', job, 'opening_id', opening, 'activity', 'Dry run not planned')),
    'no longer scheduled');
  perform pg_temp.dry_run_act_as(foreman);
  perform pg_temp.dry_run_expect_error('someone who is not an installer cannot take lead',
    format('select public.take_plan_unit_lead(gen_random_uuid(), %L::jsonb)',
      jsonb_build_object('project_id', job, 'opening_id', opening, 'activity', 'Dry run lead')),
    'Only an installer');
  perform pg_temp.dry_run_as_system();
end $$;
