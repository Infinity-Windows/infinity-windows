-- =====================================================================
-- PENDING DATA BACKFILL — needs a human decision, 2026-07-28
-- =====================================================================
-- This is deliberately SEPARATE from docs/migration-drift-2026-07-28.sql.
-- That script is schema-only and safe to apply as a unit. This one REWRITES
-- ROWS, so it is called out on its own rather than bundled.
--
-- Source migration: supabase/migrations/20260721001000_seed_brain_top10_tips.sql
-- Status: NOT APPLIED. It is not recorded in supabase_migrations.schema_migrations,
-- and the live data confirms it never ran — zero rows in window_types have any
-- tips (`with_tips = 0` across all 34 rows).
--
-- What it does: a single UPDATE over window_types that fills tips_json,
-- watch_outs_json and difficulty_rating for ten named catalog codes, sourced
-- from the St. George Windows nail-fin install walkthrough. It powers the
-- installer "brain" tips card, which is currently blank for every window type.
--
-- It is self-limiting and safe to re-run:
--   * matched by `wt.type_code = v.code`, so only the ten named codes,
--   * guarded by `jsonb_array_length(coalesce(wt.tips_json,'[]'::jsonb)) = 0`,
--     so it only fills types whose tips are still EMPTY and can never clobber
--     AI-synthesized tips generated later from real installs,
--   * difficulty_rating uses `coalesce(wt.difficulty_rating, v.diff)`, so an
--     existing rating is preserved.
--
-- WHAT YOU SHOULD KNOW BEFORE DECIDING
-- Only 3 of the 10 codes it targets actually exist in the live catalog, so it
-- will update 3 rows, not 10:
--
--   targeted : SH3252 DH3252 CAS3048 SL6048 SL7248 PIC4848 PIC6048 AWN3024
--              HOP3024 BAY7248
--   live non-provisional catalog (10 rows):
--              AWN3624 BAY9648 CAS3050 CAS3660 DH2846 DH3252 PIC4836 PIC6048
--              SL6040 SL7248
--   overlap  : DH3252, PIC6048, SL7248   <- the only rows this will touch
--
-- So applying it is low-risk but also low-yield: seven of the ten tip sets have
-- no matching catalog row and will be silently skipped. If the intent is for
-- the brain card to be populated across the catalog, the tip codes need to be
-- reconciled with the real catalog codes first. That is a content decision,
-- which is exactly why this is not bundled into the schema script.
--
-- HOW TO APPLY
-- The payload is long (ten multi-paragraph JSON tip sets) and is already
-- idempotent, so it is not duplicated here — run the migration file verbatim:
--
--     supabase/migrations/20260721001000_seed_brain_top10_tips.sql
--
-- =====================================================================


-- ---------------------------------------------------------------------
-- BEFORE: confirm the backfill has not run and see what it would touch.
-- Expect tips=0 for all three overlapping codes.
-- ---------------------------------------------------------------------
select
  type_code,
  jsonb_array_length(coalesce(tips_json, '[]'::jsonb))       as tips,
  jsonb_array_length(coalesce(watch_outs_json, '[]'::jsonb)) as watch_outs,
  difficulty_rating,
  provisional
from window_types
where type_code in (
  'SH3252','DH3252','CAS3048','SL6048','SL7248',
  'PIC4848','PIC6048','AWN3024','HOP3024','BAY7248'
)
order by type_code;


-- ---------------------------------------------------------------------
-- AFTER: the three overlapping codes should report non-zero tips.
-- ---------------------------------------------------------------------
-- select count(*) filter (where jsonb_array_length(coalesce(tips_json,'[]'::jsonb)) > 0)
--          as types_with_tips,
--        count(*) as total_types
--   from window_types;
