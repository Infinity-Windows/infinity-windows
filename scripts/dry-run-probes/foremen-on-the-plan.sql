-- Foremen on the Plan (20261130200000_foremen_on_the_plan.sql).
-- The harness always rolls this probe back.
--
-- A foreman can be named on a Plan block, can take lead on a unit from the
-- Workday, and a supervisor still cannot be named.
do $$
declare
  job uuid;
  foreman uuid;
  supervisor uuid;
  opening uuid;
  block_id text := 'dry-run-foreman-' || gen_random_uuid();
  other_lead text := gen_random_uuid()::text;
  rev integer;
  block jsonb;
begin
  perform pg_temp.dry_run_as_system();
  job := pg_temp.dry_run_sandbox_job();
  foreman := pg_temp.dry_run_pick('foreman');
  supervisor := pg_temp.dry_run_pick('supervisor');
  select id into opening from public.project_openings
    where project_id = job and removed_at is null order by opening_code limit 1;
  if opening is null then
    raise exception 'dry run: the sandbox job needs at least one opening';
  end if;
  insert into public.installer_job_plans(project_id) values (job) on conflict do nothing;

  -- Taking lead: a published block led by someone else.
  update public.installer_job_plans set published = published || jsonb_build_array(jsonb_build_object(
      'id', block_id, 'kind', 'unit', 'activity', 'Dry run foreman', 'unitCrewOnly', true,
      'start', '2099-01-05', 'end', '2099-01-05', 'startMinute', 420, 'endMinute', 900,
      'openingIds', jsonb_build_array(opening), 'installerIds', jsonb_build_array(other_lead),
      'openingCrew', jsonb_build_object(opening::text, jsonb_build_object('leadId', other_lead, 'crewIds', '[]'::jsonb))))
    where project_id = job;
  perform pg_temp.dry_run_act_as(foreman);
  perform public.take_plan_unit_lead(gen_random_uuid(),
    jsonb_build_object('project_id', job, 'opening_id', opening, 'activity', 'Dry run foreman'));
  perform pg_temp.dry_run_as_system();
  perform pg_temp.dry_run_check('a foreman takes lead on a planned unit',
    exists (select 1 from public.installer_job_plans plan, jsonb_array_elements(plan.published) b
      where plan.project_id = job and b->>'id' = block_id
        and b->'openingCrew'->(opening::text)->>'leadId' = foreman::text), block_id);

  -- Naming people on a block when the Plan is saved.
  select revision into rev from public.installer_job_plans where project_id = job;
  block := jsonb_build_object(
    'id', 'dry-run-save-' || gen_random_uuid(), 'kind', 'unit', 'activity', 'Dry run foreman save', 'unitCrewOnly', true,
    'start', '2099-01-06', 'end', '2099-01-06', 'startMinute', 420, 'endMinute', 900,
    'openingIds', jsonb_build_array(opening));
  perform pg_temp.dry_run_act_as(foreman);
  perform pg_temp.dry_run_expect_error('a supervisor still cannot be named on a block',
    format('select public.save_installer_plan(%L, %s, %L::jsonb)', job, rev,
      jsonb_build_array(block || jsonb_build_object('installerIds', jsonb_build_array(supervisor)))),
    'Choose an available installer or foreman');
  perform pg_temp.dry_run_check('a foreman can be named on a block',
    public.save_installer_plan(job, rev,
      jsonb_build_array(block || jsonb_build_object('installerIds', jsonb_build_array(foreman)))) is not null,
    foreman::text);
  perform pg_temp.dry_run_as_system();
end $$;
