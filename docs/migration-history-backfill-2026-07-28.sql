-- =====================================================================
-- Backfill supabase_migrations.schema_migrations so it tells the truth
-- =====================================================================
-- Generated 2026-07-28 from the migration files on disk AFTER the duplicate
-- timestamp renames in this PR. It supersedes
-- docs/migration-drift-2026-07-28-history-backfill.sql, which was written
-- against the pre-rename filenames and is deleted here.
--
-- WHAT THIS DOES
-- Records the 22 migrations that are genuinely applied to the live database
-- but have no row in the CLI's bookkeeping table. It touches no application
-- data whatsoever -- only the history table.
--
-- WHY THE ROWS ARE MISSING
-- These migrations were applied ad hoc, mostly by POSTing SQL to the Supabase
-- Management API, which writes nothing to schema_migrations. Every one of them
-- was re-verified against the live catalog on 2026-07-28 before being listed
-- here; nothing is recorded on faith.
--
-- SAFE TO RUN MORE THAN ONCE
-- `on conflict (version) do nothing` -- a second run inserts nothing and
-- changes nothing. It will not overwrite the name or statements of a row the
-- CLI already owns.
--
-- COLUMN SHAPE (verified against the live table, 2026-07-28)
--   version    text NOT NULL, primary key
--   statements text[] NULL
--   name       text NULL
-- statements is written as NULL on purpose. These migrations were not applied
-- through the CLI, so the CLI never captured their statement list, and NULL is
-- the honest way to say "not recorded" -- an empty array would claim the
-- migration ran zero statements. Nothing depends on it: `supabase db push`
-- and the drift check read `version` only.
-- =====================================================================

insert into supabase_migrations.schema_migrations (version, name, statements)
values
  -- never actually ran until 2026-07-28 (its twin held 20260718080000); now applied and verified
  ('20260718080030', 'chain_correctness_fixes', null::text[]),
  -- applied 2026-07-28 alongside the fix above
  ('20260718090000', 'security_hardening', null::text[]),
  ('20260720000000', 'offline_outbox_idempotency', null::text[]),
  ('20260720010000', 'push_subscriptions', null::text[]),
  ('20260720020000', 'label_serials_editable_names', null::text[]),
  ('20260721000000', 'window_type_provisional_flag', null::text[]),
  ('20260721002000', 'attachment_geo_feed', null::text[]),
  ('20260721010000', 'crew_scheduling', null::text[]),
  ('20260721020000', 'knowledge_rag', null::text[]),
  ('20260721030000', 'vault_pin', null::text[]),
  ('20260723010000', 'vehicles_machinery', null::text[]),
  ('20260723020000', 'travel_info', null::text[]),
  ('20260723030000', 'vehicle_schedule_link', null::text[]),
  ('20260723040000', 'project_chat', null::text[]),
  -- renamed +30 in this PR; shares a timestamp with project_chat
  ('20260723040030', 'vehicle_drive_sessions', null::text[]),
  ('20260723050000', 'project_message_reads', null::text[]),
  ('20260723060000', 'issue_assignee_fault', null::text[]),
  -- renamed +30 in this PR; shares a timestamp with issue_assignee_fault
  ('20260723060030', 'time_clock_note', null::text[]),
  ('20260724000000', 'mark_specs', null::text[]),
  ('20260727000000', 'mark_spec_drawings', null::text[]),
  ('20260728000000', 'mark_spec_planset', null::text[]),
  ('20260728130000', 'planset_extraction_progress', null::text[])
on conflict (version) do nothing;


-- DELIBERATELY NOT RECORDED
--   20260721001000_seed_brain_top10_tips -- this seed has NOT been run and the
--   team has declined to run it (it writes install tips for 10 window type
--   codes, only 3 of which exist in the live catalog: DH3252, PIC6048,
--   SL7248). Rather than record a migration that never ran -- the exact lie
--   this file exists to remove -- the seed has been moved out of
--   supabase/migrations/ to docs/optional-seeds/. See the README there.


-- ---------------------------------------------------------------------
-- Verification (expect 66 = the number of files in supabase/migrations/)
-- ---------------------------------------------------------------------
-- select count(*) as recorded_versions from supabase_migrations.schema_migrations;
--
-- And nothing should be left unrecorded or recorded-but-absent once this runs:
-- select max(version) as newest from supabase_migrations.schema_migrations;
-- -- expect 20260728130000
