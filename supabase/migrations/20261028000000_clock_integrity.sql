-- Release 0, "trust the clock" — K0.2, K0.4, K0.5 (crew-redesign spec,
-- owner-approved 2026-09-23; grill-log round 2, Q10 and Q11).
--
-- WHAT WAS WRONG, for a real installer on one bar of signal:
--
--   * A clock-out whose reply got lost was sent again by the phone. clock_out
--     had no guard at all: the second arrival moved clock_out_at to the new
--     now(), and — worse — set status back to 'submitted' on a shift the
--     office may already have APPROVED. A resend could re-open somebody's
--     approved week. (20260921000000_injury_note.sql:27-43 had no status or
--     idempotency check; only the queued clock_in carried a client id.)
--   * end_break with no running break "succeeded": it updated nothing, then
--     read the row back and returned it as if the lunch had ended. A lunch
--     return that could not find its lunch start was silently paid as work.
--   * Every timestamp was the server's now() on ARRIVAL (20260948000000).
--     Right for a phone with a wrong clock, wrong for the common case: a punch
--     tapped at 7:02 in a dead zone and sent at 9:30 when the truck reached
--     signal was paid from 9:30.
--
-- WHAT THIS DOES, additively (no applied migration is edited; the legacy
-- overloads are re-created verbatim with ONLY the guards added, the way every
-- clock_in rebuild since 20260730230000 has been done):
--
--   1. time_clock_actions — one ledger row per clock action, keyed by the
--      phone's one-time client id. A repeat of the same id is answered with
--      the original result and changes nothing. Breaks cannot be keyed on
--      time_shifts columns: a shift holds several breaks, and a stale replay
--      of break #1's end must never close break #2. Server-only: RLS on, no
--      grants, written by the SECURITY DEFINER RPCs below and nothing else.
--   2. New clock_in / clock_out / start_break / end_break overloads that take
--      p_client_id plus the tap trio (p_tapped_at, p_clock_checked_at,
--      p_clock_skew_ms). The legacy signatures stay callable so a stale bundle
--      keeps punching, but they now refuse a second close.
--   3. clock_out refuses anything but an open shift, so clock_out_at never
--      moves and an approved shift can never be re-submitted by a resend.
--   4. end_break with no running break returns outcome 'no_break_running'
--      instead of raising. Deliberate: a RAISE rolls the flag back with it,
--      and the whole point is that the flag survives. The row is marked
--      review_reason = 'break_end_without_break', an audit line is written,
--      and the app turns the outcome into a plain-English error.
--   5. time_shifts.review_reason — "time needs review", a short code the app
--      translates. Set when the tap time could not be trusted and when a break
--      end had no matching start. The chosen pay time stays in the existing
--      clock_in_at / clock_out_at / break_seconds columns, so no hours
--      calculation downstream changes shape; the tap and arrival times live
--      in the ledger.
--
-- THE TAP-TIME RULE (K0.5, owner decision). Pay uses the phone's tap time when
-- ALL of these hold; otherwise pay uses arrival (today's behaviour) and the
-- punch is marked for review:
--   * the phone compared its clock with server_now() within the last 24 h
--     (p_clock_checked_at is the SERVER time of that check, so the age is
--     measured on one clock);
--   * that check found the phone within 2 minutes of the server;
--   * the tap, corrected by the measured skew, precedes arrival — the skew is
--     known, so a phone 40 s fast is not failed for being 40 s fast on every
--     online punch; the correction is what makes "precedes" fair;
--   * the tap is no older than shift_cap_hours() (16 h) — no single shift runs
--     longer, so a tap older than that cannot belong to the shift it claims;
--   * the tap is not before the shift's last recorded event (its clock-in, or
--     the break it is ending).
-- A punch that sends NO tap at all is an old bundle, not a suspicious phone:
-- arrival time, no review mark — exactly what every punch recorded before
-- this migration.

-- ---------------------------------------------------------------------------
-- 1. time_shifts.review_reason
-- ---------------------------------------------------------------------------
alter table public.time_shifts add column if not exists review_reason text;

alter table public.time_shifts drop constraint if exists time_shifts_review_reason_check;
alter table public.time_shifts add constraint time_shifts_review_reason_check
  check (review_reason is null or review_reason in (
    'clock_unchecked',          -- phone never compared its clock, or not in 24 h
    'clock_off',                -- phone was more than 2 minutes off at the check
    'tap_after_arrival',        -- corrected tap is later than the server received it
    'tap_too_old',              -- tap older than the shift cap
    'tap_out_of_order',         -- tap before the shift's last recorded event
    'previous_shift_open',      -- a dangling shift had to be closed at arrival first
    'break_end_without_break'   -- a break end arrived with no running break
  ));

comment on column public.time_shifts.review_reason is
  'K0.4/K0.5 (20261028000000): why this punch needs a foreman''s look — a code the app translates, null when nothing does. Set by the clock RPCs when a tap time could not be trusted (pay used arrival time) or a break end had no running break. Never cleared by the clock; the row keeps its history.';

-- ---------------------------------------------------------------------------
-- 2. The ledger
-- ---------------------------------------------------------------------------
create table if not exists public.time_clock_actions (
  client_id        uuid primary key,
  -- Never null: a ledger row is a fact about one shift and dies with it.
  shift_id         uuid not null references public.time_shifts(id) on delete cascade,
  profile_id       uuid not null references public.profiles(id) on delete cascade,
  action           text not null check (action in ('clock_in', 'clock_out', 'break_start', 'break_end')),
  outcome          text not null,
  -- What the phone said, and when the server heard it.
  tapped_at        timestamptz,
  arrived_at       timestamptz not null default now(),
  clock_checked_at timestamptz,
  clock_skew_ms    integer,
  -- What pay was told.
  used_tap_time    boolean not null default false,
  review_reason    text,
  created_at       timestamptz not null default now()
);

create index if not exists time_clock_actions_shift_idx
  on public.time_clock_actions (shift_id, created_at);

alter table public.time_clock_actions enable row level security;
revoke all on table public.time_clock_actions from public, anon, authenticated;

comment on table public.time_clock_actions is
  'One row per clock action (clock in / out, break start / end), keyed by the phone''s one-time client id (K0.2, 20261028000000). A repeated id is answered with the original result and changes nothing. Carries the tap time and the arrival time of every action (K0.5) and which one pay used. Server-only: written by the clock RPCs, readable through no client role — the graveyard pattern, so no policy can widen it by accident.';

-- ---------------------------------------------------------------------------
-- 3. Choosing the pay time
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'clock_time_pick' and typnamespace = 'public'::regnamespace) then
    create type public.clock_time_pick as (pay_at timestamptz, used_tap boolean, reason text);
  end if;
end;
$$;

-- p_not_before: the shift's last recorded event — the clock-in for a clock-out
-- or a break start, the break start for a break end. Null for a clock-in.
create or replace function public._clock_pick_time(
  p_tapped_at timestamptz,
  p_clock_checked_at timestamptz,
  p_clock_skew_ms integer,
  p_not_before timestamptz
)
returns public.clock_time_pick
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := now();
  v_corrected timestamptz;
begin
  -- No tap sent: an old bundle. Today's behaviour, and no mark.
  if p_tapped_at is null then
    return (v_now, false, null)::public.clock_time_pick;
  end if;
  if p_clock_checked_at is null or v_now - p_clock_checked_at > interval '24 hours'
     or p_clock_checked_at > v_now + interval '2 minutes' then
    return (v_now, false, 'clock_unchecked')::public.clock_time_pick;
  end if;
  if p_clock_skew_ms is null or abs(p_clock_skew_ms) > 120000 then
    return (v_now, false, 'clock_off')::public.clock_time_pick;
  end if;
  -- The tap in the server's own clock: a phone 40 s fast said 7:02:40 when
  -- the server would have said 7:02:00.
  v_corrected := p_tapped_at - make_interval(secs => p_clock_skew_ms / 1000.0);
  if v_corrected > v_now then
    return (v_now, false, 'tap_after_arrival')::public.clock_time_pick;
  end if;
  if v_now - v_corrected > make_interval(hours => public.shift_cap_hours()) then
    return (v_now, false, 'tap_too_old')::public.clock_time_pick;
  end if;
  if p_not_before is not null and v_corrected < p_not_before then
    return (v_now, false, 'tap_out_of_order')::public.clock_time_pick;
  end if;
  return (v_corrected, true, null)::public.clock_time_pick;
end;
$$;

revoke all on function public._clock_pick_time(timestamptz, timestamptz, integer, timestamptz) from public, anon, authenticated;

comment on function public._clock_pick_time(timestamptz, timestamptz, integer, timestamptz) is
  'K0.5: the tap time, skew-corrected, when the phone''s clock was checked within 24 h and found within 2 minutes and the tap precedes arrival, is within the shift cap and not before the shift''s last event; otherwise arrival time and the reason pay could not use the tap. No tap at all = arrival time, no reason.';

-- Mark a shift for review and say so in the audit trail the supervisors and
-- the worker already read. The first reason on a row wins: one code column,
-- and the earlier problem is the one worth reading first.
create or replace function public._flag_shift_for_review(
  p_shift_id uuid,
  p_reason text,
  p_sentence text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.time_shifts
     set review_reason = coalesce(review_reason, p_reason)
   where id = p_shift_id;
  insert into public.time_shift_edits (shift_id, edited_by, field, old_value, new_value, reason)
  values (p_shift_id, auth.uid(), 'review_reason', null, p_reason, p_sentence);
end;
$$;

revoke all on function public._flag_shift_for_review(uuid, text, text) from public, anon, authenticated;

-- The sentence the audit line carries for each code. English on purpose: the
-- audit trail is English throughout (edited_note, closed_reason); the app
-- translates the CODE on the timecard.
create or replace function public._clock_review_sentence(p_reason text, p_tapped_at timestamptz, p_arrived_at timestamptz)
returns text
language sql
stable
set search_path = public, pg_temp
as $$
  select case p_reason
    when 'clock_unchecked' then 'Pay used the time this punch reached Forge (' || to_char(p_arrived_at at time zone 'America/Denver', 'HH12:MI AM') || ') because the phone''s clock had not been checked in the last day. The phone said ' || to_char(p_tapped_at at time zone 'America/Denver', 'HH12:MI AM') || '.'
    when 'clock_off' then 'Pay used the time this punch reached Forge (' || to_char(p_arrived_at at time zone 'America/Denver', 'HH12:MI AM') || ') because the phone''s clock was more than 2 minutes off. The phone said ' || to_char(p_tapped_at at time zone 'America/Denver', 'HH12:MI AM') || '.'
    when 'tap_after_arrival' then 'Pay used the time this punch reached Forge (' || to_char(p_arrived_at at time zone 'America/Denver', 'HH12:MI AM') || ') because the phone''s tap time was later than that. The phone said ' || to_char(p_tapped_at at time zone 'America/Denver', 'HH12:MI AM') || '.'
    when 'tap_too_old' then 'Pay used the time this punch reached Forge (' || to_char(p_arrived_at at time zone 'America/Denver', 'HH12:MI AM') || ') because the phone''s tap time was more than ' || public.shift_cap_hours() || ' hours earlier. The phone said ' || to_char(p_tapped_at at time zone 'America/Denver', 'YYYY-MM-DD HH12:MI AM') || '.'
    when 'tap_out_of_order' then 'Pay used the time this punch reached Forge (' || to_char(p_arrived_at at time zone 'America/Denver', 'HH12:MI AM') || ') because the phone''s tap time was before the shift''s last punch. The phone said ' || to_char(p_tapped_at at time zone 'America/Denver', 'HH12:MI AM') || '.'
    when 'previous_shift_open' then 'The previous shift was still open, so this clock-in starts when it reached Forge (' || to_char(p_arrived_at at time zone 'America/Denver', 'HH12:MI AM') || ') rather than at the phone''s tap time.'
    when 'break_end_without_break' then 'A break end arrived at ' || to_char(p_arrived_at at time zone 'America/Denver', 'HH12:MI AM') || ' with no break running, so nothing was ended. Check this shift''s breaks.'
    else 'This punch needs a look.'
  end
$$;

revoke all on function public._clock_review_sentence(text, timestamptz, timestamptz) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. clock_in with a client id, a mode and the tap trio
-- ---------------------------------------------------------------------------
-- The one overload that carries BOTH p_mode and p_client_id — the "stated
-- limit" in ClockSheet since 2026-09-06 (a queued punch lost its mode because
-- no overload took both) closes here. The toolbox gate and the dangling-shift
-- close are verbatim from 20260970000000 / 20260813000000. Every earlier
-- overload is left in place.
create or replace function public.clock_in(
  p_project_id uuid,
  p_cost_code_id uuid,
  p_photo text,
  p_lat double precision,
  p_lng double precision,
  p_note text,
  p_mode text,
  p_client_id uuid,
  p_tapped_at timestamptz default null,
  p_clock_checked_at timestamptz default null,
  p_clock_skew_ms integer default null
)
returns public.time_shifts
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_shift public.time_shifts;
  v_pick public.clock_time_pick;
  v_had_open boolean;
begin
  if v_uid is null then
    raise exception 'Sign in before clocking in.';
  end if;
  if public.is_partner_user() then
    raise exception 'Not available for your account.' using errcode = '42501';
  end if;
  if p_client_id is null then
    raise exception 'This clock-in is missing its id. Update the app and try again.';
  end if;

  -- The same tap arriving twice: answer with the shift it already made.
  select ts.* into v_shift
    from public.time_clock_actions a
    join public.time_shifts ts on ts.id = a.shift_id
   where a.client_id = p_client_id and a.profile_id = v_uid;
  if v_shift.id is not null then
    return v_shift;
  end if;
  -- A queued punch that went through the older client_id overload before the
  -- app updated, then retried through this one.
  select * into v_shift from public.time_shifts
   where client_id = p_client_id and profile_id = v_uid;
  if v_shift.id is not null then
    return v_shift;
  end if;

  if not exists (
    select 1 from public.toolbox_completions
    where profile_id = v_uid and (signed_at at time zone 'America/Denver')::date = (now() at time zone 'America/Denver')::date
  ) then
    raise exception 'complete today''s toolbox talk before clocking in';
  end if;

  -- A shift still open when this one arrives is closed at ARRIVAL by the
  -- dangling-shift guard. Starting the new one at an earlier tap time would
  -- overlap the two and pay the gap twice, so the new one starts at arrival
  -- too, and says why.
  select exists (
    select 1 from public.time_shifts
     where profile_id = v_uid and status = 'open' and clock_out_at is null
  ) into v_had_open;
  perform public._close_dangling_shift(v_uid);

  if v_had_open then
    v_pick := (now(), false, 'previous_shift_open')::public.clock_time_pick;
  else
    v_pick := public._clock_pick_time(p_tapped_at, p_clock_checked_at, p_clock_skew_ms, null);
  end if;

  insert into public.time_shifts
    (profile_id, project_id, cost_code_id, clock_in_photo, clock_in_lat, clock_in_lng,
     note, job_mode, client_id, clock_in_at, review_reason)
  values
    (v_uid, p_project_id, p_cost_code_id, p_photo, p_lat, p_lng,
     nullif(btrim(p_note), ''),
     case when p_mode in ('data', 'tracking') then p_mode else null end,
     p_client_id, v_pick.pay_at, v_pick.reason)
  returning * into v_shift;

  insert into public.time_clock_actions
    (client_id, shift_id, profile_id, action, outcome, tapped_at, arrived_at,
     clock_checked_at, clock_skew_ms, used_tap_time, review_reason)
  values
    (p_client_id, v_shift.id, v_uid, 'clock_in', 'clocked_in', p_tapped_at, now(),
     p_clock_checked_at, p_clock_skew_ms, v_pick.used_tap, v_pick.reason);

  if v_pick.reason is not null then
    perform public._flag_shift_for_review(v_shift.id, v_pick.reason,
      public._clock_review_sentence(v_pick.reason, p_tapped_at, now()));
  end if;

  return v_shift;
end;
$$;

revoke all on function public.clock_in(uuid, uuid, text, double precision, double precision, text, text, uuid, timestamptz, timestamptz, integer) from public, anon;
grant execute on function public.clock_in(uuid, uuid, text, double precision, double precision, text, text, uuid, timestamptz, timestamptz, integer) to authenticated;

comment on function public.clock_in(uuid, uuid, text, double precision, double precision, text, text, uuid, timestamptz, timestamptz, integer) is
  'Clock in with a one-time client id (a repeat returns the same shift), the job mode, and the phone''s tap time (pay uses it when trusted — see _clock_pick_time; otherwise arrival time and review_reason). 20261028000000.';

-- ---------------------------------------------------------------------------
-- 5. clock_out — the guarded legacy signature, and the keyed one
-- ---------------------------------------------------------------------------
-- 5a) Legacy signature (20260921000000), body verbatim plus the guard: only an
-- OPEN shift closes. A second arrival finds nothing to update and says so,
-- instead of moving clock_out_at and re-submitting an approved week.
create or replace function public.clock_out(
  p_shift_id uuid,
  p_photo text default null,
  p_injured boolean default false,
  p_time_confirmed boolean default true,
  p_break_seconds int default null,
  p_lat double precision default null,
  p_lng double precision default null,
  p_injury_note text default null
)
returns public.time_shifts language plpgsql set search_path = public, pg_temp as $$
declare v_shift public.time_shifts;
begin
  update public.time_shifts
  set clock_out_at = now(),
      clock_out_photo = coalesce(p_photo, clock_out_photo),
      injured = p_injured,
      injury_note = case when p_injured then nullif(trim(coalesce(p_injury_note, '')), '') else null end,
      time_confirmed = p_time_confirmed,
      break_seconds = coalesce(p_break_seconds, break_seconds),
      break_started_at = null,
      break_type = null,
      clock_out_lat = coalesce(p_lat, clock_out_lat),
      clock_out_lng = coalesce(p_lng, clock_out_lng),
      signed_at = now(),
      status = 'submitted'
  where id = p_shift_id and profile_id = auth.uid()
    and status = 'open' and clock_out_at is null
  returning * into v_shift;
  if v_shift is null then
    if exists (select 1 from public.time_shifts where id = p_shift_id and profile_id = auth.uid()) then
      raise exception 'This shift was already clocked out. Nothing was changed.';
    end if;
    raise exception 'no open shift %', p_shift_id;
  end if;
  return v_shift;
end;
$$;

-- 5b) Keyed: the same id twice is the same clock-out. A running break with no
-- client-side total is folded in rather than dropped (clock_out_for's rule).
create or replace function public.clock_out(
  p_shift_id uuid,
  p_photo text,
  p_injured boolean,
  p_time_confirmed boolean,
  p_break_seconds int,
  p_lat double precision,
  p_lng double precision,
  p_injury_note text,
  p_client_id uuid,
  p_tapped_at timestamptz default null,
  p_clock_checked_at timestamptz default null,
  p_clock_skew_ms integer default null
)
returns public.time_shifts
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_open public.time_shifts;
  v_shift public.time_shifts;
  v_pick public.clock_time_pick;
begin
  if v_uid is null then
    raise exception 'Sign in before clocking out.';
  end if;
  if public.is_partner_user() then
    raise exception 'Not available for your account.' using errcode = '42501';
  end if;
  if p_client_id is null then
    raise exception 'This clock-out is missing its id. Update the app and try again.';
  end if;

  -- Already applied: the original result, and not one column moved.
  if exists (select 1 from public.time_clock_actions where client_id = p_client_id and profile_id = v_uid) then
    select * into v_shift from public.time_shifts where id = p_shift_id and profile_id = v_uid;
    if v_shift.id is null then raise exception 'no open shift %', p_shift_id; end if;
    return v_shift;
  end if;

  select * into v_open from public.time_shifts
   where id = p_shift_id and profile_id = v_uid
   for update;
  if v_open.id is null then
    raise exception 'no open shift %', p_shift_id;
  end if;
  if v_open.status <> 'open' or v_open.clock_out_at is not null then
    raise exception 'This shift was already clocked out. Nothing was changed.';
  end if;

  v_pick := public._clock_pick_time(p_tapped_at, p_clock_checked_at, p_clock_skew_ms,
                                    greatest(v_open.clock_in_at, coalesce(v_open.break_started_at, v_open.clock_in_at)));

  update public.time_shifts ts
  set clock_out_at = v_pick.pay_at,
      clock_out_photo = coalesce(p_photo, ts.clock_out_photo),
      injured = p_injured,
      injury_note = case when p_injured then nullif(trim(coalesce(p_injury_note, '')), '') else null end,
      time_confirmed = p_time_confirmed,
      break_seconds = coalesce(p_break_seconds,
        ts.break_seconds + case
          when ts.break_started_at is not null
            then greatest(0, floor(extract(epoch from (v_pick.pay_at - ts.break_started_at)))::int)
          else 0
        end),
      break_started_at = null,
      break_type = null,
      clock_out_lat = coalesce(p_lat, ts.clock_out_lat),
      clock_out_lng = coalesce(p_lng, ts.clock_out_lng),
      signed_at = now(),
      status = 'submitted',
      review_reason = coalesce(ts.review_reason, v_pick.reason)
  where ts.id = v_open.id
  returning * into v_shift;

  insert into public.time_clock_actions
    (client_id, shift_id, profile_id, action, outcome, tapped_at, arrived_at,
     clock_checked_at, clock_skew_ms, used_tap_time, review_reason)
  values
    (p_client_id, v_shift.id, v_uid, 'clock_out', 'clocked_out', p_tapped_at, now(),
     p_clock_checked_at, p_clock_skew_ms, v_pick.used_tap, v_pick.reason);

  if v_pick.reason is not null then
    perform public._flag_shift_for_review(v_shift.id, v_pick.reason,
      public._clock_review_sentence(v_pick.reason, p_tapped_at, now()));
  end if;

  return v_shift;
end;
$$;

revoke all on function public.clock_out(uuid, text, boolean, boolean, int, double precision, double precision, text, uuid, timestamptz, timestamptz, integer) from public, anon;
grant execute on function public.clock_out(uuid, text, boolean, boolean, int, double precision, double precision, text, uuid, timestamptz, timestamptz, integer) to authenticated;

comment on function public.clock_out(uuid, text, boolean, boolean, int, double precision, double precision, text, uuid, timestamptz, timestamptz, integer) is
  'Clock out with a one-time client id: a repeat returns the shift unchanged, a closed shift is refused, clock_out_at never moves. Pay uses the phone''s tap time when trusted (_clock_pick_time), else arrival time plus review_reason. 20261028000000.';

-- ---------------------------------------------------------------------------
-- 6. start_break — guarded legacy signature, and the keyed one
-- ---------------------------------------------------------------------------
-- 6a) Legacy (20260811010000), verbatim plus: only an open shift takes a
-- break. The phase pause it carries is unchanged.
create or replace function public.start_break(
  p_shift_id uuid,
  p_break_type text default 'other'
)
returns public.time_shifts language plpgsql set search_path = public, pg_temp as $$
declare v public.time_shifts;
begin
  update public.time_shifts
  set break_started_at = coalesce(break_started_at, now()),
      break_type = coalesce(break_type, p_break_type)
  where id = p_shift_id and profile_id = auth.uid()
    and status = 'open' and clock_out_at is null
  returning * into v;
  if v is null then
    if exists (select 1 from public.time_shifts where id = p_shift_id and profile_id = auth.uid()) then
      raise exception 'This shift is already clocked out, so a break can''t start on it.';
    end if;
    raise exception 'no open shift %', p_shift_id;
  end if;

  update public.opening_phases
     set paused_at = coalesce(paused_at, now())
   where status = 'active' and started_by = auth.uid();

  return v;
end;
$$;

-- 6b) Keyed.
create or replace function public.start_break(
  p_shift_id uuid,
  p_break_type text,
  p_client_id uuid,
  p_tapped_at timestamptz default null,
  p_clock_checked_at timestamptz default null,
  p_clock_skew_ms integer default null
)
returns public.time_shifts
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_open public.time_shifts;
  v_shift public.time_shifts;
  v_pick public.clock_time_pick;
  v_outcome text;
begin
  if v_uid is null then
    raise exception 'Sign in before starting a break.';
  end if;
  if public.is_partner_user() then
    raise exception 'Not available for your account.' using errcode = '42501';
  end if;
  if p_client_id is null then
    raise exception 'This break is missing its id. Update the app and try again.';
  end if;

  if exists (select 1 from public.time_clock_actions where client_id = p_client_id and profile_id = v_uid) then
    select * into v_shift from public.time_shifts where id = p_shift_id and profile_id = v_uid;
    if v_shift.id is null then raise exception 'no open shift %', p_shift_id; end if;
    return v_shift;
  end if;

  select * into v_open from public.time_shifts
   where id = p_shift_id and profile_id = v_uid
   for update;
  if v_open.id is null then
    raise exception 'no open shift %', p_shift_id;
  end if;
  if v_open.status <> 'open' or v_open.clock_out_at is not null then
    raise exception 'This shift is already clocked out, so a break can''t start on it.';
  end if;

  if v_open.break_started_at is not null then
    -- Already on a break: the earlier start stands, as it always has.
    v_shift := v_open;
    v_outcome := 'already_on_break';
    v_pick := (now(), false, null)::public.clock_time_pick;
  else
    v_pick := public._clock_pick_time(p_tapped_at, p_clock_checked_at, p_clock_skew_ms, v_open.clock_in_at);
    update public.time_shifts ts
       set break_started_at = v_pick.pay_at,
           break_type = coalesce(ts.break_type, case when p_break_type in ('lunch', 'rest', 'other') then p_break_type else 'other' end),
           review_reason = coalesce(ts.review_reason, v_pick.reason)
     where ts.id = v_open.id
    returning * into v_shift;
    v_outcome := 'started';

    -- Going on a break pauses every phase clock you have running (20260811010000).
    update public.opening_phases
       set paused_at = coalesce(paused_at, now())
     where status = 'active' and started_by = v_uid;
  end if;

  insert into public.time_clock_actions
    (client_id, shift_id, profile_id, action, outcome, tapped_at, arrived_at,
     clock_checked_at, clock_skew_ms, used_tap_time, review_reason)
  values
    (p_client_id, v_shift.id, v_uid, 'break_start', v_outcome, p_tapped_at, now(),
     p_clock_checked_at, p_clock_skew_ms, v_pick.used_tap, v_pick.reason);

  if v_pick.reason is not null then
    perform public._flag_shift_for_review(v_shift.id, v_pick.reason,
      public._clock_review_sentence(v_pick.reason, p_tapped_at, now()));
  end if;

  return v_shift;
end;
$$;

revoke all on function public.start_break(uuid, text, uuid, timestamptz, timestamptz, integer) from public, anon;
grant execute on function public.start_break(uuid, text, uuid, timestamptz, timestamptz, integer) to authenticated;

comment on function public.start_break(uuid, text, uuid, timestamptz, timestamptz, integer) is
  'Start a break with a one-time client id (a repeat returns the shift unchanged; a break already running keeps its start). Pay uses the phone''s tap time when trusted. 20261028000000.';

-- ---------------------------------------------------------------------------
-- 7. end_break — guarded legacy signature, and the keyed one
-- ---------------------------------------------------------------------------
-- 7a) Legacy (20260718040000), verbatim plus: no running break is an error,
-- never a silent success. (A raise cannot leave a flag behind, so the flag
-- lives on the keyed overload the app uses; this one still stops the silent
-- half for a stale bundle.)
create or replace function public.end_break(p_shift_id uuid)
returns public.time_shifts language plpgsql set search_path = public, pg_temp as $$
declare v public.time_shifts;
begin
  update public.time_shifts
  set break_seconds = break_seconds
        + greatest(0, extract(epoch from (now() - break_started_at))::int),
      break_started_at = null,
      break_type = null
  where id = p_shift_id and profile_id = auth.uid() and break_started_at is not null
  returning * into v;
  if v is null then
    if exists (select 1 from public.time_shifts where id = p_shift_id and profile_id = auth.uid()) then
      raise exception 'We couldn''t find the start of that break, so it wasn''t ended. Your foreman will check your breaks.';
    end if;
    raise exception 'no open shift %', p_shift_id;
  end if;
  return v;
end;
$$;

-- 7b) Keyed. Returns jsonb {outcome, shift} rather than the row, because the
-- one outcome that matters most — 'no_break_running' — has to COMMIT its flag,
-- and a raise would roll it back. Outcomes: ended | no_break_running |
-- shift_closed (the shift was clocked out meanwhile; its running break was
-- folded by that clock-out, so there is nothing to end and nothing to flag).
create or replace function public.end_break(
  p_shift_id uuid,
  p_client_id uuid,
  p_tapped_at timestamptz default null,
  p_clock_checked_at timestamptz default null,
  p_clock_skew_ms integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_open public.time_shifts;
  v_shift public.time_shifts;
  v_pick public.clock_time_pick;
  v_prior text;
begin
  if v_uid is null then
    raise exception 'Sign in before ending a break.';
  end if;
  if public.is_partner_user() then
    raise exception 'Not available for your account.' using errcode = '42501';
  end if;
  if p_client_id is null then
    raise exception 'This break end is missing its id. Update the app and try again.';
  end if;

  select a.outcome into v_prior from public.time_clock_actions a
   where a.client_id = p_client_id and a.profile_id = v_uid;
  if v_prior is not null then
    select * into v_shift from public.time_shifts where id = p_shift_id and profile_id = v_uid;
    if v_shift.id is null then raise exception 'no open shift %', p_shift_id; end if;
    return jsonb_build_object('outcome', v_prior, 'shift', to_jsonb(v_shift));
  end if;

  select * into v_open from public.time_shifts
   where id = p_shift_id and profile_id = v_uid
   for update;
  if v_open.id is null then
    raise exception 'no open shift %', p_shift_id;
  end if;

  if v_open.status <> 'open' or v_open.clock_out_at is not null then
    insert into public.time_clock_actions
      (client_id, shift_id, profile_id, action, outcome, tapped_at, arrived_at, clock_checked_at, clock_skew_ms)
    values
      (p_client_id, v_open.id, v_uid, 'break_end', 'shift_closed', p_tapped_at, now(), p_clock_checked_at, p_clock_skew_ms);
    return jsonb_build_object('outcome', 'shift_closed', 'shift', to_jsonb(v_open));
  end if;

  if v_open.break_started_at is null then
    -- K0.4: nothing to end. Refuse, keep the refusal, mark the shift.
    insert into public.time_clock_actions
      (client_id, shift_id, profile_id, action, outcome, tapped_at, arrived_at, clock_checked_at, clock_skew_ms, review_reason)
    values
      (p_client_id, v_open.id, v_uid, 'break_end', 'no_break_running', p_tapped_at, now(), p_clock_checked_at, p_clock_skew_ms, 'break_end_without_break');
    perform public._flag_shift_for_review(v_open.id, 'break_end_without_break',
      public._clock_review_sentence('break_end_without_break', p_tapped_at, now()));
    select * into v_shift from public.time_shifts where id = v_open.id;
    return jsonb_build_object('outcome', 'no_break_running', 'shift', to_jsonb(v_shift));
  end if;

  v_pick := public._clock_pick_time(p_tapped_at, p_clock_checked_at, p_clock_skew_ms, v_open.break_started_at);

  update public.time_shifts ts
     set break_seconds = ts.break_seconds
           + greatest(0, extract(epoch from (v_pick.pay_at - ts.break_started_at))::int),
         break_started_at = null,
         break_type = null,
         review_reason = coalesce(ts.review_reason, v_pick.reason)
   where ts.id = v_open.id
  returning * into v_shift;

  insert into public.time_clock_actions
    (client_id, shift_id, profile_id, action, outcome, tapped_at, arrived_at,
     clock_checked_at, clock_skew_ms, used_tap_time, review_reason)
  values
    (p_client_id, v_shift.id, v_uid, 'break_end', 'ended', p_tapped_at, now(),
     p_clock_checked_at, p_clock_skew_ms, v_pick.used_tap, v_pick.reason);

  if v_pick.reason is not null then
    perform public._flag_shift_for_review(v_shift.id, v_pick.reason,
      public._clock_review_sentence(v_pick.reason, p_tapped_at, now()));
  end if;

  return jsonb_build_object('outcome', 'ended', 'shift', to_jsonb(v_shift));
end;
$$;

revoke all on function public.end_break(uuid, uuid, timestamptz, timestamptz, integer) from public, anon;
grant execute on function public.end_break(uuid, uuid, timestamptz, timestamptz, integer) to authenticated;

comment on function public.end_break(uuid, uuid, timestamptz, timestamptz, integer) is
  'End a break with a one-time client id. Returns {outcome, shift}: ended | no_break_running (the shift is marked review_reason=break_end_without_break and an audit line written — the flag survives because this does not raise) | shift_closed. A repeat returns the original outcome. 20261028000000.';

-- ---------------------------------------------------------------------------
-- 8. Registration: person removal counts
-- ---------------------------------------------------------------------------
-- The ledger cascades from profiles, so the Removed door (20260987000000) has
-- to count it or a login whose only trace is here would be deleted outright
-- and take its punch record along in silence. Body verbatim from 20261026000000
-- plus the one new key; app/src/lib/purgeWords.ts names it on the other side.
create or replace function public.person_record_counts(p_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'hex_learning_reviews.author_id', (select count(*) from hex_learning_reviews where author_id = p_id),
    'hex_learning_reviews.reviewer_id', (select count(*) from hex_learning_reviews where reviewer_id = p_id),
    'hex_learning_reviews.decided_by', (select count(*) from hex_learning_reviews where decided_by = p_id),
    'hex_learning_review_events.actor_id', (select count(*) from hex_learning_review_events where actor_id = p_id),
    'hex_learning_reviews.withdrawn_by', (select count(*) from hex_learning_reviews where withdrawn_by = p_id),
    'hex_learning_deliveries.last_caller', (select count(*) from hex_learning_deliveries where last_caller = p_id),
    'hex_learning_withdrawals.last_caller', (select count(*) from hex_learning_withdrawals where last_caller = p_id),
    'ai_field_requests.profile_id', (select count(*) from ai_field_requests where profile_id = p_id),
    'ai_field_actions.profile_id', (select count(*) from ai_field_actions where profile_id = p_id),
    'crew_work_records.filed_by', (select count(*) from crew_work_records where filed_by = p_id),
    'crew_work_record_people.profile_id', (select count(*) from crew_work_record_people where profile_id = p_id),
 'hex_portal_cases.asker_id',(select count(*) from public.hex_portal_cases where asker_id=p_id),
 'hex_portal_outcomes.actor_id',(select count(*) from public.hex_portal_outcomes where actor_id=p_id),
 'hex_portal_guidance_receipts.actor_id',(select count(*) from public.hex_portal_guidance_receipts where actor_id=p_id),'time_off_requests.profile_id',(select count(*) from time_off_requests where profile_id=p_id),'crew_reminders.profile_id',(select count(*) from crew_reminders where profile_id=p_id)) || jsonb_build_object('service_visits.created_by',(select count(*) from service_visits where created_by=p_id),'service_visit_units.created_by',(select count(*) from service_visit_units where created_by=p_id),'service_time_sessions.profile_id',(select count(*) from service_time_sessions where profile_id=p_id),'service_media.created_by',(select count(*) from service_media where created_by=p_id),'service_audit.actor_id',(select count(*) from service_audit where actor_id=p_id),'service_commands.profile_id',(select count(*) from service_commands where profile_id=p_id)) || jsonb_build_object(
    'custom_work_units.created_by', (select count(*) from custom_work_units where created_by = p_id),
    'custom_work_sessions.profile_id', (select count(*) from custom_work_sessions where profile_id = p_id),
    'custom_work_history.actor_id', (select count(*) from custom_work_history where actor_id = p_id),
    'custom_work_commands.profile_id', (select count(*) from custom_work_commands where profile_id = p_id),

    'workflow_plans.created_by', (select count(*) from workflow_plans where created_by = p_id),
    'workflow_plan_revisions.actor', (select count(*) from workflow_plan_revisions where actor = p_id),
    'workflow_notice_outbox.profile_id', (select count(*) from workflow_notice_outbox where profile_id = p_id),
    -- Time and money.
    'time_clock_actions.profile_id',
      (select count(*) from time_clock_actions where profile_id = p_id),
    'time_shifts.profile_id',
      (select count(*) from time_shifts where profile_id = p_id),
    'unit_sessions.profile_id',
      (select count(*) from unit_sessions where profile_id = p_id),
    'install_events.installer_id',
      (select count(*) from install_events where installer_id = p_id),
    'install_events.credited_to',
      (select count(*) from install_events where credited_to = p_id),
    'receipts.uploaded_by',
      (select count(*) from receipts where uploaded_by = p_id),
    'pay_rates.profile_id',
      (select count(*) from pay_rates where profile_id = p_id),
    'overtime_rules.profile_id',
      (select count(*) from overtime_rules where profile_id = p_id),
    'timecard_periods.profile_id',
      (select count(*) from timecard_periods where profile_id = p_id),
    'time_shift_edits.edited_by',
      (select count(*) from time_shift_edits where edited_by = p_id),
    -- Safety and training.
    'certifications.profile_id',
      (select count(*) from certifications where profile_id = p_id),
    'toolbox_completions.profile_id',
      (select count(*) from toolbox_completions where profile_id = p_id),
    'safety_acks.profile_id',
      (select count(*) from safety_acks where profile_id = p_id),
    'capability_badges.installer_id',
      (select count(*) from capability_badges where installer_id = p_id),
    'installer_clearance.installer_id',
      (select count(*) from installer_clearance where installer_id = p_id),
    'learn_progress.profile_id',
      (select count(*) from learn_progress where profile_id = p_id),
    'learning_video_quiz_attempts.profile_id',
      (select count(*) from learning_video_quiz_attempts where profile_id = p_id),
    'education_credits.profile_id',
      (select count(*) from education_credits where profile_id = p_id),
    -- The job site.
    'daily_logs.filed_by',
      (select count(*) from daily_logs where filed_by = p_id),
    'opening_phases.started_by',
      (select count(*) from opening_phases where started_by = p_id),
    'opening_phases.submitted_by',
      (select count(*) from opening_phases where submitted_by = p_id),
    'flash_run_assignments.assigned_by',
      (select count(*) from flash_run_assignments where assigned_by = p_id),
    'flash_run_assignments.profile_id',
      (select count(*) from flash_run_assignments where profile_id = p_id),
    'summons.requested_by',
      (select count(*) from summons where requested_by = p_id),
    'summon_helpers.profile_id',
      (select count(*) from summon_helpers where profile_id = p_id),
    'summon_declines.profile_id',
      (select count(*) from summon_declines where profile_id = p_id),
    'unit_redos.pressed_by',
      (select count(*) from unit_redos where pressed_by = p_id),
    'schedule_assignment_members.profile_id',
      (select count(*) from schedule_assignment_members where profile_id = p_id),
    'trip_crew.profile_id',
      (select count(*) from trip_crew where profile_id = p_id),
    'vehicle_drivers.profile_id',
      (select count(*) from vehicle_drivers where profile_id = p_id),
    -- What they said and what they were given credit for.
    'points_ledger.profile_id',
      (select count(*) from points_ledger where profile_id = p_id),
    'task_sessions.profile_id',
      (select count(*) from task_sessions where profile_id = p_id),
    'project_messages.author_id',
      (select count(*) from project_messages where author_id = p_id),
    'ask_question_log.asker_id',
      (select count(*) from ask_question_log where asker_id = p_id)
  );
$$;
revoke all on function public.person_record_counts(uuid) from public,anon,authenticated;
grant execute on function public.person_record_counts(uuid) to service_role;
