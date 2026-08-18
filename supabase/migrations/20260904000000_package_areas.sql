-- Ticket 14: where in the box — areas (ADR-0006).
--
-- Slots are parked until the physical reorganization, but "it's in Conex 7"
-- is still a five-minute hunt inside a forty-foot box. An area is the rough
-- answer: Front / Middle / Back inside anything that moves (a conex has a
-- door end, and the door end is the front wherever it is parked), the compass
-- plus Middle only inside the building, which never moves. Foreman and up set
-- it; it is a pointer, not a place — nothing points at it, no label prints
-- for it, and no movement row is written when it changes, because pointing is
-- not moving.
--
-- The column takes the superset; which options a given package may use is
-- decided by set_package_area against the kind of the box it is actually in.
alter table packages add column if not exists area text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'packages_area_ck') then
    alter table packages add constraint packages_area_ck
      check (area is null or area in (
        'front', 'middle', 'back',
        'north', 'northeast', 'east', 'southeast',
        'south', 'southwest', 'west', 'northwest'
      ));
  end if;
end;
$$;

-- Every move clears it — as a TRIGGER, not as edits to the four functions
-- that move packages. Copying four function bodies to add one line is the
-- stale-copy risk that has already broken production here once; the trigger
-- covers every writer there will ever be, in the same statement as the move
-- itself. It fires only when the placement actually changes, so the
-- idempotent no-op branches (a resent check-in that skips its UPDATE) and a
-- plain area set (which changes no placement) never touch it. A container
-- being moved does not fire it either — an area is relative to the box, and
-- the package in the front of Conex 7 is still in the front when the conex
-- arrives at the job (deliberate deviation from the ticket text, corrected in
-- the same PR).
create or replace function packages_clear_area_on_move()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.container_id is distinct from old.container_id
     or new.location_id is distinct from old.location_id then
    new.area := null;
  end if;
  return new;
end;
$$;

drop trigger if exists packages_clear_area_on_move on packages;
create trigger packages_clear_area_on_move
  before update of container_id, location_id on packages
  for each row execute function packages_clear_area_on_move();

-- The one writer. Foreman+, and the options come from the kind of the box the
-- package is in RIGHT NOW — the same check the app makes, enforced where it
-- cannot be skipped.
create or replace function set_package_area(p_package uuid, p_area text)
returns packages
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row packages;
  v_kind text;
  v_allowed text[];
begin
  if not public.is_foreman_plus(auth.uid()) then
    raise exception 'only a foreman-level user or above can set areas';
  end if;

  select p.* into v_row from packages p where p.id = p_package;
  if not found then
    raise exception 'package not found';
  end if;

  if p_area is not null then
    if v_row.container_id is null then
      raise exception 'put it in a box first — an area is where inside the box it sits';
    end if;
    select kind into v_kind from storage_containers where id = v_row.container_id;
    if coalesce(v_kind, 'conex') = 'building' then
      v_allowed := array['north','northeast','east','southeast',
                         'south','southwest','west','northwest','middle'];
    else
      -- Anything that moves: the compass would lie the day the box is
      -- re-parked facing the other way, so it only gets the door-relative
      -- three (ADR-0006).
      v_allowed := array['front','middle','back'];
    end if;
    if not (p_area = any(v_allowed)) then
      raise exception 'that area does not fit this kind of box';
    end if;
  end if;

  update packages set area = p_area where id = p_package
  returning * into v_row;
  return v_row;
end;
$$;
