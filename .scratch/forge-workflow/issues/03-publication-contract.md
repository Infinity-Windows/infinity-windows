# Verify linked-publication contract

Status: implemented in draft; deployment review pending
Blocked by: No implementation blocker; production deployment remains unapproved

## Scope

Inspect deployed tables/RLS/functions, migration history and current branches. Confirm ordinary crew cannot mutate schedules directly. Specify explicit assignment-trip links supporting rotations, distinct work/travel dates, revision rules, notification retry and reconciliation of old records. Reserve a collision-free migration after refreshing master.

## Acceptance

Read-only evidence and a concrete schema/RPC contract are recorded; ambiguity is explicit; no old trip associations guessed; no production records modified for verification.

## Comments

Created from the owner-requested busybusy review and iPhone web requirement.

## Read-only findings

See `docs/forge-publication-contract.md`. Existing schema access works. Current Schedule policies do not enforce the supervisor-only write boundary; trip draft and passenger privacy are partly client-side. Durable assignment/trip links and atomic revision publication are absent. Vehicle schedule links already exist and must be reused. No production data writes or migration deployment performed. Allocate a migration only after refreshing master/history at implementation time.

## Implementation and verification

Draft migration 20261003000000 enforces the verified permission/privacy prerequisites. Disposable Docker PostgreSQL tests now execute the actual RLS and delivery function as crew, foreman, managers, partner, anonymous and service roles, without production records. Frontend mutation buttons match those boundaries. See the publication contract and the test harness README for coverage and signed-URL limits. Shared publication itself is ticket 04 and is not implemented here.
