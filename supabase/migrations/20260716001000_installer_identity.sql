-- Phase A2: real installer identity on install events + a role-change guard.
-- Turns the free-text `installer` email into a real profiles FK so we can
-- learn per-installer performance, and captures the pre-install estimate and
-- structured photo findings.

alter table install_events
  add column if not exists installer_id uuid references profiles(id) on delete set null,
  add column if not exists estimate_minutes int check (estimate_minutes is null or estimate_minutes >= 0),
  add column if not exists photo_findings jsonb;

create index if not exists install_events_installer_idx
  on install_events (installer_id, window_type_id);

-- Recreate submit_install_event with installer_id + estimate captured.
drop function if exists submit_install_event(
  uuid, text, int, int, text, text, text, text, text, text, text, text, text, timestamptz
);

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
    p_installer, coalesce(p_installer_id, auth.uid()), p_started_at, p_minutes,
    p_estimate_minutes, p_quality_grade, p_difficulty, p_went_well, p_went_poorly,
    p_obstacles, p_tools_helped, p_time_vs_estimate, p_safety_notes, p_do_again,
    p_transcript_raw
  )
  returning * into v_event;

  update project_openings
  set status = 'installed', confirmed = true
  where id = v_opening.id;

  if v_opening.assigned_window_id is not null then
    perform install_window(v_opening.assigned_window_id, p_installer);
  end if;

  return v_event;
end;
$$;

-- Backfill installer_id from the email already stored on past events.
update install_events e
set installer_id = p.id
from profiles p
join auth.users u on u.id = p.id
where e.installer_id is null and lower(e.installer) = lower(u.email);

-- Role-change guard: only an existing lead may change roles (stops self-promotion).
create or replace function set_profile_role(p_target uuid, p_role text)
returns profiles
language plpgsql
security definer
as $$
declare
  v_caller_role text;
  v_profile profiles;
begin
  if p_role not in ('installer','lead') then
    raise exception 'invalid role %', p_role;
  end if;
  select role into v_caller_role from profiles where id = auth.uid();
  if v_caller_role is distinct from 'lead' then
    raise exception 'only a lead can change roles';
  end if;
  update profiles set role = p_role, updated_at = now()
  where id = p_target
  returning * into v_profile;
  return v_profile;
end;
$$;
