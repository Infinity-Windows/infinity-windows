# The migration history repair, as actually executed (2026-07-29)

`docs/db-push-readiness.md` described this repair. This is the record of it
being **run against production for the first time**, what it changed, and the
evidence that it changed nothing else.

Project: **`czprjcskmzzagdztqonm`** — "Infinity Windows 1nfintyWindows", in
*taylorhorizon's Org*. Confirmed by listing the organisations the management
token can see; the two `isaacammonbarlow-max` projects are in a different
organisation, which is why a dashboard link to this project returns "you don't
have access" for Ammon.

## What was actually wrong

Two separate faults, and the second was the serious one.

### 1. The edge-function job was red for a real, nameable reason

`ANTHROPIC_API_KEY` had been added as a **GitHub** repo secret at 20:34 UTC but
never as a **Supabase** edge-function secret, and those are different places.
`scripts/verify-function-secrets.sh` reads Supabase, correctly found it absent,
and failed the run:

```
Ask Infinity and plan-set reading need an API key that has not been added yet
  MISSING  ANTHROPIC_API_KEY        (ask,extract-specs)
```

That is the failure `docs/always-live.md` predicted under "The first real run
will be red, on purpose". It was accurate and working as designed.

### 2. The migrations job was GREEN and had never pushed anything

This is the one that mattered, and it was invisible because it was green.

```
Push migrations   Check for credentials   DB_PASSWORD:
##[warning]SUPABASE_ACCESS_TOKEN and/or SUPABASE_DB_PASSWORD are not set,
          so migrations were not pushed.
```

`SUPABASE_DB_PASSWORD` did not exist, so the guard took the skip branch —
which warned and **exited 0**. Every merge on 2026-07-29 reported "Push
migrations: success" having applied nothing at all. `supabase db push` was
never once invoked against production, so the phantom rows everything was
worried about had never actually blocked a real push; they were blocking a
push that was never attempted.

A green tick that means "we did nothing" is worse than a red one, because it is
believed. That guard now fails.

## The state found, and the two things that had to be fixed first

```
78 migration files on disk (76 distinct versions)
114 rows in schema_migrations
38 phantom rows — an applied row matching no file
0 migration files with no applied row
2 version(s) claimed by more than one file
```

`scripts/cleanup-migration-phantoms.sh` refused, correctly, on the last line.

### Two files claimed the same version as another file

| version | files |
| --- | --- |
| `20260729200000` | `..._ask_question_log.sql`, `..._profiles_rls_lockdown.sql` |
| `20260729210000` | `..._ai_spend_limits.sql`, `..._revoke_truncate_from_clients.sql` |

The history table is keyed by version, so only one of each pair could ever be
recorded — and only one was: `profiles_rls_lockdown` and
`revoke_truncate_from_clients`. The other two were applied to production but
recorded under some other version or not at all. Left alone this is a silent
data-loss trap: `db push` would consider both versions already applied and skip
the two unrecorded files forever.

Resolved without running any SQL from either file:

* **`ai_spend_limits`** — history already held a phantom row
  `20260729230000 / ai_spend_limits` (the MCP tool's own timestamp). The file
  was renamed `20260729230000_ai_spend_limits.sql`, so it now matches the row
  that records it. One rename removed a duplicate *and* a phantom. **The file's
  contents were not touched.**
* **`ask_question_log`** — no history row existed under any version. Every
  object it declares was verified present in the live catalog first (the table,
  all 11 columns, both named indexes plus the primary key, `can_read_ask_log`,
  all three policies, and RLS enabled), so it is genuinely applied. The file was
  renamed `20260729240000_ask_question_log.sql` and that version was recorded as
  applied — the equivalent of `supabase migration repair --status applied`, done
  in a transaction that also asserted the `profiles_rls_lockdown` row was
  undisturbed. **No SQL from the file was re-run**, so nothing about `profiles`,
  its RLS, or the PIN hashing was touched.

After that: 78 files, 78 distinct versions, 115 rows, **37 phantoms**, 0
missing, 0 duplicates — the state `db-push-readiness.md` was written for.

## The deletion

`scripts/cleanup-migration-phantoms.sh --execute`, which deletes by an explicit
list of the versions it just printed, inside a transaction whose guard rolls the
whole thing back unless the table ends up at exactly one row per file:

```
==> deleting 37 phantom rows
    delete committed
==> verifying
    78 rows, one per migration file, nothing missing
```

## Proof that nothing else changed

`scripts/content-digest.sh` (added in this PR) fingerprints every table's row
count and an md5 over its full contents, every catalog object as a counted and
hashed name list, and the auth roster — read from `pg_class`,
`information_schema` and `pg_policies`, **never from the migration log**, since
the migration log is the thing under repair.

Taken immediately before the first write and again after the deletion, the
complete difference is:

```diff
77c77
<   rel=supabase_migrations.schema_migrations  n_rows=114  digest=d8aa8e7d12e3c5e0744abf0f24158565
---
>   rel=supabase_migrations.schema_migrations  n_rows=78   digest=d91ade7271f1584558bf6ece3bc9e113
```

**One line. The bookkeeping table.** Everything else is byte-identical:

| | before | after |
| --- | --- | --- |
| `locations` | 44 rows, `0255d489…` | 44 rows, `0255d489…` |
| `profiles` | 6 rows, `06624c2f…` | 6 rows, `06624c2f…` |
| `projects` | 3 rows, `27a381d0…` | 3 rows, `27a381d0…` |
| `project_openings` | 151 rows, `7969dcf4…` | 151 rows, `7969dcf4…` |
| auth roster | 6 users, `618e1d15…` | 6 users, `618e1d15…` |
| relations | 428, `822dc443…` | 428, `822dc443…` |
| functions | 308, `c557abe3…` | 308, `c557abe3…` |
| policies | 105, `4deea373…` | 105, `4deea373…` |
| triggers | 19, `d6a9bb4a…` | 19, `d6a9bb4a…` |
| constraints | 417, `204c8686…` | 417, `204c8686…` |
| enum labels | 46, `6d93db9c…` | 46, `6d93db9c…` |

The unchanged policy and trigger digests are what prove the `profiles` RLS
lockdown, the PIN hashing functions, the AI spend tables and the staging-bay
trigger all survived untouched — they are name-lists over `pg_policies` and
`pg_trigger`, so losing any one of them would move the hash.

## Backup, and how to roll back

Taken before any write, with `scripts/backup_project.py`:

```
docs/backups/2026-07-29T2046Z-czprjcskmzzagdztqonm-full.json
  548 rows from 23/73 tables, 6 auth users, 9 storage objects
```

Re-verified against the live database with `scripts/verify_backup.py`:

```
OK   catalog matches: 76 relations in 1 user schema(s)
OK   row counts re-verified against the live database: 73 tables, 548 rows, 0 mismatches
OK   auth users match: 6
OK   storage matches: 9 objects, 23632980 bytes
OK   schema DDL present: 766 columns, 291 constraints, 178 indexes, 101 RLS
     policies, 206 functions, 14 triggers, 3 views, 12 enums, 6 extensions
```

The 9 storage objects (23.6 MB of plansets and toolbox PDFs) were downloaded and
sha256'd separately with `scripts/backup_storage_objects.py`. They are **not**
committed — they are unchanged by anything here, and re-committing 23 MB of
binaries on every repair would bloat the repo for no gain.

**Rolling back this repair does not need the backup at all.** Only 37 rows of
`supabase_migrations.schema_migrations` were deleted and one inserted; the
deleted versions are listed verbatim in the run output and in the preview above.
Re-inserting them restores the previous history exactly. Nothing in the database
depends on those rows — they are read only by the Supabase CLI. The backup is
insurance against something unrelated going wrong at the same time, not the
rollback path.

## What is still true and needs saying

* **`20260729220000_staging_bays_guaranteed.sql`** is on master and has a
  matching history row, so it is no longer a phantom. Untouched here.
* The 26 phantoms named after real files (`20260729175600 /
  20260718050000_time_timecard` and friends) were created by the Supabase MCP
  `apply_migration` tool, which stamps its own wall-clock time as the version
  instead of the file's. **A 38th appeared during this very repair**
  (`20260729230000 ai_spend_limits`). The habit described under "Keeping it
  clean" in `db-push-readiness.md` is still slipping, and the workflow going
  live is what stops it: land schema changes as a migration file in a PR.
* **The Management API's `POST /v1/projects/{ref}/database/migrations` endpoint
  is the phantom generator.** It takes a `query` and a `name` but no `version`,
  so it invents one. Do not reach for it as a substitute for `db push`.
