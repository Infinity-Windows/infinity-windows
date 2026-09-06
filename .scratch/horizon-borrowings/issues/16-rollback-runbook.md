# 16 — Rollback runbook and the additive-migration rule

Status: ready-for-agent
Type: task
Size: S

## Horizon does

`docs/rollback.md`: a named tag and branch for the last known-good snapshot,
the exact commands to revert (revert preferred over reset), how to verify the
live site is on the restored commit, and the rule that migrations after the
snapshot are additive so rolling back code never needs rolling back the
database.

## Forge today

`scripts/checkpoint.sh` makes a verified bundle after every merge; master is
protected; `docs/consolidation-runbooks.md` covers the database merge. There
is no written "the last deploy broke, do this" path, and 9 migrations drop
tables or columns.

## Build

1. `docs/rollback.md`: revert-a-PR path (`git revert` → PR → auto-merge →
   Pages + backend redeploy → `verify-functions.sh`), the checkpoint-restore
   path for the worst day, and how to confirm what is live (the build identity
   card / `buildIdentity.ts`).
2. The additive rule: a migration may add; a drop needs a preceding release
   that stopped reading the column and a note in the migration header. Add a
   `migration_lint.py` rule that flags `DROP TABLE`/`DROP COLUMN` without the
   header marker, with a test.
3. Link from `CLAUDE.md` Commands section.

## Done when

- A reviewer can follow the doc cold. A migration with a bare `DROP COLUMN`
  fails the lint test.
