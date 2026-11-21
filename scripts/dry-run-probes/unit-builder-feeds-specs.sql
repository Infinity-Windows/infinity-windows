-- Probe for 20261130140000_unit_builder_feeds_specs.sql (docs/db-dry-run.md).
--
-- The migration adds no RPC: it hangs a trigger off the one the Unit Builder
-- already calls. So this saves units through save_unit_details as the QA
-- foreman (who builds a unit) and the QA installer (who adds a placeholder and
-- corrects a unit), on the sandbox job, and then reads the mark specs and the
-- counts view as the system to see what the trigger did on their behalf.
--
-- Every mark below carries a random tag and a digit, so it cannot collide with
-- a mark already on the sandbox job and mark_base() can only read it one way
-- (a run of letters before the dash would be title-cased into a whole mark).
do $$
declare
  v_foreman uuid;
  v_installer uuid;
  v_job uuid;
  v_role text;
  v_tag text := 'QA9' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));
  -- One mark per scenario.
  m_new text := v_tag || 'W';        -- no spec yet, outside-frame size
  m_rough text := v_tag || 'R';      -- no spec yet, rough-opening size
  m_confirmed text := v_tag || 'C';  -- a spec a foreman has confirmed
  m_draft text := v_tag || 'U';      -- an unconfirmed spec with some blanks
  m_placeholder text := v_tag || 'P';
  m_curtain text := v_tag || 'K';
  m_source text := v_tag || 'S';     -- the drawing mark of a renumbered unit
  m_renamed text := v_tag || 'N';    -- the number it was changed to
  v_source_opening uuid := gen_random_uuid();
  v_source_details jsonb := '{"placeholder":false,"kind":"window"}';
  v_renamed_details jsonb;
  v_confirmed_before jsonb;
  v_confirmed_after jsonb;
  v_spec public.project_mark_specs%rowtype;
  v_n int;
  b record;
  a record;
  v_seen_curtain bigint;
begin
  -- 1. Setup, as the system. Pick everyone and everything first.
  perform pg_temp.dry_run_as_system();
  v_foreman := pg_temp.dry_run_pick('foreman');
  v_installer := pg_temp.dry_run_pick('installer');
  v_job := pg_temp.dry_run_sandbox_job();

  select openings, windows, doors, door_sliders, door_other, unknown_units, curtain_walls
    into b
    from public.project_scope_counts where project_id = v_job;
  if not found then
    raise exception 'dry run: project_scope_counts has no row for the sandbox job, so there is nothing to compare the counts against';
  end if;

  -- A spec a foreman signed off, saying this mark is a sliding door.
  insert into public.project_mark_specs
    (project_id, mark_code, style, unit_kind, door_kind, source, confirmed)
  values (v_job, m_confirmed, 'Probe confirmed spec', 'door', 'slider', 'manual', true);
  -- The extractor's draft: it knows the operation and the width, nothing else.
  insert into public.project_mark_specs
    (project_id, mark_code, style, operation, width_in, extra, source, confirmed)
  values (v_job, m_draft, 'Probe draft spec', 'XO', 40, '{"note":"keep"}'::jsonb, 'ai', false);
  -- A drawn unit of the draft's mark that nobody has opened in the builder:
  -- no details of its own, so its kind can only come from its mark's spec.
  insert into public.project_openings (project_id, opening_code)
  values (v_job, m_draft || '-2');

  select to_jsonb(s) into v_confirmed_before
    from public.project_mark_specs s
   where s.project_id = v_job and s.mark_code = m_confirmed;

  -- 2. The foreman builds units, the way JobUnitBuilderForm does.
  v_role := pg_temp.dry_run_act_as(v_foreman);
  perform pg_temp.dry_run_check('acting as the QA foreman with their own id',
    current_user = 'authenticated' and auth.uid() = v_foreman and v_role = 'foreman',
    current_user::text);

  perform public.save_unit_details(v_job, gen_random_uuid(), true, m_new || '-1',
    '{"placeholder":false,"kind":"window","width":36,"height":48.5,"basis":"unit","configuration":"XO","material":"Vinyl"}'::jsonb,
    null, '{}'::jsonb, gen_random_uuid());
  perform public.save_unit_details(v_job, gen_random_uuid(), true, m_rough || '-1',
    '{"placeholder":false,"kind":"door","width":72,"height":80,"basis":"rough"}'::jsonb,
    null, '{}'::jsonb, gen_random_uuid());
  perform public.save_unit_details(v_job, gen_random_uuid(), true, m_confirmed || '-1',
    '{"placeholder":false,"kind":"window","width":30,"height":40,"basis":"unit","configuration":"Fixed","material":"Wood"}'::jsonb,
    null, '{}'::jsonb, gen_random_uuid());
  perform public.save_unit_details(v_job, gen_random_uuid(), true, m_draft || '-1',
    '{"placeholder":false,"kind":"window","width":36,"height":48,"basis":"drawing","configuration":"Fixed","material":"Vinyl"}'::jsonb,
    null, '{}'::jsonb, gen_random_uuid());
  perform public.save_unit_details(v_job, gen_random_uuid(), true, m_curtain || '-1',
    '{"placeholder":false,"kind":"curtain_wall"}'::jsonb,
    null, '{}'::jsonb, gen_random_uuid());
  perform public.save_unit_details(v_job, v_source_opening, true, m_source || '-1',
    v_source_details, null, '{}'::jsonb, gen_random_uuid());

  perform pg_temp.dry_run_check('the spec feed leaves the opening-create guard as save_unit_details restored it',
    coalesce(current_setting('app.field_unit_add', true), '') <> 'on');
  -- The view as the app reads it: the new column is there for a signed-in
  -- person and already counts the curtain wall they just built.
  select curtain_walls into v_seen_curtain
    from public.project_scope_counts where project_id = v_job;
  perform pg_temp.dry_run_check('the foreman can read curtain_walls on the counts view',
    v_seen_curtain >= 1, 'expected at least 1, got ' || coalesce(v_seen_curtain::text, 'no row'));

  -- 3. The installer: a placeholder, and a correction that renumbers a unit.
  --    An installer may not write a mark spec directly (foreman+ by RLS), so
  --    the second save is also the proof that the feed works for them.
  v_role := pg_temp.dry_run_act_as(v_installer);
  perform pg_temp.dry_run_check('acting as the QA installer with their own id',
    current_user = 'authenticated' and auth.uid() = v_installer and v_role = 'installer',
    current_user::text);

  perform public.save_unit_details(v_job, gen_random_uuid(), true, m_placeholder || '-1',
    '{"placeholder":true,"kind":"window","floor":"2","width":36,"height":48,"basis":"unit","material":"Vinyl"}'::jsonb,
    null, '{}'::jsonb, gen_random_uuid());

  v_renamed_details := v_source_details || jsonb_build_object(
    'sourceMark', m_source || '-1', 'width', 24, 'height', 36, 'basis', 'unit');
  perform pg_temp.dry_run_check('the installer can renumber a unit and record its size',
    public.save_unit_details(v_job, v_source_opening, false, m_renamed || '-7',
      v_renamed_details, m_source || '-1', v_source_details, gen_random_uuid()),
    v_source_opening::text);

  -- 4. The truth, as the system.
  perform pg_temp.dry_run_as_system();

  -- A brand-new mark gets a field spec carrying the unit's kind and size.
  select count(*) into v_n from public.project_mark_specs
   where project_id = v_job and upper(mark_code) = m_new;
  select * into v_spec from public.project_mark_specs
   where project_id = v_job and upper(mark_code) = m_new limit 1;
  perform pg_temp.dry_run_check('a builder unit with a new mark creates exactly one spec',
    v_n = 1, 'expected 1 row, got ' || v_n);
  perform pg_temp.dry_run_check('the new spec is an unconfirmed field row',
    v_spec.source = 'field' and v_spec.confirmed = false,
    'source ' || coalesce(v_spec.source, 'none') || ', confirmed ' || coalesce(v_spec.confirmed::text, 'none'));
  perform pg_temp.dry_run_check('the new spec carries the unit''s kind and outside-frame size',
    v_spec.unit_kind = 'window' and v_spec.door_kind is null
      and v_spec.width_in = 36 and v_spec.height_in = 48.5,
    'kind ' || coalesce(v_spec.unit_kind, 'none') || ', '
      || coalesce(v_spec.width_in::text, 'no width') || ' x ' || coalesce(v_spec.height_in::text, 'no height'));
  perform pg_temp.dry_run_check('the new spec carries the configuration and the material',
    v_spec.operation = 'XO' and v_spec.extra ->> 'material' = 'Vinyl',
    'operation ' || coalesce(v_spec.operation, 'none') || ', material ' || coalesce(v_spec.extra ->> 'material', 'none'));
  perform pg_temp.dry_run_check('the new mark is on the job''s mark list too',
    exists (select 1 from public.project_marks
             where project_id = v_job and mark_code = m_new), m_new);

  -- A rough opening is the hole, not the unit: kind yes, size no.
  select count(*) into v_n from public.project_mark_specs
   where project_id = v_job and upper(mark_code) = m_rough;
  select * into v_spec from public.project_mark_specs
   where project_id = v_job and upper(mark_code) = m_rough limit 1;
  perform pg_temp.dry_run_check('a rough-opening size is not written as the unit''s size',
    v_n = 1 and v_spec.width_in is null and v_spec.height_in is null,
    v_n || ' row(s), ' || coalesce(v_spec.width_in::text, 'no width') || ' x ' || coalesce(v_spec.height_in::text, 'no height'));
  perform pg_temp.dry_run_check('a builder door with a new mark is a door of no stated kind',
    v_spec.unit_kind = 'door' and v_spec.door_kind = 'other',
    'kind ' || coalesce(v_spec.unit_kind, 'none') || ', door kind ' || coalesce(v_spec.door_kind, 'none'));

  -- A confirmed spec is not touched at all, not even its updated_at.
  select count(*) into v_n from public.project_mark_specs
   where project_id = v_job and upper(mark_code) = m_confirmed;
  select to_jsonb(s) into v_confirmed_after
    from public.project_mark_specs s
   where s.project_id = v_job and s.mark_code = m_confirmed;
  perform pg_temp.dry_run_check('a confirmed spec is left exactly as it was',
    v_n = 1 and v_confirmed_after = v_confirmed_before,
    v_n || ' row(s); ' || case when v_confirmed_after = v_confirmed_before
                               then 'unchanged' else 'the row changed' end);

  -- An unconfirmed spec keeps what it knew and gains only what it lacked.
  select count(*) into v_n from public.project_mark_specs
   where project_id = v_job and upper(mark_code) = m_draft;
  select * into v_spec from public.project_mark_specs
   where project_id = v_job and upper(mark_code) = m_draft limit 1;
  perform pg_temp.dry_run_check('an unconfirmed spec keeps every value it already had',
    v_n = 1 and v_spec.operation = 'XO' and v_spec.width_in = 40
      and v_spec.style = 'Probe draft spec' and v_spec.extra ->> 'note' = 'keep',
    v_n || ' row(s), operation ' || coalesce(v_spec.operation, 'none')
      || ', width ' || coalesce(v_spec.width_in::text, 'none'));
  perform pg_temp.dry_run_check('an unconfirmed spec gets its blanks filled',
    v_spec.unit_kind = 'window' and v_spec.height_in = 48 and v_spec.extra ->> 'material' = 'Vinyl',
    'kind ' || coalesce(v_spec.unit_kind, 'none') || ', height ' || coalesce(v_spec.height_in::text, 'none')
      || ', material ' || coalesce(v_spec.extra ->> 'material', 'none'));
  perform pg_temp.dry_run_check('filling blanks does not change where a spec came from or confirm it',
    v_spec.source = 'ai' and v_spec.confirmed = false,
    'source ' || coalesce(v_spec.source, 'none') || ', confirmed ' || coalesce(v_spec.confirmed::text, 'none'));

  -- A placeholder has no real mark, so it describes none.
  select count(*) into v_n from public.project_mark_specs
   where project_id = v_job and upper(mark_code) = m_placeholder;
  perform pg_temp.dry_run_check('a placeholder writes no spec',
    v_n = 0, 'expected 0 rows, got ' || v_n);

  -- A curtain wall is a kind the spec table now accepts.
  select * into v_spec from public.project_mark_specs
   where project_id = v_job and upper(mark_code) = m_curtain limit 1;
  perform pg_temp.dry_run_check('a curtain wall creates a curtain-wall spec',
    v_spec.unit_kind = 'curtain_wall' and v_spec.door_kind is null and v_spec.source = 'field',
    'kind ' || coalesce(v_spec.unit_kind, 'none'));

  -- A renumbered unit still describes the mark it was drawn as.
  select * into v_spec from public.project_mark_specs
   where project_id = v_job and upper(mark_code) = m_source limit 1;
  perform pg_temp.dry_run_check('a renumbered unit feeds its source mark''s spec',
    v_spec.unit_kind = 'window' and v_spec.width_in = 24 and v_spec.height_in = 36,
    'kind ' || coalesce(v_spec.unit_kind, 'none') || ', '
      || coalesce(v_spec.width_in::text, 'no width') || ' x ' || coalesce(v_spec.height_in::text, 'no height'));
  select count(*) into v_n from public.project_mark_specs
   where project_id = v_job and upper(mark_code) = m_renamed;
  perform pg_temp.dry_run_check('a renumbered unit creates no spec under its new number',
    v_n = 0, 'expected 0 rows, got ' || v_n);

  -- The counts. Eight units went on: five builder windows (new mark, confirmed
  -- mark, draft mark, renumbered, placeholder), one drawn unit with no details
  -- that reads "window" off the draft spec the builder just filled, one
  -- builder door, one curtain wall.
  select openings, windows, doors, door_sliders, door_other, unknown_units, curtain_walls
    into a
    from public.project_scope_counts where project_id = v_job;
  perform pg_temp.dry_run_check('the counts view sees all eight new units',
    a.openings - b.openings = 8, 'expected 8 more, got ' || (a.openings - b.openings));
  perform pg_temp.dry_run_check('builder windows count as windows, and a plain unit still reads its mark''s spec',
    a.windows - b.windows = 6, 'expected 6 more, got ' || (a.windows - b.windows));
  perform pg_temp.dry_run_check('a builder door counts as a door',
    a.doors - b.doors = 1 and a.door_other - b.door_other = 1,
    'doors +' || (a.doors - b.doors) || ', kind not stated +' || (a.door_other - b.door_other));
  perform pg_temp.dry_run_check('a curtain wall counts as a curtain wall',
    a.curtain_walls - b.curtain_walls = 1, 'expected 1 more, got ' || (a.curtain_walls - b.curtain_walls));
  perform pg_temp.dry_run_check('a unit that says it is a window is not counted as its mark''s sliding door',
    a.door_sliders - b.door_sliders = 0, 'expected 0 more sliders, got ' || (a.door_sliders - b.door_sliders));
  perform pg_temp.dry_run_check('no builder unit lands in the unknown bucket',
    a.unknown_units - b.unknown_units = 0, 'expected 0 more, got ' || (a.unknown_units - b.unknown_units));
  perform pg_temp.dry_run_check('the parts of the line still add up to the openings',
    a.windows + a.doors + a.curtain_walls + a.unknown_units = a.openings,
    (a.windows + a.doors + a.curtain_walls + a.unknown_units) || ' of ' || a.openings);
end $$;
