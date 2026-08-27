-- Wave T, T4: one active punch, server-enforced.
--
-- time_shifts side: `clock_in` already auto-closes any dangling open shift
-- for the profile before opening the new one — every clock_in overload
-- calls the shared `_close_dangling_shift` (20260730230000, the runaway-
-- shift-guard migration). What it did NOT do is say so on the row: the
-- believable-length branch just stamps `clock_out_at = now(), status =
-- 'submitted'`, indistinguishable from a punch the person actually closed
-- themselves. `closed_reason` below is that missing signal, in the same
-- free-text style `edited_note` already uses for system-written
-- explanations (see the over-cap branch just below it, which already has
-- one). Scope note: this migration only SETS closed_reason at the moment of
-- the auto-close; it deliberately does not chase clearing it again if a
-- human later supplies a real time via edit_shift/finish_shift_at — the
-- clock_out_at value itself is always current either way, and that edit
-- already leaves its own "edited by" trail on top, so a slightly-stale
-- closed_reason is a cosmetic footnote, not a payroll-correctness gap.
--
-- unit_sessions side: nothing to build. `start_unit_session`
-- (20260820000000) already ends the caller's open session via
-- `_end_open_session(v_uid, 'handoff')` before inserting the new one, AND
-- `unit_sessions_one_open` is a partial UNIQUE index on
-- `(profile_id) where ended_at is null` — a hard database invariant, not
-- just careful RPC ordering, so a dangling session is not just unlikely
-- here, it is impossible without the insert itself failing. Verified by
-- reading both (no live database in this environment to exercise it
-- against); this T-item is a comment for that half, per the spec's own
-- "if it already holds, this pick is a test + a comment, say so".

alter table time_shifts add column if not exists closed_reason text;

create or replace function _close_dangling_shift(p_profile uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_cap interval := make_interval(hours => shift_cap_hours());
begin
  -- Believable: a forgotten punch inside the day, or a job/phase switch. The
  -- elapsed time is still evidence, so close it exactly as before — now
  -- also naming WHY, so this row never reads as a punch the person closed
  -- themselves.
  update time_shifts
     set clock_out_at = now(),
         status = 'submitted',
         closed_reason = 'auto-closed by next clock-in'
   where profile_id = p_profile
     and status = 'open'
     and clock_out_at is null
     and now() - clock_in_at <= v_cap;

  -- Not believable. Refuse to name a finish time; say so on the row instead.
  update time_shifts
     set status = 'needs_finish',
         break_started_at = null,
         break_type = null,
         edited_note = left(
           coalesce(edited_note || ' | ', '') ||
           'Ran past ' || shift_cap_hours() || 'h without a clock-out, so the app '
           || 'stopped counting instead of guessing an end time. Needs the real '
           || 'finish time from the crew member or the office.',
           2000)
   where profile_id = p_profile
     and status = 'open'
     and clock_out_at is null
     and now() - clock_in_at > v_cap;
end;
$$;

revoke all on function _close_dangling_shift(uuid) from public;
grant execute on function _close_dangling_shift(uuid) to authenticated;
