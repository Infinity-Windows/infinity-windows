-- A shift can no longer run forever, and nothing here ever invents an hour.
--
-- The bug this closes was live on production. One shift was punched in on
-- 18 July 2026 and never closed, so the clock sheet read "WORKING 286:57:59"
-- twelve days later. The display was the harmless half. The dangerous half is
-- that every `clock_in` overload closed a dangling shift like this:
--
--     update time_shifts set clock_out_at = now(), status = 'submitted'
--      where profile_id = auth.uid() and status = 'open' and clock_out_at is null;
--
-- That is what "switch job" and "switch phase" call. One tap on the phase chips
-- already on that screen would have stamped a finish time twelve days after the
-- start and marked the result *submitted* — a 287-hour timecard, sitting in the
-- approvals queue, that nobody worked and nobody typed.
--
-- The rule adopted here is the one the install timer settled on in PR #198:
-- past the point where an auto-timed figure is believable, stop filling the
-- number in and ask a human for it.
--
--   * Dangling shift shorter than the cap -> closed at now() as before. A
--     forgotten punch inside the same day is a normal switch, and the number is
--     still evidence.
--   * Dangling shift past the cap -> status 'needs_finish', `clock_out_at`
--     stays NULL. It contributes no hours anywhere, it stops blocking a fresh
--     clock-in, and it says out loud that only a person knows the answer.
--
-- Nothing is deleted and no row's recorded time is altered. Idempotent.

-- 1) The cap, in one place, so SQL and the client cannot drift ---------------
-- Mirrors SHIFT_CAP_HOURS in app/src/lib/shiftGuard.ts. Sixteen hours is past
-- any single continuous shift, including a long install day with travel either
-- side, so beyond it the clock is measuring absence rather than work.

create or replace function shift_cap_hours()
returns int language sql immutable set search_path = public, pg_temp as $$
  select 16
$$;

-- 2) 'needs_finish' becomes a legal status ----------------------------------

alter table time_shifts drop constraint if exists time_shifts_status_check;
alter table time_shifts
  add constraint time_shifts_status_check
  check (status in ('open', 'submitted', 'approved', 'rejected', 'needs_finish'));

-- Find the runaways quickly from either the office screen or the crew's own.
create index if not exists time_shifts_unfinished_idx
  on time_shifts (clock_in_at)
  where clock_out_at is null;

-- 3) One shared dangling-shift closer --------------------------------------
-- Every clock_in overload had its own copy of the close, which is how all four
-- came to share one bug. They now all call this.

create or replace function _close_dangling_shift(p_profile uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_cap interval := make_interval(hours => shift_cap_hours());
begin
  -- Believable: a forgotten punch inside the day, or a job/phase switch. The
  -- elapsed time is still evidence, so close it exactly as before.
  update time_shifts
     set clock_out_at = now(),
         status = 'submitted'
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

-- 4) Re-create every clock_in overload over the shared closer ---------------
-- Bodies are otherwise unchanged: the toolbox-talk gate, the GPS columns, the
-- note handling and the client_id idempotency all behave exactly as they did.

-- 4a) 5-arg: photo + GPS (20260718040000).
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
  if not exists (
    select 1 from toolbox_completions
    where profile_id = auth.uid() and signed_at::date = current_date
  ) then
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

-- 4b) 6-arg with a worker note (20260723060030).
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
  if not exists (
    select 1 from toolbox_completions
    where profile_id = auth.uid() and signed_at::date = current_date
  ) then
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

-- 4c) 6-arg with an idempotency key (20260720000000).
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

  if not exists (
    select 1 from toolbox_completions
    where profile_id = auth.uid() and signed_at::date = current_date
  ) then
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

-- 4d) 7-arg: idempotency key + note (20260723060030).
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

  if not exists (
    select 1 from toolbox_completions
    where profile_id = auth.uid() and signed_at::date = current_date
  ) then
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

-- 5) A person supplies the finish time the app refused to guess -------------
-- The crew member whose shift it is, or any lead. The finish must be after the
-- start and must not be in the future; a long-but-real answer is accepted,
-- because refusing one only teaches people to type a comfortable lie. It lands
-- as 'submitted' so it goes through the same approval a normal punch does, and
-- the row records that the time was hand-entered.

create or replace function finish_shift_at(
  p_shift_id uuid,
  p_clock_out_at timestamptz,
  p_injured boolean default false,
  p_break_seconds int default null
)
returns time_shifts
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_shift time_shifts;
  v_lead boolean := _is_lead(auth.uid());
begin
  select * into v_shift from time_shifts where id = p_shift_id;
  if v_shift.id is null then
    raise exception 'no shift %', p_shift_id;
  end if;
  if v_shift.profile_id <> auth.uid() and not v_lead then
    raise exception 'that is not your shift';
  end if;
  if v_shift.clock_out_at is not null then
    raise exception 'that shift already has a finish time';
  end if;
  if p_clock_out_at is null then
    raise exception 'a finish time is required';
  end if;
  if p_clock_out_at <= v_shift.clock_in_at then
    raise exception 'the finish time must be after the clock-in time';
  end if;
  -- Two minutes of tolerance for a phone whose clock runs fast. Anything
  -- further ahead would be recording work that has not happened yet.
  if p_clock_out_at > now() + interval '2 minutes' then
    raise exception 'the finish time cannot be in the future';
  end if;

  update time_shifts
     set clock_out_at = p_clock_out_at,
         injured = coalesce(p_injured, injured),
         break_seconds = coalesce(p_break_seconds, break_seconds),
         break_started_at = null,
         break_type = null,
         time_confirmed = true,
         signed_at = now(),
         status = 'submitted',
         edited_by = auth.uid(),
         edited_at = now(),
         edited_note = left(
           coalesce(edited_note || ' | ', '') ||
           'Finish time entered by hand because the shift ran past '
           || shift_cap_hours() || 'h and the app would not guess one.',
           2000)
   where id = p_shift_id
  returning * into v_shift;

  return v_shift;
end;
$$;

revoke all on function finish_shift_at(uuid, timestamptz, boolean, int) from public;
grant execute on function finish_shift_at(uuid, timestamptz, boolean, int) to authenticated;

-- 6) Let a lead close a 'needs_finish' shift from the timecard screen -------
-- lead_edit_shift only promoted a punch to 'submitted' from 'open', so a shift
-- parked in 'needs_finish' would have taken a finish time and stayed flagged
-- for ever. Body is otherwise identical to 20260718050000.

create or replace function lead_edit_shift(
  p_shift_id uuid,
  p_project_id uuid default null,
  p_cost_code_id uuid default null,
  p_clock_in_at timestamptz default null,
  p_clock_out_at timestamptz default null,
  p_break_seconds int default null,
  p_note text default null
)
returns time_shifts
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_shift time_shifts;
begin
  if not _is_lead(auth.uid()) then
    raise exception 'only a lead-level user can edit crew time';
  end if;
  update time_shifts
     set project_id    = coalesce(p_project_id, project_id),
         cost_code_id  = coalesce(p_cost_code_id, cost_code_id),
         clock_in_at   = coalesce(p_clock_in_at, clock_in_at),
         clock_out_at  = coalesce(p_clock_out_at, clock_out_at),
         break_seconds = coalesce(p_break_seconds, break_seconds),
         edited_note   = coalesce(p_note, edited_note),
         edited_by     = auth.uid(),
         edited_at     = now(),
         status        = case
                           when p_clock_out_at is not null
                                and status in ('open', 'needs_finish')
                             then 'submitted'
                           else status
                         end
   where id = p_shift_id
   returning * into v_shift;
  if v_shift is null then raise exception 'no shift %', p_shift_id; end if;
  return v_shift;
end;
$$;

-- 7) Retire the runaways that already exist --------------------------------
-- Same treatment as a live one hitting the cap: no invented finish time, no
-- deleted row, and a note saying why. This is what takes the 286-hour timer
-- off the clock sheet and puts it on the office's list instead.

update time_shifts
   set status = 'needs_finish',
       break_started_at = null,
       break_type = null,
       edited_note = left(
         coalesce(edited_note || ' | ', '') ||
         'Open since ' || to_char(clock_in_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI')
         || 'Z with no clock-out. The app stopped counting rather than invent an '
         || 'end time. Needs the real finish time, or cancelling if no work was done.',
         2000)
 where clock_out_at is null
   and status = 'open'
   and now() - clock_in_at > make_interval(hours => shift_cap_hours());
