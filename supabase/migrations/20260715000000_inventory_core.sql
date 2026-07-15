-- Window Ops inventory core schema
-- License-plate-per-window model with addressable locations and an append-only movement log.

create extension if not exists "pgcrypto";

-- ~100 catalog window types. Units belong to a type; knowledge (difficulty,
-- tutorials, tips) attaches at this level.
create table window_types (
  id uuid primary key default gen_random_uuid(),
  type_code text not null unique,          -- e.g. CAS3050
  name text not null,                      -- e.g. Casement 30x50
  category text,                           -- casement / double-hung / slider / picture / specialty
  width_in numeric,
  height_in numeric,
  difficulty_rating int check (difficulty_rating between 1 and 5),
  tutorial_url text,
  notes text,
  created_at timestamptz not null default now()
);

-- Addressable storage locations: ZONE-RACK-SLOT (e.g. S-03-B, J-SMITH-A).
create table locations (
  id uuid primary key default gen_random_uuid(),
  zone text not null check (zone in ('R','J','S','D')),
  rack text not null,                      -- '03' in stock zone, job code in staging zone
  slot text not null,                      -- 'A'..'Z'
  address text generated always as (zone || '-' || rack || '-' || slot) stored,
  capacity int not null default 6,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (zone, rack, slot)
);

-- Contracted jobs.
create table projects (
  id uuid primary key default gen_random_uuid(),
  job_code text not null unique,           -- short code used in staging bay addresses
  name text not null,
  address text,
  status text not null default 'active' check (status in ('active','completed','cancelled')),
  created_at timestamptz not null default now()
);

-- What each project needs, by type.
create table project_windows (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  window_type_id uuid not null references window_types(id),
  quantity int not null default 1 check (quantity > 0),
  unique (project_id, window_type_id)
);

-- One row per physical window: the license plate.
create table windows (
  id uuid primary key default gen_random_uuid(),
  window_id text not null unique,          -- human-readable: W-CAS3050-0042
  window_type_id uuid not null references window_types(id),
  status text not null default 'in_warehouse'
    check (status in ('inbound','in_warehouse','staged','loaded','installed','damaged')),
  project_id uuid references projects(id) on delete set null,
  location_id uuid references locations(id) on delete set null,
  received_at timestamptz not null default now(),
  installed_at timestamptz,
  notes text
);

-- Per-type sequence counters for issuing W-<TYPE>-<SEQ> IDs.
create table window_id_counters (
  window_type_id uuid primary key references window_types(id),
  last_seq int not null default 0
);

-- Append-only event log: every scan writes a row. Audit trail + AI raw data.
create table movements (
  id uuid primary key default gen_random_uuid(),
  window_id uuid not null references windows(id) on delete cascade,
  event text not null
    check (event in ('received','putaway','moved','staged','loaded','installed','damaged','count_verified','count_missing','override')),
  from_location_id uuid references locations(id),
  to_location_id uuid references locations(id),
  project_id uuid references projects(id),
  actor text,                              -- who scanned (auth email/name)
  reason text,                             -- required for overrides/discrepancies
  created_at timestamptz not null default now()
);

-- Photos and voice-memo transcripts, keyed to the unique unit.
create table attachments (
  id uuid primary key default gen_random_uuid(),
  window_id uuid not null references windows(id) on delete cascade,
  kind text not null check (kind in ('photo','voice_memo','transcript','video','document')),
  storage_path text not null,
  transcript text,
  created_by text,
  created_at timestamptz not null default now()
);

-- Cycle count sessions.
create table cycle_counts (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references locations(id),
  started_by text,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  expected int,
  found int,
  discrepancies jsonb not null default '[]'::jsonb
);

create index windows_type_idx on windows(window_type_id);
create index windows_location_idx on windows(location_id);
create index windows_project_idx on windows(project_id);
create index windows_status_idx on windows(status);
create index movements_window_idx on movements(window_id, created_at desc);
create index attachments_window_idx on attachments(window_id);

-- Issue the next unique window ID for a type, atomically.
create or replace function issue_window_id(p_type_id uuid)
returns text
language plpgsql
as $$
declare
  v_code text;
  v_seq int;
begin
  select type_code into v_code from window_types where id = p_type_id;
  if v_code is null then
    raise exception 'unknown window type %', p_type_id;
  end if;

  insert into window_id_counters (window_type_id, last_seq)
  values (p_type_id, 1)
  on conflict (window_type_id)
  do update set last_seq = window_id_counters.last_seq + 1
  returning last_seq into v_seq;

  return 'W-' || v_code || '-' || lpad(v_seq::text, 4, '0');
end;
$$;

-- Receive a window: create the unit, log the event, return the row.
create or replace function receive_window(
  p_type_id uuid,
  p_project_id uuid default null,
  p_actor text default null
)
returns windows
language plpgsql
as $$
declare
  v_window windows;
begin
  insert into windows (window_id, window_type_id, status, project_id)
  values (issue_window_id(p_type_id), p_type_id, 'inbound', p_project_id)
  returning * into v_window;

  insert into movements (window_id, event, project_id, actor)
  values (v_window.id, 'received', p_project_id, p_actor);

  return v_window;
end;
$$;

-- Move/putaway a window to a location, updating status by zone and logging.
create or replace function move_window(
  p_window_id uuid,
  p_location_id uuid,
  p_actor text default null,
  p_reason text default null
)
returns windows
language plpgsql
as $$
declare
  v_window windows;
  v_zone text;
  v_from uuid;
  v_status text;
  v_event text;
begin
  select zone into v_zone from locations where id = p_location_id;
  if v_zone is null then
    raise exception 'unknown location %', p_location_id;
  end if;

  select location_id into v_from from windows where id = p_window_id;

  v_status := case v_zone
    when 'J' then 'staged'
    when 'D' then 'damaged'
    else 'in_warehouse'
  end;
  v_event := case
    when v_from is null then 'putaway'
    when v_zone = 'J' then 'staged'
    when v_zone = 'D' then 'damaged'
    else 'moved'
  end;

  update windows
  set location_id = p_location_id, status = v_status
  where id = p_window_id
  returning * into v_window;

  insert into movements (window_id, event, from_location_id, to_location_id, actor, reason)
  values (p_window_id, v_event, v_from, p_location_id, p_actor, p_reason);

  return v_window;
end;
$$;

-- Load a window onto the truck for its job (leaves the warehouse).
create or replace function load_window(p_window_id uuid, p_actor text default null)
returns windows
language plpgsql
as $$
declare
  v_window windows;
  v_from uuid;
begin
  select location_id into v_from from windows where id = p_window_id;

  update windows
  set status = 'loaded', location_id = null
  where id = p_window_id
  returning * into v_window;

  insert into movements (window_id, event, from_location_id, project_id, actor)
  values (p_window_id, 'loaded', v_from, v_window.project_id, p_actor);

  return v_window;
end;
$$;

-- Mark a window installed on site.
create or replace function install_window(p_window_id uuid, p_actor text default null)
returns windows
language plpgsql
as $$
declare
  v_window windows;
begin
  update windows
  set status = 'installed', installed_at = now()
  where id = p_window_id
  returning * into v_window;

  insert into movements (window_id, event, project_id, actor)
  values (p_window_id, 'installed', v_window.project_id, p_actor);

  return v_window;
end;
$$;

-- Directed putaway suggestion: staging bay if sold to a job, else the stock
-- slot already holding the most units of this type with room, else the
-- emptiest active stock slot.
create or replace function suggest_location(p_window_id uuid)
returns locations
language plpgsql
stable
as $$
declare
  v_window windows;
  v_loc locations;
begin
  select * into v_window from windows where id = p_window_id;
  if v_window is null then
    raise exception 'unknown window %', p_window_id;
  end if;

  if v_window.project_id is not null then
    select l.* into v_loc
    from locations l
    join projects p on p.job_code = l.rack
    where l.zone = 'J' and l.active and p.id = v_window.project_id
      and (select count(*) from windows w where w.location_id = l.id) < l.capacity
    order by l.slot
    limit 1;
    if v_loc.id is not null then
      return v_loc;
    end if;
  end if;

  select l.* into v_loc
  from locations l
  where l.zone = 'S' and l.active
    and (select count(*) from windows w where w.location_id = l.id) < l.capacity
  order by
    (select count(*) from windows w
     where w.location_id = l.id and w.window_type_id = v_window.window_type_id) desc,
    (select count(*) from windows w where w.location_id = l.id) asc,
    l.address
  limit 1;

  return v_loc;
end;
$$;

-- RLS: authenticated users get full access (small trusted crew).
alter table window_types enable row level security;
alter table locations enable row level security;
alter table projects enable row level security;
alter table project_windows enable row level security;
alter table windows enable row level security;
alter table window_id_counters enable row level security;
alter table movements enable row level security;
alter table attachments enable row level security;
alter table cycle_counts enable row level security;

do $$
declare t text;
begin
  foreach t in array array['window_types','locations','projects','project_windows','windows','window_id_counters','movements','attachments','cycle_counts']
  loop
    execute format('create policy "authenticated full access" on %I for all to authenticated using (true) with check (true)', t);
  end loop;
end;
$$;
