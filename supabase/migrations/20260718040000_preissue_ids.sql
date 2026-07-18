-- Phase 1: pre-issue unit IDs from the plan-set.
--
-- When a project's expected windows are known (project_windows planned quantities
-- by type, rolled up from confirmed openings), pre-issue one physical-unit record
-- per expected window BEFORE it physically arrives. Each new row gets a serial
-- window_id + hand-writable short_code (+ QR) and status 'pre_issued', so a foreman
-- can print the label batch and labels get applied on delivery.
--
-- This is the FRONT of the "track every window" chain: every expected unit has an
-- ID before arrival, which enables later missing-delivery detection (Phase 2).

-- Extend the windows status set to include the new pre-arrival state.
-- Recreate the constraint with the full set (existing set + pre_issued).
alter table windows drop constraint if exists windows_status_check;
alter table windows add constraint windows_status_check
  check (status in (
    'pre_issued','inbound','in_warehouse','staged','loaded','installed','damaged'
  ));

-- Allow logging the pre-issue event in the append-only movement log.
alter table movements drop constraint if exists movements_event_check;
alter table movements add constraint movements_event_check
  check (event in (
    'received','putaway','moved','staged','loaded','installed','damaged',
    'count_verified','count_missing','override','assigned','uninstalled','preissued'
  ));

-- Pre-issue windows rows for a project from its planned quantities.
--
-- Foreman+ only (a plain installer, or a missing/unknown profile, is rejected).
-- Idempotent: for each planned type we only create
--   (planned quantity - existing units of that type, in ANY status)
-- new rows, so running twice never creates duplicates beyond the plan. If
-- project_windows is empty for the project, this is a safe no-op.
create or replace function preissue_project_units(p_project_id uuid)
returns setof windows
language plpgsql
security definer
as $$
declare
  v_caller_role text;
  v_need record;
  v_existing int;
  v_to_create int;
  i int;
  v_window windows;
begin
  -- Guard: only a foreman-level user or above may pre-issue. Only a plain
  -- installer is explicitly blocked, so this holds for both legacy role names
  -- (lead/foreman/admin/big_boss) and any new role above installer.
  select role into v_caller_role from profiles where id = auth.uid();
  if v_caller_role is null or v_caller_role = 'installer' then
    raise exception 'only a foreman-level user or above can pre-issue unit IDs';
  end if;

  for v_need in
    select window_type_id, quantity
    from project_windows
    where project_id = p_project_id
  loop
    -- Count units that already exist for this (project, type) in ANY status so
    -- re-running never exceeds the planned quantity.
    select count(*) into v_existing
    from windows
    where project_id = p_project_id
      and window_type_id = v_need.window_type_id;

    v_to_create := v_need.quantity - v_existing;

    if v_to_create > 0 then
      for i in 1..v_to_create loop
        -- Retry on the rare short_code unique collision.
        loop
          begin
            insert into windows (
              window_id, short_code, window_type_id, status, project_id, location_id
            )
            values (
              issue_window_id(v_need.window_type_id),
              issue_window_short_code(),
              v_need.window_type_id,
              'pre_issued',
              p_project_id,
              null
            )
            returning * into v_window;
            exit;
          exception when unique_violation then
            -- extremely rare short_code collision; try again
          end;
        end loop;

        insert into movements (window_id, event, project_id, actor)
        values (v_window.id, 'preissued', p_project_id, auth.uid()::text);

        return next v_window;
      end loop;
    end if;
  end loop;

  return;
end;
$$;
