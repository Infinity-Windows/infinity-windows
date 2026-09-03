-- Drop the redundant per-task toolbox re-check (standard-tracking-jobs slice 1).
--
-- clock_in has refused the first punch of the day without today's signed
-- toolbox talk since 20260813000000_toolbox_gate_timezone.sql, once per day and
-- for every job. So by the time a person is clocked in, the talk is already
-- signed for today — and the SECOND toolbox check inside each start-work RPC
-- only ever fires when the shift check would ALSO fire, or across a midnight the
-- shift check already covers. It is dead weight that made the field button copy
-- read "clock in and complete today's toolbox talk" for a talk the crew had
-- already signed.
--
-- This rebuilds start_opening_work, start_opening_phase and start_unit_session
-- IN FULL from their current bodies (start_opening_work / start_opening_phase
-- from 20260813000000; start_unit_session from 20260820000000), same signatures
-- and same attributes, changing ONLY: the toolbox_completions existence check is
-- removed and the surviving open-shift error now says just "clock in before
-- starting a task", because the toolbox half no longer holds here. Every other
-- guard stays: open shift, flashing-outstanding, the phase on-conflict, the
-- session close/handoff, the work_started_at stamp.

-- start_opening_work: SECURITY INVOKER (unchanged), open-shift + flashing gates,
-- close-then-open the task session, stamp work_started_at.
create or replace function start_opening_work(p_opening_id uuid)
returns project_openings
language plpgsql
as $$
declare
  v_opening project_openings;
  v_uid uuid := auth.uid();
begin
  -- clock_in already enforced today's toolbox talk same-day, so an open shift
  -- is proof the talk is signed. Only the shift needs checking here.
  if not exists (
    select 1 from time_shifts
    where profile_id = v_uid and status = 'open' and clock_out_at is null
  ) then
    raise exception 'clock in before starting a task';
  end if;

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

-- start_opening_phase: SECURITY DEFINER (unchanged). Same open-shift gate; the
-- phase upsert and its "already submitted" guard are untouched.
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

-- start_unit_session: SECURITY DEFINER (unchanged). Same role check, open-shift
-- gate, flashing gate for install work, stale-session sweep, handoff close, and
-- work_started_at stamp.
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

-- create-or-replace leaves grants in place; re-granting is idempotent and keeps
-- this migration honest if it is ever applied against a fresh function.
grant execute on function start_opening_work(uuid) to authenticated;
grant execute on function start_opening_phase(uuid, text) to authenticated;
grant execute on function start_unit_session(uuid, text) to authenticated;
