-- Rolled-back real-database dry run for monthly core-value reviews
-- (20261106000000/20261106010000). docs/db-dry-run.md; copied from
-- scripts/dry-run-probes/TEMPLATE.sql's shape. Everything here runs inside
-- the batch's one transaction and is rolled back — nothing survives,
-- including the sandbox assignment/submission rows this probe makes.
--
-- WHAT THIS PROVES ON THE REAL DATABASE, not just PGlite:
--   * the migration applies cleanly on top of the real current schema
--     (profiles, time_shifts, company_settings, app_release_notes columns
--     this build assumes actually exist and have the names this build
--     expects);
--   * values_submit() works end to end as the sandbox installer, through
--     real RLS and real grants, using the built-in pg_catalog sha256 (no
--     pgcrypto/extension-schema dependency);
--   * a plain installer and a plain foreman are both refused
--     values_owner_report();
--   * values_run_due() is inert while the scheduler flag is off (the real
--     default) and does not touch anything outside the sandbox job.
do $$
declare
  v_installer uuid;
  v_installer2 uuid;
  v_foreman uuid;
  v_job uuid;
  v_role text;
  v_n int;
  v_period date;
  v_assignment uuid;
  v_receipt jsonb;
  v_request uuid := gen_random_uuid();
  v_rubric int;
begin
  -- 1. Setup, as the system.
  perform pg_temp.dry_run_as_system();
  v_installer := pg_temp.dry_run_pick('installer');
  v_foreman := pg_temp.dry_run_pick('foreman');
  v_job := pg_temp.dry_run_sandbox_job();

  -- A second installer so the sandbox job has someone to be "worked beside",
  -- and a period so values_submit has something to validate against.
  v_installer2 := pg_temp.dry_run_pick_real('installer');
  v_period := public._values_active_period(now());
  perform public._values_ensure_period(v_period);
  v_rubric := (select rubric_version from public.values_periods where period_start = v_period);

  perform pg_temp.dry_run_check(
    'the sandbox job and both installers exist',
    v_job is not null and v_installer is not null and v_installer2 is not null,
    format('job=%s installer=%s installer2=%s', v_job, v_installer, v_installer2)
  );

  insert into public.values_assignments (period_start, rater_id, subject_id, reason)
  values (v_period, v_installer, v_installer2, 'dealt')
  returning id into v_assignment;

  -- 2. Act as the installer and call values_submit the way the app does.
  v_role := pg_temp.dry_run_act_as(v_installer);
  perform pg_temp.dry_run_check('acting as an installer with their own id',
    current_user = 'authenticated' and auth.uid() = v_installer and v_role = 'installer',
    current_user::text);

  v_receipt := public.values_submit(
    v_assignment,
    v_request,
    v_rubric,
    '[{"slug":"fullsend","score":7},{"slug":"ownership","score":8},{"slug":"integrity","score":9},{"slug":"sincerity","score":6},{"slug":"tribe","score":7},{"slug":"growth","score":5},{"slug":"strategic","score":8},{"slug":"safety","score":9}]'::jsonb,
    'Dry-run probe comment.'
  );
  perform pg_temp.dry_run_check('values_submit: accepts a complete review and returns a receipt',
    (v_receipt->>'submissionId') is not null and (v_receipt->>'replay') = 'false',
    v_receipt::text);

  -- Replay with the SAME request id and payload: identical receipt, not a
  -- second row, and quarterEligibility is byte-identical (not recomputed).
  declare
    v_replay jsonb;
  begin
    v_replay := public.values_submit(
      v_assignment, v_request, v_rubric,
      '[{"slug":"fullsend","score":7},{"slug":"ownership","score":8},{"slug":"integrity","score":9},{"slug":"sincerity","score":6},{"slug":"tribe","score":7},{"slug":"growth","score":5},{"slug":"strategic","score":8},{"slug":"safety","score":9}]'::jsonb,
      'Dry-run probe comment.'
    );
    perform pg_temp.dry_run_check('values_submit: a resend of the same request is the same receipt, not a new row',
      (v_replay->>'submissionId') = (v_receipt->>'submissionId') and (v_replay->>'replay') = 'true'
        and (v_replay->>'quarterEligibility') = (v_receipt->>'quarterEligibility'),
      v_replay::text);
  end;

  -- Direct table reads as the RATER themself (not through an RPC): the
  -- rater has NO raw-table access to their own submission or scores —
  -- only the receipt already captured above and values_my_tasks' status.
  perform pg_temp.dry_run_check(
    'direct select on values_submissions: the RATER cannot read their own raw row either',
    not exists (select 1 from public.values_submissions where id = (v_receipt->>'submissionId')::uuid),
    'checked'
  );

  -- The installer reads their own task list and sees it as submitted, with
  -- the rubric version that period is using.
  perform pg_temp.dry_run_check('values_my_tasks: the rater sees their own now-submitted assignment',
    exists (select 1 from public.values_my_tasks() t where t.assignment_id = v_assignment and t.status = 'submitted' and t.rubric_version = v_rubric),
    'checked'
  );

  -- 3. Calls that must be refused.
  perform pg_temp.dry_run_expect_error(
    'values_submit: a changed payload under the same request id is a conflict, not a silent overwrite',
    format(
      'select public.values_submit(%L::uuid, %L::uuid, %s, %L::jsonb, %L)',
      v_assignment, v_request, v_rubric,
      '[{"slug":"fullsend","score":1},{"slug":"ownership","score":8},{"slug":"integrity","score":9},{"slug":"sincerity","score":6},{"slug":"tribe","score":7},{"slug":"growth","score":5},{"slug":"strategic","score":8},{"slug":"safety","score":9}]'::jsonb,
      'Dry-run probe comment.'
    ),
    'already submitted with different answers'
  );

  perform pg_temp.dry_run_expect_error(
    'values_submit: seven scores is refused',
    format('select public.values_submit(%L::uuid, %L::uuid, %s, %L::jsonb, null)',
      v_assignment, gen_random_uuid(), v_rubric,
      '[{"slug":"fullsend","score":7},{"slug":"ownership","score":8},{"slug":"integrity","score":9},{"slug":"sincerity","score":6},{"slug":"tribe","score":7},{"slug":"growth","score":5},{"slug":"strategic","score":8}]'::jsonb),
    'All eight values'
  );

  perform pg_temp.dry_run_expect_error(
    'values_submit: a mismatched rubric version is refused',
    format('select public.values_submit(%L::uuid, %L::uuid, %s, %L::jsonb, null)',
      v_assignment, gen_random_uuid(), v_rubric + 999,
      '[{"slug":"fullsend","score":7},{"slug":"ownership","score":8},{"slug":"integrity","score":9},{"slug":"sincerity","score":6},{"slug":"tribe","score":7},{"slug":"growth","score":5},{"slug":"strategic","score":8},{"slug":"safety","score":9}]'::jsonb),
    'questions were updated'
  );

  perform pg_temp.dry_run_expect_error(
    'values_owner_report: an installer is refused',
    'select public.values_owner_report()',
    'Owner access only'
  );

  -- Foreman: refused too (not an owner).
  v_role := pg_temp.dry_run_act_as(v_foreman);
  perform pg_temp.dry_run_check('acting as a foreman with their own id',
    current_user = 'authenticated' and auth.uid() = v_foreman and v_role = 'foreman', current_user::text);
  perform pg_temp.dry_run_expect_error(
    'values_owner_report: a foreman is refused (not an owner)',
    'select public.values_owner_report()',
    'Owner access only'
  );
  perform pg_temp.dry_run_expect_error(
    'values_submit: a foreman cannot submit someone else''s assignment',
    format('select public.values_submit(%L::uuid, %L::uuid, %s, %L::jsonb, null)',
      v_assignment, gen_random_uuid(), v_rubric,
      '[{"slug":"fullsend","score":7},{"slug":"ownership","score":8},{"slug":"integrity","score":9},{"slug":"sincerity","score":6},{"slug":"tribe","score":7},{"slug":"growth","score":5},{"slug":"strategic","score":8},{"slug":"safety","score":9}]'::jsonb),
    'not assigned'
  );

  -- 4. The scheduler: inert while off (the real, deployed default).
  perform pg_temp.dry_run_as_system();
  perform pg_temp.dry_run_check(
    'the scheduler flag is off by default on this database',
    coalesce((select values_scheduler_enabled from public.company_settings where id = 1), false) = false,
    'checked'
  );
  perform pg_temp.dry_run_check(
    'values_run_due is a no-op while the scheduler is off',
    (public.values_run_due() ->> 'skipped') = 'scheduler disabled',
    (public.values_run_due())::text
  );

  -- 5. Read the truth as the system, and end there.
  perform pg_temp.dry_run_as_system();
  select count(*) into v_n from public.values_scores where submission_id = (v_receipt->>'submissionId')::uuid;
  perform pg_temp.dry_run_check('exactly eight scores landed atomically', v_n = 8, v_n || ' row(s)');

  select count(*) into v_n from public.app_release_notes where id = '2026-10-03-monthly-values-review';
  perform pg_temp.dry_run_check('the bilingual announcement exists', v_n = 1, v_n || ' row(s)');
end $$;
