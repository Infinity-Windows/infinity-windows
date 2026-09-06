# 04 — Migration drift checked nightly and on the PR

Status: ready-for-agent
Type: task
Size: S

## Horizon does

`.github/workflows/migration-drift.yml`: runs on the pull request that adds a
migration (detect only), on the push that lands it (detect and apply), and
nightly at 08:10 UTC ahead of the backup (detect only, never applies on a
schedule). The header explains each trigger with the incident that earned it.

## Forge today

`scripts/migration_drift.py`, `scripts/schema_verify.py`,
`scripts/cleanup-migration-phantoms.sh` exist and are tested. They run only
inside `deploy-backend.yml`, i.e. only on the days a backend change merges.
Between deploys nobody looks, and migrations do get applied outside the repo.

## Build

1. `migration-drift.yml`: `pull_request` with a path filter on
   `supabase/migrations/**` and the two scripts; `schedule` daily (pick 08:05
   UTC so it precedes ticket 01's backup); `workflow_dispatch`. Detect only in
   all three — applying stays in `deploy-backend.yml`.
2. Output: the list of migrations merged-but-unapplied and applied-but-unmerged,
   in the step summary, in plain English.
3. Failure goes to Slack through `notify-failure.yml` on the scheduled run;
   on a PR the red check is enough.
4. Header comment in the workflow saying why each trigger exists, in the
   repo's style.

## Done when

- A PR that adds a migration shows the drift job on the PR.
- The nightly run is green on a quiet night and red when a migration is
  applied by hand and not committed (prove with the existing script tests,
  not on production).
