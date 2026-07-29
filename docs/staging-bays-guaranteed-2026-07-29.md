# A job can no longer exist without its staging bays — 2026-07-29

**Date:** 2026-07-29, 20:12–21:25 UTC. **Target:** `czprjcskmzzagdztqonm`
(production). **Closes** the product gap written up but deliberately not fixed
in [`black-desert-staging-bays-2026-07-29.md`](./black-desert-staging-bays-2026-07-29.md)
§7 and PR [#155](https://github.com/Infinity-Windows/infinity-windows/pull/155).

## The short version, for anyone who does not read SQL

Every job needs two shelves in the warehouse — a bay "A" and a bay "B" — where
its windows are stacked before they go out. Until today that rule lived in the
app and nowhere else, so it only held for jobs somebody created by pressing the
button in the app. A job that arrived any other way got no shelves, and **the
app said nothing about it.** It quietly told the foreman to put that job's
windows on a general stock shelf next to everybody else's material. Windows
stacked with another job's material get installed at the wrong address.

Three things changed, and **all of it is live**:

1. **Every job now gets its two shelves automatically**, no matter how the job
   got into the system. The database does it, not the app.
2. **The app will no longer quietly send a job's windows to a shared shelf.**
   If a job somehow has no shelf of its own, the app now says so in plain
   English instead of naming a shelf that looks perfectly reasonable.
3. **A foreman can create a missing shelf themselves**, from the job's
   Warehouse tab, with one tap. Nobody has to write SQL any more — which is
   what fixing this took last time.

There is also a daily check that looks at the live warehouse and posts to
Slack if any job has lost a shelf, so this cannot quietly come back.

Nothing existing was changed. All 44 shelves are byte-for-byte as they were,
all three jobs still work end to end, and nothing at all was written to
Ammon's databases.

---

## Contents

1. [Can a job now exist without bays?](#1-can-a-job-now-exist-without-bays)
2. [Can a foreman still be silently sent to a shared shelf?](#2-can-a-foreman-still-be-silently-sent-to-a-shared-shelf)
3. [What was built](#3-what-was-built)
4. [The rack convention](#4-the-rack-convention)
5. [What happened to the client-side code](#5-what-happened-to-the-client-side-code)
6. [How it was done safely](#6-how-it-was-done-safely)
7. [Verification](#7-verification)
8. [Rollback](#8-rollback)

---

## 1. Can a job now exist without bays?

**No — not by any insertion path, and that was proved against production rather
than reasoned about.**

An `AFTER INSERT` trigger on `projects` creates the two bays. A job inserted by
raw SQL — no app, no PostgREST, no client code anywhere near it — inside a
`REPEATABLE READ` transaction that was then rolled back:

```
insert into public.projects (job_code, name)
values ('ZZVERIFY-9', 'Verification job, rolled back');
```

```json
{
  "job_code": "ZZVERIFY-9",
  "bays": [
    { "address": "J-ZZVERIFY-9-A", "zone": "J", "rack": "ZZVERIFY-9",
      "slot": "A", "capacity": 10, "active": true,
      "serial": "SLOT-000057", "display_name": null },
    { "address": "J-ZZVERIFY-9-B", "zone": "J", "rack": "ZZVERIFY-9",
      "slot": "B", "capacity": 10, "active": true,
      "serial": "SLOT-000058", "display_name": null }
  ],
  "rack_equals_job_code_exactly": true,
  "serials_well_formed": true,
  "serials_are_new": true
}
```

Both bays, dashed addresses, `capacity` 10, `active`, `display_name` NULL —
indistinguishable from the six that were already there. `address` was never
named (it is generated); `serial` was never named (the column default is the
only allocator).

It is idempotent. Running the rule twice more against a job that already has
its bays:

| | Before | After |
| --- | --- | --- |
| `location_serial_seq` | 58 | **58** |
| digest of BLACK22's two bays | `acd8395c52a86150e0f0c55ee0c60b25` | **`acd8395c52a86150e0f0c55ee0c60b25`** |
| BLACK22 bays | 2 | **2** |

The sequence did not move, which is the part that matters: `locations.serial`
is UNIQUE with a `nextval` default and sequences are not transactional, so a
naive `on conflict do nothing` would have burned two permanent serials on every
project insert and every repair press. The rule pre-filters with `where not
exists` and keeps `on conflict` only as a race backstop.

The migration ends by running the rule against every job that already exists.
On production all three already had their bays, so it inserted nothing and drew
no serial — which is the same proof, taken during the deploy itself.

---

## 2. Can a foreman still be silently sent to a shared shelf?

**No. The word that matters is "silently": one case is refused outright and the
other is now said out loud on the screen.**

### Before — verbatim, against the old function

Same probe: a job created by SQL with no bays, a window sold to it,
`suggest_location()`:

```json
[{"bays_the_job_has": 0,
  "suggest_location_says": "S-01-C",
  "zone": "S",
  "what_that_is": "A SHARED STOCK SHELF"}]
```

No error. No warning. A real, valid-looking shelf address, which the receive
screen would have printed as "put in S-01-C".

### After — verbatim, same probe, against the live function

```json
{"outcome": "REFUSED",
 "sqlstate": "P0001",
 "hint": "no_staging_bay",
 "detail": "ZZVERIFY-9",
 "message": "Job ZZVERIFY-9 has no staging bay, so there is no shelf of its own to put this window on. Create the job's staging bays first — putting it on a shared stock shelf would mix this job's windows in with everyone else's."}
```

### Why refuse rather than answer with a warning attached

There is no correct job shelf to name, so naming one is a wrong answer however
it is decorated. Returning a shelf plus a warning field would also have meant
widening `suggest_location`'s return type away from `locations`, and every
caller that did not read the new field would have been silently wrong again —
which is precisely the failure being closed. An exception cannot be read past
by accident. And the fix is now one tap, so refusing costs a foreman seconds.

### The case that is still allowed, and is now visible

If a job's bays **exist but are full**, putaway still falls back to stock. It
has to: the windows have to go somewhere, and refusing would block receiving
entirely. But it is no longer quiet. The client marks any stock-zone suggestion
for a job-assigned window as a shared shelf, and the screens say so:

- **Receive** shows a red banner — *"S-01-C is a shared stock shelf, not this
  job's own staging bay. The job's bays are full, so these windows will be
  sitting with other jobs' material."* — and the per-unit chip reads
  "put in S-01-C (shared shelf)".
- **A window's own screen** shows the same banner, and the button changes from
  "Put in suggested slot" to **"Put in shared shelf anyway"**.

A window with no job at all still goes to a stock shelf with nothing said,
because that is where unassigned stock belongs. Confirmed live: `S-01-C`, same
as before.

---

## 3. What was built

`supabase/migrations/20260729220000_staging_bays_guaranteed.sql`:

| Object | What it is |
| --- | --- |
| `create_staging_bays(text)` | The rule, in one place, idempotent. `SECURITY DEFINER`, `search_path` pinned, **no role granted EXECUTE** — internal only. |
| `projects_create_staging_bays` | `AFTER INSERT ON projects`. The guarantee. |
| `locations_staging_bay_exists` | `BEFORE INSERT ON locations`. Asking for a bay that already exists is a no-op, not a `23505`. |
| `ensure_project_staging_bays(uuid)` | The foreman's repair button. Foreman+ only, matching `preissue_project_units`. `authenticated` may EXECUTE; **`anon` may not**. |
| `suggest_location(uuid)` | Refuses for a job with no bay. Everything else unchanged. |

No role holds EXECUTE on any of the four new functions except `postgres`,
`service_role`, and `authenticated` on the repair RPC. `anon` and `PUBLIC` hold
none, checked as a post-condition and re-read after the commit.

App side:

- `app/src/lib/staging.ts` — recognising the refusal (by the `hint`, not by the
  wording of the message), spotting a job short of a bay, and the warning text.
  12 tests in `staging.test.ts`.
- `Receive`, `WindowDetail` — surface the warning and the refusal.
- `ProjectDetail` → Warehouse tab — a **Staging bays** panel: a quiet "Ready"
  line normally, a warning with a **Create staging bays** button when one is
  missing or has been retired.

Detection: `scripts/verify-staging-bays.sh` plus
`.github/workflows/verify-warehouse.yml`.

### Why the check is not in the backend deploy

`scripts/verify-schema.sh` runs inside `deploy-backend.yml` because it checks
the *shape* of the database, which is exactly what a deploy changes. This check
is about *rows*, and rows drift with no deploy in sight — a job can arrive by a
merge, a restore or a hand-written INSERT on a quiet afternoon. Wired into the
deploy it would only ever look on the days we happen to ship, and it would
block an unrelated fix from shipping because of a data problem no deploy can
repair. So it runs daily at 08:10 UTC and on demand, and posts to Slack.

It has its own test suite (`scripts/verify-staging-bays.test.sh`, 13 cases,
stubbed — no token, no database, no network), because a check nobody has proved
can fail is not a check. `deploy-backend.yml` and `verify-functions.sh` were
not touched.

---

## 4. The rack convention

**`rack` is the job code character for character. No shortening, no
truncation, no re-punctuation.** All six live bays are exactly their
`projects.job_code`: `BLACK22`, `OAKRIDGE`, `PECAN14`.

That is not cosmetic. `locations` has no `project_id`; the only link from a bay
to its job is the string join `locations.rack = projects.job_code`, which
`suggest_location()` performs. Deriving the rack by any rule that can differ
from the code — uppercasing, stripping punctuation, trimming to N characters —
would produce a bay that exists, sits in every picker, and belongs to no job.
That is worse than no bay, because it looks right.

The app normalises the job **code** at creation (`createProject` uppercases and
dashes it); the bay then copies whatever that produced. The verification job
above deliberately used `ZZVERIFY-9` — ten characters with punctuation — and
got `J-ZZVERIFY-9-A`. The check in `verify-staging-bays.sh` looks for orphaned
racks precisely so a future rename cannot break the join in silence.

---

## 5. What happened to the client-side code

**Removed**, along with its compensating delete.

Keeping it would have been worse than redundant. The trigger creates the bays
before `createProject`'s insert could run, so that insert could only ever
collide with the unique key — and the compensating delete would then have
deleted the job the user had just made. More importantly, a rule that lives in
the client is a rule that only holds for jobs the client makes, which is how a
job reached production with no bays in the first place.

The `locations_staging_bay_exists` guard covers the deployment gap: the
frontend **currently running in production** still contains the old insert, and
the trigger went live before this PR ships. Without the guard, a job created in
the app between now and this merging would have hit a duplicate-key error and
been deleted by its own compensating delete. With it, the old insert is a
harmless no-op. The guard is deliberately narrow — zone `J` only, only when
that exact `(zone, rack, slot)` already exists — so a duplicate stock shelf
still raises. It was proved live: the old client's exact two-row INSERT ran
against a job that already had bays and produced 2 bays, not an error.

---

## 6. How it was done safely

### Fresh verified backup, taken before the write

[`docs/backups/2026-07-29T2012Z-czprjcskmzzagdztqonm-full.json`](./backups/2026-07-29T2012Z-czprjcskmzzagdztqonm-full.json)
— **549 rows across 24 non-empty tables**, 6 auth users, 9 storage objects,
captured at 20:12:07 UTC, about an hour before the write, in the same format as
the four existing production backups.

`scripts/verify_backup.py` re-counted all 74 tables against the live database,
re-listed the catalog, re-checked the auth and storage totals and confirmed the
two credential columns are redacted. Everything this change can touch matched:
`locations` 44 rows with the id set identical to live and content digest
`0255d489409faa2c99e625a9a06ba5ff`, `projects` 3, `windows` 11, `movements` 6.

Two caveats, stated rather than buried. Four tables — `ai_spend_alerts`,
`ai_spend_months`, `ai_usage_days`, `ai_usage_events` — read 1/1/1/5 rows live
against 0 in the file: they are another agent's AI-telemetry tables, receiving
rows continuously, and they gained those rows between the capture and the
verification. Storage object **bytes** were not downloaded
(`scripts/backup_storage_objects.py` was not run), so the file inventories the
9 objects without copying them. Neither is in the blast radius of a change that
adds two triggers and three functions and writes no rows.

### One transaction, at REPEATABLE READ, measuring its own baseline

The migration and nine post-conditions were applied as a single
`begin … commit` at **`REPEATABLE READ`**. The baseline — content digests of
`locations` and `projects`, four row counts, and `location_serial_seq` — is
captured into a temp table **inside the same snapshot**, never pasted in from
an earlier reading, so the concurrent work other agents are shipping into this
database can neither falsely abort it nor hide a real problem. A previous
change on this project was aborted by exactly that.

The apply transaction is **read-only apart from the DDL**: it inserts no rows
at all, so the commit burned no serials. Proving the trigger actually creates
bays was done separately, in transactions that were rolled back, because probe
rows draw permanent serials from a sequence that does not roll back.

The nine post-conditions: `locations` content digest unchanged; `locations`
count unchanged; `location_serial_seq` unmoved by the backfill; `projects`,
`windows`, `movements` counts and the `projects` digest unchanged; every job
still has exactly two active bays; 6 J-zone bays; both triggers present;
`suggest_location` contains the refusal; all five functions pin `search_path`;
zero grants to `anon`/`PUBLIC`; `authenticated` can reach the repair RPC.

### Rehearsed, and the abort path proven rather than assumed

1. **Dry run** — the identical transaction with `rollback` in place of
   `commit`. All post-conditions passed. Production re-read: 44 `locations`,
   digest unchanged, **no trigger on `projects`**.
2. **Guard test** — one expected value deliberately falsified (`J bays <> 999`).
   It raised, the transaction aborted, and production was re-read again: still
   44, still no trigger. That proves the abort path aborts.
3. Only then was the same SQL run with `commit`.

`location_serial_seq` advanced from 52 to 60 across the rehearsals and the
behaviour probes. Those eight serials now belong to nothing, exactly as
`SLOT-000043`–`SLOT-000050` already did. Serials are opaque permanent label
identifiers behind a UNIQUE index; nothing requires them to be contiguous and
nothing counts them. Rehearsing against production is worth more than tidy
numbering.

### No path to the wrong database

Reads went through `scripts/pgq.sh`, which refuses anything that is not a
SELECT and has no default project ref. Writes went through a separate helper
holding the same discipline: the ref is a required argument with no default;
writes need both a `--write` flag **and** an `SB_WRITE_ALLOWED_REF` environment
variable equal to that ref; and `jvsyhtarnvmdilsgksdi` and
`nbjmylctlklvazzlybts` are on a hard-coded deny list. All four guards were
tested before the helper was used, and all four refused. **No statement of any
kind was sent to either of Ammon's projects.**

### Migration history

`supabase db push` cannot run against this project — it holds 40 phantom
history rows, three more than yesterday, from other work stamping through the
MCP `apply_migration` tool. So the migration was applied directly and stamped
by hand as version `20260729220000`. The file was renamed from `...210000` on
discovering that version was already taken by a phantom.

**`scripts/cleanup-migration-phantoms.sh` was made directional in the same PR**,
rather than having its numbers bumped again. It used to assert three committed
integers — files on disk, rows in the history table, phantom rows — and refuse
to run unless all three matched. Every one of them moves whenever anybody
merges a migration or applies SQL through MCP: they were stale within hours of
being written, twice, in a single day. The only way past a stale equality check
is to bump the literal, which teaches everybody to bump it, which is how this
repo has already lost checks to being permanently red.

It now mirrors the decision `scripts/schema_verify.py` documents for schema
drift:

| | |
| --- | --- |
| a migration **file with no applied row** | **stops the script**, no override — something in the repo never reached the database |
| **two files claiming one version** | **stops the script**, no override — the history table is keyed by version, so one of the pair can never be recorded |
| an applied **row with no file** (a phantom) | **reported, never refused** — these are known, pre-existing and documented, and deleting them is the script's whole job |

A new phantom is still visible without any baseline to keep up to date: the
report splits phantoms into those that sort *after* every migration file — which
can only have been stamped by something applying SQL outside
`supabase/migrations/`, i.e. the leak is still open — and the historical rest.
That answers the question worth asking ("is this still happening?") instead of
the one that drifts ("is the total still 37?").

One number is still enforced, and it is derived rather than committed: the
guard inside the DELETE transaction requires the table to end up with exactly
one row per migration file, counted from the files on disk during that same
run. `scripts/cleanup-migration-phantoms.test.sh` (20 cases, stubbed curl, no
token or network) pins the direction so nobody quietly turns it back into an
equality check; it runs in CI's **Supabase merge tooling** job.
`docs/db-push-readiness.md` step 2 is updated to match.

`docs/profiles-security-2026-07-29.md` still says the script "pins its
expectations at 70/107/37" and shows how to override them. That sentence is now
out of date; it is another change's write-up, so it is named here rather than
edited.

### Two things a reader of `git log` should not panic about

`master` carries a pair of commits from a deliberate experiment, not from
anything broken: `1c43f26` *"test: deliberately break the build to prove red PRs
cannot merge"* and its revert `be6b86e` *"Revert the throwaway build-break
probe"* (#156 / #159). The break was intentional, it proved the required checks
actually block a merge, and it was reverted immediately. Nothing shipped from
it. A separate merge-queue experiment was also in flight the same afternoon and
left short-lived `test: behind-branch verification` PRs; those are the same kind
of thing.

### Migration ordering, checked against what is landing alongside

`20260729220000_staging_bays_guaranteed.sql` sorts last, after both
`20260729200000_ask_question_log.sql` (#157, on master) and
`20260729210000_ai_spend_limits.sql` (#161, pending), and neither of those
touches `projects`, `locations` or `suggest_location`, so there is nothing to
interleave and no conflict either way round.

Two hazards spotted in passing, neither introduced here and neither this
change's to fix — but both exactly what the rewritten check now catches:

* **`master` already has two files at version `20260729200000`** —
  `ask_question_log.sql` and `profiles_rls_lockdown.sql`. The history table is
  keyed by version, so only one of them can ever be recorded. The rewritten
  script stops on this; the old one could not see it at all.
* **#161's migration is `20260729210000`, and a phantom row already holds that
  version** (`revoke_truncate_from_clients`). Once #161 merges, that file will
  look *applied* to `supabase db push` when in fact something unrelated stamped
  the row — so the spend-limit tables would silently never be pushed. This is
  the same collision that forced this change's own file to be renamed away from
  `...210000`. Renaming #161's file to a fresh timestamp before it lands avoids
  it.

---

## 7. Verification

Everything below was read out of the live database after the commit.

### The rule

| Check | Result |
| --- | --- |
| A job inserted by raw SQL gets 2 bays | **Yes** — `J-ZZVERIFY-9-A`, `J-ZZVERIFY-9-B` |
| `rack` equals `job_code` character for character | **Yes** |
| Serials well-formed `SLOT-\d{6}` and new | **Yes** — `SLOT-000057`, `SLOT-000058` |
| Re-running against BLACK22 changes anything | **No** — digest and sequence both unmoved |
| Legacy client's exact INSERT against a job that has bays | **2 bays, no error** |

### suggest_location

| Case | Before | After |
| --- | --- | --- |
| Job with no bay | `S-01-C`, silently | **Refused**, `hint = no_staging_bay` |
| Job with bays | `J-BLACK22-A` | `J-BLACK22-A` |
| No job at all (stock) | `S-01-C` | `S-01-C` |
| Job repaired mid-transaction | — | `J-ZZVERIFY-9-A` |

### The three real jobs, end to end, under RLS as a signed-in user

Inside a transaction with `set local role authenticated` and a real production
`sub` (`taylor@horizonsolarusa.com`), which is what PostgREST does before
serving a request. `receive_window`, `suggest_location` and `move_window` are
all `SECURITY INVOKER`, so RLS applied throughout. Rolled back afterwards.

| Job | Received | Suggested | Its own bay? | Status after move |
| --- | --- | --- | --- | --- |
| `BLACK22` | `W-AWN2418-0001` | `J-BLACK22-A` | yes | `staged` |
| `OAKRIDGE` | `W-AWN2418-0002` | `J-OAKRIDGE-A` | yes | `staged` |
| `PECAN14` | `W-AWN2418-0003` | `J-PECAN14-A` | yes | `staged` |

`listLocations()` as the same signed-in user: **44 rows, 6 in zone J**, all six
bay addresses present. The repair RPC returned both bays for an owner and was
**refused** for a plain installer (`dave@crew.demo`): *"only a foreman-level
user or above can create staging bays"*.

### Nothing was disturbed

| | Before | After |
| --- | ---: | ---: |
| `locations` rows | 44 | **44** |
| `locations` content digest | `0255d489409faa2c99e625a9a06ba5ff` | **`0255d489409faa2c99e625a9a06ba5ff`** |
| `projects` / `windows` / `movements` | 3 / 11 / 6 | **3 / 11 / 6** |
| `window_id_counters` | 5 rows, sum 50 | **5 rows, sum 50** |
| Ammon's projects | untouched | **untouched — nothing sent** |

The digest is the important line: it rules out an edited shelf and a vanished
shelf in one check, which a row count cannot.

`scripts/verify-staging-bays.sh` against production: *3 active jobs checked, 0
without their two bays, 0 bays belonging to no job.*

### The repo

`npm run build`, `npm run lint` (0 errors) and `npm test` — **1333 tests across
105 files, all passing**, including 12 new ones for the staging logic.
`scripts/verify-staging-bays.test.sh` — **13 passed, 0 failed**.

---

## 8. Rollback

This change added two triggers and three functions and altered one. **It wrote
no rows**, so there is no data to restore; the backup above is the safety net,
not the undo. Take a Supabase point-in-time restore from the dashboard first if
anything below misbehaves.

```sql
begin;

drop trigger if exists projects_create_staging_bays on public.projects;
drop trigger if exists locations_staging_bay_exists on public.locations;
drop function if exists public.projects_create_staging_bays();
drop function if exists public.locations_staging_bay_exists();
drop function if exists public.ensure_project_staging_bays(uuid);
drop function if exists public.create_staging_bays(text);

-- Put suggest_location back to the silent fallback. This is the body from
-- 20260715000000_inventory_core.sql, with the search_path pin kept.
create or replace function public.suggest_location(p_window_id uuid)
returns public.locations
language plpgsql
stable
set search_path = public
as $$
declare
  v_window windows;
  v_loc locations;
begin
  select * into v_window from windows where id = p_window_id;
  if v_window is null then
    raise exception 'unknown window %', p_window_id;
  end if;

  if v_window.project_id is not null then
    select l.* into v_loc
    from locations l
    join projects p on p.job_code = l.rack
    where l.zone = 'J' and l.active and p.id = v_window.project_id
      and (select count(*) from windows w where w.location_id = l.id) < l.capacity
    order by l.slot
    limit 1;
    if v_loc.id is not null then
      return v_loc;
    end if;
  end if;

  select l.* into v_loc
  from locations l
  where l.zone = 'S' and l.active
    and (select count(*) from windows w where w.location_id = l.id) < l.capacity
  order by
    (select count(*) from windows w
     where w.location_id = l.id and w.window_type_id = v_window.window_type_id) desc,
    (select count(*) from windows w where w.location_id = l.id) asc,
    l.address
  limit 1;

  return v_loc;
end;
$$;

delete from supabase_migrations.schema_migrations
 where version = '20260729220000';

-- Expect 44 and 6. Anything else means stop.
select (select count(*) from public.locations) as locations,
       (select count(*) from public.locations where zone = 'J') as bays;

rollback;  -- change to commit once the counts above read 44 and 6
```

**Do this only together with reverting the PR.** The frontend after this PR no
longer creates bays from `createProject`, so dropping the trigger while the new
frontend is live means new jobs get no bays at all — the original bug, with the
last safety net removed.

Reverting the app alone is safe in either order: the old client's insert is a
no-op while the guard trigger exists, and an error the compensating delete
handles once it is gone.

`location_serial_seq` is deliberately not reset. Rolling a sequence backwards
risks re-issuing a serial that has already been printed on a label, which is
the exact failure `20260720020000_label_serials_editable_names.sql` exists to
prevent.
