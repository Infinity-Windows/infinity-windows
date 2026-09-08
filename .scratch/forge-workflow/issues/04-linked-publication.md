# Publish one connected plan

Status: needs-triage
Blocked by: 03

## Scope

Implement the verified contract using existing Schedule, Travel and vehicle records. Commit selected-plan changes atomically with idempotent retries, version checks, cancellation/history and separate notification delivery state. Refresh all affected cached views.

## Acceptance

The publication verification matrix in spec.md passes against sandbox records; both entry points publish exactly one linked plan; no partial server or local-only state claims success.

## Comments

Created from the owner-requested busybusy review and iPhone web requirement.
