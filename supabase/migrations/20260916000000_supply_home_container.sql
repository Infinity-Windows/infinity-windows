-- A supply's home becomes a real place (owner ask, 2026-08-18): a crate, a
-- conex, or the warehouse — the same containers packages live in, findable
-- the same way. Slots stay parked (ADR-0006's reasoning applies to supplies
-- exactly as it does to packages); the rough answer now is the BOX, plus a
-- free-text note for the part a box cannot say ("north wall, blue bins").
--
-- home_location_id stays for the day slots wake. The one-home rule is not
-- constrained container-XOR-location yet, deliberately: the location column
-- is dormant, and a constraint against a sleeping column is a tripwire for
-- the migration that wakes it.
alter table supplies
  add column if not exists home_container_id uuid
    references storage_containers (id) on delete set null,
  add column if not exists home_note text;

-- Same one-signature rule the boneyard hotfix (20260910) taught: the old
-- 2-arg set_supply_home is DROPPED and the new one carries every parameter
-- with defaults, so a stale bundle's (p_supply, p_location) call resolves
-- here through the defaults instead of hitting an ambiguous overload.
drop function if exists set_supply_home(uuid, uuid);
create or replace function set_supply_home(
  p_supply uuid,
  p_location uuid default null,
  p_container uuid default null,
  p_note text default null
)
returns supplies
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text;
  v_row supplies;
begin
  select role into v_role from profiles where id = auth.uid();
  if v_role is null or v_role = 'installer' then
    raise exception 'only a foreman-level user or above can set home spots';
  end if;
  if p_container is not null
     and not exists (select 1 from storage_containers where id = p_container and active) then
    raise exception 'that container is not on the list (or is archived)';
  end if;

  update supplies
  set home_location_id = p_location,
      home_container_id = p_container,
      home_note = nullif(trim(coalesce(p_note, '')), '')
  where id = p_supply
  returning * into v_row;
  if not found then
    raise exception 'that supply is not in the catalog';
  end if;
  return v_row;
end;
$$;
