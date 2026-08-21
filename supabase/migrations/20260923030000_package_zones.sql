-- Six zones inside a box that travels (owner call, ADR-0006 extended).
--
-- Front/Middle/Back has been the whole answer for a conex since ticket 14 —
-- a compass would lie the day the box gets re-parked facing the other way.
-- The owner still wants finer precision sometimes: each of those three
-- door-relative thirds now also splits left/right, giving nine possible
-- values for anything that moves. The plain three stay valid and stay the
-- primary answer — the extra precision is optional, never forced.
--
-- The building is untouched: it already has the full compass, and nothing
-- here changes what set_package_area allows for it.
alter table packages drop constraint if exists packages_area_ck;
alter table packages add constraint packages_area_ck
  check (area is null or area in (
    'front', 'middle', 'back',
    'front-left', 'front-right', 'middle-left', 'middle-right', 'back-left', 'back-right',
    'north', 'northeast', 'east', 'southeast',
    'south', 'southwest', 'west', 'northwest'
  ));

-- Rebuilt from its current definition (20260904000000_package_areas.sql) to
-- widen the allowed set for anything that isn't the building. Same writer,
-- same rule about who may set one — only what a re-parkable box may answer.
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
      -- three plus their six finer zones (ADR-0006, owner call).
      v_allowed := array['front','middle','back',
                         'front-left','front-right','middle-left','middle-right',
                         'back-left','back-right'];
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
