# STG warehouse portal

Status: operational draft implemented; see docs/stg-warehouse-portal.md for validation and remaining parity gaps

## Confirmed scope

Only each STG login's explicitly granted jobs and their inventory. Keep the independent partner shell. Warehouse operational actions are in scope; read-only inventory is not completion. No production changes or deployment. Draft PR handoff required.

## Coordination

Fresh origin/master: d26fe70766efd8aa5e3c037f2e697b7a1da37506 (2026-09-14).
Own checkout: stg-warehouse-portal, branch codex/stg-warehouse-portal.
PR 596 remains open, owns labor/stages and migration 20261009000000.
PR 595 remains open/draft, owns proposal Workflow and migration 20261008000000.
Minimal planned shared diff: register partner warehouse query roots in queryKeys.ts; no labor/stage roots changed. App.tsx may need a partner identity error state before crew chrome mounts. No crew navigation changes required for the partner Warehouse tab. StgApp.tsx must retain both Warehouse and PR 595's Workflow at eventual integration; do not merge that branch wholesale.
Candidate migration reservation: 20261010000000_stg_warehouse_portal.sql, pending final branch collision check.

## Current evidence and access limits

Master's StgApp has progress/calendar only. stg.ts silently turns missing RPCs into empty data. Owner sessions cannot serve as partner previews. Builder invitations only classify a profile on first creation, so adding an invite for an existing profile does not convert its login. Live login/grants, published build and migration availability are not yet verified. No production credentials are set in this task's environment.

Horizon URL is recorded in the user's request. Browser control failed to start twice in this session; authenticated 1st Lite behavior remains unverified. Screenshots of internal stages cannot establish partner permission parity.

Warehouse read RLS does not itself protect SECURITY DEFINER writes. Source versions of checkout_packages and receive_minted_packages check auth.uid() but not partner job grants. Verify direct legacy RPC rejection in disposable database tests, not by relying on hidden controls.

## Permission decision

Asked user whether owner should enable individual capabilities per login (recommended, default read-only), or all STG logins should get every scoped operation. No live grants will be changed by implementation. Partner payloads exclude private notes, employee/financial data and ungranted contents of mixed containers/deliveries.

## Audit checklist

| Feature | Current crew behavior | Intended STG boundary | Validation needed |
|---|---|---|---|
| Inventory/search | Broad active packages and jobs | Explicit safe fields on granted jobs only | Ungranted job/serial absent |
| Package detail/photos | Package metadata and signed media | Job-bound projection and scoped file authorization | Cross-job paths denied |
| Locations/containers | Global containers, nesting, areas | Only relevant containers; mixed contents filtered; whole-box moves require every affected job | Mixed/nested boxes |
| Staging | job_bay_box + stage_packages | Granted job bay only | Foreign target and stale state |
| Receiving/tagging | Blank/prebound labels, mark pieces, delivery sets | Explicit granted destination; no unowned inventory lookup | Serial binding and duplicates |
| Arrivals | Confirm checkout arrival; damage creates issue | Granted package/job; safe evidence | Cross-job package arrays |
| Movement/checkout/return | store/checkout plus ledger | Scoped package IDs and destinations | Atomicity, retry, stale state |
| Deliveries | May carry multiple jobs | Project only shared packages; mutation of whole delivery requires full scope | Mixed delivery leakage |
| Send to site | Selected job packages checked out | Selected granted material only | Exclusions and missing pieces |
| Damage | Issue, urgent report, photos | Granted package, safe partner report | Direct API and file checks |
| Supplies | Shared company catalog/counts/takes | Job-related allocation/order; no global stock adjustment | Foreign supply/order |
| Finalization/history | Refuse leftovers; close/reopen warehouse story | Separate capability; job grants persist | Leftovers, concurrent receive |
| Scanning | Camera and hardware wedge | Resolve only authorized serials | Foreign scans indistinguishable from absent |
| Offline | Durable queue, expected state and idempotency | Recheck grants/capability on replay; never show unsent as confirmed | Revocation and lost response |
| Undo | Opposite ledger line, actor/day or foreman | Scoped operation and current-state checks | Cross-job undo and later movement |

## Acceptance

Phone/desktop partner fixtures, crew regression tests, Node 22 unit/lint/build checks, isolated SQL permission tests, screenshot inspection and documented migration order. Report implemented/tested/merged/live separately. Do not claim full warehouse parity while any action remains unimplemented or unverified.

## Additional shared registry integration

The schema census requires two additive entries in scripts/supabase_merge_lib.py: partner_warehouse_permissions keyed by partner_profile_id and partner_warehouse_commands append-only (None). scripts/test_supabase_merge.py expects master table count +2 (143 on this branch). PR 596 adds two different tables; when combined the count must include both sets (145 before any other merges). These edits do not change its labor/stage entries. The new migration preserves master purge_project/person_record_counts and adds warehouse commands; integrate any other branch additions to those function bodies before applying both migrations.

The restrictive partner storage read policy must be combined with PR 595's explicit proposal-file authorization when that separate feature is integrated. Do not deploy both unchanged: a restrictive policy can also deny an otherwise granted proposal read.
