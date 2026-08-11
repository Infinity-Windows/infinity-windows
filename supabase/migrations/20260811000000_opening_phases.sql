-- Opening phases: work on an opening that isn't the install.
--
-- Flashing is the first phase (owner, 2026-08-10): possibly a different
-- person than the assigned installer, on its own clock, with its own photo
-- proof, and REQUIRED before the install may start or be filed. The shape is
-- deliberately general — a phases table, not flashing columns — so prep or
-- trim-out later are a check-constraint edit, not a redesign.
--
-- The decisions this file implements:
--   • Every opening defaults to needs_flashing = TRUE — including existing
--     rows on live jobs. "Yes is the default, no is the change." The one-tap
--     escape hatch is set_project_needs_flashing (foreman+): a job that
--     doesn't flash gets cleared in one call from spec review.
--   • Starting or submitting an install on an opening whose required
--     flashing isn't submitted is REFUSED server-side.
--   • Phase clocks obey the install clock's rules: you must be clocked in
--     with today's toolbox talk signed to start one, and a phase's minutes
--     are capped at the same 8-hour believability ceiling — past it, the
--     stamp is a forgotten tap, not a shift of flashing.
--   • Submit is enough — no QC step gates a flashed opening (owner call).

-- 1) The flag ---------------------------------------------------------------

alter table project_openings
  add column if not exists needs_flashing boolean not null default true;

-- 2) The phases -------------------------------------------------------------

create table if not exists opening_phases (
  id uuid primary key default gen_random_uuid(),
  opening_id uuid not null references project_openings(id) on delete cascade,
  kind text not null check (kind in ('flashing')),
  status text not null default 'active'
    check (status in ('active','submitted')),
  started_at timestamptz not null default now(),
  started_by uuid references profiles(id),
  submitted_at timestamptz,
  submitted_by uuid references profiles(id),
  /* Worked minutes, server-computed at submit, believability-capped. */
  minutes int check (minutes >= 0),
  /* install-media storage path of the finished-work photo. Required at
     submit: a phase without its proof is not submitted. */
  photo_path text,
  created_at timestamptz not null default now(),
  unique (opening_id, kind)
);

create index if not exists opening_phases_opening_idx on opening_phases (opening_id);

alter table opening_phases enable row level security;
do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'opening_phases' and policyname = 'authenticated read'
  ) then
    create policy "authenticated read" on opening_phases
      for select to authenticated using (true);
  end if;
end;
$$;
-- No client write policies: the security-definer RPCs below are the only
-- writers, so a phase can never be marked submitted without going through
-- the gate.

-- 3) Start a phase ----------------------------------------------------------
-- Same gate as start_opening_work: clocked in + today's toolbox talk. Anyone
-- who passes it can flash any opening — assignment is ownership of the
-- install, never a lock on the window.

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
  ) or not exists (
    select 1 from toolbox_completions
    where profile_id = v_uid and signed_at::date = current_date
  ) then
    raise exception 'clock in and complete today''s toolbox talk before starting a task';
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

revoke all on function start_opening_phase(uuid, text) from public;
grant execute on function start_opening_phase(uuid, text) to authenticated;

-- 4) Submit a phase ---------------------------------------------------------
-- Minutes are computed here, from the phase's own clock, capped at the same
-- ceiling as the install timer (install_timer_cap_minutes(), 480). The photo
-- rides the attachments pipeline client-side; the row is the record.

create or replace function submit_opening_phase(
  p_opening_id uuid,
  p_kind text,
  p_photo_path text
)
returns opening_phases
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_phase opening_phases;
begin
  if p_photo_path is null or btrim(p_photo_path) = '' then
    raise exception 'a finished-work photo is required to submit %', p_kind;
  end if;

  update opening_phases
     set status = 'submitted',
         submitted_at = now(),
         submitted_by = v_uid,
         photo_path = p_photo_path,
         minutes = least(
           greatest(0, floor(extract(epoch from now() - started_at) / 60)::int),
           install_timer_cap_minutes()
         )
   where opening_id = p_opening_id and kind = p_kind and status = 'active'
   returning * into v_phase;

  if v_phase is null then
    raise exception 'no active % to submit on this opening', p_kind;
  end if;
  return v_phase;
end;
$$;

revoke all on function submit_opening_phase(uuid, text, text) from public;
grant execute on function submit_opening_phase(uuid, text, text) to authenticated;

-- 5) The flag setters (foreman+) --------------------------------------------

create or replace function set_opening_needs_flashing(p_opening_id uuid, p_needs boolean)
returns project_openings
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_opening project_openings;
begin
  if not _is_lead(auth.uid()) then
    raise exception 'only a lead-level user can change flashing requirements';
  end if;
  update project_openings set needs_flashing = p_needs
  where id = p_opening_id returning * into v_opening;
  if v_opening is null then raise exception 'unknown opening %', p_opening_id; end if;
  return v_opening;
end;
$$;

create or replace function set_project_needs_flashing(p_project_id uuid, p_needs boolean)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_count int;
begin
  if not _is_lead(auth.uid()) then
    raise exception 'only a lead-level user can change flashing requirements';
  end if;
  update project_openings set needs_flashing = p_needs
  where project_id = p_project_id and needs_flashing is distinct from p_needs;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function set_opening_needs_flashing(uuid, boolean) from public;
grant execute on function set_opening_needs_flashing(uuid, boolean) to authenticated;
revoke all on function set_project_needs_flashing(uuid, boolean) from public;
grant execute on function set_project_needs_flashing(uuid, boolean) to authenticated;

-- 6) Flashing gates the install ---------------------------------------------
-- One shared predicate, used by both doors into "installing".

create or replace function _flashing_outstanding(p_opening_id uuid)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select o.needs_flashing
     and not exists (
       select 1 from opening_phases ph
       where ph.opening_id = o.id and ph.kind = 'flashing'
         and ph.status = 'submitted'
     )
  from project_openings o where o.id = p_opening_id
$$;

-- start_opening_work: body identical to 20260718007000 plus the gate.
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
    raise exception 'clock in and complete today''s toolbox talk before starting a task';
  end if;
  if not exists (
    select 1 from toolbox_completions
    where profile_id = v_uid and signed_at::date = current_date
  ) then
    raise exception 'clock in and complete today''s toolbox talk before starting a task';
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

-- submit_install_event: body identical to 20260718007000 plus the gate.
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

  if _flashing_outstanding(p_opening_id) then
    raise exception 'this opening needs flashing submitted before the install is filed';
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

  if v_profile is not null then
    perform close_open_task_sessions(v_profile);
    insert into task_sessions (profile_id, opening_id, project_id, state)
    values (v_profile, null, v_opening.project_id, 'off_task');
  end if;

  return v_event;
end;
$$;
