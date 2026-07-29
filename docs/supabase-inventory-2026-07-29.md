# Every Supabase project, measured — 2026-07-29

The management token arrived, so the two projects nobody had ever read have now
been read. This is what is actually in them.

Everything below is measured, not inferred. Every query was a `SELECT` run
through `scripts/pgq.sh` or `scripts/supabase-inventory.sh`, both of which
refuse a non-`SELECT` statement. **Nothing was written to any database.** The
raw per-project JSON is committed under [`inventory/`](./inventory/) and the
merge dry run at
[`inventory/dry-run-jvsy-into-czpr.txt`](./inventory/dry-run-jvsy-into-czpr.txt).

## Contents

1. [The decision](#1-the-decision)
2. [Per-project inventory](#2-per-project-inventory)
3. [Field work versus setup data](#3-field-work-versus-setup-data)
4. [What the third project is](#4-what-the-third-project-is)
5. [Schema comparison](#5-schema-comparison)
6. [Data overlap](#6-data-overlap)
7. [Merge recommendation](#7-merge-recommendation)
8. [Where this contradicts the merge plan](#8-where-this-contradicts-the-merge-plan)
9. [Tooling bugs found and fixed](#9-tooling-bugs-found-and-fixed)

---

## 1. The decision

**Keep `czprjcskmzzagdztqonm`. Merge exactly one job into it — Black Desert —
from `jvsyhtarnvmdilsgksdi`. Delete `nbjmylctlklvazzlybts`, which is empty.**

The question the whole exercise was meant to answer was *where is the real field
work*. The answer is **nowhere**. Neither project has a single install event,
issue, QC check, job cost, job note or attachment. Not one of the 256 openings
across both databases has moved past `planned`, and not one has a measured rough
opening. Both databases are catalog, seed and planset-extraction output.

That makes the merge far lower-stakes than
[`supabase-merge-plan.md`](./supabase-merge-plan.md) assumed, and it moves the
decision onto different ground: not "which holds the irreplaceable data" but
"which is wired into the app, and what is genuinely new in the other".

`czprjcskmzzagdztqonm` wins the first on its own — it holds all six auth users
including both owners on company email addresses, the entire warehouse
(42 rack slots, 11 serialised windows, 6 movements, 5 window-id counters), the
130-type catalog, and it is the ref pinned in the app, both workflows and the CI
secrets.

For the second: of `jvsyhtarnvmdilsgksdi`'s 430 rows, only the **Black Desert**
job is new. Its "Smith Residence" is the Pecan Valley Building 14 job again —
same two source PDFs, and 105 of its 106 opening codes are identical to the ones
already in `czprjcskmzzagdztqonm`. Its "Oakridge" is an empty shell row with no
plansets, no openings and no specs. Its warehouse locations are the same seeded
racks. Its cost codes, tools, supplies and safety talks are the same seed rows.

So the merge is: **one job, three planset PDFs, and a decision about Ammon's
second login.** Everything else in that database is either a duplicate of
something already in the target or reproducible seed.

---

## 2. Per-project inventory

### `czprjcskmzzagdztqonm` — "Infinity Windows 1nfintyWindows"

| | |
| --- | --- |
| Org / region | `ipomvmrbigxqbmsamvdv` · `us-east-1` |
| Created | 2026-07-15 16:08:43 UTC |
| Status | `ACTIVE_HEALTHY` |
| Tables | 67 in `public` — 18 with rows, 49 empty |
| Rows | 374 |
| Migrations | **107** history rows · latest `20260729180333` |
| Auth users | 6 (2 have ever signed in) |
| Storage | 4 buckets · 6 objects · 13,297,736 bytes |
| Edge functions | 10 |
| Last real write | **2026-07-18 20:31 UTC** — dormant 11 days |

Auth users: `taylor@horizonsolarusa.com` (last sign-in 2026-07-20),
`ammon@horizonsolarusa.com` (2026-07-18), and four demo accounts that have never
signed in — `chris@`, `dave@`, `maria@`, `sam@crew.demo`.

Storage: `plansets` 4 objects / 13,278,477 bytes; `toolbox-records` 2 objects /
19,259 bytes; `install-media` and `trip-attachments` both empty.

Row counts: `window_types` 130, `project_openings` 109, `locations` 42,
`project_windows` 26, `windows` 11, `tools` 8, `safety_talks` 7, `cost_codes` 6,
`movements` 6, `profiles` 6, `supplies` 6, `window_id_counters` 5,
`project_plansets` 4, `access_requests` 3, `projects` 2, and
`installer_clearance`, `time_shifts`, `toolbox_completions` at 1 each.

**Migrations do not match the repo.** All 70 repo files are applied, but the
history table holds 107 rows — 37 versions with no corresponding file:

- 11 applied out of band between 2026-07-15 and 2026-07-20 (`20260715185858`,
  `20260717203358`, `20260717233830`, three on `20260718`, three on
  `20260719`, two on `20260720`).
- 26 written by the 2026-07-29 schema repair (`20260729175600` …
  `20260729180333`).

Two schema objects exist here that **no migration in the repo creates**: the
table `project_marks` (empty, and nothing references it — `project_mark_specs`
and `project_mark_elevation_views` both key on `projects` and
`project_plansets`) and the column `project_plansets.story_label`.

The last cost-code write is stamped 2026-07-29 17:56, but that is the repair's
`sort_order` backfill, not a person. The last time a human put data in this
database was 2026-07-18.

Edge functions were **4** when this audit began at 18:57 UTC and **10** by 19:03
UTC — another agent ran `deploy-backend` mid-audit. Row counts did not change.

### `jvsyhtarnvmdilsgksdi` — "isaacammonbarlow-max's Project 2"

| | |
| --- | --- |
| Org / region | `gdkmcyypdsmxmsdtdcgh` · `us-east-1` |
| Created | 2026-07-18 18:58:39 UTC |
| Status | `ACTIVE_HEALTHY` |
| Tables | 66 in `public` — 21 with rows, 45 empty |
| Rows | 430 |
| Migrations | **70** · latest `20260728170000` · **exactly the repo, zero drift** |
| Auth users | 1 (has signed in) |
| Storage | 4 buckets · 5 objects · 16,236,355 bytes |
| Edge functions | 5 |
| Last write | **2026-07-28 21:39 UTC** — active yesterday |

Auth user: `isaacammonbarlow@gmail.com`, created 2026-07-19 00:23, last sign-in
2026-07-19 00:24. One profile, "Ammon", role `owner`.

Storage: all five objects are in `plansets`, 16,236,355 bytes. The other three
buckets are empty.

Row counts: `project_openings` 147, `project_mark_specs` 61,
`project_mark_elevation_views` 54, `window_types` 54, `locations` 44,
`project_planset_pages` 14, `schedule_events` 12, `tools` 8, `safety_talks` 7,
`cost_codes` 6, `supplies` 6, `project_plansets` 5, `projects` 3,
`project_windows` 2, and `procedures`, `profiles`,
`schedule_assignment_members`, `schedule_assignments`, `trip_crew`, `trips`,
`vault_config` at 1 each.

Its three jobs:

| Job code | Name | Plansets | Openings | Mark specs | Elevation views |
| --- | --- | ---: | ---: | ---: | ---: |
| `BLACK22` | Black Desert | 3 | 42 | 37 | 54 |
| `SMITH` | Smith Residence | 2 | 105 | 24 | 0 |
| `OAKRIDGE` | Oakridge Apartments Bldg C | 0 | 0 | 0 | 0 |

Edge functions: `ask` v7, `extract-specs` v5, `ingest-knowledge` v3, `send-push`
v2, `vault-config` v2. All five are now also deployed on
`czprjcskmzzagdztqonm`.

### `nbjmylctlklvazzlybts` — "isaacammonbarlow-max's Project"

| | |
| --- | --- |
| Org / region | `gdkmcyypdsmxmsdtdcgh` · `ca-central-1` |
| Created | 2026-07-18 20:24:04 UTC |
| Status | `ACTIVE_HEALTHY` |
| Everything else | zero |

See [§4](#4-what-the-third-project-is).

---

## 3. Field work versus setup data

This is the table the decision was supposed to turn on, and it turns out to be
unanimous.

### Field activity

| Signal | `czprjcskmzzagdztqonm` | `jvsyhtarnvmdilsgksdi` |
| --- | ---: | ---: |
| `install_events` | 0 | 0 |
| `issues` | 0 | 0 |
| `qc_checks` | 0 | 0 |
| `job_costs` | 0 | 0 |
| `job_notes` | 0 | 0 |
| `attachments` | 0 | 0 |
| `incidents` | 0 | 0 |
| `safety_acks` | 0 | 0 |
| `task_sessions` | 0 | 0 |
| `time_shifts` | 1 | 0 |
| `project_marks` | 0 | table absent |
| `movements` (warehouse) | 6 | 0 |
| `toolbox_completions` | 1 | 0 |
| `install-media` objects | 0 | 0 |
| **Total field rows** | **8** | **0** |

### Openings — has anything moved?

| Signal | `czprjcskmzzagdztqonm` | `jvsyhtarnvmdilsgksdi` |
| --- | ---: | ---: |
| Openings total | 109 | 147 |
| Past `planned` | **0** | **0** |
| Status `assigned` / `installed` | 0 / 0 | 0 / 0 |
| Rough opening measured (`ro_width_in`/`ro_height_in`) | **0** | **0** |
| Condition checked (`condition <> 'unknown'`) | 0 | 0 |
| Assigned to a person | 1 | 6 |
| `work_started_at` set | 3 | 0 |
| `work_ended_at` set | 0 | 0 |
| Flagged | 0 | 0 |
| Window physically assigned | 0 | 0 |
| `confirmed` | 109 | **0** |
| Window types with a recorded install | 0 | 0 |

Two things worth noticing. First, the eight "field" rows in
`czprjcskmzzagdztqonm` — one time shift, six warehouse movements, one toolbox
completion — are all stamped 2026-07-18 within about a minute of each other.
That is somebody clicking through the app once, not a day's work. Second, all
109 openings in `czprjcskmzzagdztqonm` are `confirmed`, whereas all 147 in
`jvsyhtarnvmdilsgksdi` are `confirmed = false`, i.e. unreviewed extraction
drafts.

### Setup and derived data

Everything else in both databases falls into one of three buckets, none of which
is expensive to lose:

- **Seeded by migration** — `cost_codes` (6), `tools` (8), `safety_talks` (7),
  `supplies` (6), and the base warehouse `locations`. Identical in both.
- **Catalog** — `window_types`. 130 rows in `czprjcskmzzagdztqonm` (the ~100
  standard catalog plus Pecan Valley marks), 54 in `jvsyhtarnvmdilsgksdi`.
  Reproducible from `docs/window-catalog-100.sql`.
- **Extraction output** — `project_openings`, `project_mark_specs`,
  `project_mark_elevation_views`, `project_planset_pages`. Derived by
  `extract-specs` from planset PDFs. **Regenerable, as long as the PDFs
  survive.**

That last point is the one that shapes the recommendation. The only artifacts in
either database that cannot be recreated from something else are the **9 planset
PDFs** (29.5 MB across both) and the **2 signed toolbox records** in
`czprjcskmzzagdztqonm`.

---

## 4. What the third project is

**`nbjmylctlklvazzlybts` is a blank Supabase project that was created and never
touched. It can be ignored, and should be deleted.**

It was created 2026-07-18 20:24:04 UTC, 86 minutes *after*
`jvsyhtarnvmdilsgksdi`, in `ca-central-1` rather than `us-east-1`. It contains:

- 8 schemas, every one of them Supabase's own — `auth`, `extensions`, `graphql`,
  `graphql_public`, `public`, `realtime`, `storage`, `vault`.
- **0 tables in `public`.** Not empty tables — no tables.
- No `supabase_migrations` schema at all, so not one migration has ever run.
- 0 auth users, 0 storage buckets, 0 storage objects, 0 edge functions.
- 5 extensions, all stock: `pg_stat_statements`, `pgcrypto`, `plpgsql`,
  `supabase_vault`, `uuid-ossp`.

There is nothing to merge and nothing to lose. The likeliest story is a
mis-selected region on the first attempt, immediately abandoned and re-created
in `us-east-1` — which is consistent with the sibling being named "Project 2".

---

## 5. Schema comparison

From `scripts/supabase-compare.py`, comparing the two projects that have a
schema. `nbjmylctlklvazzlybts` is excluded and reported separately — see
[§9](#9-tooling-bugs-found-and-fixed).

| | Count |
| --- | ---: |
| Tables MISSING somewhere but holding data elsewhere | **0** |
| Tables missing somewhere, empty wherever they exist | 1 |
| Tables present in both with different row counts | 7 |
| Tables present in both and empty in both | 38 |
| Tables present in both with matching row counts | 4 |

Keeping the three states apart, as the tool insists on doing:

- **Table missing entirely:** exactly one — `project_marks`, present in
  `czprjcskmzzagdztqonm` and absent from `jvsyhtarnvmdilsgksdi`. It is empty in
  the one that has it, no repo migration creates it, and nothing references it.
  It is drift in the target, not a gap in the source.
- **Table exists but empty:** 38 tables are empty in both. A further 15 are
  empty in one and populated in the other — including the four that matter,
  `project_mark_specs` (0 / 61), `project_mark_elevation_views` (0 / 54),
  `project_planset_pages` (0 / 14) and `schedule_events` (0 / 12), all
  populated only in `jvsyhtarnvmdilsgksdi`.
- **Table exists with data in both:** 11 tables. Four match exactly
  (`cost_codes` 6, `safety_talks` 7, `supplies` 6, `tools` 8 — the seed) and
  seven differ (`locations` 42/44, `profiles` 6/1, `project_openings` 109/147,
  `project_plansets` 4/5, `project_windows` 26/2, `projects` 2/3,
  `window_types` 130/54).

One column difference in total: `project_plansets.story_label` exists only in
`czprjcskmzzagdztqonm`, and no repo migration adds it.

### Position relative to the repo's 70 migration files

| Project | History rows | Repo files applied | Extra versions | Verdict |
| --- | ---: | ---: | ---: | --- |
| `czprjcskmzzagdztqonm` | 107 | 70 / 70 | **37** | ahead of the repo, with unbacked schema objects |
| `jvsyhtarnvmdilsgksdi` | 70 | 70 / 70 | 0 | **exactly at repo tip** |
| `nbjmylctlklvazzlybts` | none | 0 / 70 | — | never initialised |

Neither project is *behind* the repo. The one carrying drift is the production
target, not the source — see [§8](#8-where-this-contradicts-the-merge-plan).

---

## 6. Data overlap

### The one that matters: `SMITH` is `PECAN14`

`jvsyhtarnvmdilsgksdi`'s **"Smith Residence"** and `czprjcskmzzagdztqonm`'s
**"Pecan Valley Town Homes — Building 14"** are the same real-world job.

- Same source documents. `SMITH` holds `PVTH_Bldg_14_Marked.pdf` and
  `PV_Townhomes_Bldg_14_Cads_2024-12-22_1_.pdf`; `PECAN14` holds
  `PVTH_Bldg_14_Marked.pdf` and `PV_Townhomes_Bldg_14_Cads_2024-12-22.pdf`. Same
  page counts, 4 and 6.
- **105 of `SMITH`'s 105 opening codes are also in `PECAN14`.** `PECAN14` has
  one extra, `W1`. The intersection is total.

Nothing about the names or job codes reveals this. Searching both databases for
"Pecan Valley Building 14" — the check
[`supabase-merge-plan.md`](./supabase-merge-plan.md) recommends — returns one
hit, and concludes there is no duplicate. There is; it is filed under a
different customer's name.

Merging `SMITH` would create a second copy of Building 14 with 105 duplicate
openings under a job code nobody recognises.

### `projects.job_code` — a real unique-constraint collision

`projects.job_code` carries `projects_job_code_key`, a UNIQUE index. `OAKRIDGE`
exists in both. The source row has 0 plansets, 0 openings and 0 mark specs — an
empty shell — so it should simply be dropped, not merged.

Net: of `jvsyhtarnvmdilsgksdi`'s three jobs, **one is new** (Black Desert), one
is a duplicate under a different name (Smith/Pecan Valley), one is empty
(Oakridge).

### `locations.serial` — colliding, but mostly not the way the plan expects

All 42 of `czprjcskmzzagdztqonm`'s `SLOT-` serials also exist in
`jvsyhtarnvmdilsgksdi` (which has 44). But comparing on
`(zone, rack, slot)` — which carries its own UNIQUE index,
`locations_zone_rack_slot_key` — **40 of the 44 are the same physical shelf**:
the same seeded warehouse layout, created in both databases from the same
migration.

The four that genuinely differ are per-job staging slots:
`J|PECAN14|A` and `J|PECAN14|B` exist only in `czprjcskmzzagdztqonm`;
`J|BLACK22|A`, `J|BLACK22|B`, `J|SMITH|A`, `J|SMITH|B` only in
`jvsyhtarnvmdilsgksdi`. Only two slots that exist in both carry different
serials — `J|OAKRIDGE|A` and `J|OAKRIDGE|B` are `SLOT-000039`/`SLOT-000040`
in the target and `SLOT-000041`/`SLOT-000042` in the source.

So `locations` needs **deduplication on `(zone, rack, slot)` with source serials
discarded**, not wholesale re-serialisation. Re-serialising all 44 would invent
40 shelves that do not exist.

`windows.serial` cannot collide at all: `jvsyhtarnvmdilsgksdi` has zero windows.

### `window_types.type_code` — six genuine conflicts

`window_types.type_code` carries `window_types_type_code_key`, UNIQUE. 35 codes
appear in both. Of those, 29 have identical names (the shared catalog seed) and
**6 name the same code for different windows**:

| `type_code` | `czprjcskmzzagdztqonm` | `jvsyhtarnvmdilsgksdi` |
| --- | --- | --- |
| `4A` | 6080 XO (#4A) | Mark #4A |
| `4B` | 3060 (#4B) | Mark #4B |
| `13A` | 8080 XO (#13A) | Mark #13A |
| `13B` | 3060 FIXED (#13B) | Mark #13B |
| `18A` | 8080 XO (#18A) | Mark #18A |
| `18B` | 3060 FIXED (#18B) | Mark #18B |

These are Building 14 mark codes that were resolved to real window descriptions
in the target and left generic in the source. Because the index is UNIQUE, a
merge either fails on these six or silently repoints the source's openings at
the target's differently-specified type. The remaining 19 source codes
(`Mark #22`–`Mark #39` and similar) are new and safe.

### `cost_codes.code` — the plan's Hazard 1, confirmed

Both projects hold the same six codes — `100`, `110`, `200`, `300`, `400`,
`900` — with identical labels and twelve distinct UUIDs. There is no unique
constraint. A naive union produces twelve cost codes and a doubled dropdown,
exactly as predicted. No duplicates exist *within* either project.

### Auth users — zero email overlap, and that is the problem

| Project | Emails |
| --- | --- |
| `czprjcskmzzagdztqonm` | `taylor@horizonsolarusa.com`, `ammon@horizonsolarusa.com`, `chris@`/`dave@`/`maria@`/`sam@crew.demo` |
| `jvsyhtarnvmdilsgksdi` | `isaacammonbarlow@gmail.com` |

The intersection is **empty**. That is not reassuring — both projects have a
profile named "Ammon" with role `owner`, and they are the same human under two
different email addresses. Matching on `auth.users.email`, which
[`supabase-merge-plan.md`](./supabase-merge-plan.md) §8 proposes as the only
reliable identity key, would conclude these are two different people.

The saving grace is scale: `jvsyhtarnvmdilsgksdi` has exactly one user, so this
is a single decision, not a mapping exercise. Either invite
`isaacammonbarlow@gmail.com` into the target, or attribute the merged rows to
the existing `ammon@horizonsolarusa.com` account. Everything in that database
was created by that one login.

### Storage

No path collisions: the five source objects and four target objects live under
different project-UUID prefixes. But two of the five source objects are the same
documents as two of the target's — the Building 14 planset (3,688,683 bytes) and
CAD set (2,212,428 bytes) — so copying all five would duplicate 5.9 MB of PDFs
already present.

The three Black Desert objects total 10,335,244 bytes, and two of them are
byte-identical in size (`Black_Desert_Windows_Plans.pdf`, 3,249,106 bytes,
uploaded twice 52 minutes apart on 2026-07-28). Only one of those two needs
copying.

### Overlap summary

| Key | Constraint | Target | Source | Overlap | Hazard |
| --- | --- | ---: | ---: | ---: | --- |
| `projects.job_code` | UNIQUE | 2 | 3 | 1 (`OAKRIDGE`) | source row is empty — drop it |
| Job identity (by planset + opening codes) | none | 2 | 3 | **1 (`SMITH` = `PECAN14`)** | **invisible to name matching** |
| `locations(zone,rack,slot)` | UNIQUE | 42 | 44 | 40 | same shelves — dedup, don't re-serialise |
| `locations.serial` | UNIQUE | 42 | 44 | 42 | mostly the same shelf; 2 genuinely differ |
| `window_types.type_code` | UNIQUE | 130 | 54 | 35 | 29 identical, **6 conflict** |
| `cost_codes.code` | **none** | 6 | 6 | 6 | silent duplication |
| `windows.serial` | UNIQUE | 11 | 0 | 0 | none |
| `project_plansets.storage_path` | none | 4 | 5 | 0 paths, 2 documents | duplicate PDFs |
| `auth.users.email` | UNIQUE | 6 | 1 | **0** | one person, two identities |

---

## 7. Merge recommendation

**Target: `czprjcskmzzagdztqonm`.** It holds the auth users, the warehouse, the
catalog, the signed safety records, and every reference in the repo, the
workflows and the CI secrets. Nothing measured here argues for switching, and
the one advantage `jvsyhtarnvmdilsgksdi` had — five edge functions deployed only
there — evaporated during this audit when all ten were deployed to the target.

**Merge exactly one thing: the Black Desert job** — **172 rows** in total:

| | Rows |
| --- | ---: |
| `projects` | 1 |
| `project_plansets` | 3 (two are the same file uploaded twice) |
| `project_openings` | 42 |
| `project_mark_specs` | 37 |
| `project_mark_elevation_views` | 54 |
| `project_planset_pages` | 14 (all 14 in the database are Black Desert's) |
| `window_types` not already present | 19 |
| `locations` staging slots | 2 |

Optionally the 12 `schedule_events`, 1 `trip`, 1 `trip_crew`, 1 `procedures` and
1 `vault_config` row, all of which are trivial.

**Do not merge:** `SMITH` (a duplicate of `PECAN14`), `OAKRIDGE` (empty shell),
`locations` beyond the two Black Desert staging slots (same seeded warehouse),
`cost_codes`/`tools`/`supplies`/`safety_talks` (identical seed), and the 29
already-present window types.

### Preferred method: re-extract rather than move rows

Every Black Desert row is **derived output** — `extract-specs` produced the
openings, mark specs, elevation views and planset pages from three PDFs. That
function is now deployed on the target. So the cheapest and safest path is:

1. Copy the three Black Desert PDFs out of the source `plansets` bucket
   (`Black_Desert_Windows_Pictures.pdf`, and the two uploads of
   `Black_Desert_Windows_Plans.pdf` — check whether the second supersedes the
   first before copying both).
2. Create the Black Desert project row in the target through the app.
3. Upload the PDFs and run extraction there.

This sidesteps the entire hazard list: no UUID remapping, no serial re-issue, no
`type_code` conflicts (extraction creates whatever types it needs against the
target's existing catalog), no auth remap, no FK ordering. The 42 openings are
unconfirmed drafts in the source anyway, so nothing reviewed is lost by
regenerating them.

The risk is that extraction is not perfectly deterministic and produces a
slightly different set of openings than the 42 currently in the source. Given
that all 42 are unreviewed and no field work references them, that is an
acceptable difference — but confirm the count afterwards.

### If a row-level merge is required instead

Follow [`supabase-merge-plan.md`](./supabase-merge-plan.md)'s FK ordering, with
these amendments from the real data:

- Filter every table to `project_id = 'ebf64f94-0413-4434-aeb3-1aff228fb5b3'`
  (Black Desert). Do not move `SMITH` or `OAKRIDGE`.
- `locations`: dedup on `(zone, rack, slot)`. Move only `J|BLACK22|A` and
  `J|BLACK22|B`; discard the source `serial` values and issue fresh ones above
  `SLOT-000042`.
- `window_types`: move only the 19 codes not already in the target. Resolve
  `4A`, `4B`, `13A`, `13B`, `18A`, `18B` by hand — the target's names are more
  specific and are probably right.
- `cost_codes`, `tools`, `supplies`, `safety_talks`: move nothing.
- Attribute all moved rows to `ammon@horizonsolarusa.com` unless
  `isaacammonbarlow@gmail.com` is invited into the target first.

### Then

Pause `jvsyhtarnvmdilsgksdi` — do not delete it — until the target has been used
for a working week. Delete `nbjmylctlklvazzlybts` now; it has never held
anything.

### About the dry run

[`inventory/dry-run-jvsy-into-czpr.txt`](./inventory/dry-run-jvsy-into-czpr.txt)
reports **"BLOCKERS — none found"**. That is true and misleading. The dry run
reads inventory JSON, which carries table names, row counts and column names but
**no row values**, and its only blocker condition is "table holds source rows but
does not exist in the target". It therefore cannot see the `OAKRIDGE` job-code
collision, the six `type_code` conflicts, or the `SMITH`/`PECAN14` duplicate.

Read "no blockers" as **"no schema blockers"**. The data blockers are in
[§6](#6-data-overlap), and they are real.

---

## 8. Where this contradicts the merge plan

[`supabase-merge-plan.md`](./supabase-merge-plan.md) was written before anyone
could read the source. Its direction holds. Six of its specifics do not.

**1. The drift is in the target, not the source.** §2 argues for
`czprjcskmzzagdztqonm` partly because it is "already at zero schema drift" while
"Ammon's project's migration state is unknown; if it is behind…". It is not
behind. `jvsyhtarnvmdilsgksdi` has applied exactly the repo's 70 migrations and
nothing else. `czprjcskmzzagdztqonm` has 107 history rows, 37 of them with no
repo file, plus a table (`project_marks`) and a column
(`project_plansets.story_label`) that no migration creates. The target is the
drifted one. This does not overturn the direction — the other reasons are
stronger — but the argument as written is backwards.

**2. Hazard 2 overstates the serial problem.** The plan says `SLOT-000001`…
`SLOT-000042` "mean different physical things in each project" and that "every
merged `locations` and `windows` row needs a fresh serial", with a warehouse
walk to reprint labels. In fact 40 of 44 source locations are the *same shelf*
as the target's, seeded identically by the same migration. Re-serialising all of
them would create 40 shelves that do not exist. The correct operation is a dedup
on `(zone, rack, slot)`; only the 2 Black Desert staging slots need new serials.
And `windows` cannot collide at all — the source has none.

**3. Hazard 3's identity key does not work.** §8 proposes `auth.users.email` as
the only way to tell whether two profiles are one person. The two projects share
**zero** emails, yet both hold an owner profile named "Ammon" who is the same
person under `ammon@horizonsolarusa.com` and `isaacammonbarlow@gmail.com`. Email
equality would return "different people". The problem is smaller than feared —
one user, one decision — but the proposed method would have got it wrong.

**4. The duplicate-detection test as written misses the duplicate.** The plan
directs a search for the same job name across projects, naming "Pecan Valley
Building 14" as the example. That search finds nothing, because the duplicate is
filed as "Smith Residence" with job code `SMITH`. Job identity has to be checked
on **source planset filename and opening-code intersection**, not on `name` or
`job_code`.

**5. The premise that the source might hold "substantially more real data" is
answerable, and the answer is no.** §2's caveat says to revisit the direction if
the inventory shows more data on the other side. It shows 430 rows against 374 —
but zero field rows against eight, and after removing the duplicate job, the
empty job, and the shared seed, 172 rows of genuinely new material for a single
job. The caveat does not fire.

**6. The one advantage of the other direction is gone.** §2 concedes that
Ammon's newer edge functions are already deployed on his project. As of
2026-07-29 19:03 UTC all ten functions are deployed on `czprjcskmzzagdztqonm`.

**7. There is a third project, and it is empty.** §1 anticipated this
possibility correctly. `nbjmylctlklvazzlybts` exists and holds nothing at all.

Unchanged and confirmed: Hazard 1 (`cost_codes.code` duplicates — exactly six
pairs, as predicted), the FK dependency ordering, the refusal to implement
`--execute`, and the instruction to pause rather than delete the source.

---

## 9. Tooling bugs found and fixed

Three, all fixed in this change and covered by
`scripts/test_supabase_merge.py` (52 tests, passing).

**1. `scripts/supabase-inventory.sh` could not inventory a brand-new project.**
The migration query guarded a subquery with
`case when to_regclass('supabase_migrations.schema_migrations') is null`, but the
planner resolves every relation reference before any branch is evaluated, so the
whole statement failed to parse against `nbjmylctlklvazzlybts` — the one project
the guard existed for. Fixed by naming the relation inside a string literal
passed to `query_to_xml`, which defers resolution to run time where the `CASE`
really does short-circuit.

**2. `--project` silently blanked project metadata.** In `--project` mode the
script wrote `[]` as the project list, so name, region, org and creation date all
came out `null` — and overwrote a good full-run inventory file with a worse one.
Fixed by fetching the project list for metadata even when refs are named
explicitly, degrading gracefully if that call fails.

**3. `scripts/supabase-compare.py` let one empty project bury every real
finding.** Including `nbjmylctlklvazzlybts` made all 67 tables report
`MISSING WHERE DATA EXISTS ELSEWHERE`, turned the summary into 28 false
"schema gap with real data at stake" entries, and made the tool exit non-zero —
the opposite of the truth, since an empty project has nothing to merge. Fixed by
reporting a project with no `public` schema at all separately, under
"NOT COMPARED", and excluding it from the table comparison. The check is
specifically "zero tables", not "zero rows": a project whose tables exist and are
empty still has a schema and is compared normally, because empty and missing are
exactly the distinction this tool exists to preserve.

A fourth issue is a limitation rather than a bug, and is not fixed: the merge
dry run's blocker detection is structural only, and cannot see value-level
collisions. See the note at the end of [§7](#7-merge-recommendation).
