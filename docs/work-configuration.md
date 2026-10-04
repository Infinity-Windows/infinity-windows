# Versioned activity and menu configuration

This slice adds configuration APIs over the private dormant capture foundation.
It adds no activity timer, payroll write, dispatch loop, unit writer or final-QC
operation. The existing Work and Classic routes continue to own operational work.

## Authority and identity

Every mutating RPC obtains real auth.uid(), acquires configuration gate7710,
then reads current authority and validates inputs. Company publication and
retirement require an active internal owner. Active internal supervisors may
propose drafts, and owners may read their complete proposal bodies before
publishing. QA/test accounts cannot alter the global company catalog or drafts;
they may use an already published menu only within their permitted sandbox.
Retired, revoked and partner accounts receive no configuration authority.

Job menu selection requires current job visibility plus owner/supervisor authority,
or an explicit active menu_select grant for that exact foreman/job. A grant target
must independently be an active internal foreman permitted to see the job.
A dimensions_edit or final_qc grant does not imply menu_select. The future final-QC
consumer must preserve the owner's allowed foreman self-final-QC workflow.

Raw tables use RLS without public/anonymous/authenticated grants. Private helpers
have no direct authenticated execute privilege. Public APIs use a pinned search
path and caller-bound authorization. The three new configuration tables have no
project_id/opening_id; existing job selections/grants retain their real sandbox
triggers and original project identifiers.

## Immutable commands, drafts and versions

Each mutation requires a nonnull command UUID. An exact retry returns the stored
result only for the same actor, action, canonical hash AND complete normalized
JSON payload. Another actor receives no receipt. Changed input receives a
conflict. Caller intent, including the immediate-time null marker, is hashed;
server-derived timestamps are resolved only once and returned from the receipt.

Draft proposals are append-only revisions with an explicit expected revision.
Published changes create a new immutable version under the same stable code/ID.
NULL, negative and out-of-range expected revisions are refused. Retirement
requires the expected latest version. A retired definition/menu cannot be
republished through this API; restoring one needs a separate future audited
contract. Revocation requires the immutable expected grant ID, protecting a
replacement grant from a delayed request. None of these operations delete old
versions, selections or grant evidence.

## Effective dates and frozen menus

Publication captures clock_timestamp() after the governing lock wait. A null
p_effective_from means immediate publication. An explicit effective timestamp
must be finite and no earlier than publication. PublishedAt and effectiveFrom
are stored and returned separately; retries preserve both original instants.
Older foundation versions without the additive effective_from field use their
known published_at as immediate effect without rewriting historical records.

A job may select only a currently effective, unretired menu, and every enabled
activity in it must also be currently effective and unretired. A selection pins
the exact immutable menu/activity version IDs. Crew snapshots retain the frozen
enabled setting and expose eligibleNow separately, so a later retirement is
visible without rewriting the original menu. Active capture remains a future
consumer and must recheck canonical versions and current authority on the server.

## Typed fields and snapshots

Field definitions reject unknown keys, missing/null required attributes,
duplicate IDs, invalid field types/options, reversed bounds and fractional bounds
for a number whose explicit unit is count. Count bounds must be nonnegative safe integers; all numeric bounds must fit finite JavaScript numbers. Captured count values are not handled
in this configuration slice; their integer requirement belongs in the future
capture validator. Supported types are text, number, boolean, single_select and
multi_select. Only number fields carry units/min/max. Units are the stable codes
count, in, ft, mm, cm, sq_ft, sq_m, min, h, lb and kg. Labels and option labels require English and Spanish strings.

Every snapshot includes its asOf instant and exact requested projectId. Company snapshots always include currentSelection, explicitly null for a global read or unselected job. Company snapshots include complete current draft bodies, proposer and creation
instant, immutable published versions and publication/effective dates. A supplied
job is validated before any snapshot is returned. Ordinary crew and QA accounts
receive only a visible job's frozen menu; no company drafts or raw receipt ledger.
Catalog and response size limits fail explicitly instead of returning a successful
silently incomplete snapshot. Grant lists fail explicitly above200 entries and remain owner/supervisor only;
pagination for larger grant history remains a future UI/API extension.

The dormant client validates every response and binds reads to the requested job.
Writes preserve the caller's command UUID, copy inputs before waiting, and bind
the checked account token and sign-in generation. Publication receipts must
match the requested effective instant at PostgreSQL microsecond precision;
equivalent time-zone formats are accepted. Explicit input beyond six fractional
digits is refused rather than silently rounded. No screen imports this client.
The English/Spanish owner and supervisor note describes the forthcoming screens.

## Validation and limits

The actual SQL migration and real dependency helper bodies run in disposable
PGlite fixtures, with synthetic identities/jobs only. Tests cover authorization,
QA boundaries, NULL inputs, immutable identity/history, expected revisions,
publication times, stale grants, complete draft reads and raw table denial.
The original source-only author did not execute tests; the parent executes and
retains test logs. The initial57 checks passed after correcting fixture reads of
append-only revisions and decoded JSON. The expanded128 regression checks pass under Node22/PGlite, including
actual authenticated-role denials. The parent merge-tool suite also passes63
checks and protects all three private configuration tables from generic merges.

PGlite is one backend and does not prove advisory-lock contention. Independent
PostgreSQL backend races, candidate-bound actual-schema forced rollback, full CI,
installed-app compatibility and protected release remain required before shipping.
No production operational or payroll records are created for verification.
