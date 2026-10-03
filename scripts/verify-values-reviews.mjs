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
//  11. An RLS `USING` clause runs as the QUERYING role, not the SECURITY
//      DEFINER helper's owner — direct SELECTs that depend on eligibility
//      policies must not fail with "permission denied for function
//      _values_eligible" (42501), and the arbitrary-uid helpers themselves
//      must stay un-grantable to authenticated (no profile-status probe).
//  12. values_submit's digest/receipt are the exact VALUES-RECEIPT-
//      CONTRACT.md v1 encoding (assignment/request/rubric/eight ASCII-
//      sorted score lines/hex-or-null comment, built-in sha256) and the
//      nested {receipt, replay} shape, with the receipt persisted verbatim.
//  13. TEST/LIVE CALLER PARTITION (section 11): _values_eligible alone never
//      excluded a test account — owner raw RLS/report and values_submit/
//      values_my_tasks now additionally require rater and subject to share
//      the CALLER's own test/live partition; a same-partition (test-to-test)
//      submission is unaffected, and a hand-inserted cross-partition row is
//      refused at submit time and withheld from the owed list, both
//      directions.
//  14. Aggregate-only private accounting survives contributor purge unchanged;
//      identifying manifests/raw score children cascade away. Mixed period
//      policies and zero/suppressed values remain auditable only by owners.
//
// Known, declared limitation: PGlite is single-connection and cannot prove
// a real two-session race. The per-period advisory lock shared by
// values_submit and _values_freeze_quarter is exercised here for
// existence/no-deadlock only; true concurrency needs two live backend
// connections, which neither this single-connection harness nor the
// rollback-only probe's single `do $$ ... $$` transaction batch can express
// either — scripts/dry-run-probes/monthly-values-reviews.sql proves the
// real schema/grants/extension story, not a real race. A genuine two-
// session freeze/submit race test needs a separate, explicitly-scoped
// two-connection fixture against a disposable database outside this batch;
// scripts/verify-values-concurrency.py supplies that separate CI fixture; it is not executed by this script.
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
// Exercise the announcement against the actual curated-note schema, including
// its kind CHECK. The earlier fixture did not load this note/schema pair.
await db.exec(await migration("20261021000000_role_scoped_app_updates.sql"));
await db.exec(await migration("20261106010000_monthly_values_reviews_note.sql"));
const valuesAnnouncement = (await db.query("select kind from public.app_release_notes where id='2026-10-03-monthly-values-review'")).rows;
assert.deepEqual(valuesAnnouncement, [{ kind: "improvement" }]);

const uid = (n) => `00000000-0000-4000-8000-00000000000${n}`;
// A valid-hex project id — "p" (for "project") is not a hex digit, so it
// cannot appear in the last group of a real UUID; "a" stands in for it.
const pid = (n) => `00000000-0000-4000-8000-0000000000a${n}`;
// A second valid-hex block of ids for the test/live PARTITION fixtures
// below, so they never collide with uid(1..9)/pid(1..9)'s single-digit
// suffixes.
const eid = (s) => `00000000-0000-4000-8000-0000000000${s}`;
async function asId(id) {
  await db.exec("reset role");
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [id]);
  await db.exec("set role authenticated");
}
async function as(n) {
  await asId(uid(n));
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
// REGRESSION (post-remediation): this SELECT is the exact shape that used
// to fail with "permission denied for function _values_eligible" (42501) —
// an RLS USING clause runs as the QUERYING role, and that role never had
// EXECUTE on the (deliberately arbitrary-argument) eligibility helper. The
// zero-argument `_values_caller_eligible()`/`_values_caller_is_owner()`
// wrappers are what the policies call now; the broad, arbitrary-uid helpers
// stay un-grantable to authenticated so no account can probe another
// profile's retired/revoked/partner status directly.
assert.equal((await one("select rater_id from values_assignments where id = $1", [a1])).rater_id, uid(1), "the RATER can read their own assignment");
await assert.rejects(
  () => db.query("select public._values_eligible($1)", [uid(2)]),
  /permission denied/,
  "the arbitrary-uid eligibility helper stays un-grantable to authenticated — no profile-status probe",
);
await assert.rejects(
  () => db.query("select public._values_is_owner($1)", [uid(2)]),
  /permission denied/,
  "same for the arbitrary-uid owner helper",
);

// ---- 2. values_submit — validation, atomicity, replay, conflict ----------
await as(1);
await assert.rejects(() => submit(a1, crypto.randomUUID(), RUBRIC_V1,
  [{ ...FULL[0], extra: "not permitted" }, ...FULL.slice(1)]), /whole-number score|exactly slug and score/, "SQL accepts only the contract's exact score-object keys");
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
// Valid, complete scores here — this must fail on AUTHORIZATION (not
// assigned to rater 3), not on score-shape validation, which runs earlier
// in values_submit() and would otherwise mask the authorization check this
// assertion exists to prove.
await assert.rejects(() => submit(a1, crypto.randomUUID(), RUBRIC_V1, FULL), /not assigned/, "a foreign assignment is refused");

await as(1);
const reqA = crypto.randomUUID();
const resultA = (await one("select * from public.values_submit($1,$2,$3,$4,$5)", [a1, reqA, RUBRIC_V1, JSON.stringify(FULL), "Great month."])).values_submit;
const receiptA = resultA.receipt;
assert.equal(resultA.replay, false);
assert.equal(receiptA.encodingVersion, "forge-values-submit/v1");
assert.equal(receiptA.rubricVersion, RUBRIC_V1);
assert.equal(receiptA.requestId, reqA);
assert.equal(receiptA.quarterEligibility, "eligible_before_cutoff");
assert.match(receiptA.digest, /^[0-9a-f]{64}$/, "digest is lowercase 64-char hex");
await admin();
assert.equal(await count("values_submissions where id = $1", [receiptA.submissionId]), 1);
assert.equal(await count("values_scores where submission_id = $1", [receiptA.submissionId]), 8, "all eight scores landed atomically");
assert.deepEqual(
  (await one("select receipt from values_submissions where id = $1", [receiptA.submissionId])).receipt,
  receiptA,
  "the stored receipt column is exactly what was returned",
);

// Replay: same request id, same payload — identical receipt, no new row.
await as(1);
const resultA2 = (await one("select * from public.values_submit($1,$2,$3,$4,$5)", [a1, reqA, RUBRIC_V1, JSON.stringify(FULL), "Great month."])).values_submit;
const receiptA2 = resultA2.receipt;
assert.equal(receiptA2.submissionId, receiptA.submissionId);
assert.equal(resultA2.replay, true);
assert.deepEqual(receiptA2, receiptA, "the replay's receipt object is byte-identical, not recomputed against today");
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
// The SAME request id reused against a DIFFERENT assignment — a distinct
// conflict, caught explicitly BEFORE the insert (VALUES-RECEIPT-CONTRACT.md
// §5), never a raw unhandled unique-constraint violation on
// (rater_id, request_id).
await admin();
const aForReuse = (await one(
  "insert into values_assignments (period_start, rater_id, subject_id, reason) values ($1,$2,$3,'dealt') returning id",
  [periodStart, uid(1), uid(5)],
)).id;
await as(1);
await assert.rejects(() => submit(aForReuse, reqA, RUBRIC_V1, FULL), /used for a different review/);
await admin();
// Nothing was ever accepted against it — remove the scratch assignment so
// later sections asserting rater 1's exact task list are unaffected.
await db.query("delete from values_assignments where id = $1", [aForReuse]);
// A rubric-version mismatch is refused, distinctly from either conflict path.
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

// ---- 2b. GOLDEN DIGEST FIXTURES — VALUES-RECEIPT-CONTRACT.md §7, executed
// against the REAL values_submit() RPC (not a parallel reimplementation).
// Fixed assignment/request ids and scores exactly matching the contract's
// published vectors; the digest returned by the actual RPC must equal the
// actual SHA-256 the contract records for TextEncoder+WebCrypto/PGlite —
// proof the SQL canonical encoding (field order, LF termination, ASCII-sort
// by slug, hex-or-null comment token) matches byte-for-byte, not just "some
// digest that happens to be stable".
await admin();
const goldenPeriod = "2026-12-01";
await db.query("select public._values_ensure_period($1::date)", [goldenPeriod]);
const goldenAssignmentId = "11111111-1111-4111-8111-111111111111";
const goldenRequestId = "22222222-2222-4222-8222-222222222222";
const GOLDEN_SCORES = [
  { slug: "fullsend", score: 1 }, { slug: "growth", score: 2 }, { slug: "integrity", score: 3 },
  { slug: "ownership", score: 4 }, { slug: "safety", score: 5 }, { slug: "sincerity", score: 6 },
  { slug: "strategic", score: 7 }, { slug: "tribe", score: 8 },
];
async function goldenDigestCase(comment, expectedDigest, label) {
  await admin();
  // A fresh self-assignment under the SAME fixed id each time: the contract's
  // table holds assignmentId/requestId/scores fixed and varies only the
  // comment, which this schema can only express as separate accepted rows.
  await db.query("delete from values_submissions where assignment_id = $1", [goldenAssignmentId]);
  await db.query("delete from values_assignments where id = $1", [goldenAssignmentId]);
  await db.query(
    "insert into values_assignments (id, period_start, rater_id, subject_id, reason) values ($1,$2,$3,$3,'self')",
    [goldenAssignmentId, goldenPeriod, uid(1)],
  );
  await as(1);
  const result = (await one("select * from public.values_submit($1,$2,$3,$4,$5)", [
    goldenAssignmentId, goldenRequestId, RUBRIC_V1, JSON.stringify(GOLDEN_SCORES), comment,
  ])).values_submit;
  assert.equal(result.receipt.digest, expectedDigest, `${label}: digest matches VALUES-RECEIPT-CONTRACT.md's golden vector`);
}
await goldenDigestCase(null, "fa0ecfc2e76fb29a3fa169bd42583c49172e42d3972272867ef83ac90f0b2ae3", "null comment");
await goldenDigestCase(
  "  café 🛠️\r\nLine 2  ",
  "52c5c47edb67adc85e74044273789a9b6bd93b9c5e7eaeea9d093537939d3502",
  "unicode/CRLF comment, ASCII-space-only trimmed",
);
// Scratch fixture only — remove it so later sections asserting rater 1's
// exact task list (uid(1) only ever owes a1 at this point) are unaffected.
await admin();
await db.query("delete from values_submissions where assignment_id = $1", [goldenAssignmentId]);
await db.query("delete from values_assignments where id = $1", [goldenAssignmentId]);

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
await assert.rejects(() => submit(a4, crypto.randomUUID(), RUBRIC_V1, FULL), /currently unavailable/, "and cannot be submitted either");
await admin();
await db.query("update profiles set retired_at = null where id = $1", [uid(6)]); // restore for later sections
// a4 has served its purpose (lifecycle withholding + submit refusal) — drop
// it now. Section 4 below reuses subject 6 as "thinSubject" under raters
// 1/2/3 and would otherwise collide with a4's (period_start, rater_id,
// subject_id) = (periodStart, uid(1), uid(6)) against the table's own
// UNIQUE constraint.
await db.query("delete from values_assignments where id = $1", [a4]);

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
    "insert into values_submissions (period_start, assignment_id, rater_id, subject_id, rater_class, request_id, payload_digest, rubric_version, algorithm_version, receipt) " +
      "values ($1,$2,$3,$4,'worker',$5,'hand-crafted',1,1,'{}') returning id",
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
  "insert into values_submissions (period_start, assignment_id, rater_id, subject_id, rater_class, request_id, payload_digest, rubric_version, algorithm_version, receipt) " +
    "values ($1,$2,$3,$4,'worker',$5,'hand-crafted',1,1,'{}') returning id",
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

// Counts are scoped to the report period, clamped to launch. Existing seeded
// rows can belong to that period; validate arithmetic, not accidental zeros.
assert.ok(ownerReport.periodStart >= "2026-10-01");
assert.equal(person2.asRater.assigned, person2.asRater.accepted + person2.asRater.pending + person2.asRater.canceled + person2.asRater.suspended);
assert.equal(person2.suspended, false);
assert.equal(person2.retired, false);
assert.equal(person2.coverage.expectedReceived, 2);
assert.equal(typeof person2.coverage.actualReceived, "number");
assert.equal(typeof person2.coverage.missingCoverage, "boolean");

await admin();
const livePeriod = ownerReport.periodStart;
await db.query("select public._values_ensure_period($1::date)", [livePeriod]);
const liveSubject = eid("f2");
const liveRater = eid("f1");
await db.query("insert into profiles (id,role,display_name) values ($1,'installer','Lifecycle Rater'),($2,'installer','Lifecycle Subject')", [liveRater, liveSubject]);
// liveRater must appear in "people" too (that list is keyed by SUBJECThood —
// see values_owner_report's own WHERE), so give them one real-period
// self-assignment of their own, left pending, alongside the one they rate
// someone else on.
const liveRaterAssignment = (await one(
  "insert into values_assignments (period_start, rater_id, subject_id, reason) values ($1,$2,$3,'dealt') returning id",
  [livePeriod, liveRater, liveSubject],
)).id;
const liveSelfAssignment = (await one(
  "insert into values_assignments (period_start, rater_id, subject_id, reason) values ($1,$2,$2,'self') returning id",
  [livePeriod, liveRater],
)).id;
await asId(liveRater);
await submit(liveRaterAssignment, crypto.randomUUID(), RUBRIC_V1, FULL);
await as(5);
const liveReportRow = (await one("select public.values_owner_report() as r")).r;
await admin();
const livePerson1 = liveReportRow.people.find((p) => p.userId === liveRater);
assert.deepEqual(livePerson1.asRater, { assigned: 2, accepted: 1, late: 0, pending: 1, canceled: 0, suspended: 0 },
  "one real-period review of liveSubject, accepted; one self-review, still pending");
const liveSubjectRow = liveReportRow.people.find((p) => p.userId === liveSubject);
assert.equal(liveSubjectRow.coverage.actualReceived, 1, "the one just-accepted real-period submission counts toward coverage");
assert.equal(liveSubjectRow.coverage.missingCoverage, true, "one accepted review is still below the two-received floor");
// Clean up — this real-period assignment/submission must not perturb any
// later section that reads the report's own active period.
await db.query("delete from values_submissions where assignment_id = $1", [liveRaterAssignment]);
await db.query("delete from values_assignments where id in ($1, $2)", [liveRaterAssignment, liveSelfAssignment]);

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
// Confirmed via admin, not the owner's own `authenticated` role — the
// harness's stub company_settings table carries no direct SELECT grant to
// authenticated (the real table's broader grant, used by unrelated
// settings, is outside this migration's ownership); the state change
// itself was already proven by the owner-only RPC call above.
await admin();
assert.equal((await one("select values_scheduler_enabled from company_settings")).values_scheduler_enabled, true);
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
    "($1,$5,'2026-11-05T16:00:00Z','approved')," + // installer 1, TEST project same day — must not create test pairs
    "($3,$5,'2026-11-05T16:00:00Z','approved')",
  [uid(1), pid(1), uid(3), uid(4), pid(2)],
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
    "insert into values_submissions (period_start, assignment_id, rater_id, subject_id, rater_class, request_id, payload_digest, rubric_version, algorithm_version, submitted_at, receipt) " +
      "values ('2026-07-01',$1,$2,$3,'worker',$4,'x',$5,1,'2026-08-01T00:00:00Z','{}') returning id",
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
  "insert into values_submissions (period_start, assignment_id, rater_id, subject_id, rater_class, request_id, payload_digest, rubric_version, algorithm_version, submitted_at, receipt) " +
    "values ('2026-07-01',$1,$2,$3,'worker',$4,'y',$5,1,'2027-01-11T07:01:00Z','{}') returning id",
  [lateAssignment2, uid(2), lateSubject, crypto.randomUUID(), RUBRIC_V1],
)).id;
await db.query("insert into values_scores (submission_id, value_slug, score) select $1, s, 10 from unnest($2::text[]) s", [lateSub, ALL_SLUGS]);

const freezeResult = (await one("select public._values_freeze_quarter('2026-07-01'::date) as r")).r;
assert.ok(freezeResult.frozen >= 1, "the quarter froze");
const frozenRating = await one(
  "select id, overall, rater_count, submission_count, rubric_version, policy_versions from values_quarterly_ratings where quarter_start='2026-07-01' and subject_id=$1",
  [lateSubject],
);
assert.equal(frozenRating.submission_count, 3, "only the three on-time submissions counted — the late one is excluded from the cutoff-bound aggregate");
assert.equal(frozenRating.rater_count, 3);
assert.equal(Number(frozenRating.overall), 7, "the frozen overall reflects ONLY the on-time 7s, not an average pulled toward the late 10s");
const manifestRows = (await db.query(
  "select submission_id, included, exclusion_reason from values_quarterly_manifest where rating_id=$1 order by included asc",
  [frozenRating.id],
)).rows;
assert.equal(manifestRows.length, 4, "ALL FOUR submissions are recorded in the manifest — the late one as excluded, not silently dropped");
assert.equal(manifestRows.filter((r) => r.included).length, 3);
assert.equal(manifestRows.filter((r) => !r.included).length, 1);
const lateManifestRow = manifestRows.find((r) => !r.included);
assert.equal(lateManifestRow.exclusion_reason, "late", "the excluded row names WHY, not just a bare boolean");
for (const r of manifestRows.filter((row) => row.included)) {
  assert.equal(r.exclusion_reason, null, "an included row carries no exclusion reason");
}
const julyAccounting = await one("select * from values_quarterly_accounting where rating_id=$1", [frozenRating.id]);
for (const slug of ALL_SLUGS) {
  assert.equal(julyAccounting.value_totals[slug].weightedNumerator, 13.65); // 3 * .65 * 7
  assert.equal(julyAccounting.value_totals[slug].weightedDenominator, 1.95);
  assert.equal(julyAccounting.value_totals[slug].nonSelfRaters, 3);
}
assert.equal(frozenRating.rubric_version, RUBRIC_V1, "every period in this quarter agreed, so the scalar stays set (not forced null)");
// NOT asserting policy_versions.length === 1: section 5's live-period fixture
// (ownerReport.periodStart) can itself fall inside this SAME Jul-Sep quarter
// depending on which real Denver day this suite happens to run on, adding
// its own entry legitimately — assert the ENTRY this fixture actually cares
// about is present and correct, not the array's total size.
const julyPolicyEntry = frozenRating.policy_versions.find((e) => dateStr(e.periodStart) === "2026-07-01");
assert.ok(julyPolicyEntry, "policy_versions includes the '2026-07-01' period this fixture touched");
assert.equal(julyPolicyEntry.rubricVersion, RUBRIC_V1);
assert.ok(
  !("weightOwner" in julyPolicyEntry) && !("weightWorker" in julyPolicyEntry),
  "policy_versions is the SAFE provenance only — never the private weight ladder (that lives in owner-only accounting)",
);

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

// ---- 11. TEST/LIVE CALLER PARTITION ---------------------------------------
// _values_eligible() alone never excluded a test (QA/sandbox) account — only
// retired/revoked/partner. Test/live separation is a CALLER-PARTITION rule
// enforced at every RLS policy and RPC boundary that touches raw rater/
// subject identity, not merely an attendance-time exclusion (the deal
// engine's own two-sided tmp_values_days filter, exercised in section 8).
await admin();
const partOwner = eid("e1");
const partRater = eid("e2");
const partSubject = eid("e3");
await db.query(
  "insert into profiles (id, role, display_name, is_test) values ($1,'owner','Test Owner',true),($2,'installer','Test Rater',true),($3,'installer','Test Subject',true)",
  [partOwner, partRater, partSubject],
);
const partAssignment = (await one(
  "insert into values_assignments (period_start, rater_id, subject_id, reason) values ($1,$2,$3,'dealt') returning id",
  [periodStart, partRater, partSubject],
)).id;

// QA SAME-PARTITION SELF-PROBES REMAIN POSSIBLE: a test rater reviewing a
// test subject is unaffected by the partition guard.
await asId(partRater);
const partSubmitResult = (await one(
  "select * from public.values_submit($1,$2,$3,$4,$5)",
  [partAssignment, crypto.randomUUID(), RUBRIC_V1, JSON.stringify(FULL), null],
)).values_submit;
assert.equal(partSubmitResult.replay, false, "a same-partition (test-to-test) submission is accepted normally");

// OWNER RAW READ IS PARTITIONED: a test owner's report/raw reads see only
// test people; a real owner's see only real people — never both.
await asId(partOwner);
const testOwnerReport = (await one("select public.values_owner_report() as r")).r;
assert.ok(
  testOwnerReport.people.some((p) => p.userId === partSubject),
  "a test owner's report includes the test subject",
);
assert.ok(
  !testOwnerReport.people.some((p) => p.userId === uid(2) || p.userId === uid(6)),
  "a test owner's report never includes a REAL subject, even one with raw rows",
);
const testOwnerDirectRead = await db.query("select * from values_assignments where id = $1", [a1]);
assert.equal(testOwnerDirectRead.rows.length, 0, "direct RLS: a test owner cannot read a REAL assignment row either");
const testOwnerOwnPartitionRead = await db.query("select * from values_assignments where id = $1", [partAssignment]);
assert.equal(testOwnerOwnPartitionRead.rows.length, 1, "a test owner CAN read a test-partition row");

await as(5); // the real owner from section 5
const liveOwnerReport = (await one("select public.values_owner_report() as r")).r;
assert.ok(
  !liveOwnerReport.people.some((p) => p.userId === partSubject),
  "a REAL owner's report never includes a test-partition subject",
);
const liveOwnerDirectRead = await db.query("select * from values_assignments where id = $1", [partAssignment]);
assert.equal(liveOwnerDirectRead.rows.length, 0, "direct RLS: a real owner cannot read a test-partition assignment row either");

// CROSS-PARTITION SUBMISSION DENIAL: a row that crossed the wall (never
// written by the deal engine itself — this is a hand-inserted anomaly, the
// same kind of thing independent review finding #8 named for the dry-run
// probe) must still be refused at submit time, in both directions.
await admin();
const crossAssignment1 = (await one(
  "insert into values_assignments (period_start, rater_id, subject_id, reason) values ($1,$2,$3,'dealt') returning id",
  [periodStart, partRater, uid(2)], // test rater, REAL subject
)).id;
await asId(partRater);
await assert.rejects(
  () => submit(crossAssignment1, crypto.randomUUID(), RUBRIC_V1, FULL),
  /test\/live account boundary/,
  "a test rater cannot submit against a real subject, even via a hand-inserted row",
);
await admin();
const crossAssignment2 = (await one(
  "insert into values_assignments (period_start, rater_id, subject_id, reason) values ($1,$2,$3,'dealt') returning id",
  [periodStart, uid(1), partSubject], // REAL rater, test subject
)).id;
await as(1);
await assert.rejects(
  () => submit(crossAssignment2, crypto.randomUUID(), RUBRIC_V1, FULL),
  /test\/live account boundary/,
  "a real rater cannot submit against a test subject either",
);
// Neither cross-partition row shows as owed to its rater.
await asId(partRater);
const partRaterTasks = (await db.query("select * from public.values_my_tasks()")).rows;
assert.ok(
  !partRaterTasks.some((t) => t.assignment_id === crossAssignment1),
  "values_my_tasks withholds a cross-partition assignment the same way it withholds a cancelled-subject one",
);

// ---- 12. FREEZE MANIFEST PURGE + IMMUTABLE AGGREGATE ACCOUNTING ------------
await admin();
const provPeriod = "2026-04-01";
const provQuarter = "2026-04-01";
await db.query(
  "insert into values_periods (period_start, timezone, rubric_version, algorithm_version, weight_owner, weight_lead, weight_worker, weight_self, solo_factor, min_raters) values ($1,'America/Denver',$2,1,1.0,0.9,0.65,0.15,0.5,3) on conflict do nothing",
  [provPeriod, RUBRIC_V1],
);

// A fresh, disposable rater — purged later in this section — PLUS two
// ordinary raters (uid(1)/uid(2), clearing the 3-rater floor so the frozen
// overall is a real number, not suppressed-null) all reviewing the same
// otherwise-unused subject with genuinely complete, on-time submissions.
const provRater = eid("e5");
await db.query("insert into profiles (id, role, display_name) values ($1,'installer','Prov Rater')", [provRater]);
const provSubject = eid("e6");
await db.query("insert into profiles (id, role, display_name) values ($1,'installer','Prov Subject')", [provSubject]);
const provAssignment = (await one(
  "insert into values_assignments (period_start, rater_id, subject_id, reason) values ($1,$2,$3,'dealt') returning id",
  [provPeriod, provRater, provSubject],
)).id;
const provSubmission = (await one(
  "insert into values_submissions (period_start, assignment_id, rater_id, subject_id, rater_class, request_id, payload_digest, rubric_version, algorithm_version, submitted_at, receipt) " +
    "values ($1,$2,$3,$4,'worker',$5,'prov',$6,1,'2026-04-15T00:00:00Z','{}') returning id",
  [provPeriod, provAssignment, provRater, provSubject, crypto.randomUUID(), RUBRIC_V1],
)).id;
await db.query("insert into values_scores (submission_id, value_slug, score) select $1, s, 6 from unnest($2::text[]) s", [provSubmission, ALL_SLUGS]);
for (const extraRater of [uid(1), uid(2)]) {
  const extraAssignment = (await one(
    "insert into values_assignments (period_start, rater_id, subject_id, reason) values ($1,$2,$3,'dealt') returning id",
    [provPeriod, extraRater, provSubject],
  )).id;
  const extraSubmission = (await one(
    "insert into values_submissions (period_start, assignment_id, rater_id, subject_id, rater_class, request_id, payload_digest, rubric_version, algorithm_version, submitted_at, receipt) " +
      "values ($1,$2,$3,$4,'worker',$5,'prov-extra',$6,1,'2026-04-15T00:00:00Z','{}') returning id",
    [provPeriod, extraAssignment, extraRater, provSubject, crypto.randomUUID(), RUBRIC_V1],
  )).id;
  await db.query("insert into values_scores (submission_id, value_slug, score) select $1, s, 6 from unnest($2::text[]) s", [extraSubmission, ALL_SLUGS]);
}

// A second subject in the SAME quarter, reviewed only by an INCOMPLETE
// (seven-score) submission — must freeze to a null row, manifest reason
// "incomplete", not merely excluded by cutoff.
const incSubject = eid("e7");
await db.query("insert into profiles (id, role, display_name) values ($1,'installer','Inc Subject')", [incSubject]);
const incAssignment = (await one(
  "insert into values_assignments (period_start, rater_id, subject_id, reason) values ($1,$2,$3,'dealt') returning id",
  [provPeriod, uid(2), incSubject],
)).id;
const incSubmission = (await one(
  "insert into values_submissions (period_start, assignment_id, rater_id, subject_id, rater_class, request_id, payload_digest, rubric_version, algorithm_version, submitted_at, receipt) " +
    "values ($1,$2,$3,$4,'worker',$5,'inc',$6,1,'2026-04-10T00:00:00Z','{}') returning id",
  [provPeriod, incAssignment, uid(2), incSubject, crypto.randomUUID(), RUBRIC_V1],
)).id;
await db.query(
  "insert into values_scores (submission_id, value_slug, score) select $1, s, 5 from unnest($2::text[]) s",
  [incSubmission, ALL_SLUGS.filter((s) => s !== "safety")],
);

// A third subject, reviewed only by a HAND-INSERTED cross-partition
// submission (a real rater reviewing a test subject) — never writable
// through values_submit after section 11's fix, but the freeze must still
// defensively exclude its data and OMIT its identifying manifest.
const crossFreezeSubject = eid("e8");
await db.query("insert into profiles (id, role, display_name, is_test) values ($1,'installer','Cross Freeze Subject',true)", [crossFreezeSubject]);
const crossFreezeAssignment = (await one(
  "insert into values_assignments (period_start, rater_id, subject_id, reason) values ($1,$2,$3,'dealt') returning id",
  [provPeriod, uid(3), crossFreezeSubject],
)).id;
const crossFreezeSubmission = (await one(
  "insert into values_submissions (period_start, assignment_id, rater_id, subject_id, rater_class, request_id, payload_digest, rubric_version, algorithm_version, submitted_at, receipt) " +
    "values ($1,$2,$3,$4,'worker',$5,'crossf',$6,1,'2026-04-10T00:00:00Z','{}') returning id",
  [provPeriod, crossFreezeAssignment, uid(3), crossFreezeSubject, crypto.randomUUID(), RUBRIC_V1],
)).id;
await db.query("insert into values_scores (submission_id, value_slug, score) select $1, s, 4 from unnest($2::text[]) s", [crossFreezeSubmission, ALL_SLUGS]);

await one("select public._values_freeze_quarter($1::date) as r", [provQuarter]);

const provRating = await one(
  "select id, overall, rubric_version, algorithm_version, policy_versions from values_quarterly_ratings where quarter_start=$1 and subject_id=$2",
  [provQuarter, provSubject],
);
assert.equal(provRating.rubric_version, RUBRIC_V1, "a single-period quarter keeps the uniform scalar rubric_version");
assert.equal(provRating.algorithm_version, 1);
assert.equal(provRating.policy_versions.length, 1, "policy_versions has exactly the one period this quarter touched");
assert.equal(dateStr(provRating.policy_versions[0].periodStart), provPeriod);
assert.ok(!("weightOwner" in provRating.policy_versions[0]), "policy_versions never carries the private weight ladder");

const provManifestBefore = await one(
  "select * from values_quarterly_manifest where rating_id=$1 and rater_id=$2", [provRating.id, provRater]);
assert.equal(provManifestBefore.included, true);
assert.equal(provManifestBefore.exclusion_reason, null);
assert.equal(await count("values_scores where submission_id=$1", [provSubmission]), 8, "all eight raw answers exist before purge");
const manifestColumns = (await db.query("select column_name from information_schema.columns where table_schema='public' and table_name='values_quarterly_manifest'")).rows.map(r => r.column_name);
assert.deepEqual(manifestColumns.sort(), ["id","rating_id","submission_id","rater_id","included","exclusion_reason"].sort(), "no raw vector/weight/class/receipt copy is stored in the manifest");
const frozenState = async (id) => (await one("select jsonb_build_object('rating',to_jsonb(r),'accounting',to_jsonb(a),'values',(select jsonb_agg(to_jsonb(v) order by v.value_slug) from values_quarterly_values v where v.rating_id=r.id)) as state from values_quarterly_ratings r join values_quarterly_accounting a on a.rating_id=r.id where r.id=$1", [id])).state;
const provBefore = await frozenState(provRating.id);
assert.equal(provBefore.rating.overall, 6);
for (const slug of ALL_SLUGS) assert.deepEqual(provBefore.accounting.value_totals[slug], {
  weightedNumerator: 11.7, weightedDenominator: 1.95, nonSelfRaters: 3, submissions: 3, selfSum: 0, selfCount: 0,
});
await asId(provSubject);
assert.equal(await count("values_quarterly_accounting where rating_id=$1", [provRating.id]), 0, "subject cannot divide private aggregate totals");
assert.equal(await count("values_quarterly_manifest where rating_id=$1", [provRating.id]), 0);
await assert.rejects(() => db.query("update values_quarterly_accounting set value_totals='{}' where rating_id=$1", [provRating.id]), /permission denied/);
await asId(partOwner);
assert.equal(await count("values_quarterly_accounting where rating_id=$1", [provRating.id]), 0, "test owner cannot read live accounting");
await as(5);
assert.equal(await count("values_quarterly_accounting where rating_id=$1", [provRating.id]), 1, "live owner can read live accounting");
await assert.rejects(() => db.query("delete from values_quarterly_manifest where id=$1", [provManifestBefore.id]), /permission denied/);
await assert.rejects(() => db.query("update values_quarterly_ratings set overall=10 where id=$1", [provRating.id]), /permission denied/);
for (const blocked of [1,4,7]) {
  await as(blocked);
  assert.equal(await count("values_quarterly_accounting where rating_id=$1", [provRating.id]), 0, "installer/lead/partner cannot read private accounting");
}
for (const flag of ["retired_at","access_revoked_at"]) {
  await admin();
  await db.query(`update profiles set ${flag}=now() where id=$1`,[uid(5)]);
  await as(5);
  assert.equal(await count("values_quarterly_accounting where rating_id=$1",[provRating.id]),0, `${flag} blocks lingering owner JWT from private accounting`);
  await admin();
  await db.query(`update profiles set ${flag}=null where id=$1`,[uid(5)]);
}
await admin();
await db.query("delete from profiles where id=$1", [provRater]);
for (const [table, column, value] of [["values_assignments","id",provAssignment],["values_submissions","id",provSubmission],["values_scores","submission_id",provSubmission],["values_quarterly_manifest","id",provManifestBefore.id]]) {
  assert.equal(await count(`${table} where ${column}=$1`, [value]), 0, `${table} raw contributor data cascaded away`);
}
assert.deepEqual(await frozenState(provRating.id), provBefore, "other subject's frozen values/counts/policies/aggregate math are byte-equivalent after contributor purge");
await db.query("select public._values_freeze_quarter($1::date)", [provQuarter]);
assert.deepEqual(await frozenState(provRating.id), provBefore, "refreeze after purge never recomputes from remaining provenance");

const incRating = await one("select id, overall, submission_count from values_quarterly_ratings where quarter_start=$1 and subject_id=$2", [provQuarter, incSubject]);
assert.equal(incRating.overall, null, "the only contributor was incomplete — a null frozen row, same as zero submissions");
assert.equal(incRating.submission_count, 0);
const incManifest = await one("select exclusion_reason, included from values_quarterly_manifest where rating_id=$1", [incRating.id]);
assert.equal(incManifest.included, false);
assert.equal(incManifest.exclusion_reason, "incomplete", "named distinctly from late");

const crossFreezeRating = await one("select id, overall, submission_count from values_quarterly_ratings where quarter_start=$1 and subject_id=$2", [provQuarter, crossFreezeSubject]);
assert.equal(crossFreezeRating.overall, null, "the only contributor crossed the partition wall — excluded, null frozen row");
assert.equal(crossFreezeRating.submission_count, 0);
assert.equal(await count("values_quarterly_manifest where rating_id=$1", [crossFreezeRating.id]), 0, "cross-partition contributor identity is not copied into the manifest");
await asId(partOwner);
assert.equal(await count("values_quarterly_manifest where submission_id=$1", [crossFreezeSubmission]), 0, "same-partition subject owner cannot see opposite-partition reviewer metadata");
await admin();

// ---- 13. PERMISSIVE RLS OR / TASK HISTORY / REPLAY PARTITION REGRESSIONS ---
await asId(partRater);
assert.equal(await count("values_assignments where id=$1", [crossAssignment1]), 0, "rater's permissive policy cannot bypass owner/test partition");
await admin();
const ownerCrossAssignment = (await one("insert into values_assignments(period_start,rater_id,subject_id,reason) values($1,$2,$3,'dealt') returning id", [periodStart,partOwner,uid(2)])).id;
await asId(partOwner);
assert.equal(await count("values_assignments where id=$1", [ownerCrossAssignment]), 0, "owner who is also rater has no OR-policy bypass");
await admin();
// Move only a fixture profile across partitions after a valid accepted review.
await db.query("update profiles set is_test=false where id=$1", [partSubject]);
await asId(partRater);
assert.ok(!(await db.query("select * from values_my_tasks()")).rows.some(r=>r.assignment_id===partAssignment), "submitted task history cannot expose opposite-partition subject identity");
await assert.rejects(()=>submit(partAssignment,partSubmitResult.receipt.requestId,RUBRIC_V1,FULL), /test\/live account boundary/, "immutable receipt replay still enforces current read partition");
await admin();
await db.query("update profiles set is_test=true where id=$1", [partSubject]);
await asId(partRater);
const partReplay=(await one("select values_submit($1,$2,$3,$4,$5) as r", [partAssignment,partSubmitResult.receipt.requestId,RUBRIC_V1,JSON.stringify(FULL),null])).r;
assert.deepEqual(partReplay.receipt,partSubmitResult.receipt, "same-partition replay stays byte-equivalent");
await admin();

// Reusable privileged fixture seeding; production still has only values_submit.
async function seedReview({period,rater,subject,score=7,klass="worker",complete=true,at="2026-04-01T00:00:00Z",rubric=RUBRIC_V1,algorithm=1,solo=false}) {
  const assignment=(await one("insert into values_assignments(period_start,rater_id,subject_id,reason,solo) values($1,$2,$3,$4,$5) returning id", [period,rater,subject,klass==="self"?"self":"dealt",solo])).id;
  if(score===null) return {assignment};
  const submission=(await one("insert into values_submissions(period_start,assignment_id,rater_id,subject_id,rater_class,solo,request_id,payload_digest,rubric_version,algorithm_version,submitted_at,receipt) values($1,$2,$3,$4,$5,$6,$7,'fixture',$8,$9,$10,'{}') returning id", [period,assignment,rater,subject,klass,solo,crypto.randomUUID(),rubric,algorithm,at])).id;
  await db.query("insert into values_scores(submission_id,value_slug,score) select $1,s,$2 from unnest($3::text[]) s", [submission,score,complete?ALL_SLUGS:ALL_SLUGS.slice(0,7)]);
  return {assignment,submission};
}

// ---- 14. ACCEPTED INCLUDES LATE; INCOMPLETE/CROSS-PARTITION ARE NOT ACCEPTED --
const lifecycleIds=Array.from({length:6},()=>crypto.randomUUID());
for(const [i,id] of lifecycleIds.entries()) await db.query("insert into profiles(id,role,display_name,is_test,retired_at) values($1,'installer',$2,$3,$4)", [id,`Lifecycle fixture ${i}`,i===5,i===4?"2026-01-01":null]);
const [lr,ls,li,lp,lc,lx]=lifecycleIds;
const liveCutoff=(await one("select _values_quarter_cutoff_at(_values_quarter_of($1::date)) as c", [livePeriod])).c;
await seedReview({period:livePeriod,rater:lr,subject:lr,score:null,klass:"self"});
await seedReview({period:livePeriod,rater:lr,subject:ls,at:liveCutoff});
const incompleteLifecycle=await seedReview({period:livePeriod,rater:lr,subject:li,complete:false});
await seedReview({period:livePeriod,rater:lr,subject:lc,score:null});
await seedReview({period:livePeriod,rater:lr,subject:lx}); // anomalous cross-partition complete header
await as(5);
const lifecycleReport=(await one("select values_owner_report() as r")).r;
const lifecycleRow=lifecycleReport.people.find(p=>p.userId===lr);
assert.deepEqual(lifecycleRow.asRater,{assigned:4,accepted:1,late:1,pending:2,canceled:1,suspended:0});
assert.equal(lifecycleReport.people.find(p=>p.userId===ls).coverage.actualReceived,1);
const incompleteRow=lifecycleReport.people.find(p=>p.userId===li);
assert.equal(incompleteRow.coverage.actualReceived,0);
assert.equal(incompleteRow.owedCount,1);
assert.ok(!lifecycleReport.people.some(p=>p.userId===lx));
await asId(lr);
assert.equal((await db.query("select * from values_my_tasks() where assignment_id=$1", [incompleteLifecycle.assignment])).rows[0].status,"pending");
assert.equal((await one("select values_my_owed_count() as n")).n,2);
await admin();

// Retirement cancels unanswered work; temporary revocation suspends it.
await db.query("update profiles set retired_at=now() where id=$1",[lr]);
await as(5);
let lifecycleState=(await one("select values_owner_report() as r")).r.people.find(p=>p.userId===lr);
assert.equal(lifecycleState.retired,true);
assert.deepEqual(lifecycleState.asRater,{assigned:4,accepted:1,late:1,pending:0,canceled:3,suspended:0});
await admin();
await db.query("update profiles set retired_at=null,access_revoked_at=now() where id=$1",[lr]);
await as(5);
lifecycleState=(await one("select values_owner_report() as r")).r.people.find(p=>p.userId===lr);
assert.equal(lifecycleState.suspended,true);
assert.deepEqual(lifecycleState.asRater,{assigned:4,accepted:1,late:1,pending:0,canceled:1,suspended:2});
await admin();

await db.query("update profiles set access_revoked_at=null where id=$1",[lr]);
await db.query("update profiles set access_revoked_at=now() where id=$1",[li]);
await as(5);
lifecycleState=(await one("select values_owner_report() as r")).r.people.find(p=>p.userId===lr);
assert.deepEqual(lifecycleState.asRater,{assigned:4,accepted:1,late:1,pending:1,canceled:1,suspended:1},"revoked subject suspends only its unanswered task");
await admin();
await db.query("update profiles set access_revoked_at=null,is_partner=true where id=$1",[li]);
await as(5);
lifecycleState=(await one("select values_owner_report() as r")).r.people.find(p=>p.userId===lr);
assert.deepEqual(lifecycleState.asRater,{assigned:4,accepted:1,late:1,pending:1,canceled:1,suspended:1},"partner conversion remains denied without losing accounting");
await admin();

// ---- 15. MIXED POLICY / HAND-KNOWN WEIGHTED MATH / PRIVATE SUPPRESSION -----
const mixQuarter="2051-01-01",mixSecond="2051-02-01";
await db.query("select _values_ensure_period($1)",[mixQuarter]);
const rubric2=(await one("insert into values_rubric_versions(version_label,source_note) values('fixture-v2','Disposable mixed-policy fixture') returning id")).id;
await db.query("insert into values_periods(period_start,timezone,rubric_version,algorithm_version,weight_version,weight_owner,weight_lead,weight_worker,weight_self,solo_factor,min_raters) values($1,'America/Denver',$2,2,2,1.2,0.8,0.5,0.2,0.5,3)",[mixSecond,rubric2]);
const mixIds=Array.from({length:6},()=>crypto.randomUUID());
for(const id of mixIds) await db.query("insert into profiles(id,role,display_name) values($1,'installer','Mixed-policy fixture')",[id]);
const [ms,mw,ml,mo,thin,empty]=mixIds;
await seedReview({period:mixQuarter,rater:mw,subject:ms,score:2}); // .65 * 2 = 1.3
await seedReview({period:mixQuarter,rater:ml,subject:ms,score:8,klass:"crew_leader"}); // .9 * 8 = 7.2
await seedReview({period:mixSecond,rater:mo,subject:ms,score:10,klass:"owner",rubric:rubric2,algorithm:2}); // 1.2 * 10 = 12
await seedReview({period:mixSecond,rater:ms,subject:ms,score:4,klass:"self",rubric:rubric2,algorithm:2}); // .2 * 4 = .8
await seedReview({period:mixQuarter,rater:mw,subject:thin,score:9});
await seedReview({period:mixQuarter,rater:ml,subject:empty,score:null});
await db.query("select _values_freeze_quarter($1)",[mixQuarter]);
const mixRating=await one("select * from values_quarterly_ratings where quarter_start=$1 and subject_id=$2",[mixQuarter,ms]);
const mixAccounting=await one("select * from values_quarterly_accounting where rating_id=$1",[mixRating.id]);
assert.equal(mixRating.rubric_version,null);assert.equal(mixRating.algorithm_version,null);
assert.equal(Number(mixRating.overall),7.22); // 21.3 / 2.95 = 7.220338...
assert.deepEqual(mixAccounting.policy_snapshots.map(p=>[p.periodStart,p.rubricVersion,p.algorithmVersion,p.weightVersion,p.weightOwner]), [[mixQuarter,RUBRIC_V1,1,1,1],[mixSecond,rubric2,2,2,1.2]]);
for(const slug of ALL_SLUGS) assert.deepEqual(mixAccounting.value_totals[slug],{weightedNumerator:21.3,weightedDenominator:2.95,nonSelfRaters:3,submissions:4,selfSum:4,selfCount:1});
const emptyRating=await one("select id,overall from values_quarterly_ratings where quarter_start=$1 and subject_id=$2",[mixQuarter,empty]);
assert.equal(emptyRating.overall,null);
const emptyTotals=(await one("select value_totals from values_quarterly_accounting where rating_id=$1",[emptyRating.id])).value_totals;
for(const slug of ALL_SLUGS) assert.deepEqual(emptyTotals[slug],{weightedNumerator:0,weightedDenominator:0,nonSelfRaters:0,submissions:0,selfSum:0,selfCount:0});
const thinRating=await one("select id from values_quarterly_ratings where quarter_start=$1 and subject_id=$2",[mixQuarter,thin]);
await asId(thin);
assert.equal((await one("select overall from values_quarterly_ratings where id=$1",[thinRating.id])).overall,null);
assert.equal(await count("values_quarterly_values where rating_id=$1",[thinRating.id]),0);
assert.equal(await count("values_quarterly_accounting where rating_id=$1",[thinRating.id]),0,"one-review arithmetic must not bypass suppression");
const thinSummary=(await one("select values_my_summary() as s")).s;
assert.ok(!JSON.stringify(thinSummary).includes("weightedNumerator"));
await admin();
const mixBefore=await frozenState(mixRating.id);
await db.query("insert into values_reminder_claims(profile_id,period_start,kind,dedupe_key) values($1,$2,'month_end','fixture-purge')",[mw,mixQuarter]);
await db.query("delete from profiles where id=$1",[mw]);
assert.equal(await count("values_reminder_claims where profile_id=$1",[mw]),0);
assert.equal(await count("values_quarterly_manifest where rater_id=$1",[mw]),0);
assert.deepEqual(await frozenState(mixRating.id),mixBefore);
await db.query("select _values_freeze_quarter($1)",[mixQuarter]);
assert.deepEqual(await frozenState(mixRating.id),mixBefore,"mixed-policy snapshot and math immutable after purge/refreeze");
await db.query("delete from profiles where id=$1",[ms]);
assert.equal(await count("values_quarterly_ratings where id=$1",[mixRating.id]),0);
assert.equal(await count("values_quarterly_accounting where rating_id=$1",[mixRating.id]),0,"subject purge removes private accounting");
assert.equal(await count("values_quarterly_manifest where rating_id=$1",[mixRating.id]),0);

console.log(
  "Monthly values reviews (post-remediation): RLS/grant denial including revoked owner/rater, " +
    "values_submit atomic/validated(array-shaped, string/null/duplicate-rejecting)/idempotent/conflict-safe/rubric-version-checked, " +
    "no rater raw-table read, values_my_tasks lifecycle-cancellation on a retired subject, " +
    "per-value rater-threshold suppression with incomplete-submission exclusion, " +
    "values_owner_report owner-only (foreman/partner/revoked-owner refused), " +
    "the deal actually runs without 42P10 and excludes a test project, " +
    "cutoff-bound freeze excludes a late submission with a visible manifest, " +
    "a zero-submission assigned subject still freezes, " +
    "scheduler off by default and owner-only to flip, the calendar helpers, " +
    "test/live caller-partition enforcement at owner RLS/report and submit (same-partition QA probes still work, " +
    "cross-partition submission and raw read are denied both directions), and freeze manifest exclusion reasons " +
    "(late/incomplete; opposite-partition source omitted), aggregate-only private accounting, and raw contributor purge all passed.",
);
await db.close();
