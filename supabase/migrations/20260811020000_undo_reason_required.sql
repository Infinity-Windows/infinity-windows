-- Undoing an install now requires saying why.
--
-- The undo has always PRESERVED everything (the install event is voided,
-- never deleted — memos, photos, grade and minutes all survive on the voided
-- row), but the reason was optional, and an optional reason in the field
-- means a blank one. The reason is the whole value of the record: "forgot
-- the shims" and "glass scratched on install" send two different people back
-- to the wall — and it also becomes the failed-install issue's note, so a
-- blank reason was producing blank issues. Owner call (2026-08-11): no
-- reason, no undo.
--
-- Body otherwise identical to 20260718080030 (the latest recreation: closes
-- task sessions, guards a repeat undo's movement, opens the deduped
-- failed_install issue, refreshes type rollups).

create or replace function undo_install(p_opening_id uuid, p_reason text default null)
returns void
language plpgsql
security definer
as $$
declare
  v_caller_role text;
  v_opening project_openings;
  v_voided_id uuid;
begin
  select role into v_caller_role from profiles where id = auth.uid();
  if v_caller_role is null or v_caller_role = 'installer' then
    raise exception 'only a foreman-level user or above can undo an install';
  end if;

  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'a reason is required to undo an install';
  end if;

  select * into v_opening from project_openings where id = p_opening_id;
  if v_opening is null then
    raise exception 'unknown opening %', p_opening_id;
  end if;

  -- Void (never delete) the most recent non-voided install event, remembering
  -- whether we actually voided one.
  update install_events
  set voided_at = now(),
      voided_by = auth.uid(),
      void_reason = btrim(p_reason)
  where id = (
    select id from install_events
    where project_opening_id = p_opening_id
      and voided_at is null
    order by created_at desc
    limit 1
  )
  returning id into v_voided_id;

  -- Revert the opening to its pre-install state. Clear BOTH work_started_at and
  -- work_ended_at so the phantom "in progress" and any elapsed task-time clear.
  update project_openings
  set status = case when assigned_window_id is not null then 'assigned' else 'planned' end,
      confirmed = false,
      work_started_at = null,
      work_ended_at = null
  where id = p_opening_id;

  -- Stop task-time: close any still-open session tied to this opening.
  update task_sessions
  set ended_at = now()
  where opening_id = p_opening_id and ended_at is null;

  -- Return the physical unit to the truck. Only append the reverse movement when
  -- an install event was actually voided (guards a spurious repeat undo).
  if v_opening.assigned_window_id is not null then
    update windows
    set status = 'loaded', installed_at = null
    where id = v_opening.assigned_window_id;

    if v_voided_id is not null then
      insert into movements (window_id, event, project_id, actor, reason)
      values (
        v_opening.assigned_window_id,
        'uninstalled',
        v_opening.project_id,
        auth.uid()::text,
        btrim(p_reason)
      );
    end if;
  end if;

  -- Void any points earned for this install (ref stores the opening UUID as text).
  update points_ledger
  set status = 'void'
  where ref = p_opening_id::text
    and status in ('pending', 'confirmed');

  -- Open a failed-install issue (deduped on an open one for this opening).
  if not exists (
    select 1 from issues
    where opening_id = p_opening_id and kind = 'failed_install' and status = 'open'
  ) then
    insert into issues (project_id, opening_id, kind, urgency, note, created_by)
    values (v_opening.project_id, p_opening_id, 'failed_install', 'urgent', btrim(p_reason), auth.uid());
  end if;

  -- Refresh learned rollups for this type (best-effort; skip if absent).
  if v_opening.window_type_id is not null then
    begin
      perform recompute_window_type_rollups(v_opening.window_type_id);
    exception when undefined_function then
      null;
    end;
  end if;
end;
$$;
