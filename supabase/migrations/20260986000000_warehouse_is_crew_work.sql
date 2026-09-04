-- Warehouse work is crew work (owner call, 2026-09-04 — ADR-0007).
--
-- Every warehouse action in this app used to draw the same line: foreman and
-- up. That line was drawn when the warehouse was one person's job. It isn't:
-- the person at the tailgate at 6am, the person who puts the crate in the
-- conex, and the person who drives to the yard for one more tube of caulk are
-- all installers. Making them wait for a lead to tap a button is how material
-- ends up untracked — the rule stopped protecting anything and started
-- costing the record.
--
-- So the floor drops to "any crew member" for the ordinary warehouse actions,
-- and stays where it is for exactly two kinds of door:
--
--   Destructive (foreman+, untouched here): burn_packages, delete_packages,
--   delete_delivery. These END things — a burned label, a deleted package, a
--   deleted truck. Nothing about opening putaway argues for opening those.
--
--   Scheduling and settings (supervisor+, untouched here): schedule_delivery,
--   save_checkout_reason. Putting a truck on the company calendar and editing
--   the company's reason list are office decisions, not warehouse work.
--
-- WHAT CHANGED IN EACH FUNCTION BELOW: the rank check, and nothing else.
-- Every one is rebuilt IN FULL from its CURRENT definition (the latest
-- migration that defines it, named above each block), with the rank check
-- replaced by the two questions that still matter — are you signed in, and
-- are you a builder login. Every validation, every refusal, every movement
-- line and every message is byte-for-byte what it was.
--
-- THE PARTNER WALL IS THE REASON THE PARTNER LINE IS NEW, NOT MISSING BEFORE.
-- A builder login (wave S, 20260950000000) carries `role = 'installer'` — the
-- rank floor — with `is_partner` telling it apart. Until today, the foreman+
-- rank check was ALSO what kept partners out of these RPCs. Drop the rank and
-- that protection would leave with it, silently. So every function opened here
-- gains an explicit `is_partner_user()` refusal in the same breath: the wall
-- stands exactly where it stood, on its own legs now instead of leaning on a
-- rank check that no longer exists.
--
-- Deploy order: this migration must land AFTER 20260985000000
-- (clock-crew-in-and-out), which is in flight.


-- ==========================================================================
-- Coming in — stickers and labels
-- ==========================================================================

-- mint_packages — rebuilt from 20260814000000_storage_tracking.sql
create or replace function mint_packages(p_count int)
returns setof packages
language plpgsql
security definer
as $$
declare
  i int;
  v_row packages;
begin
  -- Warehouse work is crew work (ADR-0007, owner call 2026-09-04). The rank
  -- check that stood here is gone; signed in, and not a builder login, is
  -- the whole door now. Every other line of this function is byte-for-byte
  -- what it was.
  if auth.uid() is null then
    raise exception 'sign in first';
  end if;
  if public.is_partner_user() then
    raise exception 'Only a crew member can do warehouse work.'
      using errcode = '42501';
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

-- mint_mark_packages — rebuilt from 20260906000000_minted_packages.sql
create or replace function mint_mark_packages(
  p_project uuid,
  p_mark text,
  p_total int,
  p_category text default 'windows'
)
returns setof packages
language plpgsql
security definer
set search_path = public
as $$
declare
  v_mark uuid;
  v_mark_code text;
  v_existing_total int;
  v_have int[];
  i int;
  v_row packages;
begin
  -- Warehouse work is crew work (ADR-0007, owner call 2026-09-04). The rank
  -- check that stood here is gone; signed in, and not a builder login, is
  -- the whole door now. Every other line of this function is byte-for-byte
  -- what it was.
  if auth.uid() is null then
    raise exception 'sign in first';
  end if;
  if public.is_partner_user() then
    raise exception 'Only a crew member can do warehouse work.'
      using errcode = '42501';
  end if;
  if p_total is null or p_total < 1 or p_total > 20 then
    raise exception 'a window arrives as 1 to 20 packages';
  end if;

  v_mark_code := upper(trim(coalesce(p_mark, '')));
  select id into v_mark
  from project_marks
  where project_id = p_project and mark_code = v_mark_code;
  if v_mark is null then
    raise exception 'mark % is not on this job''s schedule', v_mark_code;
  end if;

  -- Every package already carrying this mark, whatever its stage. A label
  -- that disagrees about the total is a contradiction, not a top-up.
  select array_agg(distinct p.part_index) filter (where p.part_index is not null),
         max(p.part_total)
    into v_have, v_existing_total
  from packages p
  join package_marks pm on pm.package_id = p.id
  where pm.mark_id = v_mark;

  if v_existing_total is not null and v_existing_total <> p_total then
    raise exception
      'window % already has labels saying "of %" — burn those first if the count is really %',
      v_mark_code, v_existing_total, p_total;
  end if;

  for i in 1..p_total loop
    if v_have is not null and i = any(v_have) then
      continue; -- that part slot already has its label
    end if;
    insert into packages
      (status, project_id, category, part_index, part_total,
       short_code, bound_at, bound_by)
    values
      ('minted', p_project, p_category, i, p_total,
       issue_package_short_code(), now(), auth.uid()::text)
    returning * into v_row;

    insert into package_marks (package_id, mark_id)
    values (v_row.id, v_mark)
    on conflict do nothing;

    -- 'preissued' is already in movements_event_ck — the unit chain put it
    -- there, and this is its idea living on. The constraint stays untouched.
    insert into movements (package_id, event, project_id, actor, reason)
    values (v_row.id, 'preissued', p_project, auth.uid()::text,
            'label minted — part ' || i || ' of ' || p_total);

    return next v_row;
  end loop;
  return;
end;
$$;

-- add_project_mark — rebuilt from 20260913000000_add_project_mark.sql
-- Not on the original inventory, and it has to be here: the tag screen's
-- "Add window N to the schedule" button — opened to every crew member in
-- this same wave — is this RPC. Leaving it foreman+ would put a live
-- button in front of an installer that answers with a refusal.
create or replace function add_project_mark(p_project uuid, p_mark text)
returns project_marks
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text;
  v_row project_marks;
begin
  -- Warehouse work is crew work (ADR-0007, owner call 2026-09-04). The rank
  -- check that stood here is gone; signed in, and not a builder login, is
  -- the whole door now. Every other line of this function is byte-for-byte
  -- what it was.
  if auth.uid() is null then
    raise exception 'sign in first';
  end if;
  if public.is_partner_user() then
    raise exception 'Only a crew member can do warehouse work.'
      using errcode = '42501';
  end if;
  if not exists (select 1 from projects where id = p_project) then
    raise exception 'job not found';
  end if;
  v_code := upper(trim(coalesce(p_mark, '')));
  if v_code = '' or length(v_code) > 12 then
    raise exception 'a window number is 1 to 12 characters';
  end if;

  insert into project_marks (project_id, mark_code)
  values (p_project, v_code)
  on conflict (project_id, mark_code) do nothing;

  select * into v_row
  from project_marks
  where project_id = p_project and mark_code = v_code;
  return v_row;
end;
$$;

-- set_mark_part_total — rebuilt from 20260912000000_set_mark_part_total.sql
create or replace function set_mark_part_total(
  p_project uuid,
  p_mark text,
  p_total int
)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_mark uuid;
  v_mark_code text;
  v_max_index int;
  v_count int;
begin
  -- Warehouse work is crew work (ADR-0007, owner call 2026-09-04). The rank
  -- check that stood here is gone; signed in, and not a builder login, is
  -- the whole door now. Every other line of this function is byte-for-byte
  -- what it was.
  if auth.uid() is null then
    raise exception 'sign in first';
  end if;
  if public.is_partner_user() then
    raise exception 'Only a crew member can do warehouse work.'
      using errcode = '42501';
  end if;
  if p_total is null or p_total < 1 or p_total > 20 then
    raise exception 'a window arrives as 1 to 20 packages';
  end if;

  v_mark_code := upper(trim(coalesce(p_mark, '')));
  select id into v_mark
  from project_marks
  where project_id = p_project and mark_code = v_mark_code;
  if v_mark is null then
    raise exception 'mark % is not on this job''s schedule', v_mark_code;
  end if;

  select max(p.part_index), count(*)
    into v_max_index, v_count
  from packages p
  join package_marks pm on pm.package_id = p.id
  where pm.mark_id = v_mark and p.status <> 'blank';

  if v_count = 0 then
    raise exception 'window % has no packages yet — nothing to renumber', v_mark_code;
  end if;
  -- Shrinking below an existing part number would orphan real paper: a
  -- package printed "4 of 4" cannot live under "of 3".
  if v_max_index is not null and p_total < v_max_index then
    raise exception
      'window % already has a part numbered % — the count cannot be smaller than that',
      v_mark_code, v_max_index;
  end if;

  update packages p
  set part_total = p_total
  from package_marks pm
  where pm.package_id = p.id
    and pm.mark_id = v_mark
    and p.status <> 'blank'
    and p.part_total is distinct from p_total;

  insert into movements (event, project_id, actor, reason)
  values (
    'override', p_project, auth.uid()::text,
    'window ' || v_mark_code || ' package count set to ' || p_total ||
      ' — every part label now reads "of ' || p_total || '"'
  );

  return v_count;
end;
$$;

-- ==========================================================================
-- Put away — containers, areas, windows, jobs
-- ==========================================================================

-- save_storage_container — rebuilt from 20260903000000_container_address_history.sql
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
  v_row storage_containers;
  v_old_address text;
begin
  -- Warehouse work is crew work (ADR-0007, owner call 2026-09-04). The rank
  -- check that stood here is gone; signed in, and not a builder login, is
  -- the whole door now. Every other line of this function is byte-for-byte
  -- what it was.
  if auth.uid() is null then
    raise exception 'sign in first';
  end if;
  if public.is_partner_user() then
    raise exception 'Only a crew member can do warehouse work.'
      using errcode = '42501';
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

-- set_package_area — rebuilt from 20260923030000_package_zones.sql
-- ADR-0006 said "foreman and up set it". ADR-0007 supersedes that one
-- sentence and nothing else in ADR-0006: an area is still a pointer, not a
-- place, still cleared by every move, still no label printed for it.
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
  -- Warehouse work is crew work (ADR-0007, owner call 2026-09-04). The rank
  -- check that stood here is gone; signed in, and not a builder login, is
  -- the whole door now. Every other line of this function is byte-for-byte
  -- what it was.
  if auth.uid() is null then
    raise exception 'sign in first';
  end if;
  if public.is_partner_user() then
    raise exception 'Only a crew member can do warehouse work.'
      using errcode = '42501';
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

-- set_package_window — rebuilt from 20260914000000_set_package_window.sql
create or replace function set_package_window(p_package uuid, p_mark text)
returns packages
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row packages;
  v_mark uuid;
  v_code text;
  v_old text;
begin
  -- Warehouse work is crew work (ADR-0007, owner call 2026-09-04). The rank
  -- check that stood here is gone; signed in, and not a builder login, is
  -- the whole door now. Every other line of this function is byte-for-byte
  -- what it was.
  if auth.uid() is null then
    raise exception 'sign in first';
  end if;
  if public.is_partner_user() then
    raise exception 'Only a crew member can do warehouse work.'
      using errcode = '42501';
  end if;

  select p.* into v_row from packages p where p.id = p_package;
  if not found then
    raise exception 'package not found';
  end if;
  if v_row.status = 'blank' then
    raise exception 'that sticker is not on a package yet — tag it first';
  end if;
  if v_row.project_id is null then
    raise exception 'Boneyard stock has no window — assign it to a job first';
  end if;

  v_code := upper(trim(coalesce(p_mark, '')));
  select id into v_mark
  from project_marks
  where project_id = v_row.project_id and mark_code = v_code;
  if v_mark is null then
    raise exception 'mark % is not on this job''s schedule', v_code;
  end if;

  select string_agg(pm2.mark_code, ', ') into v_old
  from package_marks pm
  join project_marks pm2 on pm2.id = pm.mark_id
  where pm.package_id = p_package;

  delete from package_marks where package_id = p_package;
  insert into package_marks (package_id, mark_id)
  values (p_package, v_mark)
  on conflict do nothing;

  insert into movements (package_id, event, project_id, actor, reason)
  values (
    p_package, 'assigned', v_row.project_id, auth.uid()::text,
    case
      when v_old is null then 'window set to ' || v_code || ' — tagged without one'
      else 'window changed: ' || v_old || ' → ' || v_code
    end
  );

  return v_row;
end;
$$;

-- assign_package_to_job — rebuilt from 20260929000000_assign_clears_pending.sql
-- CONTEXT.md called this "the foreman-and-up action"; ADR-0007 makes it
-- any crew member's. The refusals it already carries do the real work —
-- only Boneyard stock can be assigned, and only to a window on that job's
-- schedule.
create or replace function assign_package_to_job(
  p_package uuid,
  p_project uuid,
  p_mark text
)
returns packages
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row packages;
  v_mark uuid;
  v_mark_code text;
  v_job text;
  v_issue uuid;
begin
  -- Warehouse work is crew work (ADR-0007, owner call 2026-09-04). The rank
  -- check that stood here is gone; signed in, and not a builder login, is
  -- the whole door now. Every other line of this function is byte-for-byte
  -- what it was.
  if auth.uid() is null then
    raise exception 'sign in first';
  end if;
  if public.is_partner_user() then
    raise exception 'Only a crew member can do warehouse work.'
      using errcode = '42501';
  end if;
  if p_project is null then
    raise exception 'pick the job this package is going on';
  end if;

  select p.* into v_row from packages p where p.id = p_package;
  if not found then
    raise exception 'package not found';
  end if;
  if v_row.status = 'blank' then
    raise exception 'that sticker is not on a package yet — tag it first';
  end if;
  if v_row.project_id is not null then
    raise exception 'this package already belongs to a job — only Boneyard stock can be assigned';
  end if;

  v_issue := v_row.pending_issue_id;

  v_mark_code := upper(trim(coalesce(p_mark, '')));
  if v_mark_code = '' then
    raise exception 'pick the window this package becomes part of';
  end if;
  select id into v_mark
  from project_marks
  where project_id = p_project and mark_code = v_mark_code;
  if v_mark is null then
    raise exception 'mark % is not on this job''s schedule', v_mark_code;
  end if;

  update packages
  set project_id = p_project,
      pending_job_name = null,
      pending_issue_id = null
  where id = p_package
  returning * into v_row;

  insert into package_marks (package_id, mark_id)
  values (p_package, v_mark)
  on conflict do nothing;

  select job_code into v_job from projects where id = p_project;
  insert into movements (package_id, event, project_id, actor, reason)
  values (
    p_package, 'assigned', p_project, auth.uid()::text,
    'assigned from the Boneyard to ' || coalesce(v_job, 'a job') ||
      ' as window ' || v_mark_code
  );

  -- The missing_job issue resolves when its last waiting package files —
  -- byte-for-byte the rule file_pending_packages follows.
  if v_issue is not null and not exists (
    select 1 from packages
    where pending_issue_id = v_issue and project_id is null
  ) then
    update issues
       set status = 'resolved', resolved_by = auth.uid(), resolved_at = now()
     where id = v_issue and status = 'open';
  end if;

  return v_row;
end;
$$;

-- ==========================================================================
-- Supplies and takeoffs
-- ==========================================================================

-- add_supply — rebuilt from 20260829000000_lock_movements_and_supplies.sql
create or replace function add_supply(p_name text, p_unit text default 'ea')
returns supplies
language plpgsql
security definer
as $$
declare
  v_name text := nullif(trim(coalesce(p_name, '')), '');
  v_row supplies;
begin
  -- Warehouse work is crew work (ADR-0007, owner call 2026-09-04). The rank
  -- check that stood here is gone; signed in, and not a builder login, is
  -- the whole door now. Every other line of this function is byte-for-byte
  -- what it was.
  if auth.uid() is null then
    raise exception 'sign in first';
  end if;
  if public.is_partner_user() then
    raise exception 'Only a crew member can do warehouse work.'
      using errcode = '42501';
  end if;
  if v_name is null then
    raise exception 'give the supply a name';
  end if;

  -- Case-insensitive duplicate guard: "Caulk", "caulk" and "CAULK" are one
  -- supply, and a split catalog makes every count on it meaningless.
  select * into v_row from supplies where lower(name) = lower(v_name) limit 1;
  if found then
    return v_row;
  end if;

  insert into supplies (name, unit)
  values (v_name, coalesce(nullif(trim(coalesce(p_unit, '')), ''), 'ea'))
  returning * into v_row;
  return v_row;
end;
$$;

-- set_supply_home — rebuilt from 20260916000000_supply_home_container.sql
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
  v_row supplies;
begin
  -- Warehouse work is crew work (ADR-0007, owner call 2026-09-04). The rank
  -- check that stood here is gone; signed in, and not a builder login, is
  -- the whole door now. Every other line of this function is byte-for-byte
  -- what it was.
  if auth.uid() is null then
    raise exception 'sign in first';
  end if;
  if public.is_partner_user() then
    raise exception 'Only a crew member can do warehouse work.'
      using errcode = '42501';
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

-- create_takeoff — rebuilt from 20260917000000_takeoffs.sql
create or replace function create_takeoff(
  p_project uuid,
  p_for uuid,
  p_items jsonb,
  p_note text default null,
  p_ready boolean default false
)
returns takeoffs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row takeoffs;
  v_item jsonb;
  v_supply uuid;
  v_qty numeric;
  v_count int := 0;
begin
  -- Warehouse work is crew work (ADR-0007, owner call 2026-09-04). The rank
  -- check that stood here is gone; signed in, and not a builder login, is
  -- the whole door now. Every other line of this function is byte-for-byte
  -- what it was.
  if auth.uid() is null then
    raise exception 'sign in first';
  end if;
  if public.is_partner_user() then
    raise exception 'Only a crew member can do warehouse work.'
      using errcode = '42501';
  end if;
  if not exists (select 1 from projects where id = p_project) then
    raise exception 'job not found';
  end if;
  if p_for is not null and not exists (select 1 from profiles where id = p_for) then
    raise exception 'that person is not on the roster';
  end if;

  insert into takeoffs (project_id, for_profile_id, created_by, status, note,
                        ready_at)
  values (
    p_project,
    coalesce(p_for, auth.uid()),
    auth.uid(),
    case when coalesce(p_ready, false) then 'ready' else 'requested' end,
    nullif(trim(coalesce(p_note, '')), ''),
    case when coalesce(p_ready, false) then now() end
  )
  returning * into v_row;

  for v_item in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb))
  loop
    v_supply := (v_item->>'supply_id')::uuid;
    v_qty := (v_item->>'qty')::numeric;
    if v_supply is null or v_qty is null or v_qty <= 0 then
      raise exception 'every line needs a supply and a count above zero';
    end if;
    if not exists (select 1 from supplies where id = v_supply) then
      raise exception 'a line names a supply that is not in the catalog';
    end if;
    insert into takeoff_items (takeoff_id, supply_id, qty)
    values (v_row.id, v_supply, v_qty);
    v_count := v_count + 1;
  end loop;
  if v_count = 0 then
    raise exception 'a takeoff needs at least one line';
  end if;

  return v_row;
end;
$$;

-- acknowledge_takeoff — rebuilt from 20260917000000_takeoffs.sql
create or replace function acknowledge_takeoff(
  p_takeoff uuid,
  p_eta text default null,
  p_eta_note text default null
)
returns takeoffs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row takeoffs;
begin
  -- Warehouse work is crew work (ADR-0007, owner call 2026-09-04). The rank
  -- check that stood here is gone; signed in, and not a builder login, is
  -- the whole door now. Every other line of this function is byte-for-byte
  -- what it was.
  if auth.uid() is null then
    raise exception 'sign in first';
  end if;
  if public.is_partner_user() then
    raise exception 'Only a crew member can do warehouse work.'
      using errcode = '42501';
  end if;
  update takeoffs
  set status = 'acknowledged',
      acknowledged_at = now(),
      eta = p_eta,
      eta_note = nullif(trim(coalesce(p_eta_note, '')), '')
  where id = p_takeoff and status = 'requested'
  returning * into v_row;
  if not found then
    raise exception 'that request is not waiting for an answer';
  end if;
  return v_row;
end;
$$;

-- ready_takeoff — rebuilt from 20260917000000_takeoffs.sql
create or replace function ready_takeoff(p_takeoff uuid)
returns takeoffs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row takeoffs;
begin
  -- Warehouse work is crew work (ADR-0007, owner call 2026-09-04). The rank
  -- check that stood here is gone; signed in, and not a builder login, is
  -- the whole door now. Every other line of this function is byte-for-byte
  -- what it was.
  if auth.uid() is null then
    raise exception 'sign in first';
  end if;
  if public.is_partner_user() then
    raise exception 'Only a crew member can do warehouse work.'
      using errcode = '42501';
  end if;
  update takeoffs
  set status = 'ready', ready_at = now()
  where id = p_takeoff and status in ('requested', 'acknowledged')
  returning * into v_row;
  if not found then
    raise exception 'that takeoff is not in a state that can become ready';
  end if;
  return v_row;
end;
$$;

-- ==========================================================================
-- Deliveries and sets
-- ==========================================================================

-- create_manual_delivery — rebuilt from 20260932000000_crates_are_packages.sql
create or replace function create_manual_delivery(
  p_label text,
  p_entries jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_delivery uuid;
  v_entry jsonb;
  v_set jsonb;
  v_project uuid;
  v_job_name text;
  v_issue uuid;
  v_crate_name text;
  v_created int := 0;
  v_unfiled int := 0;
  v_entry_count int := 0;
  v_set_count int;
  v_n int;
begin
  -- Warehouse work is crew work (ADR-0007, owner call 2026-09-04). The rank
  -- check that stood here is gone; signed in, and not a builder login, is
  -- the whole door now. Every other line of this function is byte-for-byte
  -- what it was.
  if auth.uid() is null then
    raise exception 'sign in first';
  end if;
  if public.is_partner_user() then
    raise exception 'Only a crew member can do warehouse work.'
      using errcode = '42501';
  end if;
  if p_entries is null or jsonb_typeof(p_entries) <> 'array'
     or jsonb_array_length(p_entries) < 1 then
    raise exception 'Log at least one job''s material.';
  end if;
  if jsonb_array_length(p_entries) > 17 then
    raise exception 'A delivery covers at most 17 jobs.';
  end if;

  insert into package_deliveries (label, arrived_on, created_by)
  values (
    coalesce(nullif(trim(p_label), ''), 'Hand-logged delivery'),
    current_date,
    auth.uid()::text
  )
  returning id into v_delivery;

  for v_entry in select * from jsonb_array_elements(p_entries) loop
    v_entry_count := v_entry_count + 1;
    v_project := nullif(v_entry->>'project_id', '')::uuid;
    v_job_name := nullif(trim(coalesce(v_entry->>'job_name', '')), '');
    if v_project is null and v_job_name is null then
      raise exception 'Entry % names no job.', v_entry_count;
    end if;
    if jsonb_typeof(v_entry->'sets') <> 'array'
       or jsonb_array_length(v_entry->'sets') < 1 then
      raise exception 'Job % has no sets.', v_entry_count;
    end if;
    v_set_count := jsonb_array_length(v_entry->'sets');
    if v_set_count > 50 then
      raise exception 'A job takes at most 50 sets in one delivery.';
    end if;

    v_issue := null;
    if v_project is null then
      insert into issues (project_id, kind, urgency, note, created_by)
      values (
        null, 'missing_job', 'normal',
        'Build the job "' || v_job_name || '" — ' || v_set_count ||
        ' set(s) from the delivery "' ||
        coalesce(nullif(trim(p_label), ''), 'Hand-logged delivery') ||
        '" arrived under that name and are waiting to be filed.',
        auth.uid()
      )
      returning id into v_issue;
    end if;

    for v_set in select * from jsonb_array_elements(v_entry->'sets') loop
      v_n := public.create_delivery_set(
        v_delivery, v_project,
        v_set->>'mark',
        coalesce(v_set->>'kind', 'window'),
        (v_set->>'package_count')::int,
        v_set#>>'{crate,name}',
        (v_set#>>'{crate,pieces}')::int,
        v_set#>>'{crate,part_type}',
        coalesce((v_set->>'quantity')::int, 1),
        v_job_name,
        v_issue
      );
      v_created := v_created + v_n;
      if v_project is null then
        v_unfiled := v_unfiled + v_n;
      end if;
    end loop;

    -- One sealed crate per distinct name this entry mentioned.
    for v_crate_name in
      select distinct upper(trim(s#>>'{crate,name}'))
      from jsonb_array_elements(v_entry->'sets') s
      where nullif(trim(coalesce(s#>>'{crate,name}', '')), '') is not null
    loop
      insert into packages
        (status, project_id, category, part_type, mfr_mark,
         pending_job_name, pending_issue_id,
         delivery_id, short_code, bound_at, bound_by)
      values
        ('minted', v_project, 'other', 'crate', v_crate_name,
         case when v_project is null then v_job_name end,
         case when v_project is null then v_issue end,
         v_delivery, issue_package_short_code(), now(), auth.uid()::text);
      v_created := v_created + 1;
      if v_project is null then
        v_unfiled := v_unfiled + 1;
      end if;
    end loop;
  end loop;

  return jsonb_build_object(
    'delivery_id', v_delivery,
    'created', v_created,
    'unfiled', v_unfiled,
    'pending', 0
  );
end;
$$;

-- file_pending_packages — rebuilt from 20260932000000_crates_are_packages.sql
create or replace function file_pending_packages(
  p_package_ids uuid[],
  p_project uuid
)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row packages;
  v_mark uuid;
  v_id uuid;
  v_issue uuid;
  v_count int := 0;
begin
  -- Warehouse work is crew work (ADR-0007, owner call 2026-09-04). The rank
  -- check that stood here is gone; signed in, and not a builder login, is
  -- the whole door now. Every other line of this function is byte-for-byte
  -- what it was.
  if auth.uid() is null then
    raise exception 'sign in first';
  end if;
  if public.is_partner_user() then
    raise exception 'Only a crew member can do warehouse work.'
      using errcode = '42501';
  end if;
  if not exists (select 1 from projects where id = p_project) then
    raise exception 'That job does not exist.';
  end if;

  foreach v_id in array coalesce(p_package_ids, array[]::uuid[])
  loop
    select * into v_row from packages
    where id = v_id and project_id is null and pending_job_name is not null;
    if not found then
      continue;
    end if;

    v_issue := v_row.pending_issue_id;

    update packages
    set project_id = p_project,
        pending_job_name = null,
        pending_issue_id = null
    where id = v_id;

    if v_row.mfr_mark is not null and coalesce(v_row.part_type, '') <> 'crate' then
      insert into project_marks (project_id, mark_code)
      values (p_project, v_row.mfr_mark)
      on conflict (project_id, mark_code) do nothing;
      select id into v_mark from project_marks
      where project_id = p_project and mark_code = v_row.mfr_mark;
      insert into package_marks (package_id, mark_id)
      values (v_id, v_mark) on conflict do nothing;
    end if;

    insert into movements (package_id, event, project_id, actor, reason)
    values (v_id, 'assigned', p_project, auth.uid()::text,
            'filed onto the job — was waiting as "' || v_row.pending_job_name || '"');
    v_count := v_count + 1;

    if v_issue is not null and not exists (
      select 1 from packages
      where pending_issue_id = v_issue and project_id is null
    ) then
      update issues
         set status = 'resolved', resolved_by = auth.uid(), resolved_at = now()
       where id = v_issue and status = 'open';
    end if;
  end loop;

  return v_count;
end;
$$;

-- add_delivery_set — rebuilt from 20260949900000_fix_add_delivery_set_table.sql
-- The wrapper the app actually calls (storage.ts -> "add_delivery_set").
-- 20260938000000 defined it against a table that never existed; this is
-- the 20260949900000 repair, rebuilt. create_delivery_set, the helper it
-- forwards to, has no rank check of its own and needs no edit.
create or replace function add_delivery_set(
  p_delivery uuid,
  p_project uuid,
  p_job_name text,
  p_mark text,
  p_kind text,
  p_package_count int,
  p_crate_name text default null,
  p_crate_pieces int default null,
  p_crate_part_type text default null
)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- Warehouse work is crew work (ADR-0007, owner call 2026-09-04). The rank
  -- check that stood here is gone; signed in, and not a builder login, is
  -- the whole door now. Every other line of this function is byte-for-byte
  -- what it was.
  if auth.uid() is null then
    raise exception 'sign in first';
  end if;
  if public.is_partner_user() then
    raise exception 'Only a crew member can do warehouse work.'
      using errcode = '42501';
  end if;
  if not exists (select 1 from package_deliveries where id = p_delivery) then
    raise exception 'That delivery does not exist.';
  end if;
  if p_kind not in ('window', 'door') then
    raise exception 'A set is a window or a door.';
  end if;

  return public.create_delivery_set(
    p_delivery, p_project, p_mark, p_kind, p_package_count,
    p_crate_name, p_crate_pieces, p_crate_part_type,
    1, p_job_name, null
  );
end;
$$;

-- update_delivery — rebuilt from 20260934000000_delivery_scheduling.sql
create or replace function update_delivery(
  p_delivery uuid,
  p_label text default null,
  p_expected_at timestamptz default null
)
returns package_deliveries
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_row package_deliveries;
begin
  -- Warehouse work is crew work (ADR-0007, owner call 2026-09-04). The rank
  -- check that stood here is gone; signed in, and not a builder login, is
  -- the whole door now. Every other line of this function is byte-for-byte
  -- what it was.
  if auth.uid() is null then
    raise exception 'sign in first';
  end if;
  if public.is_partner_user() then
    raise exception 'Only a crew member can do warehouse work.'
      using errcode = '42501';
  end if;
  update package_deliveries
  set label = coalesce(nullif(trim(coalesce(p_label, '')), ''), label),
      expected_at = coalesce(p_expected_at, expected_at)
  where id = p_delivery
  returning * into v_row;
  if not found then
    raise exception 'That delivery is gone.';
  end if;
  -- The schedule entry follows the truck's new time.
  if p_expected_at is not null then
    update schedule_assignments
    set start_date = p_expected_at::date,
        end_date = p_expected_at::date,
        start_time = p_expected_at::time
    where delivery_id = p_delivery;
  end if;
  return v_row;
end;
$$;

-- rewrite_set — rebuilt from 20260958000000_rewrite_set.sql
-- Safe to open because of what it already refuses: arrived material never
-- dies by arithmetic here. A shrinking line releases only never-arrived
-- placeholders, and a line that would fall below what has already arrived
-- refuses the WHOLE apply. "Start this set over" — the one path that does
-- delete real material — is not this function; it is delete_packages,
-- which stays foreman+ (see the header).
create or replace function public.rewrite_set(
  p_project_id uuid default null,
  p_pending_job_name text default null,
  p_mark text default null,
  p_lines jsonb default '[]'::jsonb,
  p_kind text default 'window'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_mark text := upper(regexp_replace(trim(coalesce(p_mark, '')), '^#', ''));
  v_pending text := nullif(trim(coalesce(p_pending_job_name, '')), '');
  v_category text := case when p_kind = 'door' then 'doors' else 'windows' end;
  v_existing_category text;
  v_project_mark uuid;
  v_removed_count int;
  v_candidate_count int;
  v_removed_part_type text;
  v_removed_packaging text;
  v_removed_arrived int;
  v_refit_from_type text;
  v_refit_from_packaging text;
  v_refit_to_type text;
  v_refit_to_packaging text;
  v_parts text;
  v_row record;
  v_key_type text;
  v_key_packaging text;
  v_old_arrived int;
  v_old_expected int;
  v_old_arrived_ids uuid[];
  v_old_expected_ids uuid[];
  v_target_count int;
  v_target_expected int;
  v_mint int;
  v_release int;
  v_minted int := 0;
  v_deleted int := 0;
  v_delivery uuid;
begin
  -- Warehouse work is crew work (ADR-0007, owner call 2026-09-04). The rank
  -- check that stood here is gone; signed in, and not a builder login, is
  -- the whole door now. Every other line of this function is byte-for-byte
  -- what it was.
  if auth.uid() is null then
    raise exception 'sign in first';
  end if;
  if public.is_partner_user() then
    raise exception 'Only a crew member can do warehouse work.'
      using errcode = '42501';
  end if;

  if (p_project_id is null) = (v_pending is null) then
    raise exception 'That set does not exist.';
  end if;
  if p_project_id is not null and not exists (select 1 from projects where id = p_project_id) then
    raise exception 'That set does not exist.';
  end if;
  if length(v_mark) < 1 then
    raise exception 'That set does not exist.';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then
    raise exception 'That set does not exist.';
  end if;
  if jsonb_array_length(p_lines) > 12 then
    raise exception 'A set holds at most 12 lines — split it if it needs more.';
  end if;

  -- Register the mark on the job's schedule (create_delivery_set's own
  -- precedent) — a real job's mark may not be on it yet: the whole point of
  -- this screen is fixing material that never matched the manifest.
  if p_project_id is not null then
    insert into project_marks (project_id, mark_code)
    values (p_project_id, v_mark)
    on conflict (project_id, mark_code) do nothing;
    select id into v_project_mark from project_marks
    where project_id = p_project_id and mark_code = v_mark;
  end if;

  -- ---------------------------------------------------- normalize the ask

  drop table if exists _rw_new;
  create temp table _rw_new (
    part_type text not null default '',
    packaging text not null,
    count int not null
  ) on commit drop;

  insert into _rw_new (part_type, packaging, count)
  select coalesce(nullif(trim(lower(x.part_type)), ''), ''), x.packaging, sum(x.count)::int
  from jsonb_to_recordset(p_lines) as x(part_type text, packaging text, count int)
  where x.packaging in ('package', 'crate_pool') and x.count is not null and x.count > 0
  group by 1, 2;

  if exists (select 1 from _rw_new where packaging = 'package' and count > 20) then
    raise exception 'A line of packages holds at most 20.';
  end if;
  if exists (select 1 from _rw_new where packaging = 'crate_pool' and count > 99) then
    raise exception 'A line of pieces in a crate holds at most 99.';
  end if;

  -- ---------------------------------------------------- current reality

  drop table if exists _rw_old;
  create temp table _rw_old (
    part_type text not null default '',
    packaging text not null,
    arrived int not null default 0,
    expected int not null default 0,
    arrived_ids uuid[] not null default array[]::uuid[],
    expected_ids uuid[] not null default array[]::uuid[]
  ) on commit drop;

  insert into _rw_old (part_type, packaging, arrived, expected, arrived_ids, expected_ids)
  with scope as (
    select p.*
    from packages p
    where coalesce(p.part_type, '') <> 'crate'
      and (
        (p_project_id is not null and p.project_id = p_project_id and exists (
          select 1 from package_marks pm
          join project_marks pmk on pmk.id = pm.mark_id
          where pm.package_id = p.id and pmk.mark_code = v_mark
        ))
        or
        (v_pending is not null and p.project_id is null
           and p.pending_job_name = v_pending and p.mfr_mark = v_mark)
      )
  )
  select coalesce(nullif(trim(lower(part_type)), ''), ''),
         'package',
         coalesce(count(*) filter (where status in ('received', 'stored', 'checked_out')), 0)::int,
         coalesce(count(*) filter (where status = 'minted'), 0)::int,
         coalesce(array_agg(id order by part_index nulls last) filter (where status in ('received', 'stored', 'checked_out')), array[]::uuid[]),
         coalesce(array_agg(id order by part_index nulls last) filter (where status = 'minted'), array[]::uuid[])
  from scope where piece_count is null
  group by 1
  union all
  select coalesce(nullif(trim(lower(part_type)), ''), ''),
         'crate_pool',
         coalesce(sum(piece_count) filter (where status in ('received', 'stored', 'checked_out')), 0)::int,
         coalesce(sum(piece_count) filter (where status = 'minted'), 0)::int,
         coalesce(array_agg(id) filter (where status in ('received', 'stored', 'checked_out')), array[]::uuid[]),
         coalesce(array_agg(id) filter (where status = 'minted'), array[]::uuid[])
  from scope where piece_count is not null
  group by 1;

  select category into v_existing_category from packages p
  where coalesce(p.part_type, '') <> 'crate' and p.category is not null
    and (
      (p_project_id is not null and p.project_id = p_project_id and exists (
        select 1 from package_marks pm join project_marks pmk on pmk.id = pm.mark_id
        where pm.package_id = p.id and pmk.mark_code = v_mark
      ))
      or
      (v_pending is not null and p.project_id is null
         and p.pending_job_name = v_pending and p.mfr_mark = v_mark)
    )
  limit 1;
  if v_existing_category is not null then
    v_category := v_existing_category;
  end if;

  -- The tailgate lists a delivery's packages by delivery_id, and the whole
  -- point of this screen is fixing a set WHILE unloading — so replacements
  -- minted here inherit the delivery the set's existing packages rode in on
  -- (latest first when a set somehow spans two trucks). Captured BEFORE the
  -- apply loop deletes anything. Declaring from scratch has no truck to
  -- inherit; those mint delivery-less, same as the ledger's own additions.
  select p.delivery_id into v_delivery from packages p
  where p.delivery_id is not null
    and coalesce(p.part_type, '') <> 'crate'
    and (
      (p_project_id is not null and p.project_id = p_project_id and exists (
        select 1 from package_marks pm join project_marks pmk on pmk.id = pm.mark_id
        where pm.package_id = p.id and pmk.mark_code = v_mark
      ))
      or
      (v_pending is not null and p.project_id is null
         and p.pending_job_name = v_pending and p.mfr_mark = v_mark)
    )
  order by p.bound_at desc nulls last
  limit 1;

  -- --------------------------------------- ambiguity / re-fit resolution
  -- A "removed" line: an old group with arrived material whose (type,
  -- packaging) is absent from the new declaration entirely — the line
  -- vanished, not merely shrank. Re-fit is allowed ONLY when exactly one
  -- such line exists and exactly one brand-new line (same packaging) can
  -- hold its arrived count; anything less clear-cut refuses rather than
  -- guess with real material.

  drop table if exists _rw_removed;
  create temp table _rw_removed on commit drop as
  select o.* from _rw_old o
  left join _rw_new n on n.part_type = o.part_type and n.packaging = o.packaging
  where n.part_type is null and o.arrived > 0;

  drop table if exists _rw_new_only;
  create temp table _rw_new_only on commit drop as
  select n.* from _rw_new n
  left join _rw_old o on o.part_type = n.part_type and o.packaging = n.packaging
  where o.part_type is null;

  select count(*) into v_removed_count from _rw_removed;

  if v_removed_count = 1 then
    select part_type, packaging, arrived into v_removed_part_type, v_removed_packaging, v_removed_arrived
    from _rw_removed;
    select count(*) into v_candidate_count from _rw_new_only
    where packaging = v_removed_packaging and count >= v_removed_arrived;
  else
    v_candidate_count := null;
  end if;

  if v_removed_count = 1 and v_candidate_count = 1 then
    select v_removed_part_type, v_removed_packaging, part_type, packaging
      into v_refit_from_type, v_refit_from_packaging, v_refit_to_type, v_refit_to_packaging
    from _rw_new_only
    where packaging = v_removed_packaging and count >= v_removed_arrived;
  elsif v_removed_count > 0 then
    select string_agg(
      arrived || ' ' || coalesce(nullif(part_type, ''), 'untyped') || ' ' ||
      (case when packaging = 'crate_pool' then 'piece' else 'package' end) ||
      (case when arrived = 1 then '' else 's' end),
      ', ' order by part_type
    ) into v_parts
    from _rw_removed;
    raise exception '%', 'Some arrived material doesn''t clearly fit the new plan: ' || v_parts ||
      '. Retype it one at a time first.';
  end if;

  -- ------------------------------------------------------- apply, per line

  for v_row in
    select part_type, packaging from _rw_old
    union
    select part_type, packaging from _rw_new
  loop
    v_key_type := v_row.part_type;
    v_key_packaging := v_row.packaging;

    select coalesce(arrived, 0), coalesce(expected, 0),
           coalesce(arrived_ids, array[]::uuid[]), coalesce(expected_ids, array[]::uuid[])
      into v_old_arrived, v_old_expected, v_old_arrived_ids, v_old_expected_ids
    from _rw_old where part_type = v_key_type and packaging = v_key_packaging;
    v_old_arrived := coalesce(v_old_arrived, 0);
    v_old_expected := coalesce(v_old_expected, 0);
    v_old_arrived_ids := coalesce(v_old_arrived_ids, array[]::uuid[]);
    v_old_expected_ids := coalesce(v_old_expected_ids, array[]::uuid[]);

    if v_refit_from_type is not null
       and v_key_type = v_refit_from_type and v_key_packaging = v_refit_from_packaging then
      -- This line's arrived material moved on; only its never-arrived
      -- placeholders remain, and those are simply released below.
      v_old_arrived := 0;
      v_old_arrived_ids := array[]::uuid[];
    elsif v_refit_to_type is not null
       and v_key_type = v_refit_to_type and v_key_packaging = v_refit_to_packaging then
      declare
        v_src_arrived int;
        v_src_ids uuid[];
      begin
        select coalesce(arrived, 0), coalesce(arrived_ids, array[]::uuid[])
          into v_src_arrived, v_src_ids
        from _rw_old where part_type = v_refit_from_type and packaging = v_refit_from_packaging;
        v_old_arrived := v_old_arrived + coalesce(v_src_arrived, 0);
        v_old_arrived_ids := v_old_arrived_ids || coalesce(v_src_ids, array[]::uuid[]);
      end;
    end if;

    select count into v_target_count from _rw_new
    where part_type = v_key_type and packaging = v_key_packaging;
    v_target_count := coalesce(v_target_count, 0);

    if v_target_count < v_old_arrived then
      raise exception '%',
        v_old_arrived::text || ' ' || coalesce(nullif(v_key_type, ''), 'untyped') ||
        (case when v_key_packaging = 'crate_pool'
              then ' piece' || (case when v_old_arrived = 1 then '' else 's' end)
              else '' end) ||
        ' already arrived — the new plan only holds ' || v_target_count::text ||
        '. Un-arrive or delete pieces first, so nothing real disappears.';
    end if;

    if v_target_count = 0 and v_old_arrived = 0 and v_old_expected = 0 then
      continue; -- nothing here at all — not a line, before or after
    end if;

    v_target_expected := v_target_count - v_old_arrived;
    v_mint := greatest(0, v_target_expected - v_old_expected);
    v_release := greatest(0, v_old_expected - v_target_expected);

    if v_key_packaging = 'package' then
      declare
        v_release_ids uuid[];
        v_keep_expected_ids uuid[];
        v_new_minted_ids uuid[] := array[]::uuid[];
        v_final_ids uuid[];
        v_idx int;
        v_mint_i int;
        v_id uuid;
        v_len int := coalesce(array_length(v_old_expected_ids, 1), 0);
      begin
        if v_release > 0 then
          v_release_ids := v_old_expected_ids[(v_len - v_release + 1):v_len];
          v_keep_expected_ids := v_old_expected_ids[1:(v_len - v_release)];
        else
          v_release_ids := array[]::uuid[];
          v_keep_expected_ids := v_old_expected_ids;
        end if;

        if coalesce(array_length(v_release_ids, 1), 0) > 0 then
          delete from packages where id = any (v_release_ids);
          v_deleted := v_deleted + array_length(v_release_ids, 1);
        end if;

        if v_mint > 0 then
          for v_mint_i in 1..v_mint loop
            insert into packages
              (status, project_id, category, part_type, pending_job_name,
               short_code, bound_at, bound_by, mfr_mark, delivery_id)
            values
              ('minted', p_project_id, v_category, nullif(v_key_type, ''),
               case when p_project_id is null then v_pending end,
               issue_package_short_code(), now(), auth.uid()::text, v_mark, v_delivery)
            returning id into v_id;
            v_new_minted_ids := v_new_minted_ids || v_id;
            if p_project_id is not null then
              insert into package_marks (package_id, mark_id)
              values (v_id, v_project_mark) on conflict do nothing;
            end if;
            insert into movements (package_id, event, project_id, actor, reason)
            values (v_id, 'preissued', p_project_id, auth.uid()::text,
                    'rewrite: mark #' || v_mark || ' declared to hold ' || v_target_count::text ||
                    ' ' || coalesce(nullif(v_key_type, ''), 'untyped'));
          end loop;
          v_minted := v_minted + v_mint;
        end if;

        v_final_ids := v_old_arrived_ids || v_keep_expected_ids || v_new_minted_ids;
        v_idx := 0;
        foreach v_id in array v_final_ids loop
          v_idx := v_idx + 1;
          update packages
          set part_index = v_idx, part_total = v_target_count, part_type = nullif(v_key_type, '')
          where id = v_id;
        end loop;
      end;
    else -- crate_pool
      declare
        v_id uuid;
      begin
        if coalesce(array_length(v_old_expected_ids, 1), 0) > 0 then
          delete from packages where id = any (v_old_expected_ids);
          v_deleted := v_deleted + array_length(v_old_expected_ids, 1);
        end if;

        if v_target_expected > 0 then
          insert into packages
            (status, project_id, category, part_type, piece_count, mfr_mark,
             pending_job_name, short_code, bound_at, bound_by, delivery_id)
          values
            ('minted', p_project_id, v_category, nullif(v_key_type, ''), v_target_expected, v_mark,
             case when p_project_id is null then v_pending end,
             issue_package_short_code(), now(), auth.uid()::text, v_delivery)
          returning id into v_id;
          if p_project_id is not null then
            insert into package_marks (package_id, mark_id)
            values (v_id, v_project_mark) on conflict do nothing;
          end if;
          insert into movements (package_id, event, project_id, actor, reason)
          values (v_id, 'preissued', p_project_id, auth.uid()::text,
                  'rewrite: mark #' || v_mark || ' declared to hold ' || v_target_expected::text ||
                  ' piece(s) of ' || coalesce(nullif(v_key_type, ''), 'untyped') || ' in the crates');
          v_minted := v_minted + 1;
        end if;

        if coalesce(array_length(v_old_arrived_ids, 1), 0) > 0 then
          update packages set part_type = nullif(v_key_type, '')
          where id = any (v_old_arrived_ids);
        end if;
      end;
    end if;
  end loop;

  return jsonb_build_object('minted', v_minted, 'deleted', v_deleted);
end;
$$;

-- ==========================================================================
-- Reads: a takeoff is the crew's, not a rank's
-- ==========================================================================
-- The bundle the warehouse builds is FOR somebody, and until now only
-- foreman+ (or the person named on it, or whoever made it) could see one at
-- all. With every crew member able to file a takeoff and answer one, the read
-- policy that hid other people's takeoffs is hiding the shared warehouse
-- inbox from the people now working it. So the rank/ownership filter goes and
-- the wall stays: any signed-in crew member reads takeoffs; a builder login
-- reads none, exactly as before. Rebuilt from their CURRENT definitions —
-- the partner-wall sweep's (20260950000000), not the originals.

drop policy if exists "takeoff_items_read" on takeoff_items;
create policy "takeoff_items_read" on takeoff_items
  for select to authenticated
  using (not public.is_partner_user());

drop policy if exists "takeoffs_read" on takeoffs;
create policy "takeoffs_read" on takeoffs
  for select to authenticated
  using (not public.is_partner_user());


-- ==========================================================================
-- Grants
-- ==========================================================================
-- `create or replace function` keeps a function's existing grants, so these
-- change nothing today. They are re-stated for the three functions whose own
-- migrations state them, so this file stands on its own if it is ever the
-- first place somebody looks.

grant execute on function add_delivery_set(uuid, uuid, text, text, text, int, text, int, text) to authenticated;
grant execute on function update_delivery(uuid, text, timestamptz) to authenticated;
grant execute on function public.rewrite_set(uuid, text, text, jsonb, text) to authenticated;
