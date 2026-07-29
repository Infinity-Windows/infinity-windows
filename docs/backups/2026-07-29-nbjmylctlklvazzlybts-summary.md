# Backup summary — `nbjmylctlklvazzlybts` ("isaacammonbarlow-max's Project")

- **Backup file:** `docs/backups/2026-07-29-nbjmylctlklvazzlybts-full.json` (3,903 bytes)
- **Captured:** 2026-07-29T19:13Z, read-only, via the Supabase Management API
- **Project:** org `gdkmcyypdsmxmsdtdcgh`, region `ca-central-1`, created 2026-07-18,
  Postgres 17.6.1.147, status `ACTIVE_HEALTHY`

## The short version

**This project is empty.** It is a Supabase project that was created and then never
used. There is nothing in it to lose.

## Totals

| | |
| --- | --- |
| Tables in `public` | **0** |
| Views | 0 |
| Total rows | **0** |
| Auth users | **0** |
| Storage buckets | 0 |
| Storage objects | 0 (0 bytes) |
| Object bytes preserved? | Not applicable — no objects exist |
| Edge functions deployed | 0 |
| Secrets set | 0 |
| Migrations applied | **0** |

The `public` schema exists but contains no tables, no views, and no functions. The only
things present are what Supabase provisions for every new project: the `auth`,
`storage`, `realtime`, `graphql`, `vault` and `extensions` schemas, and five default
extensions (`pg_stat_statements`, `pgcrypto`, `plpgsql`, `supabase_vault`, `uuid-ossp`).

## Field work

None — there are no tables at all, so `install_events`, `issues`, `qc_checks`,
`job_costs`, `job_notes`, `attachments`, `time_shifts` and `project_openings` do not
exist in this database, let alone hold rows.

## Auth

No users, no identities, no password hashes.

## Storage

No buckets and no objects, so there is nothing to download and nothing at risk.

## Migrations vs. this repo

There is no `supabase_migrations.schema_migrations` table, so **0 of the repo's 70
migration files have ever been applied here.** This confirms the app was never deployed
against this project.

## Verification

Re-checked against the live database by `scripts/verify_backup.py`:

- JSON parses.
- Live catalog re-listed: 0 relations in the one user schema (`public`). Nothing in the
  live catalog is missing from the backup and nothing extra is in the backup.
- 0 rows, 0 mismatches.
- Auth user count (0) and storage object count and bytes (0, 0) re-queried and matched.
- Zero capture failures.

## What this means for the merge

Any plan to merge Ammon's two databases is really a plan involving one database. This
one holds nothing, so it can be set aside without any data loss. Confirm with Ammon
before deleting it, in case he created it for a reason that has not started yet.
