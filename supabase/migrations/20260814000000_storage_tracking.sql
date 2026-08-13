-- Storage tracking: conex containers + license-plate packages.
--
-- The owner's receiving reality (2026-08-13): a diesel truck drops a mixed
-- delivery (windows/doors/frames/hardware for several jobs). Crews stick a
-- PRE-PRINTED anonymous QR sticker on each package as it comes off — the
-- sticker binds to the package on first use and is permanent from then on
-- (the warehouse industry's "license plate" pattern). Packages then check in
-- to one of ~8-15 rented conex containers (or the main warehouse), and
-- installers later check them out with a reason + destination job.
--
-- Design decisions (owner picks, 2026-08-13):
--   * Binding records job + category + optional marks from the job schedule
--     ("where is window 16?" is answerable when crews fill it in).
--   * Checkout CONCLUDES tracking (reason + destination job); a transfer to
--     another container re-stores instead, and a package that comes back can
--     simply check in again.
--   * This is a NEW layer: the per-unit `windows` system (serials, openings
--     assignment) is untouched.
--
-- Security model: reads are open to the crew like the rest of the warehouse,
-- but there are NO direct-write policies — every mutation goes through the
-- SECURITY DEFINER RPCs below (which re-check roles), so the wide-open-RLS
-- hole the older warehouse tables carry is not repeated here.

-- ---------------------------------------------------------------- containers

create sequence if not exists container_serial_seq;

create table if not exists storage_containers (
  id uuid primary key default gen_random_uuid(),
  serial text unique default ('CTR-' || lpad(nextval('container_serial_seq')::text, 6, '0')),
  name text not null,
  address text,
  access_code text,
  notes text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

drop trigger if exists storage_containers_lock_serial on storage_containers;
create trigger storage_containers_lock_serial
  before update on storage_containers
  for each row execute function lock_serial();

-- ---------------------------------------------------------------- packages

create sequence if not exists package_serial_seq;

-- One truckload; lets "what arrived on the Aug 14 delivery" stay answerable.
create table if not exists package_deliveries (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  arrived_on date not null default current_date,
  created_by text,
  created_at timestamptz not null default now()
);

create table if not exists packages (
  id uuid primary key default gen_random_uuid(),
  serial text unique default ('PKG-' || lpad(nextval('package_serial_seq')::text, 6, '0')),
  short_code text unique,
  -- blank: printed, on the roll, means nothing yet.
  -- received: bound to a physical package (job/category/marks locked in).
  -- stored: sitting in a container.
  -- checked_out: taken by an installer with a reason — tracking concluded.
  status text not null default 'blank'
    check (status in ('blank', 'received', 'stored', 'checked_out')),
  project_id uuid references projects (id) on delete set null,
  category text
    check (category in ('windows', 'doors', 'frames', 'hardware', 'other')),
  note text,
  delivery_id uuid references package_deliveries (id) on delete set null,
  container_id uuid references storage_containers (id) on delete set null,
  bound_at timestamptz,
  bound_by text,
  created_at timestamptz not null default now()
);

create index if not exists packages_container_idx on packages (container_id);
create index if not exists packages_project_idx on packages (project_id);
create index if not exists packages_status_idx on packages (status);

drop trigger if exists packages_lock_serial on packages;
create trigger packages_lock_serial
  before update on packages
  for each row execute function lock_serial();

-- Which marks from the job's schedule ride inside (optional, per owner pick).
create table if not exists package_marks (
  package_id uuid not null references packages (id) on delete cascade,
  mark_code text not null,
  primary key (package_id, mark_code)
);

-- Append-only history: every touch, forever (mirrors `movements`).
create table if not exists package_events (
  id uuid primary key default gen_random_uuid(),
  package_id uuid not null references packages (id) on delete cascade,
  event text not null
    check (event in ('bound', 'stored', 'moved', 'checked_out')),
  container_id uuid references storage_containers (id) on delete set null,
  project_id uuid references projects (id) on delete set null,
  reason text,
  actor text,
  created_at timestamptz not null default now()
);

create index if not exists package_events_package_idx on package_events (package_id);

-- Checkout reasons are data, not code — supervisors curate the list.
create table if not exists checkout_reasons (
  id uuid primary key default gen_random_uuid(),
  label text not null unique,
  sort int not null default 100,
  active boolean not null default true
);

insert into checkout_reasons (label, sort) values
  ('Ready for installation', 10),
  ('Staging for delivery', 20),
  ('Damaged — return to supplier', 30),
  ('Warranty / service', 40),
  ('Other', 90)
on conflict (label) do nothing;

-- ---------------------------------------------------------------- RLS

alter table storage_containers enable row level security;
alter table package_deliveries enable row level security;
alter table packages enable row level security;
alter table package_marks enable row level security;
alter table package_events enable row level security;
alter table checkout_reasons enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array[
    'storage_containers', 'package_deliveries', 'packages',
    'package_marks', 'package_events', 'checkout_reasons'
  ]
  loop
    if not exists (
      select 1 from pg_policies
      where tablename = t and policyname = 'crew read'
    ) then
      execute format(
        'create policy "crew read" on %I for select to authenticated using (true)',
        t
      );
    end if;
    -- Deliberately NO insert/update/delete policies: writes only through the
    -- SECURITY DEFINER RPCs below.
  end loop;
end;
$$;

-- ---------------------------------------------------------------- RPCs

-- Foreman+: print a batch of blank stickers. Returns the fresh rows so the
-- client can build the PDF immediately.
create or replace function mint_packages(p_count int)
returns setof packages
language plpgsql
security definer
as $$
declare
  v_role text;
  i int;
  v_row packages;
begin
  select role into v_role from profiles where id = auth.uid();
  if v_role is null or v_role = 'installer' then
    raise exception 'only a foreman-level user or above can print sticker batches';
  end if;
  if p_count is null or p_count < 1 or p_count > 500 then
    raise exception 'sticker batches are 1-500 at a time';
  end if;

  for i in 1..p_count loop
    insert into packages (short_code)
    values (issue_package_short_code())
    returning * into v_row;
    return next v_row;
  end loop;
  return;
end;
$$;

create or replace function issue_package_short_code()
returns text
language plpgsql
as $$
declare
  v_code text;
begin
  loop
    v_code := gen_short_code(6);
    exit when not exists (select 1 from packages where short_code = v_code);
  end loop;
  return v_code;
end;
$$;

-- Foreman+: register or edit a container. Serial is set once by default and
-- locked by trigger; name/address/code stay editable forever.
create or replace function save_storage_container(
  p_id uuid,
  p_name text,
  p_address text default null,
  p_access_code text default null,
  p_notes text default null,
  p_active boolean default true
)
returns storage_containers
language plpgsql
security definer
as $$
declare
  v_role text;
  v_row storage_containers;
begin
  select role into v_role from profiles where id = auth.uid();
  if v_role is null or v_role = 'installer' then
    raise exception 'only a foreman-level user or above can manage containers';
  end if;
  if p_name is null or length(trim(p_name)) = 0 then
    raise exception 'a container needs a name';
  end if;

  if p_id is null then
    insert into storage_containers (name, address, access_code, notes, active)
    values (trim(p_name), p_address, p_access_code, p_notes, coalesce(p_active, true))
    returning * into v_row;
  else
    update storage_containers
    set name = trim(p_name), address = p_address, access_code = p_access_code,
        notes = p_notes, active = coalesce(p_active, true)
    where id = p_id
    returning * into v_row;
    if not found then
      raise exception 'container not found';
    end if;
  end if;
  return v_row;
end;
$$;

-- Any crew: today's delivery group (create-or-reuse by label + date).
create or replace function ensure_package_delivery(p_label text)
returns package_deliveries
language plpgsql
security definer
as $$
declare
  v_row package_deliveries;
begin
  if auth.uid() is null then
    raise exception 'sign in first';
  end if;
  select * into v_row
  from package_deliveries
  where label = trim(p_label) and arrived_on = current_date
  limit 1;
  if found then
    return v_row;
  end if;
  insert into package_deliveries (label, created_by)
  values (trim(p_label), auth.uid()::text)
  returning * into v_row;
  return v_row;
end;
$$;

-- Any crew: bind a blank sticker to a physical package — ONCE. The job is
-- required; category/note/marks are the optional detail. Blank-only guard
-- makes the license-plate promise real: a bound sticker can never rebind.
create or replace function bind_package(
  p_package uuid,
  p_project uuid,
  p_category text default null,
  p_note text default null,
  p_marks text[] default null,
  p_delivery uuid default null
)
returns packages
language plpgsql
security definer
as $$
declare
  v_row packages;
  m text;
begin
  if auth.uid() is null then
    raise exception 'sign in first';
  end if;
  if p_project is null then
    raise exception 'every package binds to a job';
  end if;

  update packages
  set status = 'received',
      project_id = p_project,
      category = p_category,
      note = nullif(trim(coalesce(p_note, '')), ''),
      delivery_id = p_delivery,
      bound_at = now(),
      bound_by = auth.uid()::text
  where id = p_package and status = 'blank'
  returning * into v_row;
  if not found then
    raise exception 'that sticker is already assigned — a package ID never moves to another package';
  end if;

  foreach m in array coalesce(p_marks, array[]::text[])
  loop
    insert into package_marks (package_id, mark_code)
    values (p_package, upper(trim(m)))
    on conflict do nothing;
  end loop;

  insert into package_events (package_id, event, project_id, actor)
  values (p_package, 'bound', p_project, auth.uid()::text);

  return v_row;
end;
$$;

-- Any crew: check packages into a container (the multi-select flow). Works
-- for fresh packages ('stored') and for transfers between containers
-- ('moved') — a transfer is a re-store, not a checkout, per the owner's pick.
create or replace function store_packages(p_packages uuid[], p_container uuid)
returns int
language plpgsql
security definer
as $$
declare
  v_id uuid;
  v_prev uuid;
  v_count int := 0;
begin
  if auth.uid() is null then
    raise exception 'sign in first';
  end if;
  if not exists (select 1 from storage_containers where id = p_container and active) then
    raise exception 'container not found or inactive';
  end if;

  foreach v_id in array coalesce(p_packages, array[]::uuid[])
  loop
    select container_id into v_prev
    from packages
    where id = v_id and status in ('received', 'stored', 'checked_out');
    if not found then
      continue; -- blank stickers can't be stored
    end if;

    update packages
    set status = 'stored', container_id = p_container
    where id = v_id;

    insert into package_events (package_id, event, container_id, actor)
    values (
      v_id,
      case when v_prev is null then 'stored' else 'moved' end,
      p_container,
      auth.uid()::text
    );
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- Any crew (installers included — the owner's flow): check packages OUT.
-- Reason + destination job required; this concludes tracking for the package
-- (its full history stays in package_events).
create or replace function checkout_packages(
  p_packages uuid[],
  p_reason text,
  p_project uuid
)
returns int
language plpgsql
security definer
as $$
declare
  v_id uuid;
  v_from uuid;
  v_count int := 0;
begin
  if auth.uid() is null then
    raise exception 'sign in first';
  end if;
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'pick a reason for taking the material';
  end if;
  if p_project is null then
    raise exception 'pick the job this material is going to';
  end if;

  foreach v_id in array coalesce(p_packages, array[]::uuid[])
  loop
    select container_id into v_from
    from packages
    where id = v_id and status in ('received', 'stored');
    if not found then
      continue;
    end if;

    update packages
    set status = 'checked_out', container_id = null
    where id = v_id;

    insert into package_events (package_id, event, container_id, project_id, reason, actor)
    values (v_id, 'checked_out', v_from, p_project, trim(p_reason), auth.uid()::text);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- Supervisor+: curate the checkout reason list.
create or replace function save_checkout_reason(
  p_id uuid,
  p_label text,
  p_sort int default 100,
  p_active boolean default true
)
returns checkout_reasons
language plpgsql
security definer
as $$
declare
  v_role text;
  v_row checkout_reasons;
begin
  select role into v_role from profiles where id = auth.uid();
  if v_role is null or v_role in ('installer', 'foreman') then
    raise exception 'only a supervisor or above can edit checkout reasons';
  end if;
  if p_label is null or length(trim(p_label)) = 0 then
    raise exception 'a reason needs a label';
  end if;

  if p_id is null then
    insert into checkout_reasons (label, sort, active)
    values (trim(p_label), coalesce(p_sort, 100), coalesce(p_active, true))
    returning * into v_row;
  else
    update checkout_reasons
    set label = trim(p_label), sort = coalesce(p_sort, 100), active = coalesce(p_active, true)
    where id = p_id
    returning * into v_row;
    if not found then
      raise exception 'reason not found';
    end if;
  end if;
  return v_row;
end;
$$;
