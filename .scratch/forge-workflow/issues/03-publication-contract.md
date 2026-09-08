# Verify linked-publication contract

Status: inspected; database hardening and behavioral verification required
Blocked by: Isolated database test setup for policy and publication mutations

## Scope

Inspect deployed tables/RLS/functions, migration history and current branches. Confirm ordinary crew cannot mutate schedules directly. Specify explicit assignment-trip links supporting rotations, distinct work/travel dates, revision rules, notification retry and reconciliation of old records. Reserve a collision-free migration after refreshing master.

## Acceptance

Read-only evidence and a concrete schema/RPC contract are recorded; ambiguity is explicit; no old trip associations guessed; no production records modified for verification.

## Comments

Created from the owner-requested busybusy review and iPhone web requirement.

## Read-only findings

See `docs/forge-publication-contract.md`. Existing schema access works. Current Schedule policies do not enforce the supervisor-only write boundary; trip draft and passenger privacy are partly client-side. Durable assignment/trip links and atomic revision publication are absent. Vehicle schedule links already exist and must be reused. No production data writes or migration deployment performed. Allocate a migration only after refreshing master/history at implementation time.
