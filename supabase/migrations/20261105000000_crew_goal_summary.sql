-- One job's approved hour goal and aggregate paid-time evidence. No employee rows leave this RPC.
create or replace function public.crew_goal_summary(p_project_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_target public.project_labor_targets;
  v_recorded numeric;
  v_running numeric;
  v_open integer;
  v_unresolved integer;
  v_at timestamptz := statement_timestamp();
begin
  if not public.custom_work_internal() or public.is_partner_user() or p_project_id is null
    or not exists (
      select 1 from public.projects p where p.id = p_project_id and p.deleted_at is null
      and (not p.is_test or public._is_supervisor(auth.uid()) or
        (public.is_test_profile(auth.uid()) and public.is_sandbox_project(p.id)))
    ) then
    raise exception 'This job is unavailable.' using errcode = '42501';
  end if;

  select * into v_target from public.project_labor_targets where project_id = p_project_id;
  -- A single statement snapshot makes the all-time sum complete regardless of row count.
  -- Closed time follows shiftHours: max(0, wall time minus stored break seconds).
  select coalesce(sum(case when status in ('submitted','approved') and clock_out_at is not null
      then greatest(0, extract(epoch from (clock_out_at - clock_in_at)) - break_seconds) / 3600
      else 0 end), 0),
    coalesce(sum(case when status = 'open' and clock_out_at is null
      then greatest(0, floor(extract(epoch from (v_at - clock_in_at))) - break_seconds
        - case when break_started_at is not null then greatest(0, floor(extract(epoch from (v_at - break_started_at)))) else 0 end) / 3600
      else 0 end), 0),
    count(*) filter (where status = 'open' and clock_out_at is null),
    count(*) filter (where status in ('needs_finish','rejected')
      or (status not in ('voided','open') and clock_out_at is null)
      or (status = 'open' and clock_out_at is not null))
  into v_recorded, v_running, v_open, v_unresolved
  from public.time_shifts where project_id = p_project_id and status <> 'voided';

  return jsonb_build_object(
    'goal_hours', v_target.goal_hours, 'goal_revision', v_target.revision,
    'goal_updated_at', v_target.updated_at, 'recorded_hours', v_recorded,
    'running_provisional_hours', v_running, 'open_shifts', v_open,
    'unresolved_shifts', v_unresolved, 'as_of', v_at,
    'allowance_hours', case when v_target.goal_hours is null then null
      else v_target.goal_hours - v_recorded - v_running end);
end; $$;

revoke all on function public.crew_goal_summary(uuid) from public, anon;
grant execute on function public.crew_goal_summary(uuid) to authenticated;
