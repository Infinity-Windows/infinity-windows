# Migration drift — PRODUCTION (`czprjcskmzzagdztqonm`), 2026-07-29

**Measured against the production project only.** Project ref
`czprjcskmzzagdztqonm`, confirmed from `app/.env`,
`.github/workflows/deploy-pages.yml` and the live bundle at
<https://infinity-windows.github.io/infinity-windows/>.

The earlier audit, [`docs/migration-audit-2026-07-28.md`](./migration-audit-2026-07-28.md),
was measured against `jvsyhtarnvmdilsgksdi` — a **different** project, which
`scripts/pgq.sh` used to default to. Its "64 APPLIED / zero MISSING" all-clear
does not describe production and must not be relied on. Its *diagnoses* and
*repair SQL* are still useful.

## Method

* Live catalog snapshot: `scripts/live_schema.sql` executed against
  `czprjcskmzzagdztqonm` through the Supabase MCP `execute_sql` tool
  (4,256 catalog rows).
* Declared objects: `scripts/migration_objects.py` over all 70 files in
  `supabase/migrations/`.
* Verdicts: `scripts/migration_drift.py`.

`supabase_migrations.schema_migrations` was **not** used as evidence. It held
only 11 rows whose versions do not correspond to any migration filename, so it
is not a usable signal on this project.

## Headline

| Measure | Before repair |
| --- | --- |
| Live relations in `public` (tables + views) | 38 (36 base tables, 2 views) |
| Relations declared by migrations | 68 |
| Relations missing | **31** |
| Files APPLIED | 42 |
| Files PARTIAL | 4 |
| Files MISSING | 22 |
| Files DATA-ONLY (seed/backfill, not catalog-verifiable) | 2 |

The 22nd MISSING file, `20260728140000_mark_spec_fractional_dimensions.sql`, was
invisible on the first pass — see
[the column-type blind spot](#the-column-type-blind-spot) below.

One live table, `project_marks`, is not declared by any migration file. It was
left untouched — it predates or sits outside the migration set, and dropping
anything is out of scope.

## Note on the two tables the task brief said the extractor could not see

The brief listed `mark_elevation_views` and `spec_plan_discrepancies` as
undeclared by `scripts/migration_objects.py`. They are in fact declared
correctly; those are **migration filenames**, not table names. The tables are
`project_mark_elevation_views` and `project_spec_discrepancies`, and the
extractor emits both. No extractor bug there.

`scripts/migration_objects.py` did have a real defect: `main()` ignored
`sys.argv` and always rescanned the whole directory, so passing it a single
file silently produced output for all 70. That is fixed in this change — it now
scans only the paths given, and falls back to the whole directory when given
none.

## The column-type blind spot

A second, more consequential extractor gap turned up during the repair.

`20260728140000_mark_spec_fractional_dimensions.sql` contains only
`alter table project_mark_specs alter column width_in type numeric` (and the
same for `height_in`). The extractor had no rule for `ALTER COLUMN … TYPE`, so
it emitted **zero** objects for that file, and `migration_drift.py` — which
builds its verdict list from files that declared something — dropped the file
from the report entirely. It appeared in neither the APPLIED nor the MISSING
column. That is why the first pass reported 69 files rather than 70.

This matters here because the file fixes a real production failure: the
`int` columns reject a printed half-inch dimension with
`invalid input syntax for type integer: "89.5"`, which drops **every** spec row
for the affected pages, leaving installers with blank spec cards.

Both scripts now understand the shape. `migration_objects.py` emits
`coltype|table.column|type` for the type spellings it can map onto
`information_schema.data_type`, and `migration_drift.py` records the live type
of every column so the two compare. Re-running the old (pre-repair) snapshot
through the fixed tooling now correctly flags the file as MISSING.

## Missing relations, grouped by the migration that declares them

| Migration | Missing relations |
| --- | --- |
| `20260720010000_push_subscriptions.sql` | `push_subscriptions` |
| `20260721010000_crew_scheduling.sql` | `schedule_assignments`, `schedule_assignment_members`, `schedule_events` |
| `20260721020000_knowledge_rag.sql` | `knowledge_docs`, `knowledge_chunks` (+ `vector` extension) |
| `20260721030000_vault_pin.sql` | `vault_config` |
| `20260723010000_vehicles_machinery.sql` | `vehicles`, `vehicle_drivers`, `vehicle_devices`, `vehicle_locations_latest`, `vehicle_locations_history`, `vehicle_service_records`, `vehicle_service_schedules`, `vehicle_financials`, `vehicle_project_assignments` |
| `20260723020000_travel_info.sql` | `trips`, `trip_crew`, `flights`, `lodging`, `ground_transport`, `procedures`, `trip_contacts`, `trip_attachments` |
| `20260723040000_project_chat.sql` | `project_messages` |
| `20260723040030_vehicle_drive_sessions.sql` | `vehicle_drive_sessions` |
| `20260723050000_project_message_reads.sql` | `project_message_reads` |
| `20260724000000_mark_specs.sql` | `project_mark_specs` |
| `20260728130000_planset_extraction_progress.sql` | `project_planset_pages` |
| `20260728150000_spec_plan_discrepancies.sql` | `project_spec_discrepancies` |
| `20260728170000_mark_elevation_views.sql` | `project_mark_elevation_views` |

## Per-file verdicts

Files not listed below are `APPLIED` — every object they declare was found in
the live catalog.

### PARTIAL

**`20260718050000_time_timecard.sql`** — 1 present / 10 missing

* columns `time_shifts.edited_by`, `.edited_at`, `.rejected_by`,
  `.rejected_at`, `.reject_reason`
* functions `_is_lead`, `reject_shift`, `lead_add_shift`, `lead_edit_shift`
* STALE `time_shifts_status_check`: live is missing the value `'rejected'`

**`20260720000000_offline_outbox_idempotency.sql`** — 1 present / 4 missing

* columns `time_shifts.client_id`, `attachments.client_id`
* unique indexes `time_shifts_client_id_key`, `attachments_client_id_key`

**`20260723060030_time_clock_note.sql`** — 1 present / 1 missing

* column `time_shifts.note`

**`20260728160000_spec_discrepancy_issues.sql`** — 1 present / 7 missing

* columns `project_spec_discrepancies.issue_id`, `.status`
* constraint `project_spec_discrepancies_status_check`
* index `project_spec_discrepancies_issue_idx`
* functions `acknowledge_spec_discrepancy`, `withdraw_spec_discrepancy`
* STALE `issues_kind_check`: live is missing the value `'spec_gap'`

### MISSING

| File | Objects missing |
| --- | --- |
| `20260718060000_cost_codes_library.sql` | 7 — `cost_codes.description/.sort_order/.created_at/.updated_at`, index `cost_codes_sort_idx`, function `set_cost_codes_updated_at`, trigger `trg_cost_codes_updated` |
| `20260718080000_project_details.sql` | 8 — `projects.customer_name/.contact_phone/.contact_email/.site_state/.unit_number/.start_date/.end_date/.notes` |
| `20260720010000_push_subscriptions.sql` | 13 — table, 7 columns, 1 index, 4 policies |
| `20260720020000_label_serials_editable_names.sql` | 11 — `locations.serial/.display_name`, `windows.serial/.display_name`, sequences `location_serial_seq`/`window_serial_seq`, unique indexes, function `lock_serial`, 2 triggers |
| `20260721002000_attachment_geo_feed.sql` | 7 — `attachments.project_id/.lat/.lng/.accuracy_m/.taken_at/.caption`, index `attachments_project_idx` |
| `20260721010000_crew_scheduling.sql` | 33 — 3 tables, 5 indexes, 3 policies |
| `20260721020000_knowledge_rag.sql` | 28 — `vector` extension, 2 tables, 4 indexes, 2 policies, 2 functions, 1 trigger |
| `20260721030000_vault_pin.sql` | 10 — table, 2 functions, 1 trigger |
| `20260723010000_vehicles_machinery.sql` | 107 — 9 tables, 7 indexes, 9 policies |
| `20260723020000_travel_info.sql` | 138 — 8 tables, 9 indexes, 16 table policies, 2 `storage.objects` policies, 2 functions |
| `20260723030000_vehicle_schedule_link.sql` | 5 — `vehicle_project_assignments.assignment_id/.start_date/.end_date`, 2 indexes |
| `20260723040000_project_chat.sql` | 13 — table, 2 indexes, 2 policies, function `can_access_project_chat`, realtime publication |
| `20260723040030_vehicle_drive_sessions.sql` | 18 — table, 2 indexes, 1 policy |
| `20260723050000_project_message_reads.sql` | 8 — table, 1 index, 3 policies |
| `20260723060000_issue_assignee_fault.sql` | 6 — `issues.assigned_to/.fault_by`, 2 indexes, functions `assign_issue`, `set_issue_fault` |
| `20260724000000_mark_specs.sql` | 32 — table, 1 index, 4 policies, functions `trg_project_mark_specs_updated`, `is_foreman_plus`, 1 trigger, realtime publication |
| `20260727000000_mark_spec_drawings.sql` | 2 — `project_mark_specs.image_page/.image_bbox` |
| `20260728000000_mark_spec_planset.sql` | 2 — `project_mark_specs.planset_id`, index `project_mark_specs_planset_idx` |
| `20260728130000_planset_extraction_progress.sql` | 10 — table, 1 index, 1 policy |
| `20260728140000_mark_spec_fractional_dimensions.sql` | 2 — `project_mark_specs.width_in` and `.height_in` still `integer`, should be `numeric` |
| `20260728150000_spec_plan_discrepancies.sql` | 18 — table, 1 index, 4 policies, 1 function, 1 trigger, realtime publication |
| `20260728170000_mark_elevation_views.sql` | 19 — table, 1 index, 4 policies |

### DATA-ONLY (not catalog-verifiable)

* `20260715000100_seed_demo.sql`
* `20260717009000_seed_modules.sql`

Both were left alone. Seeds are not idempotent in general and production
already carries real data (2 projects, 130 window types, 42 locations); re-running
them risks duplicating rows for no benefit.

## Already correct — deliberately not re-applied

Confirmed present in the live catalog and left untouched:

* the `guard_profile_role_change` trigger on `profiles`
* `windows_status_check` already accepts `'on_site'`
* `unload_units` already sets `'on_site'`
* 51 functions already carry a pinned `search_path`
* `20260718090000_security_hardening.sql`, which contains the `pg_proc` loop, is
  already APPLIED and already carries the
  `pg_depend … deptype = 'e'` guard that keeps the pgvector trap from firing.
  It was not re-run.

## Repair

See [`docs/migration-repair-2026-07-29-production.md`](./migration-repair-2026-07-29-production.md)
for what was applied and the after-state verification.
