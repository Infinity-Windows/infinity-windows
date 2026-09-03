-- One tap says the rough opening is good, without typing a tape measure.
--
-- The checklist is three judgments and up to nine numbers, and on a phone at
-- the wall that is a minute a window. Owner's ask (2026-09-02): put a fast
-- path right beside "Save rough opening" for the openings an installer can
-- see are fine — held the unit up to the hole, it goes in — so the fit gate
-- stops reading "Rough opening not measured." on windows nobody is worried
-- about.
--
-- The flag is deliberately WEAKER than a measurement. It is only read when
-- there are no numbers on file, and saving numbers clears it (the rebuild at
-- the bottom of this file). That is the same rule the checklist already
-- applies when the tape disagrees with a Good tap: the tape outranks the
-- thumb, always.

alter table project_openings
  add column if not exists ro_quick_ok boolean not null default false;

comment on column project_openings.ro_quick_ok is
  'One-tap "quick check: all good" on the rough opening: somebody looked and '
  'said the unit goes in, without writing tape numbers down. Only read when '
  'ro_width_in / ro_height_in are null — set_opening_rough_opening clears it '
  'whenever real numbers are saved, because numbers always win.';

-- Record the quick check.
--
-- Caller rules are copied from set_opening_rough_opening, which this sits
-- next to on the same screen: SECURITY INVOKER (the default), so the
-- `openings_update_live` policy from 20260730210000 decides who may write —
-- any authenticated crew member, on a row that has not been removed. It is
-- deliberately NOT security definer: the measurement RPC beside it is not
-- either, and a definer version here would let one tap write rows the tape
-- measure cannot, including soft-removed openings and openings a partner
-- login may not even read (20260950000000).
--
-- Execute is granted the way the neighbour's is — by Supabase's default ACL
-- on `public`, which is why set_opening_rough_opening carries no grant of its
-- own. The grant below only states that out loud for the roles the app uses.
--
-- search_path is pinned for the same reason 20260718090000_security_hardening
-- pinned it on every other function in `public`: an unpinned one is a linter
-- warning here, and a privilege-escalation route on any function that later
-- turns definer.
create or replace function quick_check_rough_opening(
  p_opening_id uuid,
  p_actor text default null
)
returns project_openings
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_opening project_openings;
begin
  update project_openings
  set ro_quick_ok = true,
      ro_measured_by = p_actor,
      ro_measured_at = now()
  where id = p_opening_id
  returning * into v_opening;

  if v_opening is null then
    raise exception 'unknown opening %', p_opening_id;
  end if;
  return v_opening;
end;
$$;

grant execute on function quick_check_rough_opening(uuid, text) to authenticated;

-- Full current body from 20260811040000_ro_check_saved.sql, plus one line:
-- real numbers clear the quick check.
--
-- Rebuilt in full rather than altered because `create or replace function`
-- replaces everything about the function — a partial rebuild would silently
-- drop the saved-checklist behaviour, and omitting the `set search_path`
-- clause would undo 20260718090000_security_hardening's pinning on this one
-- function.
--
-- Why the clear matters: without it, an opening quick-checked in the morning
-- and measured in the afternoon would carry both answers, and a measurement
-- that reads "too small" would sit next to a stale "all good". The
-- measurement is the record; the quick check was only ever standing in for
-- one that had not been taken.
create or replace function set_opening_rough_opening(
  p_opening_id uuid,
  p_width_in numeric,
  p_height_in numeric,
  p_actor text default null,
  p_check jsonb default null
)
returns project_openings
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_opening project_openings;
begin
  update project_openings
  set ro_width_in = p_width_in,
      ro_height_in = p_height_in,
      ro_measured_by = p_actor,
      ro_measured_at = now(),
      ro_check = coalesce(p_check, ro_check),
      ro_quick_ok = false
  where id = p_opening_id
  returning * into v_opening;

  if v_opening is null then
    raise exception 'unknown opening %', p_opening_id;
  end if;
  return v_opening;
end;
$$;
