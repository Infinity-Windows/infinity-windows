# Migration drift audit — 2026-07-28

Triggered by a live failure: "Load marks from plans" died with
`Could not find the 'provisional' column of 'window_types' in the schema cache
[PGRST204]` because `20260721000000_window_type_provisional_flag.sql` was in the
repo but had never been applied. That migration has since been applied. This
audit answers the follow-up question: **what else is missing?**

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

| Verdict | Files |
| --- | --- |
| APPLIED | 62 |
| PARTIALLY APPLIED | 1 |
| MISSING | 1 |
| DATA-ONLY (seeds/backfills, verified by querying rows) | 3 |

Only two files carry schema drift.

### `20260718080000_chain_correctness_fixes.sql` — effectively entirely unapplied

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

- `trg_guard_profile_role_change` does not exist in any schema
- the `guard_profile_role_change` trigger on `profiles` does not exist
- 27 `SECURITY DEFINER` functions have no pinned `search_path` (plus 155
  `SECURITY INVOKER` functions)

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

Neither unapplied schema migration contains a top-level `update`/`delete`; the
`UPDATE`s inside `chain_correctness_fixes` are runtime logic within function
bodies, not backfills.

## Recommendation: keep the history honest

**Do all three, in this order.** They solve different halves of the problem and
the cheapest one is the one that would have caught this bug.

### 1. Rename the duplicate-timestamp files (do this first — it is the actual root cause)

Six pairs share a version prefix. This is what let a completely unapplied
migration hide behind its twin's recorded version, and no amount of process
discipline fixes it, because the CLI physically cannot record two rows for one
version. Renaming the second file of each pair to a unique timestamp (the CLI's
own `+30s` convention) makes the failure impossible rather than unlikely.

Pairs: `20260718040000`, `20260718050000`, `20260718060000`, `20260718080000`,
`20260723040000`, `20260723060000`.

Trade-off: renaming files that are already applied is safe *only* once the
history table records the new names, so do it together with step 2.

### 2. Backfill `schema_migrations`, then use `supabase db push` from here on

`docs/migration-drift-2026-07-28-history-backfill.sql` records the 23 verified
versions the CLI is missing. Once applied, `supabase migration list` becomes
truthful and `db push` has a sane starting point.

Trade-off and the reason this is not sufficient on its own: `db push` has
previously failed here on remote-history mismatch and on IPv6 connectivity. The
history mismatch is exactly what the backfill fixes. The IPv6 problem is
environmental — if the direct `db.<ref>.supabase.co` host is IPv6-only from this
network, use the CLI's session-mode pooler host (IPv4) via
`--db-url`, or keep the Management API as the fallback path. The CLI is at
`~/.local/share/supabase/supabase` (v2.109.1).

Note the backfill records *names only*, not `statements`. That is fine for
`db push`, which keys off `version`.

### 3. Keep the drift audit and run it before you trust a release

`scripts/audit-migrations.sh` is checked in and read-only. It needs only
`SUPABASE_ACCESS_TOKEN` and takes a few seconds.

This is the piece that actually protects you, because it does not trust the
history table at all — it compares the repo against the live catalog, including
**function bodies and CHECK-constraint value lists**. Those two checks are what
found `chain_correctness_fixes`; a plain "does this table/column exist?" diff,
and `db push` itself, would both have reported everything fine.

Worth wiring into CI against the production project on a schedule, or at minimum
running it after any hand-applied SQL.

## Files in this change

| File | Purpose |
| --- | --- |
| `docs/migration-drift-2026-07-28.sql` | The repair. Schema-only, idempotent, ordered. **Apply this.** |
| `docs/migration-drift-2026-07-28-data-backfill.sql` | The one pending data backfill, called out separately for a decision. |
| `docs/migration-drift-2026-07-28-history-backfill.sql` | Optional; makes `schema_migrations` truthful. Run after the repair verifies clean. |
| `scripts/audit-migrations.sh` | Re-runnable drift audit entry point. |
| `scripts/pgq.sh` | Read-only Management API query helper (refuses non-SELECT). |
| `scripts/live_schema.sql`, `scripts/live_functions.sql` | The catalog snapshot queries. |
| `scripts/migration_objects.py` | Extracts declared objects from each migration file. |
| `scripts/migration_drift.py` | Per-file APPLIED / PARTIAL / MISSING verdict. |
| `scripts/function_drift.py` | Catches stale `create or replace function` bodies. |

## Applying the repair

```bash
export SUPABASE_ACCESS_TOKEN=sbp_...

# 1. Apply the schema repair (review it first).
# 2. Re-run the audit — chain_correctness_fixes and security_hardening
#    should both drop off the list, and function drift should be zero.
scripts/audit-migrations.sh
```
