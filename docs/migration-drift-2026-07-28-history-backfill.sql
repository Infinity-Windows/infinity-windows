-- =====================================================================
-- OPTIONAL — make supabase_migrations.schema_migrations tell the truth again
-- =====================================================================
-- Run this ONLY AFTER docs/migration-drift-2026-07-28.sql has been applied and
-- its verification queries all report OK. Until then, recording these versions
-- would make the history claim things that are not in the database — the exact
-- failure mode this whole audit exists to fix.
--
-- Nothing here touches application data. It only writes rows to the CLI's
-- bookkeeping table so `supabase migration list` and `supabase db push` stop
-- believing 23 applied migrations are still pending.
--
-- WHY THESE ROWS ARE MISSING
-- These migrations were applied by POSTing SQL to the Supabase Management API,
-- which records nothing in schema_migrations. They ARE in the database — the
-- audit verified every object each one declares against the live catalog.
--
-- THE DUPLICATE-TIMESTAMP PROBLEM (this is what bit us)
-- Six pairs of files share a version prefix. The CLI can only record one row
-- per version, so for the pairs it did apply it bumped the second file by 30
-- seconds (20260718050030, 20260718060030, 20260718040030 are all in the table
-- already). For 20260718080000 it recorded only `project_details` — and
-- `chain_correctness_fixes`, which shares that timestamp, was never applied at
-- all yet looked applied because its twin's version was on record.
--
-- So the two still-unrecorded pairs below get the same +30 treatment, and
-- chain_correctness_fixes is recorded as 20260718080030.
--
-- The durable fix is to RENAME the duplicate files so no two share a version.
-- See docs/migration-audit-2026-07-28.md.
-- =====================================================================

insert into supabase_migrations.schema_migrations (version, name)
values
  -- Repaired by docs/migration-drift-2026-07-28.sql. Recorded at +30 because
  -- 20260718080000 is already taken by its twin, project_details.
  ('20260718080030', 'chain_correctness_fixes'),
  ('20260718090000', 'security_hardening'),

  -- Applied by hand via the Management API; verified present in the live catalog.
  ('20260720000000', 'offline_outbox_idempotency'),
  ('20260720010000', 'push_subscriptions'),
  ('20260720020000', 'label_serials_editable_names'),
  ('20260721000000', 'window_type_provisional_flag'),
  ('20260721002000', 'attachment_geo_feed'),
  ('20260721010000', 'crew_scheduling'),
  ('20260721020000', 'knowledge_rag'),
  ('20260721030000', 'vault_pin'),
  ('20260723010000', 'vehicles_machinery'),
  ('20260723020000', 'travel_info'),
  ('20260723030000', 'vehicle_schedule_link'),
  ('20260723040000', 'project_chat'),
  ('20260723040030', 'vehicle_drive_sessions'),   -- +30: shares a version with project_chat
  ('20260723050000', 'project_message_reads'),
  ('20260723060000', 'issue_assignee_fault'),
  ('20260723060030', 'time_clock_note'),          -- +30: shares a version with issue_assignee_fault
  ('20260724000000', 'mark_specs'),
  ('20260727000000', 'mark_spec_drawings'),
  ('20260728000000', 'mark_spec_planset'),
  ('20260728130000', 'planset_extraction_progress')
on conflict (version) do nothing;

-- DELIBERATELY NOT RECORDED:
--   20260721001000_seed_brain_top10_tips — this one genuinely has NOT run (no
--   window_type has any tips). It is a data backfill; see
--   docs/migration-drift-2026-07-28-data-backfill.sql. Record it only after you
--   decide to run it.


-- ---------------------------------------------------------------------
-- Verification: 66 of the 67 repo files should now be on record.
-- ---------------------------------------------------------------------
-- select count(*) as recorded_versions from supabase_migrations.schema_migrations;
