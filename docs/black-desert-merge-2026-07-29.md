# Black Desert is now in production — 2026-07-29

**Date:** 2026-07-29, 19:24–19:40 UTC. **Target:** `czprjcskmzzagdztqonm`
(production). **Source:** `jvsyhtarnvmdilsgksdi` (Ammon's project).

## The short version, for anyone who does not read SQL

There was one real job sitting in the wrong database — **Black Desert**. It is
now in the database the app actually uses, with all 42 of its window openings and
all three of its plan PDFs. Anyone signed in to the app can open it.

Two other jobs in that database were **deliberately left behind**. One of them,
"Smith Residence", turned out to be the Pecan Valley Building 14 job entered a
second time under a different customer name. Copying it across would have created
a second Building 14 and could have sent crews to a job that does not exist. It
was not copied, and Building 14 still appears exactly once. The other, "Oakridge
Apartments Bldg C", was an empty placeholder with nothing in it.

Nothing was deleted, nothing was overwritten, and nothing at all was written to
Ammon's databases. This is the last piece of the two-database consolidation.

---

## Contents

1. [What was inserted](#1-what-was-inserted)
2. [Before and after counts](#2-before-and-after-counts)
3. [Decisions applied](#3-decisions-applied)
4. [What was deliberately not merged](#4-what-was-deliberately-not-merged)
5. [How it was done safely](#5-how-it-was-done-safely)
6. [Verification](#6-verification)
7. [Rollback](#7-rollback)
8. [Known gap, and the follow-up it implies](#8-known-gap-and-the-follow-up-it-implies)

---

## 1. What was inserted

**170 rows in one transaction, insert-only, plus three storage objects.**

| # | Table | Rows | Notes |
| --- | --- | ---: | --- |
| 1 | `window_types` | 19 | The 19 mark codes Black Desert needs that production did not have (`13`, `18`, `22`–`39`). All have `golden_install_event_id` NULL, so the FK cycle is never exercised. |
| 2 | `projects` | 1 | `BLACK22` · "Black Desert" · 2026-08-05 → 2026-08-26 |
| 3 | `project_plansets` | 3 | `Black_Desert_Windows_Pictures.pdf` (specs, 14pp) and two uploads of `Black_Desert_Windows_Plans.pdf` (building, 4pp) |
| 4 | `project_planset_pages` | 14 | All 14 belong to the specs planset |
| 5 | `project_mark_specs` | 37 | |
| 6 | `project_mark_elevation_views` | 54 | |
| 7 | `project_openings` | 42 | Exactly the source's 42, same opening codes |
| | **Total** | **170** | |

Storage, into production's `plansets` bucket under `ebf64f94-0413-4434-aeb3-1aff228fb5b3/`:

| Object | Bytes | MD5 verified against source |
| --- | ---: | --- |
| `1785247643865-Black_Desert_Windows_Pictures.pdf` | 3,837,032 | yes |
| `1785253853208-Black_Desert_Windows_Plans.pdf` | 3,249,106 | yes |
| `1785256963527-Black_Desert_Windows_Plans.pdf` | 3,249,106 | yes |
| **Total** | **10,335,244** | |

The two `..._Plans.pdf` uploads are byte-identical (same MD5, uploaded 52 minutes
apart on 2026-07-28), confirming what the inventory suspected. Both `project_plansets`
rows were kept so production is an exact mirror of the source job rather than a
tidied-up version of it; the elevation views hang off the later of the two.

Uploads used `x-upsert: false`, so a path collision would have been an error, not
a silent overwrite. Source objects were downloaded only — the source bucket still
holds its five objects and 16,236,355 bytes.

### The 170 vs 172 difference

[`supabase-inventory-2026-07-29.md`](./supabase-inventory-2026-07-29.md) §7 sizes
Black Desert at **172** rows, including two `locations` staging slots
(`J|BLACK22|A`, `J|BLACK22|B`). Those two rows were **excluded on instruction** —
production's warehouse is authoritative and its `locations`/`windows` counts had
to come out unchanged. See [§8](#8-known-gap-and-the-follow-up-it-implies).

---

## 2. Before and after counts

Exact counts, taken with `count(*)` per table (never
`pg_stat_user_tables.n_live_tup`), immediately before the write and again after.
All 67 `public` base tables were counted; the 46 that are empty on both sides are
omitted below and are all still empty.

| Table | Before | After | Delta |
| --- | ---: | ---: | ---: |
| `access_requests` | 3 | 3 | 0 |
| `cost_codes` | 6 | 6 | 0 |
| `installer_clearance` | 1 | 1 | 0 |
| `locations` | 42 | 42 | 0 |
| `movements` | 6 | 6 | 0 |
| `profiles` | 6 | 6 | 0 |
| `project_mark_elevation_views` | 0 | 54 | **+54** |
| `project_mark_specs` | 0 | 37 | **+37** |
| `project_openings` | 109 | 151 | **+42** |
| `project_planset_pages` | 0 | 14 | **+14** |
| `project_plansets` | 4 | 7 | **+3** |
| `project_windows` | 26 | 26 | 0 |
| `projects` | 2 | 3 | **+1** |
| `safety_talks` | 7 | 7 | 0 |
| `supplies` | 6 | 6 | 0 |
| `time_shifts` | 1 | 1 | 0 |
| `toolbox_completions` | 1 | 1 | 0 |
| `tools` | 8 | 8 | 0 |
| `window_id_counters` | 5 | 5 | 0 |
| `window_types` | 130 | 149 | **+19** |
| `windows` | 11 | 11 | 0 |
| **Total, all 67 tables** | **374** | **544** | **+170** |

Every delta is Black Desert. Proven not just by count but by content: the full
row-level export taken before the write was diffed against a full row-level
export taken after, and **zero pre-existing rows were altered or removed**. Of
the 170 rows that are new, every one carries `project_id =
ebf64f94-0413-4434-aeb3-1aff228fb5b3` (or, for `project_planset_pages`, a
`planset_id` belonging to it; or, for `window_types`, an id used by a Black Desert
opening and by nothing else).

Auth: **6 users before, 6 after**, same six addresses. No user was created and
none was invited.

Source project: **430 rows before, 430 rows after.** Three jobs before, three
jobs after, one auth user, five storage objects. Nothing was written to it.
`nbjmylctlklvazzlybts` still has zero tables in `public`.

---

## 3. Decisions applied

### Ammon's second login → attributed to his work account

The two databases share no email address: Ammon is
`ammon@horizonsolarusa.com` in production and `isaacammonbarlow@gmail.com` in the
source. Same person. Owner's decision was to attribute the job to the existing
production account and **not** create a new auth user or invite the Gmail
address.

That turned out to need no rewriting at all. Every person-shaped column on the
Black Desert rows is already NULL in the source — `projects.green_light_by`, and
`project_openings.assigned_to` / `assigned_by` / `flagged_by` on all 42 openings.
The source auth id `70366300-…` therefore never entered production; it was
asserted absent from the generated payload before the write and confirmed absent
from production afterwards. The job simply belongs to production's own six
accounts, of which Ammon's work account is one.

### Six conflicting `window_types.type_code` values → production's names kept

`type_code` is UNIQUE, and six codes name different windows in the two databases:

| `type_code` | Production (kept) | Source (discarded) |
| --- | --- | --- |
| `4A` | 6080 XO (#4A) | Mark #4A |
| `4B` | 3060 (#4B) | Mark #4B |
| `13A` | 8080 XO (#13A) | Mark #13A |
| `13B` | 3060 FIXED (#13B) | Mark #13B |
| `18A` | 8080 XO (#18A) | Mark #18A |
| `18B` | 3060 FIXED (#18B) | Mark #18B |

Production's descriptive names are kept, unchanged. No `UPDATE` was needed to
achieve that, because **all six codes are used only by `SMITH`** (verified: 1–3
openings each, all on `SMITH`, none on Black Desert). Excluding `SMITH` excluded
the conflict. Production's six rows were re-read after the merge and still carry
the descriptive names.

### Black Desert's other 19 window types → remapped, not duplicated

Black Desert's 42 openings reference 38 window types. 19 of those already exist in
production under the same `type_code` **and the same name** — codes `1`–`12`,
`14`–`17` and `19`–`21`, all named `Mark #<n>` on both sides. Those 19 were not
inserted; each opening's
`window_type_id` was rewritten to production's existing row. The other 19 were
genuinely new and were inserted. 19 + 19 = 38, and `window_types` moved 130 → 149.

### Primary keys → source UUIDs kept, deliberately

The merge plan's §6 remapping machinery was not needed. Every UUID due to be
inserted was checked against production's existing ids in the same table first,
and **all 157 of them were free** (1 project, 3 plansets, 42 openings, 37 mark
specs, 54 elevation views, 19 window types, and the source profile id). Keeping
the source ids means the `plansets` storage paths — which are keyed on the project
UUID — needed no rewriting, which removes the whole class of path-prefix bug
described in the merge plan's §9.

---

## 4. What was deliberately not merged

### `SMITH` — "Smith Residence" is Pecan Valley Building 14, entered twice

**This is the single most important exclusion, and it was re-verified against the
live databases before the write, not taken on trust.**

- **105 of `SMITH`'s 105 opening codes are already in production's `PECAN14`.**
  The intersection is total. `PECAN14` has one extra, `W1`.
- Same source documents: `SMITH` holds `PVTH_Bldg_14_Marked.pdf` and
  `PV_Townhomes_Bldg_14_Cads_2024-12-22_1_.pdf`; `PECAN14` holds
  `PVTH_Bldg_14_Marked.pdf` and `PV_Townhomes_Bldg_14_Cads_2024-12-22.pdf`.

Nothing in the name or the job code says so — the duplicate is filed under a
different customer. Merging it would have produced a second Building 14 with 105
duplicate openings under a job code nobody recognises, and crews could have been
dispatched to it.

After the merge, production holds **exactly one** Pecan Valley Building 14, by
name and by job code, with its opening count unchanged at **106**.

### `OAKRIDGE` — empty shell, and a UNIQUE collision

`projects.job_code` carries `projects_job_code_key`. `OAKRIDGE` exists in both
databases. The source row has 0 plansets, 0 openings and 0 mark specs; production's
has 2 plansets and 3 openings. The source row was dropped. Its 2
`project_windows` rows went with it — they are the only `project_windows` rows in
the source and they belong to `OAKRIDGE`, not to Black Desert.

### `locations` and `windows` — not touched at all

40 of the source's 44 `locations` are the *same physical shelf* as production's,
by `(zone, rack, slot)`, seeded identically by the same migration. Production's
warehouse is authoritative and complete. Both counts came out unchanged (42 and
11). The source has zero `windows`, so nothing could have collided there anyway.

### Seed tables — nothing moved

`cost_codes`, `tools`, `supplies`, `safety_talks` are the same migration seed in
both databases with different UUIDs, and `cost_codes` has **no unique
constraint** — a naive union would have silently produced twelve cost codes and a
doubled dropdown. Nothing was inserted into any of them. `cost_codes` is still 6,
with no duplicate `code`.

### Odds and ends left in the source

`schedule_events` (12), `trips` (1), `trip_crew` (1), `procedures` (1) and
`vault_config` (1) are listed as optional in the inventory. None of them
references Black Desert (`schedule_events` has no `project_id` column at all;
`trips` has zero rows for this project), so all were left behind. `vault_config`
is one device-PIN hash and is a human decision, not a merge.

---

## 5. How it was done safely

### Fresh verified backup, taken immediately before the write

`docs/backups/2026-07-29T1924Z-czprjcskmzzagdztqonm-full.json` — same format as
the earlier `…T1200Z…` file (an `exported_at`, a `project_id`, and one key per
non-empty table holding every column of every row). 374 rows across 18 non-empty
tables.

It was **verified before the merge proceeded**: every one of the 67 `public` base
tables was re-counted in the live database and compared against the row count in
the file. All 67 matched. Had any disagreed, the merge would not have run.

### One transaction, with post-conditions that abort it

The whole thing is a single `begin; … commit;` containing seven `INSERT`s in
foreign-key dependency order (`window_types` → `projects` → `project_plansets` →
`project_planset_pages` → `project_mark_specs` →
`project_mark_elevation_views` → `project_openings`), followed by a `DO` block of
**22 post-conditions**. Any one of them raises, which aborts the transaction and
turns the trailing `commit` into a rollback. The post-conditions include the
total row count, the per-table counts, "PECAN14 openings = 106", "Pecan Valley
appears once", "`locations` = 42", "`windows` = 11", "`cost_codes` = 6",
"`auth.users` = 6", zero duplicate `type_code`/`job_code`, zero orphaned foreign
keys on every inserted table, and zero rows referencing the source login.

Rows were supplied as JSON to `jsonb_populate_recordset(null::public.<table>, …)`
rather than as hand-quoted literal tuples, so column mapping is by name and
`project_plansets.story_label` — which exists in production and not in the source
— simply arrives NULL. `locations.address` is a generated column and would reject
any INSERT that named it; `locations` was not inserted into at all.

### Rehearsed twice before it was committed

1. **Dry run.** The identical transaction, with `rollback` in place of `commit`.
   All 22 post-conditions passed and the projected post-state was returned.
   Production was then re-read: still 374 rows.
2. **Guard test.** One expected value was deliberately falsified
   (`PECAN14 openings = 999`). The run failed with
   `P0001: post-condition failed: PECAN14 openings unchanged = 106 (expected 999)`
   and production was re-read again: still 374 rows, 2 projects, 130 window types.
   That proves the abort path works rather than assuming it.

Only then was the same SQL run with `commit`.

### Insert-only, and no path to the wrong database

No `UPDATE`, `DELETE`, `DROP`, `ALTER` or `TRUNCATE` was issued against
production. `scripts/pgq.sh` refuses non-`SELECT` statements, so the writes went
through a separate helper that keeps the same discipline and adds to it: the
project ref is a required argument with no default, writes additionally require
an explicit `--write` flag **and** a `SB_WRITE_ALLOWED_REF` environment variable
that must equal the ref, and `jvsyhtarnvmdilsgksdi` and `nbjmylctlklvazzlybts`
are on a hard-coded deny list that no combination of arguments can override. A
guessed ref has already caused one incident on this project
(`docs/migration-drift-2026-07-29-production.md`); two independent statements of
intent are now needed before a single row can be written.

Storage was copied before the database rows were inserted, so the job was never
in the state the consolidation assessment warns about — listed in the app with
plansets that cannot be opened.

---

## 6. Verification

All of the following was read back out of the live database after the commit.

| Check | Result |
| --- | --- |
| Total `public` rows | 374 → **544** (+170, every row Black Desert) |
| Pre-existing rows altered or removed | **0** (full row-level diff, before vs after) |
| `projects` | 2 → **3**; exactly one `BLACK22` |
| Black Desert openings | **42** — exactly the source's 42, same opening codes |
| Pecan Valley Building 14 | **appears exactly once** by name and by `job_code`; openings unchanged at **106** |
| Duplicate `job_code` / `type_code` / `cost_codes.code` / `locations.address` | **0 / 0 / 0 / 0** |
| The six conflicting type codes | still production's descriptive names |
| `locations` / `windows` | **42 / 11** — unchanged |
| `auth.users` | **6** — unchanged, same six addresses, none created |
| Profiles that are not auth users | **0** |
| Rows referencing the source login `70366300-…` | **0** |
| Orphaned FKs (opening→type, opening→planset, spec→planset, view→planset, page→planset) | **0** on all five |
| `project_plansets` rows with no matching storage object | **0** |
| `window_id_counters` behind the highest issued `window_id` | **0** |
| Source project `jvsyhtarnvmdilsgksdi` | **430 rows** — unchanged; 5 storage objects, 16,236,355 bytes; 1 auth user |
| `nbjmylctlklvazzlybts` | 0 tables in `public` — untouched |

### Storage

All three objects present in production's `plansets` bucket at matching byte
sizes, and MD5-identical to the source after a round trip back out of production.
All three also fetch cleanly through a **signed URL** — the same path
`app/src/lib/install/api.ts` uses — returning HTTP 200 and a `%PDF-` header.

### Read back as the app sees it

Two ways, because "the row exists" and "the app can use it" are different claims.

**Through PostgREST, with the app's own select string** (`OPENING_SELECT` in
`app/src/lib/install/api.ts` line 30):

```
GET /rest/v1/project_openings
    ?select=*, window_types(*), windows:assigned_window_id(*), projects(*), assignee:assigned_to(*)
    &project_id=eq.ebf64f94-0413-4434-aeb3-1aff228fb5b3
    &order=opening_code
```

HTTP 200, **42 openings**. Every one resolves its embedded `projects` row
(`BLACK22` · Black Desert · 2026-08-05 → 2026-08-26) and its embedded
`window_types` row; **0** openings failed to resolve either. 38 distinct window
types across the job. Opening codes: `1-1, 1-2, 10, 11, 12-1, 12-2, 13-1, 13-2,
14, 15, 16, 17, 18, 19, 2-1, 2-2, 20, 21, 22, 23, 24, 26, 27, 28, 29, 3, 30, 31,
32, 33, 34, 35, 36, 37, 38, 39, 4, 5, 6, 7, 8, 9`.

**Under row-level security, as a signed-in user.** The above runs as
`service_role`, which bypasses RLS, so the same reads were repeated inside a
transaction with `set local role authenticated` and Ammon's production `sub`:

| Visible to `ammon@horizonsolarusa.com` | |
| --- | ---: |
| `projects` | 3 |
| Black Desert | 1 |
| its openings | 42 |
| its plansets | 3 |
| its mark specs | 37 |
| its elevation views | 54 |
| its planset pages | 14 |
| `window_types` | 149 |

So this is a usable job with its openings attached, not an orphaned shell.

### What has not changed about the job's state

Black Desert's 42 openings arrive exactly as they were in the source:
`status = 'planned'`, `confirmed = false`, no rough openings measured, nobody
assigned. They are unreviewed extraction drafts, which is what they were. There
is still **no field work anywhere** in production — `install_events`, `issues`,
`qc_checks`, `job_costs`, `job_notes` and `attachments` are all 0, and no opening
in the database has moved past `planned`.

---

## 7. Rollback

### The backup

`docs/backups/2026-07-29T1924Z-czprjcskmzzagdztqonm-full.json` — production
exactly as it stood at 2026-07-29 19:24 UTC, immediately before the write, and
verified table-by-table against the live database at that moment. 374 rows, 18
non-empty tables.

Also take a Supabase point-in-time restore from the dashboard before running
anything below; that is the real restore path if the statements themselves go
wrong.

### Undoing the merge

Because the merge was insert-only and touched nothing that already existed,
undoing it is a delete of exactly the 170 rows that were added, in reverse
dependency order. Run as one transaction and read the counts before committing.

```sql
begin;

delete from public.project_openings
 where project_id = 'ebf64f94-0413-4434-aeb3-1aff228fb5b3';

delete from public.project_mark_elevation_views
 where project_id = 'ebf64f94-0413-4434-aeb3-1aff228fb5b3';

delete from public.project_mark_specs
 where project_id = 'ebf64f94-0413-4434-aeb3-1aff228fb5b3';

delete from public.project_planset_pages
 where planset_id in (
   select id from public.project_plansets
    where project_id = 'ebf64f94-0413-4434-aeb3-1aff228fb5b3');

delete from public.project_plansets
 where project_id = 'ebf64f94-0413-4434-aeb3-1aff228fb5b3';

delete from public.projects
 where id = 'ebf64f94-0413-4434-aeb3-1aff228fb5b3';

-- The 19 window types added for this job. The `not exists` guard is what keeps
-- this safe: it refuses to remove a type that some other job has started using.
delete from public.window_types
 where type_code in ('13','18','22','23','24','26','27','28','29','30','31',
                     '32','33','34','35','36','37','38','39')
   and not exists (select 1 from public.project_openings o
                    where o.window_type_id = window_types.id);

-- Expect 374. Anything else means stop and restore from the backup instead.
select sum(n) as total_rows from (
  select (xpath('/row/c/text()', query_to_xml(
    format('select count(*) as c from %I.%I', t.table_schema, t.table_name),
    false, true, '')))[1]::text::bigint as n
    from information_schema.tables t
   where t.table_schema = 'public' and t.table_type = 'BASE TABLE') s;

rollback;  -- change to commit once the count above reads 374
```

Then remove the three storage objects, which the deletes above do not touch:

```
plansets/ebf64f94-0413-4434-aeb3-1aff228fb5b3/1785247643865-Black_Desert_Windows_Pictures.pdf
plansets/ebf64f94-0413-4434-aeb3-1aff228fb5b3/1785253853208-Black_Desert_Windows_Plans.pdf
plansets/ebf64f94-0413-4434-aeb3-1aff228fb5b3/1785256963527-Black_Desert_Windows_Plans.pdf
```

Nothing needs to be recovered from the source: `jvsyhtarnvmdilsgksdi` still holds
its own untouched copy of all of it. Per the merge plan, **pause that project
rather than deleting it**, and not until the app has been used against production
for a full working week.

---

## 8. Known gap, and the follow-up it implies

> **Closed on 2026-07-29.** The two bays now exist. See
> [`black-desert-staging-bays-2026-07-29.md`](./black-desert-staging-bays-2026-07-29.md),
> which also corrects two details below: the addresses are `J-BLACK22-A` and
> `J-BLACK22-B` (the generated column joins with `-`, not `|`), and the serials
> are `SLOT-000051`/`SLOT-000052`, not `SLOT-000043`/`SLOT-000044`, because
> rehearsing the write drew from the sequence and sequences do not roll back.
> That write-up also names the wider product gap: nothing in the system
> guarantees a job has its bays, and when one does not, the app silently suggests
> a general stock shelf instead of saying so.

**Black Desert has no warehouse staging bays in production.**

`createProject` in `app/src/lib/api.ts` lines 128–131 creates two `locations`
rows for every new job — `J|<JOBCODE>|A` and `J|<JOBCODE>|B`, capacity 10 each —
which is where windows for that job get staged and which show up under "Job
staging" in the Labels screen. The source has them for `BLACK22` (`SLOT-000043`
and `SLOT-000044`); production has `J|OAKRIDGE|A/B` and `J|PECAN14|A/B` but now
has Black Desert without a pair, because `locations` had to come out unchanged.

Nothing is broken today: Black Desert has no `windows` assigned to it anywhere,
and the source had none either, so there is nothing to stage yet. But the first
time someone tries to receive or stage a window for this job, the bay will not be
in the list.

The fix is two rows and is deliberately **not** part of this change, since it
writes to the warehouse:

```sql
insert into public.locations (zone, rack, slot, capacity)
values ('J', 'BLACK22', 'A', 10), ('J', 'BLACK22', 'B', 10);
```

Do not name `serial` or `address` in that INSERT. `serial` has a column default
that draws from `location_serial_seq` (currently at 42, so the two new bays would
get `SLOT-000043` and `SLOT-000044` — the same serials they carry in the source,
by coincidence rather than by design), and `address` is a generated column that
Postgres rejects any INSERT from naming. Two physical shelf labels would need
printing. Worth doing before the job starts on 2026-08-05.

---

## Where this leaves the consolidation

This was the last piece. Production `czprjcskmzzagdztqonm` now holds all three
jobs, all six logins, the whole warehouse and the whole catalog, and it is the ref
pinned in the app, the workflows and the CI secrets. Remaining steps, all of them
somebody else's call:

1. Use the app against production for a working week.
2. Then **pause** `jvsyhtarnvmdilsgksdi`. Do not delete it.
3. `nbjmylctlklvazzlybts` has never held anything and can be deleted whenever.
4. ~~Add the two `J|BLACK22|*` staging bays~~ — **done**, see
   [`black-desert-staging-bays-2026-07-29.md`](./black-desert-staging-bays-2026-07-29.md).
   Two physical shelf labels still need printing.
