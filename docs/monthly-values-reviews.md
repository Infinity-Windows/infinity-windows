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

## Current authority and privacy boundary

Every RPC checks the current caller. Owner authority means exact
`profiles.role = 'owner'`, not a rank threshold, and requires a nonpartner,
nonretired, nonrevoked profile. Arbitrary-profile eligibility/owner helpers
remain ungranted; the two authenticated zero-argument caller wrappers close
over `auth.uid()` for RLS. Revoked/retired/partner callers cannot retain reads
with an old JWT. Test/live partition checks apply to raw owner reads, the
rater's own assignment policy, all task history, aggregates, new submissions
and receipt replay. An owner does not bypass the partition wall.

Raw submissions, scores, comments and identifying freeze manifests are
owner-only. Raters can read their own same-partition assignments and receive
an immutable submission receipt. Crew summaries contain only per-value
aggregates suppressed below three distinct nonself reviewers, their separate
self average and safe frozen quarter results. No arbitrary subject argument
is accepted. Weights remain private. Only complete eight-score submissions
enter aggregates and accepted/coverage counts.

## Submit, calendar and allocation

`values_submit(assignment_id, request_id, rubric_version, scores, comment)`
requires exactly eight objects with exactly `slug` and `score`, unique known
slugs, numeric integer scores 1–10, the period's rubric version and an optional
comment of at most 2,000 Unicode code points. The digest is the shared
`forge-values-submit/v1` canonical UTF-8 encoding, hashed with PostgreSQL's
built-in `pg_catalog.sha256`; no pgcrypto schema lookup is required. See
`../outputs/Crew-Goals-Values-Build-2026-10-03/VALUES-RECEIPT-CONTRACT.md`.

The per-rater request lock, assignment row lock and governing period lock
serialize acceptance. The server rechecks access after waiting and captures
`clock_timestamp()` after the period lock. Header, eight scores and immutable
receipt commit atomically. Exact request/payload replay returns that saved
receipt, including after freeze; changed payload or another request for an
already-completed assignment conflicts. Receipt eligibility describes the
acceptance time, not whether cron has already frozen the quarter.

Denver calendar rules open the final seven days of a month. The quarter's
strict cutoff is Denver 00:00 on the tenth of the following month. Existing
assignments may be submitted later as late evidence, without rewriting
frozen results. `values_run_due()` derives time from the database, catches up
open/unfrozen periods and freezes closed quarters in order. It has no client
arguments and is callable by the database cron executor, not authenticated,
anon or service_role through PostgREST. The cron statement contains no secret.
`values_scheduler_enabled` ships OFF; the owner-only toggle does not itself
run dealing or freezing. Activation remains a separate release decision.

Attendance uses distinct profile/project/Denver clock-in day in Forge
`time_shifts`, including open shifts, excluding voided/rejected/needs-finish,
null project, test project/profile and unusable accounts. Worker self plus
normally two coworkers, lead self plus all coworkers, owner participating
leads plus own coworkers, and previous-month solo fallback at half weight
follow the pinned algorithm. Period-seeded ordering, deduplication, deal locks
and merge-on-redeal preserve stored assignments. See
`scripts/verify-values-dealing.mjs` for the independent synthetic allocation
fixture; no exact random-pick parity across implementations is claimed.

The private period policy freezes timezone, rubric/algorithm/weight versions,
owner 1, lead .9, worker .65, self .15 and solo factor .5. A future weight
retune must increment weight_version for new periods; existing policies are
not rewritten. Promotions do not change accepted rater class/solo snapshots.

## Frozen accounting and purge

`values_quarterly_ratings` and `values_quarterly_values` expose only safe,
already-suppressed results, historical counts, cutoff and safe policy-version
metadata to the subject. A mixed-policy quarter has an ordered period array;
its scalar rubric/algorithm version is null when the periods disagree.
Every assigned subject freezes, even with no submissions and a null result.
Retries skip existing ratings; ordinary users and owners have no DML grant.

`values_quarterly_accounting` is a separate owner-only table with the same
caller/subject partition rule. It stores full period policy snapshots and
per-value aggregate weighted numerator/denominator, historical nonself count,
submission count and separate self totals. These private fields never appear
in subject-readable tables or crew RPCs: dividing unsuppressed totals would
otherwise bypass the privacy threshold. Empty values retain zero accounting.

`values_quarterly_manifest` stores only source/rater references and
included/late/incomplete classification. It does not copy any individual
score vector, weight/class, comment or receipt. Opposite-partition contributions
are omitted. Source and rater FKs use CASCADE, so an authorized profile purge
removes the affected raw submissions/scores/assignments, manifest rows and
reminder claims. The corresponding reference is registered in
`person_record_counts` and the app purge probes. Subject deletion cascades
that subject's ratings, values, private accounting and manifests.

Other subjects' already-frozen aggregates, policies and historical counts
remain byte-equivalent when a contributor is purged. A shorter surviving
manifest means identifying provenance was erased; do not recompute the
historical denominator from it. Exact individual reconstruction after purge
is intentionally unavailable. Purge is the explicit exception to manifest
retention; no ordinary RPC can erase it. There is no global three-month
employee purge in this checkout; implementing that remains separate work.

## Lifecycle and owner report

`values_owner_report()` returns same-partition named raw reviews and the
published additive `asRater`, `coverage`, `suspended` and `retired` fields.
`accepted` includes late complete submissions; `late` is a subset.
`assigned = accepted + pending + canceled + suspended`. Incomplete imported headers are
not accepted: an eligible subject remains pending. Cross-partition pairs
contribute to none of these counts. Unanswered work for a retired rater or subject counts canceled;
nonretired pairs with either side revoked or converted to a partner count
suspended. Pending requires both sides eligible. Subject
retirement/revocation withholds outstanding tasks; accepted same-partition history remains retained. Temporary
revocation prevents work while access is revoked. The owner report's period
is clamped to launch so early launch-month views never claim a prelaunch
September review period.

The person list retains its published subject-based scope (ever assigned or
reviewed within the caller's partition). `coverage.expectedReceived = 2` is
the monthly assignment target, distinct from the three-rater aggregate
privacy floor. Stage 2 push is not implemented: `values_reminder_claims` is an
unused, purge-compatible schema placeholder with no delivery worker.

## UI and offline boundary

`/values` presents current tasks, eight initially unselected scores and an
optional overall comment, plus rolling/all-time/frozen-quarter summaries.
`/values/owner` is restricted to the real eligible owner; crew preview does
not mount the owner report. Private query keys include identity/generation;
owner views require a fresh online response, and account/preview boundaries
clear private projections. Raw reports are never persisted as offline drafts.

Drafts and queued submissions are owner-bound. The exact saved request/digest
must match the validated server receipt before an atomic local acknowledgment
removes the queue entry. Form writes serialize through close/reopen, controls
lock the submission snapshot during hashing, and an already-open own form
survives signal loss. These are separate from server acceptance guarantees;
see `VALUES-FORM-FINAL-FIX.md` and the offline review handoffs in outputs.
A review never blocks clock, break, clock-out or photo operations.

## Verification and remaining release gates

The canonical `scripts/verify-values-reviews.mjs` executes the migration in
an existing disposable PGlite database with synthetic schema fixtures. It
checks real SQL role/RLS boundaries, strict payload/digest/receipt behavior,
complete-only aggregation, lifecycle counts, cutoff/zero-quarter behavior,
private accounting access, mixed policies with hand-known weighted math,
raw contribution purge and unchanged historical aggregates/refreeze.
`scripts/verify-values-dealing.mjs` independently exercises allocation,
coverage, solo half weight, stable redealing and missed-cron catch-up.

PGlite is single-connection. The parent-owned
`scripts/verify-values-concurrency.py` is a genuine two-session disposable
PostgreSQL CI fixture for duplicate/conflict and cutoff/freeze races; its
execution is separate evidence, not implied by canonical script success.
`scripts/dry-run-probes/monthly-values-reviews.sql` exercises public RPCs and
actual grants under temporary QA identities inside the mandatory rollback
batch; it does not mutate real employee roles or freeze their quarters.
The real-schema rollback probe and final independent Claude review remain
release gates. Physical-device/offline and owner/crew acceptance, build,
lint, CI, deployment and scheduler activation are separate coordinator gates.

See the dated `VALUES-SQL-FINAL-FIX.md` handoff for executed checks and exact
file hashes. This document does not claim unrun CI, live-database, field or
release verification. No global purge, rubric re-authoring, weekly ritual,
clock wall or push delivery is included.
