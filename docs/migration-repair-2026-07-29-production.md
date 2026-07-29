# Schema repair applied to `czprjcskmzzagdztqonm`, 2026-07-29 — HALTED

> ## STOP: read this before doing anything with either database
>
> **The task was halted after the schema work had already completed.** Taylor
> raised that the other project, `jvsyhtarnvmdilsgksdi`, may hold the real
> ongoing work and may be the one the team adapts to. No further changes have
> been made since, and **nothing has been rolled back**.
>
> **This file is the authoritative record of the current state of
> `czprjcskmzzagdztqonm`.** Anyone deciding which project to keep needs it.
>
> Short version of where that database now stands:
>
> * **31 new tables exist and all 31 are empty** (0 rows, combined).
> * **No pre-existing row was deleted, truncated or dropped.** Every original
>   row count is unchanged.
> * **Four small data writes did happen**, all backfills carried inside the
>   migration files themselves: 6 `cost_codes.sort_order` values, 42
>   `locations.serial` values, 11 `windows.serial` values, and 1 storage bucket
>   row (`trip-attachments`, holding 0 objects). See
>   [§3](#3-data-that-was-written) for exactly what and why.
> * **70 rows were added to `supabase_migrations.schema_migrations`**, plus 26
>   written automatically by the `apply_migration` tool. See [§5](#5-migration-history).
> * The `vector` extension was installed into `public`.
> * Two CHECK constraints were widened (`time_shifts_status_check` gained
>   `rejected`; `issues_kind_check` gained `spec_gap`) and two columns widened
>   (`project_mark_specs.width_in` / `.height_in`, `integer` → `numeric`).
>
> **Nothing is half-finished.** Every one of the 26 migrations succeeded in
> full, so there is no partial object to clean up and no improvised rollback is
> warranted. Leaving the 31 empty tables in place costs nothing.
>
> If `czprjcskmzzagdztqonm` turns out to be the database the team keeps, this
> work stands and is complete. If `jvsyhtarnvmdilsgksdi` wins instead, the
> effect on `czprjcskmzzagdztqonm` is 31 unused empty tables and the four
> backfills above — none of which harms a database that is being retired.

Companion to [`docs/migration-drift-2026-07-29-production.md`](./migration-drift-2026-07-29-production.md),
which records the before-state.

Everything below was executed against **`czprjcskmzzagdztqonm`** through the
Supabase MCP `apply_migration` / `execute_sql` tools. Project
`jvsyhtarnvmdilsgksdi` was never touched, read or written at any point.

## 1. Restore point (taken before anything was applied)

`docs/backups/2026-07-29T1200Z-czprjcskmzzagdztqonm-full.json` — 243,943 bytes,
a JSON object with one array per non-empty table.

| Table | Rows |
| --- | --- |
| `window_types` | 130 |
| `project_openings` | 109 |
| `locations` | 42 |
| `project_windows` | 26 |
| `windows` | 11 |
| `tools` | 8 |
| `safety_talks` | 7 |
| `cost_codes` | 6 |
| `movements` | 6 |
| `profiles` | 6 |
| `supplies` | 6 |
| `window_id_counters` | 5 |
| `project_plansets` | 4 |
| `access_requests` | 3 |
| `projects` | 2 |
| `installer_clearance` | 1 |
| `time_shifts` | 1 |
| `toolbox_completions` | 1 |
| **Total** | **374** |

The other 18 tables in `public` were empty and are not in the file.

## 2. Migrations applied

26 `apply_migration` calls, oldest to newest, each named for its file, each
carrying that file's own SQL. Every one succeeded on the first attempt; **no
migration failed, and nothing had to be rewritten to make it apply.** Every file
was already written to be idempotent (`if not exists`, `create or replace`,
`drop trigger if exists`, `pg_policies` guards), so the SQL went in verbatim
apart from stripping comments.

| # | Migration | What it added |
| --- | --- | --- |
| 1 | `20260718050000_time_timecard` | 5 `time_shifts` columns, 4 functions, widened `time_shifts_status_check` to accept `rejected` |
| 2 | `20260718060000_cost_codes_library` | 4 `cost_codes` columns, index, function, trigger, `sort_order` backfill |
| 3 | `20260718080000_project_details` | 8 `projects` intake columns |
| 4 | `20260720000000_offline_outbox_idempotency` | `client_id` on `time_shifts` + `attachments`, 2 partial unique indexes, `clock_in` 6-arg overload |
| 5 | `20260720010000_push_subscriptions` | table + index + 4 own-row policies |
| 6 | `20260720020000_label_serials_editable_names` | 2 sequences, 4 columns, 2 unique indexes, `lock_serial` + 2 triggers, serial backfill |
| 7 | `20260721002000_attachment_geo_feed` | 6 `attachments` columns + index |
| 8 | `20260721010000_crew_scheduling` | `schedule_assignments`, `schedule_assignment_members`, `schedule_events` |
| 9 | `20260721020000_knowledge_rag` | `vector` extension, `knowledge_docs`, `knowledge_chunks`, ivfflat index, 2 functions |
| 10 | `20260721030000_vault_pin` | `vault_config`, 2 functions, trigger |
| 11 | `20260723010000_vehicles_machinery` | 9 vehicle tables, 7 indexes, 9 policies |
| 12 | `20260723020000_travel_info` | 8 travel tables, 9 indexes, 16 policies, 2 functions, `trip-attachments` bucket + 2 storage policies |
| 13 | `20260723030000_vehicle_schedule_link` | 3 columns + 2 indexes on `vehicle_project_assignments` |
| 14 | `20260723040000_project_chat` | `project_messages`, `can_access_project_chat`, realtime publication |
| 15 | `20260723040030_vehicle_drive_sessions` | table, 2 indexes, owner/supervisor policy |
| 16 | `20260723050000_project_message_reads` | table, index, 3 own-row policies |
| 17 | `20260723060000_issue_assignee_fault` | `issues.assigned_to` / `.fault_by`, 2 indexes, 2 RPCs |
| 18 | `20260723060030_time_clock_note` | `time_shifts.note`, 2 more `clock_in` overloads |
| 19 | `20260724000000_mark_specs` | `project_mark_specs`, `is_foreman_plus`, trigger, 4 policies, realtime |
| 20 | `20260727000000_mark_spec_drawings` | `image_page`, `image_bbox` |
| 21 | `20260728000000_mark_spec_planset` | `planset_id` + index |
| 22 | `20260728130000_planset_extraction_progress` | `project_planset_pages` |
| 23 | `20260728150000_spec_plan_discrepancies` | `project_spec_discrepancies`, trigger, 4 policies, realtime |
| 24 | `20260728160000_spec_discrepancy_issues` | `issue_id` / `status`, status check, index, 2 RPCs, `issues_kind_check` widened with `spec_gap` |
| 25 | `20260728170000_mark_elevation_views` | `project_mark_elevation_views`, index, 4 policies |
| 26 | `20260728140000_mark_spec_fractional_dimensions` | `project_mark_specs.width_in` / `.height_in` `integer` → `numeric` |

Number 26 is out of timestamp order because it was found only after the first
pass — see [the column-type blind spot](./migration-drift-2026-07-29-production.md#the-column-type-blind-spot).
Applying it late is harmless: it only widens two columns on a table created by
number 19, and the table was empty at the time.

### The pgvector trap did not fire

`20260721020000_knowledge_rag` installs the `vector` extension.
`20260718090000_security_hardening`, the only migration that loops over every
function in `public`, was already APPLIED and already carries the
`not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')`
guard. It was not re-run, so there was nothing to roll back.

## 3. Data that was written

This is the complete list. Nothing else in the database was written to.

### 31 new tables — all empty

Combined row count across all 31: **0**. Verified after the halt.

`push_subscriptions` · `schedule_assignments` · `schedule_assignment_members` ·
`schedule_events` · `knowledge_docs` · `knowledge_chunks` · `vault_config` ·
`vehicles` · `vehicle_drivers` · `vehicle_devices` · `vehicle_locations_latest` ·
`vehicle_locations_history` · `vehicle_service_records` ·
`vehicle_service_schedules` · `vehicle_financials` ·
`vehicle_project_assignments` · `vehicle_drive_sessions` · `trips` ·
`trip_crew` · `flights` · `lodging` · `ground_transport` · `procedures` ·
`trip_contacts` · `trip_attachments` · `project_messages` ·
`project_message_reads` · `project_mark_specs` · `project_planset_pages` ·
`project_spec_discrepancies` · `project_mark_elevation_views`

### Four writes that touched real data

Each is a backfill written into the migration file itself, not something
improvised during the repair.

| What | Rows | From | To |
| --- | --- | --- | --- |
| `cost_codes.sort_order` | 6 | `0` (the column's new default) | `10, 20, 30, 40, 50, 60` in `code` order |
| `locations.serial` | 42 | `null` (new column) | `SLOT-000001` … `SLOT-000042` |
| `windows.serial` | 11 | `null` (new column) | `WIN-000001` … `WIN-000011` |
| `storage.buckets` | 1 | — | one row, `trip-attachments`, private, currently holding 0 objects |

All four fill columns that did not exist minutes earlier, or a bucket that did
not exist. **No pre-existing value was overwritten.** The `spec_discrepancy_issues`
migration also carries a backfill loop over `project_spec_discrepancies`; that
table was empty, so it inserted 0 rows and created 0 issues.

### Schema-level changes to existing objects

* `time_shifts_status_check` dropped and re-added, widened to accept
  `'rejected'` alongside `open` / `submitted` / `approved`.
* `issues_kind_check` dropped and re-added, widened to accept `'spec_gap'`.
* `project_mark_specs.width_in` and `.height_in` changed `integer` → `numeric`
  (a widening; both columns were empty).
* New nullable columns added to `time_shifts`, `attachments`, `projects`,
  `cost_codes`, `locations`, `windows`, `issues` — all nullable or defaulted,
  none replacing an existing column.
* `vector` extension installed into `public`.
* `supabase_realtime` publication gained `project_messages`,
  `project_mark_specs`, `project_spec_discrepancies`.
* Grants issued to `authenticated` / `service_role` on the new tables only.

## 4. Verification, by catalog

| Measure | Before | After |
| --- | --- | --- |
| Base tables in `public` (`pg_class.relkind = 'r'`) | 36 | **67** |
| All relations (tables + views) | 38 | **69** |
| Catalog rows in the snapshot | 4,256 | 5,082 |
| Files APPLIED | 42 | **68** |
| Files PARTIAL | 4 | **0** |
| Files MISSING | 22 | **0** |
| Files DATA-ONLY | 2 | 2 |

All 31 previously-missing relations now exist. `scripts/migration_drift.py`
against a fresh post-repair snapshot reports `Counter({'APPLIED': 68,
'DATA-ONLY': 2})` — every one of the 70 files accounted for, nothing missing,
nothing partial.

### Row counts are unchanged

Re-counted after the repair and identical to the restore point in every case:

`project_openings` 109 · `profiles` 6 · `projects` 2 · `window_types` 130 ·
`locations` 42 · `project_windows` 26 · `windows` 11 · `project_plansets` 4 ·
`tools` 8 · `safety_talks` 7 · `cost_codes` 6 · `movements` 6 · `supplies` 6 ·
`window_id_counters` 5 · `access_requests` 3 · `installer_clearance` 1 ·
`time_shifts` 1 · `toolbox_completions` 1 · `install_events` 0 · `issues` 0.

Nothing was dropped, truncated or deleted. The only writes to existing rows were
the two backfills carried inside the migration files themselves —
`cost_codes.sort_order` (was 0, now 10/20/…/60) and the `SLOT-`/`WIN-` serials
on `locations` and `windows`, both of which fill previously-null or
previously-zero columns and neither of which changes a row count.

## 5. Migration history

All **70** filename versions are now present in
`supabase_migrations.schema_migrations`, inserted with
`on conflict (version) do nothing`. Both seeds are recorded as applied because
their rows are demonstrably in the database (`DH3252` / `PIC6048` / `SL7248`
window types from `seed_demo`; 8 tools and 7 safety talks from `seed_modules`).

The table holds 107 rows, so **37 are phantom versions that match no file**:

* **26** written by `apply_migration` itself. The MCP tool stamps its own
  `2026072917…`/`2026072918…` version and puts the file name in the `name`
  column, so each repair here produced a duplicate bookkeeping row alongside the
  canonical one.
* **11** pre-existing rows (`20260715185858` … `20260720223956`) whose versions
  matched no filename before this change either.

**These were deliberately left in place.** The brief said never to DELETE, and
they hold no application data. They are not harmless, though: `supabase db push`
compares versions, so it will see 37 remote-only migrations with no local file.
`docs/migration-history-phantom-cleanup-2026-07-29.sql` contains the tightly
scoped cleanup, ready to run once a human decides.

## 6. Advisors after the repair

### Security — 145 findings (2 ERROR, 142 WARN, 1 INFO)

| Finding | Count | Notes |
| --- | --- | --- |
| `security_definer_view` (ERROR) | 2 | `installer_type_stats`, `installer_category_stats` — **pre-existing**, unrelated to this repair |
| `rls_policy_always_true` | 51 | The repo's deliberate "authenticated full access" trusted-crew pattern. 13 of these are on tables created here; the pattern is what the migration files declare |
| `anon_security_definer_function_executable` | 35 | Every `security definer` RPC is callable via `/rest/v1/rpc/…`; each guards itself internally by reading the caller's true role |
| `authenticated_security_definer_function_executable` | 35 | Same set |
| `function_search_path_mutable` | 19 | **Worth acting on.** 16 are functions created by this repair |
| `extension_in_public` | 1 | `vector` landed in `public`, because that is what `create extension if not exists vector;` does and what `vector(1536)` in the same file resolves against |
| `rls_enabled_no_policy` (INFO) | 1 | `vault_config` — intentional; the migration's own comment explains that only the service role may touch the PIN hash |
| `auth_leaked_password_protection` | 1 | Pre-existing Auth setting, not schema |

**The `function_search_path_mutable` group is the one real gap.**
`20260718090000_security_hardening` pins `search_path` on every function that
exists *when it runs*. Sixteen functions created by later migrations
(`_is_lead`, `reject_shift`, `lead_add_shift`, `lead_edit_shift`, `clock_in`,
`lock_serial`, `set_cost_codes_updated_at`, `set_knowledge_docs_updated_at`,
`match_knowledge_chunks`, `set_vault_config_updated_at`, `assign_issue`,
`set_issue_fault`, `trg_project_mark_specs_updated`,
`trg_project_spec_discrepancies_updated`, plus `open_service_case` and
`set_opening_condition` which pre-date this work) therefore have a mutable
`search_path`. That is what the repo currently declares, so it is **not drift** —
it is a standing gap in the repo, and fixing it means a new migration.
Deliberately not done here: this change applies what the repo declares and
improvises no schema.

### Performance — 144 findings (29 WARN, 115 INFO)

| Finding | Count | Notes |
| --- | --- | --- |
| `unindexed_foreign_keys` (INFO) | 58 | Long-standing pattern across the schema |
| `unused_index` (INFO) | 57 | Expected — most are on tables created minutes ago with zero rows |
| `auth_rls_initplan` | 20 | Policies calling `auth.uid()` per row; fixable by wrapping as `(select auth.uid())` |
| `multiple_permissive_policies` | 8 | The travel tables' deliberate read + write policy pair |
| `duplicate_index` | 1 | `project_plansets_kind_idx` / `project_plansets_project_kind_idx` — **pre-existing** |

None of these block anything at this data volume (the largest table has 130
rows). All are follow-up candidates, none were acted on.

## 7. Deliberately not done

* **Did not run the two seed migrations.** They are not idempotent, and their
  rows are already present.
* **Did not touch `project_marks`** — a live table no migration declares.
* **Did not delete the 37 phantom migration-history rows** (see above).
* **Did not pin `search_path`** on the 19 flagged functions, or act on any other
  advisor finding. All would be new schema the repo does not declare.
* **Did not re-run `20260718090000_security_hardening`.**
* **Did not touch `app/src`.**
* **Did not touch project `jvsyhtarnvmdilsgksdi`** — not read, not written, at
  any point.

## 8. Not rolled back, and why

When the halt came, the instruction was to revert only what is *trivially safe
and clearly incomplete* — a half-created table from a failed statement, say.
There is nothing in that category. All 26 migrations succeeded in full; not one
statement failed, so no object is partial.

Rolling the 31 tables back would mean 31 improvised `DROP TABLE` statements
against a live database to remove tables holding no data, which is strictly more
risk than leaving them. The four data backfills fill columns that would have to
be dropped alongside them. So nothing was undone.

**If the decision goes to `jvsyhtarnvmdilsgksdi`,** this database is left with 31
unused empty tables, four backfilled columns and a spare storage bucket — all
inert, and all irrelevant to a database being retired.

**If the decision stays with `czprjcskmzzagdztqonm`,** the work is already
complete and verified: zero drift against all 70 migration files.
