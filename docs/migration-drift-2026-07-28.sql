-- =====================================================================
-- Migration drift repair — generated 2026-07-28
-- =====================================================================
-- Audited all 67 files in supabase/migrations/ against the live database
-- (project jvsyhtarnvmdilsgksdi) by comparing every table, column, index,
-- constraint, policy, function BODY, trigger, view, sequence and extension
-- they declare against the live catalog.
--
-- Result: 64 of 67 files are fully applied. This script contains the two
-- files that are NOT applied, in timestamp order.
--
--   20260718080000_chain_correctness_fixes.sql  — entirely unapplied
--   20260718090000_security_hardening.sql       — entirely unapplied
--
-- Why the migration history did not catch this: 20260718080000 IS recorded in
-- supabase_migrations.schema_migrations, but TWO files share that version
-- (chain_correctness_fixes and project_details). Only project_details actually
-- ran; the recorded version made its twin look applied.
--
-- ORDERING MATTERS. Section 1 must run BEFORE section 2. `CREATE OR REPLACE
-- FUNCTION` resets a function's SET clauses, so recreating the six functions in
-- section 1 would strip the search_path that section 2 pins. Running them in
-- this (timestamp) order leaves every function hardened.
--
-- IDEMPOTENT: every statement is `if not exists`, `drop ... if exists` followed
-- by a create, or a `create or replace`. Safe to run more than once.
--
-- NOT INCLUDED — a pending DATA backfill needing a separate decision:
--   20260721001000_seed_brain_top10_tips.sql  (an UPDATE over window_types)
-- It is in docs/migration-drift-2026-07-28-data-backfill.sql. Read that file
-- before running it; it rewrites rows rather than changing schema.
-- =====================================================================


-- =====================================================================
-- SECTION 1 of 2 — source: supabase/migrations/20260718080000_chain_correctness_fixes.sql
-- ---------------------------------------------------------------------
-- Status: ENTIRELY UNAPPLIED. Verified missing in live:
--   * constraint windows_status_check is live WITHOUT the 'on_site' value
--   * load_window             — live body has no warehouse-ready guard
--   * unload_units            — live body sets 'staged', not 'on_site'
--   * activate_preissued_unit — live body does not resolve the 'missing' issue
--   * set_opening_condition   — live body lacks the unit-OR-opening damage dedup
--   * undo_install            — live body never clears work_ended_at / closes the
--                               task session, and logs a spurious 'uninstalled'
--   * open_service_case       — live body is not idempotent (duplicate cases)
-- Contains no data-rewriting statements; every UPDATE inside it is runtime
-- logic within a function body, not a backfill.
-- =====================================================================

-- C1: extend the windows status set with 'on_site'. Recreate the constraint with
-- the full set (existing set + on_site), matching the earlier pre_issued pattern.
alter table windows drop constraint if exists windows_status_check;
alter table windows add constraint windows_status_check
  check (status in (
    'pre_issued','inbound','in_warehouse','staged','loaded','installed','damaged','on_site'
  ));

-- C2: load a window onto the truck ONLY when it is warehouse-ready
-- ('in_warehouse' or 'staged'); anything else (already loaded, on site,
-- installed, damaged, pre-issued) is rejected. Movement log + return unchanged.
create or replace function load_window(p_window_id uuid, p_actor text default null)
returns windows
language plpgsql
as $$
declare
  v_window windows;
  v_from uuid;
  v_status text;
begin
  select location_id, status into v_from, v_status from windows where id = p_window_id;
  if v_status is null then
    raise exception 'unknown window %', p_window_id;
  end if;
  if v_status not in ('in_warehouse', 'staged') then
    raise exception 'unit is not warehouse-ready to load (status %)', v_status;
  end if;

  update windows
  set status = 'loaded', location_id = null
  where id = p_window_id
  returning * into v_window;

  insert into movements (window_id, event, from_location_id, project_id, actor)
  values (p_window_id, 'loaded', v_from, v_window.project_id, p_actor);

  return v_window;
end;
$$;

-- C1 + H4: jobsite unload. OK units land 'on_site' (on site, ready to install)
-- instead of 'staged', so they can't be re-loaded. Damaged units hold + open a
-- deduped 'damage' issue that now matches EITHER the unit OR its currently-
-- assigned opening (H4), so a unit never accrues two open damage issues.
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
    set status = 'on_site'
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

      -- Dedup on the unit OR the opening it currently links to (H4).
      if not exists (
        select 1 from issues
        where kind = 'damage' and status = 'open'
          and (
            window_id = v_id
            or opening_id = (
              select id from project_openings
              where assigned_window_id = v_id
              limit 1
            )
          )
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

-- C3 + H4: receive a physical unit against the plan. On the OK path (now
-- in_warehouse) we resolve any open 'missing' issue for the unit (C3). On the
-- damaged path the damage-issue dedup now matches the unit OR its currently-
-- assigned opening (H4). All other behavior is preserved.
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

  if p_damaged then
    -- Damaged on arrival: hold + open a deduped damage issue (unit OR opening).
    if not exists (
      select 1 from issues
      where kind = 'damage' and status = 'open'
        and (
          window_id = v_unit.id
          or opening_id = (
            select id from project_openings
            where assigned_window_id = v_unit.id
            limit 1
          )
        )
    ) then
      insert into issues (project_id, opening_id, window_id, kind, urgency, note, created_by)
      values (v_unit.project_id, null, v_unit.id, 'damage', 'urgent',
              'damaged on arrival', auth.uid());
    end if;
  else
    -- Arrived fine: the delivery is no longer missing — resolve its open issue.
    update issues
    set status = 'resolved', resolved_at = now(), resolved_by = auth.uid()
    where window_id = v_unit.id and kind = 'missing' and status = 'open';
  end if;

  return v_unit;
end;
$$;

-- H4: record the arrival condition of the unit at an opening. Recreated
-- preserving all behavior; the damage-issue dedup now matches the opening OR the
-- assigned unit's window_id, so an opening-level and unit-level report of the
-- same physical unit collapse to ONE open damage issue.
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
    -- Dedup on the opening OR the assigned unit's window_id (H4).
    if not exists (
      select 1 from issues
      where kind = 'damage' and status = 'open'
        and (
          opening_id = p_opening_id
          or window_id = v_opening.assigned_window_id
        )
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

-- H2: undo/reclaim an install. Recreated preserving all prior behavior (void the
-- latest install event, revert the opening, clear work_started_at, void points,
-- open a deduped failed_install issue). Additionally it now:
--   * clears work_ended_at too, so elapsed task-time fully resets;
--   * closes the still-open task session for the opening;
--   * only logs the 'uninstalled' movement when an install event was actually
--     voided, so a repeat undo with nothing to void adds no spurious movement.
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

  select * into v_opening from project_openings where id = p_opening_id;
  if v_opening is null then
    raise exception 'unknown opening %', p_opening_id;
  end if;

  -- Void (never delete) the most recent non-voided install event, remembering
  -- whether we actually voided one.
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
        coalesce(p_reason, 'install undone')
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

-- H3: open a warranty / after-service case. Recreated preserving all behavior,
-- but now idempotent — if an 'open' case already exists for this unit, return it
-- instead of inserting a duplicate.
create or replace function open_service_case(
  p_window_id uuid,
  p_reason text,
  p_fail_point text default null,
  p_description text default null
)
returns service_cases
language plpgsql
security definer
as $$
declare
  v_role text;
  v_window windows;
  v_event install_events;
  v_case service_cases;
begin
  select role into v_role from profiles where id = auth.uid();
  if v_role is null or v_role = 'installer' then
    raise exception 'only a foreman-level user or above can open a service case';
  end if;

  select * into v_window from windows where id = p_window_id;
  if v_window is null then
    raise exception 'unknown window %', p_window_id;
  end if;

  -- Idempotent: one open case per unit. Return the existing open case if any.
  select * into v_case
  from service_cases
  where window_id = p_window_id and status = 'open'
  order by created_at desc
  limit 1;
  if v_case.id is not null then
    return v_case;
  end if;

  -- Latest non-voided install event for this unit gives us the opening,
  -- installer, and the exact event the failure traces back to.
  select * into v_event
  from install_events
  where window_id = p_window_id and voided_at is null
  order by created_at desc
  limit 1;

  insert into service_cases (
    window_id, install_event_id, project_id, opening_id, window_type_id,
    installer_id, status, reason, fail_point, description, reported_by
  ) values (
    p_window_id,
    v_event.id,
    v_window.project_id,
    v_event.project_opening_id,
    v_window.window_type_id,
    v_event.installer_id,
    'open',
    p_reason,
    p_fail_point,
    p_description,
    auth.uid()
  )
  returning * into v_case;

  return v_case;
end;
$$;


-- =====================================================================
-- SECTION 2 of 2 — source: supabase/migrations/20260718090000_security_hardening.sql
-- ---------------------------------------------------------------------
-- Status: ENTIRELY UNAPPLIED. Verified missing in live:
--   * function trg_guard_profile_role_change  — absent from every schema
--   * trigger  guard_profile_role_change on profiles — absent
--   * 27 SECURITY DEFINER functions in `public` have NO pinned search_path
--     (plus 155 SECURITY INVOKER functions)
--
-- Live impact: `profiles` has exactly one policy — "authenticated full access"
-- FOR ALL USING (true) WITH CHECK (true) — and no guard trigger, so any signed-in
-- user can UPDATE their own profiles.role to 'owner' directly. Closing this is
-- the highest-value item in this script.
--
-- Contains no data-rewriting statements.
-- =====================================================================

-- ---------------------------------------------------------------------------
-- 1. profiles.role self-promotion lockdown
-- ---------------------------------------------------------------------------
-- A BEFORE UPDATE trigger blocks any change to profiles.role UNLESS the caller
-- is authorized. Authorized = the caller's OWN current role is elevated
-- (foreman / supervisor / owner, plus the legacy elevated names), which is
-- exactly the check set_profile_role() already enforces — so the sanctioned
-- role-change RPC keeps working while a plain installer can never promote
-- itself (or anyone) by writing the profiles table directly.
--
-- Two escape hatches keep existing behavior intact:
--   * auth.uid() IS NULL  -> service-role / migration context (RLS already
--     blocks anon writes), so seeds and edge functions using the service key
--     are never blocked.
--   * owner-bootstrap emails -> the two founder emails may self-promote to
--     owner on sign-in (mirrors OWNER_BOOTSTRAP_EMAILS in app/src/lib/install/
--     api.ts). Without this, first-run owner bootstrap would be blocked.
--
-- Reads, inserts, and every non-role profile edit (display_name, skill_level,
-- active, pin) are untouched — only a role mutation is gated.

create or replace function trg_guard_profile_role_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller_role text;
  v_caller_email text;
begin
  -- Service role / no JWT (migrations, seeds, edge functions on the service
  -- key). RLS already prevents anon writes, so this is safe to allow.
  if auth.uid() is null then
    return new;
  end if;

  -- Founder bootstrap emails may self-promote to owner (mirrors the app).
  v_caller_email := lower(coalesce(auth.jwt() ->> 'email', ''));
  if v_caller_email in (
    'ammon@horizonsolarusa.com',
    'isaacammonbarlow@gmail.com'
  ) then
    return new;
  end if;

  -- Otherwise the caller's own current role must be elevated (foreman-level or
  -- above). Installers — and any unknown/legacy-nonelevated role — are blocked.
  -- This matches set_profile_role()'s own guard so the RPC path still works.
  select role into v_caller_role from profiles where id = auth.uid();
  if v_caller_role is null
     or v_caller_role not in ('foreman', 'supervisor', 'owner', 'lead', 'admin', 'big_boss')
  then
    raise exception
      'not authorized to change a profile role (foreman-level or above only)'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists guard_profile_role_change on profiles;
create trigger guard_profile_role_change
  before update on profiles
  for each row
  when (old.role is distinct from new.role)
  execute function trg_guard_profile_role_change();


-- ---------------------------------------------------------------------------
-- 2. Harden SECURITY DEFINER functions: pin search_path = public
-- ---------------------------------------------------------------------------
-- A SECURITY DEFINER function without a fixed search_path can be tricked into
-- resolving unqualified object names against an attacker-controlled schema,
-- letting a signed-in user escalate to the definer's (owner) privileges. Every
-- function in this app lives in `public` and already references cross-schema
-- symbols with a qualifier (e.g. auth.uid()), so pinning search_path = public
-- is behavior-neutral.
--
-- This is done dynamically so it hardens exactly the SECURITY DEFINER functions
-- present when the migration runs (the repo has ~22 across all migrations; a
-- live DB behind on migrations simply has fewer, and each is covered as it is
-- created by its own earlier-timestamped migration before this one runs). The
-- second loop also pins search_path on the remaining (SECURITY INVOKER)
-- functions to clear the linter's function_search_path_mutable warnings; this
-- is likewise behavior-neutral.

do $$
declare
  fn record;
begin
  -- Critical: SECURITY DEFINER functions (privilege-escalation surface).
  for fn in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prokind = 'f'
      and p.prosecdef = true
  loop
    execute format('alter function %s set search_path = public', fn.sig);
  end loop;

  -- Defense-in-depth: the rest of our public functions (SECURITY INVOKER).
  for fn in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prokind = 'f'
      and p.prosecdef = false
      and (p.proconfig is null
           or not exists (
             select 1 from unnest(p.proconfig) c where c like 'search_path=%'
           ))
  loop
    execute format('alter function %s set search_path = public', fn.sig);
  end loop;
end $$;


-- =====================================================================
-- Verification — run after applying; every row should report OK.
-- =====================================================================
-- select 'on_site accepted' as check,
--        case when pg_get_constraintdef(oid) like '%on_site%' then 'OK' else 'FAIL' end
--   from pg_constraint where conname = 'windows_status_check';
--
-- select 'role guard trigger' as check,
--        case when count(*) = 1 then 'OK' else 'FAIL' end
--   from pg_trigger where tgname = 'guard_profile_role_change' and not tgisinternal;
--
-- select 'secdef search_path pinned' as check,
--        case when count(*) = 0 then 'OK' else 'FAIL: ' || count(*)::text end
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--  where n.nspname = 'public' and p.prokind = 'f' and p.prosecdef
--    and (p.proconfig is null
--         or not exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%'));
--
-- select 'unload sends units on_site' as check,
--        case when prosrc like '%on_site%' then 'OK' else 'FAIL' end
--   from pg_proc where proname = 'unload_units';
