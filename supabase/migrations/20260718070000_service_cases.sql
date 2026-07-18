-- Phase 4: warranty / after-service traceability.
--
-- This closes the plan-set -> warranty loop. Every physical unit already carries
-- its full history (received -> loaded -> unloaded -> installed via movements +
-- install_events). A service_case is opened AFTER install, against a specific
-- installed unit, when something goes wrong in the 1-year warranty window:
--   * open_service_case: open a case from a unit's history — derives the unit's
--     project + window type and the latest install event + installer
--     automatically, so the failure is attributed back to the type/installer/
--     procedure without re-keying anything.
--   * schedule_service_case: book the revisit (status 'scheduled').
--   * resolve_service_case: close it out (status 'resolved' + note).
--   * list_service_cases: cross-project feed for the foreman/owner service view,
--     which groups callbacks by window type / installer / fail point so leads see
--     which products, procedures, and people drive warranty work.
--
-- All RPCs are guarded foreman+ (a plain installer, or a missing/unknown
-- profile, is rejected), matching the Phase 1/2/3 pattern.

create table if not exists service_cases (
  id uuid primary key default gen_random_uuid(),
  window_id uuid not null references windows(id) on delete cascade,
  install_event_id uuid references install_events(id) on delete set null,
  project_id uuid references projects(id) on delete set null,
  opening_id uuid references project_openings(id) on delete set null,
  window_type_id uuid references window_types(id) on delete set null,
  installer_id uuid references profiles(id) on delete set null,
  status text not null default 'open' check (status in ('open','scheduled','resolved')),
  reason text,
  fail_point text,
  description text,
  reported_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  scheduled_at timestamptz,
  resolved_by uuid references profiles(id) on delete set null,
  resolved_at timestamptz,
  resolution_note text
);

create index if not exists service_cases_status_idx on service_cases (status);
create index if not exists service_cases_window_idx on service_cases (window_id);
create index if not exists service_cases_type_idx on service_cases (window_type_id);

-- Revisit photos/voice/docs hang off the service case (in addition to the
-- window/install-event targets already supported).
alter table attachments add column if not exists service_case_id uuid
  references service_cases(id) on delete set null;
create index if not exists attachments_service_case_idx on attachments (service_case_id);

-- RLS: same trusted-crew pattern as the other install tables. The write/read
-- RPCs below are additionally guarded foreman+.
alter table service_cases enable row level security;
do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'service_cases' and policyname = 'authenticated full access'
  ) then
    create policy "authenticated full access" on service_cases
      for all to authenticated using (true) with check (true);
  end if;
end;
$$;

-- --- RPCs -------------------------------------------------------------------

-- Open a warranty / after-service case against a specific physical unit. Derives
-- the unit's project + window type and the latest (non-voided) install event +
-- installer automatically, so the callback is attributed back to the type /
-- installer / procedure. status 'open'; reported_by = the caller. Foreman+ only.
create or replace function open_service_case(
  p_window_id uuid,
  p_reason text,
  p_fail_point text default null,
  p_description text default null
)
returns service_cases
language plpgsql
security definer
as $$
declare
  v_role text;
  v_window windows;
  v_event install_events;
  v_case service_cases;
begin
  select role into v_role from profiles where id = auth.uid();
  if v_role is null or v_role = 'installer' then
    raise exception 'only a foreman-level user or above can open a service case';
  end if;

  select * into v_window from windows where id = p_window_id;
  if v_window is null then
    raise exception 'unknown window %', p_window_id;
  end if;

  -- Latest non-voided install event for this unit gives us the opening,
  -- installer, and the exact event the failure traces back to.
  select * into v_event
  from install_events
  where window_id = p_window_id and voided_at is null
  order by created_at desc
  limit 1;

  insert into service_cases (
    window_id, install_event_id, project_id, opening_id, window_type_id,
    installer_id, status, reason, fail_point, description, reported_by
  ) values (
    p_window_id,
    v_event.id,
    v_window.project_id,
    v_event.project_opening_id,
    v_window.window_type_id,
    v_event.installer_id,
    'open',
    p_reason,
    p_fail_point,
    p_description,
    auth.uid()
  )
  returning * into v_case;

  return v_case;
end;
$$;

-- Schedule the revisit for a case (status 'scheduled', scheduled_at = when).
-- Foreman+ only.
create or replace function schedule_service_case(p_id uuid, p_when timestamptz)
returns service_cases
language plpgsql
security definer
as $$
declare
  v_role text;
  v_case service_cases;
begin
  select role into v_role from profiles where id = auth.uid();
  if v_role is null or v_role = 'installer' then
    raise exception 'only a foreman-level user or above can schedule a service case';
  end if;

  update service_cases
  set status = 'scheduled', scheduled_at = p_when
  where id = p_id
  returning * into v_case;
  if v_case is null then
    raise exception 'unknown service case %', p_id;
  end if;
  return v_case;
end;
$$;

-- Resolve a case (status 'resolved', resolved_by = caller, resolved_at = now,
-- resolution_note = note). Foreman+ only.
create or replace function resolve_service_case(p_id uuid, p_note text default null)
returns service_cases
language plpgsql
security definer
as $$
declare
  v_role text;
  v_case service_cases;
begin
  select role into v_role from profiles where id = auth.uid();
  if v_role is null or v_role = 'installer' then
    raise exception 'only a foreman-level user or above can resolve a service case';
  end if;

  update service_cases
  set status = 'resolved',
      resolved_by = auth.uid(),
      resolved_at = now(),
      resolution_note = p_note
  where id = p_id
  returning * into v_case;
  if v_case is null then
    raise exception 'unknown service case %', p_id;
  end if;
  return v_case;
end;
$$;

-- Cross-project service-case feed for the foreman/owner service view. Returns
-- every case (open + scheduled + resolved); the UI filters + groups by window
-- type / installer / fail point for attribution. Foreman+ only.
create or replace function list_service_cases()
returns setof service_cases
language plpgsql
security definer
as $$
declare v_role text;
begin
  select role into v_role from profiles where id = auth.uid();
  if v_role is null or v_role = 'installer' then
    raise exception 'service cases are for foreman-level users and above';
  end if;
  return query select * from service_cases order by created_at desc;
end;
$$;
