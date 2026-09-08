# Publish one connected plan

Status: implemented-in-draft; rollout and full detail authoring remain gated
Blocked by: Permission migration 03 must be reviewed and applied before production rollout

## Scope

Implement the verified contract using existing Schedule, Travel and vehicle records. Commit selected-plan changes atomically with idempotent retries, version checks, cancellation/history and separate notification delivery state. Refresh all affected cached views.

## Acceptance

The publication verification matrix in spec.md passes against sandbox records; both entry points publish exactly one linked plan; no partial server or local-only state claims success.

## Comments

Created from the owner-requested busybusy review and iPhone web requirement.

## Prerequisite update

The database permission contract and isolated execution harness are implemented in draft under 03. Build linked publication on that contract; do not treat the frontend publication buttons or local fallback as an atomic server acknowledgment.

## Implementation update — September 8

Explicit selected-plan links, parent/crew working drafts, atomic publication and cancellation, immutable history, idempotent retries, conflict review, an outbox with leased delivery, shared Schedule/Travel review, and multi-trip My Schedule navigation are implemented in draft PR #591. The database harness tests rollback, concurrency, RLS, queue retry and account-history integration. See `docs/forge-publication-contract.md` for evidence and limits.

This first version freezes detailed travel rows/files and vehicle identity after connection. It does not claim all of the broader detail-editing acceptance matrix or live Supabase/Storage/push validation is complete. No migration, function deployment, production business write or notice delivery has occurred.
