# Optional seeds — reviewed, deliberately not run

Files in this folder are valid SQL that we have **chosen not to apply**. They
are kept here rather than in `supabase/migrations/` on purpose.

`supabase/migrations/` is a promise: everything in it has run, or is about to
run on the next `supabase db push`. A file that sits there indefinitely without
running is the thing that hurt us on 2026-07-28 — see
`docs/migration-audit-2026-07-28.md`. The alternative, recording a row in
`supabase_migrations.schema_migrations` saying it ran when it didn't, is worse:
it is exactly the lie we spent that audit removing, and a note in a doc doesn't
help because `supabase migration list` would still report it as applied.

So: if it hasn't run and we don't intend to run it, it doesn't live in
`migrations/`. Moving it here keeps the folder honest and keeps the file.

---

## `20260721001000_seed_brain_top10_tips.sql`

**What it does.** A single `UPDATE` over `window_types` that fills
`tips_json`, `watch_outs_json` and `difficulty_rating` with real install tips
and watch-outs for the 10 most common window type codes, so the installer brain
card isn't blank before the AI has learned anything from real installs. The
content comes from the St. George Windows nail-fin install walkthrough.

It is self-limiting and safe by construction: it only touches rows whose
`tips_json` is still empty, so it can never clobber tips synthesized later from
real installs, and it preserves any `difficulty_rating` already set.

**Why it hasn't been run.** It targets 10 type codes, but only **3** of them
exist in the live catalog: `DH3252`, `PIC6048`, `SL7248`. The other seven
(`SH3252`, `CAS3048`, `SL6048`, `PIC4848`, `AWN3024`, `HOP3024`, `BAY7248`)
match nothing, so the seed would quietly update 3 rows and skip the rest — the
tips would look delivered while most of the catalog stayed blank.

Fixing that is a **content decision, not an engineering one**: someone has to
reconcile these codes against the real catalog, either by renaming the codes in
the seed to match what's actually stocked or by adding the missing types.

**How to run it later**, once the codes are reconciled:

1. Check what's actually there and what would be touched:

```sql
select type_code, jsonb_array_length(coalesce(tips_json, '[]'::jsonb)) as tips
from window_types
order by type_code;
```

2. Edit the `type_code` values in the seed so every one of them exists.
3. Apply the file's SQL (it is idempotent — re-running changes nothing once
   tips are populated).
4. **Do not** add a row to `supabase_migrations.schema_migrations` for it and do
   not move it back into `supabase/migrations/`. It is a one-off content seed,
   not part of the schema chain, and the chain is now exactly the 66 files in
   `supabase/migrations/`.

Fuller pre/post checks: `docs/migration-drift-2026-07-28-data-backfill.sql`.
