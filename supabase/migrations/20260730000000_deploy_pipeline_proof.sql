-- Proof that a migration in a merged PR reaches production by itself.
--
-- Deliberately the most harmless statement that is still externally provable.
-- A table comment changes no table, no column, no row, no policy and no
-- privilege; it writes one entry in pg_description and nothing else. If this
-- migration were to fail, or to be skipped, nothing about the app changes —
-- which is exactly what makes it safe to be the first thing pushed by an
-- automated pipeline that had never successfully pushed anything before.
--
-- Why it exists at all: until 2026-07-29 the "Push migrations" job reported
-- SUCCESS on every merge while applying nothing, because its database password
-- was never set and the job warned-and-passed instead of failing. A green tick
-- was therefore not evidence of anything. This gives the first run something to
-- apply whose presence can be read straight back out of the live catalog:
--
--   select obj_description('public.locations'::regclass, 'pg_class');
--
-- Idempotent: `comment on` is a set, not an append, so re-running is a no-op.
comment on table public.locations is
  'Warehouse and job-site locations. Comment set by migration '
  '20260730000000 to prove the backend deploy pipeline applies migrations '
  'automatically on merge to master (docs/always-live.md).';
