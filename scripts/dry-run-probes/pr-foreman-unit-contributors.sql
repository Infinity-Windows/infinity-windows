-- Exercise record_stage_contributors, stage_contributor_summary,
-- correct_stage_contributors and the hardened record_crew_work against the
-- actual schema on the sandbox job. db-dry-run owns the transaction and
-- rolls every one of these writes back.
--
-- Codex review before dispatch: v_foreman and v_installer are the ONLY two
-- QA logins dry_run_pick can hand back (one per role); dry_run_pick_real
-- gives a REAL person, never a second QA identity. The hardened
-- same-test-partition worker rule correctly refuses mixing a QA actor's
-- record with a real person as a NAMED CONTRIBUTOR — so every multi-person
-- WRITE below uses v_foreman and v_installer together (both QA/test), and
-- v_installer2 (real) is used only as a READER, to prove the opposite side
-- of the partition rule (a real, non-supervisor person must not see a test
-- job's contributor summary). The two-actual-installers case the compact
-- panel is built for is covered locally (UnitContributors.test.tsx), where
-- a second QA installer identity is not required to prove the RPC contract.
do $$
declare
  v_foreman uuid;
  v_installer uuid;
  v_installer2 uuid;
  v_job uuid;
  v_opening uuid := gen_random_uuid();
  v_unit_from_opening uuid;
  v_saved_unit uuid := gen_random_uuid();
  v_request uuid := gen_random_uuid();
  v_actor_role text;
  v_count int;
  v_digest text;
  v_digest2 text;
  v_result uuid;
  -- Whole-row snapshots, not emptiness assumptions: the sandbox job already
  -- carries real history from other probes and fixtures.
  v_shifts_before jsonb; v_shifts_after jsonb;
  v_sessions_before jsonb; v_sessions_after jsonb;
  v_unit_sessions_before jsonb; v_unit_sessions_after jsonb;
  v_phases_before jsonb; v_phases_after jsonb;
  v_assignments_before jsonb; v_assignments_after jsonb;
  v_points_before jsonb; v_points_after jsonb;
  v_opening_before jsonb; v_opening_after jsonb;
  v_unit_facts_before jsonb; v_unit_facts_after jsonb;
  v_unit_revision_before int; v_unit_revision_after int;
begin
  perform pg_temp.dry_run_as_system();
  v_foreman := pg_temp.dry_run_pick('foreman');
  v_installer := pg_temp.dry_run_pick('installer');
  v_installer2 := pg_temp.dry_run_pick_real('installer');
  v_job := pg_temp.dry_run_sandbox_job();
  insert into public.project_openings(id, project_id, opening_code, status)
    values (v_opening, v_job, 'DRY-SC-' || left(v_opening::text, 8), 'planned');

  -- A saved unit the foreman already built, for the "existing unit" path.
  v_actor_role := pg_temp.dry_run_act_as(v_foreman);
  perform pg_temp.dry_run_check('contributors: foreman role selected', v_actor_role = 'foreman', v_actor_role);
  perform public.record_crew_work(v_saved_unit, jsonb_build_object(
    'unit', jsonb_build_object('id', v_saved_unit, 'revision', 0, 'project_id', v_job, 'opening_id', null,
      'label', 'DRY-SC unit ' || left(v_saved_unit::text, 6), 'type_label', 'Bifold door', 'facts', '{}'::jsonb),
    'people', jsonb_build_array(v_installer), 'work_date', current_date::text,
    'stage', 'Installing', 'outcome', 'assigned', 'description', 'Assigned for the dry run'));
  -- record_crew_work's own replay: same id, same payload, no second row.
  perform public.record_crew_work(v_saved_unit, jsonb_build_object(
    'unit', jsonb_build_object('id', v_saved_unit, 'revision', 0, 'project_id', v_job, 'opening_id', null,
      'label', 'DRY-SC unit ' || left(v_saved_unit::text, 6), 'type_label', 'Bifold door', 'facts', '{}'::jsonb),
    'people', jsonb_build_array(v_installer), 'work_date', current_date::text,
    'stage', 'Installing', 'outcome', 'assigned', 'description', 'Assigned for the dry run'));
  perform pg_temp.dry_run_as_system();
  select count(*) into v_count from public.crew_work_records where id = v_saved_unit;
  perform pg_temp.dry_run_check('record_crew_work: replay created exactly one report row', v_count = 1, v_count || ' row(s)');

  -- Whole-row snapshots of every table a contributor action must never
  -- touch, taken once real fixture activity (the assignment above) exists.
  select coalesce(jsonb_agg(to_jsonb(t) order by t.id), '[]') into v_shifts_before from public.time_shifts t where t.project_id = v_job;
  select coalesce(jsonb_agg(to_jsonb(t) order by t.id), '[]') into v_sessions_before from public.custom_work_sessions t where t.project_id = v_job;
  select coalesce(jsonb_agg(to_jsonb(t) order by t.id), '[]') into v_unit_sessions_before from public.unit_sessions t where t.opening_id in (select id from public.project_openings where project_id = v_job);
  select coalesce(jsonb_agg(to_jsonb(t) order by t.id), '[]') into v_phases_before from public.opening_phases t where t.started_by in (v_foreman, v_installer, v_installer2);
  select coalesce(jsonb_agg(to_jsonb(t) order by t.id), '[]') into v_assignments_before from public.schedule_assignment_members t where t.profile_id in (v_foreman, v_installer, v_installer2);
  select coalesce(jsonb_agg(to_jsonb(t) order by t.id), '[]') into v_points_before from public.points_ledger t where t.profile_id in (v_foreman, v_installer, v_installer2);
  select to_jsonb(t) into v_opening_before from public.project_openings t where t.id = v_opening;
  select facts, revision into v_unit_facts_before, v_unit_revision_before from public.custom_work_units where id = v_saved_unit;

  -- record_stage_contributors on that saved unit: one installer, RO checked.
  perform pg_temp.dry_run_act_as(v_foreman);
  perform public.record_stage_contributors(v_request, jsonb_build_object(
    'unit_id', v_saved_unit, 'stage', 'RO checked', 'work_date', (current_date - 1)::text,
    'outcome', 'finished', 'people', jsonb_build_array(v_installer)));
  perform pg_temp.dry_run_as_system();
  select count(*) into v_count from public.crew_work_record_people p join public.crew_work_records r on r.id = p.record_id
    where r.unit_id = v_saved_unit and r.stage = 'RO checked' and p.voided_at is null;
  perform pg_temp.dry_run_check('contributors: one effective RO-checked contributor', v_count = 1, v_count || ' row(s)');

  -- Replay the same request id: no new row, same unit back.
  perform pg_temp.dry_run_act_as(v_foreman);
  v_result := public.record_stage_contributors(v_request, jsonb_build_object(
    'unit_id', v_saved_unit, 'stage', 'RO checked', 'work_date', (current_date - 1)::text,
    'outcome', 'finished', 'people', jsonb_build_array(v_installer)));
  perform pg_temp.dry_run_check('contributors: replay returns the same unit', v_result = v_saved_unit, v_result::text);
  perform pg_temp.dry_run_as_system();
  select count(*) into v_count from public.crew_work_record_people p join public.crew_work_records r on r.id = p.record_id
    where r.unit_id = v_saved_unit and r.stage = 'RO checked' and p.voided_at is null;
  perform pg_temp.dry_run_check('contributors: replay created no new row', v_count = 1, v_count || ' row(s)');

  -- Fresh semantic overlap: a NEW request id naming the same installer PLUS
  -- the foreman adds only the foreman — dedupe is against effective reports,
  -- not against this request's own receipt.
  perform pg_temp.dry_run_act_as(v_foreman);
  perform public.record_stage_contributors(gen_random_uuid(), jsonb_build_object(
    'unit_id', v_saved_unit, 'stage', 'RO checked', 'work_date', (current_date - 1)::text,
    'outcome', 'finished', 'people', jsonb_build_array(v_installer, v_foreman)));
  perform pg_temp.dry_run_as_system();
  select count(*) into v_count from public.crew_work_record_people p join public.crew_work_records r on r.id = p.record_id
    where r.unit_id = v_saved_unit and r.stage = 'RO checked' and p.voided_at is null;
  perform pg_temp.dry_run_check('contributors: fresh overlap adds only the new person', v_count = 2, v_count || ' effective');

  -- A mapped opening with no saved unit: record_stage_contributors makes the
  -- one necessary companion unit from plan data, not a client-supplied one.
  perform pg_temp.dry_run_act_as(v_foreman);
  perform public.record_stage_contributors(gen_random_uuid(), jsonb_build_object(
    'opening_id', v_opening, 'stage', 'Flashing', 'work_date', (current_date - 1)::text,
    'outcome', 'partial', 'people', jsonb_build_array(v_installer, v_foreman)));
  perform pg_temp.dry_run_as_system();
  select id into v_unit_from_opening from public.custom_work_units where opening_id = v_opening;
  perform pg_temp.dry_run_check('contributors: exactly one companion unit for the opening', v_unit_from_opening is not null, coalesce(v_unit_from_opening::text, 'none'));
  select count(*) into v_count from public.custom_work_units where opening_id = v_opening;
  perform pg_temp.dry_run_check('contributors: no duplicate companion unit', v_count = 1, v_count || ' row(s)');

  -- Installer cannot file a contributor record or correct one.
  perform pg_temp.dry_run_act_as(v_installer);
  perform pg_temp.dry_run_expect_error('contributors: installer cannot record contributors',
    format('select public.record_stage_contributors(%L::uuid,%L::jsonb)', gen_random_uuid(),
      jsonb_build_object('unit_id', v_saved_unit, 'stage', 'RO checked', 'work_date', (current_date - 1)::text,
        'outcome', 'finished', 'people', jsonb_build_array(v_installer))), 'foreman');
  perform pg_temp.dry_run_expect_error('contributors: installer cannot correct a contributor record',
    format('select public.correct_stage_contributors(%L::uuid,%L::jsonb)', gen_random_uuid(),
      jsonb_build_object('unit_id', v_saved_unit, 'stage', 'RO checked', 'work_date', (current_date - 1)::text,
        'expected_digest', 'x', 'reason', 'probe', 'remove', jsonb_build_array(v_installer))), 'foreman');

  -- Summary visibility is partitioned both ways: the QA foreman (test) sees
  -- this test-job unit; a REAL installer, reading only, does not.
  perform pg_temp.dry_run_act_as(v_foreman);
  select count(*) into v_count from public.stage_contributor_summary(v_saved_unit) where stage = 'RO checked' and work_date = current_date - 1;
  perform pg_temp.dry_run_check('contributors: the QA actor (same partition) can read the summary', v_count > 0, v_count || ' row(s)');
  perform pg_temp.dry_run_act_as(v_installer2);
  select count(*) into v_count from public.stage_contributor_summary(v_saved_unit) where stage = 'RO checked' and work_date = current_date - 1;
  perform pg_temp.dry_run_check('contributors: a real, non-supervisor reader does not see the test job''s summary', v_count = 0, v_count || ' row(s)');

  -- Correction: a stale digest is refused; the live one voids and replaces.
  perform pg_temp.dry_run_act_as(v_foreman);
  select digest into v_digest from public.stage_contributor_summary(v_saved_unit) where stage = 'RO checked' and work_date = current_date - 1 and profile_id = v_installer limit 1;
  perform pg_temp.dry_run_expect_error('contributors: a stale digest is refused',
    format('select public.correct_stage_contributors(%L::uuid,%L::jsonb)', gen_random_uuid(),
      jsonb_build_object('unit_id', v_saved_unit, 'stage', 'RO checked', 'work_date', (current_date - 1)::text,
        'expected_digest', 'not-the-real-digest', 'reason', 'probe', 'remove', jsonb_build_array(v_installer))),
    'changed');
  v_result := public.correct_stage_contributors(gen_random_uuid(), jsonb_build_object(
    'unit_id', v_saved_unit, 'stage', 'RO checked', 'work_date', (current_date - 1)::text,
    'expected_digest', v_digest, 'reason', 'Dry-run probe correction', 'remove', jsonb_build_array(v_installer), 'add', jsonb_build_array(v_installer), 'outcome', 'finished'));
  perform pg_temp.dry_run_as_system();
  select count(*) into v_count from public.crew_work_record_people where profile_id = v_installer and voided_at is not null and void_reason = 'Dry-run probe correction';
  perform pg_temp.dry_run_check('contributors: the void reason was recorded', v_count = 1, v_count || ' row(s)');
  select count(*) into v_count from public.crew_work_record_people p join public.crew_work_records r on r.id = p.record_id
    where r.unit_id = v_saved_unit and r.stage = 'RO checked' and r.work_date = current_date - 1 and p.voided_at is null and p.profile_id = v_installer;
  perform pg_temp.dry_run_check('contributors: the same person re-added under new evidence is effective again', v_count = 1, v_count || ' row(s)');

  -- Source-evidence digest sensitivity: the new evidence from the void+readd
  -- above changed the digest, even though the distinct people are the same
  -- as right before it — a correction built against the EARLIER digest is
  -- now stale, not merely against the literal string used above.
  perform pg_temp.dry_run_act_as(v_foreman);
  select digest into v_digest2 from public.stage_contributor_summary(v_saved_unit) where stage = 'RO checked' and work_date = current_date - 1 and profile_id = v_installer limit 1;
  perform pg_temp.dry_run_check('contributors: evidence digest changed after the void+readd', v_digest2 is distinct from v_digest, coalesce(v_digest2, 'null'));
  perform pg_temp.dry_run_expect_error('contributors: the pre-swap digest is now stale too',
    format('select public.correct_stage_contributors(%L::uuid,%L::jsonb)', gen_random_uuid(),
      jsonb_build_object('unit_id', v_saved_unit, 'stage', 'RO checked', 'work_date', (current_date - 1)::text,
        'expected_digest', v_digest, 'reason', 'stale retry', 'remove', jsonb_build_array(v_installer))),
    'changed');
  -- The correction's own replay: same id, same payload, does not re-apply.
  v_result := public.correct_stage_contributors(v_result, jsonb_build_object(
    'unit_id', v_saved_unit, 'stage', 'RO checked', 'work_date', (current_date - 1)::text,
    'expected_digest', v_digest, 'reason', 'Dry-run probe correction', 'remove', jsonb_build_array(v_installer), 'add', jsonb_build_array(v_installer), 'outcome', 'finished'));
  perform pg_temp.dry_run_check('contributors: correction replay returns the same unit', v_result = v_saved_unit, v_result::text);

  -- Nothing here changed the mapped opening's own status/assignment, nor the
  -- saved unit's facts/revision (no unit "edit" happened, only attribution).
  perform pg_temp.dry_run_as_system();
  select to_jsonb(t) into v_opening_after from public.project_openings t where t.id = v_opening;
  perform pg_temp.dry_run_check('contributors: the mapped opening''s own row is unchanged (status/assignment/QC)',
    v_opening_after = v_opening_before, v_opening_after::text);
  select facts, revision into v_unit_facts_after, v_unit_revision_after from public.custom_work_units where id = v_saved_unit;
  perform pg_temp.dry_run_check('contributors: the saved unit''s facts are unchanged', v_unit_facts_after = v_unit_facts_before, v_unit_facts_after::text);
  perform pg_temp.dry_run_check('contributors: the saved unit''s revision did not move (no unit edit)', v_unit_revision_after = v_unit_revision_before, v_unit_revision_after || ' vs ' || v_unit_revision_before);

  -- Nothing here touched payroll, timers, phases, schedule assignments or
  -- points: whole-row snapshots match exactly, not merely "still zero".
  select coalesce(jsonb_agg(to_jsonb(t) order by t.id), '[]') into v_shifts_after from public.time_shifts t where t.project_id = v_job;
  select coalesce(jsonb_agg(to_jsonb(t) order by t.id), '[]') into v_sessions_after from public.custom_work_sessions t where t.project_id = v_job;
  select coalesce(jsonb_agg(to_jsonb(t) order by t.id), '[]') into v_unit_sessions_after from public.unit_sessions t where t.opening_id in (select id from public.project_openings where project_id = v_job);
  select coalesce(jsonb_agg(to_jsonb(t) order by t.id), '[]') into v_phases_after from public.opening_phases t where t.started_by in (v_foreman, v_installer, v_installer2);
  select coalesce(jsonb_agg(to_jsonb(t) order by t.id), '[]') into v_assignments_after from public.schedule_assignment_members t where t.profile_id in (v_foreman, v_installer, v_installer2);
  select coalesce(jsonb_agg(to_jsonb(t) order by t.id), '[]') into v_points_after from public.points_ledger t where t.profile_id in (v_foreman, v_installer, v_installer2);
  perform pg_temp.dry_run_check('contributors: time_shifts snapshot unchanged', v_shifts_after = v_shifts_before, 'before ' || jsonb_array_length(v_shifts_before) || ', after ' || jsonb_array_length(v_shifts_after));
  perform pg_temp.dry_run_check('contributors: custom_work_sessions snapshot unchanged', v_sessions_after = v_sessions_before, 'before ' || jsonb_array_length(v_sessions_before) || ', after ' || jsonb_array_length(v_sessions_after));
  perform pg_temp.dry_run_check('contributors: unit_sessions (map timers) snapshot unchanged', v_unit_sessions_after = v_unit_sessions_before, 'before ' || jsonb_array_length(v_unit_sessions_before) || ', after ' || jsonb_array_length(v_unit_sessions_after));
  perform pg_temp.dry_run_check('contributors: opening_phases (flashing) snapshot unchanged', v_phases_after = v_phases_before, 'before ' || jsonb_array_length(v_phases_before) || ', after ' || jsonb_array_length(v_phases_after));
  perform pg_temp.dry_run_check('contributors: schedule_assignment_members snapshot unchanged', v_assignments_after = v_assignments_before, 'before ' || jsonb_array_length(v_assignments_before) || ', after ' || jsonb_array_length(v_assignments_after));
  perform pg_temp.dry_run_check('contributors: points_ledger snapshot unchanged', v_points_after = v_points_before, 'before ' || jsonb_array_length(v_points_before) || ', after ' || jsonb_array_length(v_points_after));
end $$;
