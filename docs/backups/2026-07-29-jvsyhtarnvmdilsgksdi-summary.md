# Backup summary — `jvsyhtarnvmdilsgksdi` ("isaacammonbarlow-max's Project 2")

- **Backup file:** `docs/backups/2026-07-29-jvsyhtarnvmdilsgksdi-full.json` (1,053,091 bytes)
- **Storage files:** `docs/backups/jvsyhtarnvmdilsgksdi-storage/` (5 PDFs, 16,236,355 bytes)
- **Captured:** 2026-07-29T19:12:27Z, read-only, via the Supabase Management API
- **Project:** org `gdkmcyypdsmxmsdtdcgh`, region `us-east-1`, created 2026-07-18, Postgres 17.6.1.147

## The short version

This database has the app's **full schema and a real amount of planning data, but no
completed field work at all.** Three jobs are set up, five plan sets are uploaded, and
147 openings have been laid out on those plans — but not one opening has been
confirmed installed, no window has been assigned to an opening, and every table that
records work actually happening in the field is empty.

## Totals

| | |
| --- | --- |
| Tables in `public` | 66 (plus 2 views) |
| Non-empty tables | 21 |
| Total rows captured | **430** |
| Auth users | 1 (`isaacammonbarlow@gmail.com`) |
| Storage buckets | 4, all private |
| Storage objects | 5, 16,236,355 bytes (15.5 MiB) |
| Object bytes preserved? | **Yes** — all 5 downloaded, sha256 recorded per file |
| Edge functions deployed | 5 |
| Migrations applied | 70 |

## Field work vs. setup data

This is the distinction that decides which database the company keeps.

**Field work recorded: none.**

| Table | Rows |
| --- | --- |
| `install_events` | 0 |
| `issues` | 0 |
| `qc_checks` | 0 |
| `job_costs` | 0 |
| `job_notes` | 0 |
| `attachments` | 0 |
| `time_shifts` | 0 |
| `windows` (physical window units) | 0 |
| `movements` | 0 |
| `task_sessions` | 0 |
| `incidents` | 0 |
| `toolbox_completions` | 0 |
| `safety_acks` | 0 |

There is no table named `project_marks` in this database. The nearest things are
`project_mark_specs` (61) and `project_mark_elevation_views` (54), which are the
output of reading specs off an uploaded plan set — plan interpretation, not field work.

**Openings past "planned": zero of 147.**

| Opening state | Count |
| --- | --- |
| Openings total | 147 |
| `confirmed = true` | 0 |
| Window assigned (`assigned_window_id`) | 0 |
| Condition checked | 0 |
| Flagged | 0 |
| Assigned to an installer (`assigned_to`) | 6 |

The only forward movement is 6 openings assigned to a person, which is scheduling
intent rather than work performed.

**Planning and plan-extraction data (real, and worth keeping):**

| Table | Rows | What it is |
| --- | --- | --- |
| `project_openings` | 147 | Openings pinned onto plan pages |
| `project_mark_specs` | 61 | Specs read off the plans |
| `project_mark_elevation_views` | 54 | Elevation views tied to those marks |
| `project_planset_pages` | 14 | Rendered plan pages |
| `project_plansets` | 5 | Uploaded plan sets |
| `projects` | 3 | `OAKRIDGE`, `SMITH`, `BLACK22` (Black Desert) |
| `project_windows` | 2 | Window quantities per job |
| `schedule_events` | 12 | Calendar entries |
| `schedule_assignments` / `schedule_assignment_members` | 1 / 1 | One crew assignment |
| `trips` / `trip_crew` | 1 / 1 | One travel record |

**Setup / reference data (recreatable from seed migrations):**

| Table | Rows |
| --- | --- |
| `window_types` | 54 |
| `locations` | 44 |
| `tools` | 8 |
| `safety_talks` | 7 |
| `cost_codes` | 6 |
| `supplies` | 6 |
| `procedures` | 1 |
| `profiles` | 1 (Ammon, role `owner`) |
| `vault_config` | 1 |

**Empty (45 tables):** `access_requests`, `attachments`, `change_orders`,
`cycle_counts`, `flights`, `ground_transport`, `incidents`, `install_events`,
`installer_clearance`, `issues`, `job_costs`, `job_notes`, `knowledge_chunks`,
`knowledge_docs`, `learn_priority_terms`, `learn_progress`, `lodging`, `movements`,
`points_ledger`, `project_message_reads`, `project_messages`,
`project_plan_outlines`, `project_spec_discrepancies`, `push_subscriptions`,
`qc_checks`, `safety_acks`, `service_cases`, `supply_orders`, `task_sessions`,
`time_shifts`, `toolbox_completions`, `trip_attachments`, `trip_contacts`,
`vehicle_devices`, `vehicle_drive_sessions`, `vehicle_drivers`, `vehicle_financials`,
`vehicle_locations_history`, `vehicle_locations_latest`,
`vehicle_project_assignments`, `vehicle_service_records`,
`vehicle_service_schedules`, `vehicles`, `window_id_counters`, `windows`.

## Auth

One user: `isaacammonbarlow@gmail.com`, created 2026-07-19T00:23:54Z, email confirmed
2026-07-19T00:24:15Z, last sign-in 2026-07-19T00:24:20Z, with one `email` provider
identity. That user has a password hash set; **the hash value was deliberately not
captured.** Restoring from this backup means Ammon sets a password again or signs in
through his provider.

## Storage

| Bucket | Public? | Objects | Bytes |
| --- | --- | --- | --- |
| `plansets` | private | 5 | 16,236,355 |
| `install-media` | private | 0 | 0 |
| `toolbox-records` | private | 0 | 0 |
| `trip-attachments` | private | 0 | 0 |

All five objects are plan set PDFs, and **all five were downloaded byte-for-byte** into
`docs/backups/jvsyhtarnvmdilsgksdi-storage/`, with a sha256 stored alongside each entry
in the backup JSON:

| File | Bytes |
| --- | --- |
| `plansets/ebf64f94…/1785247643865-Black_Desert_Windows_Pictures.pdf` | 3,837,032 |
| `plansets/98444d24…/1784439420431-PVTH_Bldg_14_Marked.pdf` | 3,688,683 |
| `plansets/ebf64f94…/1785253853208-Black_Desert_Windows_Plans.pdf` | 3,249,106 |
| `plansets/ebf64f94…/1785256963527-Black_Desert_Windows_Plans.pdf` | 3,249,106 |
| `plansets/98444d24…/1784439732173-PV_Townhomes_Bldg_14_Cads_2024-12-22_1_.pdf` | 2,212,428 |

The two `Black_Desert_Windows_Plans.pdf` entries are the same size and are almost
certainly the same document uploaded twice; both are kept.

No install photos exist — `install-media` is empty — so nothing irreplaceable from the
field is at risk here.

## Edge functions and secrets

Deployed and `ACTIVE`: `send-push` (v2), `ask` (v7), `ingest-knowledge` (v3),
`vault-config` (v2), `extract-specs` (v5). All five slugs also exist in this repo under
`supabase/functions/`, so their source is already version-controlled.

Secret **names** only (no values were read or recorded): `ANTHROPIC_API_KEY`,
`SUPABASE_ANON_KEY`, `SUPABASE_DB_URL`, `SUPABASE_JWKS`,
`SUPABASE_PUBLISHABLE_KEYS`, `SUPABASE_SECRET_KEYS`, `SUPABASE_SERVICE_ROLE_KEY`,
`SUPABASE_URL`, `VAPID_PRIVATE_KEY`, `VAPID_PUBLIC_KEY`, `VAPID_SUBJECT`.

## Migrations vs. this repo

**70 migrations applied, and the repo has exactly 70 migration files — the two lists
match version for version, with nothing applied that is missing from the repo and
nothing in the repo left unapplied.** First `20260715000000`, last `20260728170000`.
This database is fully up to date with `supabase/migrations/`.

## Schema captured

697 columns, 266 constraints, 163 indexes, 89 RLS policies (RLS enabled on all 66
tables), 191 functions, 11 triggers, 2 views (`installer_category_stats`,
`installer_type_stats`), 6 extensions, plus every foreign key and sequence. Enough to
rebuild the database, not just repopulate it. The 12 enum types recorded all belong to
Supabase-managed schemas; the `public` schema uses check constraints rather than enums.

## What was deliberately removed

Three live credentials were found in the row data and replaced with
`[REDACTED-CREDENTIAL]` before anything was committed, so the backup is safe to keep in
the repository. The rows and columns are otherwise intact.

| Location | What it was |
| --- | --- |
| `profiles.pin` | Ammon's app sign-in PIN, stored in plain text |
| `vault_config.pin_hash` | PBKDF2 hash of the vault PIN |
| `vault_config.pin_salt` | Salt for that hash |

Restoring this database from the backup therefore means setting those PINs again. That
is the intended trade-off: a restore point should not double as a credential leak.

Worth flagging separately: the already-committed production backup
(`2026-07-29T1200Z-czprjcskmzzagdztqonm-full.json`) contains plain-text `profiles.pin`
values for six people. This backup does not change that file, but somebody should.

## Verification

Re-checked against the live database after writing the file, by `scripts/verify_backup.py`:

- JSON parses.
- Live catalog listed again: 68 relations, all present in the backup, none extra.
- Every one of the 66 tables re-counted directly against the database — 430 rows, **0
  mismatches**, and every non-empty table's stored row array is exactly as long as its
  live count.
- Auth user count, storage object count and total bytes all re-queried and matched.
- All 5 downloaded PDFs re-hashed on disk against their recorded sha256 and re-checked
  against their recorded sizes.
- Zero capture failures. No table was skipped.
