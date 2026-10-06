-- Rolled-back live sandbox probe for the two atomic CAD extraction RPCs.
-- IDs and colliding marks are generated at run time; all writes target only
-- dry_run_sandbox_job() and the whole batch is rolled back by the harness.
do $$
declare
  v_foreman uuid;
  v_installer uuid;
  v_real_owner uuid;
  v_job uuid;
  v_set_a uuid := gen_random_uuid();
  v_set_b uuid := gen_random_uuid();
  v_mark_1 text := 'CAD-DR-' || replace(gen_random_uuid()::text, '-', '');
  v_mark_2 text := 'CAD-DR-' || replace(gen_random_uuid()::text, '-', '');
  v_mark_3 text := 'CAD-DR-' || replace(gen_random_uuid()::text, '-', '');
  v_open_id uuid;
  v_legacy_id uuid;
  v_field_id uuid;
  v_type_1 uuid;
  v_type_2 uuid;
  v_link_type uuid;
  v_build_set uuid;
  v_build_open_id uuid;
  v_assignment_open_id uuid;
  v_inventory_window_id uuid;
  v_import_code text;
  v_snapshot jsonb;
  v_open_before jsonb;
  v_specs_before jsonb;
  v_open_after jsonb;
  v_specs_after jsonb;
  v_ids uuid[];
  v_result jsonb;
  v_role text;
  v_shift boolean;
  v_type_details jsonb;
  v_updated_open public.project_openings;
  v_imported_type_id uuid;
  v_import_result jsonb;
  v_view_saved integer;
  v_ref_ids uuid[];
begin
  -- Pick every account and the sandbox job before switching JWT identity.
  perform pg_temp.dry_run_as_system();
  v_foreman := pg_temp.dry_run_pick('foreman');
  v_installer := pg_temp.dry_run_pick('installer');
  v_real_owner := pg_temp.dry_run_pick_real('owner');
  v_job := pg_temp.dry_run_sandbox_job();

  -- Isolated specs-kind source documents for this transaction only.
  insert into public.project_plansets (id, project_id, storage_path, source_format, status, kind)
  values (v_set_a, v_job, 'dry-run/cad-multiple-sets/a.pdf', 'pdf', 'ready', 'specs'),
         (v_set_b, v_job, 'dry-run/cad-multiple-sets/b.pdf', 'pdf', 'ready', 'specs');

  -- Existing provisional catalog rows should receive blank spec details only
  -- when the opening commit itself succeeds.
  v_type_2 := gen_random_uuid();
  insert into public.window_types (id, type_code, name, category, provisional)
  values (v_type_2, upper(v_mark_2), 'Probe placeholder', null, true);

  -- Snapshot every current live opening exactly as the RPC compares it. The
  -- generated marks below cannot overlap existing marks on the sandbox job.
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', o.id, 'opening_code', o.opening_code, 'planset_id', o.planset_id,
      'confirmed', o.confirmed, 'status', o.status, 'pin_x', o.pin_x,
      'pin_y', o.pin_y, 'page_number', o.page_number, 'assigned_to', o.assigned_to,
      'work_started_at', o.work_started_at, 'ro_width_in', o.ro_width_in,
      'ro_height_in', o.ro_height_in, 'ro_quick_ok', o.ro_quick_ok,
      'condition', o.condition, 'field_added', o.field_added
    ) order by o.id), '[]'::jsonb)
    into v_snapshot
    from public.project_openings o
   where o.project_id = v_job and o.removed_at is null;

  -- Foreman success for opening drafts (RPC one).
  v_role := pg_temp.dry_run_act_as(v_foreman);
  perform pg_temp.dry_run_check('caller is sandbox foreman',
    current_user = 'authenticated' and auth.uid() = v_foreman and v_role = 'foreman',
    current_user::text || ', ' || coalesce(v_role, 'no role'));
  v_result := public.reconcile_planset_openings(
    v_job, v_set_a, v_snapshot, array[v_mark_1, v_mark_2]::text[], '{}'::uuid[],
    jsonb_build_array(
      jsonb_build_object('opening_code', v_mark_1, 'mark_code', v_mark_1, 'label', 'dry-run first mark', 'page_number', 1),
      jsonb_build_object('opening_code', v_mark_2, 'mark_code', v_mark_2, 'label', 'dry-run second mark', 'page_number', 1)
    ), false,
    jsonb_build_array(
      jsonb_build_object('mark_code', v_mark_1, 'type_code', upper(v_mark_1),
        'name', 'Probe aluminum fixed', 'category', 'window', 'width_in', 36,
        'height_in', 48, 'notes', 'dry-run aluminum sample', 'window_type_id', null),
      jsonb_build_object('mark_code', v_mark_2, 'type_code', upper(v_mark_2),
        'name', 'Probe vinyl slider', 'category', 'window', 'width_in', 24,
        'height_in', 36, 'notes', 'dry-run vinyl sample', 'window_type_id', null)
    )
  );
  perform pg_temp.dry_run_check('reconcile_planset_openings: foreman inserts two drafts',
    v_result ->> 'inserted' = '2' and v_result ->> 'updated' = '0'
      and v_result ->> 'deleted' = '0' and v_result ->> 'catalog_written' = '0'
      and exists (
        select 1 from public.project_openings o
        where o.project_id = v_job and o.planset_id = v_set_a
          and o.opening_code = v_mark_1 and o.window_type_id is null
      )
      and exists (
        select 1 from public.window_types w
        where w.id = v_type_2 and w.provisional and w.width_in is null
          and w.height_in is null and w.category is null and w.notes is null
      )
      and (select window_type_id = v_type_2 from public.project_openings
            where project_id = v_job and planset_id = v_set_a
              and opening_code = v_mark_2),
    coalesce(v_result::text, 'no result') || '; sandbox extraction must not write/fill global catalog');

  -- Foreman success for extracted mark specs (RPC two).
  v_result := public.commit_planset_mark_specs(v_job, v_set_a, jsonb_build_array(
    jsonb_build_object('mark_code', v_mark_1, 'style', 'Probe aluminum fixed', 'source', 'deterministic'),
    jsonb_build_object('mark_code', v_mark_2, 'style', 'Probe vinyl slider', 'source', 'deterministic')
  ));
  perform pg_temp.dry_run_check('commit_planset_mark_specs: foreman saves two specs',
    v_result ->> 'saved' = '2' and v_result ->> 'skipped' = '0',
    coalesce(v_result::text, 'no result'));

  -- A real owner can see the testing job, so use that JWT to exercise
  -- global catalog creation and provisional blank-filling. The QA foreman
  -- above proved that the ordinary sandbox extraction leaves global rows
  -- untouched and still commits its openings.
  perform pg_temp.dry_run_as_system();
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', o.id, 'opening_code', o.opening_code, 'planset_id', o.planset_id,
      'confirmed', o.confirmed, 'status', o.status, 'pin_x', o.pin_x,
      'pin_y', o.pin_y, 'page_number', o.page_number, 'assigned_to', o.assigned_to,
      'work_started_at', o.work_started_at, 'ro_width_in', o.ro_width_in,
      'ro_height_in', o.ro_height_in, 'ro_quick_ok', o.ro_quick_ok,
      'condition', o.condition, 'field_added', o.field_added
    ) order by o.id), '[]'::jsonb)
    into v_snapshot from public.project_openings o
   where o.project_id = v_job and o.removed_at is null;
  select coalesce(array_agg(o.id order by o.opening_code), '{}'::uuid[])
    into v_ids from public.project_openings o
   where o.project_id = v_job and o.planset_id = v_set_a and o.removed_at is null;
  v_role := pg_temp.dry_run_act_as(v_real_owner);
  v_result := public.reconcile_planset_openings(
    v_job, v_set_a, v_snapshot, array[v_mark_1, v_mark_2]::text[], v_ids,
    jsonb_build_array(
      jsonb_build_object('opening_code', v_mark_1, 'mark_code', v_mark_1, 'label', 'dry-run first mark', 'page_number', 1),
      jsonb_build_object('opening_code', v_mark_2, 'mark_code', v_mark_2, 'label', 'dry-run second mark', 'page_number', 1)
    ), false,
    jsonb_build_array(
      jsonb_build_object('mark_code', v_mark_1, 'type_code', upper(v_mark_1),
        'name', 'Probe aluminum fixed', 'category', 'window', 'width_in', 36,
        'height_in', 48, 'notes', 'dry-run aluminum sample', 'window_type_id', null),
      jsonb_build_object('mark_code', v_mark_2, 'type_code', upper(v_mark_2),
        'name', 'Probe vinyl slider', 'category', 'window', 'width_in', 24,
        'height_in', 36, 'notes', 'dry-run vinyl sample', 'window_type_id', null)
    )
  );
  perform pg_temp.dry_run_as_system();
  perform pg_temp.dry_run_check('real owner extraction creates and fills catalog rows atomically',
    v_result ->> 'updated' = '1' and v_result ->> 'inserted' = '0'
      and v_result ->> 'deleted' = '0' and v_result ->> 'catalog_written' = '2'
      and exists (select 1 from public.project_openings o
                    join public.window_types w on w.id = o.window_type_id
                   where o.project_id = v_job and o.planset_id = v_set_a
                     and o.opening_code = v_mark_1 and w.provisional
                     and w.width_in = 36 and w.height_in = 48)
      and exists (select 1 from public.window_types w
                   where w.id = v_type_2 and w.provisional and w.width_in = 24
                     and w.height_in = 36 and w.category = 'window'
                     and w.notes = 'dry-run vinyl sample'),
    coalesce(v_result::text, 'no result'));

  -- A matching real product is carried into a newly extracted specs opening
  -- and also links an existing other-kind draft with the same normalized mark
  -- base. A suffix keeps the two live opening_code values distinct.
  perform pg_temp.dry_run_as_system();
  v_build_set := gen_random_uuid();
  v_link_type := gen_random_uuid();
  insert into public.project_plansets (id, project_id, storage_path, source_format, status, kind)
  values (v_build_set, v_job, 'dry-run/cad-multiple-sets/building.pdf', 'pdf', 'ready', 'building');
  insert into public.window_types (id, type_code, name, category, provisional)
  values (v_link_type, 'CAD-DR-REAL-' || replace(gen_random_uuid()::text, '-', ''),
          'Probe real catalog product', 'window', false);
  insert into public.project_openings (project_id, planset_id, opening_code, confirmed)
  values (v_job, v_build_set, v_mark_3 || '-1', false)
  returning id into v_build_open_id;

  select coalesce(jsonb_agg(jsonb_build_object(
      'id', o.id, 'opening_code', o.opening_code, 'planset_id', o.planset_id,
      'confirmed', o.confirmed, 'status', o.status, 'pin_x', o.pin_x,
      'pin_y', o.pin_y, 'page_number', o.page_number, 'assigned_to', o.assigned_to,
      'work_started_at', o.work_started_at, 'ro_width_in', o.ro_width_in,
      'ro_height_in', o.ro_height_in, 'ro_quick_ok', o.ro_quick_ok,
      'condition', o.condition, 'field_added', o.field_added
    ) order by o.id), '[]'::jsonb)
    into v_snapshot from public.project_openings o
   where o.project_id = v_job and o.removed_at is null;

  v_role := pg_temp.dry_run_act_as(v_real_owner);
  v_result := public.reconcile_planset_openings(
    v_job, v_set_a, v_snapshot, array[v_mark_3 || '-2']::text[], '{}'::uuid[],
    jsonb_build_array(jsonb_build_object(
      'opening_code', v_mark_3 || '-2', 'mark_code', v_mark_3 || '-2', 'label', 'matched catalog product',
      'page_number', 1, 'window_type_id', v_link_type
    )), false,
    jsonb_build_array(jsonb_build_object(
      'mark_code', v_mark_3 || '-2', 'type_code', upper(v_mark_3 || '-2'),
      'name', 'Probe matched product mark', 'category', 'window',
      'width_in', 30, 'height_in', 42, 'notes', 'dry-run matched sample',
      'window_type_id', v_link_type
    ))
  );
  perform pg_temp.dry_run_as_system();
  perform pg_temp.dry_run_check('reconcile links matched product to the new and existing same-base openings',
    v_result ->> 'inserted' = '1' and v_result ->> 'linked' = '1'
      and v_result ->> 'catalog_written' = '1'
      and exists (select 1 from public.project_openings
                   where id = v_build_open_id and window_type_id = v_link_type)
      and exists (select 1 from public.project_openings
                   where project_id = v_job and opening_code = v_mark_3 || '-2'
                     and planset_id = v_set_a and window_type_id = v_link_type)
      and exists (select 1 from public.window_types
                   where type_code = upper(v_mark_3 || '-2') and provisional),
    coalesce(v_result::text, 'no result'));

  -- The review screen's picker has a narrow foreman RPC. It changes one
  -- expected type, returns the row, and refuses stale writes. Old browser
  -- direct writes to the same column and catalog detail fields must fail.
  select id into v_open_id from public.project_openings
   where project_id = v_job and planset_id = v_set_a
     and opening_code = v_mark_3 || '-2' and removed_at is null;
  insert into public.opening_notes (opening_id, body)
  values (v_open_id, 'Rollback-only CAD reference probe');
  v_role := pg_temp.dry_run_act_as(v_foreman);
  v_ref_ids := public.planset_referenced_openings(v_job, array[v_open_id]);
  perform pg_temp.dry_run_check('browser planner sees an opening note through the same FK sweep',
    v_open_id = any(v_ref_ids), coalesce(v_ref_ids::text, 'no references'));
  v_updated_open := public.set_opening_type(v_open_id, v_type_2, v_link_type);
  perform pg_temp.dry_run_check('set_opening_type: foreman changes the expected type',
    v_updated_open.id = v_open_id and v_updated_open.window_type_id = v_type_2,
    coalesce(v_updated_open.id::text, 'no row'));
  perform pg_temp.dry_run_expect_error('set_opening_type refuses a stale review screen',
    format('select public.set_opening_type(%L::uuid,%L::uuid,%L::uuid)',
      v_open_id, v_link_type, v_link_type), 'Someone changed this window');
  perform pg_temp.dry_run_expect_error('old-client direct opening type link is refused',
    format('update public.project_openings set window_type_id = %L::uuid where id = %L::uuid',
      v_link_type, v_open_id), 'older version');
  perform pg_temp.dry_run_expect_error('old-client direct catalog metadata update is refused',
    format('update public.window_types set width_in = 999 where id = %L::uuid', v_type_2),
    'older version');
  perform pg_temp.dry_run_expect_error('old-client direct provisional catalog insert is refused',
    format('insert into public.window_types (type_code, name, category, provisional) values (%L, %L, %L, true)',
      'CAD-DR-OLD-' || replace(gen_random_uuid()::text, '-', ''),
      'old client provisional row', 'window'), 'older version');
  perform pg_temp.dry_run_expect_error('old-client catalog CSV upsert is refused',
    format('insert into public.window_types (type_code, name, width_in) values (%L, %L, 99) on conflict (type_code) do update set width_in = excluded.width_in',
      upper(v_mark_2), 'old client CSV overwrite'), 'older version');
  v_role := pg_temp.dry_run_act_as(v_installer);
  perform pg_temp.dry_run_expect_error('installer cannot use the manual opening type picker',
    format('select public.set_opening_type(%L::uuid,%L::uuid,%L::uuid)',
      v_open_id, v_link_type, v_type_2), 'Only a foreman or above');
  perform pg_temp.dry_run_as_system();
  perform pg_temp.dry_run_check('refused old-client writes preserve catalog and type link',
    (select width_in = 24 from public.window_types where id = v_type_2)
      and (select window_type_id = v_type_2 from public.project_openings where id = v_open_id),
    'catalog width and opening type remain unchanged');

  -- Assignment may fill a previously blank opening type only through its
  -- existing RPC marker. Use a generated inventory unit already assigned to
  -- the sandbox job: QA logins cannot move a unit from an unknown job, even
  -- within this rolled-back rehearsal. The blank-type fill is still tested.
  v_assignment_open_id := gen_random_uuid();
  v_inventory_window_id := gen_random_uuid();
  perform pg_temp.dry_run_as_system();
  insert into public.project_openings (id, project_id, opening_code, confirmed)
  values (v_assignment_open_id, v_job,
          'CAD-DR-ASG-' || replace(gen_random_uuid()::text, '-', ''), true);
  insert into public.windows (id, window_id, window_type_id, project_id, status)
  values (v_inventory_window_id,
          'CAD-DR-W-' || replace(gen_random_uuid()::text, '-', ''), v_type_2, v_job, 'in_warehouse');
  v_role := pg_temp.dry_run_act_as(v_installer);
  v_updated_open := public.assign_window_to_opening(v_assignment_open_id, v_inventory_window_id, null);
  perform pg_temp.dry_run_check('assign_window_to_opening: installer assignment fills the blank type',
    v_updated_open.id = v_assignment_open_id
      and v_updated_open.assigned_window_id = v_inventory_window_id
      and v_updated_open.window_type_id = v_type_2 and v_updated_open.status = 'assigned',
    coalesce(v_updated_open.id::text, 'no row'));

  -- A cached app's project-wide elevation delete must stop before it removes
  -- another file's references. The current app replaces only its own file.
  v_role := pg_temp.dry_run_act_as(v_real_owner);
  v_view_saved := public.replace_planset_elevation_views(v_job, v_set_a,
    jsonb_build_array(jsonb_build_object(
      'mark_code', v_mark_1, 'page_number', 1, 'region_index', 0,
      'pin_x', 0.2, 'pin_y', 0.3)));
  perform pg_temp.dry_run_check('first drawing gets one elevation reference',
    v_view_saved = 1, v_view_saved::text);
  v_view_saved := public.replace_planset_elevation_views(v_job, v_build_set,
    jsonb_build_array(jsonb_build_object(
      'mark_code', v_mark_3, 'page_number', 1, 'region_index', 0,
      'pin_x', 0.4, 'pin_y', 0.5)));
  perform pg_temp.dry_run_check('second drawing gets one elevation reference',
    v_view_saved = 1, v_view_saved::text);
  v_role := pg_temp.dry_run_act_as(v_foreman);
  perform pg_temp.dry_run_expect_error('cached app cannot erase project-wide elevation references',
    format('delete from public.project_mark_elevation_views where project_id = %L::uuid', v_job),
    'older version');
  v_role := pg_temp.dry_run_act_as(v_installer);
  perform pg_temp.dry_run_expect_error('installer cannot replace elevation references',
    format('select public.replace_planset_elevation_views(%L::uuid,%L::uuid,''[]''::jsonb)',
      v_job, v_set_a), 'Only a current Forge foreman');
  v_role := pg_temp.dry_run_act_as(v_real_owner);
  v_view_saved := public.replace_planset_elevation_views(v_job, v_set_a, '[]'::jsonb);
  perform pg_temp.dry_run_as_system();
  perform pg_temp.dry_run_check('re-reading one drawing leaves the other references',
    v_view_saved = 0
      and not exists (select 1 from public.project_mark_elevation_views
                       where project_id = v_job and planset_id = v_set_a)
      and exists (select 1 from public.project_mark_elevation_views
                   where project_id = v_job and planset_id = v_build_set
                     and mark_code = v_mark_3),
    'only the second drawing keeps its reference');

  -- Global catalog writes are blocked for sandbox logins, even inside this
  -- rollback-only probe. The same test uses a real owner for a generated
  -- row; both import calls are still rolled back by the outer harness.
  v_role := pg_temp.dry_run_act_as(v_foreman);
  perform pg_temp.dry_run_expect_error('sandbox foreman cannot import the global catalog',
    format('select public.import_window_types(%L::jsonb)',
      jsonb_build_array(jsonb_build_object(
        'type_code', 'CAD-DR-QA-' || replace(gen_random_uuid()::text, '-', ''),
        'name', 'QA catalog row'
      ))::text), 'Test accounts can''t import the catalog');
  v_role := pg_temp.dry_run_act_as(v_installer);
  perform pg_temp.dry_run_expect_error('installer cannot import the global catalog',
    format('select public.import_window_types(%L::jsonb)',
      jsonb_build_array(jsonb_build_object(
        'type_code', 'CAD-DR-INST-' || replace(gen_random_uuid()::text, '-', ''),
        'name', 'installer catalog row'
      ))::text), 'Only a foreman or above');
  v_role := pg_temp.dry_run_act_as(v_real_owner);
  v_import_code := 'CAD-DR-IMPORT-' || replace(gen_random_uuid()::text, '-', '');
  v_import_result := public.import_window_types(jsonb_build_array(jsonb_build_object(
    'type_code', v_import_code,
    'name', 'Probe imported product', 'category', 'slider', 'width_in', 48,
    'height_in', 36, 'difficulty_rating', 2, 'tutorial_url', null,
    'notes', 'rollback-only catalog probe'
  )));
  perform pg_temp.dry_run_check('import_window_types: real foreman inserts one catalog row',
    v_import_result ->> 'inserted' = '1' and v_import_result ->> 'updated' = '0'
      and v_import_result ->> 'total' = '1'
      and exists (select 1 from public.window_types where type_code = v_import_code
                   and name = 'Probe imported product' and width_in = 48
                   and height_in = 36 and notes = 'rollback-only catalog probe'),
    coalesce(v_import_result::text, 'no result'));
  v_import_result := public.import_window_types(jsonb_build_array(jsonb_build_object(
    'type_code', v_import_code, 'name', 'Probe updated product', 'category', 'picture',
    'width_in', 60, 'height_in', 40, 'difficulty_rating', 3,
    'tutorial_url', null, 'notes', 'updated rollback-only probe'
  )));
  perform pg_temp.dry_run_check('import_window_types: real foreman updates by type code',
    v_import_result ->> 'inserted' = '0' and v_import_result ->> 'updated' = '1'
      and v_import_result ->> 'total' = '1'
      and exists (select 1 from public.window_types where type_code = v_import_code
                   and name = 'Probe updated product' and category = 'picture'
                   and width_in = 60 and height_in = 40
                   and notes = 'updated rollback-only probe'),
    coalesce(v_import_result::text, 'no result'));
  perform pg_temp.dry_run_as_system();

  -- Create a field-added unit when the sandbox foreman is already clocked in;
  -- if not, an existing sandbox field unit can still exercise the merge below.
  perform pg_temp.dry_run_as_system();
  select exists (
    select 1 from public.time_shifts ts
     where ts.profile_id = v_foreman and ts.project_id = v_job
       and ts.status = 'open' and ts.clock_out_at is null
  ) into v_shift;
  if v_shift then
    v_role := pg_temp.dry_run_act_as(v_foreman);
    select id into v_field_id
      from public.add_field_unit(v_job, 'window', 36, 48, null, 0.5, 0.5,
                                 'CAD dry-run field unit', 1);
    perform pg_temp.dry_run_as_system();
    perform pg_temp.dry_run_check('field-unit setup created a sandbox unit',
      exists (select 1 from public.project_openings where id = v_field_id
               and project_id = v_job and field_added), coalesce(v_field_id::text, 'no id'));
  else
    select id into v_field_id from public.project_openings
     where project_id = v_job and removed_at is null and field_added
     order by created_at desc limit 1;
  end if;

  -- Capture the exact prior rows, then prove both RPCs refuse another source
  -- document's same-kind mark without altering those rows or specs.
  select coalesce(jsonb_agg(to_jsonb(o) order by o.id), '[]'::jsonb),
         coalesce(array_agg(o.id order by o.opening_code), '{}'::uuid[])
    into v_open_before, v_ids
    from public.project_openings o
   where o.project_id = v_job and o.planset_id = v_set_a and o.removed_at is null;
  select coalesce(jsonb_agg(to_jsonb(s) order by s.id), '[]'::jsonb)
    into v_specs_before
    from public.project_mark_specs s
   where s.project_id = v_job and s.planset_id = v_set_a;
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', o.id, 'opening_code', o.opening_code, 'planset_id', o.planset_id,
      'confirmed', o.confirmed, 'status', o.status, 'pin_x', o.pin_x,
      'pin_y', o.pin_y, 'page_number', o.page_number, 'assigned_to', o.assigned_to,
      'work_started_at', o.work_started_at, 'ro_width_in', o.ro_width_in,
      'ro_height_in', o.ro_height_in, 'ro_quick_ok', o.ro_quick_ok,
      'condition', o.condition, 'field_added', o.field_added
    ) order by o.id), '[]'::jsonb)
    into v_snapshot
    from public.project_openings o
   where o.project_id = v_job and o.removed_at is null;

  v_role := pg_temp.dry_run_act_as(v_foreman);
  perform pg_temp.dry_run_expect_error('opening RPC refuses a same-kind mark owned by another plan set',
    format('select public.reconcile_planset_openings(%L::uuid,%L::uuid,%L::jsonb,%L::text[],%L::uuid[],''[]''::jsonb,false)',
      v_job, v_set_b, v_snapshot::text, array[v_mark_1]::text[], '{}'::uuid[]),
    'another plan set');
  perform pg_temp.dry_run_expect_error('spec RPC refuses a same-kind mark owned by another plan set',
    format('select public.commit_planset_mark_specs(%L::uuid,%L::uuid,%L::jsonb)',
      v_job, v_set_b,
      jsonb_build_array(jsonb_build_object('mark_code', v_mark_1, 'source', 'deterministic'))::text),
    'another plan set');
  perform pg_temp.dry_run_expect_error('refused multi-set read does not create an unrelated catalog type',
    format('select public.reconcile_planset_openings(%L::uuid,%L::uuid,%L::jsonb,%L::text[],%L::uuid[],''[]''::jsonb,false,%L::jsonb)',
      v_job, v_set_b, v_snapshot::text,
      array[v_mark_1, v_mark_3]::text[], '{}'::uuid[],
      jsonb_build_array(jsonb_build_object(
        'mark_code', v_mark_3, 'type_code', upper(v_mark_3), 'name', 'must not be created',
        'category', 'window', 'width_in', 30, 'height_in', 42, 'notes', null,
        'window_type_id', null
      ))::text), 'another plan set');

  perform pg_temp.dry_run_as_system();
  perform pg_temp.dry_run_check('refused multi-set read left no provisional type behind',
    not exists (select 1 from public.window_types where type_code = upper(v_mark_3)),
    'no catalog row for the unrelated mark');
  select coalesce(jsonb_agg(to_jsonb(o) order by o.id), '[]'::jsonb)
    into v_open_after from public.project_openings o
   where o.project_id = v_job and o.planset_id = v_set_a and o.removed_at is null;
  select coalesce(jsonb_agg(to_jsonb(s) order by s.id), '[]'::jsonb)
    into v_specs_after from public.project_mark_specs s
   where s.project_id = v_job and s.planset_id = v_set_a;
  perform pg_temp.dry_run_check('collision refusals preserve prior opening rows',
    v_open_after = v_open_before, 'before=' || v_open_before::text || '; after=' || v_open_after::text);
  perform pg_temp.dry_run_check('collision refusals preserve prior mark specs',
    v_specs_after = v_specs_before, 'before=' || v_specs_before::text || '; after=' || v_specs_after::text);

  -- Older clients must be stopped before their direct DELETE or extractor
  -- INSERT can bypass the atomic commit functions.
  v_role := pg_temp.dry_run_act_as(v_foreman);
  v_open_id := v_ids[1];
  perform pg_temp.dry_run_expect_error('old-client direct delete is refused',
    format('delete from public.project_openings where id = %L::uuid', v_open_id),
    'older version');
  perform pg_temp.dry_run_expect_error('old-client direct draft insert is refused',
    format('insert into public.project_openings (project_id, planset_id, opening_code, confirmed) values (%L::uuid,%L::uuid,%L,false)',
      v_job, v_set_a, 'CAD-DR-OLD-' || replace(gen_random_uuid()::text, '-', '')),
    'older version');

  -- Pre-provenance drafts are especially vulnerable: an older browser used
  -- to delete them in one request, then insert replacements in another.
  -- The first request must be refused too, even though planset_id is NULL.
  perform pg_temp.dry_run_as_system();
  insert into public.project_openings (project_id, planset_id, opening_code, confirmed)
    values (v_job, null, 'CAD-DR-LEGACY-' || replace(gen_random_uuid()::text, '-', ''), false)
    returning id into v_legacy_id;
  v_role := pg_temp.dry_run_act_as(v_foreman);
  perform pg_temp.dry_run_expect_error('old-client direct legacy draft delete is refused',
    format('delete from public.project_openings where id = %L::uuid', v_legacy_id),
    'older version');
  perform pg_temp.dry_run_as_system();
  perform pg_temp.dry_run_check('legacy draft survives rejected old-client delete',
    exists (select 1 from public.project_openings where id = v_legacy_id),
    'legacy row retained');

  -- Installer JWT must be denied by each RPC before any plan-set write.
  v_role := pg_temp.dry_run_act_as(v_installer);
  perform pg_temp.dry_run_expect_error('installer cannot call opening reconcile',
    format('select public.reconcile_planset_openings(%L::uuid,%L::uuid,''[]''::jsonb,''{}''::text[],''{}''::uuid[],''[]''::jsonb,false)',
      v_job, v_set_a), 'Only a foreman or above');
  perform pg_temp.dry_run_expect_error('installer cannot commit mark specs',
    format('select public.commit_planset_mark_specs(%L::uuid,%L::uuid,''[]''::jsonb)',
      v_job, v_set_a), 'Only a foreman or above');

  -- A successful later CAD save preserves an existing field-added row by
  -- carrying it in the full current snapshot and excluding it from deletes.
  perform pg_temp.dry_run_as_system();
  if v_field_id is not null then
    select coalesce(jsonb_agg(jsonb_build_object(
        'id', o.id, 'opening_code', o.opening_code, 'planset_id', o.planset_id,
        'confirmed', o.confirmed, 'status', o.status, 'pin_x', o.pin_x,
        'pin_y', o.pin_y, 'page_number', o.page_number, 'assigned_to', o.assigned_to,
        'work_started_at', o.work_started_at, 'ro_width_in', o.ro_width_in,
        'ro_height_in', o.ro_height_in, 'ro_quick_ok', o.ro_quick_ok,
        'condition', o.condition, 'field_added', o.field_added
      ) order by o.id), '[]'::jsonb)
      into v_snapshot from public.project_openings o
     where o.project_id = v_job and o.removed_at is null;
    v_role := pg_temp.dry_run_act_as(v_foreman);
    v_result := public.reconcile_planset_openings(
      v_job, v_set_a, v_snapshot, array[v_mark_1, v_mark_3]::text[], v_ids,
      jsonb_build_array(
        jsonb_build_object('opening_code', v_mark_1, 'mark_code', v_mark_1, 'label', 'updated CAD draft', 'page_number', 1),
        jsonb_build_object('opening_code', v_mark_3, 'mark_code', v_mark_3, 'label', 'new CAD draft', 'page_number', 1)
      ), false
    );
    perform pg_temp.dry_run_as_system();
    perform pg_temp.dry_run_check('valid CAD merge keeps the field-added unit',
      v_result ->> 'updated' = '1' and v_result ->> 'inserted' = '1'
       and v_result ->> 'deleted' = '1'
       and exists (select 1 from public.project_openings where id = v_field_id
                    and project_id = v_job and field_added and removed_at is null),
      coalesce(v_result::text, 'no result') || '; field=' || v_field_id::text);
  else
    perform pg_temp.dry_run_check('valid CAD merge keeps a field-added unit', true,
      'skipped: no field-added row or open sandbox foreman shift was available');
  end if;
end $$;
