-- Ticket 13: where a container has been is history, not an edit.
--
-- move_container has written a movement line since 20260825 — nesting and slot
-- changes leave a trail. The hole was the ADDRESS: the owner's conexes really
-- do travel between the yard and job sites, the address field is how that is
-- recorded day to day, and save_storage_container silently overwrote it. That
-- answers "where is Conex 7" and destroys "where was it last Tuesday" — the
-- question that matters the first time material goes missing between two
-- yards.
--
-- An address change now writes a movement row: event 'moved', with the reason
-- carrying the from -> to in words. 'moved' is reused ON PURPOSE — adding a
-- new event value means rebuilding movements_event_ck, and rebuilding that
-- constraint from a stale list has already broken production once
-- (see app/src/lib/warehouse/movementEvents.test.ts). The reason line is what
-- a person reads anyway.
--
-- The building gets the same treatment, deliberately: it never physically
-- moves, but its address can be CORRECTED (it was seeded without one), and a
-- correction that leaves a visible line is honest where a silent edit is not.
-- The trail will read "address set: (none) -> 400 S Industrial", which is
-- exactly what happened.
--
-- Rebuilt from the CURRENT definition in 20260902000000 (kinds), never an
-- older one.
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
  v_old_address text;
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
    select address into v_old_address from storage_containers where id = p_id;
    if not found then
      raise exception 'container not found';
    end if;

    update storage_containers
    set name = trim(p_name), address = p_address, access_code = p_access_code,
        notes = p_notes, active = coalesce(p_active, true),
        length_cm = p_length_cm, width_cm = p_width_cm,
        height_cm = p_height_cm, weight_kg = p_weight_kg
    where id = p_id
    returning * into v_row;

    -- The trail. Whitespace-insensitive so a stray space is not a "move", and
    -- written AFTER the update so a failed update writes no phantom line.
    if nullif(trim(coalesce(v_old_address, '')), '')
       is distinct from nullif(trim(coalesce(p_address, '')), '') then
      insert into movements (container_id, event, actor, reason)
      values (
        p_id,
        'moved',
        auth.uid()::text,
        case
          when nullif(trim(coalesce(v_old_address, '')), '') is null
            then 'address set: ' || trim(p_address)
          when nullif(trim(coalesce(p_address, '')), '') is null
            then 'address cleared — was ' || trim(v_old_address)
          else 'address changed: ' || trim(v_old_address) || ' → ' || trim(p_address)
        end
      );
    end if;
  end if;
  return v_row;
end;
$$;
