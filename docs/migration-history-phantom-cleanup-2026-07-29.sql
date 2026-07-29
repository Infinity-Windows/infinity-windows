-- =====================================================================
-- Remove phantom rows from supabase_migrations.schema_migrations
-- =====================================================================
-- NOT RUN. Left here for a human to approve, because the repair brief
-- forbade DELETE and these rows, while wrong, are harmless to the app.
--
-- PREFER THE SCRIPT. `scripts/cleanup-migration-phantoms.sh` runs this same
-- cleanup with the guards a hand-run SELECT-then-DELETE cannot give you: it
-- names the project explicitly, previews before it writes, needs --execute,
-- refuses unless the table is exactly 107 rows / 70 files / 37 phantoms, and
-- rolls back if the result is not 70 rows with every filename version intact.
-- The ordering — and whether this must happen before the deploy secrets are
-- added — is in docs/db-push-readiness.md.
--
-- WHAT IS WRONG
-- After the 2026-07-29 production repair the history table holds 107 rows for
-- 70 migration files. All 70 filename versions are present and correct. The
-- other 37 are phantoms — versions that match no file in supabase/migrations/:
--
--   * 26 rows stamped 2026072917xxxx / 2026072918xxxx. The Supabase MCP
--     `apply_migration` tool writes its own timestamp as the `version` and puts
--     the migration's name in `name`, so applying a back-dated file creates a
--     row that duplicates the canonical one under a today-dated version.
--
--   * 11 older rows (20260715185858 .. 20260720223956) that already matched no
--     filename before this work. Their `name` values (install_capture,
--     planset_kind, role_rename, ...) do correspond to real migrations, so they
--     look like earlier ad-hoc applications recorded under a wall-clock version.
--
-- WHY IT MATTERS
-- `supabase db push` and `supabase migration list` compare VERSIONS against the
-- files on disk. 37 remote-only versions show up as migrations the local repo
-- has lost, which is exactly the confusion this cleanup removes. The rows carry
-- no application data — dropping them cannot lose a byte of anyone's work.
--
-- SAFETY
-- Scoped by an explicit version list, not a pattern, so it can only ever touch
-- these 37 rows. Re-running it is a no-op. Run the SELECT first and confirm it
-- returns exactly 37 rows, none of which is a filename version.
-- =====================================================================

-- 1) Preview. Expect 37 rows, and expect every `version` to be absent from
--    the filenames in supabase/migrations/.
select version, name
from supabase_migrations.schema_migrations
where version not in (
  '20260715000000','20260715000100','20260715120000','20260715200000',
  '20260715210000','20260715230000','20260715240000','20260716000000',
  '20260716001000','20260716002000','20260716003000','20260716004000',
  '20260716005000','20260716010000','20260717000000','20260717001000',
  '20260717002000','20260717003000','20260717004000','20260717005000',
  '20260717006000','20260717007000','20260717008000','20260717009000',
  '20260717140000','20260718000000','20260718001000','20260718002000',
  '20260718003000','20260718004000','20260718005000','20260718006000',
  '20260718007000','20260718010000','20260718023000','20260718030000',
  '20260718040000','20260718040030','20260718050000','20260718050030',
  '20260718060000','20260718060030','20260718070000','20260718080000',
  '20260718080030','20260718090000','20260720000000','20260720010000',
  '20260720020000','20260721000000','20260721002000','20260721010000',
  '20260721020000','20260721030000','20260723010000','20260723020000',
  '20260723030000','20260723040000','20260723040030','20260723050000',
  '20260723060000','20260723060030','20260724000000','20260727000000',
  '20260728000000','20260728130000','20260728140000','20260728150000',
  '20260728160000','20260728170000'
)
order by version;

-- 2) The cleanup. Same predicate. Run only after the preview looks right.
--
-- delete from supabase_migrations.schema_migrations
-- where version not in ( ...the same 70 versions... );

-- 3) Verify. Expect exactly 70.
-- select count(*) from supabase_migrations.schema_migrations;
