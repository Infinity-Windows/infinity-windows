-- Release 1 — the new front door (crew redesign spec, owner-approved
-- 2026-09-23: K-X2 rollout, K1.3 Start day / paid-time rule, K1.5 Prep time).
--
-- Five things, additive only, idempotent throughout:
--
--   1. profiles.ui_design + set_my_ui_design — the person's own choice of
--      front door ("classic" or "new"), the same shape as profiles.language.
--   2. company_settings.new_design_r1_enabled + set_new_design_switch — the
--      owner's master switch per release, and
--      company_settings.paid_time_from_start_day_on + set_paid_time_rule_date —
--      the one date (Q69) from which paid time starts at the Start day tap.
--   3. Four helpers, each the ONE copy of a rule:
--        _toolbox_signed_today — "is today's talk on this person's record";
--        _toolbox_gate_open    — "may this person clock in without today's
--                                signature", replacing six inline copies in
--                                the clock_in overloads. The bodies below are
--                                the latest ones (20260813000000 for the four
--                                older overloads, 20260970000000 for the
--                                p_mode one, 20261028000000 for Release 0's
--                                keyed one), extracted verbatim with ONLY
--                                the gate's condition moved into the helper;
--        _unit_work_gate       — "refuse unit work until today's talk is
--                                signed", the plain sentence and all;
--        _prep_time_gate       — the same refusal for Prep time, in its own
--                                sentence (the owner's answer, 2026-09-24:
--                                Prep time waits for the signature exactly
--                                like unit work).
--   4. The unit-work gate put back on EVERY server path that starts a unit,
--      phase or session timer (WHY it was missing is below):
--      start_opening_work, start_opening_phase, start_unit_session
--      (20260969000000), resume_opening_phase (20260811010000),
--      custom_work_command's 'start' with a unit_id (20261011000000 — Current
--      Work, the new Work screen's saved units and the Forge AI field tool
--      start_unit_work all end there), and answer_summon (20260963000000,
--      whose trigger opens a helper unit session). Each body is restated
--      VERBATIM from that migration with ONE added line,
--      `perform public._unit_work_gate(…)`, right after its open-shift
--      check (resume_opening_phase never had one; the line goes first).
--      Signed, every one of them behaves exactly as before. PREP TIME
--      (custom_work_command 'start' with no unit_id — the Work screen's
--      Prep time button, Current Work, and the Forge AI field tool
--      start_idle_time, which all end in that one branch) carries
--      `perform public._prep_time_gate(…)` in the same place. Breaks,
--      clock-out and the break-end resume (unit_sessions_follow_shift) are
--      NOT gated: they end or continue time, they never start work.
--      Servicing's own idle and travel timers (service_visit_command,
--      20261017000000) are left alone on purpose — that RPC starts a service
--      VISIT's timer, unit kind included, and none of its kinds pass the
--      unit-work gate either; if the owner extends the rule to service
--      visits, its 'start' branch is the one door to gate.
--   5. The crew announcements (docs/app-updates.md).
--
-- THE PAID-TIME RULE, plainly: today the first clock-in of the day is refused
-- until the toolbox talk is signed, so the talk is read off the clock. The
-- owner's rule ("paid time starts the moment someone starts the toolbox
-- talk") means clocking in FIRST and signing on the clock. It switches on for
-- everyone at once, on a date the owner picks at the start of a pay period,
-- and NOT before — default off, so nothing changes on deploy. It changes only
-- when a shift may begin, and no shift on record is touched.
--
-- WHY THE UNIT-WORK GATE HAD TO COME BACK: 20260969000000 dropped the
-- signature check from start_opening_work, start_opening_phase and
-- start_unit_session on the strength of "an open shift proves the talk is
-- signed" — true while clock_in refused the unsigned, and false from the day
-- the rule turns on: Start day then opens a shift BEFORE the talk is signed,
-- and those three would have let unsigned unit work straight through. The
-- rule the owner approved (spec Q3 / K1.3: "people sign for themselves; unit
-- work stays locked until signed") is only true on the server if the
-- signature is checked in its own right — so item 4 checks it, through one
-- helper, on every path that starts a timer on a unit. The practice-run
-- probe (scripts/dry-run-probes/pr-642-front-door.sql) is what caught it;
-- scripts/verify-new-front-door.mjs now loads the REAL current bodies and
-- proves every path both ways.
--
-- Coordination notes:
--   * Release 0 (clock integrity, 20261028000000) merges first. Its keyed
--     clock_in — the one the app calls — is restated below as 3f with the
--     shared gate, so the rule opens the door the phone actually uses (Codex
--     review of #642, 2026-09-25). Any LATER overload of clock_in keeps its
--     gate as `if not public._toolbox_gate_open(<caller>) then raise …`, so
--     the rule cannot be forgotten by one path.
--   * A NEW RPC that starts a timer on a unit — a session, a phase, a helper —
--     calls `perform public._unit_work_gate(auth.uid())` right after its
--     open-shift check, for the same reason; one that starts Prep time calls
--     `perform public._prep_time_gate(auth.uid())` there.
--
-- Timezone: 'America/Denver' spelled out, the company-local day every clock
-- gate has used since 20260813000000.

-- ---------------------------------------------------------------------------
-- 1. profiles.ui_design — the person's own front door
-- ---------------------------------------------------------------------------
alter table public.profiles
  add column if not exists ui_design text not null default 'classic';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'profiles_ui_design_check'
      and conrelid = 'public.profiles'::regclass
  ) then
    alter table public.profiles
      add constraint profiles_ui_design_check
      check (ui_design in ('classic', 'new'));
  end if;
end;
$$;

comment on column public.profiles.ui_design is
  'Which front door this person chose: ''classic'' or ''new'' (Release 1, crew redesign K-X2). Written only through set_my_ui_design(); the authenticated role holds SELECT but not UPDATE on it, matching language, role and pin_hash. The owner''s master switch (company_settings.new_design_r1_enabled) overrides it app-wide.';

-- Readable, never directly writable (20260729200000 made grants per column).
grant select (ui_design) on table public.profiles to authenticated;
revoke update (ui_design) on table public.profiles from anon, authenticated;

create or replace function public.set_my_ui_design(p_design text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v text := lower(coalesce(trim(p_design), ''));
begin
  if auth.uid() is null then
    raise exception 'sign in before choosing a design' using errcode = '42501';
  end if;

  if v not in ('classic', 'new') then
    raise exception 'design must be classic or new' using errcode = '22023';
  end if;

  update public.profiles
     set ui_design = v, updated_at = now()
   where id = auth.uid();
end;
$$;

comment on function public.set_my_ui_design(text) is
  'Set the calling user''s own front door (''classic'' or ''new''). SECURITY DEFINER and scoped to auth.uid(); the only client-reachable writer of profiles.ui_design (Release 1, K-X2).';

revoke all on function public.set_my_ui_design(text) from public, anon;
grant execute on function public.set_my_ui_design(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. The owner's two release settings
-- ---------------------------------------------------------------------------
alter table public.company_settings
  add column if not exists new_design_r1_enabled boolean not null default true;
alter table public.company_settings
  add column if not exists paid_time_from_start_day_on date;

comment on column public.company_settings.new_design_r1_enabled is
  'Release 1 master switch (crew redesign K-X2). False sends everyone back to the classic screens at once, whatever they chose; their choices are kept. Owner-only through set_new_design_switch().';
comment on column public.company_settings.paid_time_from_start_day_on is
  'The company-local day from which the first clock-in of the day no longer waits for the toolbox signature — paid time starts at the Start day tap and the talk is signed on the clock (K1.3, Q69: one date for everyone, picked at the start of a pay period). Null = off, today''s timing applies. Read by _toolbox_gate_open(); never applied to a shift already recorded.';

-- The switch is keyed by release so the next release adds one branch here
-- rather than a second function. Only 'r1' exists today.
create or replace function public.set_new_design_switch(p_release text, p_enabled boolean)
returns company_settings
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row company_settings;
begin
  if public.my_role_rank() < 3 then
    raise exception 'Only an owner can turn a new design on or off for everyone.'
      using errcode = '42501';
  end if;
  if p_enabled is null then
    raise exception 'Say whether the new design is on or off.' using errcode = '22023';
  end if;

  if p_release = 'r1' then
    update company_settings
       set new_design_r1_enabled = p_enabled,
           updated_at = now(),
           updated_by = auth.uid()
     where id = 1
    returning * into v_row;
  else
    raise exception 'Unknown release "%". The only new design so far is r1.', p_release
      using errcode = '22023';
  end if;

  return v_row;
end;
$$;

comment on function public.set_new_design_switch(text, boolean) is
  'Owner only: turn a release''s new design on or off for everyone at once (K-X2). p_release names the release (''r1''); anything else is refused in one plain sentence.';

revoke all on function public.set_new_design_switch(text, boolean) from public, anon;
grant execute on function public.set_new_design_switch(text, boolean) to authenticated;

create or replace function public.set_paid_time_rule_date(p_on date)
returns company_settings
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row company_settings;
begin
  if public.my_role_rank() < 3 then
    raise exception 'Only an owner can set when paid time starts at Start day.'
      using errcode = '42501';
  end if;
  -- A past date would switch the rule on retroactively for today's shifts
  -- already punched under the old timing — nothing is recalculated, but the
  -- day would then run under two rules. Today or later only; null turns it off.
  if p_on is not null and p_on < (now() at time zone 'America/Denver')::date then
    raise exception 'Pick today or a later day — the rule cannot start in the past.'
      using errcode = '22023';
  end if;

  update company_settings
     set paid_time_from_start_day_on = p_on,
         updated_at = now(),
         updated_by = auth.uid()
   where id = 1
  returning * into v_row;

  return v_row;
end;
$$;

comment on function public.set_paid_time_rule_date(date) is
  'Owner only: the day the paid-time rule starts for everyone (K1.3, Q69), or null to switch it off. Today or later; never rewrites a recorded shift.';

revoke all on function public.set_paid_time_rule_date(date) from public, anon;
grant execute on function public.set_paid_time_rule_date(date) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Four helpers: signed today, may the shift begin, may unit work begin,
--    may Prep time begin
-- ---------------------------------------------------------------------------
-- Invoker rights on purpose: the caller reads their OWN toolbox_completions
-- rows and the crew-readable company_settings row, both of which every clock
-- gate already read inline. Nothing is widened by moving the condition here.
-- (Inside a SECURITY DEFINER caller they run as the definer, exactly as the
-- inline copies did.)
create or replace function public._toolbox_signed_today(p_uid uuid)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from toolbox_completions
    where profile_id = p_uid
      and (signed_at at time zone 'America/Denver')::date
        = (now() at time zone 'America/Denver')::date
  );
$$;

comment on function public._toolbox_signed_today(uuid) is
  'Is today''s toolbox talk (company-local day, America/Denver) on this person''s record? The ONE copy of that condition: _toolbox_gate_open, _unit_work_gate and _prep_time_gate all read it.';

revoke all on function public._toolbox_signed_today(uuid) from public, anon;
grant execute on function public._toolbox_signed_today(uuid) to authenticated;

create or replace function public._toolbox_gate_open(p_uid uuid)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select public._toolbox_signed_today(p_uid)
    or exists (
      select 1 from company_settings
      where id = 1
        and paid_time_from_start_day_on is not null
        and paid_time_from_start_day_on <= (now() at time zone 'America/Denver')::date
    );
$$;

comment on function public._toolbox_gate_open(uuid) is
  'May this person''s shift begin right now? Yes once today''s toolbox talk is on their record, or — from the owner''s date in company_settings.paid_time_from_start_day_on — before it, because paid time then starts at the Start day tap and the talk is signed on the clock (K1.3). Unit work has its own gate, _unit_work_gate, which never reads the date.';

revoke all on function public._toolbox_gate_open(uuid) from public, anon;
grant execute on function public._toolbox_gate_open(uuid) to authenticated;

-- The unit-work gate. Raises rather than returns so the sentence a person
-- reads lives in exactly one place; the SQLSTATE is the clock-in gate's
-- (P0001, the default), which the app and the AI already treat as "a plain
-- refusal, show the words". It does NOT read the paid-time date: under the
-- rule the shift may begin unsigned, unit work may not.
create or replace function public._unit_work_gate(p_uid uuid)
returns void
language plpgsql
stable
set search_path = public, pg_temp
as $$
begin
  if not public._toolbox_signed_today(p_uid) then
    raise exception 'Sign today''s toolbox talk before starting work on a unit.';
  end if;
end;
$$;

comment on function public._unit_work_gate(uuid) is
  'Refuse, in one plain sentence, until today''s toolbox talk is on this person''s record. Called by every RPC that starts a timer on a unit (a session, a phase, a helper) right after its open-shift check — K1.3: unit work stays locked until signed, whatever the paid-time rule says about the shift.';

revoke all on function public._unit_work_gate(uuid) from public, anon;
grant execute on function public._unit_work_gate(uuid) to authenticated;

-- The Prep-time gate (owner decision 2026-09-24: "Prep time also waits for
-- today's toolbox signature, exactly like unit work"). The same condition,
-- the same SQLSTATE, its own sentence — Prep time is not "work on a unit",
-- and the phone maps each sentence to its own words. It does NOT read the
-- paid-time date either: under the rule the shift may begin unsigned, paid
-- job work of any kind may not.
create or replace function public._prep_time_gate(p_uid uuid)
returns void
language plpgsql
stable
set search_path = public, pg_temp
as $$
begin
  if not public._toolbox_signed_today(p_uid) then
    raise exception 'Sign today''s toolbox talk before starting work.';
  end if;
end;
$$;

comment on function public._prep_time_gate(uuid) is
  'Refuse, in one plain sentence, until today''s toolbox talk is on this person''s record. Called by every RPC that starts a Prep-time (idle) timer — today only custom_work_command''s start with no unit — right after its open-shift check. The owner''s answer of 2026-09-24: Prep time waits for the signature exactly like unit work, whatever the paid-time rule says about the shift.';

revoke all on function public._prep_time_gate(uuid) from public, anon;
grant execute on function public._prep_time_gate(uuid) to authenticated;

-- 3a–3f. One gate, six doors: the clock_in overloads.
-- 3a. The five-argument overload (20260813000000).
create or replace function clock_in(
  p_project_id uuid,
  p_cost_code_id uuid,
  p_photo text default null,
  p_lat double precision default null,
  p_lng double precision default null
)
returns time_shifts language plpgsql set search_path = public, pg_temp as $$
declare v_shift time_shifts;
begin
  if not public._toolbox_gate_open(auth.uid()) then
    raise exception 'complete today''s toolbox talk before clocking in';
  end if;

  perform _close_dangling_shift(auth.uid());

  insert into time_shifts
    (profile_id, project_id, cost_code_id, clock_in_photo, clock_in_lat, clock_in_lng)
  values (auth.uid(), p_project_id, p_cost_code_id, p_photo, p_lat, p_lng)
  returning * into v_shift;
  return v_shift;
end;
$$;

-- 3b. The note overload (20260813000000).
create or replace function clock_in(
  p_project_id uuid,
  p_cost_code_id uuid,
  p_photo text,
  p_lat double precision,
  p_lng double precision,
  p_note text
)
returns time_shifts language plpgsql set search_path = public, pg_temp as $$
declare v_shift time_shifts;
begin
  if not public._toolbox_gate_open(auth.uid()) then
    raise exception 'complete today''s toolbox talk before clocking in';
  end if;

  perform _close_dangling_shift(auth.uid());

  insert into time_shifts
    (profile_id, project_id, cost_code_id, clock_in_photo, clock_in_lat, clock_in_lng, note)
  values
    (auth.uid(), p_project_id, p_cost_code_id, p_photo, p_lat, p_lng,
     nullif(btrim(p_note), ''))
  returning * into v_shift;
  return v_shift;
end;
$$;

-- 3c. The offline client-id overload (20260813000000).
create or replace function clock_in(
  p_project_id uuid,
  p_cost_code_id uuid,
  p_photo text,
  p_lat double precision,
  p_lng double precision,
  p_client_id uuid
)
returns time_shifts language plpgsql set search_path = public, pg_temp as $$
declare v_shift time_shifts;
begin
  if p_client_id is not null then
    select * into v_shift from time_shifts
      where client_id = p_client_id and profile_id = auth.uid();
    if v_shift.id is not null then
      return v_shift;
    end if;
  end if;

  if not public._toolbox_gate_open(auth.uid()) then
    raise exception 'complete today''s toolbox talk before clocking in';
  end if;

  perform _close_dangling_shift(auth.uid());

  insert into time_shifts
    (profile_id, project_id, cost_code_id, clock_in_photo, clock_in_lat, clock_in_lng,
     client_id)
  values
    (auth.uid(), p_project_id, p_cost_code_id, p_photo, p_lat, p_lng, p_client_id)
  returning * into v_shift;
  return v_shift;
end;
$$;

-- 3d. The offline client-id + note overload (20260813000000).
create or replace function clock_in(
  p_project_id uuid,
  p_cost_code_id uuid,
  p_photo text,
  p_lat double precision,
  p_lng double precision,
  p_client_id uuid,
  p_note text
)
returns time_shifts language plpgsql set search_path = public, pg_temp as $$
declare v_shift time_shifts;
begin
  if p_client_id is not null then
    select * into v_shift from time_shifts
      where client_id = p_client_id and profile_id = auth.uid();
    if v_shift.id is not null then
      return v_shift;
    end if;
  end if;

  if not public._toolbox_gate_open(auth.uid()) then
    raise exception 'complete today''s toolbox talk before clocking in';
  end if;

  perform _close_dangling_shift(auth.uid());

  insert into time_shifts
    (profile_id, project_id, cost_code_id, clock_in_photo, clock_in_lat, clock_in_lng,
     client_id, note)
  values
    (auth.uid(), p_project_id, p_cost_code_id, p_photo, p_lat, p_lng,
     p_client_id, nullif(btrim(p_note), ''))
  returning * into v_shift;
  return v_shift;
end;
$$;

-- 3e. The note + mode overload (20260970000000) — the one the app called
-- first before Release 0; a bundle from before it still does.
create or replace function clock_in(
  p_project_id uuid,
  p_cost_code_id uuid,
  p_photo text,
  p_lat double precision,
  p_lng double precision,
  p_note text,
  p_mode text
)
returns time_shifts language plpgsql set search_path = public, pg_temp as $$
declare v_shift time_shifts;
begin
  if not public._toolbox_gate_open(auth.uid()) then
    raise exception 'complete today''s toolbox talk before clocking in';
  end if;

  perform _close_dangling_shift(auth.uid());

  insert into time_shifts
    (profile_id, project_id, cost_code_id, clock_in_photo, clock_in_lat, clock_in_lng,
     note, job_mode)
  values
    (auth.uid(), p_project_id, p_cost_code_id, p_photo, p_lat, p_lng,
     nullif(btrim(p_note), ''),
     case when p_mode in ('data', 'tracking') then p_mode else null end)
  returning * into v_shift;
  return v_shift;
end;
$$;

-- 3f. The keyed overload (20261028000000, Release 0) — the one the app calls
-- first since #640: the tap's one-time id, the mode and the tap time. That
-- migration merges first and carries its own inline copy of the toolbox
-- check; left alone, the paid-time rule would open the five doors above and
-- keep this one shut, so Start day would promise a clock-in the database
-- refused (Codex review of #642, 2026-09-25). Restated from 20261028000000's
-- final body VERBATIM — the per-person advisory lock, the replay lookups (a
-- repeat of a saved id is answered BEFORE the gate, so a punch saved while
-- the gate was open still comes back if it has closed since), the dangling-
-- shift close, the tap-time rule and the timeline check against completed
-- shifts, last_punch_at, the ledger row and the review flag — with ONE
-- change: the inline `if not exists (select 1 from toolbox_completions …)`
-- condition is `if not public._toolbox_gate_open(v_uid)`. SECURITY DEFINER
-- and its pinned search_path stay as they were; the grants are restated so
-- this file says who may call it. app/src/lib/frontDoorKeyedClockIn.test.ts
-- pins the body to 20261028000000's line for line, but for that condition.
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
  v_previous_end timestamptz;
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

  -- One person, one clock-in at a time, until this transaction ends. Two
  -- devices sending clock-ins together — or one tap resent neck and neck
  -- with itself — would otherwise both read the timeline below before either
  -- had written to it, and the second would not see the first's shift.
  perform pg_advisory_xact_lock(hashtextextended('clock_in:' || v_uid::text, 0));

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

  if not public._toolbox_gate_open(v_uid) then
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
    -- The end of this person's timeline: the latest moment any shift that
    -- still counts reached (a voided one has left every total; a completed
    -- or approved one has not). A trusted tap before it would start this
    -- shift inside the previous one and pay the overlap twice — the stale
    -- device whose earlier clock-in arrives after another phone or the
    -- office closed the day. Arrival instead, marked, with the tap kept in
    -- the ledger for the review. An untrusted tap is already arrival time.
    select max(greatest(clock_in_at, clock_out_at)) into v_previous_end
      from public.time_shifts
     where profile_id = v_uid and status <> 'voided';
    if v_pick.used_tap and v_previous_end is not null and v_pick.pay_at < v_previous_end then
      v_pick := (now(), false, 'overlaps_previous_shift')::public.clock_time_pick;
    end if;
  end if;

  insert into public.time_shifts
    (profile_id, project_id, cost_code_id, clock_in_photo, clock_in_lat, clock_in_lng,
     note, job_mode, client_id, clock_in_at, last_punch_at, review_reason)
  values
    (v_uid, p_project_id, p_cost_code_id, p_photo, p_lat, p_lng,
     nullif(btrim(p_note), ''),
     case when p_mode in ('data', 'tracking') then p_mode else null end,
     p_client_id, v_pick.pay_at, v_pick.pay_at, v_pick.reason)
  returning * into v_shift;

  insert into public.time_clock_actions
    (client_id, shift_id, profile_id, action, outcome, tapped_at, arrived_at,
     clock_checked_at, clock_skew_ms, used_tap_time, review_reason)
  values
    (p_client_id, v_shift.id, v_uid, 'clock_in', 'clocked_in', p_tapped_at, now(),
     p_clock_checked_at, p_clock_skew_ms, v_pick.used_tap, v_pick.reason);

  if v_pick.reason is not null then
    perform public._flag_shift_for_review(v_shift.id, v_pick.reason,
      public._clock_review_sentence(v_pick.reason, p_tapped_at, now(), v_previous_end));
  end if;

  return v_shift;
end;
$$;

revoke all on function public.clock_in(uuid, uuid, text, double precision, double precision, text, text, uuid, timestamptz, timestamptz, integer) from public, anon;
grant execute on function public.clock_in(uuid, uuid, text, double precision, double precision, text, text, uuid, timestamptz, timestamptz, integer) to authenticated;

comment on function public.clock_in(uuid, uuid, text, double precision, double precision, text, text, uuid, timestamptz, timestamptz, integer) is
  'Clock in with a one-time client id (a repeat returns the same shift), the job mode, and the phone''s tap time (pay uses it when trusted — see _clock_pick_time; otherwise arrival time and review_reason). 20261028000000; its toolbox check is the shared _toolbox_gate_open since 20261031000000 (today''s signature, or the owner''s paid-time date).';

-- ---------------------------------------------------------------------------
-- 4. Unit work stays locked until signed — six doors, one gate
-- ---------------------------------------------------------------------------
-- Each function below is the latest body on master, restated verbatim, plus
-- ONE line: `perform public._unit_work_gate(…)` after its open-shift check.
-- Order of refusals is unchanged for today's callers: with the rule off an
-- unsigned person has no open shift, so "clock in before starting a task"
-- still fires first, exactly as it does now; only a person clocked in
-- unsigned — possible from the owner's date — meets the new sentence.

-- 4a. start_opening_work (20260969000000): SECURITY INVOKER, open-shift +
-- flashing gates, close-then-open the task session, stamp work_started_at.
create or replace function start_opening_work(p_opening_id uuid)
returns project_openings
language plpgsql
as $$
declare
  v_opening project_openings;
  v_uid uuid := auth.uid();
begin
  if not exists (
    select 1 from time_shifts
    where profile_id = v_uid and status = 'open' and clock_out_at is null
  ) then
    raise exception 'clock in before starting a task';
  end if;
  -- An open shift no longer proves the talk is signed (see the header): the
  -- signature is checked in its own right, in the one shared helper.
  perform public._unit_work_gate(v_uid);

  if _flashing_outstanding(p_opening_id) then
    raise exception 'this opening needs flashing before the install starts';
  end if;

  update project_openings
  set work_started_at = coalesce(work_started_at, now())
  where id = p_opening_id
  returning * into v_opening;

  if v_opening is null then
    raise exception 'unknown opening %', p_opening_id;
  end if;

  perform close_open_task_sessions(v_uid);
  insert into task_sessions (profile_id, opening_id, project_id, state)
  values (v_uid, v_opening.id, v_opening.project_id, 'on_task');

  return v_opening;
end;
$$;

-- 4b. start_opening_phase (20260969000000): SECURITY DEFINER; the phase upsert
-- and its "already submitted" guard are untouched.
create or replace function start_opening_phase(p_opening_id uuid, p_kind text)
returns opening_phases
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_phase opening_phases;
begin
  if not exists (
    select 1 from time_shifts
    where profile_id = v_uid and status = 'open' and clock_out_at is null
  ) then
    raise exception 'clock in before starting a task';
  end if;
  perform public._unit_work_gate(v_uid);

  insert into opening_phases (opening_id, kind, started_by)
  values (p_opening_id, p_kind, v_uid)
  on conflict (opening_id, kind) do update
    -- Re-starting an unfinished phase is fine (a second person joining, or a
    -- resume); a submitted phase stays submitted.
    set started_by = coalesce(opening_phases.started_by, excluded.started_by)
  returning * into v_phase;

  if v_phase.status = 'submitted' then
    raise exception 'this % is already submitted', p_kind;
  end if;
  return v_phase;
end;
$$;

-- 4c. start_unit_session (20260969000000): SECURITY DEFINER; role check,
-- flashing gate for install work, stale-session sweep, handoff close and the
-- work_started_at stamp are untouched.
create or replace function start_unit_session(
  p_opening_id uuid,
  p_role text default 'install'
)
returns unit_sessions
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_row unit_sessions;
begin
  if p_role not in ('install', 'helper') then
    raise exception 'role must be install or helper';
  end if;
  if not exists (
    select 1 from time_shifts
    where profile_id = v_uid and status = 'open' and clock_out_at is null
  ) then
    raise exception 'clock in before starting a task';
  end if;
  perform public._unit_work_gate(v_uid);
  if p_role = 'install' and _flashing_outstanding(p_opening_id) then
    raise exception 'this opening needs flashing before the install starts';
  end if;

  perform _close_stale_sessions(v_uid);
  perform _end_open_session(v_uid, 'handoff');

  insert into unit_sessions (opening_id, profile_id, role, is_rework)
  values (p_opening_id, v_uid, p_role, _has_open_redo(p_opening_id))
  returning * into v_row;

  -- Keep the map/Heartbeat read-model true: first touch stamps the unit.
  update project_openings
  set work_started_at = coalesce(work_started_at, now())
  where id = p_opening_id;

  return v_row;
end;
$$;

-- 4d. resume_opening_phase (20260811010000): SECURITY DEFINER. The one door
-- that never asked for a shift — a deliberate tap after a pause. It asks for
-- the signature now, because the pause may have been yesterday's.
create or replace function resume_opening_phase(p_opening_id uuid, p_kind text)
returns opening_phases
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v opening_phases;
begin
  -- A phase paused yesterday must not run today on an unsigned talk: for the
  -- signature's purposes, resuming is starting. (This RPC never checked the
  -- shift; that is unchanged.)
  perform public._unit_work_gate(auth.uid());
  update opening_phases
     set paused_seconds = paused_seconds
           + greatest(0, extract(epoch from (now() - paused_at))::int),
         paused_at = null
   where opening_id = p_opening_id and kind = p_kind
     and status = 'active' and paused_at is not null
   returning * into v;
  if v is null then
    -- Already running (or never paused) — return the row as it stands.
    select * into v from opening_phases
    where opening_id = p_opening_id and kind = p_kind and status = 'active';
    if v is null then raise exception 'no active % on this opening', p_kind; end if;
  end if;
  return v;
end;
$$;

-- 4e. custom_work_command (20261011000000): SECURITY DEFINER. Current Work,
-- the new Work screen's saved units and the Forge AI field tool
-- start_unit_work (ai_field_command → _ai_field_apply) all start a unit
-- through its 'start' action with a unit_id; that branch is gated by
-- _unit_work_gate. The 'start' with NO unit_id is Prep time — the Work
-- screen's Prep time button, Current Work's, and the Forge AI field tool
-- start_idle_time (the same ai_field_command → _ai_field_apply route) — and
-- is gated by _prep_time_gate in the same place (owner, 2026-09-24).
create or replace function public.custom_work_command(p_id uuid,p_action text,p_data jsonb) returns uuid
language plpgsql security definer set search_path=public,pg_temp as $$
declare
  uid uuid:=auth.uid(); c public.custom_work_commands; u public.custom_work_units;
  s public.custom_work_sessions; sh public.time_shifts; oldj jsonb; outid uuid;
  jid uuid; oid uuid; at_time timestamptz; typ public.custom_work_types;
  expected uuid; target uuid; f jsonb; finish_time timestamptz;
begin
  if not public.custom_work_internal() then raise exception 'An active Forge crew login is required.' using errcode='42501'; end if;
  if p_id is null or p_data is null or jsonb_typeof(p_data)<>'object' then raise exception 'Invalid work request.'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_id::text,7282));
  -- Shares the lock with legacy-session inserts, preventing two surfaces/devices accruing together.
  perform pg_advisory_xact_lock(hashtextextended(uid::text,7281));
  select * into c from public.custom_work_commands where id=p_id;
  if found then
    if c.profile_id<>uid or c.payload<>jsonb_build_object('action',p_action,'data',p_data) then raise exception 'This retry belongs to a different request.'; end if;
    return c.result_id;
  end if;
  if p_action='type' then
    if not public._is_lead(uid) or public.is_test_profile(uid) then raise exception 'Only foremen and above can manage shared types.'; end if;
    target:=(p_data->>'id')::uuid;
    select * into typ from public.custom_work_types where id=target for update;
    if coalesce(typ.revision,0)<>coalesce((p_data->>'revision')::int,-1) then raise exception 'This type changed. Refresh before saving.'; end if;
    oldj:=to_jsonb(typ);
    insert into public.custom_work_types(id,label,archived,revision) values(target,btrim(p_data->>'label'),coalesce((p_data->>'archived')::boolean,false),coalesce(typ.revision,0)+1)
    on conflict(id) do update set label=excluded.label,archived=excluded.archived,revision=excluded.revision;
    outid:=target;
  elsif p_action in ('unit','link') then
    target:=(p_data->>'id')::uuid;
    select * into u from public.custom_work_units where id=target for update;
    if u.id is not null and u.created_by<>uid and not public._is_lead(uid) then raise exception 'Only the author or a foreman can edit this unit.'; end if;
    if coalesce(u.revision,0)<>coalesce((p_data->>'revision')::int,-1) then raise exception 'Unit details changed. Refresh before saving.'; end if;
    if u.project_id is not null and not exists(select 1 from projects where id=u.project_id and deleted_at is null) then raise exception 'That job is unavailable.'; end if;
    jid:=nullif(p_data->>'project_id','')::uuid;
    oid:=nullif(p_data->>'opening_id','')::uuid;
    if jid is not null and not exists(select 1 from projects where id=jid and deleted_at is null) then raise exception 'That job is unavailable.'; end if;
    if oid is not null and not exists(select 1 from project_openings where id=oid and project_id=jid and removed_at is null) then raise exception 'That map unit is not on this job.'; end if;
    if u.project_id is not null and jid is distinct from u.project_id and not public._is_lead(uid) then raise exception 'Ask a foreman to move a record already assigned to a job.'; end if;
    if u.id is not null and (jid is distinct from u.project_id or oid is distinct from u.opening_id) and length(btrim(coalesce(p_data->>'reason','')))<3 then raise exception 'Add a short reason for assigning or linking this record.'; end if;
    f:=coalesce(p_data->'facts','{}'); perform public.validate_custom_work_facts(f);
    oldj:=to_jsonb(u);
    insert into public.custom_work_units(id,project_id,opening_id,created_by,label,type_label,facts,revision)
    values(target,jid,oid,uid,btrim(p_data->>'label'),coalesce(nullif(btrim(p_data->>'type_label'),''),'Unknown'),f,coalesce(u.revision,0)+1)
    on conflict(id) do update set project_id=excluded.project_id,opening_id=excluded.opening_id,label=excluded.label,type_label=excluded.type_label,facts=excluded.facts,revision=excluded.revision,updated_at=now();
    update public.custom_work_units set legacy_time_present=exists(select 1 from unit_sessions where opening_id=oid) or exists(select 1 from task_sessions where opening_id=oid) where id=target;
    -- Attribution moves the observation, never the underlying payroll shift.
    update public.custom_work_sessions set project_id=jid,review_required=review_required or exists(select 1 from time_shifts t where t.id=shift_id and (t.project_id is distinct from jid or t.status in ('needs_finish','rejected','voided'))),revision=revision+1 where unit_id=target and project_id is distinct from jid;
    outid:=target;
  elsif p_action in ('start','stop') then
    at_time:=coalesce((p_data->>'at')::timestamptz,now());
    if at_time>now()+interval '2 minutes' or at_time<now()-interval '7 days' then raise exception 'This work time needs a foreman review. Check the device clock.'; end if;
    expected:=nullif(p_data->>'expected_session_id','')::uuid;
    select * into s from public.custom_work_sessions where profile_id=uid and ended_at is null for update;
    if s.id is null and expected is not null then
      select * into s from public.custom_work_sessions where id=expected and profile_id=uid and ended_at is not null and end_reason in ('clock_out','stop') for update;
      if s.id is not null and (at_time<s.started_at or at_time>s.ended_at) then s.id:=null; end if;
    end if;
    if s.id is distinct from expected then raise exception 'Your current work changed. Sync and review before retrying.'; end if;
    if s.id is not null and at_time<s.started_at then raise exception 'The finish cannot be before the start.'; end if;
    if p_action='start' then
      select * into sh from public.time_shifts where id=(p_data->>'shift_id')::uuid and profile_id=uid for update;
      if sh.id is null or sh.status not in ('open','submitted','approved') or sh.clock_in_at>at_time or (sh.clock_out_at is not null and sh.clock_out_at<=at_time) or (sh.break_started_at is not null and sh.break_started_at<=at_time) then raise exception 'Clock in or resume your job clock before starting work.'; end if;
      -- The job clock already enforces its safety step; do not ask a second time.
      if now()-sh.clock_in_at>interval '16 hours' and sh.clock_out_at is null then raise exception 'Finish the older job clock before starting new work.'; end if;
      target:=nullif(p_data->>'unit_id','')::uuid;
      jid:=sh.project_id;
      -- Both kinds of start wait for today's toolbox signature, right after the
      -- open-shift check above (20261031000000): a UNIT start (a unit_id) meets
      -- the same gate every other unit-start RPC passes; PREP TIME (no unit_id;
      -- kind 'idle') meets its own, in its own sentence — the owner's answer of
      -- 2026-09-24. The two lines are the only change to this branch.
      if target is not null then
        perform public._unit_work_gate(uid);
        select * into u from public.custom_work_units where id=target for update;
        if u.id is null or (u.project_id is null and u.created_by<>uid and not public._is_lead(uid)) then raise exception 'That custom unit is unavailable.'; end if;
        if u.project_id is not null and u.project_id is distinct from sh.project_id then raise exception 'Switch your job clock to this unit''s job first.'; end if;
        jid:=u.project_id;
      else
        perform public._prep_time_gate(uid);
        if length(btrim(coalesce(p_data->>'description','')))=0 then raise exception 'Describe your idle time.'; end if;
      end if;
      if jid is not null and not exists(select 1 from projects where id=jid and deleted_at is null) then raise exception 'That job is unavailable.'; end if;
      -- Never rewrite a newer activity based on a stale/offline start.
      if exists(select 1 from public.custom_work_sessions where profile_id=uid and id is distinct from s.id and coalesce(ended_at,'infinity')>at_time) or exists(select 1 from public.unit_sessions where profile_id=uid and (started_at>at_time or (ended_at is not null and ended_at>at_time))) or exists(select 1 from public.task_sessions where profile_id=uid and (started_at>at_time or (ended_at is not null and ended_at>at_time))) then raise exception 'This overlaps recorded work. Ask a foreman to review the timeline.'; end if;
      if at_time<now()-interval '2 minutes' and exists(select 1 from opening_phases where started_by=uid and status='active' and paused_at is null) then raise exception 'A flashing timer is now running. Ask a foreman to reconcile the older work.'; end if;
      update public.task_sessions set ended_at=at_time where profile_id=uid and ended_at is null;
      update public.unit_sessions set ended_at=at_time,end_reason='handoff' where profile_id=uid and ended_at is null;
      update public.opening_phases set paused_at=at_time where started_by=uid and status='active' and paused_at is null;
    end if;
    if s.id is not null then
      oldj:=to_jsonb(s);
      update public.custom_work_sessions set ended_at=at_time,end_reason=case when p_action='start' then 'switch' else 'stop' end,
        outcome=nullif(p_data->>'outcome',''),description=coalesce(p_data->>'finish_note',description),delay_reason=coalesce(p_data->>'delay_reason',delay_reason),revision=revision+1 where id=s.id;
      insert into public.custom_work_history(project_id,actor_id,entity_id,action,before_value,after_value) select project_id,uid,id,'stop',oldj,to_jsonb(x) from public.custom_work_sessions x where id=s.id;
    end if;
    if p_action='start' then
      -- A later visit reopens completion; the worker can mark the whole install done again.
      update public.custom_work_units set facts=jsonb_set(facts,'{installation_complete}','"No"'),revision=revision+1,updated_at=now() where id=target and facts->>'installation_complete'='Yes';
      if found then
        insert into custom_work_history(project_id,actor_id,entity_id,action,before_value,after_value,reason) select jid,uid,id,'reopen',to_jsonb(u),to_jsonb(x),'New work visit' from custom_work_units x where id=target;
      end if;
      outid:=(p_data->>'id')::uuid;
      insert into public.custom_work_sessions(id,profile_id,shift_id,project_id,unit_id,kind,participation,stage,description,started_at,ended_at,end_reason,shift_status,review_required)
      values(outid,uid,sh.id,jid,target,case when target is null then 'idle' else 'unit' end,coalesce(p_data->>'participation','install'),case when target is null then 'Idle time' else coalesce(p_data->>'stage','Installing') end,coalesce(p_data->>'description',''),at_time,sh.clock_out_at,case when sh.clock_out_at is not null then 'clock_out' end,sh.status,jid is distinct from sh.project_id or (sh.clock_out_at is not null and coalesce(sh.break_seconds,0)>0));
      oldj:=null;
    else outid:=s.id; jid:=s.project_id;
    end if;
  elsif p_action='session' then
    select * into s from public.custom_work_sessions where id=(p_data->>'id')::uuid for update;
    if s.id is null or (s.profile_id<>uid and not public._is_lead(uid)) then raise exception 'Only the worker or a foreman can correct this record.'; end if;
    if s.project_id is not null and not exists(select 1 from projects where id=s.project_id and deleted_at is null) then raise exception 'That job is unavailable.'; end if;
    if s.revision<>coalesce((p_data->>'revision')::int,-1) then raise exception 'This record changed. Refresh before saving.'; end if;
    if length(btrim(coalesce(p_data->>'reason','')))<3 then raise exception 'Add a correction reason.'; end if;
    if s.kind='idle' and length(btrim(coalesce(p_data->>'description',s.description)))=0 then raise exception 'Describe your idle time.'; end if;
    oldj:=to_jsonb(s); jid:=s.project_id; outid:=s.id;
    if coalesce((p_data->>'review_time')::boolean,false) or p_data ? 'started_at' or p_data ? 'ended_at' then
      if not public._is_lead(uid) then raise exception 'Only foremen and above can correct captured times.'; end if;
      if s.ended_at is null then raise exception 'Stop the activity before correcting its time.'; end if;
      select * into sh from time_shifts where id=s.shift_id for update;
      at_time:=coalesce((p_data->>'started_at')::timestamptz,s.started_at);
      finish_time:=coalesce((p_data->>'ended_at')::timestamptz,s.ended_at);
      if sh.status not in ('submitted','approved') or sh.clock_out_at is null or s.project_id is distinct from sh.project_id or s.project_id is null
        or at_time<sh.clock_in_at or finish_time>sh.clock_out_at or finish_time<at_time or finish_time-at_time>interval '16 hours' then
        raise exception 'First resolve the job, timecard, or shift bounds. Captured time must fit its closed job clock.';
      end if;
      if exists(select 1 from custom_work_sessions x where x.profile_id=s.profile_id and x.id<>s.id and x.started_at<finish_time and coalesce(x.ended_at,'infinity')>at_time)
        or exists(select 1 from unit_sessions x where x.profile_id=s.profile_id and x.started_at<finish_time and coalesce(x.ended_at,'infinity')>at_time)
        or exists(select 1 from task_sessions x where x.profile_id=s.profile_id and x.started_at<finish_time and coalesce(x.ended_at,'infinity')>at_time) then
        raise exception 'The corrected interval overlaps other recorded work.';
      end if;
      if extract(epoch from finish_time-at_time)+(select coalesce(sum(extract(epoch from ended_at-started_at)),0) from custom_work_sessions where shift_id=s.shift_id and id<>s.id)
        >extract(epoch from sh.clock_out_at-sh.clock_in_at)-coalesce(sh.break_seconds,0)+1 then
        raise exception 'Captured activity exceeds the worked shift time after breaks. Review the other intervals too.';
      end if;
      update public.custom_work_sessions set started_at=at_time,ended_at=finish_time,review_required=false,end_reason='reviewed' where id=s.id;
    end if;
    update public.custom_work_sessions set description=coalesce(p_data->>'description',description),outcome=nullif(p_data->>'outcome',''),delay_reason=coalesce(p_data->>'delay_reason',delay_reason),revision=revision+1 where id=s.id;
  else raise exception 'Unknown work action.';
  end if;
  -- Audit values live behind the same job/author boundary as the records.
  insert into public.custom_work_history(project_id,actor_id,entity_id,action,before_value,after_value,reason)
  values(jid,uid,coalesce(outid,p_id),p_action,oldj,
    case when p_action in ('unit','link') then (select to_jsonb(x) from public.custom_work_units x where id=outid)
      when p_action='type' then (select to_jsonb(x) from public.custom_work_types x where id=outid)
      else (select to_jsonb(x) from public.custom_work_sessions x where id=outid) end,coalesce(p_data->>'reason',''));
  insert into public.custom_work_commands(id,profile_id,payload,result_id) values(p_id,uid,jsonb_build_object('action',p_action,'data',p_data),outid);
  return outid;
end; $$;

-- 4f. answer_summon (20260963000000): SECURITY DEFINER. The trigger
-- unit_sessions_follow_summon_helpers opens a helper unit session the moment
-- the answer row lands, so the answer itself is the door.
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
  -- Answering opens a helper unit session (unit_sessions_follow_summon_helpers,
  -- 20260963000000) — unit work, so it waits for today's signature too.
  perform public._unit_work_gate(v_uid);
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

-- create-or-replace leaves grants in place; re-granting is idempotent and keeps
-- this migration honest if it is ever applied against a fresh function.
grant execute on function start_opening_work(uuid) to authenticated;
grant execute on function start_opening_phase(uuid, text) to authenticated;
grant execute on function start_unit_session(uuid, text) to authenticated;
revoke all on function resume_opening_phase(uuid, text) from public;
grant execute on function resume_opening_phase(uuid, text) to authenticated;
revoke all on function public.custom_work_command(uuid,text,jsonb) from public,anon;
grant execute on function public.custom_work_command(uuid,text,jsonb) to authenticated;
revoke all on function answer_summon(uuid) from public;
grant execute on function answer_summon(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Tell the crew (docs/app-updates.md)
-- ---------------------------------------------------------------------------
insert into public.app_release_notes(id,published_on,audience,kind,title_en,title_es,body_en,body_es,href) values
('2026-09-23-new-design-choice','2026-09-23',array[0,1,2,3],'improvement',
 'Try the new Forge — your choice','Prueba el nuevo Forge: tú eliges',
 'Settings has a new "Use the new design" switch. The new design puts your clock, today''s job and your next unit on one Work screen, with a Start day button that opens today''s toolbox talk, a Schedule tab, and a "Clocked in" badge at the top of every screen for breaks and clock-out. Your work saves the same either way, and you can switch back any time.',
 'Ajustes tiene un nuevo interruptor "Usar el nuevo diseño". El nuevo diseño pone tu reloj, el trabajo de hoy y tu siguiente unidad en una sola pantalla de Trabajo, con un botón Iniciar el día que abre la charla de seguridad de hoy, una pestaña Horario y una etiqueta "Entrada" arriba de cada pantalla para descansos y salida. Tu trabajo se guarda igual de las dos formas y puedes volver cuando quieras.',
 '/settings'),
('2026-09-23-prep-time','2026-09-23',array[0,1,2,3],'improvement',
 'Idle time is now called Prep time','El tiempo inactivo ahora se llama Tiempo de preparación',
 'Job work that isn''t on one unit — gathering, hauling, setup, errands, cleanup — is now called Prep time everywhere in the app, with one-tap reasons. Nothing about your recorded hours changed; older records simply show the new name.',
 'El trabajo del proyecto que no es de una sola unidad — juntar material, acarrear, preparar, mandados, limpieza — ahora se llama Tiempo de preparación en toda la app, con razones de un toque. Nada cambió en tus horas registradas; los registros anteriores solo muestran el nuevo nombre.',
 NULL),
('2026-09-23-new-design-owner-switches','2026-09-23',array[3],'improvement',
 'Owner switches for the new design and paid-time start','Interruptores del dueño para el nuevo diseño y el inicio del tiempo pagado',
 'Settings has two owner-only controls: a master switch that turns Release 1''s new design off for everyone at once, and the date from which paid time starts at the Start day tap (before the toolbox talk is signed). The date is off until you set it; pick the start of a pay period.',
 'Ajustes tiene dos controles solo para el dueño: un interruptor general que apaga el nuevo diseño del Lanzamiento 1 para todos de una vez, y la fecha desde la cual el tiempo pagado empieza al tocar Iniciar el día (antes de firmar la charla de seguridad). La fecha está apagada hasta que la fijes; elige el inicio de un periodo de pago.',
 '/settings')
on conflict(id) do nothing;
