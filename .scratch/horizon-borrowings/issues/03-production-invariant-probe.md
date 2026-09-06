# 03 — Production invariant probe on every PR

Status: ready-for-agent
Type: task
Size: S

## Horizon does

`db-assertions` job in `test.yml` + `scripts/check-db-assertions.mjs` +
`src/server/dbAssertions.server.ts`: on every PR and push, asks the LIVE
database whether a partner account still cannot read hidden jobs, crew chat,
documents, BOM data or gate codes, and whether every project still carries the
canonical phase list. A missing secret FAILS the job ("no invariant was
checked must not render as a green tick"), except on forks.

## Forge today

`scripts/test_partner_wall.py` and `scripts/test_sandbox_guard.py` replay the
MIGRATION FILES in CI. They prove the files are right; they cannot see a policy
edited by hand in the dashboard, and the July migration-history repairs show
that happens. `scripts/pgq.sh` runs one statement and refuses anything that is
not a SELECT. `scripts/schema_verify.py` compares declared objects to a
snapshot.

## Build

1. `scripts/verify-invariants.sh` (or `.py` using `mgmt_query.py`), a list of
   SELECTs each paired with the expected answer, run through the read-only
   path. Start with the invariants the repo already cares about:
   - STG partner grants: the partner role sees only rows in
     `partner_job_grants`, nothing from `profiles`, chat, receipts, financials.
   - Sandbox fence: every project-scoped table has the guard trigger
     (`sandbox_guard_census.sql` is the census; turn it into an assertion).
   - Every active job has two active staging bays (move the check out of
     `verify-warehouse.yml` or call it from here).
   - `profiles.pin_hash` is not readable by any client role.
2. A job in `ci.yml` on `pull_request` and push; missing secret = red unless
   the PR is from a fork.
3. A test for the script (stubbed query runner, offline), and its line in
   `ci.yml` so `ci-runs-script-tests.test.mjs` sees it.

## Done when

- Temporarily granting `authenticated` a select on a fenced table in a scratch
  project (or in the stubbed test) turns the job red with a message that names
  the table.
- The job is green on master and reads nothing but SELECTs (confirm with the
  pgq refusal in the test).
