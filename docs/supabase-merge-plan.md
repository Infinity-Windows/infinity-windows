# Merging the Infinity Windows Supabase projects

Two people built this app against two different Supabase projects. Taylor has
decided everything should end up in one. This document is the plan for doing
that without losing a row or silently creating a duplicate.

**Nothing here has been executed, and nothing here can be executed by a script
in this repo.** `scripts/supabase-merge.sh` prints statements and stops; it has
no `--execute`. That is deliberate — see [§10](#10-why-there-is-no-execute).

## Contents

1. [What we know, and what we do not](#1-what-we-know-and-what-we-do-not)
2. [Recommended direction](#2-recommended-direction)
3. [The three hazards that will actually bite](#3-the-three-hazards-that-will-actually-bite)
4. [Foreign-key dependency order](#4-foreign-key-dependency-order)
5. [Dedup key, table by table](#5-dedup-key-table-by-table)
6. [UUID collision and remapping](#6-uuid-collision-and-remapping)
7. [Pick one winner: tables that must not be merged](#7-pick-one-winner-tables-that-must-not-be-merged)
8. [Auth users](#8-auth-users)
9. [Storage objects](#9-storage-objects)
10. [Why there is no `--execute`](#10-why-there-is-no-execute)
11. [Verification](#11-verification)
12. [Rollback](#12-rollback)
13. [Runbook](#13-runbook)

---

## 1. What we know, and what we do not

### `czprjcskmzzagdztqonm` — measured

This is the project the app points at. As of 2026-07-29 it holds **374 rows
across 18 tables**, with all 67 base tables present and all 70 migration files
applied. The complete row-level state is committed at
`docs/backups/2026-07-29T1200Z-czprjcskmzzagdztqonm-full.json`.

| Table | Rows | | Table | Rows |
| --- | ---: | --- | --- | ---: |
| `window_types` | 130 | | `movements` | 6 |
| `project_openings` | 109 | | `profiles` | 6 |
| `locations` | 42 | | `supplies` | 6 |
| `project_windows` | 26 | | `window_id_counters` | 5 |
| `windows` | 11 | | `project_plansets` | 4 |
| `tools` | 8 | | `access_requests` | 3 |
| `safety_talks` | 7 | | `projects` | 2 |
| `cost_codes` | 6 | | `installer_clearance` · `time_shifts` · `toolbox_completions` | 1 each |

The other 49 tables are present and empty. Full detail, including the four
backfills applied during the 2026-07-29 schema repair, is in
[`migration-repair-2026-07-29-production.md`](./migration-repair-2026-07-29-production.md).

### `jvsyhtarnvmdilsgksdi` — never read

Ammon's project. Several newer edge functions were deployed there. **Nobody has
ever read its contents.** Every statement in this document about it is
conditional, and the first job once a token exists is to make it unconditional:

```
SUPABASE_ACCESS_TOKEN=sbp_... scripts/supabase-inventory.sh
```

That enumerates **every** project on the account — not just these two. There may
well be a third that nobody has mentioned; the inventory script does not assume
otherwise and neither should the plan.

### The distinction this whole exercise turns on

An earlier audit reported `czprjcskmzzagdztqonm` as clean while it was 31 tables
short, because it guessed a project ref and because "table has no rows" and
"table does not exist" both read as zero. `scripts/supabase-compare.py` keeps
those three states apart — `MISSING`, `empty`, `populated` — and exits non-zero
when a table holds data in one project and does not exist in another. Do not
replace it with anything that reports a single number per table.

---

## 2. Recommended direction

**Merge `jvsyhtarnvmdilsgksdi` (and any other project found) INTO
`czprjcskmzzagdztqonm`. Keep `czprjcskmzzagdztqonm`.**

This is a recommendation with one honest caveat: nobody has read Ammon's
project. If the inventory comes back showing it holds substantially more real
data than 374 rows, revisit — but revisit knowing the cost below, not by
default.

### Why

**It is where the real data already is.** 374 rows of production data, measured,
backed up, and referenced by every existing operational document. Merging *into*
it means the smaller side moves, and the smaller side is the one with less to
lose if a statement is wrong.

**It is already at zero schema drift.** All 70 migration files applied, verified
by catalog. Ammon's project's migration state is unknown; if it is behind, then
making it the target means running the full migration history there first and
then merging — the same work, plus a migration run, against a database that has
never been audited.

**Every reference in the repo already points at it.** Switching direction means
changing all of the following, and getting all of them right at once:

| File | Line | What it pins |
| --- | --- | --- |
| `app/src/lib/supabaseProject.ts` | 13 | `EXPECTED_PROJECT_REF` — the constant behind the "wrong project" banner |
| `app/src/lib/supabaseProject.test.ts` | 10, 15, 35, 50, 77 | Tests that assert the banner fires for `jvsyhtarnvmdilsgksdi` and not for `czprjcskmzzagdztqonm`. **Both refs would swap roles.** |
| `app/.env.example` | 3, 11 | `VITE_SUPABASE_URL` and the comment naming the shared project |
| `.github/workflows/deploy-backend.yml` | 35 | `SUPABASE_PROJECT_REF` — the ref migrations and edge functions deploy to |
| `.github/workflows/vault-sync.yml` | 49 | `SUPABASE_URL` for the vault sync job |
| `scripts/verify-functions.sh` | 25 | `REF` default |
| `scripts/pgq.sh` | 18, 25 | Documentation of which ref is production, and the worked example |
| `scripts/audit-migrations.sh` | 12 | Documented example ref |
| `README.md` | — | Names the project |
| `docs/migration-audit-2026-07-28.md`, `docs/migration-drift-2026-07-29-production.md`, `docs/migration-repair-2026-07-29-production.md`, `docs/migration-drift-2026-07-28.sql` | — | Historical records. **Do not rewrite these**; they describe what was true at the time. |

Plus, outside the repo and invisible to `grep`:

- The **GitHub Actions repo secrets** `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`,
  `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD`, `SUPABASE_SERVICE_ROLE_KEY` —
  all scoped to whichever project they were issued for.
- Every crew member's **installed PWA**, which caches the Supabase URL in its
  bundle until a hard refresh.
- Every **auth session**. Sessions are per-project; pointing the app at a
  different Supabase project signs everyone out, and they cannot sign back in
  until their user exists there.

`app/.env` itself is not in the repo (only `.env.example` is), so whoever
switches direction also has to fix their own local file and any other developer's.

**What the other direction buys you.** One thing: Ammon's newer edge functions
are already deployed on his project. That is the weakest of the reasons above —
edge functions are code in `supabase/functions/` and redeploy with one workflow
run (`deploy-backend.yml`), whereas 374 rows of hand-entered inventory do not
regenerate.

---

## 3. The three hazards that will actually bite

These are the ones found by reading the real schema in `supabase/migrations/`,
not generic merge advice.

### Hazard 1 — `cost_codes.code` looks like a key and is not one

`cost_codes` is created by `20260717001000_time_clock.sql` with **no unique
constraint on `code`**, and the same migration then does a bare
`insert into cost_codes (code, label) values ('100', ...), ('110', ...)` with no
`on conflict` clause — it cannot have one, because there is no constraint to
conflict on.

So both projects ran that insert, both hold six cost codes with identical
`code` values, and every one of those twelve rows has a different UUID.
`time_shifts.cost_code_id` points at them. A naive union produces twelve cost
codes, the app's dropdown shows every code twice, and half the timesheets point
at the copy nobody sees.

It is not alone. Eleven other tables have a dedup key that is convention only:
`access_requests.email`, `supplies.name`, `safety_talks(talk_date, title)`,
`toolbox_completions(profile_id, talk_id)`, `project_plansets(project_id,
storage_path)`, `knowledge_chunks(doc_id, chunk_index)`, `trips(name,
start_date)`, `trip_attachments(trip_id, storage_path)`, `vehicles.vin`,
`vehicle_devices(provider, provider_device_id)` and
`vehicle_service_schedules(vehicle_id, task)`. For all of them, `on conflict`
is unavailable and duplicates may **already** exist inside a single project.
Preflight check 2 in the dry run is what tells you.

### Hazard 2 — `SLOT-000001` and `WIN-000001` mean different physical things in each project

`20260720020000_label_serials_editable_names.sql` adds `locations.serial` and
`windows.serial`, backfills them from a sequence starting at 1, and puts a
**UNIQUE index on each**. On `czprjcskmzzagdztqonm` that produced
`SLOT-000001` … `SLOT-000042` and `WIN-000001` … `WIN-000011`.

If that migration also ran on Ammon's project, it produced the same strings over
a completely different set of racks and windows. `SLOT-000007` is a physical
label on a physical shelf. Two projects, two different shelves, same label.

The unique index means the merge cannot just insert them — it fails loudly,
which is the good case. **The bad case is a merge that pre-emptively "resolves"
the collision by keeping one row.** That silently discards a real rack. Every
merged `locations` and `windows` row needs a fresh serial issued above the
target's current maximum, the physical labels need reprinting, and someone has
to walk the warehouse. This is the part of the merge that is not a database
problem.

### Hazard 3 — `profiles` has no email, and `profiles.id` is `auth.users.id`

`create table profiles (id uuid primary key references auth.users(id) on delete cascade, ...)`.
There is no `email` column, no `username`, nothing but `display_name` (not
unique) and a PIN.

So the only way to tell whether Ammon's "Dave" and Taylor's "Dave" are the same
person is `auth.users.email` — a table in the `auth` schema that **SQL cannot
insert into**. You cannot `insert into auth.users`; Supabase manages it, and a
hand-written row produces an account that cannot log in and breaks in ways that
surface weeks later.

Every `profiles` row therefore either matches an existing auth user in the
target by id, or it is a blocker that must be resolved through the Auth admin
API before a single dependent row can move. And a lot depends on it: **47 of the
schema's foreign keys point at `profiles`** — more than at any other table.

### Also worth knowing

- **The schema has a genuine foreign-key cycle.**
  `window_types.golden_install_event_id → install_events → window_types`, with
  `windows` and `project_openings` in the same strongly connected component. No
  insert order satisfies every constraint in one pass. The column is nullable,
  so the merge inserts `window_types` with it NULL and fills it in afterwards
  (phase 3 of the dry run).
- **`locations.address` is `generated always as (zone || '-' || rack || '-' || slot) stored`.**
  Postgres rejects any INSERT that names it. The committed backup contains it, so
  a merge that replays the backup verbatim fails on the first `locations` row.
- **`project_marks` exists in production and no migration declares it.** It is
  outside everything in this plan. Inventory it before deciding what to do with it.

---

## 4. Foreign-key dependency order

Derived from `supabase/migrations/` by `scripts/supabase_merge_lib.parse_migrations`
and topologically sorted by `dependency_order`. Regenerate rather than trusting
this table if the migrations change:

```
python3 -c "import sys; sys.path.insert(0,'scripts'); from supabase_merge_lib import *; print('\n'.join(dependency_order(parse_migrations())))"
```

`scripts/test_supabase_merge.py` asserts that every foreign key in the schema is
satisfied by this order, so a new migration that adds a table breaks the test
rather than breaking a merge.

Self-references are excluded (handled by inserting in two passes, not by
ordering), as is `profiles → auth.users`, which no merge can insert.
`window_types.golden_install_event_id` is deferred to phase 3.

### Insert order

| # | Table | Waits for |
| --- | --- | --- |
| 1 | `cost_codes` | — |
| 2 | `learn_priority_terms` | — |
| 3 | `locations` | — |
| 4 | `profiles` | — |
| 5 | `safety_talks` | — |
| 6 | `supplies` | — |
| 7 | `window_types` | — |
| 8 | `access_requests` | `profiles` |
| 9 | `cycle_counts` | `locations` |
| 10 | `installer_clearance` | `profiles`, `window_types` |
| 11 | `knowledge_docs` | `profiles` |
| 12 | `learn_progress` | `profiles` |
| 13 | `points_ledger` | `profiles` |
| 14 | `projects` | `profiles` |
| 15 | `push_subscriptions` | `profiles` |
| 16 | `safety_acks` | `profiles`, `safety_talks` |
| 17 | `schedule_events` | `profiles` |
| 18 | `toolbox_completions` | `profiles`, `safety_talks` |
| 19 | `tools` | `profiles` |
| 20 | `vault_config` | `profiles` |
| 21 | `vehicles` | `profiles` |
| 22 | `window_id_counters` | `window_types` |
| 23 | `change_orders` | `projects` |
| 24 | `incidents` | `profiles`, `projects` |
| 25 | `job_costs` | `profiles`, `projects` |
| 26 | `job_notes` | `profiles`, `projects` |
| 27 | `knowledge_chunks` | `knowledge_docs` |
| 28 | `project_message_reads` | `profiles`, `projects` |
| 29 | `project_messages` | `profiles`, `projects` |
| 30 | `project_plansets` | `projects` |
| 31 | `project_windows` | `projects`, `window_types` |
| 32 | `schedule_assignments` | `profiles`, `projects` |
| 33 | `supply_orders` | `projects`, `supplies` |
| 34 | `time_shifts` | `cost_codes`, `profiles`, `projects` |
| 35 | `trips` | `profiles`, `projects` |
| 36 | `vehicle_devices` | `vehicles` |
| 37 | `vehicle_drive_sessions` | `profiles`, `vehicles` |
| 38 | `vehicle_drivers` | `profiles`, `vehicles` |
| 39 | `vehicle_financials` | `vehicles` |
| 40 | `vehicle_locations_history` | `vehicles` |
| 41 | `vehicle_locations_latest` | `vehicles` |
| 42 | `vehicle_service_records` | `vehicles` |
| 43 | `vehicle_service_schedules` | `vehicles` |
| 44 | `windows` | `locations`, `projects`, `window_types` |
| 45 | `flights` | `profiles`, `trips` |
| 46 | `ground_transport` | `trips` |
| 47 | `lodging` | `trips` |
| 48 | `movements` | `locations`, `projects`, `windows` |
| 49 | `procedures` | `trips` |
| 50 | `project_mark_elevation_views` | `project_plansets`, `projects` |
| 51 | `project_mark_specs` | `project_plansets`, `projects` |
| 52 | `project_openings` | `profiles`, `project_plansets`, `projects`, `window_types`, `windows` |
| 53 | `project_plan_outlines` | `project_plansets`, `projects` |
| 54 | `project_planset_pages` | `project_plansets` |
| 55 | `schedule_assignment_members` | `profiles`, `schedule_assignments` |
| 56 | `trip_contacts` | `trips` |
| 57 | `trip_crew` | `profiles`, `trips` |
| 58 | `vehicle_project_assignments` | `projects`, `schedule_assignments`, `vehicles` |
| 59 | `install_events` | `profiles`, `project_openings`, `window_types`, `windows` |
| 60 | `issues` | `profiles`, `project_openings`, `projects`, `windows` |
| 61 | `qc_checks` | `project_openings` |
| 62 | `task_sessions` | `profiles`, `project_openings`, `projects` |
| 63 | `trip_attachments` | `flights`, `lodging`, `profiles`, `trips` |
| 64 | `project_spec_discrepancies` | `issues`, `profiles`, `projects` |
| 65 | `service_cases` | `install_events`, `profiles`, `project_openings`, `projects`, `window_types`, `windows` |
| 66 | `attachments` | `install_events`, `projects`, `service_cases`, `windows` |

Then, after all of the above:

```sql
-- Phase 3: the deferred edge.
update public.window_types
   set golden_install_event_id = <remapped install_events.id>
 where id = <remapped window_types.id>;
```

---

## 5. Dedup key, table by table

"Enforced" means a UNIQUE index or primary key backs the key, so `on conflict
(...) do nothing` is available and duplicates cannot already exist within one
project. "Convention only" means the key is real but unenforced — see
[Hazard 1](#hazard-1--cost_codescode-looks-like-a-key-and-is-not-one). "Surrogate
UUID only" means there is no way to tell a duplicate from a distinct row; those
rows are appended, never matched.

24 tables are enforced, 12 are convention only, 30 are surrogate-only.

| Table | Dedup key | Enforced by a UNIQUE index? |
| --- | --- | --- |
| `cost_codes` | `code` | **no — convention only** |
| `learn_priority_terms` | `term_id` | yes |
| `locations` | `zone`, `rack`, `slot` | yes |
| `profiles` | `id` | yes |
| `safety_talks` | `talk_date`, `title` | **no — convention only** |
| `supplies` | `name` | **no — convention only** |
| `window_types` | `type_code` | yes |
| `access_requests` | `email` | **no — convention only** |
| `cycle_counts` | _none — surrogate UUID only_ | — |
| `installer_clearance` | `installer_id`, `window_type_id` | yes |
| `knowledge_docs` | `source`, `path` | yes |
| `learn_progress` | `profile_id`, `term_id` | yes |
| `points_ledger` | _none — surrogate UUID only_ | — |
| `projects` | `job_code` | yes |
| `push_subscriptions` | `endpoint` | yes |
| `safety_acks` | `talk_id`, `profile_id` | yes |
| `schedule_events` | _none — surrogate UUID only_ | — |
| `toolbox_completions` | `profile_id`, `talk_id` | **no — convention only** |
| `tools` | _none — surrogate UUID only_ | — |
| `vault_config` | _none — surrogate UUID only_ | — |
| `vehicles` | `vin` | **no — convention only** |
| `window_id_counters` | `window_type_id` | yes |
| `change_orders` | _none — surrogate UUID only_ | — |
| `incidents` | _none — surrogate UUID only_ | — |
| `job_costs` | _none — surrogate UUID only_ | — |
| `job_notes` | _none — surrogate UUID only_ | — |
| `knowledge_chunks` | `doc_id`, `chunk_index` | **no — convention only** |
| `project_message_reads` | `project_id`, `profile_id` | yes |
| `project_messages` | _none — surrogate UUID only_ | — |
| `project_plansets` | `project_id`, `storage_path` | **no — convention only** |
| `project_windows` | `project_id`, `window_type_id` | yes |
| `schedule_assignments` | _none — surrogate UUID only_ | — |
| `supply_orders` | _none — surrogate UUID only_ | — |
| `time_shifts` | _none — surrogate UUID only_ | — |
| `trips` | `name`, `start_date` | **no — convention only** |
| `vehicle_devices` | `provider`, `provider_device_id` | **no — convention only** |
| `vehicle_drive_sessions` | _none — surrogate UUID only_ | — |
| `vehicle_drivers` | _none — surrogate UUID only_ | — |
| `vehicle_financials` | `vehicle_id` | yes |
| `vehicle_locations_history` | _none — surrogate UUID only_ | — |
| `vehicle_locations_latest` | `vehicle_id` | yes |
| `vehicle_service_records` | _none — surrogate UUID only_ | — |
| `vehicle_service_schedules` | `vehicle_id`, `task` | **no — convention only** |
| `windows` | `window_id` | yes |
| `flights` | _none — surrogate UUID only_ | — |
| `ground_transport` | _none — surrogate UUID only_ | — |
| `lodging` | _none — surrogate UUID only_ | — |
| `movements` | _none — surrogate UUID only_ | — |
| `procedures` | _none — surrogate UUID only_ | — |
| `project_mark_elevation_views` | `planset_id`, `mark_code`, `page_number`, `region_index` | yes |
| `project_mark_specs` | `project_id`, `mark_code` | yes |
| `project_openings` | `project_id`, `opening_code` | yes |
| `project_plan_outlines` | _none — surrogate UUID only_ | — |
| `project_planset_pages` | `planset_id`, `page_number` | yes |
| `schedule_assignment_members` | `assignment_id`, `profile_id` | yes |
| `trip_contacts` | _none — surrogate UUID only_ | — |
| `trip_crew` | `trip_id`, `profile_id` | yes |
| `vehicle_project_assignments` | _none — surrogate UUID only_ | — |
| `install_events` | _none — surrogate UUID only_ | — |
| `issues` | _none — surrogate UUID only_ | — |
| `qc_checks` | `project_opening_id` | yes |
| `task_sessions` | _none — surrogate UUID only_ | — |
| `trip_attachments` | `trip_id`, `storage_path` | **no — convention only** |
| `project_spec_discrepancies` | `project_id`, `mark_code`, `kind` | yes |
| `service_cases` | _none — surrogate UUID only_ | — |
| `attachments` | _none — surrogate UUID only_ | — |

Two notes on judgement calls in that table:

- **`tools` has no key even though it has a name.** Two crates both labelled
  "Hilti TE 6" are two physical tools. Deduping on name would delete one.
- **Text keys are matched trimmed and case-folded** (`natural_key_of`), because
  the two databases were populated by two people typing. `CAS3050` and
  `cas3050 ` are the same window type.

---

## 6. UUID collision and remapping

Every table's primary key defaults to `gen_random_uuid()`. Both projects were
seeded from the same source material — the same ~130-row window catalogue, the
same rack layout, the same cost codes — and each generated its own ids. **The
same real-world thing therefore has two different UUIDs.**

Two distinct problems come out of that, and they need opposite fixes.

### 6a. Same thing, different ids → match and remap

Detection: match source rows to target rows on the natural key from
[§5](#5-dedup-key-table-by-table). Where they match and the ids differ, record
`source id → target id`.

```sql
-- Detection, run with both databases reachable (or against two exports):
select s.type_code, s.id as source_id, t.id as target_id
  from source.window_types s
  join target.window_types t on lower(trim(t.type_code)) = lower(trim(s.type_code))
 where s.id <> t.id;
```

Then **do not insert the source row at all** — the target already has it — and
rewrite every child row that pointed at the source id.

`IdRemapper.remap_row` does this by consulting the parsed schema, so a child
follows its parent through the FK definition rather than through a hand-written
list. `movements.window_id` resolves through the `windows` mapping;
`project_windows.window_type_id` through `window_types`; and so on for all 47
foreign keys that point at `profiles`.

The order in [§4](#4-foreign-key-dependency-order) is what makes this work: a
parent's mapping is always learned before any child is rewritten.

### 6b. Same id, different things → issue a fresh id

Rarer, but not impossible — a row copied between projects by hand, or a
deliberate seed with a literal UUID. Detection is the inverse of the above: same
`id`, different natural key.

```sql
select s.id, s.type_code as source_code, t.type_code as target_code
  from source.window_types s
  join target.window_types t on t.id = s.id
 where lower(trim(t.type_code)) <> lower(trim(s.type_code));
```

Here the source row is genuinely new and must be inserted, but its id is taken.
`IdRemapper.learn` issues a fresh `uuid4`, records it in the same mapping, and
lists it under "UUID COLLISIONS" in the dry run. Children follow it exactly as in
6a — the mechanism is identical, only the target id differs.

### 6c. Rows with no natural key

For the 30 surrogate-only tables there is no detection at all. A source row is
inserted with its own id (or a fresh one if taken), and if both projects
independently logged the same real event, you get two rows and no way to tell.

For `movements`, `install_events` and `attachments` that is arguably correct —
they are append-only logs of things that happened on two systems, and both did
happen. For `time_shifts` it is a payroll problem: two clock-ins for one shift.
**Review `time_shifts` by hand before merging it.** There is one row on
`czprjcskmzzagdztqonm`; if Ammon's project has many, that is a conversation, not
a script.

---

## 7. Pick one winner: tables that must not be merged

| Table | Why merging is meaningless | What to do |
| --- | --- | --- |
| `window_id_counters` | A per-type sequence high-water mark (`last_seq`). Adding two counters, or taking either one, issues window ids that already exist. | Recompute after `windows` is merged. |
| `locations.serial`, `windows.serial` | Generated series with a UNIQUE index, backfilled from 1 in both projects. Same string, different physical object. | Re-issue every merged row's serial above the target's maximum. Reprint labels. See [Hazard 2](#hazard-2--slot-000001-and-win-000001-mean-different-physical-things-in-each-project). |
| `supabase_migrations.schema_migrations` | Bookkeeping, not data. A union makes `supabase db push` see remote-only versions with no local file. `czprjcskmzzagdztqonm` already carries 37 phantom rows. | Keep the target's history untouched. Then consider `docs/migration-history-phantom-cleanup-2026-07-29.sql`. |
| `vault_config` | Holds one PIN hash. Two projects mean two PINs. | A human picks one and re-sets it through the app. |
| Sequences behind `locations.serial` / `windows.serial` | `setval` state, not rows. | After merging, `setval` above the new maximum, or the next insert collides. |

### Recomputing `window_id_counters`

Run **after** `windows` is merged, never before:

```sql
select wt.id as window_type_id,
       max(coalesce(substring(w.window_id from '[0-9]+$')::int, 0)) as needed_seq
  from public.window_types wt
  left join public.windows w on w.window_type_id = wt.id
 group by wt.id;
```

Then `update window_id_counters set last_seq = greatest(last_seq, needed_seq)`.
The counter must never go down: `issue_window_id` increments and returns, so a
counter behind reality mints a duplicate `window_id` and hits the unique index
on the next receive.

---

## 8. Auth users

`profiles.id` **is** `auth.users.id`. There is no email on `profiles`
([Hazard 3](#hazard-3--profiles-has-no-email-and-profilesid-is-authusersid)), and
`auth.users` cannot be written by SQL.

### Step 1 — read both sides

```sql
select u.id, u.email, u.created_at, u.last_sign_in_at,
       p.display_name, p.role, p.active
  from auth.users u
  left join public.profiles p on p.id = u.id
 order by u.created_at;
```

Run on both projects. `scripts/supabase-inventory.sh` reports the counts; this
gives you the identities.

### Step 2 — classify every source user by email

- **Same email in both projects.** Two auth users, two ids, one human. Record
  `source auth id → target auth id` in the same `IdRemapper` mapping under
  `profiles`. Do **not** insert the source `profiles` row; merge its fields into
  the existing one by hand (higher `skill_level` wins, `role` is a decision, PIN
  stays the target's). Every child row remaps automatically.
- **Email only in the source project.** A real person who has never existed on
  the target. Invite them:
  ```
  POST https://<target-ref>.supabase.co/auth/v1/admin/users
  Authorization: Bearer <SERVICE_ROLE_KEY>
  { "email": "...", "email_confirm": true }
  ```
  or use the Auth → Users → Invite button in the dashboard. **The new user gets a
  new UUID.** Record `source id → new id`, then insert the `profiles` row with
  the new id and let children follow.
- **Email only in the target.** Nothing to do.
- **An `auth.users` row with no `profiles` row.** Someone who signed up and was
  never onboarded. Check `access_requests` before assuming they are junk.

### Step 3 — order matters

Nothing that references `profiles` may be inserted until every source auth user
is either matched or invited. `profiles` is #4 in the insert order for that
reason, and 47 foreign keys wait behind it. The dry run reports any source
`profiles` row whose id is not already an auth user in the target as a blocker.

### What breaks if you get it wrong

A `profiles` row inserted with an id that has no `auth.users` row fails the
foreign key — the good case. Worse: matching two different people because they
share a display name reassigns their timesheets, their points, their QC records
and their signed toolbox talks to the wrong person. **Match on email, never on
`display_name`.**

---

## 9. Storage objects

Four buckets, all created by migrations: `install-media`, `plansets`,
`toolbox-records` and `trip-attachments` (the last added on 2026-07-29 and
currently holding zero objects on `czprjcskmzzagdztqonm`).

Storage objects are not rows a SQL merge can move. They are copied with the
Storage API — download from source, upload to target — and the database rows
that reference them must be updated to the new path in the same pass.

### The path-prefix collision risk

Every bucket keys its paths on an id that **changes during the merge**:

| Bucket | Path pattern | Prefix | Risk |
| --- | --- | --- | --- |
| `plansets` | `${projectId}/${Date.now()}-${safeName}` | project UUID | After remapping, two projects' files land under the same prefix. Same original filename plus a same-millisecond upload collides. |
| `install-media` | caller-supplied, stored in `attachments.storage_path` as `bucket/path` | varies | Paths are opaque; must be read from the row, not reconstructed. |
| `toolbox-records` | `${profileId}/${talkId}/${stamp}-signature.png` and `${stamp}.pdf`, `stamp = <local-date>-<epoch-ms>` | profile + talk UUID | **The worst case.** If the same auth user signed the same talk on both projects, both ids match after remapping. Uploads use `upsert: true`, so the second copy silently overwrites a signed safety record. |
| `trip-attachments` | `${tripId}/${uuid}-${safeName}` | trip UUID | Filename carries a fresh UUID, so collisions need a trip-id collision first. Lowest risk. |

### Procedure

1. **List both sides before copying anything.** The inventory reports per-bucket
   object counts; get the full object list with `storage.objects` or the Storage
   API and diff the paths.
2. **Never upload with `upsert: true` during a merge.** Upload with upsert off so
   a collision is an error you see, not an overwrite you do not.
3. **Rewrite the prefix as you copy**, using the same `source id → target id`
   mapping the row merge used. A file whose row moved to a new project id must
   move to the new project id's prefix, or the app looks for it where it is not.
4. **Update the referencing column in the same step**: `project_plansets.storage_path`
   and `.converted_pdf_path`, `attachments.storage_path`,
   `toolbox_completions.pdf_path` and `.signature_path`,
   `trip_attachments.storage_path`.
5. **Verify no row points at a missing object** — the last query in
   [§11](#11-verification).

---

## 10. Why there is no `--execute`

`scripts/supabase-merge.sh --execute` prints a refusal and exits 2. That is not
an unfinished feature.

Three of the decisions above cannot be made by a script:

- Whether Ammon's "Dave" and Taylor's "Dave" are one person.
- Which physical shelf keeps the label `SLOT-000007`.
- Whether two `time_shifts` rows are one shift double-logged or two shifts.

A tool that guessed at any of them would be confidently wrong in a way nobody
notices for weeks. This repo has already had one incident caused by a script
guessing — an audit that defaulted to a project ref and reported the wrong
database as clean while production was 31 tables short. The dry run exists so a
human reads every statement before it runs.

If it is ever automated, the missing pieces are: transaction handling with a
savepoint per phase, serial re-issue for `locations` and `windows`, and the auth
invite-and-remap flow. None are stubbed, because a half-written mutation tool is
worse than none.

---

## 11. Verification

Run these on the target **before** the merge to capture the baseline, and again
after. The dry run prints all of them with the expected numbers filled in.

### Expected counts

With `T` = target rows before the merge (374 for `czprjcskmzzagdztqonm`), `S` =
source rows, and `D` = source rows that deduped onto an existing target row:

```
rows_after == T + S - D
```

`D` is knowable in advance: the dry run counts it per table as "N source id(s)
remap onto an existing target row". Any other number means something was lost or
duplicated.

### Nothing was lost

```sql
-- Exact counts. Not pg_stat_user_tables.n_live_tup, which is an estimate and
-- reads zero on a table that has never been analysed.
select t.table_name,
       (xpath('/row/c/text()', query_to_xml(
         format('select count(*) as c from %I.%I', t.table_schema, t.table_name),
         false, true, '')))[1]::text::bigint as rows
  from information_schema.tables t
 where t.table_schema = 'public' and t.table_type = 'BASE TABLE'
 order by 1;
```

Every table's count must be **greater than or equal to** its pre-merge value. A
count that went down means the merge deleted something, and the only correct
response is [rollback](#12-rollback).

### No duplicate was created

One query per natural key from [§5](#5-dedup-key-table-by-table); all must return
zero rows. The dry run emits all of them. The shape:

```sql
select 'window_types' as t, type_code, count(*) from public.window_types
 group by type_code having count(*) > 1;
select 'cost_codes' as t, code, count(*) from public.cost_codes
 group by code having count(*) > 1;
-- ... and so on for all 36 tables with a dedup key
```

The convention-only keys matter most here: the enforced ones cannot produce a
duplicate without the insert having already failed.

### No orphaned foreign key

One query per single-column foreign key; all must return zero rows:

```sql
select 'movements.window_id' as fk, count(*)
  from public.movements c
  left join public.windows p on p.id = c.window_id
 where c.window_id is not null and p.id is null;
```

This is the query that catches a child whose parent was remapped but which was
not rewritten.

### Serials are unique and continuous

```sql
select serial, count(*) from public.locations group by serial having count(*) > 1;
select serial, count(*) from public.windows   group by serial having count(*) > 1;
select count(*) as locations_without_serial from public.locations where serial is null;
```

### Counters are ahead of reality

```sql
select wt.type_code, c.last_seq,
       max(coalesce(substring(w.window_id from '[0-9]+$')::int, 0)) as highest_issued
  from public.window_types wt
  join public.window_id_counters c on c.window_type_id = wt.id
  left join public.windows w on w.window_type_id = wt.id
 group by wt.type_code, c.last_seq
having c.last_seq < max(coalesce(substring(w.window_id from '[0-9]+$')::int, 0));
```

Zero rows, or the next window received gets an id that already exists.

### Every profile is a real auth user

```sql
select p.id, p.display_name
  from public.profiles p
  left join auth.users u on u.id = p.id
 where u.id is null;
```

### Every referenced storage object exists

```sql
select 'project_plansets' as t, ps.id, ps.storage_path
  from public.project_plansets ps
  left join storage.objects o
    on o.bucket_id = 'plansets' and o.name = ps.storage_path
 where o.id is null;
```

Repeat for `attachments`, `toolbox_completions` and `trip_attachments`.

---

## 12. Rollback

### Before you start

1. **Take a fresh backup of the target.** The committed
   `docs/backups/2026-07-29T1200Z-czprjcskmzzagdztqonm-full.json` is a
   *pre-repair* snapshot: it predates the `SLOT-`/`WIN-` serial backfill, the
   `cost_codes.sort_order` backfill and the 31 tables added on 2026-07-29. It
   proves the 374 rows and their contents, and it is the right reference for
   *what data existed*. It is **not** a restorable dump of the current schema.
2. **Take a Supabase point-in-time / daily backup** from the dashboard, and note
   the timestamp. This is the real restore path.
3. **Record the exact pre-merge counts** with the query in
   [§11](#11-verification), committed to the repo.

### Aborting mid-merge

Run each phase in an explicit transaction:

```sql
begin;
-- one phase of statements
-- run the relevant verification queries here, inside the transaction
rollback;   -- or commit, once you have read the answers
```

Postgres rolls back DDL and DML alike, so an aborted phase leaves nothing
behind. **Do not run the whole merge as one transaction** — it will be tens of
thousands of statements and a single failure at the end discards hours of
verified work. One transaction per phase, verified before commit.

### After a bad commit

1. Stop. Do not attempt a corrective merge on top of a bad one; the second pass
   cannot tell its own duplicates from the first pass's.
2. Restore the target from the Supabase backup taken in step 2 above.
3. Diff the restored database against the committed pre-merge counts.
4. Only then work out what went wrong, using the dry run output — which is why
   `scripts/supabase-merge.sh --out` exists. Keep the plan file.

### If the source project is deleted too early

Do not delete `jvsyhtarnvmdilsgksdi` — or any other project — until the merged
target has passed every verification query in [§11](#11-verification) **and**
the app has been used against it for a full working week. Pause it instead;
a paused project costs nothing and can be resumed.

---

## 13. Runbook

Nothing below can start until Taylor has a management token
(`sbp_...`, Supabase dashboard → Account → Access Tokens).

```bash
# 1. What exists? Every project on the account, not just the two we know about.
SUPABASE_ACCESS_TOKEN=sbp_... scripts/supabase-inventory.sh

# 2. What is different?
python3 scripts/supabase-compare.py docs/inventory/*.json

# 3. What would a merge do? (nothing is executed)
scripts/supabase-merge.sh \
  --source docs/inventory/jvsyhtarnvmdilsgksdi.json \
  --target docs/inventory/czprjcskmzzagdztqonm.json \
  --out docs/inventory/dry-run.txt
```

Then, in order:

1. Read the comparison. Confirm or overturn the direction in
   [§2](#2-recommended-direction).
2. Run the preflight queries from the dry run on **both** projects. Resolve every
   advisory-key duplicate before going further.
3. Resolve auth users ([§8](#8-auth-users)). Invite anyone missing. Record the
   id mapping.
4. Back up the target. Record pre-merge counts.
5. Export the source's rows to JSON, re-run the dry run against real rows so it
   emits real statements, and read them.
6. Execute phase by phase, in a transaction, verifying before each commit.
7. Copy storage objects ([§9](#9-storage-objects)) and update the referencing
   columns.
8. Recompute `window_id_counters`, re-issue serials, `setval` the sequences.
9. Run every verification query in [§11](#11-verification).
10. Use the app for a week. Then pause the source project — do not delete it.
