-- Ticket 12: a container knows what it is.
--
-- Every container was the same shape — a name, an address, a code — which is
-- how a crate ends up described as a conex on screen, and how nesting rules
-- had to guess. Three later tickets branch on what kind of box something is
-- (a compass makes sense inside a building and lies inside a conex that gets
-- re-parked), so the kind becomes a column, not a guess.
--
--   conex    — a shipping container; nests in nothing.
--   crate    — glass, mostly; rides in a conex or on a truck, and a forklift
--              can put one on a job whole, which is why it carries dimensions
--              and weight (some crates fit in no conex at all).
--   truck    — a container that drives; holds crates and packages in transit.
--   building — the main warehouse. Holds anything, sits in nothing, and NEVER
--              moves ("our main warehouse does not move" — owner, 2026-08-18).
--
-- The two containers production has today are both conexes, so the default is
-- 'conex' and the backfill is the default doing its job.

alter table storage_containers
  add column if not exists kind text not null default 'conex',
  add column if not exists length_cm numeric,
  add column if not exists width_cm numeric,
  add column if not exists height_cm numeric,
  add column if not exists weight_kg numeric;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'containers_kind_ck') then
    alter table storage_containers add constraint containers_kind_ck
      check (kind in ('conex', 'crate', 'truck', 'building'));
  end if;
  -- Dimensions are measurements, not codes: null means "not measured", and a
  -- measured zero is somebody's typo, not a crate.
  if not exists (select 1 from pg_constraint where conname = 'containers_dims_ck') then
    alter table storage_containers add constraint containers_dims_ck
      check (
        (length_cm is null or length_cm > 0) and
        (width_cm  is null or width_cm  > 0) and
        (height_cm is null or height_cm > 0) and
        (weight_kg is null or weight_kg > 0)
      );
  end if;
end;
$$;

-- The main warehouse becomes a real container, so "it's in the main warehouse"
-- is a recordable answer without inventing a shelf (grill Q8, 2026-08-18).
-- Exactly one: seeded only if no building exists yet, so this migration does
-- not care how many times it has run — and if the owner has already renamed
-- the building, a re-run must not resurrect the old name.
insert into storage_containers (name, kind)
select 'Main warehouse', 'building'
where not exists (select 1 from storage_containers where kind = 'building');

-- The nesting rules stop being guesses. The depth trigger from 20260824 keeps
-- guarding one-level-deep; these are the KIND rules on top of it, enforced in
-- the one function every move goes through:
--   * a building never moves — not into a parent, not onto a slot;
--   * nothing nests INTO a crate (a crate is the smallest box there is);
--   * a conex rides only on a truck (yard moves happen by truck), never
--     inside another conex or a building's record;
--   * a crate rides in a conex, on a truck, or in the building.
-- Rebuilt from the CURRENT definition in 20260825000000 plus the kind checks —
-- never from the original — because rebuilding from a stale body is how a
-- constraint here once dropped four event values in production.
create or replace function move_container(
  p_container uuid,
  p_parent uuid default null,
  p_location uuid default null
)
returns storage_containers
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row storage_containers;
  v_old_parent uuid;
  v_old_location uuid;
  v_kind text;
  v_parent_kind text;
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

  select kind into v_kind from storage_containers where id = p_container;
  if v_kind = 'building' then
    raise exception 'the building does not move';
  end if;

  if p_parent is not null then
    select kind into v_parent_kind
    from storage_containers where id = p_parent and active;
    if v_parent_kind is null then
      raise exception 'destination container not found or inactive';
    end if;
    if v_parent_kind = 'crate' then
      raise exception 'nothing goes inside a crate — a crate is the smallest box there is';
    end if;
    if v_kind = 'conex' and v_parent_kind <> 'truck' then
      raise exception 'a conex only rides on a truck';
    end if;
    if v_kind = 'truck' then
      raise exception 'a truck does not go inside anything';
    end if;
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

-- save_storage_container learns kind and dimensions. Rebuilt from the current
-- definition in 20260814000000 (nothing since has redefined it — checked).
-- The kind is set at creation and never changed after: a crate that "becomes"
-- a conex is really a new box, and rewriting the kind would silently re-rule
-- every package history line inside it.
drop function if exists save_storage_container(uuid, text, text, text, text, boolean);
create or replace function save_storage_container(
  p_id uuid,
  p_name text,
  p_address text default null,
  p_access_code text default null,
  p_notes text default null,
  p_active boolean default true,
  p_kind text default null,
  p_length_cm numeric default null,
  p_width_cm numeric default null,
  p_height_cm numeric default null,
  p_weight_kg numeric default null
)
returns storage_containers
language plpgsql
security definer
set search_path = public
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
    if coalesce(p_kind, 'conex') = 'building'
       and exists (select 1 from storage_containers where kind = 'building') then
      raise exception 'there is already a building — the main warehouse is one of a kind';
    end if;
    insert into storage_containers
      (name, address, access_code, notes, active, kind,
       length_cm, width_cm, height_cm, weight_kg)
    values
      (trim(p_name), p_address, p_access_code, p_notes, coalesce(p_active, true),
       coalesce(p_kind, 'conex'),
       p_length_cm, p_width_cm, p_height_cm, p_weight_kg)
    returning * into v_row;
  else
    -- Kind deliberately not updatable; dimensions are (a crate gets measured
    -- when somebody has a tape, not when the row is made).
    update storage_containers
    set name = trim(p_name), address = p_address, access_code = p_access_code,
        notes = p_notes, active = coalesce(p_active, true),
        length_cm = p_length_cm, width_cm = p_width_cm,
        height_cm = p_height_cm, weight_kg = p_weight_kg
    where id = p_id
    returning * into v_row;
    if not found then
      raise exception 'container not found';
    end if;
  end if;
  return v_row;
end;
$$;
