-- Remove one calendar day atomically. Keep both remaining ranges and their crew
-- and vehicle links; caller RLS and connected-plan guards remain in force.
create or replace function public.schedule_remove_day(
  p_assignment_id uuid, p_day date, p_expected_updated_at timestamptz
) returns void language plpgsql security invoker
set search_path = public, pg_temp as $$
declare
  a public.schedule_assignments%rowtype;
  right_id uuid;
begin
  if auth.uid() is null or public.is_partner_user() or not public.travel_is_supervisor()
     or not exists (select 1 from public.profiles where id=auth.uid() and active) then
    raise exception 'Only an active owner or supervisor can remove scheduled days.';
  end if;
  if p_day is null or p_expected_updated_at is null then
    raise exception 'Choose a day and reload the assignment before removing it.';
  end if;
  -- Match connected publication's lock order, including membership/vehicle edits.
  perform pg_advisory_xact_lock(639024,1);
  select * into a from public.schedule_assignments where id=p_assignment_id for update;
  -- A retry after a lost response must not remove any additional days.
  if not found then return; end if;
  if exists (select 1 from public.workflow_plan_assignments where assignment_id=a.id) then
    raise exception 'Open the connected plan to change its work dates.';
  end if;
  if p_day < a.start_date or p_day > a.end_date then return; end if;
  if a.updated_at is distinct from p_expected_updated_at then
    raise exception 'This assignment changed. Close and reopen it before removing a day.';
  end if;
  if a.kind is distinct from 'install' then
    raise exception 'Change delivery dates from the delivery schedule.';
  end if;
  if a.start_date = a.end_date then
    delete from public.schedule_assignments where id=a.id;
  elsif p_day = a.start_date then
    update public.schedule_assignments set start_date=p_day+1,updated_at=clock_timestamp() where id=a.id;
    update public.vehicle_project_assignments set start_date=p_day+1,end_date=a.end_date where assignment_id=a.id;
  elsif p_day = a.end_date then
    update public.schedule_assignments set end_date=p_day-1,updated_at=clock_timestamp() where id=a.id;
    update public.vehicle_project_assignments set start_date=a.start_date,end_date=p_day-1 where assignment_id=a.id;
  else
    right_id := gen_random_uuid();
    insert into public.schedule_assignments
      (id,project_id,start_date,end_date,start_time,status,color,note,created_by,published_at,created_at,kind,created_via)
    values (right_id,a.project_id,p_day+1,a.end_date,a.start_time,a.status,a.color,a.note,a.created_by,a.published_at,a.created_at,a.kind,a.created_via);
    insert into public.schedule_assignment_members (assignment_id,profile_id,role,created_at)
      select right_id,profile_id,role,created_at from public.schedule_assignment_members where assignment_id=a.id;
    insert into public.vehicle_project_assignments (vehicle_id,project_id,assigned_at,note,assignment_id,start_date,end_date)
      select vehicle_id,project_id,assigned_at,note,right_id,p_day+1,a.end_date
      from public.vehicle_project_assignments where assignment_id=a.id;
    update public.schedule_assignments set end_date=p_day-1,updated_at=clock_timestamp() where id=a.id;
    update public.vehicle_project_assignments set start_date=a.start_date,end_date=p_day-1 where assignment_id=a.id;
  end if;
  insert into public.schedule_events (assignment_id,actor,kind,payload)
    values (a.id,auth.uid(),'removed',jsonb_build_object('scope','day','day',p_day,
      'previous_start_date',a.start_date,'previous_end_date',a.end_date,'remaining_assignment_id',right_id));
end $$;
revoke all on function public.schedule_remove_day(uuid,date,timestamptz) from public,anon;
grant execute on function public.schedule_remove_day(uuid,date,timestamptz) to authenticated;
