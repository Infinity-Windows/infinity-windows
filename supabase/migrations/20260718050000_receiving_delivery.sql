-- Phase 2: receiving + missing-delivery + damaged-on-arrival.
--
-- Phase 1 pre-issues one 'pre_issued' windows row per expected unit BEFORE it
-- arrives. This migration closes the RECEIVING side of the chain:
--   * activate_preissued_unit: match a scanned/typed physical unit to its
--     pre_issued ID and turn it real ('in_warehouse' + a slot, or 'damaged'),
--     logging a 'received' movement and (if damaged) opening a damage issue.
--   * reconcile_project_deliveries: a foreman-triggered pass that flags every
--     still-'pre_issued' unit for a project as a 'missing' issue.
--
-- Unit-level issues (a specific damaged/missing window) need to point at the
-- physical unit, so we add a nullable windows(id) reference to `issues` and
-- extend the kind set with 'missing'.

-- Link an issue to a specific physical unit (nullable — opening-level issues
-- still use opening_id only).
alter table issues add column if not exists window_id uuid
  references windows(id) on delete set null;
create index if not exists issues_window_idx on issues (window_id);

-- Extend the issue kind set with 'missing' (undelivered unit). Recreate the
-- constraint with the full set.
alter table issues drop constraint if exists issues_kind_check;
alter table issues add constraint issues_kind_check
  check (kind in (
    'failed_install','flag','damage','blocker','complication','missing'
  ));

-- Receive a physical unit against the plan: match it to its pre_issued ID and
-- activate it. Foreman+ only (a plain installer, or a missing/unknown profile,
-- is rejected).
--
-- Resolves the unit via find_window_by_code (short_code OR serial,
-- case-insensitive). Requires the unit to exist AND still be 'pre_issued'
-- (anything else raises a clear error so a double-scan or bad code is obvious).
-- On success: status -> 'in_warehouse' (or 'damaged' if p_damaged), optional
-- storage location, a 'received' movement, and — when damaged — a unit-level
-- 'damage' issue (deduped on an open one for that window).
create or replace function activate_preissued_unit(
  p_code text,
  p_location_id uuid default null,
  p_damaged boolean default false,
  p_actor text default null
)
returns windows
language plpgsql
security definer
as $$
declare
  v_caller_role text;
  v_unit windows;
  v_new_status text;
begin
  -- Guard: only a foreman-level user or above may receive against the plan.
  select role into v_caller_role from profiles where id = auth.uid();
  if v_caller_role is null or v_caller_role = 'installer' then
    raise exception 'only a foreman-level user or above can receive against the plan';
  end if;

  select * into v_unit from find_window_by_code(p_code);
  if v_unit.id is null then
    raise exception 'unknown code % — no unit matches that code or serial', p_code;
  end if;
  if v_unit.status <> 'pre_issued' then
    raise exception
      'window % is not awaiting delivery (status %) — it may already be received',
      v_unit.window_id, v_unit.status;
  end if;

  v_new_status := case when p_damaged then 'damaged' else 'in_warehouse' end;

  update windows
  set status = v_new_status,
      location_id = coalesce(p_location_id, location_id),
      received_at = now()
  where id = v_unit.id
  returning * into v_unit;

  insert into movements (window_id, event, to_location_id, project_id, actor, reason)
  values (
    v_unit.id,
    'received',
    p_location_id,
    v_unit.project_id,
    coalesce(p_actor, auth.uid()::text),
    case when p_damaged then 'received damaged on arrival' else null end
  );

  -- Damaged on arrival: hold the unit and open a unit-level damage issue,
  -- deduped on an existing open damage issue for this window.
  if p_damaged then
    if not exists (
      select 1 from issues
      where window_id = v_unit.id and kind = 'damage' and status = 'open'
    ) then
      insert into issues (project_id, opening_id, window_id, kind, urgency, note, created_by)
      values (v_unit.project_id, null, v_unit.id, 'damage', 'urgent',
              'damaged on arrival', auth.uid());
    end if;
  end if;

  return v_unit;
end;
$$;

-- Foreman-triggered delivery reconcile: for every unit still 'pre_issued' for a
-- project, open a 'missing' issue (deduped on an existing open missing issue for
-- that window). Returns the issues it opened. No cron/date needed — a foreman
-- runs this after a delivery to flag whatever never showed up. Foreman+ only.
create or replace function reconcile_project_deliveries(p_project_id uuid)
returns setof issues
language plpgsql
security definer
as $$
declare
  v_caller_role text;
  v_unit windows;
  v_issue issues;
begin
  select role into v_caller_role from profiles where id = auth.uid();
  if v_caller_role is null or v_caller_role = 'installer' then
    raise exception 'only a foreman-level user or above can reconcile deliveries';
  end if;

  for v_unit in
    select * from windows
    where project_id = p_project_id and status = 'pre_issued'
  loop
    if not exists (
      select 1 from issues
      where window_id = v_unit.id and kind = 'missing' and status = 'open'
    ) then
      insert into issues (project_id, opening_id, window_id, kind, urgency, note, created_by)
      values (
        p_project_id, null, v_unit.id, 'missing', 'urgent',
        'delivery missing: ' || v_unit.window_id ||
          coalesce(' (' || v_unit.short_code || ')', ''),
        auth.uid()
      )
      returning * into v_issue;
      return next v_issue;
    end if;
  end loop;

  return;
end;
$$;
