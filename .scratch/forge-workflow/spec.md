# Forge iPhone workflow

Status: implementation in progress

## Direction from the owner

Implement the busybusy review in Forge. Design every role for iPhone web use first, with an optional computer layout. Source: `docs/busybusy-design-review.md`.

## Live-app coordination requirement

The owner explicitly requires preserving the live app and Claude Code's work.
Keep changes isolated and PRs in draft until checks and review are complete.
Reconcile with current master without discarding either agent's changes.
Do not merge or deploy without the owner's approval. No test writes to live
business records. No automatic notification to Claude is implied by this spec;
use the shared repository and PR state for coordination until a direct channel
is explicitly authorized.

## Product contract

The daily loop is plan → publish instructions → work and capture → review. Draft plans, published instructions, actual time, and report revisions are separate states linked by durable identifiers. Preserve installation sessions, unit records, warehouse workflows, travel/lodging fields, existing permission grants, English/Spanish, and foreground-only location policy.

Use Auto / Phone / Desktop as a per-device display preference. Shared URLs, permissions, queries and mutations underlie both layouts. Changing layout preserves job/date/filter/editor state. Phone screens use a day agenda, full-screen forms, readable person rows, touch actions, and continuous trip details. Desktop expands those same flows into boards and adjacent details. No feature may require hover or dragging.

## Delivery and ownership

Baseline: master 6ecbb59, refreshed September 7, 2026 (America/Denver). Working branch: codex/iphone-workflow. This is an isolated checkout, not the user's Downloads checkout.

First slice: TripDetail.tsx, its scoped CSS, two translated strings, browser coverage, and this workflow. PR #586 supplied Today/Tomorrow/navigation and PR #590 supplied Spanish; both are now merged into the integrated baseline. Preserve those changes and refresh ownership before touching their files. Shared catalog/CSS changes should remain small and additive. No live session handshake with Claude is implied.

## Ordered implementation tickets

1. `issues/01-continuous-trip-sheet.md` — first implementation slice.
2. `issues/02-display-layouts.md` — reusable device preference and phone layouts.
3. `issues/03-publication-contract.md` — verify live schema, permissions, and migration constraints.
4. `issues/04-linked-publication.md` — persistent plan links and atomic publication.
5. `issues/05-phone-schedule.md` — phone plan editor and agenda connected to the trip.
6. `issues/06-daily-role-flow.md` — existing Today and crew tools, actionable exceptions.
7. `issues/07-job-day-report.md` — evidence reused in a reviewable daily report.
8. `issues/08-ai-job-draft.md` — owner-reviewed full-job AI flow.

## Verification gate

Use Node 22. Run app tests, lint, typecheck/build and bundle budget. Add fixture-backed browser checks for affected flows at 375/390 and 1280 CSS pixels, English/Spanish, touch/keyboard, long text, and view changes. Verify Safari on an actual iPhone before describing physical-device behavior as proven. Keep all browser tests on the repository's dedicated fixture server, with no production record writes.

Publication additionally needs: duplicate clicks, retry after commit, concurrent edits, membership removal, two trips for one job, rotations, weekend travel, vehicle conflicts, cancellation, unrelated drafts, partner and crew boundaries, attachment privacy, and offline recovery. A locally stored draft cannot claim publication or notification delivery.

## Access and completion

Source and isolated local tests are available. Live schema/management test verification is an explicit dependency of the publication contract. No new Supabase project. No Gmail, Drive, Backblaze or Docker connector required for this slice. No merge/deployment is implied by a passing local test.

The review is fully incorporated into the tracked workflow; the product program is complete only when every implementation ticket's acceptance checks are satisfied. An individual slice must report what remains.

## First-slice verification

Draft PR #591. The first GitHub CI browser run passed all nine targeted checks. The latest master integration preserves the Spanish changes from #590 and passes 5,360 unit/component tests across 384 files. Physical iPhone Safari verification remains outstanding. The second slice below adds the display toggle; shared publication remains unimplemented.

## Second-slice implementation

Based on master 6ecbb59 after #586 and #590 merged. Auto/Phone/Desktop preference, phone scheduling agenda and editor presentation are implemented for draft review, preserving the first trip-sheet slice. This is presentation work; it does not add shared publication.

Live schema access is available. The read-only audit found database permission and privacy prerequisites; `docs/forge-publication-contract.md` records the evidence, concrete contract and release gate. Tickets 04 and the remaining connected-plan work are still incomplete. Physical iPhone Safari validation remains outstanding.

## Third-slice implementation

Integrated master 32b0620, preserving Claude's #592 three-step window sheet. The verified Schedule/Travel permission prerequisite is now a draft migration with real PostgreSQL role tests in an isolated Docker container. Foreman controls across schedule views match read-only permissions; existing crew job-level vehicle assignment remains available. Full app suite: 5,367 passing tests across 385 files; 15 browser tests pass. Database policy tests and migration replay checks pass. No production migration has been applied. Ticket 04 (linked atomic publication) is the next implementation stage.

## Fourth-slice implementation

Draft connected-plan publication is implemented on master 32b0620. Schedule and Travel share one review, explicit links and server revision, with independent work/travel dates, conflict checks, cancellation and a separate notification queue. My Schedule supports multiple named rotations. The first version edits parent instructions and crew; detailed travel rows/files and vehicle identity freeze after connection. See the publication contract for these limits, purged-job/history handling and the remaining rollout validation. Tickets 05–08 and full detailed working-copy authoring remain incomplete. No production migration or deployment occurred.
