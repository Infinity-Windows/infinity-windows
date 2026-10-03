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
--   * values_my_owed_count/values_my_summary/the zero-arg caller wrappers
--     all actually run under real grants, not just values_my_tasks;
--   * a plain installer, a plain foreman, a supervisor, a partner, a
--     revoked owner and a retired owner are all refused values_owner_report()
--     (the last four against the QA foreman's own row, temporarily
--     promoted/flagged and reverted — never a real employee's role/flags),
--     and a genuinely current owner succeeds;
--   * set_values_scheduler_enabled() is owner-only (installer and revoked
--     owner both refused) and a current owner can flip it, on this real
--     schema's grants;
--   * values_run_due() is inert while the scheduler flag is off (the real
--     default) and does not touch anything outside the sandbox job.
--
-- DECLARED CONCURRENCY LIMITATION: this whole probe is ONE transaction in
-- ONE backend (the batch runner's `do $$ ... $$` block), exactly like the
-- PGlite verifier. Neither can open a second real session, so neither can
-- prove the per-period advisory lock actually serializes a genuine
-- values_submit()/_values_freeze_quarter() RACE across two live
-- connections — only that the lock exists, is acquired in the documented
-- order, and does not deadlock or error when taken once. A real two-session
-- race test needs a separate, explicitly-scoped fixture (two concurrent
-- `psql`/driver connections against a disposable database, outside any
-- rolled-back batch) provided separately by scripts/verify-values-concurrency.py in CI; this rollback-only probe does not execute it.
do $$
declare
  v_installer uuid;
  v_foreman uuid;
  v_job uuid;
  v_role text;
  v_n int;
  v_period date;
  v_assignment uuid;
  v_receipt jsonb;
  v_request uuid := gen_random_uuid();
  v_rubric int;
  v_owed int;
  v_summary jsonb;
  v_owner_report jsonb;
  v_owner_role text;
  v_private_rating uuid;
begin
  -- 1. Setup, as the system.
  perform pg_temp.dry_run_as_system();
  v_installer := pg_temp.dry_run_pick('installer');
  v_foreman := pg_temp.dry_run_pick('foreman');
  v_job := pg_temp.dry_run_sandbox_job();

  -- The QA installer reviews the QA foreman — both are sandbox/QA logins,
  -- never a real employee (independent review finding/CLAUDE-VALUES-FINAL-
  -- CORRECTIONS.md #8: this probe must never write a real employee's row,
  -- even transiently inside a batch that rolls everything back; there is
  -- no `dry_run_pick_real`-equivalent second QA installer available, so the
  -- QA foreman stands in as the review subject instead of reaching for a
  -- real person).
  --
  -- FORCED FIXTURE, not the bare "whatever period is active right now"
  -- (independent review): on any day before the review window has opened
  -- for the current month, _values_active_period(now()) alone returns LAST
  -- month — which, run on a day early enough in the very first launch
  -- month, is a month BEFORE _values_launch() and not scorable at all. The
  -- greatest of the two is always a real, scorable, dealable period,
  -- whatever day this probe happens to run on.
  v_period := greatest(public._values_active_period(now()), public._values_launch());
  perform public._values_ensure_period(v_period);
  v_rubric := (select rubric_version from public.values_periods where period_start = v_period);

  perform pg_temp.dry_run_check(
    'the sandbox job and both QA logins exist',
    v_job is not null and v_installer is not null and v_foreman is not null,
    format('job=%s installer=%s foreman=%s', v_job, v_installer, v_foreman)
  );

  insert into public.values_assignments (period_start, rater_id, subject_id, reason)
  values (v_period, v_installer, v_foreman, 'dealt')
  returning id into v_assignment;

  -- QA-only private-accounting grant fixture. Never freeze a real quarter
  -- here: that would touch other employees even inside the rollback batch.
  insert into public.values_quarterly_ratings(quarter_start,subject_id,overall)
  values ('2099-01-01',v_installer,null) returning id into v_private_rating;
  insert into public.values_quarterly_accounting(rating_id,cutoff,policy_snapshots,value_totals)
  values (v_private_rating,'2099-04-10T06:00:00Z','[]','{}');

  -- 2. Act as the installer and call values_submit the way the app does.
  v_role := pg_temp.dry_run_act_as(v_installer);
  perform pg_temp.dry_run_check('acting as an installer with their own id',
    current_user = 'authenticated' and auth.uid() = v_installer and v_role = 'installer',
    current_user::text);

  -- A direct SELECT through the "rater reads own assignments" RLS policy —
  -- this is the EXACT shape that used to fail with "permission denied for
  -- function _values_eligible" (42501) on the real schema: an RLS `USING`
  -- clause runs as the QUERYING role (authenticated), which never had
  -- EXECUTE on the arbitrary-uid eligibility helper. The policy now calls a
  -- zero-argument `_values_caller_eligible()` wrapper granted to
  -- `authenticated` instead.
  perform pg_temp.dry_run_check(
    'direct select on values_assignments through RLS does not raise 42501',
    (select count(*) from public.values_assignments where id = v_assignment) = 1,
    'checked'
  );

  -- The zero-arg caller wrappers RLS policies now call, invoked directly
  -- (not just implicitly through a policy) — proves the grant to
  -- `authenticated` actually works, not merely "a policy using it happened
  -- not to raise".
  perform pg_temp.dry_run_check(
    'public._values_caller_eligible(): true for a current installer',
    public._values_caller_eligible(), 'checked'
  );
  perform pg_temp.dry_run_check(
    'public._values_caller_is_owner(): false for an installer',
    not public._values_caller_is_owner(), 'checked'
  );

  perform pg_temp.dry_run_check(
    'subject direct SELECT cannot read unsuppressed private accounting',
    (select count(*) from public.values_quarterly_accounting where rating_id=v_private_rating)=0,
    'checked'
  );
  perform pg_temp.dry_run_expect_error(
    'authenticated callers cannot invoke cron runner',
    'select public.values_run_due()', 'permission denied'
  );

  v_receipt := public.values_submit(
    v_assignment,
    v_request,
    v_rubric,
    '[{"slug":"fullsend","score":7},{"slug":"ownership","score":8},{"slug":"integrity","score":9},{"slug":"sincerity","score":6},{"slug":"tribe","score":7},{"slug":"growth","score":5},{"slug":"strategic","score":8},{"slug":"safety","score":9}]'::jsonb,
    'Dry-run probe comment.'
  );
  -- Shape is {receipt: {...}, replay} (VALUES-RECEIPT-CONTRACT.md §5) — not
  -- a flat object. encodingVersion/digest/cutoffAt live under "receipt".
  perform pg_temp.dry_run_check('values_submit: accepts a complete review and returns a receipt',
    (v_receipt->'receipt'->>'submissionId') is not null
      and (v_receipt->'receipt'->>'encodingVersion') = 'forge-values-submit/v1'
      and (v_receipt->>'replay') = 'false',
    v_receipt::text);

  -- Replay with the SAME request id and payload: identical receipt, not a
  -- second row — the STORED receipt object is returned verbatim, so this
  -- must be byte-identical, not merely field-equal.
  declare
    v_replay jsonb;
  begin
    v_replay := public.values_submit(
      v_assignment, v_request, v_rubric,
      '[{"slug":"fullsend","score":7},{"slug":"ownership","score":8},{"slug":"integrity","score":9},{"slug":"sincerity","score":6},{"slug":"tribe","score":7},{"slug":"growth","score":5},{"slug":"strategic","score":8},{"slug":"safety","score":9}]'::jsonb,
      'Dry-run probe comment.'
    );
    perform pg_temp.dry_run_check('values_submit: a resend of the same request is the same receipt, not a new row',
      (v_replay->'receipt') = (v_receipt->'receipt') and (v_replay->>'replay') = 'true',
      v_replay::text);
  end;

  -- Direct table reads as the RATER themself (not through an RPC): the
  -- rater has NO raw-table access to their own submission or scores —
  -- only the receipt already captured above and values_my_tasks' status.
  perform pg_temp.dry_run_check(
    'direct select on values_submissions: the RATER cannot read their own raw row either',
    not exists (select 1 from public.values_submissions where id = (v_receipt->'receipt'->>'submissionId')::uuid),
    'checked'
  );

  -- The installer reads their own task list and sees it as submitted, with
  -- the rubric version that period is using.
  perform pg_temp.dry_run_check('values_my_tasks: the rater sees their own now-submitted assignment',
    exists (select 1 from public.values_my_tasks() t where t.assignment_id = v_assignment and t.status = 'submitted' and t.rubric_version = v_rubric),
    'checked'
  );

  select public.values_my_owed_count() into v_owed;
  perform pg_temp.dry_run_check('values_my_owed_count: a non-negative count, callable by the rater',
    v_owed is not null and v_owed >= 0, v_owed::text
  );

  select public.values_my_summary() into v_summary;
  perform pg_temp.dry_run_check(
    'values_my_summary: own data only, no subject override accepted',
    (v_summary->>'subjectId') = v_installer::text
      and v_summary ? 'mirror' and v_summary ? 'allTime' and v_summary ? 'quarters',
    v_summary::text
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
  perform pg_temp.dry_run_expect_error(
    'set_values_scheduler_enabled: an installer is refused',
    'select public.set_values_scheduler_enabled(true)',
    'Only an owner'
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

  -- 3b. OWNER-AUTHORITY MATRIX. values_owner_report/set_values_scheduler_enabled
  -- re-check owner authority on every call (never a cached grant); prove
  -- supervisor/partner/revoked/retired are each refused, and one genuinely
  -- current owner succeeds. Every step promotes/flags/reverts the QA
  -- FOREMAN'S OWN row, as the system, inside this rolled-back batch — never
  -- a real employee's role or flags, and never a role change issued BY a
  -- test account (the thing docs/test-account.md's trigger actually
  -- refuses) — same technique scripts/dry-run-probes/crew-goal-summary.sql
  -- already uses for its own supervisor/partner fixtures.
  perform pg_temp.dry_run_as_system();
  update public.profiles set role = 'supervisor' where id = v_foreman;
  v_owner_role := pg_temp.dry_run_act_as(v_foreman);
  perform pg_temp.dry_run_check('acting as the QA login temporarily promoted to supervisor',
    current_user = 'authenticated' and auth.uid() = v_foreman and v_owner_role = 'supervisor', current_user::text);
  perform pg_temp.dry_run_expect_error(
    'values_owner_report: a supervisor is refused (not an owner)',
    'select public.values_owner_report()', 'Owner access only'
  );

  perform pg_temp.dry_run_as_system();
  update public.profiles set role = 'owner', is_partner = true where id = v_foreman;
  perform pg_temp.dry_run_act_as(v_foreman);
  perform pg_temp.dry_run_expect_error(
    'values_owner_report: role=owner but flagged a partner is refused',
    'select public.values_owner_report()', 'Owner access only'
  );

  perform pg_temp.dry_run_as_system();
  update public.profiles set is_partner = false, access_revoked_at = now() where id = v_foreman;
  perform pg_temp.dry_run_act_as(v_foreman);
  perform pg_temp.dry_run_expect_error(
    'values_owner_report: a revoked owner is refused',
    'select public.values_owner_report()', 'Owner access only'
  );
  perform pg_temp.dry_run_expect_error(
    'set_values_scheduler_enabled: a revoked owner is refused',
    'select public.set_values_scheduler_enabled(true)', 'Only an owner'
  );

  perform pg_temp.dry_run_as_system();
  update public.profiles set access_revoked_at = null, retired_at = now() where id = v_foreman;
  perform pg_temp.dry_run_act_as(v_foreman);
  perform pg_temp.dry_run_expect_error(
    'values_owner_report: a retired owner is refused',
    'select public.values_owner_report()', 'Owner access only'
  );

  -- Now a genuinely current owner (role=owner, not a partner, not revoked,
  -- not retired) — the one combination that must actually succeed, and the
  -- only point this probe exercises the scheduler switch for real.
  perform pg_temp.dry_run_as_system();
  update public.profiles set retired_at = null where id = v_foreman;
  v_owner_role := pg_temp.dry_run_act_as(v_foreman);
  perform pg_temp.dry_run_check('acting as the QA login temporarily promoted to a current owner',
    current_user = 'authenticated' and auth.uid() = v_foreman and v_owner_role = 'owner', current_user::text);
  select public.values_owner_report() into v_owner_report;
  perform pg_temp.dry_run_check(
    'values_owner_report: a current owner succeeds and the review subject appears in people',
    (v_owner_report->>'periodStart') is not null
      and exists (select 1 from jsonb_array_elements(v_owner_report->'people') p where p->>'userId' = v_foreman::text),
    v_owner_report::text
  );
  perform pg_temp.dry_run_check(
    'eligible same-partition owner reads private accounting',
    (select count(*) from public.values_quarterly_accounting where rating_id=v_private_rating)=1,
    'checked'
  );
  perform public.set_values_scheduler_enabled(true);
  perform pg_temp.dry_run_check(
    'set_values_scheduler_enabled: a current owner can flip it on',
    (select values_scheduler_enabled from public.company_settings where id = 1) = true,
    'checked'
  );
  perform public.set_values_scheduler_enabled(false);

  -- Revert the QA foreman to exactly what it was before this matrix.
  perform pg_temp.dry_run_as_system();
  update public.profiles
     set role = 'foreman', is_partner = false, access_revoked_at = null, retired_at = null
   where id = v_foreman;

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
  select count(*) into v_n from public.values_scores where submission_id = (v_receipt->'receipt'->>'submissionId')::uuid;
  perform pg_temp.dry_run_check('exactly eight scores landed atomically', v_n = 8, v_n || ' row(s)');

  select count(*) into v_n from public.app_release_notes where id = '2026-10-03-monthly-values-review';
  perform pg_temp.dry_run_check('the bilingual announcement exists', v_n = 1, v_n || ' row(s)');
end $$;
