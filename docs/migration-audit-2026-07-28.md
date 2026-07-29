# Migration drift audit — 2026-07-28

> ## ⚠️ CORRECTION (2026-07-29): this audit did not measure the database the app was using.
>
> Everything below — including the "Status: closed" all-clear and the
> "64 APPLIED / zero MISSING" result — was measured against Supabase project
> **`jvsyhtarnvmdilsgksdi`**. It got there unintentionally: `scripts/pgq.sh`
> defaulted to that ref whenever `SUPABASE_PROJECT_REF` was unset, so every
> audit run silently pointed at it without saying so.
>
> The database the deployed app and local dev were pointed at is
> **`czprjcskmzzagdztqonm`** (`app/.env`,
> `.github/workflows/deploy-pages.yml`, the live bundle). Measured against *that*
> project on 2026-07-29, it was **31 relations short of what the migrations
> declare** — 22 files entirely MISSING and 4 PARTIAL, including all of vehicles,
> travel, crew scheduling, project chat and the whole mark-spec chain.
>
> So this document's all-clear is a true statement about
> `jvsyhtarnvmdilsgksdi` and a false one about the app's database. Its
> *diagnosis* and *repair SQL* remain accurate as descriptions of the problems
> themselves.
>
> **Which project should be canonical is now an open question**, being
> re-evaluated by the team — `jvsyhtarnvmdilsgksdi` may hold the real ongoing
> work. Schema repair against `czprjcskmzzagdztqonm` was halted for that reason;
> see [`docs/migration-repair-2026-07-29-production.md`](./migration-repair-2026-07-29-production.md)
> for exactly what had already been applied, and
> [`docs/migration-drift-2026-07-29-production.md`](./migration-drift-2026-07-29-production.md)
> for the read-only comparison.
>
> `scripts/pgq.sh` no longer has a default ref; it fails with a clear message
> when `SUPABASE_PROJECT_REF` is unset. Whichever project wins, an audit can no
> longer measure one database while appearing to describe another.

Triggered by a live failure: "Load marks from plans" died with
`Could not find the 'provisional' column of 'window_types' in the schema cache
[PGRST204]` because `20260721000000_window_type_provisional_flag.sql` was in the
repo but had never been applied. That migration has since been applied. This
audit answers the follow-up question: **what else is missing?**

> **Status: closed.** Everything below is fixed. Both unapplied migrations are
> applied and verified against the live database, the duplicate timestamps that
> caused the masking are renamed away, the declined seed has been moved out of
> `supabase/migrations/`, and the history table gets its missing rows from
> `docs/migration-history-backfill-2026-07-28.sql`. The sections below are kept
> in their original wording as the record of what was wrong, with the outcome
> noted inline. Jump to [What was done](#what-was-done) for the resolution.

## Method

The recorded migration history cannot be trusted here — migrations have often
been applied by POSTing SQL to the Supabase Management API, which writes nothing
to `supabase_migrations.schema_migrations`. So the live catalog was treated as
the only source of truth.

For all 67 files in `supabase/migrations/`, the objects each one declares were
extracted and compared against the live database:

- tables, views, columns, indexes, sequences, extensions
- constraints — **including the value list of every named CHECK constraint**,
  not just its name
- policies and buckets across **every** schema, not just `public`
  (several migrations create `storage.objects` policies)
- functions across every schema, and **the body text of every function**, since
  `create or replace function` is invisible to an existence check
- triggers, publications, enum values, and RLS enablement per table

Tooling is checked in and re-runnable: `scripts/audit-migrations.sh`.

## Result

As first found (67 files, before the repair):

| Verdict | Files |
| --- | --- |
| APPLIED | 62 |
| PARTIALLY APPLIED | 1 |
| MISSING | 1 |
| DATA-ONLY (seeds/backfills, verified by querying rows) | 3 |

Only two files carried schema drift. Both are now applied; the third data-only
file was the declined seed, which has since moved to `docs/optional-seeds/`.

### `20260718080000_chain_correctness_fixes.sql` — effectively entirely unapplied

*(Now applied and verified; renamed to `20260718080030_chain_correctness_fixes.sql`.)*

Classified PARTIAL only because the objects it touches already existed from
earlier migrations. Nothing in the file actually took effect:

- `windows_status_check` is live **without** `'on_site'`
- all six functions it rewrites still run their previous bodies:
  `load_window`, `unload_units`, `activate_preissued_unit`,
  `set_opening_condition`, `undo_install`, `open_service_case`

**Why the history missed it.** Two files share the version `20260718080000`.
The recorded row for that version is named `project_details` — its twin. The
CLI records one row per version, so `chain_correctness_fixes` looked applied
while never having run. This is precisely the masking risk that duplicate
timestamp prefixes create.

### `20260718090000_security_hardening.sql` — entirely unapplied

*(Now applied and verified.)*

- `trg_guard_profile_role_change` does not exist in any schema
- the `guard_profile_role_change` trigger on `profiles` does not exist
- 27 `SECURITY DEFINER` functions have no pinned `search_path` (plus 155
  `SECURITY INVOKER` functions)

#### Why it never landed: pgvector

This one is worth recording, because the failure was invisible. The migration
ends with two loops that walk the functions in `public` and pin each one's
`search_path`. The loops were not filtered by ownership, so they reached
`subvector` — a function that belongs to the **pgvector** extension, not to us.
`alter function` on an extension-owned function fails with
`must be owner of function`, and because the whole migration runs in one
transaction, that single error rolled back **everything** in the file: the
guard trigger, the role-change protection, and every `search_path` pin that had
already succeeded. The migration looked like it had been attempted and produced
nothing.

The fix (`Skip extension-owned functions when pinning search_path`, #122) adds
a `not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')`
guard to both loops. Extension functions ship with their own `search_path`, so
skipping them costs nothing — hardening *our* functions was always the point.

## Ranked live landmines

Ranked by whether they can break — or already are silently corrupting — a user
action.

1. **Anyone signed in can make themselves an owner.** `profiles` has exactly one
   policy, `"authenticated full access" FOR ALL USING (true) WITH CHECK (true)`,
   and no guard trigger. Any installer can `UPDATE` their own `profiles.role` to
   `'owner'` directly and unlock every foreman/owner-gated screen. *Breaks:*
   the entire role/permission model. This is the most serious finding.
2. **Units unloaded at the jobsite can be loaded onto a truck again.** The live
   `unload_units` sets status `'staged'` instead of `'on_site'`. The app's
   `LOADABLE` list is `["in_warehouse", "staged"]`, so a window physically
   sitting at the jobsite reappears in the warehouse load-out list as available
   stock. *Breaks:* Load-out (`ProjectDetail` → Unload panel, `lib/loadout.ts`).
3. **`load_window` accepts any unit in any state.** The live body has no status
   guard at all, so an already-installed, damaged, on-site, or not-yet-received
   unit can be loaded onto a truck. Combined with #2 this is how the same
   physical window ends up in two contradictory states. *Breaks:* Load-out
   (`loadWindow`, `app/src/lib/api.ts`).
4. **Undoing an install leaves a phantom running timer.** The live `undo_install`
   never clears `work_ended_at` and never closes the open `task_sessions` row,
   so elapsed task-time keeps accruing against a job nobody is working, and job
   costing inherits the bad number. It also appends a spurious `'uninstalled'`
   movement on a repeat undo. *Breaks:* install undo, task time, job costing
   (`undoInstall`, `app/src/lib/install/api.ts`).
5. **Duplicate open warranty cases.** The live `open_service_case` is not
   idempotent — every tap creates another open case for the same unit.
   *Breaks:* service/warranty list (`app/src/lib/service.ts`).
6. **Duplicate open damage issues.** The live `set_opening_condition` and
   `unload_units` dedupe on the unit alone, not "the unit OR its assigned
   opening", so one physical window can carry two open damage issues.
   *Breaks:* the issues list and the reorder rollup that counts damaged units.
7. **Receiving a late delivery leaves its "missing" issue open.** The live
   `activate_preissued_unit` does not resolve the open `'missing'` issue when
   the unit finally arrives, so office keeps chasing a delivery that is already
   in the warehouse. *Breaks:* receiving (`app/src/lib/api.ts`) and the issues
   list.
8. **Function `search_path` hardening absent.** No user-visible breakage; a
   privilege-escalation hardening gap that pairs with finding #1.

Note that none of these throw an error the way the `provisional` bug did. They
are all silent wrong behaviour, which is why nobody has reported them.

## Pending data-rewriting backfills

One, and it is **not** bundled into the repair script:

- `20260721001000_seed_brain_top10_tips.sql` — a single `UPDATE` over
  `window_types` filling `tips_json` / `watch_outs_json` / `difficulty_rating`.
  Confirmed never run: no window type has any tips. It is self-limiting (only
  fills rows whose tips are empty, preserves an existing difficulty rating), but
  only **3 of the 10** codes it targets exist in the live catalog
  (`DH3252`, `PIC6048`, `SL7248`), so it would update 3 rows and silently skip
  seven. Reconciling those codes with the real catalog is a content decision.
  Details and pre/post checks: `docs/migration-drift-2026-07-28-data-backfill.sql`.
  **Decided: declined.** The seed now lives in `docs/optional-seeds/` rather
  than `supabase/migrations/` — see step 2 below.

Neither unapplied schema migration contains a top-level `update`/`delete`; the
`UPDATE`s inside `chain_correctness_fixes` are runtime logic within function
bodies, not backfills.

## What was done

### 1. Renamed the duplicate-timestamp files (the actual root cause)

Six pairs shared a version prefix. This is what let a completely unapplied
migration hide behind its twin's recorded version, and no amount of process
discipline fixes it, because the CLI physically cannot record two rows for one
version. Each pair's second file was renamed to a unique timestamp using the
CLI's own `+30s` convention, which makes the failure impossible rather than
unlikely.

**Which file of each pair keeps the base version was not a judgement call.** It
is dictated by what `supabase_migrations.schema_migrations` already records —
renaming a file to a version the table doesn't have would re-create the drift
we are removing. Four of the six pairs already had both rows on record, so the
assignment was read straight out of the table:

| Version | Recorded name | File action |
| --- | --- | --- |
| `20260718040000` | `time_clock_horizon` | unchanged |
| `20260718040030` | `preissue_ids` | renamed from `20260718040000_preissue_ids.sql` |
| `20260718050000` | `time_timecard` | unchanged |
| `20260718050030` | `receiving_delivery` | renamed from `20260718050000_receiving_delivery.sql` |
| `20260718060000` | `cost_codes_library` | unchanged |
| `20260718060030` | `loadout_unload` | renamed from `20260718060000_loadout_unload.sql` |
| `20260718080000` | `project_details` | unchanged |
| — (no row) | `chain_correctness_fixes` | renamed to `20260718080030_chain_correctness_fixes.sql` |

Note that the recorded assignment is **counterintuitive**: `20260718040000` is
`time_clock_horizon` and `20260718050030` is `receiving_delivery`. A plausible
"second file alphabetically gets the +30" rule would have assigned both of
those backwards. Always read the table; never re-derive.

`chain_correctness_fixes` has no recorded row (that is the whole bug), so `+30`
was both forced — its twin holds the base version — and truthful, since it
genuinely executed later, on 2026-07-28.

Two pairs have no recorded row at all, so a deterministic fallback applies:
alphabetically-first keeps the base version. Both pairs were checked for shared
objects first and are order-independent, so the choice cannot change the
outcome of a replay:

| Version | Keeps base | Renamed to `+30` |
| --- | --- | --- |
| `20260723040000` | `project_chat` | `20260723040030_vehicle_drive_sessions.sql` |
| `20260723060000` | `issue_assignee_fault` | `20260723060030_time_clock_note.sql` |

### 2. Moved the declined seed out of `supabase/migrations/`

`20260721001000_seed_brain_top10_tips.sql` has not run and the team has decided
not to run it (see the data-backfill section above — only 3 of the 10 window
type codes it targets exist). Leaving it in `migrations/` would keep a file
there that will never run; recording it as applied would be a straight lie in
the history table, and a doc note wouldn't help because `supabase migration
list` reads the table, not the doc.

So it moved to `docs/optional-seeds/`, with a README covering what it is, why it
wasn't run, and how to run it if the catalog codes are ever reconciled. The
migrations folder now contains only files that have run or will run.

### 3. Backfilled `schema_migrations`

`docs/migration-history-backfill-2026-07-28.sql` records the 22 verified
versions the CLI was missing, using the **post-rename** versions and names. It
is `on conflict (version) do nothing`, so it is safely repeatable. (It replaces
`docs/migration-drift-2026-07-28-history-backfill.sql`, which was generated
before the renames and named files that no longer exist.)

The `statements` column is written as `null`. These migrations were not applied
through the CLI, so their statement list was never captured, and `null` says
that honestly where an empty array would claim zero statements ran. Nothing
depends on it — `db push` and the drift check select `version` only.

Once applied, the arithmetic closes: **66 files in `supabase/migrations/`, 66
recorded versions** (44 already on record + 22 backfilled). That equality is the
proof that the repo and the history table agree.

### 4. Keep the drift audit and run it before you trust a release

`scripts/audit-migrations.sh` is checked in and read-only. It needs only
`SUPABASE_ACCESS_TOKEN` and takes a few seconds.

This is the piece that actually protects you, because it does not trust the
history table at all — it compares the repo against the live catalog, including
**function bodies and CHECK-constraint value lists**. Those two checks are what
found `chain_correctness_fixes`; a plain "does this table/column exist?" diff,
and `db push` itself, would both have reported everything fine.

Worth wiring into CI against the production project on a schedule, or at minimum
running it after any hand-applied SQL.

It was re-run after the renames to confirm the renames themselves didn't break
its parsing — it keys off whole filenames, not version prefixes, so they didn't.
Current output over the 66 files: **64 APPLIED, 2 DATA-ONLY** (`seed_demo`,
`seed_modules`), zero MISSING, zero PARTIAL, and function drift of **71
functions matching, 0 absent, 0 with a differing live body**.

## Verified live state (2026-07-28, after the repair)

Checked directly against the live catalog, not inferred from the migration
files:

| Check | Result |
| --- | --- |
| `windows` status constraint accepts `'on_site'` | yes |
| `unload_units` has the `p_location_note` parameter and sets `'on_site'` | yes |
| `undo_install` clears `work_ended_at` and closes the open `task_sessions` row | yes |
| `guard_profile_role_change` trigger on `profiles` | present and enabled |
| our functions in `public` with `search_path` pinned | 74 |
| our `SECURITY DEFINER` functions left unpinned | 0 |
| extension-owned functions in `public` (deliberately untouched) | 118 |

74 is also the total number of functions in `public` that we own, so the
hardening is complete rather than merely large. The privilege-escalation hole
(finding #1 — any signed-in user setting their own `profiles.role` to `owner`)
is closed.

## Files in this change

| File | Purpose |
| --- | --- |
| `docs/migration-drift-2026-07-28.sql` | The repair. Schema-only, idempotent, ordered. **Applied.** |
| `docs/migration-drift-2026-07-28-data-backfill.sql` | The one pending data backfill. Declined; the seed now lives in `docs/optional-seeds/`. |
| `docs/migration-history-backfill-2026-07-28.sql` | Makes `schema_migrations` truthful. 22 rows, post-rename names, repeatable. |
| `docs/optional-seeds/` | Reviewed SQL we chose not to run, kept out of `migrations/` on purpose. |
| `scripts/audit-migrations.sh` | Re-runnable drift audit entry point. |
| `scripts/pgq.sh` | Read-only Management API query helper (refuses non-SELECT). |
| `scripts/live_schema.sql`, `scripts/live_functions.sql` | The catalog snapshot queries. |
| `scripts/migration_objects.py` | Extracts declared objects from each migration file. |
| `scripts/migration_drift.py` | Per-file APPLIED / PARTIAL / MISSING verdict. |
| `scripts/function_drift.py` | Catches stale `create or replace function` bodies. |

## Re-checking it yourself

```bash
export SUPABASE_ACCESS_TOKEN=sbp_...
scripts/audit-migrations.sh
```

Expect 64 APPLIED, 2 DATA-ONLY, and zero function drift.

Once `docs/migration-history-backfill-2026-07-28.sql` has been applied, the CLI
should also agree that there is nothing left to push:

```bash
~/.local/share/supabase/supabase db push --dry-run \
  --db-url "postgresql://postgres.jvsyhtarnvmdilsgksdi:<DB_PASSWORD>@aws-0-us-east-1.pooler.supabase.com:5432/postgres"
```

Expect `Remote database is up to date.`

Two notes on that command. It goes through the **session-mode** pooler (port
`5432`, not the transaction-mode `6543` the dashboard shows by default) because
`db push` needs a session; the pooler is also IPv4, which sidesteps the IPv6
failures seen against the direct `db.<ref>.supabase.co` host. And
`<DB_PASSWORD>` must be URL-encoded if it contains reserved characters.
