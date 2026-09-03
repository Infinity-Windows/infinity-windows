-- A finished unit's minutes come from its own sessions (owner report,
-- 2026-09-02).
--
-- finish_unit works out how long THIS round on THIS unit took by adding up
-- the unit's sessions since the last install filed on it. The cutoff it used
-- was written like this (20260820000000_unit_sessions.sql):
--
--     from unit_sessions
--     where opening_id = p_opening_id and ended_at is not null
--       and started_at > coalesce(
--         (select max(created_at) from install_events
--          where opening_id = p_opening_id and voided_at is null),
--         '-infinity'::timestamptz);
--
-- `install_events` has no `opening_id` column — it has `project_opening_id`
-- (20260715120000_install_capture.sql), and always has. Postgres does not
-- error on that: an unqualified name a subquery cannot resolve is resolved
-- against the ENCLOSING query, so `opening_id` bound to the outer
-- `unit_sessions.opening_id` and the subquery became a correlated one. The
-- outer WHERE already pins that column to `p_opening_id`, so the inner test
-- `opening_id = p_opening_id` was true for every candidate row and the
-- subquery collapsed to
--
--     select max(created_at) from install_events where voided_at is null
--
-- — the newest install filed ANYWHERE on the database, on anyone's job.
--
-- What that did to a real finish: on a busy day some other crew files an
-- install a few minutes ago, so the cutoff sits a few minutes in the past,
-- every session on the unit being finished started before it, and the sum is
-- zero. `nullif(v_minutes, 0)` then hands submit_install_event a NULL and the
-- unit is filed with no minutes and no start time at all — the whole point of
-- per-unit clocking (CONTEXT.md, "Session") silently missing from the record.
-- On a quiet database the last install anywhere happened to BE this unit's,
-- which is why this survived from 2026-08-20 to now.
--
-- The fix is the column name. Same signature, no drop, rebuilt from the
-- CURRENT full body (20260820000000_unit_sessions.sql is still the only file
-- that defines it) rather than patched as a diff — the movements_event_ck
-- lesson. Nothing else in the body changes.
--
-- scripts/test_schema_verify.py now fails on any migration that filters
-- install_events by a bare `opening_id`, so this exact shape cannot come back
-- in a future function without somebody being told.

/**
 * Finish = the whole submit flow (photo/grade gates unchanged — it CALLS
 * submit_install_event) + the session close + the CHAIN: the next unit's
 * session starts in the same transaction, so walk time lands on the
 * incoming unit with zero client round-trips. Minutes passed to the event
 * are SESSION-DERIVED (this round's sessions, 480-cap each) — the
 * hand-typed override is gone.
 */
create or replace function finish_unit(
  p_opening_id uuid,
  p_next_opening_id uuid default null,
  p_installer text default null,
  p_quality_grade int default null,
  p_difficulty text default null,
  p_went_well text default null,
  p_went_poorly text default null,
  p_obstacles text default null,
  p_tools_helped text default null,
  p_time_vs_estimate text default null,
  p_safety_notes text default null,
  p_do_again text default null,
  p_transcript_raw text default null,
  p_installer_id uuid default null,
  p_estimate_minutes int default null
)
returns install_events
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_minutes int;
  v_started timestamptz;
  v_event install_events;
  v_tiers int;
begin
  -- Close the caller's open session on this unit first so it counts.
  update unit_sessions
  set ended_at = now(), end_reason = 'finish'
  where profile_id = v_uid and ended_at is null and opening_id = p_opening_id;

  -- Session-derived figures for THIS round: sessions since the last
  -- non-voided event ON THIS UNIT (all of them for a first install). The
  -- column is `project_opening_id`; a bare `opening_id` here resolves to the
  -- outer unit_sessions row instead and picks the newest install on the whole
  -- database (2026-09-02).
  select coalesce(sum(least(480,
           greatest(0, floor(extract(epoch from (ended_at - started_at)) / 60)))), 0)::int,
         min(started_at)
  into v_minutes, v_started
  from unit_sessions
  where opening_id = p_opening_id and ended_at is not null
    and started_at > coalesce(
      (select max(created_at) from install_events
       where project_opening_id = p_opening_id and voided_at is null),
      '-infinity'::timestamptz);

  v_event := submit_install_event(
    p_opening_id, p_installer, nullif(v_minutes, 0), p_quality_grade,
    p_difficulty, p_went_well, p_went_poorly, p_obstacles, p_tools_helped,
    p_time_vs_estimate, p_safety_notes, p_do_again, p_transcript_raw,
    v_started, p_installer_id, p_estimate_minutes);

  -- Finishing resolves the unit's open redo, if any.
  update unit_redos
  set resolved_at = now()
  where opening_id = p_opening_id and resolved_at is null;

  -- The CHAIN — suppressed on multi-tier units (signature tiers > 1) and
  -- never allowed to sink the submit: a refused start (flashing owed on
  -- the next unit) leaves the finish standing.
  select coalesce(jsonb_array_length(signature -> 'tiers'), 1)
  into v_tiers from project_openings where id = p_opening_id;
  if p_next_opening_id is not null and coalesce(v_tiers, 1) <= 1 then
    begin
      perform start_unit_session(p_next_opening_id, 'install');
    exception when others then
      null; -- next starts by hand
    end;
  end if;

  return v_event;
end;
$$;
