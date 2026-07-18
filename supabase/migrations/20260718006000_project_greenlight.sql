-- Project green light — supervisor-controlled "go" status for the Heartbeat.
--
-- The supervisor Heartbeat gives one glance at every active project: live crew,
-- anomaly flags, % complete, open-issue counts, and this green light. The green
-- light is a supervisor-controlled "this job is cleared to run" signal that the
-- board (and any downstream surface) can render at a glance.

alter table projects add column if not exists green_light boolean not null default false;
alter table projects add column if not exists green_light_note text;
alter table projects add column if not exists green_light_by uuid references profiles(id) on delete set null;
alter table projects add column if not exists green_light_at timestamptz;

-- Flip a project's green light. Supervisor+ only (supervisor/owner, plus legacy
-- admin/big_boss). A null/installer/foreman role is blocked in-RPC — matches the
-- roleRank semantics used everywhere else (only rank >= 2 may set).
create or replace function set_project_green_light(
  p_project uuid,
  p_on boolean,
  p_note text default null
)
returns projects
language plpgsql
security definer
as $$
declare
  v_role text;
  v_project projects;
begin
  select role into v_role from profiles where id = auth.uid();
  if v_role is null or v_role in ('installer', 'foreman', 'lead') then
    raise exception 'only a supervisor or above can set a project green light';
  end if;

  update projects
  set green_light = p_on,
      green_light_note = p_note,
      green_light_by = auth.uid(),
      green_light_at = now()
  where id = p_project
  returning * into v_project;

  if v_project is null then
    raise exception 'unknown project %', p_project;
  end if;

  return v_project;
end;
$$;
