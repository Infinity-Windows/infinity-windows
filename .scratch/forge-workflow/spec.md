# Forge iPhone workflow

Status: implementation in progress

## Direction from the owner

Implement the busybusy review in Forge. Design every role for iPhone web use first, with an optional computer layout. Source: `docs/busybusy-design-review.md`.

## Product contract

The daily loop is plan → publish instructions → work and capture → review. Draft plans, published instructions, actual time, and report revisions are separate states linked by durable identifiers. Preserve installation sessions, unit records, warehouse workflows, travel/lodging fields, existing permission grants, English/Spanish, and foreground-only location policy.

Use Auto / Phone / Desktop as a per-device display preference. Shared URLs, permissions, queries and mutations underlie both layouts. Changing layout preserves job/date/filter/editor state. Phone screens use a day agenda, full-screen forms, readable person rows, touch actions, and continuous trip details. Desktop expands those same flows into boards and adjacent details. No feature may require hover or dragging.

## Delivery and ownership

Baseline: master baacc2e, fetched September 8, 2026. Working branch: codex/iphone-workflow. This is an isolated checkout, not the user's Downloads checkout.

First slice: TripDetail.tsx, its scoped CSS, two translated strings, browser coverage, and this workflow. PR #586 owns Today/Tomorrow/navigation and PR #590 covers Spanish; they were open at the check. Preserve those changes and refresh ownership before touching their files. Shared catalog/CSS changes should remain small and additive. No live session handshake with Claude is implied.

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
