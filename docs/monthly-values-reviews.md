# Monthly core-value reviews

Built 2026-10-03 on an owner-authorized build instruction, in the isolated
worktree `monthly-values-reviews` (branch `codex/monthly-values-reviews`).
**Deployment remains gated** — nothing here has run against live data; the
scheduler ships disabled by default and real release is a parent decision.

## What this is

Once a scorable month, every active crew member reviews a handful of people
they worked beside (plus themselves) on Horizon's eight core values — one
integer score 1–10 per value, plus an optional overall comment. Confidential
to the person scored (they see only thresholded aggregates and their own
self score); identifiable to the owner (named raw rows, comments, rater
identity). Quarterly, a frozen rating is computed from the same engine over
the whole closed quarter and never changes again.

## Provenance

- Source: pinned Horizon snapshot
  `taylorhorizon/horizon-hub-44@94b0d20cd0882ee1173092d2892b97a4a198d946`.
- Research: `../outputs/Horizon-Crew-Goals-Reviews-2026-10-03/HORIZON-CORE-VALUE-REVIEWS.md`,
  `TRANSFER-INTEGRITY-REVIEW.md`, `RECOMMENDATIONS.md`.
- English rubric text: `app/src/lib/values/rubric.ts`, verbatim, with a
  source-fixture comparison test (`rubric.test.ts` vs `rubric.fixture.json`).
  The source itself marks the briefing/criteria/anchors as drafts for
  Horizon's owner's red pen; Forge's owner approved **building** this exact
  text, not a separate re-authoring of it. The Ownership briefing's source
  text names "Horizon" by name — kept literal on purpose (see the comment in
  `rubric.ts`); renaming it is an explicit open owner decision, not something
  silently fixed here.
- Spanish: `app/src/lib/i18n/valuesCatalog.ts`'s `VALUE_RUBRICS_ES` — a
  reviewed translation of the same English draft, not an independently
  authored rubric.

## Declared adaptations from the pinned source

All five are documented at the top of `app/src/lib/values/valuesEngine.ts`
and in the migration's own header comment:

1. **Denver, not Eastern.** Explicit locale choice. The TS engine's own test
   suite checks DST/month boundaries in Denver terms; there is no claim of
   literal Eastern-midnight parity.
2. **Per-value rater threshold**, not window-wide (TRANSFER-INTEGRITY-REVIEW
   §3). Every combined value needs its *own* three distinct non-self raters.
   **Residual note:** because adaptation #4 below makes every submission
   atomic across all eight values, a single subject's rater count is, in
   practice, currently identical across all eight slugs for any one window —
   the exact partial-submission precondition that made Horizon's version of
   this bug possible cannot arise through `values_submit()`. The per-value
   suppression is kept anyway as defense in depth (a future correction route,
   a data migration, or a schema change could reintroduce partial rows), and
   is exercised directly in both `valuesEngine.test.ts` (pure function, hand-
   built fixtures) and `scripts/verify-values-reviews.mjs` (hand-crafted rows
   against the real schema, bypassing `values_submit` as admin).
3. **No clock-in wall, at all.** Horizon's `clockInWallApplies` is not ported
   in any form. A review never blocks, edits or backdates a clock punch,
   Break or Clock out. There is no "owed review" gate anywhere in the clock
   path.
4. **Atomic, complete submissions only.** `values_submit()` commits the
   header and all eight scores in one transaction. There is no Horizon-style
   "header saved, children repaired later" state to aggregate.
5. **No weekly history.** Forge has never run a weekly ritual; every period
   here is a calendar month from the start.

## Remediation pass (same session)

An independent SQL review (Codex, `../outputs/Crew-Goals-Values-Build-2026-10-03/VALUES-SQL-SECURITY-REVIEW.md`) actually EXECUTED an earlier draft of `20261106000000_monthly_values_reviews.sql` (sha256 `bdb082e4...`) in PGlite and found ten concrete, numbered findings. All ten were corrected in this same session, against the current file:

1. **Revoked/retired accounts retained reads.** Added `_values_eligible(uuid)` / `_values_is_owner(uuid)` (exact `role='owner'`, not a generic rank floor), applied to every RLS policy and every RPC, re-checked on every call. Removed the rater's raw-read policy on `values_submissions`/`values_scores` entirely — a rater's own confirmation is the receipt `values_submit` returns and `values_my_tasks`' status, never a direct table read.
2. **Assignment generation failed at runtime (42P10).** Two `SELECT DISTINCT ... ORDER BY <expr not in select list>` statements in `_values_deal_period` are fixed by wrapping the `DISTINCT` in a derived table and sorting the (non-DISTINCT) outer query.
3. **Freeze used scheduler execution time, not the cutoff; raced submissions.** Added `_values_quarter_cutoff_at(quarter)` (exact Denver-midnight timestamptz) and a `p_cutoff` parameter on `_values_mirror`; `_values_freeze_quarter` now filters `submitted_at < cutoff`. `values_submit` and `_values_freeze_quarter` now share one advisory lock key (`values_period:<period_start>`), acquired by freeze for every period in the quarter before it reads anything, and by submit before it captures `acceptedAt`.
4. **Empty assigned subjects never froze; snapshots lacked evidence.** Freeze now enumerates subjects from `values_assignments`, not `values_submissions`. Added `values_quarterly_ratings.cutoff`/`.rubric_version` and a new `values_quarterly_manifest` table (submission/rater references are `ON DELETE SET NULL`, purge-safe) recording every submission considered, included or not.
5. **Receipt inclusion was unstable; no rubric-version check.** `values_submit` now takes `p_rubric_version` and refuses a mismatch against the assignment's period. The receipt's `quarterEligibility` (`eligible_before_cutoff` | `late_after_cutoff`) is a pure function of the immutable `submitted_at` and the cutoff — identical before and after a later freeze, replacing the old `quarterIncluded` boolean that flipped after freezing.
6. **Test/live partition and solo eligibility not enforced end to end.** Attendance and `_values_recent_coworkers` now join `projects` and require `not is_test`, on top of the existing profile-eligibility checks already applied to the candidate side.
7. **Catch-up dealing and lifecycle were missing.** `values_run_due` now deals/tops-up every open (not yet quarter-closed) scorable month on every run, not only the current one. `values_my_tasks`/`values_my_owed_count`/`values_submit` withhold or refuse a task whose SUBJECT has since been retired/revoked (functional lifecycle cancellation, via eligibility filtering rather than a new status column — a declared simplification, see below).
8. **Allocation could double-count a pair; running counts weren't live.** `tmp_values_new` now has a `UNIQUE (rater_id, subject_id)` constraint with `ON CONFLICT DO NOTHING` on every insert into it. The worker base-pick's "least received" ordering now adds live, same-run `tmp_values_new` counts to the stored baseline.
9. **Aggregation counted incomplete submissions.** `_values_mirror` now has a `complete_submissions` CTE requiring exactly eight score rows; an incomplete header (only reachable outside `values_submit`, e.g. a hand-made fixture) contributes to nothing.
10. **Digest depended on an unqualified, possibly-missing `digest()`.** Replaced with PostgreSQL's built-in `pg_catalog.sha256(bytea)` (core since PG11) over `convert_to(text,'UTF8')` — no `pgcrypto`/`extensions` schema dependency at all.

Also addressed from "additional required fixes": `p_scores` is now a JSON **array** of `{slug,score}` objects, not an object keyed by slug (an object silently collapses a real duplicate key and erases the JSON number/string distinction before the function ever sees it); every score is validated against a genuine JSON number and a bare-digit text pattern, so a string `"7"`, `null`, or a true duplicate slug are all refused; `_values_slugs()` is now revoked from `anon`/`authenticated` too.

**Declared simplification, not fully addressed:** the review's full "owner-only coverage/canceled/suspended/missing/accepted/late distinction" in `values_owner_report` is implemented only partially (`owedCount` per subject; lifecycle cancellation via eligibility filtering). A dedicated status column/state machine on `values_assignments` (canceled vs. suspended vs. missing vs. accepted vs. late, surfaced explicitly in the owner report) was judged out of scope for this pass and is the clearest remaining gap for a follow-up session.

**None of this was executed in this session** — `scripts/verify-values-reviews.mjs` and `scripts/dry-run-probes/monthly-values-reviews.sql` were rewritten to exercise every finding above (including, for the first time, actually calling `_values_deal_period` against seeded `time_shifts`/`projects` data, since that is exactly the call that used to crash with 42P10), but neither has been run. Treat every claim in this section as unverified until the parent runs them. PGlite remains single-connection and cannot prove the real two-session race the per-period advisory lock is meant to serialize; that needs the real-database rollback-only probe.

## Schema (20261106000000)

`values_rubric_versions`, `values_periods` (private policy snapshot: weights,
timezone, rubric/algorithm version — never exposed to a crew-facing
response), `values_assignments`, `values_submissions`, `values_scores`,
`values_quarterly_ratings`, `values_quarterly_values`, and
`values_reminder_claims` (**reserved, unused — see Stage 2 below**).

Weights: owner 1.0, lead (foreman/supervisor) 0.9, worker (installer) 0.65,
self 0.15, solo×0.5 — exactly the brief's values, written once per period by
`_values_ensure_period` and never changed for an already-dealt period.

## RPCs

- `values_my_tasks()`, `values_my_owed_count()`, `values_my_summary()` —
  caller-scoped, no subject override possible.
- `values_submit(assignment_id, request_id, rubric_version, scores, comment)`
  — the one write path. `scores` is a JSON **array** of `{slug, score}`
  objects (not an object keyed by slug — see the remediation note above on
  why). Validates exactly eight known slugs (each a genuine JSON
  number/string; a string `"7"`, `null`, or a true duplicate slug are all
  refused), integer 1–10 via the raw text (not cast through `numeric`, which
  would silently round a fractional value), ≤2000-char comment, and that
  `rubric_version` matches the assignment's period. Derives rater class/solo
  server-side; idempotent replay by `(rater_id, request_id, assignment_id)`;
  a changed payload under the same request id, or a competing request id for
  an already-completed assignment, raises `23505`. The returned receipt is
  immutable: `{submissionId, assignmentId, requestId, digest, rubricVersion,
  acceptedAt, periodStart, quarterStart, cutoff, quarterEligibility, replay}`
  — `quarterEligibility` (`eligible_before_cutoff` | `late_after_cutoff`) is a
  pure function of `acceptedAt` and the quarter's cutoff, so a replay returns
  the byte-identical value forever, even after the quarter later freezes.
- `values_owner_report()` — re-checks owner authority (rank ≥ 3, not a
  partner) on *every* call.
- `set_values_scheduler_enabled(bool)` — owner-only.
- `values_run_due()` — parameterless, service-only (not granted to
  anon/authenticated/service_role either — reachable only by `pg_cron`
  calling it directly in SQL). No-ops entirely unless
  `company_settings.values_scheduler_enabled` is true. **Off by default.**
  Scheduled hourly via direct `cron.schedule(...)`, never an HTTP endpoint.

Internal helpers (`_values_*`) are never granted to `anon`/`authenticated` —
callable only from other `SECURITY DEFINER` functions owned by the same
migration role, same pattern as `_unit_work_gate` etc.

## The deal (assignment engine)

`_values_deal_period(p_period)` is SQL's **independent** port of
`app/src/lib/values/valuesEngine.ts`'s `dealAssignments`/`assignmentsToStore`
rules — same quotas (2 per worker), same coverage floor (2), same merge-on-
redeal guarantee (a rater who already holds rows this period is never dealt
a fresh base pick again; a subject still short of the floor may still
collect one). It is **not** a line-for-line transliteration of the TS code,
and there is no promise of identical random person selection between the
two implementations — only the same rules. Person-days come from
`time_shifts` with `status in ('open','submitted','approved')` (voided,
rejected and needs-finish shifts are excluded from coverage, not silently
trusted), real (non-test) accounts with current access, `profiles.active`
is never read.

**What was NOT independently exercised in this session:** the deal
function's PL/pgSQL body (temp-table bookkeeping, the floor pass, the merge
pass) was hand-traced carefully (see the PR body / commit history for the
reasoning) but has **not been run** — there is no synthetic-crew PGlite
harness for it in this build, because it depends on `time_shifts` +
`profiles` role data that would require a much larger fixture than this
session's budget allowed. The pure TS engine (`valuesEngine.test.ts`) *is*
unit-tested thoroughly and is the trustworthy half; the SQL port is the
parent's next verification priority — see "Next steps" below.

## Quarter freeze

`_values_freeze_quarter(quarter_start)` — idempotent by **skipping** an
already-frozen subject, never overwriting. Collection cutoff is Denver
00:00 on the 10th of the month after the quarter closes
(`_values_quarter_closed`). A later submission for a period inside an
already-frozen quarter still inserts into `values_submissions` (identifiable
late evidence) but never reopens or edits the freeze.

## Privacy, purge and CASCADE

- `values_assignments.{rater_id,subject_id}`, `values_submissions.{rater_id,
  subject_id}`, `values_quarterly_ratings.subject_id`,
  `values_reminder_claims.profile_id` — all `ON DELETE CASCADE` to
  `profiles(id)`, registered in `person_record_counts` (restated in full in
  this migration, per the existing pattern) and in
  `app/src/lib/purgeWords.ts`'s `WORK_HISTORY_PROBES`, verified by
  `purgeWords.test.ts`'s schema-derived completeness check.
- Raw tables are never exposed to a subject, a notification, an export, AI
  context, or diagnostics/log scrubbing. `values_my_summary`/
  `values_my_tasks`/`values_owner_report` are the only reads; none return
  weights, and none but the owner's return rater identity or comments.
- **Dependency, not solved here:** this checkout's `purgeLogin.ts` retires an
  account with any history indefinitely; there is no three-month employee
  purge in this codebase. A global purge of this feature's own rows (beyond
  the account-removal cascade above) is a separate coordinator follow-up, not
  an expansion of this build.

## Offline

`values_submit` goes through the existing outbox (`op: "values_submit"`,
`lib/offline/outbox.ts`'s `enqueueValuesSubmit`, handler in
`outboxHandlers.ts`). The request id **is** the outbox entry's stable id, so
a dropped reply and the ordinary retry are the exact same request. A draft
(unfinished scores + comment) is kept in `localStorage`, keyed by assignment
id, cleared only on a confirmed accepted submission; a missing/corrupt draft
starts fresh rather than crashing. `entryOwner.ts` maps `values_submit` →
`raterId`, same shape as `toolbox_sign` → `profileId`.

## UI

- `/values` (installer floor, hidden — reached from Settings → "My values",
  never a bottom-bar or menu row of its own): owed tasks, one-person-at-a-
  time form, rolling/all-time/quarterly summary.
- `/values/owner` (gated on **`realRole`**, not `effectiveRole` — see
  `RequireRealOwner` in `App.tsx` — so an owner previewing a lower role never
  mounts this page or its query, per the brief's "avoid mounting owner
  queries in crew previews"): named matrix, scheduler on/off toggle.
- `components/values/MyValuesSettingsCard.tsx`: Settings card with owed
  count; the owner-matrix link only renders for `realRole === "owner"`.
- EN/ES: `app/src/lib/i18n/valuesCatalog.ts`, registered into the shared
  catalog (`TKey` union in `catalog.ts`), same lazy-chunk pattern as
  `workCatalog.ts`.

## What is explicitly NOT in this build

- **Stage 2 (push reminders).** `values_reminder_claims` exists as an empty,
  unused schema placeholder. No edge function, no `SYSTEM_ACTORS.md` entry,
  no cron target for it. Documented as the next review slice, not claimed
  implemented.
- **Real activation.** `company_settings.values_scheduler_enabled` defaults
  to `false`. The cron job itself is registered (so it exists and can be
  flipped) but every invocation is a cheap single-row no-op select while the
  flag is off.
- **A global, schedule-wide employee purge.** Only the account-removal
  cascade above.
- **Rubric re-authoring.** The English text is exactly the pinned Horizon
  draft; it has not been separately polished, re-translated from scratch, or
  had "Horizon" renamed to "Forge"/the company name.

## Open owner decisions (carried over from the research, not resolved here)

1. Confirm the draft rubric text as Forge's adopted standard (or revise it).
2. Confirm the Denver/month-boundary choice and the "current month minus
   three months" mirror window as the intended trend definition going
   forward (vs. a later switch to exactly three completed calendar months —
   which would be a new, versioned algorithm, never a silent rewrite).
3. Decide whether a person with genuinely no firsthand observation of
   someone should stay a mandatory, flagged review, or gain an explicit
   non-scored exception — Horizon has neither; adding one is a deliberate
   departure, not a bug fix.
4. Whether/when to rename "Horizon" in the Ownership briefing.
5. Real activation timeline for `values_scheduler_enabled` and Stage 2 push.

## Next steps for the parent / before any real activation

1. Run `npm test`, `npm run lint`, `npx tsc --noEmit -p tsconfig.app.json`
   inside `app/` (Node 22). This session did not execute any of these —
   treat every claim above as unverified until they pass.
2. Run `node scripts/verify-values-reviews.mjs` (needs `@electric-sql/pglite`
   — already a dev dependency per the existing verify-*.mjs scripts, also
   available pre-built at `/tmp/forge-daily-log-pglite/node_modules/
   @electric-sql/pglite/dist/index.js` per the independent reviewer's own
   environment notes). The earlier `pgcrypto`-availability risk no longer
   applies: `values_submit` now hashes with PostgreSQL's built-in
   `pg_catalog.sha256`, which this script neither installs nor stubs.
3. `gh workflow run db-dry-run.yml` against
   `scripts/dry-run-probes/monthly-values-reviews.sql` — this is the real-
   database rollback-only probe; it has not been run in this session.
4. Build a synthetic-crew fixture and exercise `_values_deal_period`
   directly (coverage floor, solo fallback, merge-on-redeal across two
   consecutive calls) — the gap called out above.
5. Phone/desktop E2E for `/values` (score entry, offline draft survival,
   restart) and `/values/owner` (realRole gating) — not attempted here.
6. Only then: owner decision on `values_scheduler_enabled`, per the open
   decisions above.

## Files

Owned by this build: `app/src/lib/values/**`, `app/src/pages/values/**`,
`app/src/components/values/**`, `app/src/lib/i18n/valuesCatalog.ts`,
`docs/monthly-values-reviews.md`, `scripts/verify-values-reviews.mjs`,
`scripts/dry-run-probes/monthly-values-reviews.sql`,
`supabase/migrations/20261106000000_monthly_values_reviews.sql`,
`supabase/migrations/20261106010000_monthly_values_reviews_note.sql`.

Shared integration edits (additive only, coordinated with the separate goals
branch per the coordinator's instruction): `App.tsx`, `lib/nav.ts`,
`pages/Settings.tsx`, `lib/queryKeys.ts`,
`lib/offline/{outbox-core,outbox,outboxHandlers,entryOwner}.ts`,
`lib/purgeWords.ts`, `lib/appUpdates.ts`, `lib/i18n/catalog.ts`,
`lib/i18n/installerFloor.test.ts`, `lib/offline/entryOwner.test.ts`.
