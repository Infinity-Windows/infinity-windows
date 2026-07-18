-- Phase 3: warehouse load-out -> jobsite unload + condition report + reorder rollup.
--
-- This is the warehouse-to-jobsite leg of the tracking chain:
--   * load_units: batch-select a project's in-warehouse (or staged) units and
--     LOAD them for a run ('loaded' / on the truck), one 'loaded' movement each.
--   * unload_units: at the jobsite, confirm arrival with a per-unit condition
--     report — good units go 'staged' (on site, ready to install); damaged units
--     go 'damaged' + a deduped 'damage' issue ('damaged in transit/unload').
--   * list_reorder_needs: a foreman+/office rollup of shortfalls per window type
--     (still-missing deliveries + damaged units) so reorders happen fast.
--
-- All three RPCs are guarded foreman+ (a plain installer, or a missing/unknown
-- profile, is rejected), matching the Phase 1/2 pattern.

-- Allow logging the jobsite unload event in the append-only movement log.
-- Recreate the constraint with the full set (existing set + unloaded).
alter table movements drop constraint if exists movements_event_check;
alter table movements add constraint movements_event_check
  check (event in (
    'received','putaway','moved','staged','loaded','installed','damaged',
    'count_verified','count_missing','override','assigned','uninstalled',
    'preissued','unloaded'
  ));

-- Batch load-out: move a set of the project's units onto the truck. Batch
-- version of load_window. For each id that belongs to the project AND is
-- currently 'in_warehouse' or 'staged', set status 'loaded', clear its slot, and
-- log a 'loaded' movement. Ineligible ids (wrong job / already loaded / gone) are
-- silently skipped; only the units actually loaded are returned. Foreman+ only.
create or replace function load_units(
  p_window_ids uuid[],
  p_project_id uuid,
  p_actor text default null
)
returns setof windows
language plpgsql
security definer
as $$
declare
  v_role text;
  v_id uuid;
  v_from uuid;
  v_window windows;
begin
  select role into v_role from profiles where id = auth.uid();
  if v_role is null or v_role = 'installer' then
    raise exception 'only a foreman-level user or above can load units for a run';
  end if;

  foreach v_id in array coalesce(p_window_ids, array[]::uuid[])
  loop
    -- Only load a unit that belongs to this job and is warehouse-ready.
    select location_id into v_from
    from windows
    where id = v_id
      and project_id = p_project_id
      and status in ('in_warehouse', 'staged');
    if not found then
      continue;
    end if;

    update windows
    set status = 'loaded', location_id = null
    where id = v_id
    returning * into v_window;

    insert into movements (window_id, event, from_location_id, project_id, actor)
    values (v_id, 'loaded', v_from, p_project_id, coalesce(p_actor, auth.uid()::text));

    return next v_window;
  end loop;

  return;
end;
$$;

-- Jobsite unload + condition report. p_ok_ids are units that arrived fine;
-- p_damaged_ids arrived broken. For each currently-'loaded' unit of this job:
--   * OK  -> status 'staged' (on site, ready to install), 'unloaded' movement
--            (p_location_note folded into the reason).
--   * bad -> status 'damaged', 'unloaded' movement, and a deduped unit-level
--            'damage' issue ('damaged in transit/unload', urgent).
-- Ineligible ids are skipped. Returns { unloaded, damaged } counts. Foreman+ only.
create or replace function unload_units(
  p_ok_ids uuid[],
  p_damaged_ids uuid[],
  p_project_id uuid,
  p_location_note text default null,
  p_actor text default null
)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_role text;
  v_id uuid;
  v_actor text;
  v_note text;
  v_unloaded int := 0;
  v_damaged int := 0;
begin
  select role into v_role from profiles where id = auth.uid();
  if v_role is null or v_role = 'installer' then
    raise exception 'only a foreman-level user or above can unload a run';
  end if;

  v_actor := coalesce(p_actor, auth.uid()::text);
  v_note := nullif(trim(coalesce(p_location_note, '')), '');

  -- Good units: unloaded on site, ready to install.
  foreach v_id in array coalesce(p_ok_ids, array[]::uuid[])
  loop
    update windows
    set status = 'staged'
    where id = v_id and project_id = p_project_id and status = 'loaded';
    if found then
      insert into movements (window_id, event, project_id, actor, reason)
      values (
        v_id, 'unloaded', p_project_id, v_actor,
        'unloaded on site' ||
          case when v_note is not null then ' — ' || v_note else '' end
      );
      v_unloaded := v_unloaded + 1;
    end if;
  end loop;

  -- Damaged in transit/unload: hold + open a deduped unit-level damage issue.
  foreach v_id in array coalesce(p_damaged_ids, array[]::uuid[])
  loop
    update windows
    set status = 'damaged'
    where id = v_id and project_id = p_project_id and status = 'loaded';
    if found then
      insert into movements (window_id, event, project_id, actor, reason)
      values (v_id, 'unloaded', p_project_id, v_actor, 'damaged in transit/unload');

      if not exists (
        select 1 from issues
        where window_id = v_id and kind = 'damage' and status = 'open'
      ) then
        insert into issues (project_id, opening_id, window_id, kind, urgency, note, created_by)
        values (p_project_id, null, v_id, 'damage', 'urgent',
                'damaged in transit/unload', auth.uid());
      end if;
      v_damaged := v_damaged + 1;
    end if;
  end loop;

  return jsonb_build_object('unloaded', v_unloaded, 'damaged', v_damaged);
end;
$$;

-- Reorder rollup: per window type, how many units still need reordering for a
-- project — damaged units (status 'damaged') plus still-missing deliveries (an
-- open 'missing' issue for a unit of that type). One row per type with any
-- shortfall, so foreman+/office can reorder fast. Foreman+ only.
create or replace function list_reorder_needs(p_project_id uuid)
returns table (
  window_type_id uuid,
  type_name text,
  missing_count int,
  damaged_count int
)
language plpgsql
security definer
as $$
declare v_role text;
begin
  select role into v_role from profiles where id = auth.uid();
  if v_role is null or v_role = 'installer' then
    raise exception 'only a foreman-level user or above can view reorder needs';
  end if;

  return query
  with damaged as (
    select w.window_type_id as tid, count(*)::int as cnt
    from windows w
    where w.project_id = p_project_id and w.status = 'damaged'
    group by w.window_type_id
  ),
  missing as (
    select w.window_type_id as tid, count(*)::int as cnt
    from issues i
    join windows w on w.id = i.window_id
    where i.project_id = p_project_id
      and i.kind = 'missing'
      and i.status = 'open'
    group by w.window_type_id
  ),
  tids as (
    select tid from damaged
    union
    select tid from missing
  )
  select
    t.tid,
    wt.name,
    coalesce(m.cnt, 0),
    coalesce(d.cnt, 0)
  from tids t
  join window_types wt on wt.id = t.tid
  left join missing m on m.tid = t.tid
  left join damaged d on d.tid = t.tid
  order by wt.type_code;
end;
$$;
