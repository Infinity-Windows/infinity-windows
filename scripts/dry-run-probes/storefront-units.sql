-- Probe for 20261130250000_storefront_units.sql (docs/db-dry-run.md).
--
-- On the sandbox job: the QA installer adds a storefront as a field
-- placeholder with a size, the QA foreman builds one outright, its mark gets a
-- storefront spec, and the job's counts put both under storefronts instead of
-- unknown while every other count stays where it was. A type nobody listed and
-- a curtain wall behave as they did before.
do $$
declare
  v_foreman uuid;
  v_installer uuid;
  v_job uuid;
  v_role text;
  -- A digit in every tag: a run of letters before the dash would be read by
  -- mark_base() as one whole title-cased mark.
  v_tag text := 'QA9' || upper(left(replace(gen_random_uuid()::text, '-', ''), 6));
  m_store text := v_tag || 'SF';
  v_placeholder uuid := gen_random_uuid();
  v_spec public.project_mark_specs%rowtype;
  b record;
  a record;
begin
  perform pg_temp.dry_run_as_system();
  v_foreman := pg_temp.dry_run_pick('foreman');
  v_installer := pg_temp.dry_run_pick('installer');
  v_job := pg_temp.dry_run_sandbox_job();

  select openings, windows, doors, unknown_units, curtain_walls, storefronts
    into b
    from public.project_scope_counts where project_id = v_job;
  if not found then
    raise exception 'dry run: project_scope_counts has no row for the sandbox job, so there is nothing to compare the counts against';
  end if;

  -- The installer, as Workday's Create unit does: a placeholder with a size.
  v_role := pg_temp.dry_run_act_as(v_installer);
  perform pg_temp.dry_run_check('acting as the QA installer with their own id',
    current_user = 'authenticated' and auth.uid() = v_installer and v_role = 'installer',
    current_user::text);
  perform pg_temp.dry_run_check('an installer adds a storefront placeholder with its size',
    public.save_unit_details(v_job, v_placeholder, true, 'PH-SF-' || v_tag,
      '{"placeholder":true,"kind":"storefront","width":120,"height":96,"basis":"rough"}'::jsonb,
      null, '{}'::jsonb, gen_random_uuid()), v_placeholder::text);
  perform pg_temp.dry_run_expect_error('a type nobody listed is still refused',
    format('select public.save_unit_details(%L, %L, true, %L, %L, null, %L, %L)',
      v_job, gen_random_uuid(), 'PH-XX-' || v_tag, '{"placeholder":true,"kind":"skylight"}', '{}', gen_random_uuid()),
    'Enter a unit number');

  -- The foreman, as the Unit Builder does: a defined unit on a new mark.
  v_role := pg_temp.dry_run_act_as(v_foreman);
  perform pg_temp.dry_run_check('acting as the QA foreman with their own id',
    current_user = 'authenticated' and auth.uid() = v_foreman and v_role = 'foreman',
    current_user::text);
  perform pg_temp.dry_run_check('a foreman builds a storefront',
    public.save_unit_details(v_job, gen_random_uuid(), true, m_store || '-1',
      '{"placeholder":false,"kind":"storefront","width":144,"height":108,"basis":"unit","material":"Aluminum"}'::jsonb,
      null, '{}'::jsonb, gen_random_uuid()), m_store);
  perform pg_temp.dry_run_check('a foreman still builds a curtain wall',
    public.save_unit_details(v_job, gen_random_uuid(), true, v_tag || 'CW-1',
      '{"placeholder":false,"kind":"curtain_wall"}'::jsonb,
      null, '{}'::jsonb, gen_random_uuid()), v_tag || 'CW');
  select openings, windows, doors, unknown_units, curtain_walls, storefronts
    into a
    from public.project_scope_counts where project_id = v_job;
  perform pg_temp.dry_run_check('the foreman reads storefronts on the counts view',
    a.storefronts = b.storefronts + 2,
    'before ' || b.storefronts || ', after ' || coalesce(a.storefronts::text, 'no row'));
  perform pg_temp.dry_run_check('a storefront is not counted as unknown, a window or a door',
    a.unknown_units = b.unknown_units and a.windows = b.windows and a.doors = b.doors,
    format('unknown %s to %s, windows %s to %s, doors %s to %s',
      b.unknown_units, a.unknown_units, b.windows, a.windows, b.doors, a.doors));
  perform pg_temp.dry_run_check('the three new units are all counted once',
    a.openings = b.openings + 3 and a.curtain_walls = b.curtain_walls + 1,
    format('openings %s to %s, curtain walls %s to %s', b.openings, a.openings, b.curtain_walls, a.curtain_walls));

  -- The truth, as the system.
  perform pg_temp.dry_run_as_system();
  select * into v_spec from public.project_mark_specs
   where project_id = v_job and upper(mark_code) = m_store limit 1;
  perform pg_temp.dry_run_check('the storefront''s mark gets a storefront spec with its size',
    v_spec.unit_kind = 'storefront' and v_spec.door_kind is null
      and v_spec.width_in = 144 and v_spec.height_in = 108 and v_spec.extra ->> 'material' = 'Aluminum',
    'kind ' || coalesce(v_spec.unit_kind, 'none') || ', '
      || coalesce(v_spec.width_in::text, 'no width') || ' x ' || coalesce(v_spec.height_in::text, 'no height'));
  perform pg_temp.dry_run_check('the placeholder keeps its type and size on its own row',
    exists (select 1 from public.project_openings where id = v_placeholder and project_id = v_job and field_added
      and unit_details ->> 'kind' = 'storefront' and (unit_details ->> 'width')::numeric = 120), v_placeholder::text);
  perform pg_temp.dry_run_check('a placeholder writes no spec of its own',
    not exists (select 1 from public.project_mark_specs
      where project_id = v_job and upper(mark_code) = upper(public.mark_base('PH-SF-' || v_tag))), 'PH-SF-' || v_tag);
end $$;
