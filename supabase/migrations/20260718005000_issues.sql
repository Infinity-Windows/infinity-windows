-- Unified tiered issues model.
--
-- Three scattered "problem" surfaces (ProjectDetail Exceptions tab, Dispatch
-- Blockers, ProjectMap voided rings) plus the foreman "issues list" become ONE
-- table. Every problem write (flag, damage, undo/failed install, complication)
-- flows into `issues`; the Exceptions tab and Blockers become filtered views of
-- the same data. `urgency` renders as blank / `!` / `!!!` in the UI.

create table if not exists issues (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  opening_id uuid references project_openings(id) on delete set null,
  kind text not null check (kind in ('failed_install','flag','damage','blocker','complication')),
  urgency text not null default 'normal' check (urgency in ('normal','urgent','emergency')),
  status text not null default 'open' check (status in ('open','resolved')),
  note text,
  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  resolved_by uuid references profiles(id) on delete set null,
  resolved_at timestamptz
);

create index if not exists issues_status_urgency_idx on issues (status, urgency);
create index if not exists issues_project_idx on issues (project_id);
create index if not exists issues_opening_idx on issues (opening_id);

-- RLS: same trusted-crew pattern as the other install tables. The cross-project
-- list is additionally guarded foreman+ inside list_issues().
alter table issues enable row level security;
do $$
begin
  if not exists (
    select 1 from pg_policies where tablename = 'issues' and policyname = 'authenticated full access'
  ) then
    create policy "authenticated full access" on issues
      for all to authenticated using (true) with check (true);
  end if;
end;
$$;

-- Stream issues to the lead board / heartbeat like the other field tables.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'issues'
  ) then
    alter publication supabase_realtime add table issues;
  end if;
end;
$$;

-- --- RPCs -------------------------------------------------------------------

-- Open a new issue (created_by = the caller). Used by the OpeningSheet
-- "complication" / skip-damaged escalations and any future writer.
create or replace function create_issue(
  p_project uuid,
  p_opening uuid,
  p_kind text,
  p_urgency text default 'normal',
  p_note text default null
)
returns issues
language plpgsql
security definer
as $$
declare v_issue issues;
begin
  insert into issues (project_id, opening_id, kind, urgency, note, created_by)
  values (p_project, p_opening, p_kind, coalesce(p_urgency, 'normal'), p_note, auth.uid())
  returning * into v_issue;
  return v_issue;
end;
$$;

-- Resolve an issue (who + when). Idempotent-friendly: re-resolving is harmless.
create or replace function resolve_issue(p_id uuid)
returns issues
language plpgsql
security definer
as $$
declare v_issue issues;
begin
  update issues
  set status = 'resolved',
      resolved_by = auth.uid(),
      resolved_at = now()
  where id = p_id
  returning * into v_issue;
  if v_issue is null then
    raise exception 'unknown issue %', p_id;
  end if;
  return v_issue;
end;
$$;

-- Cross-project issue feed for foreman-level users and above. Returns every
-- issue (open + resolved); the UI filters by status/kind/project.
create or replace function list_issues()
returns setof issues
language plpgsql
security definer
as $$
declare v_role text;
begin
  select role into v_role from profiles where id = auth.uid();
  if v_role is null or v_role = 'installer' then
    raise exception 'issues are for foreman-level users and above';
  end if;
  return query select * from issues order by created_at desc;
end;
$$;

-- --- Wire existing writes into the issues table -----------------------------

-- Flag (or clear) an opening for the lead. Recreated from
-- 20260716010000_field_flags.sql, preserving all behavior, and now also opens a
-- 'flag' issue (deduped on an existing OPEN flag for the same opening). Clearing
-- the flag resolves any open flag issues for that opening.
create or replace function flag_opening(p_opening_id uuid, p_note text)
returns project_openings
language plpgsql
as $$
declare
  v_opening project_openings;
  v_clean text;
begin
  v_clean := nullif(trim(coalesce(p_note, '')), '');

  update project_openings
  set flag_note = v_clean,
      flagged_by = case when v_clean is null then null else auth.uid() end,
      flagged_at = case when v_clean is null then null else now() end
  where id = p_opening_id
  returning * into v_opening;
  if v_opening is null then
    raise exception 'unknown opening %', p_opening_id;
  end if;

  if v_clean is null then
    -- Flag cleared: resolve any open flag issues for this opening.
    update issues
    set status = 'resolved', resolved_by = auth.uid(), resolved_at = now()
    where opening_id = p_opening_id and kind = 'flag' and status = 'open';
  else
    -- Flag set: open a flag issue unless one is already open.
    if not exists (
      select 1 from issues
      where opening_id = p_opening_id and kind = 'flag' and status = 'open'
    ) then
      insert into issues (project_id, opening_id, kind, urgency, note, created_by)
      values (v_opening.project_id, p_opening_id, 'flag', 'normal', v_clean, auth.uid());
    end if;
  end if;

  return v_opening;
end;
$$;

-- Record the arrival condition of the unit at an opening. Recreated from
-- 20260715230000_fit_condition_gate.sql, preserving all behavior, and now a
-- 'damage' issue (urgent) is opened when the unit is marked damaged (deduped on
-- an existing OPEN damage issue). Marking OK/unknown resolves open damage issues.
create or replace function set_opening_condition(
  p_opening_id uuid,
  p_condition text,
  p_note text default null,
  p_actor text default null
)
returns project_openings
language plpgsql
as $$
declare
  v_opening project_openings;
begin
  if p_condition not in ('unknown','ok','damaged') then
    raise exception 'invalid condition %', p_condition;
  end if;

  update project_openings
  set condition = p_condition,
      condition_note = p_note,
      condition_checked_by = p_actor,
      condition_checked_at = now()
  where id = p_opening_id
  returning * into v_opening;

  if v_opening is null then
    raise exception 'unknown opening %', p_opening_id;
  end if;

  -- Damaged units flag the physical record so the office/warehouse sees it too.
  if p_condition = 'damaged' and v_opening.assigned_window_id is not null then
    update windows set status = 'damaged' where id = v_opening.assigned_window_id;
    insert into movements (window_id, event, project_id, actor, reason)
    values (
      v_opening.assigned_window_id, 'damaged', v_opening.project_id, p_actor,
      coalesce('damaged at opening ' || v_opening.opening_code ||
        case when p_note is not null then ': ' || p_note else '' end,
        'damaged at opening')
    );
  end if;

  -- Route the condition into the issues model.
  if p_condition = 'damaged' then
    if not exists (
      select 1 from issues
      where opening_id = p_opening_id and kind = 'damage' and status = 'open'
    ) then
      insert into issues (project_id, opening_id, kind, urgency, note, created_by)
      values (v_opening.project_id, p_opening_id, 'damage', 'urgent', p_note, auth.uid());
    end if;
  else
    -- No longer damaged: resolve any open damage issues for this opening.
    update issues
    set status = 'resolved', resolved_by = auth.uid(), resolved_at = now()
    where opening_id = p_opening_id and kind = 'damage' and status = 'open';
  end if;

  return v_opening;
end;
$$;

-- Undo/reclaim an install. Recreated from 20260718004000_integration_fixes.sql,
-- PRESERVING the work_started_at = null clear and all prior behavior, and now it
-- also opens a 'failed_install' issue (urgent, note = reason), deduped on an
-- existing OPEN failed_install issue for that opening.
create or replace function undo_install(p_opening_id uuid, p_reason text default null)
returns void
language plpgsql
security definer
as $$
declare
  v_caller_role text;
  v_opening project_openings;
begin
  -- Guard: only elevated roles may undo. Only a plain installer is blocked, so
  -- this holds for both legacy (lead/foreman/admin/big_boss) and any new role
  -- names above installer.
  select role into v_caller_role from profiles where id = auth.uid();
  if v_caller_role is null or v_caller_role = 'installer' then
    raise exception 'only a foreman-level user or above can undo an install';
  end if;

  select * into v_opening from project_openings where id = p_opening_id;
  if v_opening is null then
    raise exception 'unknown opening %', p_opening_id;
  end if;

  -- Void (never delete) the most recent non-voided install event.
  update install_events
  set voided_at = now(),
      voided_by = auth.uid(),
      void_reason = p_reason
  where id = (
    select id from install_events
    where project_opening_id = p_opening_id
      and voided_at is null
    order by created_at desc
    limit 1
  );

  -- Revert the opening back to its pre-install state. Also clear
  -- work_started_at so the phantom "in progress" clears on Home/MyWork/Dispatch.
  update project_openings
  set status = case when assigned_window_id is not null then 'assigned' else 'planned' end,
      confirmed = false,
      work_started_at = null
  where id = p_opening_id;

  -- Return the physical unit to the truck and log the reverse movement.
  if v_opening.assigned_window_id is not null then
    update windows
    set status = 'loaded', installed_at = null
    where id = v_opening.assigned_window_id;

    insert into movements (window_id, event, project_id, actor, reason)
    values (
      v_opening.assigned_window_id,
      'uninstalled',
      v_opening.project_id,
      auth.uid()::text,
      coalesce(p_reason, 'install undone')
    );
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
    values (v_opening.project_id, p_opening_id, 'failed_install', 'urgent', p_reason, auth.uid());
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

-- --- Backfill existing problems into issues (idempotent) --------------------

-- Existing flags → open flag issues.
insert into issues (project_id, opening_id, kind, urgency, note, created_by, created_at)
select o.project_id, o.id, 'flag', 'normal', o.flag_note, o.flagged_by,
       coalesce(o.flagged_at, now())
from project_openings o
where o.flag_note is not null
  and not exists (
    select 1 from issues i
    where i.opening_id = o.id and i.kind = 'flag' and i.status = 'open'
  );

-- Existing damaged conditions → open damage issues (urgent).
insert into issues (project_id, opening_id, kind, urgency, note, created_by, created_at)
select o.project_id, o.id, 'damage', 'urgent', o.condition_note, null,
       coalesce(o.condition_checked_at, now())
from project_openings o
where o.condition = 'damaged'
  and not exists (
    select 1 from issues i
    where i.opening_id = o.id and i.kind = 'damage' and i.status = 'open'
  );

-- Existing voided (failed/undone) installs → open failed_install issues (urgent).
insert into issues (project_id, opening_id, kind, urgency, note, created_by, created_at)
select o.project_id, e.project_opening_id, 'failed_install', 'urgent',
       e.void_reason, e.voided_by, coalesce(e.voided_at, now())
from install_events e
join project_openings o on o.id = e.project_opening_id
where e.voided_at is not null
  and not exists (
    select 1 from issues i
    where i.opening_id = e.project_opening_id
      and i.kind = 'failed_install' and i.status = 'open'
  );
