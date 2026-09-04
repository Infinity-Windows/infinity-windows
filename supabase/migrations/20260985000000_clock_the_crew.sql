-- Clock the crew in and out from the roster (owner ask, 2026-09-04).
--
-- WHAT HE SAW: fourteen people on Team timecards, every one of them clocked
-- into OFFICE a minute or two apart. Somebody stood in the shop and punched
-- fourteen phones in by hand, one at a time, and the timestamps are the
-- fingerprint of it. He asked for one tap that clocks the whole list in — and
-- one that clocks them out again at the end of the day.
--
-- THE HONESTY PROBLEM this creates, and how it is answered here. Every punch
-- in this database has meant "this person tapped this button". A punch a
-- supervisor makes FOR somebody is a different fact, and if it looked
-- identical the timecard would quietly stop being evidence of anything:
--
--   * time_shifts.clocked_in_by / clocked_out_by say who pressed it. NULL
--     keeps its old meaning — the person themselves — so every row that
--     already exists reads correctly without a backfill.
--   * every on-behalf punch also writes a time_shift_edits row, so it lands
--     in the audit trail supervisors already read AND in the worker's own
--     "Your timecard was changed" feed (Wave K, K4, 20260976000000). The
--     person finds out from the app, not from a short cheque.
--   * the bulk loops repeat only the refusals written here, marked with
--     `using hint = 'crew-clock'`. Anything else `when others` catches is an
--     accident, and its raw Postgres wording is logged rather than shown.
--
-- THE TOOLBOX PROBLEM, and why this is not a hole in the safety gate. Since
-- 20260718003000 nobody may clock in without today's signed toolbox talk, and
-- 20260813000000 made that day company-local. A bulk clock-in that ignored the
-- gate would let one tap put fourteen people on the clock with nobody having
-- heard a safety talk — the exact failure the gate exists to prevent. So:
--
--   * clock_in_for REFUSES unless the supervisor ticks p_talk_attested. The
--     box says "I gave today's toolbox talk to everyone selected", and that
--     claim is what is being recorded.
--   * for anybody who has not already signed today, it files a real
--     toolbox_completions row marked signed_via = 'group' with signed_by =
--     the supervisor. A group sign-in is a WEAKER record than a signature and
--     is stored as one — no typed name, no drawn signature, no PDF — but it
--     is a record, with a named person answerable for it, rather than a gate
--     switched off. Somebody who already signed for themselves keeps their
--     own row; this never overwrites a signature with an attestation.
--
-- RANK: supervisor+ (_is_supervisor, 20260810000000), the same tier that may
-- already edit and void crew time. A foreman reads this screen and cannot
-- change time on it, which is Q3's settled line; a partner login is refused
-- outright even though its pinned 'installer' rank would refuse it anyway.
--
-- IDEMPOTENT throughout: add-column-if-not-exists, a guarded create type,
-- drop-then-add for the check constraint, create-or-replace for every
-- function. Safe to run twice.
--
-- NO NEW TABLE. The on-behalf marks live on time_shifts and time_shift_edits,
-- and the group sign-in lives in toolbox_completions — three tables that all
-- already carry their partner-wall policy (20260950000000) and, being company-
-- wide rather than project-scoped, nothing for attach_sandbox_guards() to arm.
--
-- MERGE ORDER: nothing else in flight carries a migration. This is 20260985000000
-- and it lands after 20260984000000 (wave U). It touches time_shifts,
-- toolbox_completions and time_shift_edits, which no open branch touches.

-- ---------------------------------------------------------------------------
-- 1. Who pressed the button
-- ---------------------------------------------------------------------------
-- Nullable with NO default and no backfill: null means "the person themselves",
-- which is what every one of the punches already in this table is. Wave K added
-- last_seen_* to this table the same way (20260976000000).
--
-- `on delete set null` rather than cascade: a supervisor leaving the company
-- must never delete somebody else's timecard. The name goes; the punch stays.
alter table time_shifts
  add column if not exists clocked_in_by uuid references profiles(id) on delete set null;
alter table time_shifts
  add column if not exists clocked_out_by uuid references profiles(id) on delete set null;

comment on column time_shifts.clocked_in_by is
  'The supervisor who started this punch FOR the crew member, from the Team timecards roster. NULL = the person clocked themselves in, which is every punch made before 20260985000000. Written by clock_in_for(); the same event is also recorded in time_shift_edits so the worker sees it in their own notifications feed.';
comment on column time_shifts.clocked_out_by is
  'The supervisor who ended this punch FOR the crew member. NULL = the person clocked themselves out. Also set on the punch a move closes, when clock_in_for moves somebody from another job.';

create index if not exists time_shifts_clocked_in_by_idx
  on time_shifts (clocked_in_by) where clocked_in_by is not null;

-- ---------------------------------------------------------------------------
-- 2. A group sign-in on the toolbox talk
-- ---------------------------------------------------------------------------
-- signed_via defaults to 'self' so EVERY existing row, and every row the
-- worker's own sign-off path keeps inserting, reads as a real signature
-- without touching either. The clock gate is untouched: it asks only "is there
-- a row for this person today", which is the point — a group sign-in satisfies
-- it exactly like a signature does.
--
-- The screens are NOT untouched, and must not be. Recording the difference in
-- the database and then showing the two identically would be the worst of both
-- (2026-09-04 review: for a day, that is exactly what shipped — a worker's own
-- Safety page said "Signed today ✓" above a blank name for a talk they never
-- saw). lib/toolbox.ts now names these columns in every read, todayCompliance
-- counts signatures and attestations separately, and the Safety page and the
-- personal history say which one a row is. todayCompliance falls back to the
-- old two-column select on a missing-column error, so a phone running ahead of
-- this migration still gets its compliance list.
alter table toolbox_completions
  add column if not exists signed_by uuid references profiles(id) on delete set null;
alter table toolbox_completions
  add column if not exists signed_via text not null default 'self';

alter table toolbox_completions drop constraint if exists toolbox_completions_signed_via_check;
alter table toolbox_completions add constraint toolbox_completions_signed_via_check
  check (signed_via in ('self', 'group'));

comment on column toolbox_completions.signed_by is
  'Who filed this completion. NULL (or equal to profile_id) = the crew member signed for themselves. Set to the supervisor when signed_via = ''group''.';
comment on column toolbox_completions.signed_via is
  'How today''s talk was recorded: ''self'' = the crew member read it and signed it on their own phone (typed name + drawn signature + archived PDF); ''group'' = a supervisor gave the talk to a group in person and attested to it while clocking them in from the roster. A group row deliberately carries no signature and no PDF — it is a weaker record, and stored as one. Defaults to ''self'' so every pre-existing row and every self sign-off keeps its meaning.';

-- ---------------------------------------------------------------------------
-- 3. File the group sign-in, once, for one person
-- ---------------------------------------------------------------------------
-- Internal helper, called only by the SECURITY DEFINER functions below, so it
-- is granted to nobody: a crew login must not be able to sign somebody else's
-- safety talk directly.
--
-- The day comparison is 'America/Denver' spelled out — the company-local day
-- 20260813000000 settled for every clock gate. There is no helper to reuse;
-- the convention IS the literal, so this follows it rather than inventing a
-- second source of truth.
create or replace function public._file_group_toolbox_signin(
  p_profile_id uuid,
  p_by uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_day date := (now() at time zone 'America/Denver')::date;
  v_talk uuid;
begin
  -- Already covered for today — by their own signature, or by an earlier
  -- group sign-in this morning. Never a second row: the gate is satisfied,
  -- and a duplicate would make the compliance list say two people signed.
  if exists (
    select 1 from toolbox_completions tc
     where tc.profile_id = p_profile_id
       and (tc.signed_at at time zone 'America/Denver')::date = v_day
  ) then
    return;
  end if;

  -- Today's talk, if there is one. A company that has not published one yet
  -- still gets a dated record of the attestation, with no talk attached —
  -- talk_id is nullable and always has been.
  select st.id into v_talk
    from safety_talks st
   where st.talk_date = v_day
   order by st.created_at desc
   limit 1;

  insert into toolbox_completions
    (talk_id, profile_id, signed_at, typed_name, signed_by, signed_via)
  values
    (v_talk, p_profile_id, now(), null, p_by, 'group');
end;
$$;

comment on function public._file_group_toolbox_signin(uuid, uuid) is
  'Record that a supervisor gave today''s toolbox talk to this person in person, so the clock-in gate is satisfied. No-op when they are already covered for the company-local day. Internal: called only by clock_in_for / clock_in_many.';

revoke all on function public._file_group_toolbox_signin(uuid, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. One person, one answer
-- ---------------------------------------------------------------------------
-- A named composite rather than `returns table (profile_id uuid, ...)`: an OUT
-- parameter called profile_id would shadow the column of the same name on
-- time_shifts, toolbox_completions and profiles, and every unqualified
-- reference inside these bodies would become ambiguous. A type has no such
-- trap, and it lets the bulk functions be `setof` the exact same shape the
-- single-person ones return, so the client parses one row the same way it
-- parses fourteen.
do $$
begin
  create type crew_clock_result as (profile_id uuid, outcome text);
exception when duplicate_object then
  null;
end;
$$;

comment on type crew_clock_result is
  'One person''s answer from an on-behalf clock action. outcome is one of: clocked_in, already_on_this_job, moved_from_other_job, clocked_out, already_out, or refused:<plain sentence>. Everything a bulk call needs to say who it actually touched.';

-- ---------------------------------------------------------------------------
-- 5. clock_in_for: a real punch, made by somebody else
-- ---------------------------------------------------------------------------
-- The rules are the ones the newest clock_in overload (20260970000000) plays
-- by, plus the ones a picker on a phone enforces client-side and a bulk call
-- from the office has no business trusting: the job is live, the cost code is
-- one this job actually uses, and the mode is one this job allows. Getting
-- fourteen punches onto a deleted job because a roster was stale is not a
-- mistake anybody would notice until payroll.
--
-- NO GEO, deliberately. Every other clock-in stamps clock_in_lat/lng from the
-- phone that pressed it. Here that phone is the supervisor's, standing in the
-- shop, and writing it onto fourteen crew punches would put fourteen people at
-- a place none of them chose to report. An absent fix is the truthful record.
--
-- p_move_if_elsewhere is the server half of the sheet's "Move anyone already on
-- another job here" box. Off by default and REFUSED rather than silently
-- honoured, because the decision has to survive the gap between reading the
-- roster and tapping the button: somebody can start their own punch on another
-- job in that half-second, and a client-side skip would move them anyway.
create or replace function public.clock_in_for(
  p_profile_id uuid,
  p_project_id uuid,
  p_cost_code_id uuid,
  p_note text default null,
  p_mode text default null,
  p_talk_attested boolean default false,
  p_move_if_elsewhere boolean default false
)
returns crew_clock_result
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_actor_name text;
  v_person profiles;
  v_project projects;
  v_open time_shifts;
  v_shift time_shifts;
  v_mode text;
  v_outcome text := 'clocked_in';
  v_moved_from text;
begin
  -- ---- who is asking ------------------------------------------------------
  if v_actor is null then
    raise exception 'Sign in before clocking anybody in.' using hint = 'crew-clock';
  end if;
  -- A builder/GC login is pinned to 'installer' (20260950000000), so the rank
  -- check below already refuses it. Said out loud anyway: this function is
  -- SECURITY DEFINER and writes straight past every policy on time_shifts, so
  -- the wall has to stand in the body, not only on the table.
  if public.is_partner_user() then
    raise exception 'Not available for your account.' using errcode = '42501', hint = 'crew-clock';
  end if;
  if not _is_supervisor(v_actor) then
    raise exception 'Only a supervisor or above can clock somebody else in.' using hint = 'crew-clock';
  end if;
  if not coalesce(p_talk_attested, false) then
    raise exception 'Give today''s toolbox talk first, then tick the box to say you did.' using hint = 'crew-clock';
  end if;

  -- ---- who is being clocked in -------------------------------------------
  select * into v_person from profiles where id = p_profile_id;
  if not found then
    raise exception 'That person is not on the crew list.' using hint = 'crew-clock';
  end if;
  if not coalesce(v_person.active, false) then
    raise exception 'They are not an active crew member.' using hint = 'crew-clock';
  end if;
  if coalesce(v_person.is_partner, false) then
    raise exception 'That is a builder login, not a crew member.' using hint = 'crew-clock';
  end if;

  -- ---- the job ------------------------------------------------------------
  select * into v_project from projects where id = p_project_id;
  if not found or v_project.deleted_at is not null then
    raise exception 'That job is not there any more.' using hint = 'crew-clock';
  end if;
  if v_project.status is distinct from 'active' then
    raise exception '% is not an active job, so nobody can put time on it.', v_project.job_code
      using hint = 'crew-clock';
  end if;

  -- ---- the cost code ------------------------------------------------------
  if p_cost_code_id is null then
    raise exception 'Pick a cost code before clocking anybody in.' using hint = 'crew-clock';
  end if;
  if not exists (
    select 1 from cost_codes cc where cc.id = p_cost_code_id and cc.active
  ) then
    raise exception 'That cost code is not in use any more.' using hint = 'crew-clock';
  end if;
  -- The same rule resolveClockCostCodes plays by on the phone (20260973000000):
  -- a job with its own subset allows only those codes, a job without one allows
  -- the whole active library, and the general catch-all is allowed either way
  -- so nobody is ever left with nothing valid to charge to.
  if exists (
        select 1 from project_cost_codes pcc where pcc.project_id = p_project_id
      )
     and not exists (
        select 1 from project_cost_codes pcc
         where pcc.project_id = p_project_id and pcc.cost_code_id = p_cost_code_id
      )
     and not exists (
        select 1 from cost_codes cc where cc.id = p_cost_code_id and cc.is_general
      )
  then
    raise exception 'That cost code is not one % uses.', v_project.job_code using hint = 'crew-clock';
  end if;

  -- ---- the mode -----------------------------------------------------------
  v_mode := case when p_mode in ('data', 'tracking') then p_mode else null end;
  if v_mode is not null and not (v_mode = any (v_project.allowed_modes)) then
    raise exception '% is not set up for % work.', v_project.job_code, v_mode
      using hint = 'crew-clock';
  end if;

  -- ---- are they already on the clock? -------------------------------------
  select * into v_open
    from time_shifts ts
   where ts.profile_id = p_profile_id
     and ts.status = 'open'
     and ts.clock_out_at is null
   order by ts.clock_in_at desc
   limit 1;

  if found then
    if v_open.project_id is not distinct from p_project_id then
      -- Already exactly where this call wanted them. Opening a second punch
      -- would split one day into two and double nothing but the paperwork.
      return (p_profile_id, 'already_on_this_job')::crew_clock_result;
    end if;
    select pj.job_code into v_moved_from from projects pj where pj.id = v_open.project_id;
    if not coalesce(p_move_if_elsewhere, false) then
      raise exception 'Already on %. Tick "Move anyone already on another job here" to bring them over.',
        coalesce(v_moved_from, 'another job') using hint = 'crew-clock';
    end if;
    v_outcome := 'moved_from_other_job';
  end if;

  select p.display_name into v_actor_name from profiles p where p.id = v_actor;
  v_actor_name := coalesce(v_actor_name, 'a supervisor');

  -- ---- the safety talk ----------------------------------------------------
  -- Files a group sign-in for anybody not already covered today, which is what
  -- makes the gate below pass honestly rather than being bypassed.
  perform public._file_group_toolbox_signin(p_profile_id, v_actor);

  -- ---- close whatever was running ----------------------------------------
  -- The shared close every clock_in overload calls (20260945000000): a
  -- believable punch is closed at now() and marked auto-closed; one that ran
  -- past the cap is put into needs_finish rather than given a made-up end.
  perform _close_dangling_shift(p_profile_id);

  if v_open.id is not null then
    -- Say who ended it, and log it, for the same reason the new punch does:
    -- a move is a clock-out somebody else performed.
    update time_shifts ts
       set clocked_out_by = v_actor
     where ts.id = v_open.id
       and ts.clock_out_at is not null
       and ts.clocked_out_by is null;

    insert into time_shift_edits (shift_id, edited_by, field, old_value, new_value, reason)
    select v_open.id, v_actor, 'clock_out', null, ts.clock_out_at::text,
           'clocked out by ' || v_actor_name || ' from the roster, moving them to '
             || v_project.job_code
      from time_shifts ts
     where ts.id = v_open.id
       and ts.clock_out_at is not null;
  end if;

  -- ---- the punch ----------------------------------------------------------
  insert into time_shifts
    (profile_id, project_id, cost_code_id, note, job_mode, clocked_in_by)
  values
    (p_profile_id, p_project_id, p_cost_code_id,
     nullif(btrim(p_note), ''), v_mode, v_actor)
  returning * into v_shift;

  -- ---- the audit trail, and with it the worker's own notice ---------------
  insert into time_shift_edits (shift_id, edited_by, field, old_value, new_value, reason)
  values (v_shift.id, v_actor, 'clock_in', null, v_shift.clock_in_at::text,
          'clocked in by ' || v_actor_name || ' from the roster');

  return (p_profile_id, v_outcome)::crew_clock_result;
end;
$$;

comment on function public.clock_in_for(uuid, uuid, uuid, text, text, boolean, boolean) is
  'Supervisor+: start a punch FOR a crew member from the Team timecards roster. Plays by the same rules as clock_in (live job, a cost code the job uses, a mode the job allows, the shared dangling-shift close) and additionally requires p_talk_attested — the supervisor''s claim that they gave today''s toolbox talk — which files a group sign-in for anybody not already covered. Stamps clocked_in_by and writes a time_shift_edits row so the worker is told. Returns (profile_id, outcome).';

revoke all on function public.clock_in_for(uuid, uuid, uuid, text, text, boolean, boolean) from public, anon;
grant execute on function public.clock_in_for(uuid, uuid, uuid, text, text, boolean, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. clock_out_for
-- ---------------------------------------------------------------------------
-- Closes at now(), the same moment clock_out uses. Two things it deliberately
-- does NOT do, both because the person is not holding the phone:
--
--   * time_confirmed is left alone. On the worker's own clock-out, leaving the
--     "my time is wrong" box unticked IS the answer "yes, it's correct". Nobody
--     answered that here, and writing `true` would put words in their mouth on
--     the one field the office reads to decide whether to look twice.
--   * a running break is folded into break_seconds instead of being abandoned,
--     so a person clocked out while at lunch is not paid for the lunch.
create or replace function public.clock_out_for(p_profile_id uuid)
returns crew_clock_result
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_actor_name text;
  v_open time_shifts;
  v_shift time_shifts;
begin
  if v_actor is null then
    raise exception 'Sign in before clocking anybody out.' using hint = 'crew-clock';
  end if;
  if public.is_partner_user() then
    raise exception 'Not available for your account.' using errcode = '42501', hint = 'crew-clock';
  end if;
  if not _is_supervisor(v_actor) then
    raise exception 'Only a supervisor or above can clock somebody else out.' using hint = 'crew-clock';
  end if;

  select * into v_open
    from time_shifts ts
   where ts.profile_id = p_profile_id
     and ts.clock_out_at is null
     and ts.status in ('open', 'needs_finish')
   order by ts.clock_in_at desc
   limit 1;

  if not found then
    -- Not an error and not a refusal: a bulk call sweeps up whoever is on the
    -- clock, and "they were already off" is a perfectly good thing to report.
    return (p_profile_id, 'already_out')::crew_clock_result;
  end if;

  if v_open.status = 'needs_finish' then
    -- The app already refused to guess an end for this one. Stamping now()
    -- here would be that same guess, made by somebody who was not there.
    raise exception 'Their punch ran too long to guess an end for. Set the real finish time on "Still on the clock".'
      using hint = 'crew-clock';
  end if;

  select p.display_name into v_actor_name from profiles p where p.id = v_actor;
  v_actor_name := coalesce(v_actor_name, 'a supervisor');

  update time_shifts ts
     set clock_out_at = now(),
         break_seconds = ts.break_seconds + case
           when ts.break_started_at is not null
             then greatest(0, floor(extract(epoch from (now() - ts.break_started_at)))::int)
           else 0
         end,
         break_started_at = null,
         break_type = null,
         signed_at = now(),
         status = 'submitted',
         clocked_out_by = v_actor
   where ts.id = v_open.id
  returning * into v_shift;

  insert into time_shift_edits (shift_id, edited_by, field, old_value, new_value, reason)
  values (v_shift.id, v_actor, 'clock_out', null, v_shift.clock_out_at::text,
          'clocked out by ' || v_actor_name || ' from the roster');

  return (p_profile_id, 'clocked_out')::crew_clock_result;
end;
$$;

comment on function public.clock_out_for(uuid) is
  'Supervisor+: close a crew member''s open punch now, stamping clocked_out_by and logging it to time_shift_edits. A person already off the clock is a no-op that answers ''already_out''. Refuses a punch the app has already stopped counting (needs_finish) rather than guessing its end. Returns (profile_id, outcome).';

revoke all on function public.clock_out_for(uuid) from public, anon;
grant execute on function public.clock_out_for(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. The whole list, in one request
-- ---------------------------------------------------------------------------
-- One tap is one round trip. Fourteen separate calls from a phone on site is
-- fourteen chances for the signal to drop halfway through, leaving half a crew
-- on the clock and nobody sure which half.
--
-- Each person is attempted inside their OWN exception block, which is a
-- subtransaction: one refusal rolls back that person and nothing else, so a
-- deactivated account or somebody who wandered onto another job cannot take
-- the other thirteen down with them. Their line comes back as
-- 'refused:<sentence>' and the roster prints it beside their name.
--
-- WHOSE WORDS end up on that line matters, and it is why every deliberate
-- refusal above carries `using hint = 'crew-clock'`. `when others` catches far
-- more than the sentences this file writes: a check constraint on time_shifts,
-- one of the unit_sessions triggers, a deadlock. Passing sqlerrm straight
-- through would print
--   Not done — new row for relation "time_shifts" violates check constraint
--   "time_shifts_job_mode_check"
-- onto a supervisor's phone, which is exactly the leak the app's own rule
-- against String(err) exists to stop. The hint is the marker that separates
-- "we refused this, on purpose, in plain English" from "something broke": the
-- first is repeated word for word, the second becomes one generic line and the
-- real text goes to the Postgres log for whoever is fixing it.
create or replace function public.clock_in_many(
  p_profile_ids uuid[],
  p_project_id uuid,
  p_cost_code_id uuid,
  p_note text default null,
  p_mode text default null,
  p_talk_attested boolean default false,
  p_move_if_elsewhere boolean default false
)
returns setof crew_clock_result
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
  v_hint text;
begin
  -- The whole-call refusals are checked ONCE, up front, and thrown rather than
  -- returned: "you are not allowed to do this" and "you have not said you gave
  -- the talk" are facts about the request, not fourteen separate outcomes.
  if auth.uid() is null then
    raise exception 'Sign in before clocking anybody in.' using hint = 'crew-clock';
  end if;
  if public.is_partner_user() then
    raise exception 'Not available for your account.' using errcode = '42501', hint = 'crew-clock';
  end if;
  if not _is_supervisor(auth.uid()) then
    raise exception 'Only a supervisor or above can clock somebody else in.' using hint = 'crew-clock';
  end if;
  if not coalesce(p_talk_attested, false) then
    raise exception 'Give today''s toolbox talk first, then tick the box to say you did.' using hint = 'crew-clock';
  end if;

  for v_id in
    select distinct u from unnest(coalesce(p_profile_ids, '{}'::uuid[])) as u
  loop
    begin
      return next public.clock_in_for(
        v_id, p_project_id, p_cost_code_id, p_note, p_mode,
        p_talk_attested, p_move_if_elsewhere);
    exception when others then
      -- Only a refusal this file WROTE is repeated to a supervisor. Everything
      -- else caught here is an accident — a check constraint, a trigger, a
      -- deadlock — and sqlerrm for those is raw Postgres wording, which is the
      -- one thing an installer-facing app must never put on a screen. It is
      -- logged instead, where whoever is fixing it can read it.
      get stacked diagnostics v_hint = pg_exception_hint;
      if v_hint is distinct from 'crew-clock' then
        raise warning 'clock_in_many: unexpected error for %: % (%)',
          v_id, sqlerrm, sqlstate;
        return next (
          v_id,
          'refused:Something went wrong for this person. Try again, or clock them in from their own phone.'
        )::crew_clock_result;
      else
        return next (v_id, 'refused:' || sqlerrm)::crew_clock_result;
      end if;
    end;
  end loop;
end;
$$;

comment on function public.clock_in_many(uuid[], uuid, uuid, text, text, boolean, boolean) is
  'Supervisor+: clock a whole selection in, one row back per person (clocked_in | already_on_this_job | moved_from_other_job | refused:<sentence>). Each person is attempted in their own subtransaction, so one refusal never rolls back the rest. Duplicated ids are collapsed.';

revoke all on function public.clock_in_many(uuid[], uuid, uuid, text, text, boolean, boolean) from public, anon;
grant execute on function public.clock_in_many(uuid[], uuid, uuid, text, text, boolean, boolean) to authenticated;

create or replace function public.clock_out_many(p_profile_ids uuid[])
returns setof crew_clock_result
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
  v_hint text;
begin
  if auth.uid() is null then
    raise exception 'Sign in before clocking anybody out.' using hint = 'crew-clock';
  end if;
  if public.is_partner_user() then
    raise exception 'Not available for your account.' using errcode = '42501', hint = 'crew-clock';
  end if;
  if not _is_supervisor(auth.uid()) then
    raise exception 'Only a supervisor or above can clock somebody else out.' using hint = 'crew-clock';
  end if;

  for v_id in
    select distinct u from unnest(coalesce(p_profile_ids, '{}'::uuid[])) as u
  loop
    begin
      return next public.clock_out_for(v_id);
    exception when others then
      -- Same rule as clock_in_many: our own sentence, or one generic line.
      get stacked diagnostics v_hint = pg_exception_hint;
      if v_hint is distinct from 'crew-clock' then
        raise warning 'clock_out_many: unexpected error for %: % (%)',
          v_id, sqlerrm, sqlstate;
        return next (
          v_id,
          'refused:Something went wrong for this person. Try again, or clock them out from their own phone.'
        )::crew_clock_result;
      else
        return next (v_id, 'refused:' || sqlerrm)::crew_clock_result;
      end if;
    end;
  end loop;
end;
$$;

comment on function public.clock_out_many(uuid[]) is
  'Supervisor+: clock a whole selection out, one row back per person (clocked_out | already_out | refused:<sentence>). Same one-subtransaction-per-person shape as clock_in_many.';

revoke all on function public.clock_out_many(uuid[]) from public, anon;
grant execute on function public.clock_out_many(uuid[]) to authenticated;
