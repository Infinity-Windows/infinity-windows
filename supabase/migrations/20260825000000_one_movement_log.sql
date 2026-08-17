-- One movement log (warehouse ticket 05).
--
-- "Last moved Tuesday by Ammon" must be answerable for anything scannable —
-- a window, a package, a crate, someday a supply. Two parallel histories
-- (`movements` for windows, `package_events` for packages) meant the one you
-- needed was always the one missing a column. This migration widens
-- `movements` into the single log and folds `package_events` into it.
--
-- Shape: exactly ONE subject per row (window / package / container / supply)
-- plus context columns saying where it came from and went. Existing window
-- rows already satisfy that — they carry window_id and nothing else.
--
-- The merge tooling's parser reads only `create table` statements, so
-- `package_events` (created 20260814, dropped here) stays visible to it;
-- its dedup entry stays valid and the table tripwire stays at 97.

-- ---------------------------------------------------------------- widen

alter table movements alter column window_id drop not null;

alter table movements
  -- Subjects. Cascade like package_events did: history dies with its thing.
  add column if not exists package_id uuid references packages (id) on delete cascade,
  add column if not exists container_id uuid references storage_containers (id) on delete cascade,
  add column if not exists supply_id uuid references supplies (id) on delete cascade,
  -- Context: which box it left and which it entered (locations had this
  -- pair from day one; containers get theirs now).
  add column if not exists from_container_id uuid references storage_containers (id) on delete set null,
  add column if not exists to_container_id uuid references storage_containers (id) on delete set null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'movements_one_subject_ck') then
    alter table movements add constraint movements_one_subject_ck check (
      (window_id is not null)::int
      + (package_id is not null)::int
      + (container_id is not null)::int
      + (supply_id is not null)::int
      = 1
    );
  end if;
end;
$$;

-- The event vocabulary is the union of both logs. The window set keeps its
-- original names; the package set arrives verbatim so copied history reads
-- exactly as it was written. 'took' is minted for supplies (ticket 07).
--
-- Drop the old event check BY SHAPE, not by name: production's constraint
-- names have drifted before (see docs/migration-repair-2026-07-29), and a
-- survivor here would reject every 'bound'/'stored' row the fold-in writes.
do $$
declare
  c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'movements'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%event%in%'
  loop
    execute format('alter table movements drop constraint %I', c.conname);
  end loop;
end;
$$;
-- The window set is the list as it stood at 20260718060030_loadout_unload —
-- NOT the original 20260715 list. It was widened four times after that
-- (assigned, uninstalled, preissued, unloaded), and rebuilding this check
-- from the first definition is how the first version of this migration broke
-- the deploy: production rows carrying those four values violated it and the
-- ALTER refused, blocking every migration behind it. Widen this list, never
-- retype it from memory.
alter table movements add constraint movements_event_ck check (event in (
  'received', 'putaway', 'moved', 'staged', 'loaded', 'installed', 'damaged',
  'count_verified', 'count_missing', 'override',
  'assigned', 'uninstalled', 'preissued', 'unloaded',
  'bound', 'stored', 'checked_out',
  'took'
));

create index if not exists movements_package_idx on movements (package_id, created_at desc);
create index if not exists movements_container_idx on movements (container_id, created_at desc);

-- ---------------------------------------------------------------- fold in

-- Copy package_events verbatim, then drop it — guarded so a rerun is a no-op.
-- Context mapping is per event: a checkout's container was where the package
-- LEFT FROM; a store/move's container was where it WENT.
do $$
begin
  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'package_events'
  ) then
    insert into movements
      (package_id, event, from_container_id, to_container_id,
       project_id, actor, reason, created_at)
    select
      e.package_id,
      e.event,
      case when e.event = 'checked_out' then e.container_id end,
      case when e.event <> 'checked_out' then e.container_id end,
      e.project_id, e.actor, e.reason, e.created_at
    from package_events e;
    drop table package_events;
  end if;
end;
$$;

-- ------------------------------------------------- rewrite the four writers
--
-- Same signatures, same behavior, one destination. Bodies otherwise verbatim
-- from 20260823 (bind) and 20260814 (store/checkout) and 20260824 (move).

create or replace function bind_package(
  p_package uuid,
  p_project uuid,
  p_category text default null,
  p_note text default null,
  p_marks text[] default null,
  p_delivery uuid default null,
  p_part_index int default null,
  p_part_total int default null,
  p_part_type text default null,
  p_mfr_mark text default null
)
returns packages
language plpgsql
security definer
as $$
declare
  v_row packages;
  v_mark uuid;
  m text;
begin
  if auth.uid() is null then
    raise exception 'sign in first';
  end if;
  if p_project is null then
    raise exception 'every package binds to a job';
  end if;
  if (p_part_index is null) <> (p_part_total is null) then
    raise exception 'a part number needs both halves — "2 of 3", not just one';
  end if;
  if p_part_index is not null and p_part_index > p_part_total then
    raise exception 'part % of % — the first number can''t be bigger than the second', p_part_index, p_part_total;
  end if;

  foreach m in array coalesce(p_marks, array[]::text[])
  loop
    select id into v_mark
    from project_marks
    where project_id = p_project and mark_code = upper(trim(m));
    if v_mark is null then
      raise exception 'mark % is not on this job''s schedule', m;
    end if;
  end loop;

  update packages
  set status = 'received',
      project_id = p_project,
      category = p_category,
      note = nullif(trim(coalesce(p_note, '')), ''),
      delivery_id = p_delivery,
      part_index = p_part_index,
      part_total = p_part_total,
      part_type = p_part_type,
      mfr_mark = nullif(upper(trim(coalesce(p_mfr_mark, ''))), ''),
      bound_at = now(),
      bound_by = auth.uid()::text
  where id = p_package and status = 'blank'
  returning * into v_row;
  if not found then
    raise exception 'that sticker is already assigned — a package ID never moves to another package';
  end if;

  foreach m in array coalesce(p_marks, array[]::text[])
  loop
    select id into v_mark
    from project_marks
    where project_id = p_project and mark_code = upper(trim(m));
    insert into package_marks (package_id, mark_id)
    values (p_package, v_mark)
    on conflict do nothing;
  end loop;

  insert into movements (package_id, event, project_id, actor)
  values (p_package, 'bound', p_project, auth.uid()::text);

  return v_row;
end;
$$;

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

    insert into movements (package_id, event, from_container_id, to_container_id, actor)
    values (
      v_id,
      case when v_prev is null then 'stored' else 'moved' end,
      v_prev,
      p_container,
      auth.uid()::text
    );
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

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

    insert into movements (package_id, event, from_container_id, project_id, reason, actor)
    values (v_id, 'checked_out', v_from, p_project, trim(p_reason), auth.uid()::text);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- move_container now writes TWO kinds of rows: one subject-row for the
-- container itself (who moved the crate, from where to where — the record
-- 20260824 had no home for), and the per-package ride-alongs as before.
create or replace function move_container(
  p_container uuid,
  p_parent uuid default null,
  p_location uuid default null
)
returns storage_containers
language plpgsql
security definer
as $$
declare
  v_row storage_containers;
  v_old_parent uuid;
  v_old_location uuid;
begin
  if auth.uid() is null then
    raise exception 'sign in first';
  end if;
  if p_parent is not null and p_location is not null then
    raise exception 'pick one destination — inside a container or at a spot, not both';
  end if;
  if not exists (select 1 from storage_containers where id = p_container and active) then
    raise exception 'container not found or inactive';
  end if;
  if p_parent is not null
     and not exists (select 1 from storage_containers where id = p_parent and active) then
    raise exception 'destination container not found or inactive';
  end if;

  select parent_container_id, location_id into v_old_parent, v_old_location
  from storage_containers where id = p_container;

  update storage_containers
  set parent_container_id = p_parent,
      location_id = p_location
  where id = p_container
  returning * into v_row;

  insert into movements
    (container_id, event, from_container_id, to_container_id,
     from_location_id, to_location_id, actor)
  values
    (p_container, 'moved', v_old_parent, p_parent, v_old_location, p_location,
     auth.uid()::text);

  insert into movements (package_id, event, to_container_id, actor, reason)
  select p.id, 'moved', p.container_id, auth.uid()::text,
         'rode along — ' || v_row.name || ' moved'
  from packages p
  where p.status = 'stored'
    and (
      p.container_id = p_container
      or p.container_id in (
        select id from storage_containers where parent_container_id = p_container
      )
    );

  return v_row;
end;
$$;
