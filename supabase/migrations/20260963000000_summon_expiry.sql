-- A summon ends a day after it was sent (owner ask, 2026-09-02).
--
-- "A summons should expire 1 day after the user sends the summons." Nobody
-- closes a call for hands that nobody answered — the caller has moved on to
-- another window and forgotten it — so live summons pile up on every crew
-- member's landing strip forever. One day is the whole rule: past that, the
-- call is over.
--
-- Three pieces, because a sweep alone leaves a gap:
--
--   1. expire_summons() closes every day-old open/covered summon exactly the
--      way close_summon does, so an expired call and an ended one leave
--      identical rows behind. close_summon is rebuilt alongside it, because
--      the statement they share had to learn to leave a helper who backed
--      out alone.
--   2. pg_cron runs it every 10 minutes (the summon 5-minute-warning
--      migration, 20260918000000, is the pattern; the nightly trash purge,
--      20260959000000, is the pure-SQL-no-HTTP-hop version this copies).
--   3. answer_summon, decline_summon and create_summon apply the same
--      one-day rule INLINE, so the up-to-10-minutes between sweeps can never
--      let someone answer a call that is already over — or, on the caller's
--      side, block a fresh summon on a window whose old one has expired but
--      not yet been swept.
--
-- Every function this file replaces is rebuilt from its CURRENT full body
-- (the movements_event_ck lesson: whole body, never a diff) — 20260923020000
-- for answer_summon and decline_summon, 20260920000000 for create_summon,
-- 20260818000000 for close_summon, 20260919000000 for the helper-session
-- trigger — with the same signatures, so nothing is dropped and no overload
-- appears.

-- ---------------------------------------------------------------------------
-- 1. The sweep
-- ---------------------------------------------------------------------------
-- The helper UPDATE is close_summon's statement, because an expired summon
-- must be indistinguishable from one the caller ended by hand — the same
-- stamped minutes, and the same helper-session trigger firing behind it
-- (unit_sessions_follow_summon_helpers ends the helper's clock on that
-- window when completed_at lands) — or the time record would tell two
-- different stories about the same afternoon.
--
-- With one guard both statements need: `canceled_at is null`. Somebody who
-- answered at 08:00 and tapped "Can't make it" at 08:05 already has
-- minutes = 0 and a canceled_at, and completed_at still NULL
-- (cancel_summon_help, 20260919000000). Without the guard the sweep stamps
-- them too — up to eight hours credited to a person who worked five minutes,
-- and the trigger's 'complete' branch fired on somebody who never completed.
-- close_summon does that to one row when a human ends one call; the sweep
-- would do it every ten minutes to every stale row on the books, and the
-- first run after this deploys hits the whole backlog at once. So
-- close_summon is rebuilt with the same guard below — they stay the same
-- statement on purpose.
create or replace function public.expire_summons()
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_closed int;
begin
  update summon_helpers h
  set completed_at = now(),
      minutes = least(480, greatest(0, floor(extract(epoch from now() - h.joined_at) / 60))::int)
  where h.completed_at is null
    and h.canceled_at is null
    and h.summon_id in (
      select s.id from summons s
      where s.status in ('open', 'covered')
        and s.created_at < now() - interval '1 day'
    );

  with expired as (
    update summons
    set status = 'closed', closed_at = now()
    where status in ('open', 'covered')
      and created_at < now() - interval '1 day'
    returning 1
  )
  select count(*) into v_closed from expired;

  return v_closed;
end;
$$;

comment on function public.expire_summons() is
  'The one-day rule (owner, 2026-09-02): closes every summon still open or covered a day after it was sent, stamping unfinished helpers exactly as close_summon does — and leaving helpers who backed out alone — so an expired call is indistinguishable from an ended one. Run every 10 minutes by pg_cron (''expire-summons''); the same rule is enforced inline by create_summon, answer_summon and decline_summon so the gap between sweeps changes nothing anyone can do.';

revoke all on function public.expire_summons() from public, anon;
grant execute on function public.expire_summons() to authenticated, service_role;

-- Full current body from 20260818000000_summons.sql, plus the same
-- canceled_at guard. It was written before cancel_summon_help existed
-- (20260919000000 added canceled_at), so ending a call by hand overwrote a
-- helper's deliberate "Can't make it" — minutes = 0 replaced by up to eight
-- hours — and told the session trigger they had completed. One person doing
-- it to one call hid the bug; a sweep doing it to the backlog every ten
-- minutes is what found it.
create or replace function close_summon(p_summon_id uuid)
returns summons
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_summon summons;
begin
  select * into v_summon from summons where id = p_summon_id for update;
  if v_summon.id is null then
    raise exception 'summon not found';
  end if;
  if v_summon.requested_by <> v_uid and not _is_lead(v_uid) then
    raise exception 'only the caller or a foreman can end a summon';
  end if;
  update summon_helpers
  set completed_at = now(),
      minutes = least(480, greatest(0, floor(extract(epoch from now() - joined_at) / 60))::int)
  where summon_id = p_summon_id and completed_at is null and canceled_at is null;
  update summons
  set status = 'closed', closed_at = now()
  where id = p_summon_id
  returning * into v_summon;
  return v_summon;
end;
$$;

-- Full current body from 20260919000000_summon_cancel.sql, plus the window
-- the session belongs to.
--
-- Stamping a helper row ends that person's helper clock, and the two UPDATE
-- branches matched on profile_id alone: "end whatever helper session this
-- person has open". That held while only a human ended a call they were
-- standing at. It stops holding the moment a sweep stamps YESTERDAY's
-- unfinished row: Dana helped on BLACK22 and never tapped Complete, answers
-- a fresh summon on RAC-OAK-5 this morning, and ten minutes later the sweep
-- over the old job ends the clock she is carrying a window on right now —
-- and on the first run after deploy, for everyone with a stale row at once.
--
-- unit_sessions has no summon_id, so the opening is the closest thing to the
-- session's identity we can name: end the helper clock on the window THIS
-- summon was called for.
create or replace function unit_sessions_follow_summon_helpers()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_opening uuid;
begin
  if tg_op = 'INSERT' then
    select opening_id into v_opening from summons where id = new.summon_id;
    if v_opening is not null then
      perform _close_stale_sessions(new.profile_id);
      perform _end_open_session(new.profile_id, 'handoff');
      insert into unit_sessions (opening_id, profile_id, role, is_rework)
      values (v_opening, new.profile_id, 'helper', _has_open_redo(v_opening));
    end if;
    return new;
  end if;
  if tg_op = 'UPDATE' and new.completed_at is not null and old.completed_at is null then
    select opening_id into v_opening from summons where id = new.summon_id;
    update unit_sessions
    set ended_at = now(), end_reason = 'complete'
    where profile_id = new.profile_id and ended_at is null and role = 'helper'
      and opening_id = v_opening;
  end if;
  if tg_op = 'UPDATE' and new.canceled_at is not null and old.canceled_at is null then
    select opening_id into v_opening from summons where id = new.summon_id;
    update unit_sessions
    set ended_at = now(), end_reason = 'handoff'
    where profile_id = new.profile_id and ended_at is null and role = 'helper'
      and opening_id = v_opening;
  end if;
  -- A revived answer (canceled_at cleared) opens a fresh helper session.
  if tg_op = 'UPDATE' and new.canceled_at is null and old.canceled_at is not null then
    select opening_id into v_opening from summons where id = new.summon_id;
    if v_opening is not null then
      perform _close_stale_sessions(new.profile_id);
      perform _end_open_session(new.profile_id, 'handoff');
      insert into unit_sessions (opening_id, profile_id, role, is_rework)
      values (v_opening, new.profile_id, 'helper', _has_open_redo(v_opening));
    end if;
    return new;
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Every 10 minutes, under cron's own trusted context
-- ---------------------------------------------------------------------------
-- Same idempotent unschedule-then-schedule shape as 20260918000000, and the
-- same "no pg_net hop" call as 20260959000000 — there is nothing here worth
-- exposing to an anonymous poke. One departure from both: the extension and
-- the schedule are wrapped so a database WITHOUT pg_cron (a local `supabase
-- start`, a fork for a test) still applies this migration. The sweep is a
-- convenience, not the rule — the three RPCs below hold the line on their
-- own — so a missing scheduler deserves a warning in the log, not a failed
-- migration.
do $$
begin
  create extension if not exists pg_cron;
exception when others then
  raise warning 'expire_summons: pg_cron is not available here (%) — the sweep will not run, but the one-day rule still holds in create_summon, answer_summon and decline_summon.', sqlerrm;
end;
$$;

do $$
begin
  perform cron.unschedule('expire-summons');
exception when others then
  null; -- first run: nothing scheduled yet
end;
$$;

do $$
begin
  perform cron.schedule(
    'expire-summons',
    '*/10 * * * *',
    $c$ select public.expire_summons(); $c$
  );
exception when others then
  raise warning 'expire_summons: could not schedule the sweep (%) — the one-day rule still holds in create_summon, answer_summon and decline_summon.', sqlerrm;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. The same rule, inline, so the gap between sweeps is not a loophole
-- ---------------------------------------------------------------------------

-- Full current body from 20260920000000_summon_note.sql, plus the one-day
-- rule on the "already live" check. Without it, a caller whose summon has
-- expired but not yet been swept is told 'a summon is already live on this
-- window' when they try again — the app has stopped showing them that summon
-- by then, so the message would read as the app being broken.
create or replace function create_summon(
  p_opening_id uuid,
  p_needed int,
  p_lead_minutes int default null,
  p_note text default null
)
returns summons
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_project uuid;
  v_row summons;
begin
  if p_needed is null or p_needed < 1 or p_needed > 8 then
    raise exception 'ask for between 1 and 8 helpers';
  end if;
  if p_lead_minutes is not null and (p_lead_minutes < 5 or p_lead_minutes > 480) then
    raise exception 'lead time must be between 5 minutes and 8 hours';
  end if;
  if p_note is not null and length(p_note) > 500 then
    raise exception 'keep the note under 500 characters';
  end if;
  select project_id into v_project from project_openings where id = p_opening_id;
  if v_project is null then
    raise exception 'opening not found';
  end if;
  if exists (
    select 1 from summons
    where opening_id = p_opening_id
      and status in ('open', 'covered')
      and created_at >= now() - interval '1 day'
  ) then
    raise exception 'a summon is already live on this window';
  end if;
  insert into summons (project_id, opening_id, requested_by, needed, needed_at, note)
  values (
    v_project, p_opening_id, v_uid, p_needed,
    case when p_lead_minutes is null then null
         else now() + make_interval(mins => p_lead_minutes) end,
    nullif(trim(p_note), '')
  )
  returning * into v_row;
  return v_row;
end;
$$;

-- Full current body from 20260923020000_summon_decline.sql, plus the one-day
-- rule. Walking over to a call that went out yesterday helps nobody, so it
-- gets the same plain words a closed summon gets.
create or replace function answer_summon(p_summon_id uuid)
returns summon_helpers
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_summon summons;
  v_row summon_helpers;
  v_count int;
begin
  if not exists (
    select 1 from time_shifts
    where profile_id = v_uid and status = 'open' and clock_out_at is null
  ) then
    raise exception 'clock in before answering a summon';
  end if;
  select * into v_summon from summons where id = p_summon_id for update;
  if v_summon.id is null then
    raise exception 'summon not found';
  end if;
  if v_summon.status = 'closed' then
    raise exception 'this summon has ended';
  end if;
  -- Expired but not yet swept: a day-old call is over whatever the row says.
  if v_summon.created_at < now() - interval '1 day' then
    raise exception 'this summon has ended';
  end if;
  if v_summon.requested_by = v_uid then
    raise exception 'you called this summon — no answering yourself';
  end if;
  select count(*) into v_count
  from summon_helpers
  where summon_id = p_summon_id and canceled_at is null;
  if v_count >= v_summon.needed then
    raise exception 'this summon is covered — thanks anyway';
  end if;

  -- Re-answer after a cancel revives the old row; first answer inserts.
  update summon_helpers
  set canceled_at = null, joined_at = now(), completed_at = null, minutes = null
  where summon_id = p_summon_id and profile_id = v_uid and canceled_at is not null
  returning * into v_row;
  if v_row.id is null then
    insert into summon_helpers (summon_id, profile_id)
    values (p_summon_id, v_uid)
    returning * into v_row;
  end if;

  if v_count + 1 >= v_summon.needed then
    update summons set status = 'covered' where id = p_summon_id;
  end if;

  insert into points_ledger (profile_id, kind, points, ref, status)
  values (v_uid, 'summon_answer', 10, p_summon_id::text, 'confirmed');

  -- You answered — any earlier "can't help" no longer applies.
  delete from summon_declines where summon_id = p_summon_id and profile_id = v_uid;

  return v_row;
end;
$$;

-- Full current body from 20260923020000_summon_decline.sql, plus the one-day
-- rule. Declining a call that already ended is a no-op worth naming: the row
-- is gone from the screen either way, and the caller is owed the truth about
-- who was still deciding.
create or replace function decline_summon(p_summon_id uuid)
returns summon_declines
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_summon summons;
  v_row summon_declines;
begin
  select * into v_summon from summons where id = p_summon_id for update;
  if v_summon.id is null then
    raise exception 'summon not found';
  end if;
  if v_summon.status not in ('open', 'covered') then
    raise exception 'this summon has ended';
  end if;
  if v_summon.created_at < now() - interval '1 day' then
    raise exception 'this summon has ended';
  end if;

  insert into summon_declines (summon_id, profile_id)
  values (p_summon_id, v_uid)
  on conflict (summon_id, profile_id) do nothing;

  select * into v_row from summon_declines
  where summon_id = p_summon_id and profile_id = v_uid;

  return v_row;
end;
$$;
