-- Containers nest one level, and moving one moves everything inside it
-- (warehouse ticket 04 — ADR-0004's "location is inherited" made physical).
--
-- A crate of glass sits inside Conex 3; the crate goes on a truck; twenty
-- packages just moved and NOTHING per-package was written — that is the whole
-- point of inherited location. What this migration adds:
--
--   * packages.location_id — a package can sit loose on a warehouse rack slot
--     instead of in a container. Neither set = LOOSE, the genuinely-cannot-
--     find-it pile (CONTEXT.md). The shelf write path arrives with the one-
--     page warehouse (ticket 08); the column ships now so the read models of
--     tickets 05-06 have one shape to build on.
--   * storage_containers.parent_container_id — a crate inside a conex.
--     Exactly one level: "a crate in a crate in a conex" is where these
--     systems stop being reasonable to think about (grill Q29).
--   * storage_containers.location_id — a conex can have a recorded spot.
--   * move_container() — the one action that relocates a container and, by
--     inheritance, everything in it and in its children.

alter table packages
  add column if not exists location_id uuid references locations (id) on delete set null;

alter table storage_containers
  add column if not exists parent_container_id uuid
    references storage_containers (id) on delete set null,
  add column if not exists location_id uuid references locations (id) on delete set null;

do $$
begin
  -- One place at a time: in a container OR on a slot (or neither = loose).
  if not exists (select 1 from pg_constraint where conname = 'packages_one_place_ck') then
    alter table packages add constraint packages_one_place_ck
      check (container_id is null or location_id is null);
  end if;
  -- A container likewise: inside a parent OR at a spot, never both.
  if not exists (select 1 from pg_constraint where conname = 'containers_one_place_ck') then
    alter table storage_containers add constraint containers_one_place_ck
      check (parent_container_id is null or location_id is null);
  end if;
end;
$$;

-- Depth is a rule about OTHER rows, so a check constraint can't hold it — a
-- trigger can. Both directions are guarded: the parent must not itself have a
-- parent, and a container that holds others can't be tucked inside something.
create or replace function enforce_container_depth()
returns trigger
language plpgsql
as $$
begin
  if new.parent_container_id is not null then
    if new.parent_container_id = new.id then
      raise exception 'a container cannot sit inside itself';
    end if;
    if exists (
      select 1 from storage_containers
      where id = new.parent_container_id and parent_container_id is not null
    ) then
      raise exception 'one level only — a crate inside a conex is as deep as it goes';
    end if;
    if exists (
      select 1 from storage_containers where parent_container_id = new.id
    ) then
      raise exception 'this container holds others — empty it before nesting it';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists storage_containers_depth on storage_containers;
create trigger storage_containers_depth
  before insert or update of parent_container_id on storage_containers
  for each row execute function enforce_container_depth();

-- ---------------------------------------------------------------- RPC

-- Any signed-in crew, same as store_packages: putting a crate somewhere is
-- putting-away work, not a lead decision.
--
-- The ride-along history: every stored package in the moved container (and in
-- its children) gets a 'moved' event naming the container it rode in — that
-- is what keeps "last moved Tuesday by Ammon" answerable per package before
-- ticket 05 unifies the logs. Their container_id does NOT change; the thing
-- that moved is the box they were already in.
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

  update storage_containers
  set parent_container_id = p_parent,
      location_id = p_location
  where id = p_container
  returning * into v_row;

  insert into package_events (package_id, event, container_id, actor, reason)
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
