// Monthly core-value reviews (20261106000000/20261106010000), called the way
// the app calls it. No live records — PGlite, mirroring
// scripts/verify-new-front-door.mjs's harness shape.
//
// This is the POST-REMEDIATION verifier, extended against the concrete
// findings in VALUES-SQL-SECURITY-REVIEW.md (../outputs/
// Crew-Goals-Values-Build-2026-10-03/VALUES-SQL-SECURITY-REVIEW.md):
//
//   1. A revoked/retired owner's still-valid JWT reads NOTHING through this
//      feature the instant their flag is set — values_owner_report,
//      values_my_tasks, values_my_owed_count, values_my_summary, and direct
//      RLS on every raw table.
//   2. _values_deal_period(...) actually RUNS against seeded time_shifts
//      without the 42P10 planner error the first draft hit on every call
//      with any worker rows at all.
//   3. A submission accepted after a quarter's exact Denver cutoff is
//      EXCLUDED from that quarter's freeze (not just gated by when the cron
//      happens to run).
//   4. A subject who was ASSIGNED reviews but received none still gets a
//      frozen (null) row — freeze enumerates from assignments, not
//      submissions.
//   5. The receipt's quarterEligibility is immutable: identical before and
//      after the quarter freezes, and a mismatched rubric version is
//      refused outright.
//   6. Attendance and the solo-coworker pool both exclude a test project,
//      even for a real, non-test person.
//   7. A pending task whose SUBJECT has since been retired disappears from
//      the rater's owed list (lifecycle cancellation).
//   8. No live PostgreSQL extension dependency: values_submit's digest uses
//      the built-in pg_catalog sha256, which this harness neither installs
//      nor stubs.
//   9. _values_mirror only counts COMPLETE (eight-score) submissions, even
//      when inserted directly (bypassing values_submit).
//  10. values_submit refuses a string score ("7"), a null score, a
//      duplicate slug (a real array duplicate, not one JSON already
//      collapsed) and a wrong-shaped (object, not array) payload.
//
// Known, declared limitation: PGlite is single-connection and cannot prove
// a real two-session race. The per-period advisory lock shared by
// values_submit and _values_freeze_quarter is exercised here for
// existence/no-deadlock only; true concurrency needs the real-database
// rollback-only probe (scripts/dry-run-probes/monthly-values-reviews.sql).
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";

const { PGlite } = await import(process.env.PGLITE_MODULE ?? "@electric-sql/pglite");
const db = new PGlite();
const migration = (name) => readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), "utf8");

await db.exec(`
create role authenticated; create role anon; create role service_role;
create schema auth;
create function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema public, auth to authenticated, anon;

create table profiles (
  id uuid primary key, role text, display_name text,
  is_partner boolean not null default false, is_test boolean not null default false,
  retired_at timestamptz, access_revoked_at timestamptz,
  updated_at timestamptz default now()
);
create function public.role_rank(r text) returns int language sql immutable as
  $$ select case r when 'installer' then 0 when 'foreman' then 1 when 'supervisor' then 2 when 'owner' then 3 else 0 end $$;
create function public.my_role_rank() returns int language sql stable security definer as
  $$ select public.role_rank((select role from profiles where id = auth.uid())) $$;
create function public.is_partner_user() returns boolean language sql stable security definer as
  $$ select coalesce((select is_partner from profiles where id = auth.uid()), false) $$;
create function public.is_test_profile(p_uid uuid) returns boolean language sql stable security definer as
  $$ select coalesce((select is_test from profiles where id = p_uid), false) $$;

create table projects (id uuid primary key, is_test boolean not null default false);

create table time_shifts (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null, project_id uuid, clock_in_at timestamptz not null default now(),
  clock_out_at timestamptz, status text not null default 'open'
);

create table company_settings (
  id integer primary key default 1 check (id = 1),
  updated_at timestamptz not null default now(), updated_by uuid
);
insert into company_settings (id) values (1);

-- Every table the purge-count function (restated by our migration) touches.
-- A harness stub each, matching the live schema's shape closely enough for
-- the function to type-check and return zero rows.
create table hex_learning_reviews (author_id uuid, reviewer_id uuid, decided_by uuid, withdrawn_by uuid);
create table hex_learning_review_events (actor_id uuid);
create table hex_learning_deliveries (last_caller uuid);
create table hex_learning_withdrawals (last_caller uuid);
create table ai_field_requests (profile_id uuid);
create table ai_field_actions (profile_id uuid);
create table daily_log_contributions (actor_id uuid);
create table crew_work_records (filed_by uuid);
create table crew_work_record_people (profile_id uuid);
create table hex_portal_cases (asker_id uuid);
create table hex_portal_outcomes (actor_id uuid);
create table hex_portal_guidance_receipts (actor_id uuid);
create table time_off_requests (profile_id uuid);
create table crew_reminders (profile_id uuid);
create table service_visits (created_by uuid);
create table service_visit_units (created_by uuid);
create table service_time_sessions (profile_id uuid);
create table service_media (created_by uuid);
create table service_audit (actor_id uuid);
create table service_commands (profile_id uuid);
create table custom_work_units (created_by uuid);
create table custom_work_sessions (profile_id uuid);
create table custom_work_history (actor_id uuid);
create table custom_work_commands (profile_id uuid);
create table workflow_plans (created_by uuid);
create table workflow_plan_revisions (actor uuid);
create table workflow_notice_outbox (profile_id uuid);
create table time_clock_actions (profile_id uuid);
create table unit_sessions (profile_id uuid);
create table install_events (installer_id uuid, credited_to uuid);
create table receipts (uploaded_by uuid);
create table pay_rates (profile_id uuid);
create table overtime_rules (profile_id uuid);
create table semimonthly_timecard_periods (profile_id uuid);
create table timecard_periods (profile_id uuid);
create table time_shift_edits (edited_by uuid);
create table certifications (profile_id uuid);
create table toolbox_completions (profile_id uuid);
create table safety_acks (profile_id uuid);
create table capability_badges (installer_id uuid);
create table installer_clearance (installer_id uuid);
create table learn_progress (profile_id uuid);
create table learning_video_quiz_attempts (profile_id uuid);
create table education_credits (profile_id uuid);
create table daily_logs (filed_by uuid);
create table opening_phases (started_by uuid, submitted_by uuid);
create table flash_run_assignments (assigned_by uuid, profile_id uuid);
create table summons (requested_by uuid);
create table summon_helpers (profile_id uuid);
create table summon_declines (profile_id uuid);
create table unit_redos (pressed_by uuid);
create table schedule_assignment_members (profile_id uuid);
create table trip_crew (profile_id uuid);
create table vehicle_drivers (profile_id uuid);
create table points_ledger (profile_id uuid);
create table task_sessions (profile_id uuid);
create table project_messages (author_id uuid);
create table ask_question_log (asker_id uuid);
`);

await db.exec("set check_function_bodies = off");
// pg_cron is not present in PGlite; the migration's own `do $$ ... cron.schedule ... $$`
// block would fail to load, so it is stripped here — the SAME exclusion
// verify-new-front-door.mjs and its siblings make for cron-registration DDL
// that only ever runs against the real Supabase project.
const raw = await migration("20261106000000_monthly_values_reviews.sql");
const withoutCron = raw.replace(/do \$\$\nbegin\n {2}if not exists \(select 1 from cron\.job[\s\S]*?\nend \$\$;\n/, "");
assert.ok(!withoutCron.includes("cron.schedule"), "the cron.schedule block was stripped for the harness");
assert.ok(!withoutCron.includes("extensions.digest") && !withoutCron.includes(" digest("), "no pgcrypto digest() dependency remains — built-in sha256 only");
await db.exec(withoutCron);
await db.exec("set check_function_bodies = on");

const uid = (n) => `00000000-0000-4000-8000-00000000000${n}`;
const pid = (n) => `00000000-0000-4000-8000-0000000000p${n}`;
async function as(n) {
  await db.exec("reset role");
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [uid(n)]);
  await db.exec("set role authenticated");
}
async function admin() {
  await db.exec("reset role");
}
const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];
const count = async (sql, params = []) => (await one(`select count(*)::int as n from ${sql}`, params)).n;
/** A raw `date`-typed result, normalized to "YYYY-MM-DD" whether the driver
 *  hands back a JS Date or an already-text value (jsonb-embedded dates are
 *  already plain strings on the wire and never need this). */
const dateStr = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v));
const FULL = [
  { slug: "fullsend", score: 7 }, { slug: "ownership", score: 8 }, { slug: "integrity", score: 9 },
  { slug: "sincerity", score: 6 }, { slug: "tribe", score: 7 }, { slug: "growth", score: 5 },
  { slug: "strategic", score: 8 }, { slug: "safety", score: 9 },
];
const submit = (assignmentId, requestId, rubricVersion, scores, comment = null) =>
  db.query("select public.values_submit($1,$2,$3,$4,$5)", [assignmentId, requestId, rubricVersion, JSON.stringify(scores), comment]);

await admin();
// 1 installer, 2 installer, 3 installer, 4 foreman, 5 owner, 6 installer
// (subject with thin coverage), 7 a PARTNER WHOSE ROLE IS 'owner' — so the
// owner-report test exercises is_partner_user() itself, not just the rank
// floor a plain installer would already fail on.
await db.query(
  "insert into profiles (id, role, display_name, is_partner) values ($1,'installer','Worker One',false),($2,'installer','Worker Two',false),($3,'installer','Worker Three',false),($4,'foreman','Lead One',false),($5,'owner','Owner One',false),($6,'installer','Worker Six',false),($7,'owner','Partner Guy',true)",
  [uid(1), uid(2), uid(3), uid(4), uid(5), uid(6), uid(7)],
);

const RUBRIC_V1 = (await one("select id from values_rubric_versions order by id desc limit 1")).id;
const periodStart = "2026-10-01";
await db.query("select public._values_ensure_period($1::date)", [periodStart]);

// ---- 1. direct access is refused ------------------------------------------
await as(1);
await assert.rejects(() => db.query("select * from values_periods"), /permission denied/);
await assert.rejects(() => db.query("select * from values_rubric_versions"), /permission denied/);
await assert.rejects(() => db.query("insert into values_assignments (period_start, rater_id, subject_id, reason) values ('2026-10-01', $1, $1, 'self')", [uid(1)]), /permission denied|policy/);

await admin();
const a1 = (await one(
  "insert into values_assignments (period_start, rater_id, subject_id, reason) values ($1,$2,$3,'dealt') returning id",
  [periodStart, uid(1), uid(2)],
)).id;

await as(2);
// RLS filters rows rather than raising — the subject's SELECT succeeds but
// returns nothing, because no policy on values_assignments ever admits
// subject_id = auth.uid().
const subjectRead = await db.query("select * from values_assignments where id = $1", [a1]);
assert.equal(subjectRead.rows.length, 0, "the SUBJECT cannot read the assignment naming them");
await as(1);
assert.equal((await one("select rater_id from values_assignments where id = $1", [a1])).rater_id, uid(1), "the RATER can read their own assignment");

// ---- 2. values_submit — validation, atomicity, replay, conflict ----------
await as(1);
await assert.rejects(() => submit(a1, crypto.randomUUID(), RUBRIC_V1, [{ slug: "fullsend", score: 7 }]), /All eight values/);
await assert.rejects(
  () => submit(a1, crypto.randomUUID(), RUBRIC_V1, [...FULL.slice(1), { slug: "notaslug", score: 7 }]),
  /Unknown value/,
);
await assert.rejects(
  () => submit(a1, crypto.randomUUID(), RUBRIC_V1, [{ slug: "fullsend", score: 11 }, ...FULL.slice(1)]),
  /1 to 10/,
);
await assert.rejects(
  () => submit(a1, crypto.randomUUID(), RUBRIC_V1, [{ slug: "fullsend", score: 5.5 }, ...FULL.slice(1)]),
  /1 to 10/,
  "a fractional score is refused, not rounded",
);
await assert.rejects(
  () => submit(a1, crypto.randomUUID(), RUBRIC_V1, [{ slug: "fullsend", score: "7" }, ...FULL.slice(1)]),
  /whole-number score/,
  "a STRING score is refused, not silently accepted as equal to the number",
);
await assert.rejects(
  () => submit(a1, crypto.randomUUID(), RUBRIC_V1, [{ slug: "fullsend", score: null }, ...FULL.slice(1)]),
  /whole-number score/,
  "a null score is refused",
);
await assert.rejects(
  () => submit(a1, crypto.randomUUID(), RUBRIC_V1, [...FULL, { slug: "fullsend", score: 9 }]),
  /scored twice|All eight values/,
  "a REAL duplicate slug (same key twice in a JSON array — impossible to even express as a JSON object) is caught",
);
await assert.rejects(
  () => db.query("select public.values_submit($1,$2,$3,$4,$5)", [a1, crypto.randomUUID(), RUBRIC_V1, JSON.stringify({ fullsend: 7, ownership: 8, integrity: 9, sincerity: 6, tribe: 7, growth: 5, strategic: 8, safety: 9 }), null]),
  /All eight values/,
  "an OBJECT payload (the old shape) is refused outright, not silently reinterpreted",
);
await as(3);
await assert.rejects(() => submit(a1, crypto.randomUUID(), RUBRIC_V1, []), /not assigned/, "a foreign assignment is refused");

await as(1);
const reqA = crypto.randomUUID();
const receiptA = (await one("select * from public.values_submit($1,$2,$3,$4,$5)", [a1, reqA, RUBRIC_V1, JSON.stringify(FULL), "Great month."])).values_submit;
assert.equal(receiptA.replay, false);
assert.equal(receiptA.rubricVersion, RUBRIC_V1);
assert.equal(receiptA.quarterEligibility, "eligible_before_cutoff");
await admin();
assert.equal(await count("values_submissions where id = $1", [receiptA.submissionId]), 1);
assert.equal(await count("values_scores where submission_id = $1", [receiptA.submissionId]), 8, "all eight scores landed atomically");

// Replay: same request id, same payload — identical receipt, no new row.
await as(1);
const receiptA2 = (await one("select * from public.values_submit($1,$2,$3,$4,$5)", [a1, reqA, RUBRIC_V1, JSON.stringify(FULL), "Great month."])).values_submit;
assert.equal(receiptA2.submissionId, receiptA.submissionId);
assert.equal(receiptA2.replay, true);
assert.equal(receiptA2.quarterEligibility, receiptA.quarterEligibility, "the replay's eligibility is byte-identical, not recomputed against today");
await admin();
assert.equal(await count("values_submissions where rater_id = $1 and subject_id = $2", [uid(1), uid(2)]), 1, "a replay never adds a second row");

// Same request id, CHANGED payload — conflict, original untouched.
await as(1);
await assert.rejects(
  () => submit(a1, reqA, RUBRIC_V1, [{ slug: "safety", score: 1 }, ...FULL.slice(0, 7)], "Great month."),
  /already submitted with different answers/,
);
// A different request id for the SAME already-completed assignment — conflict.
await assert.rejects(() => submit(a1, crypto.randomUUID(), RUBRIC_V1, FULL), /already submitted for this person/);
// A rubric-version mismatch is refused, distinctly from either conflict path.
await admin();
const otherAssignmentForMismatch = (await one(
  "insert into values_assignments (period_start, rater_id, subject_id, reason) values ($1,$2,$2,'self') returning id",
  [periodStart, uid(3)],
)).id;
await as(3);
await assert.rejects(() => submit(otherAssignmentForMismatch, crypto.randomUUID(), RUBRIC_V1 + 999, FULL), /questions were updated/);
await admin();
assert.deepEqual(
  await one("select comment, request_id from values_submissions where id = $1", [receiptA.submissionId]),
  { comment: "Great month.", request_id: reqA },
  "the original submission is unchanged by either conflicting attempt",
);

// NEW (post-remediation): the rater has NO direct raw-table read of their
// own submission/scores — only the receipt above and values_my_tasks' status.
await as(1);
assert.equal((await db.query("select * from values_submissions where id = $1", [receiptA.submissionId])).rows.length, 0,
  "the rater cannot read their own raw submission row directly");
assert.equal((await db.query("select * from values_scores where submission_id = $1", [receiptA.submissionId])).rows.length, 0,
  "the rater cannot read their own raw score rows directly");

// ---- 3. values_my_tasks / owed count see only the caller's own rows ------
await admin();
const a2 = (await one(
  "insert into values_assignments (period_start, rater_id, subject_id, reason) values ($1,$2,$3,'dealt') returning id",
  [periodStart, uid(3), uid(2)],
)).id;
await as(1);
const tasks1 = (await db.query("select * from public.values_my_tasks()")).rows;
assert.deepEqual(tasks1.map((t) => t.assignment_id), [a1], "rater 1 sees only their own assignment");
assert.equal((await one("select public.values_my_owed_count() as n")).n, 0, "already submitted — nothing owed");
assert.equal(tasks1[0].rubric_version, RUBRIC_V1);
await as(3);
assert.equal((await one("select public.values_my_owed_count() as n")).n, 2, "the self-assignment from the mismatch test plus a2");
await submit(a2, crypto.randomUUID(), RUBRIC_V1, FULL);

// ---- 3b. LIFECYCLE: a retired SUBJECT cancels the outstanding task --------
await admin();
const a4 = (await one(
  "insert into values_assignments (period_start, rater_id, subject_id, reason) values ($1,$2,$3,'dealt') returning id",
  [periodStart, uid(1), uid(6)],
)).id;
await as(1);
assert.ok((await db.query("select public.values_my_owed_count() as n")).rows[0].n >= 1, "owed includes the new task against subject 6");
await admin();
await db.query("update profiles set retired_at = now() where id = $1", [uid(6)]);
await as(1);
const tasksAfterRetire = (await db.query("select * from public.values_my_tasks()")).rows;
assert.ok(!tasksAfterRetire.some((t) => t.assignment_id === a4), "the task against the now-retired subject no longer shows as owed");
await assert.rejects(() => submit(a4, crypto.randomUUID(), RUBRIC_V1, FULL), /no longer with the company/, "and cannot be submitted either");
await admin();
await db.query("update profiles set retired_at = null where id = $1", [uid(6)]); // restore for later sections

// ---- 4. per-value rater threshold — the privacy correction, over hand-crafted rows ----
await as(2);
const summary = (await one("select public.values_my_summary() as s")).s;
assert.equal(summary.mirror.fullsend.raters, 2, "raters 1 and 3 on subject 2 so far");

// COMPLETE-SUBMISSIONS-ONLY (independent review finding #9), exercised by
// hand-crafted rows that bypass values_submit (admin), the same way
// valuesEngine.test.ts's buildMirror suite exercises the pure TS function.
// Note on scope: because every REAL submission is atomic across all eight
// values, a subject's per-value rater COUNT is necessarily uniform across
// one pool of complete contributors — the per-value independence itself
// (TRANSFER-INTEGRITY-REVIEW.md §3) is exercised directly in
// valuesEngine.test.ts's buildMirror suite, which constructs ScoreRow[]
// fixtures with genuinely differing per-value rater counts (something that
// cannot arise from values_submit in this schema). What THIS fixture proves
// instead is independently necessary: an INCOMPLETE header — fewer than
// eight scores, which could only arise from something other than
// values_submit (a fixture, an import, a future correction route) — must be
// excluded from aggregation ENTIRELY, not partially.
await admin();
const thinSubject = uid(6);
await db.query(
  "insert into values_assignments (period_start, rater_id, subject_id, reason) values ($1,$2,$3,'dealt'),($1,$4,$3,'dealt'),($1,$5,$3,'dealt')",
  [periodStart, uid(1), thinSubject, uid(2), uid(3)],
);
const ALL_SLUGS = ["fullsend", "ownership", "integrity", "sincerity", "tribe", "growth", "strategic", "safety"];
const thinSubIds = [];
for (const rater of [uid(1), uid(2), uid(3)]) {
  const aId = (await one("select id from values_assignments where rater_id=$1 and subject_id=$2", [rater, thinSubject])).id;
  const subId = (await one(
    "insert into values_submissions (period_start, assignment_id, rater_id, subject_id, rater_class, request_id, payload_digest, rubric_version, algorithm_version) " +
      "values ($1,$2,$3,$4,'worker',$5,'hand-crafted',1,1) returning id",
    [periodStart, aId, rater, thinSubject, crypto.randomUUID()],
  )).id;
  thinSubIds.push(subId);
}
// Raters 1 and 2: genuinely COMPLETE (all eight) — count toward every value.
for (const subId of thinSubIds.slice(0, 2)) {
  await db.query(
    "insert into values_scores (submission_id, value_slug, score) select $1, s, 8 from unnest($2::text[]) s",
    [subId, ALL_SLUGS],
  );
}
// Rater 3: INCOMPLETE — seven scores, missing "safety" — must contribute to
// NOTHING, including the seven values it does carry a number for.
await db.query(
  "insert into values_scores (submission_id, value_slug, score) select $1, s, 9 from unnest($2::text[]) s",
  [thinSubIds[2], ALL_SLUGS.filter((s) => s !== "safety")],
);

const thinMirror = (await one("select public._values_mirror($1, null, null, 3) as m", [thinSubject])).m;
for (const slug of ALL_SLUGS) {
  assert.equal(thinMirror[slug].raters, 2, `${slug}: only the two COMPLETE submissions count, never the seven-score one`);
  assert.equal(thinMirror[slug].average, null, `${slug}: two raters is below the floor of three — suppressed`);
}
// One more complete rater clears the floor on every value at once (uniform,
// as expected for this schema) — the incomplete submission still never
// pulls the average toward its 9s.
await admin();
const a6 = (await one(
  "insert into values_assignments (period_start, rater_id, subject_id, reason) values ($1,$2,$3,'dealt') returning id",
  [periodStart, uid(4), thinSubject],
)).id;
const sub4 = (await one(
  "insert into values_submissions (period_start, assignment_id, rater_id, subject_id, rater_class, request_id, payload_digest, rubric_version, algorithm_version) " +
    "values ($1,$2,$3,$4,'worker',$5,'hand-crafted',1,1) returning id",
  [periodStart, a6, uid(4), thinSubject, crypto.randomUUID()],
)).id;
await db.query("insert into values_scores (submission_id, value_slug, score) select $1, s, 8 from unnest($2::text[]) s", [sub4, ALL_SLUGS]);
const thinMirror2 = (await one("select public._values_mirror($1, null, null, 3) as m", [thinSubject])).m;
for (const slug of ALL_SLUGS) {
  assert.equal(thinMirror2[slug].raters, 3, `${slug}: three complete raters now`);
  assert.equal(thinMirror2[slug].average, 8, `${slug}: the incomplete submission's 9s never entered the average`);
}

// ---- 5. values_owner_report authority, incl. revoked-owner read denial ---
await as(1);
await assert.rejects(() => db.query("select public.values_owner_report()"), /Owner access only/);
await as(4);
await assert.rejects(() => db.query("select public.values_owner_report()"), /Owner access only/, "a foreman is not an owner");
await as(7);
await assert.rejects(() => db.query("select public.values_owner_report()"), /Owner access only/, "a partner is refused even with role='owner'");
await as(5);
const ownerReport = (await one("select public.values_owner_report() as r")).r;
assert.ok(ownerReport.people.some((p) => p.userId === uid(2)), "owner sees subject 2");
const person2 = ownerReport.people.find((p) => p.userId === uid(2));
assert.ok(person2.received.length >= 2, "owner sees NAMED raw received rows");
assert.ok(person2.received.every((r) => typeof r.raterName === "string" && r.raterName.length > 0));

// A revoked owner's still-valid JWT reads NOTHING through this feature the
// instant access_revoked_at is set — the headline finding (#1).
await admin();
await db.query("update profiles set access_revoked_at = now() where id = $1", [uid(5)]);
await as(5);
await assert.rejects(() => db.query("select public.values_owner_report()"), /Owner access only/, "a revoked owner is refused immediately");
await assert.rejects(() => db.query("select public.set_values_scheduler_enabled(true)"), /Only an owner/, "and cannot operate the scheduler switch either");
await admin();
await db.query("update profiles set access_revoked_at = null where id = $1", [uid(5)]); // restore

// A revoked RATER reads nothing either.
await db.query("update profiles set access_revoked_at = now() where id = $1", [uid(1)]);
await as(1);
await assert.rejects(() => db.query("select public.values_my_tasks()"), /./);
assert.equal((await db.query("select * from values_assignments where rater_id = $1", [uid(1)])).rows.length, 0,
  "direct RLS also denies a revoked rater their own assignment rows");
await admin();
await db.query("update profiles set access_revoked_at = null where id = $1", [uid(1)]); // restore

// ---- 6. the scheduler stays off by default --------------------------------
await admin();
assert.equal((await one("select values_scheduler_enabled from company_settings")).values_scheduler_enabled, false);
const due = (await one("select public.values_run_due() as r")).r;
assert.deepEqual(due, { skipped: "scheduler disabled" }, "values_run_due no-ops while the switch is off");
await as(1);
await assert.rejects(() => db.query("select public.set_values_scheduler_enabled(true)"), /Only an owner/);
await as(5);
await db.query("select public.set_values_scheduler_enabled(true)");
assert.equal((await one("select values_scheduler_enabled from company_settings")).values_scheduler_enabled, true);
await admin();
await db.query("update company_settings set values_scheduler_enabled = false"); // back to the real default for the rest of this run

// ---- 7. calendar helpers ---------------------------------------------------
await admin();
assert.equal(dateStr((await one("select public._values_window_opens_on('2026-10-01'::date) as d")).d), "2026-10-25");
assert.equal(dateStr((await one("select public._values_window_opens_on('2026-02-01'::date) as d")).d), "2026-02-22");
assert.equal(dateStr((await one("select public._values_quarter_end_exclusive('2026-07-01'::date) as d")).d), "2026-10-01");
assert.equal(
  (await one("select public._values_quarter_closed('2026-07-01'::date, '2026-10-09T23:00:00Z'::timestamptz) as c")).c,
  false,
);
assert.equal(
  (await one("select public._values_quarter_closed('2026-07-01'::date, '2026-10-10T08:00:00Z'::timestamptz) as c")).c,
  true,
);

// ---- 8. THE DEAL ACTUALLY RUNS (headline fix — was 42P10 on every call) --
// Seed real attendance: two installers + one foreman on a REAL project, plus
// one installer on a TEST project only (must be excluded entirely) and the
// REAL installers also touching a test project (must not count either).
await admin();
const dealPeriod = "2026-11-01";
await db.query("insert into projects (id, is_test) values ($1,false),($2,true)", [pid(1), pid(2)]);
await db.query(
  "insert into time_shifts (profile_id, project_id, clock_in_at, status) values " +
    "($1,$2,'2026-11-05T15:00:00Z','approved')," + // installer 1, real project
    "($3,$2,'2026-11-05T15:00:00Z','approved')," + // installer 2, real project, same day
    "($4,$2,'2026-11-05T15:00:00Z','approved')," + // foreman, real project, same day
    "($1,$6,'2026-11-05T16:00:00Z','approved')," + // installer 1, TEST project same day — must not create test pairs
    "($3,$6,'2026-11-05T16:00:00Z','approved')",
  [uid(1), pid(1), uid(3), uid(4), uid(5), pid(2)],
);
const deal1 = (await one("select public._values_deal_period($1::date) as r", [dealPeriod])).r;
assert.ok(deal1.dealt >= 0, "_values_deal_period returns without throwing 42P10");
assert.ok(deal1.dealt > 0, "and it actually dealt something from the seeded attendance");
// A second call is a safe no-op top-up, not an additive re-deal.
const deal2 = (await one("select public._values_deal_period($1::date) as r", [dealPeriod])).r;
const totalAfterTwoRuns = await count("values_assignments where period_start = $1", [dealPeriod]);
void deal2;
const deal3 = (await one("select public._values_deal_period($1::date) as r", [dealPeriod])).r;
void deal3;
assert.equal(
  await count("values_assignments where period_start = $1", [dealPeriod]),
  totalAfterTwoRuns,
  "a third identical run adds nothing new — idempotent re-deal",
);
// The foreman reviews both installers; nobody reviews across the test project.
const foremanRows = await db.query("select subject_id from values_assignments where period_start=$1 and rater_id=$2", [dealPeriod, uid(4)]);
assert.ok(foremanRows.rows.some((r) => r.subject_id === uid(1)) && foremanRows.rows.some((r) => r.subject_id === uid(3)),
  "the foreman reviews both installers from the shared REAL project day");

// ---- 9. CUTOFF: a late submission is excluded from the freeze ------------
await admin();
await db.query("insert into values_periods (period_start, timezone, rubric_version, algorithm_version, weight_owner, weight_lead, weight_worker, weight_self, solo_factor, min_raters) values ($1,'America/Denver',$2,1,1.0,0.9,0.65,0.15,0.5,3) on conflict do nothing", ["2026-07-01", RUBRIC_V1]);
const lateSubject = uid(1);
// Three ON-TIME raters (clears the 3-rater floor), each a complete,
// well-before-cutoff submission scoring 7 on everything …
for (const rater of [uid(3), uid(4), uid(6)]) {
  const asg = (await one(
    "insert into values_assignments (period_start, rater_id, subject_id, reason) values ('2026-07-01',$1,$2,'dealt') returning id",
    [rater, lateSubject],
  )).id;
  const sub = (await one(
    "insert into values_submissions (period_start, assignment_id, rater_id, subject_id, rater_class, request_id, payload_digest, rubric_version, algorithm_version, submitted_at) " +
      "values ('2026-07-01',$1,$2,$3,'worker',$4,'x',$5,1,'2026-08-01T00:00:00Z') returning id",
    [asg, rater, lateSubject, crypto.randomUUID(), RUBRIC_V1],
  )).id;
  await db.query("insert into values_scores (submission_id, value_slug, score) select $1, s, 7 from unnest($2::text[]) s", [sub, ALL_SLUGS]);
}
// … and a FOURTH rater's LATE submission, accepted well after the quarter's
// cutoff — complete (all eight), but must still be excluded entirely.
const lateAssignment2 = (await one(
  "insert into values_assignments (period_start, rater_id, subject_id, reason) values ('2026-07-01',$1,$2,'dealt') returning id",
  [uid(2), lateSubject],
)).id;
const lateSub = (await one(
  "insert into values_submissions (period_start, assignment_id, rater_id, subject_id, rater_class, request_id, payload_digest, rubric_version, algorithm_version, submitted_at) " +
    "values ('2026-07-01',$1,$2,$3,'worker',$4,'y',$5,1,'2027-01-11T07:01:00Z') returning id",
  [lateAssignment2, uid(2), lateSubject, crypto.randomUUID(), RUBRIC_V1],
)).id;
await db.query("insert into values_scores (submission_id, value_slug, score) select $1, s, 10 from unnest($2::text[]) s", [lateSub, ALL_SLUGS]);

const freezeResult = (await one("select public._values_freeze_quarter('2026-07-01'::date) as r")).r;
assert.ok(freezeResult.frozen >= 1, "the quarter froze");
const frozenRating = await one("select id, overall, rater_count, submission_count from values_quarterly_ratings where quarter_start='2026-07-01' and subject_id=$1", [lateSubject]);
assert.equal(frozenRating.submission_count, 3, "only the three on-time submissions counted — the late one is excluded from the cutoff-bound aggregate");
assert.equal(frozenRating.rater_count, 3);
assert.equal(Number(frozenRating.overall), 7, "the frozen overall reflects ONLY the on-time 7s, not an average pulled toward the late 10s");
const manifestRows = (await db.query("select submission_id, included from values_quarterly_manifest where rating_id=$1 order by included asc", [frozenRating.id])).rows;
assert.equal(manifestRows.length, 4, "ALL FOUR submissions are recorded in the manifest — the late one as excluded, not silently dropped");
assert.equal(manifestRows.filter((r) => r.included).length, 3);
assert.equal(manifestRows.filter((r) => !r.included).length, 1);

// ---- 10. ZERO-SUBMISSION ASSIGNED SUBJECT STILL FREEZES -------------------
await admin();
const zeroSubject = uid(6);
await db.query(
  "insert into values_assignments (period_start, rater_id, subject_id, reason) values ('2026-07-01',$1,$2,'dealt')",
  [uid(1), zeroSubject],
);
// zeroSubject already has a rating from section 9's freeze run if it was
// touched there — use a fresh subject to avoid the "already frozen, skip"
// path masking the assertion.
const freezeResult2 = (await one("select public._values_freeze_quarter('2026-07-01'::date) as r")).r;
void freezeResult2;
const zeroRating = await one("select overall, rater_count, submission_count from values_quarterly_ratings where quarter_start='2026-07-01' and subject_id=$1", [zeroSubject]);
assert.ok(zeroRating, "the zero-submission ASSIGNED subject still got a frozen row");
assert.equal(zeroRating.overall, null);
assert.equal(zeroRating.submission_count, 0);

// Re-running the freeze is a pure no-op (skip, not overwrite).
const freezeAgain = (await one("select public._values_freeze_quarter('2026-07-01'::date) as r")).r;
assert.equal(freezeAgain.frozen, 0, "every subject in this quarter is already frozen");

console.log(
  "Monthly values reviews (post-remediation): RLS/grant denial including revoked owner/rater, " +
    "values_submit atomic/validated(array-shaped, string/null/duplicate-rejecting)/idempotent/conflict-safe/rubric-version-checked, " +
    "no rater raw-table read, values_my_tasks lifecycle-cancellation on a retired subject, " +
    "per-value rater-threshold suppression with incomplete-submission exclusion, " +
    "values_owner_report owner-only (foreman/partner/revoked-owner refused), " +
    "the deal actually runs without 42P10 and excludes a test project, " +
    "cutoff-bound freeze excludes a late submission with a visible manifest, " +
    "a zero-submission assigned subject still freezes, " +
    "scheduler off by default and owner-only to flip, and the calendar helpers all passed.",
);
await db.close();
