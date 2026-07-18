-- Installer spam-through task loop + unified on-task / off-task / break time.
--
-- Reconciles the two previously-decoupled clocks (shift-time from time_shifts,
-- task-time from project_openings.work_started_at) into one interval model:
--   task_sessions rows are 'on_task' (installing a specific opening),
--   'off_task' (between windows), or 'break' (on a shift break).
-- start_opening_work opens an on_task session (and now hard-requires the worker
-- be clocked in with today's toolbox signed); submit_install_event closes it and
-- opens off_task; the break RPCs open/close 'break'. work_ended_at stamps the
-- opening when the install is submitted so elapsed task time is exact.

-- 1. When did the physical install finish for this opening.
alter table project_openings
  add column if not exists work_ended_at timestamptz;

-- 2. On/off/break interval log per person.
create table if not exists task_sessions (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles(id) on delete cascade,
  opening_id uuid references project_openings(id) on delete set null,
  project_id uuid references projects(id) on delete set null,
  state text not null check (state in ('on_task','off_task','break')),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  created_at timestamptz not null default now()
);

-- Fast lookup of a person's currently-open session (ended_at is null).
create index if not exists task_sessions_profile_open_idx
  on task_sessions (profile_id, ended_at);

alter table task_sessions enable row level security;
do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'task_sessions' and policyname = 'authenticated full access'
  ) then
    create policy "authenticated full access" on task_sessions
      for all to authenticated using (true) with check (true);
  end if;
end;
$$;

-- Helper: close every open session for a profile (idempotent).
create or replace function close_open_task_sessions(p_profile uuid)
returns void
language plpgsql
as $$
begin
  update task_sessions
  set ended_at = now()
  where profile_id = p_profile and ended_at is null;
end;
$$;

-- 3. Recreate start_opening_work: guard on shift + toolbox, keep work_started_at,
--    and open a fresh on_task session (closing any dangling ones first).
create or replace function start_opening_work(p_opening_id uuid)
returns project_openings
language plpgsql
as $$
declare
  v_opening project_openings;
  v_uid uuid := auth.uid();
begin
  -- Gate: reconcile shift-time and task-time. You cannot be "on a task" unless
  -- you're clocked in and have signed today's toolbox talk.
  if not exists (
    select 1 from time_shifts
    where profile_id = v_uid and status = 'open' and clock_out_at is null
  ) then
    raise exception 'clock in and complete today''s toolbox talk before starting a task';
  end if;
  if not exists (
    select 1 from toolbox_completions
    where profile_id = v_uid and signed_at::date = current_date
  ) then
    raise exception 'clock in and complete today''s toolbox talk before starting a task';
  end if;

  update project_openings
  set work_started_at = coalesce(work_started_at, now())
  where id = p_opening_id
  returning * into v_opening;

  if v_opening is null then
    raise exception 'unknown opening %', p_opening_id;
  end if;

  -- Reconcile task-time: close whatever the person was doing and land on_task.
  perform close_open_task_sessions(v_uid);
  insert into task_sessions (profile_id, opening_id, project_id, state)
  values (v_uid, v_opening.id, v_opening.project_id, 'on_task');

  return v_opening;
end;
$$;

-- 4. Recreate submit_install_event PRESERVING the current signature + behavior
--    (from 20260716001000_installer_identity.sql) and ALSO: stamp work_ended_at,
--    close the open on_task session, and open an off_task session so the person
--    is "between windows" until they tap the next one.
create or replace function submit_install_event(
  p_opening_id uuid,
  p_installer text default null,
  p_minutes int default null,
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
  p_started_at timestamptz default null,
  p_installer_id uuid default null,
  p_estimate_minutes int default null
)
returns install_events
language plpgsql
as $$
declare
  v_opening project_openings;
  v_event install_events;
  v_profile uuid := coalesce(p_installer_id, auth.uid());
begin
  select * into v_opening from project_openings where id = p_opening_id;
  if v_opening is null then
    raise exception 'unknown opening %', p_opening_id;
  end if;

  insert into install_events (
    project_opening_id, window_id, window_type_id, installer, installer_id,
    started_at, minutes, estimate_minutes, quality_grade, difficulty, went_well,
    went_poorly, obstacles, tools_helped, time_vs_estimate, safety_notes,
    do_again, transcript_raw
  ) values (
    v_opening.id, v_opening.assigned_window_id, v_opening.window_type_id,
    p_installer, v_profile, p_started_at, p_minutes,
    p_estimate_minutes, p_quality_grade, p_difficulty, p_went_well, p_went_poorly,
    p_obstacles, p_tools_helped, p_time_vs_estimate, p_safety_notes, p_do_again,
    p_transcript_raw
  )
  returning * into v_event;

  update project_openings
  set status = 'installed', confirmed = true, work_ended_at = now()
  where id = v_opening.id;

  if v_opening.assigned_window_id is not null then
    perform install_window(v_opening.assigned_window_id, p_installer);
  end if;

  -- Task-time: this window is done — close on_task, land off_task (between
  -- windows) until they tap "Next one" (which opens the next on_task session).
  if v_profile is not null then
    perform close_open_task_sessions(v_profile);
    insert into task_sessions (profile_id, opening_id, project_id, state)
    values (v_profile, null, v_opening.project_id, 'off_task');
  end if;

  return v_event;
end;
$$;

-- 5. start_off_task(): explicit "between windows" transition (e.g. installer
--    backs out of a task without submitting). Closes open sessions, opens
--    off_task. project is optional context.
create or replace function start_off_task(p_project uuid default null)
returns task_sessions
language plpgsql
as $$
declare
  v_session task_sessions;
  v_uid uuid := auth.uid();
begin
  perform close_open_task_sessions(v_uid);
  insert into task_sessions (profile_id, opening_id, project_id, state)
  values (v_uid, null, p_project, 'off_task')
  returning * into v_session;
  return v_session;
end;
$$;

-- 6. Recreate the break RPCs (exact current behavior from
--    20260717008000_pin_and_breaks.sql) + mirror into task_sessions so the
--    on/off/break model stays consistent: start_break closes the open task
--    session and opens a 'break' session; end_break closes 'break' and lands
--    the person off_task (ready to tap their next window).
create or replace function start_break(p_shift_id uuid)
returns time_shifts language plpgsql as $$
declare
  v time_shifts;
begin
  update time_shifts set break_started_at = coalesce(break_started_at, now())
  where id = p_shift_id and profile_id = auth.uid()
  returning * into v;
  if v is null then raise exception 'no open shift %', p_shift_id; end if;

  perform close_open_task_sessions(auth.uid());
  insert into task_sessions (profile_id, opening_id, project_id, state)
  values (auth.uid(), null, v.project_id, 'break');

  return v;
end;
$$;

create or replace function end_break(p_shift_id uuid)
returns time_shifts language plpgsql as $$
declare
  v time_shifts;
begin
  update time_shifts
  set break_seconds = break_seconds
        + greatest(0, extract(epoch from (now() - break_started_at))::int),
      break_started_at = null
  where id = p_shift_id and profile_id = auth.uid() and break_started_at is not null
  returning * into v;
  if v is null then
    select * into v from time_shifts where id = p_shift_id and profile_id = auth.uid();
  end if;

  perform close_open_task_sessions(auth.uid());
  insert into task_sessions (profile_id, opening_id, project_id, state)
  values (auth.uid(), null, v.project_id, 'off_task');

  return v;
end;
$$;

-- Live sync: task_sessions in the realtime publication so a supervisor board can
-- watch on/off/break transitions across crews.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'task_sessions'
  ) then
    alter publication supabase_realtime add table task_sessions;
  end if;
end;
$$;
