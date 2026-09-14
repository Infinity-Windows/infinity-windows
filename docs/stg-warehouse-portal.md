# STG partner warehouse portal

Status: implemented in an isolated branch; validation recorded below. Not merged, migrated in production, or live. This is an operational portal, not a claim of complete crew-warehouse parity or verified Horizon parity.

## Why the view was missing

Fresh master `d26fe70766efd8aa5e3c037f2e697b7a1da37506` has an STG shell at `/stg`, but only Job progress and Calendar tabs. Its warehouse screens are crew screens, and several functions explicitly refuse partner callers. Opening `/stg` with an ordinary owner account is not a partner preview. The partner invitation is consumed during profile creation: inviting an existing crew profile does not convert it. Missing projection RPCs previously returned empty arrays and looked like a login with no grants.

This branch adds Warehouse to that shell, shows setup failures rather than empty job lists, gives crew accounts a clear explanation at `/stg`, and prevents crew chrome from mounting after a failed identity check. It does not convert accounts, send invitations, or grant live access.

The actual user's login role, invitations, grants, production migration availability, and published frontend were not verified. Supabase CLI read access and management credentials were unavailable. GitHub showed preview deployments for the other draft work; those do not establish production behavior. Browser control failed to start twice. The supplied Horizon project could not be inspected while authenticated; no 1st Lite permission behavior is claimed as verified.

## Permission model

Each active partner keeps its existing per-login job grants. Warehouse action capabilities are separately configured by an active owner through Account → Builder logins → Warehouse actions. Existing logins start with viewing access only. The per-login capability model is the conservative implementation assumption; the user's final selection was not received during this run.

All partner reads use explicit projection fields. Mutations verify the real caller, current job grant, capability, and relevant records server-side. Internal notes, access codes, employees, costs, payroll, labor targets and bonus data are not added to the warehouse payload. Whole-container moves and whole-delivery edits reject mixed-job contents. Package-level actions operate only on the selected job's material.

The private `stg_private` schema is not an API schema and has no client usage or execution grants. It holds copies of the existing warehouse transaction bodies, with source migration provenance, behind a single scoped command gate. Future crew business-rule changes must update the corresponding private implementation too. Legacy public warehouse functions get an early partner refusal so calling them directly cannot bypass that gate.

Storage has restrictive partner policies: existing broad bucket policies no longer allow partners to read arbitrary objects. Only photos attached solely to an authorized package can be signed. Partner uploads are constrained to their own package/actor path; overwrite and delete are blocked. Signed URLs last 60 seconds; an already issued URL can remain valid until expiry after a grant is revoked.

## Warehouse coverage

| Feature | Crew behavior reused / STG behavior | Scope and actor | API / validation |
|---|---|---|---|
| Inventory and search | Status, mark, pieces, serial, short code, container and area; per-job search | Any active granted partner | `stg_warehouse`; foreign job/serial absent in SQL tests |
| Package detail/photos | Select a package to view condition photos, camera/library upload | Reads follow job; uploads require receive or damage | Scoped photo RPCs and restrictive Storage RLS; foreign paths denied |
| Containers/locations | Relevant boxes and current package area; create job boxes and move whole job-owned boxes | `containers`; mixed boxes need office coordination | Real movement body behind gate; foreign container denied |
| Staging | Existing job bay behavior | `move`, scoped packages | Expected state and movement-version checks |
| Receiving/tagging | Receive preissued packages; prepare existing-window labels; bind a physical blank sticker; print/reprint | `receive` / `tag`; current job, existing mark | Permanent binding; foreign/used sticker refused; original label PDF renderer |
| Arrivals | Confirm checked-out packages arrived | `arrival` | Existing arrival ledger logic; project/package validation |
| Movements/checkout/returns | Put away, move, return to relevant container, selected checkout | `move` / `checkout` | Atomic selected batch, retry identity, stale state refusal |
| Deliveries | Read projected manifests, create a delivery from selected material, edit an exclusive job delivery | `deliveries`; mixed manifests filtered and whole edits refused | Server scope and stale-date checks; no crew assignment controls |
| Send to site | Selected packages checked out; unticked material stays | `checkout` | Existing checkout transaction; statuses checked server-side |
| Damage | Condition description opens urgent damage issue and records movement; photos attached to package | `damage` | Granted package IDs, input bounds, idempotent command receipt |
| Supplies | Show supplies appearing on this job's orders; record takes | `supplies`; no global catalog/count edits | Existing idempotent supply take; unrelated supply denied |
| Finalization/history | Refuse on-hand leftovers, finalize/reopen warehouse story, latest 200 movements | `finalize`; job grant required | Database leftovers check; full job status untouched |
| Scanning | Camera, typed serial/short code and scanner input in the search field | Only current job's projected identifiers resolve | Reuses Scanner/QR parser; no crew lookup API |
| Offline | Actor-bound ordinary commands saved before send; unchanged retry ID; failure stays visible | Current grant/capability checked again on replay | Unit and browser reload/retry tests |
| Offline photos | Image bytes persisted in IndexedDB before upload; retry after returning to package | Actor/package-bound path; metadata follows uploaded bytes | Browser reload recovery test |
| Undo | Undo own receive/move/stage/checkout from past 24 hours, if no subsequent state change | `undo`, current grant; finalized jobs must reopen first | Opposite ledger line, current state/version checks; foreign and stale undo denied |

## Explicit limitations and remaining choices

- This does not expose every crew tool. Global/company-stock operations, Boneyard reassignment, global supply counts/catalog administration, deleting/burning material, rewriting unit sets, container Studio models/dimensions, and crew/vehicle scheduling remain outside this implementation. Some would affect records beyond the confirmed STG scope; any requested STG-scoped equivalents need a separate action decision and implementation. Do not describe this as full warehouse parity.
- Warehouse reads are not persisted for access after a cold offline startup. The open page retains its loaded inventory; queued commands survive reloads and send when Warehouse is opened with connectivity. Photos recover when the package is reopened. Camera permission, physical hardware scanners and a thermal printer were not tested on real hardware.
- Undo covers the listed partner package movements, not every existing crew event, container move, supply take or metadata edit. Reopening materials is the explicit reversal for finalization.
- New delivery dates appear in Warehouse. Creating a delivery does not assign crew or publish a new Schedule entry. Changes to an already scheduled exclusive delivery keep its existing dates in step; canceling that schedule stays with the office.
- Disabling or revoking access blocks subsequent API calls; this cannot erase data a user already viewed or downloaded.
- Database tests execute the new functions and policies in disposable PGlite with a minimal domain fixture. They are not a full production-schema replay or proof that production migrations are installed. Existing sandbox/partner-wall checks are static repository tests.

## Integration and deployment order

1. Review the draft and resolve the remaining action scope. Keep production unchanged during review.
2. Recheck current master and migration reservations. This branch reserves `20261010000000_stg_warehouse_portal.sql`, after master through `20261004000000`; it expects the existing partner wall, projections, current package/attachment/supply schema, bays and finalization functions.
3. Coordinate with PR #596 without changing its labor/stage implementation. Shared changes here: two lines in App.tsx for identity errors; three query roots; two additive merge-registry entries and the schema table-count expectation. No `nav.ts` change. Combined table count must include both branches' new tables.
4. PR #595 is open/draft and contains a separate Workflow tab. Keep both Warehouse and Workflow when integrating StgApp. Its proposal-file authorization must be combined with the new restrictive storage policy; deploying both unchanged would deny otherwise shared proposal files. Also merge additions to `person_record_counts` and `purge_project` from other branches instead of overwriting those bodies.
5. After normal migration review/backup and release authorization, deploy the backend migration before the frontend. The frontend intentionally reports missing setup if deployed first. The shared production project remains `czprjcskmzzagdztqonm`; no replacement project is needed.
6. An owner configures the intended real partner login, job grants and capabilities. Verify that actual login on phone and desktop, including an unauthorized direct API attempt, before calling the portal live.

## Validation

Passed locally: 5,378 unit tests; 30 partner/crew Playwright scenarios; 64 isolated database checks; Node 22 build and bundle budget; lint with 25 existing warnings; 11 partner-wall, 41 sandbox, 54 merge-tool and 101 schema checks. Phone/desktop screenshots were inspected. The current commit/PR are recorded in the local handoff alongside the screenshots. Core commands:

```sh
# Node 22, from app/
npm test
npm run lint
npm run build
npm run budget
IW_MAP_PORT=5227 npm run e2e -- stg-warehouse.spec.ts stg-partner-wall.spec.ts warehouse-crew.spec.ts delivery-receive.spec.ts scan-sheet.spec.ts warehouse-send-to-site.spec.ts
# From repo root; local runtime only, never a production connection
PGLITE_MODULE=/tmp/forge-execution-db-check/node_modules/@electric-sql/pglite/dist/index.js node scripts/verify-stg-warehouse.mjs
python3 scripts/test_partner_wall.py
python3 scripts/test_sandbox_guard.py
python3 scripts/test_supabase_merge.py
python3 scripts/test_schema_verify.py
```
