-- Wave T, T1: the clean slate for time-clocking (owner grill, settled
-- 2026-08-26 — see CONTEXT.md's Session/Shift vocabulary and the
-- "Settled decisions" section of the T1 spec):
--
--   WIPE: all rows in the shifts table (time_shifts), all per-unit SESSIONS
--   and their approvals/punch-approval rows die. Toolbox-talk signature
--   history SURVIVES (safety record, not hours).
--
-- Precedent: 20260924010000_wipe_storage_data.sql (the owner's prior
-- clean-slate wipe, done as a plain migration). That one only DELETEd rows
-- from tables nobody needed to keep a copy of. This wipe touches PAYROLL
-- data, so the settled decision is stricter: graveyard-copy first, in the
-- exact form the owner specified —
--
--   create table time_shifts_graveyard as select * from time_shifts
--
-- — so every row survives IN the database, invisible to the app (no RLS
-- policy is added, so nothing but a superuser/service-role connection can
-- read these tables — see the security section below). Nothing is written
-- to a dump file: this repo is public, and a dump file would ship payroll
-- data to it. The owner can DROP these `_graveyard` tables himself whenever
-- he's satisfied nothing needs recovering from them; nothing else in the
-- app ever reads them.
--
-- What "the shifts table" and "per-unit SESSIONS" resolve to, concretely:
--   * time_shifts            — the shift itself. Also carries every
--                               per-punch approval (approved_by/approved_at
--                               are columns on this same row, per
--                               20260717001000/20260810000000 — there is no
--                               separate approvals table to wipe).
--   * time_shift_edits       — the append-only edit/void audit trail
--                               (20260810000000). Child of time_shifts via
--                               `on delete cascade`; graveyarded for the
--                               same reason time_shifts is, and truncated
--                               alongside it.
--   * unit_sessions          — CONTEXT.md's "Session": "the atomic time
--                               record: one installer, one unit, a start,
--                               a stop" (20260820000000). This is the
--                               per-unit clocking data the settled decision
--                               means by "SESSIONS".
--
-- Deliberately NOT touched, and why:
--   * toolbox_completions    — signature history, explicitly kept ("a
--                               safety record, not hours").
--   * unit_redos             — CONTEXT.md's "Rework": a quality/redo flag
--                               on a unit, not a time record. Nothing in
--                               the settled decision calls for erasing
--                               which units were sent back for rework just
--                               because the clock is being reset.
--   * task_sessions          — the RETIRED pre-`unit_sessions` on/off/break
--                               log (20260718007000; superseded per
--                               20260820000000's own header comment). Not
--                               CONTEXT.md's "Session", and not live payroll
--                               data — nothing writes it any more.
--   * overtime_rules         — configuration (the company's OT policy),
--                               not a time record.
--
-- The app is expected to keep working against empty tables: every reader
-- already handles zero rows as "no shifts yet" / "no sessions yet" rather
-- than crashing (verified by the existing vitest suite and by hand against
-- the built pages after this migration).

-- ---------------------------------------------------------------- graveyard
-- Point-in-time copies, taken before anything is touched. `select *` (not an
-- explicit column list) so the copy can never silently drop a column future
-- code depends on. No RLS policy is added on purpose: RLS with zero policies
-- denies every role but a superuser/service-role connection, which is
-- exactly "invisible to the app" — nothing in the client ever queries a
-- `_graveyard` table, and nothing here grants it the ability to.

create table if not exists time_shifts_graveyard as
  select * from time_shifts;
alter table time_shifts_graveyard enable row level security;

create table if not exists time_shift_edits_graveyard as
  select * from time_shift_edits;
alter table time_shift_edits_graveyard enable row level security;

create table if not exists unit_sessions_graveyard as
  select * from unit_sessions;
alter table unit_sessions_graveyard enable row level security;

-- ------------------------------------------------------------------ wipe
-- time_shift_edits is a child of time_shifts (`shift_id ... on delete
-- cascade`); truncating both together in one statement satisfies that
-- foreign key without needing CASCADE. unit_sessions has no dependents
-- (confirmed: it is the only table besides time_shift_edits that
-- references time_shifts, and nothing references unit_sessions at all), so
-- it truncates alone.

truncate table time_shift_edits, time_shifts;
truncate table unit_sessions;
