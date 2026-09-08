# Publish one connected plan

Status: ready-for-agent
Blocked by: Permission migration 03 must be reviewed and applied before production rollout

## Scope

Implement the verified contract using existing Schedule, Travel and vehicle records. Commit selected-plan changes atomically with idempotent retries, version checks, cancellation/history and separate notification delivery state. Refresh all affected cached views.

## Acceptance

The publication verification matrix in spec.md passes against sandbox records; both entry points publish exactly one linked plan; no partial server or local-only state claims success.

## Comments

Created from the owner-requested busybusy review and iPhone web requirement.

## Prerequisite update

The database permission contract and isolated execution harness are implemented in draft under 03. Build linked publication on that contract; do not treat the frontend publication buttons or local fallback as an atomic server acknowledgment.
