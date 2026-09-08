-- Optional planned daily end time. Existing assignments keep null; no business
-- values or working drafts are rewritten. Clocked payroll hours are untouched.
alter table public.schedule_assignments add column if not exists end_time time;
alter table public.schedule_assignments add constraint schedule_assignment_daily_times
  check (end_time is null or (start_time is not null and end_time > start_time));

-- Omit a null new field from snapshots so pre-migration connected plans keep
-- their original source fingerprint and remain publishable.
create or replace function public.workflow_snapshot(p_plan uuid) returns jsonb language sql stable security definer
set search_path=public,pg_temp as $$
 select jsonb_build_object(
  'assignments',coalesce((select jsonb_agg((case when a.end_time is null then to_jsonb(a)-'end_time' else to_jsonb(a) end)||jsonb_build_object('members',
   coalesce((select jsonb_agg(to_jsonb(m) order by m.profile_id) from public.schedule_assignment_members m where m.assignment_id=a.id),'[]'::jsonb)) order by a.id)
   from public.schedule_assignments a join public.workflow_plan_assignments l on l.assignment_id=a.id where l.plan_id=p_plan),'[]'::jsonb),
  'trips',coalesce((select jsonb_agg(jsonb_build_object('trip',to_jsonb(t),
   'crew',coalesce((select jsonb_agg(to_jsonb(c) order by c.profile_id) from public.trip_crew c where c.trip_id=t.id),'[]'::jsonb),
   'flights',coalesce((select jsonb_agg(to_jsonb(c) order by c.id) from public.flights c where c.trip_id=t.id),'[]'::jsonb),
   'lodging',coalesce((select jsonb_agg(to_jsonb(c) order by c.id) from public.lodging c where c.trip_id=t.id),'[]'::jsonb),
   'ground',coalesce((select jsonb_agg(to_jsonb(c) order by c.id) from public.ground_transport c where c.trip_id=t.id),'[]'::jsonb),
   'procedures',coalesce((select jsonb_agg(to_jsonb(c) order by c.id) from public.procedures c where c.trip_id=t.id),'[]'::jsonb),
   'contacts',coalesce((select jsonb_agg(to_jsonb(c) order by c.id) from public.trip_contacts c where c.trip_id=t.id),'[]'::jsonb),
   'attachments',coalesce((select jsonb_agg(to_jsonb(c) order by c.id) from public.trip_attachments c where c.trip_id=t.id),'[]'::jsonb)
   ) order by t.id) from public.trips t join public.workflow_plan_trips l on l.trip_id=t.id where l.plan_id=p_plan),'[]'::jsonb),
  'vehicles',coalesce((select jsonb_agg(to_jsonb(v) order by v.id) from public.vehicle_project_assignments v
   join public.workflow_plan_assignments l on l.assignment_id=v.assignment_id where l.plan_id=p_plan),'[]'::jsonb)
 );
$$;

create or replace function public.workflow_save_draft(p_plan uuid,p_expected bigint,p_draft jsonb)
returns bigint language plpgsql security definer set search_path=public,pg_temp as $$
declare plan public.workflow_plans; a jsonb; original jsonb; section jsonb; old_section jsonb;
begin
 perform public.workflow_require_manager(); perform pg_advisory_xact_lock(639024,1);
 select * into strict plan from public.workflow_plans where id=p_plan for update;
 if plan.state<>'active' or plan.revision<>p_expected then raise exception 'The plan changed. Reload it before saving.' using errcode='40001'; end if;
 if jsonb_typeof(p_draft) is distinct from 'object' or pg_column_size(p_draft)>1048576 then raise exception 'That draft is not valid.'; end if;
 if (p_draft - array['assignments','trips']) is distinct from (plan.draft - array['assignments','trips'])
 or jsonb_array_length(p_draft->'assignments') is distinct from jsonb_array_length(plan.draft->'assignments')
 or jsonb_array_length(p_draft->'trips') is distinct from jsonb_array_length(plan.draft->'trips') then
  raise exception 'Keep the linked work, trips, and vehicle records in this plan.';
 end if;
 for a in select value from jsonb_array_elements(p_draft->'assignments') loop
  if jsonb_typeof(a->'members') is distinct from 'array' or (a->>'start_date')::date is null or (a->>'end_date')::date is null or (a->>'start_date')::date>(a->>'end_date')::date then raise exception 'Work needs valid dates and a crew list.'; end if;
  if a->>'end_time' is not null and ((a->>'start_time') is null or (a->>'end_time')::time <= (a->>'start_time')::time) then raise exception 'End time must be later than start time on the same day.'; end if;
  select value into original from jsonb_array_elements(plan.draft->'assignments') where value->>'id'=a->>'id';
  if original is null or (a-array['start_date','end_date','start_time','end_time','note','members']) is distinct from (original-array['start_date','end_date','start_time','end_time','note','members']) then raise exception 'The work identity cannot be changed.'; end if;
 end loop;
 for section in select value from jsonb_array_elements(p_draft->'trips') loop
  if jsonb_typeof(section->'crew') is distinct from 'array' or (section->'trip'->>'start_date')::date is null or (section->'trip'->>'end_date')::date is null or (section->'trip'->>'start_date')::date>(section->'trip'->>'end_date')::date then raise exception 'Travel needs valid dates and a crew list.'; end if;
  select value into old_section from jsonb_array_elements(plan.draft->'trips') where value->'trip'->>'id'=section->'trip'->>'id';
  if old_section is null or (section-array['trip','crew']) is distinct from (old_section-array['trip','crew'])
   or ((section->'trip')-array['name','destination','start_date','end_date','timezone','notes']) is distinct from ((old_section->'trip')-array['name','destination','start_date','end_date','timezone','notes']) then
   raise exception 'Keep the existing travel details and files. Only plan fields and crew can change here.';
  end if;
 end loop;
 -- Duplicate parent IDs must not replace another parent in a same-length list.
 if (select count(distinct value->>'id') from jsonb_array_elements(p_draft->'assignments'))<>jsonb_array_length(p_draft->'assignments')
 or (select count(distinct value->'trip'->>'id') from jsonb_array_elements(p_draft->'trips'))<>jsonb_array_length(p_draft->'trips') then raise exception 'A linked record appears twice.'; end if;
 if p_draft=plan.draft then return plan.revision; end if;
 update public.workflow_plans set draft=p_draft,revision=revision+1,updated_at=now() where id=p_plan returning revision into plan.revision;
 return plan.revision;
end $$;

create or replace function public.workflow_publish_plan(p_plan uuid,p_expected bigint,p_request uuid,p_review_token text,p_allow_crew_conflicts boolean default false,p_cancel boolean default false)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare p public.workflow_plans; prior public.workflow_publish_requests; fingerprint text; conflicts jsonb; a jsonb; pack jsonb; member jsonb; old_members uuid[]; new_members uuid[]; result jsonb;
begin
 perform public.workflow_require_manager(); perform pg_advisory_xact_lock(639024,1);
 if p_request is null or p_expected is null or p_review_token is null or p_cancel is null or p_allow_crew_conflicts is null then raise exception 'Review this plan before publishing.'; end if;
 fingerprint:=md5(jsonb_build_array(p_plan,p_expected,p_review_token,p_allow_crew_conflicts,p_cancel)::text);
 select * into prior from public.workflow_publish_requests where request_id=p_request;
 if found then
  if prior.fingerprint<>fingerprint then raise exception 'This publish request was already used for different changes.'; end if;
  return prior.result;
 end if;
 select * into strict p from public.workflow_plans where id=p_plan for update;
 if p.state<>'active' or p.revision<>p_expected then raise exception 'The plan changed. Reload and review it again.' using errcode='40001'; end if;
 if not p_cancel and p.published_revision=p.revision then raise exception 'There are no unpublished changes.'; end if;
 conflicts:=public.workflow_conflicts(p_plan);
 if md5(p.draft::text||conflicts::text)<>p_review_token then raise exception 'Bookings changed since your review. Review the conflicts again.' using errcode='40001'; end if;
 if public.workflow_snapshot(p_plan)<>p.source_snapshot then raise exception 'A linked source changed outside this plan. Reconcile it before publishing.' using errcode='40001'; end if;
 if not p_cancel and exists(select 1 from jsonb_array_elements(conflicts) c where c->>'kind'='vehicle') then raise exception 'Resolve the vehicle double-booking before publishing.'; end if;
 if not p_cancel and jsonb_array_length(conflicts)>0 and not p_allow_crew_conflicts then raise exception 'Review and acknowledge the crew conflicts before publishing.'; end if;
 select array_agg(distinct id) into old_members from (
  select m.profile_id as id from public.schedule_assignment_members m join public.workflow_plan_assignments l on l.assignment_id=m.assignment_id where l.plan_id=p_plan
  union select m.profile_id from public.trip_crew m join public.workflow_plan_trips l on l.trip_id=m.trip_id where l.plan_id=p_plan
 ) x;
 if p_cancel then
  update public.schedule_assignments set status='canceled',updated_at=now() where id in(select assignment_id from public.workflow_plan_assignments where plan_id=p_plan);
  update public.trips set status='draft',updated_at=now() where id in(select trip_id from public.workflow_plan_trips where plan_id=p_plan);
  update public.workflow_plans set state='canceled',revision=revision+1 where id=p_plan returning * into p;
 else
  for a in select value from jsonb_array_elements(p.draft->'assignments') loop
   if (a->>'start_date')::date>(a->>'end_date')::date or jsonb_array_length(a->'members')=0 then raise exception 'Each work block needs valid dates and crew.'; end if;
   update public.schedule_assignments set start_date=(a->>'start_date')::date,end_date=(a->>'end_date')::date,
    start_time=(a->>'start_time')::time,end_time=(a->>'end_time')::time,note=a->>'note',status='published',published_at=now(),updated_at=now() where id=(a->>'id')::uuid;
   delete from public.schedule_assignment_members where assignment_id=(a->>'id')::uuid;
   for member in select value from jsonb_array_elements(a->'members') loop
    if not exists(select 1 from public.profiles where id=(member->>'profile_id')::uuid and not is_partner and active) then raise exception 'Choose active internal crew members.'; end if;
    insert into public.schedule_assignment_members(assignment_id,profile_id,role) values((a->>'id')::uuid,(member->>'profile_id')::uuid,member->>'role');
   end loop;
   update public.vehicle_project_assignments set start_date=(a->>'start_date')::date,end_date=(a->>'end_date')::date where assignment_id=(a->>'id')::uuid;
  end loop;
  for pack in select value from jsonb_array_elements(p.draft->'trips') loop
   a:=pack->'trip';
   if nullif(trim(a->>'name'),'') is null or (a->>'start_date')::date>(a->>'end_date')::date or jsonb_array_length(pack->'crew')=0 then raise exception 'Each trip needs a name, valid dates and crew.'; end if;
   if nullif(a->>'timezone','') is not null and not exists(select 1 from pg_timezone_names where name=a->>'timezone') then raise exception 'Choose a valid trip time zone.'; end if;
   update public.trips set name=a->>'name',destination=a->>'destination',start_date=(a->>'start_date')::date,end_date=(a->>'end_date')::date,
    timezone=nullif(a->>'timezone',''),notes=a->>'notes',status='published',published_at=now(),updated_at=now() where id=(a->>'id')::uuid;
   delete from public.trip_crew where trip_id=(a->>'id')::uuid;
   for member in select value from jsonb_array_elements(pack->'crew') loop
    if not exists(select 1 from public.profiles where id=(member->>'profile_id')::uuid and not is_partner and active) then raise exception 'Choose active internal crew members.'; end if;
    insert into public.trip_crew(trip_id,profile_id,role) values((a->>'id')::uuid,(member->>'profile_id')::uuid,coalesce(member->>'role','crew'));
   end loop;
  end loop;
 end if;
 -- Immutable audit, materialized instructions and the durable notification
 -- queue commit together. A network retry returns this result without replay.
 update public.workflow_plans set published_revision=revision,source_snapshot=public.workflow_snapshot(p_plan),
  draft=public.workflow_snapshot(p_plan),updated_at=now() where id=p_plan returning * into p;
 insert into public.workflow_plan_revisions(plan_id,revision,action,snapshot,actor) values(p_plan,p.revision,case when p_cancel then 'cancel' else 'publish' end,p.draft,auth.uid());
 insert into public.schedule_events(assignment_id,actor,kind,payload)
  select assignment_id,auth.uid(),case when p_cancel then 'removed' else 'published' end,
   jsonb_build_object('plan_id',p_plan,'revision',p.revision) from public.workflow_plan_assignments where plan_id=p_plan;
 select array_agg(distinct id) into new_members from (
  select m.profile_id as id from public.schedule_assignment_members m join public.workflow_plan_assignments l on l.assignment_id=m.assignment_id where l.plan_id=p_plan
  union select m.profile_id from public.trip_crew m join public.workflow_plan_trips l on l.trip_id=m.trip_id where l.plan_id=p_plan
 ) x;
 insert into public.workflow_notice_outbox(plan_id,revision,profile_id)
  select p_plan,p.revision,id from (select distinct unnest(coalesce(old_members,'{}'::uuid[])||coalesce(new_members,'{}'::uuid[])) id) x;
 result:=jsonb_build_object('plan_id',p_plan,'revision',p.revision,'state',p.state,'notifications','pending');
 insert into public.workflow_publish_requests values(p_request,p_plan,fingerprint,result,now());
 return result;
end $$;

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
      (id,project_id,start_date,end_date,start_time,end_time,status,color,note,created_by,published_at,created_at,kind,created_via)
    values (right_id,a.project_id,p_day+1,a.end_date,a.start_time,a.end_time,a.status,a.color,a.note,a.created_by,a.published_at,a.created_at,a.kind,a.created_via);
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
