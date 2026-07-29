# Black Desert has warehouse staging bays — 2026-07-29

**Date:** 2026-07-29, 19:42–19:58 UTC. **Target:** `czprjcskmzzagdztqonm`
(production). **Closes** the known gap left open by
[`black-desert-merge-2026-07-29.md`](./black-desert-merge-2026-07-29.md) §8 and
PR [#152](https://github.com/Infinity-Windows/infinity-windows/pull/152).

## The short version, for anyone who does not read SQL

Every job in the app gets two shelves in the warehouse where its windows are
stacked before they go out — a bay "A" and a bay "B". When Black Desert was
brought into the live database yesterday, its two bays were deliberately left
out, because that change had promised not to touch the warehouse.

Those two bays now exist. **This is already live.** A foreman receiving a Black
Desert window will now be offered `J-BLACK22-A` and `J-BLACK22-B`, and the app
will suggest bay A automatically, the same way it does for the other two jobs.

Before this, the app did not show an error — it quietly suggested a general
stock shelf (`S-01-C`) instead. Black Desert windows would have been put away
with everybody else's rather than kept together for the job, and nobody would
have been told. The job starts on 5 August, so this is fixed before any window
arrives. **Two physical shelf labels still need printing** from the Slot labels
screen — that part is not something software can do.

Nothing else changed. Nothing was deleted or overwritten, no existing shelf was
altered, and nothing at all was written to Ammon's databases.

There is also a wider problem worth naming, which is not fixed here and is not a
Black Desert problem: **nothing in the system guarantees a job has its bays.**
See [§7](#7-the-product-gap-this-exposes).

---

## Contents

1. [What was inserted](#1-what-was-inserted)
2. [Before and after counts](#2-before-and-after-counts)
3. [Getting the shape right](#3-getting-the-shape-right)
4. [How it was done safely](#4-how-it-was-done-safely)
5. [Verification — present *and* usable](#5-verification--present-and-usable)
6. [Ammon's projects](#6-ammons-projects)
7. [The product gap this exposes](#7-the-product-gap-this-exposes)
8. [Rollback](#8-rollback)

---

## 1. What was inserted

**Two rows in `public.locations`, in one transaction. Nothing else.**

| `address` | `zone` | `rack` | `slot` | `capacity` | `active` | `serial` | `id` |
| --- | --- | --- | --- | ---: | --- | --- | --- |
| `J-BLACK22-A` | `J` | `BLACK22` | `A` | 10 | true | `SLOT-000051` | `b0ae66f9-00da-4eac-8963-11d1f74cfe28` |
| `J-BLACK22-B` | `J` | `BLACK22` | `B` | 10 | true | `SLOT-000052` | `89069c68-43a8-4c0c-9355-72c4918aab4e` |

Both created at `2026-07-29 19:51:39.932256+00`. `display_name` is NULL on both,
matching the four bays already in production.

No `UPDATE`, `DELETE`, `DROP`, `ALTER` or `TRUNCATE` was issued against
production at any point. This is data, not schema, so there is no migration
file; production also carries 37 phantom migration-history rows, so
`supabase db push` would refuse regardless.

---

## 2. Before and after counts

| | Before | After | Delta |
| --- | ---: | ---: | ---: |
| `locations` | **42** | **44** | **+2** |
| `locations` where `active` | 42 | 44 | +2 |
| `locations` in zone `J` (job staging) | 4 | 6 | +2 |
| Jobs with exactly 2 active staging bays | 2 of 3 | **3 of 3** | +1 |
| Black Desert bays | **0** | **2** | +2 |
| Every other table in `public` | — | — | **0** |

Total rows in `public` grew by **exactly 2**, measured inside the transaction
itself (see [§4](#4-how-it-was-done-safely)) rather than as two absolute numbers
taken at different times, because production was being written to concurrently
while this ran.

Unchanged, checked by name after the commit:

| | |
| --- | ---: |
| `windows` | 11 |
| `movements` | 6 |
| `projects` | 3 (exactly one `BLACK22`) |
| Black Desert openings | 42 |
| Pecan Valley Building 14 openings | 106 |
| `profiles` | 6 |
| `auth.users` | 6 |
| `cost_codes` | 6 |
| `window_id_counters` | 5 rows, `sum(last_seq)` 50 |
| Duplicate `locations.address` / `locations.serial` / null serials | 0 / 0 / 0 |

**The 42 pre-existing `locations` rows are byte-for-byte unchanged.** Proven by
content digest, not by count: the md5 of every pre-existing row, taken before the
write, is `a2f37d43c790042793ff49e2ef6c4ddf`, and re-measuring the same 42 rows
after the commit returns the same digest. That rules out an edited shelf and a
vanished shelf in one check, which a row count cannot do.

---

## 3. Getting the shape right

The merge write-up's §8 supplied a candidate statement. It was checked against
the code and against the live database rather than trusted, and it was right
about the important parts and wrong about two details.

### Where bays come from

`createProject` in `app/src/lib/api.ts` lines 128–131, immediately after
inserting the job:

```ts
const { error: stagingError } = await supabase.from("locations").insert([
  { zone: "J", rack: jobCode, slot: "A", capacity: 10 },
  { zone: "J", rack: jobCode, slot: "B", capacity: 10 },
]);
```

Four columns, and that is all. The statement used here inserts exactly those
four columns with exactly those values, so a bay added now is indistinguishable
from one the app would have made.

### The shape, confirmed against the live rows

The four existing bays (`J-OAKRIDGE-A/B`, `J-PECAN14-A/B`) all carry `zone='J'`,
`rack` = the job code, `slot` `A`/`B`, `capacity` 10, `active` true,
`display_name` NULL. The new pair matches on every one.

- **There is no `project_id` column on `locations`.** The link from a bay to its
  job is `locations.rack = projects.job_code`, and `suggest_location()` joins on
  exactly that. This is worth knowing: the association is by string, and renaming
  a job's code without renaming its bays' `rack` would silently orphan them.
- **`address` is a generated column** —
  `((((zone || '-') || rack) || '-') || slot)`, confirmed from
  `information_schema.columns` in the live database. It is never named in the
  INSERT; Postgres rejects that. It produces `J-BLACK22-A` and `J-BLACK22-B`.

### Correction: the addresses are dashes, not pipes

The merge write-up §8 and the inventory refer to these bays as `J|BLACK22|A` and
`J|BLACK22|B`. That is not what they are called anywhere in the product. The
generated column uses `-`, so the real addresses are **`J-BLACK22-A`** and
**`J-BLACK22-B`**, which is also what the four pre-existing bays look like. The
pipe form appears in no column, label or screen. The write-up's *SQL* was right,
since it only ever names `zone`/`rack`/`slot`; only its prose was wrong.

### Correction: the serials are `SLOT-000051` / `SLOT-000052`, not `43` / `44`

`locations.serial` is UNIQUE (`locations_serial_key`) and has a column default,
confirmed live:

```
('SLOT-'::text || lpad((nextval('location_serial_seq'::regclass))::text, 6, '0'))
```

So a new bay must **not** name `serial`: leaving it to the default is how the app
allocates one, and is the only way to be sure of not colliding with the 42 that
`20260720020000_label_serials_editable_names.sql` backfilled. It is not named
here.

The write-up predicted `SLOT-000043` and `SLOT-000044`. The bays actually carry
**`SLOT-000051`** and **`SLOT-000052`**, because **sequences are not
transactional**: this change was rehearsed three times before it was committed,
and each rehearsal drew two serials and then rolled back the rows but not the
sequence. `SLOT-000043` through `SLOT-000050` were consumed by those rehearsals
and now belong to nothing.

That is harmless and was accepted deliberately. Serials are opaque permanent
label identifiers behind a UNIQUE index; nothing in the schema or the app
requires them to be contiguous, and nothing counts them. Rehearsing the write
against production three times is worth more than a tidy numbering, and the
alternative — forcing the serials with an explicit value or resetting the
sequence — would have meant naming a column the app does not name, or issuing an
`ALTER`/`setval` this change had no business issuing. The bays' serials differ
from the ones the same two bays carry in Ammon's project, which the merge
write-up had already noted was a coincidence rather than a design.

---

## 4. How it was done safely

### Fresh verified backup, taken before the write

[`docs/backups/2026-07-29T1942Z-czprjcskmzzagdztqonm-full.json`](./backups/2026-07-29T1942Z-czprjcskmzzagdztqonm-full.json)
— same format as the two existing production backups (an `exported_at`, a
`project_id`, and one key per non-empty table holding every column of every row).
**545 rows across 22 non-empty tables**, captured at 19:42:50 UTC, nine minutes
before the write.

It was verified before the write proceeded: all **67** `public` base tables were
re-counted in the live database with `count(*)` — never
`pg_stat_user_tables.n_live_tup` — and compared against the file. All 67 matched,
0 mismatches. A second, independent capture through `scripts/backup_project.py`
agreed on the same 545 rows, 6 auth users and 9 storage objects.

It was also verified *after* the write, as a rollback target specifically: the
42 `locations` rows in the file were compared field-by-field against the live
table, and the id sets are identical with **0 field-level differences**. The only
difference between the file and the live table is the two rows this change added
— which is precisely what makes it a usable rollback.

Web Push key material (`push_subscriptions.auth`, `push_subscriptions.p256dh`)
is redacted with the same column list `scripts/backup_project.py` uses, so no
live secret is committed. Those are the only two redacted values in the file.

### One transaction, at REPEATABLE READ, with 24 post-conditions

The write is a single `begin … commit` containing one `INSERT` and a `DO` block
of **24 post-conditions**. Any one of them raises, which aborts the transaction
and turns the trailing `commit` into a rollback.

The transaction runs at **`REPEATABLE READ`, and measures its own baseline**
rather than comparing against numbers pasted in from an earlier reading. It
digests every table in `public` before the insert, inserts, digests them all
again, and requires that **`locations` is the only table whose content or count
differs** and that the database grew by exactly 2 rows. Because the whole
transaction sees one snapshot, that comparison measures this change's effect and
nothing else.

That mattered. Production is being written to concurrently by other work in
flight, and this change's first attempt to commit **was correctly refused by its
own post-conditions**:

```
ERROR: P0001: post-condition failed: total public rows = 547 (got 548)
```

Between the baseline and the write, another change had shipped five new tables
(`ai_spend_alerts`, `ai_spend_limits`, `ai_spend_months`, `ai_usage_days`,
`ai_usage_events`) with telemetry rows arriving into them. Nothing was written;
the transaction aborted. The whole pre-existing schema was then re-measured and
confirmed untouched by that work — every one of the original 22 non-empty tables
identical in count *and* content digest — and the transaction was rewritten to
baseline itself at `REPEATABLE READ` so that concurrent, unrelated activity
cannot either falsely abort it or hide a real problem.

The 24 post-conditions cover: exactly 2 Black Desert bays; their addresses are
`J-BLACK22-A` and `J-BLACK22-B`; both `capacity` 10, `active`, slots `A`/`B`,
`display_name` NULL; both serials well-formed `SLOT-\d{6}`, distinct, non-null,
and non-colliding; zero duplicate `address` or `serial` table-wide; `locations`
at 44; total rows up by exactly 2; no table but `locations` changed; the 42
pre-existing `locations` rows byte-for-byte unchanged; `windows` 11; `movements`
6; `projects` 3; exactly one `BLACK22`; Black Desert openings 42; PECAN14
openings 106; `profiles` 6; `auth.users` 6; `cost_codes` 6; every job has exactly
2 active bays; and 2 J-zone bays per job.

### Rehearsed, and the abort path proven rather than assumed

1. **Dry run** — the identical transaction with `rollback` in place of `commit`.
   All post-conditions passed. Production re-read afterwards: still 42
   `locations`, 0 Black Desert bays.
2. **Guard test** — one expected value deliberately falsified (PECAN14 openings
   = 999). It failed with
   `P0001: post-condition failed: PECAN14 openings unchanged = 999 (got 106)`
   and production was re-read again: still 42 `locations`, 0 Black Desert bays.
   That proves the abort path aborts.
3. **The real abort described above**, which was not a rehearsal.

Only then was the same SQL run with `commit`.

### No path to the wrong database

`scripts/pgq.sh` refuses non-`SELECT` statements, so the write went through a
separate helper holding the same discipline and more: the project ref is a
required argument with no default; writes require an explicit `--write` flag
**and** an `SB_WRITE_ALLOWED_REF` environment variable equal to the ref, so two
independent statements of intent are needed before a row can be written; the
helper refuses any `UPDATE`, `DELETE`, `DROP`, `ALTER`, `TRUNCATE`, `GRANT` or
`REVOKE` outright; and `jvsyhtarnvmdilsgksdi` and `nbjmylctlklvazzlybts` are on a
hard-coded deny list that no combination of arguments can override.

All four guards were tested before the helper was used in anger, and all four
refused: the deny list on both of Ammon's refs, the missing `--write` flag, and
the missing `SB_WRITE_ALLOWED_REF`. A guessed ref has already caused one incident
on this project ([`migration-drift-2026-07-29-production.md`](./migration-drift-2026-07-29-production.md)).

---

## 5. Verification — present *and* usable

Two rows existing in a table is not the same as two bays a foreman can use. All
of the following was read back out of the live database after the commit.

### The list a foreman picks a bay from

`listLocations()` (`app/src/lib/api.ts` lines 51–59) is
`.from("locations").select("*").eq("active", true).order("address")`. It feeds
the **"Put in location"** picker on a job's receive screen
(`app/src/pages/ProjectDetail.tsx` line 1203) and the **Slot labels** screen's
"Job staging" zone filter (`app/src/pages/Labels.tsx` line 121).

Run as a **signed-in user with RLS active** — inside a transaction with
`set local role authenticated` and a real production `sub`
(`taylor@horizonsolarusa.com`, owner), which is exactly what PostgREST does
before serving a request:

| | |
| --- | ---: |
| Rows returned | **44** |
| Zone `J` ("Job staging") entries | **6** |
| Black Desert bays visible | **`J-BLACK22-A`, `J-BLACK22-B`** |
| Their position in the picker | **#2 and #3 of 44**, ordered by address |

Also run as a real HTTP request through **PostgREST**, with the app's own query
string, `GET /rest/v1/locations?select=*&active=eq.true&order=address` — HTTP
200, 44 rows, both bays present with `capacity` 10 and their serials.

RLS is genuinely enforced rather than merely enabled: the identical request as
**anon** (not signed in) returns HTTP 200 and **0 rows**. The warehouse is
visible to signed-in crew only.

### Actually staging a window into the bays

Present in a dropdown still is not proof of use. So a real staging operation was
performed against the new bays, as a signed-in user with RLS active, through the
app's own RPCs — `receive_window`, `suggest_location`, `move_window`, none of
which is `SECURITY DEFINER`, so all of them ran as `authenticated` with RLS
applied. The whole thing was rolled back.

| Step | Result |
| --- | --- |
| Bays `suggest_location()` had to offer **before** this change | **0** |
| `receive_window()` a Black Desert unit | `W-1-0001`, status `inbound` |
| `suggest_location()` for it | **`J-BLACK22-A`** (`SLOT-000051`) — chosen automatically |
| `move_window()` into bay A | status → `staged`, `movements` event `putaway` |
| `move_window()` from bay A into bay B | status → `staged` at `J-BLACK22-B`, `movements` event `staged` |
| Bay occupancy reported | **1 of 10** |

Both bays accept a unit, both set the unit's status to `staged` because they are
in zone `J`, both write the movement log the warehouse audit trail reads, and
both report occupancy against their capacity of 10. Bay A is what the app picks
on its own.

The rehearsal was rolled back and production re-read: `windows` still **11**,
`movements` still **6**, `window_id_counters` still 5 rows summing to **50**.
Nothing from the test survives.

### The rest

| Check | Result |
| --- | --- |
| Jobs without exactly 2 active staging bays | **0** |
| Pre-existing `locations` rows altered or removed | **0** (content digest, before vs after) |
| Tables other than `locations` changed by the transaction | **0** (in-snapshot digest of all 72) |
| Duplicate `address` / duplicate `serial` / null `serial` | **0 / 0 / 0** |
| RLS on `locations` | enabled; one `authenticated`-only policy |

---

## 6. Ammon's projects

Nothing was written to either, and both were confirmed afterwards:

| Project | Expected | Found |
| --- | --- | --- |
| `jvsyhtarnvmdilsgksdi` | 430 rows | **430 rows** in 66 `public` tables |
| `nbjmylctlklvazzlybts` | zero tables | **0 tables** in `public` |

Both are on the write helper's hard-coded deny list, and the deny list was
tested against both refs before any write was attempted. Neither was queried for
anything except these two confirmations.

---

## 7. The product gap this exposes

**Black Desert was not an oversight in the merge. It is the first job to arrive
by any route other than the app, and it exposed that nothing guarantees a job
has its bays.**

The "two bays per job" rule exists in exactly one place: seven lines of
client-side TypeScript inside `createProject`. There is nothing behind it.

- **No trigger.** The only trigger on `locations` is `locations_lock_serial`,
  and there is no trigger on `projects` at all.
- **No constraint and no foreign key** ties a job to its bays — `locations` has
  no `project_id`; the link is the string `locations.rack = projects.job_code`.
- **No detection.** Nothing anywhere reports a job with no bays. This gap was
  found by reading a merge write-up, not by the system noticing.
- **No repair path.** `createProject` has a compensating delete if bay creation
  fails, so a job never *starts* life without bays via the app — but there is no
  way, anywhere in the product, to give bays to a job that already lacks them.
  Fixing Black Desert required hand-written SQL against production.

And when a job has no bays, the app does not complain — it silently does the
wrong thing. `suggest_location()` tries the job's `J` bays first, and when it
finds none it **falls through to the general stock shelves in zone `S`**. For
Black Desert it would have returned `S-01-C`. A foreman would have been told,
with no warning of any kind, to put a Black Desert window on a shared stock
shelf instead of keeping the job's units together. The only visible symptom
would have been the absence of two entries in a 42-item dropdown.

### Are any other jobs missing bays?

**No. All three production jobs now have exactly two active bays**, and that was
checked as a post-condition rather than by eye:

| Job | `job_code` | Bays | Where they came from |
| --- | --- | ---: | --- |
| Oakridge Apartments Bldg C | `OAKRIDGE` | 2 | seed migration |
| Pecan Valley Town Homes — Building 14 | `PECAN14` | 2 | seed migration |
| Black Desert | `BLACK22` | 2 | **this change** |

But the two that already had bays did **not** get them from `createProject`
either. Both pairs carry `created_at = 2026-07-15 18:17:42.78784+00`, identical
to their own `projects` rows and to the rest of the demo seed, and they come from
`supabase/migrations/20260715000100_seed_demo.sql`:

```sql
insert into locations (zone, rack, slot, capacity)
select 'J', p.job_code, s.slot, 10
from projects p, (values ('A'), ('B')) as s(slot)
on conflict do nothing;
```

That statement back-fills bays for **whatever jobs existed when the migration
ran**, which is why those two are covered. So no job currently in production has
ever had its bays created by the app path. The one job that arrived after the
seed and outside `createProject` had none, silently, for a day.

### What is worth doing about it

Not fixed here — this change is deliberately two rows — but worth a decision:

1. **Enforce it in the database.** An `after insert on projects` trigger creating
   the two bays would make the rule hold no matter how a job arrives: the app, a
   merge, a restore, a seed, a manual insert. This is the real fix, and it is
   small.
2. **Make the absence visible.** `suggest_location()` silently preferring a stock
   shelf is the dangerous part. Either it should refuse for a job with no bay, or
   the receive screen should say "this job has no staging bay" instead of quietly
   offering the wrong shelf.
3. **Add a repair path.** A foreman should be able to create a missing bay from
   the Warehouse screen without an engineer writing SQL against production.
4. **Check the invariant.** "Every active job has two active staging bays" is a
   one-line query and belongs in whatever already watches production.

Until (1) exists, **any future job added by merge, restore or SQL will repeat
this exactly**, and the next person will find out when a window is already on the
wrong shelf.

### Still to do by hand

**Two physical shelf labels need printing** for `J-BLACK22-A` and `J-BLACK22-B`,
from the Slot labels screen with the zone filter set to "Job staging" — both bays
are in that list now. Their QR codes encode `SLOT-000051` and `SLOT-000052`. The
job starts 2026-08-05.

---

## 8. Rollback

### The backup

[`docs/backups/2026-07-29T1942Z-czprjcskmzzagdztqonm-full.json`](./backups/2026-07-29T1942Z-czprjcskmzzagdztqonm-full.json)
— production as it stood at 2026-07-29 19:42:50 UTC, nine minutes before the
write, verified table-by-table against the live database at that moment and
verified again afterwards as a rollback target (42 `locations` rows,
field-for-field identical to live, 0 differences).

Take a Supabase point-in-time restore from the dashboard before running anything
below; that is the real restore path if the statements themselves go wrong.

### Undoing this change

Two rows, inserted and nothing else, so the undo is a delete of exactly those two
rows. Run it as one transaction and read the counts before committing.

```sql
begin;

-- Refuse to remove a bay that has anything in it. This is the guard that makes
-- the delete safe: if a window has been staged into either bay since, stop and
-- move it out first, or the audit trail loses where it was.
do $$
declare v_n int;
begin
  select count(*) into v_n from public.windows w
   where w.location_id in (select id from public.locations
                            where zone = 'J' and rack = 'BLACK22');
  if v_n <> 0 then
    raise exception 'refusing: % window(s) are sitting in the Black Desert bays', v_n;
  end if;
  select count(*) into v_n from public.movements m
   where m.from_location_id in (select id from public.locations
                                 where zone = 'J' and rack = 'BLACK22')
      or m.to_location_id in (select id from public.locations
                               where zone = 'J' and rack = 'BLACK22');
  if v_n <> 0 then
    raise exception 'refusing: % movement(s) reference the Black Desert bays', v_n;
  end if;
end $$;

delete from public.locations
 where id in ('b0ae66f9-00da-4eac-8963-11d1f74cfe28',
              '89069c68-43a8-4c0c-9355-72c4918aab4e');

-- Expect 42. Anything else means stop and restore from the backup instead.
select count(*) as locations from public.locations;

rollback;  -- change to commit once the count above reads 42
```

The two ids are the ones in [§1](#1-what-was-inserted). Deleting by id rather
than by `(zone, rack, slot)` means a bay someone has since created by hand cannot
be caught by accident.

If instead the bays should stay but be taken out of service, retire them the way
the app does — `update locations set active = false` — which keeps the rows for
history and removes them from every picker and label list. That is
`deleteLocation` in `app/src/lib/api.ts`, and it is the reversible option.

`location_serial_seq` is deliberately **not** reset by either path. Rolling a
sequence backwards risks re-issuing a serial that has already been printed on a
label, which is the exact failure
`20260720020000_label_serials_editable_names.sql` exists to prevent.
