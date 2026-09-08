-- Connected plans own a working copy; ordinary Schedule/Travel rows remain the
-- last published instructions. Unlinked records keep their existing workflows.
create table public.workflow_plans (
 id uuid primary key default gen_random_uuid(), project_id uuid references public.projects(id),
 name text not null, revision bigint not null default 1, published_revision bigint,
 state text not null default 'active' check (state in ('active','canceled')),
 draft jsonb not null default '{}', source_snapshot jsonb not null default '{}',
 created_by uuid not null references public.profiles(id), created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.workflow_plan_assignments (
 plan_id uuid not null references public.workflow_plans(id) on delete cascade,
 assignment_id uuid primary key references public.schedule_assignments(id)
);
create table public.workflow_plan_trips (
 plan_id uuid not null references public.workflow_plans(id) on delete cascade,
 trip_id uuid primary key references public.trips(id)
);
create table public.workflow_plan_revisions (
 plan_id uuid not null references public.workflow_plans(id), revision bigint not null,
 action text not null check(action in ('publish','cancel')), snapshot jsonb not null,
 actor uuid not null references public.profiles(id), created_at timestamptz not null default now(),
 primary key(plan_id,revision)
);
create table public.workflow_publish_requests (
 request_id uuid primary key, plan_id uuid not null references public.workflow_plans(id),
 fingerprint text not null, result jsonb not null, created_at timestamptz not null default now()
);
create table public.workflow_notice_outbox (
 id uuid primary key default gen_random_uuid(), plan_id uuid not null references public.workflow_plans(id),
 revision bigint not null,
 profile_id uuid not null references public.profiles(id),
 state text not null default 'pending' check(state in ('pending','sending','sent','failed')),
 attempts integer not null default 0, lease_id uuid, lease_until timestamptz, last_error text,
 created_at timestamptz not null default now(), sent_at timestamptz,
 unique(plan_id,revision,profile_id)
);
revoke all on public.workflow_plans from public,anon,authenticated;
revoke all on public.workflow_plan_assignments from public,anon,authenticated;
revoke all on public.workflow_plan_trips from public,anon,authenticated;
revoke all on public.workflow_plan_revisions from public,anon,authenticated;
revoke all on public.workflow_publish_requests from public,anon,authenticated;
revoke all on public.workflow_notice_outbox from public,anon,authenticated;
alter table public.workflow_plans enable row level security;
alter table public.workflow_plan_assignments enable row level security;
alter table public.workflow_plan_trips enable row level security;
alter table public.workflow_plan_revisions enable row level security;
alter table public.workflow_publish_requests enable row level security;
alter table public.workflow_notice_outbox enable row level security;
create policy "workflow manager read" on public.workflow_plans for select to authenticated
 using(not public.is_partner_user() and public.travel_is_supervisor());
create policy "workflow assignment links read" on public.workflow_plan_assignments for select to authenticated
 using(not public.is_partner_user());
create policy "workflow trip links read" on public.workflow_plan_trips for select to authenticated
 using(not public.is_partner_user() and public.travel_is_supervisor());
create policy "workflow revisions manager read" on public.workflow_plan_revisions for select to authenticated
 using(not public.is_partner_user() and public.travel_is_supervisor());
create policy "workflow notices manager read" on public.workflow_notice_outbox for select to authenticated
 using(not public.is_partner_user() and public.travel_is_supervisor());
grant select on public.workflow_plans, public.workflow_plan_assignments, public.workflow_plan_trips,
 public.workflow_plan_revisions, public.workflow_notice_outbox to authenticated;
grant all on public.workflow_plans, public.workflow_plan_assignments, public.workflow_plan_trips,
 public.workflow_plan_revisions, public.workflow_publish_requests, public.workflow_notice_outbox to service_role;
-- Also fences SECURITY DEFINER inserts by the dedicated QA logins.
select public.attach_sandbox_guards();

create function public.workflow_require_manager() returns void language plpgsql security definer
set search_path=public,pg_temp as $$ begin
 if auth.uid() is null or public.is_partner_user() or not public.travel_is_supervisor() then
  raise exception 'Only an internal supervisor or owner can change a connected plan.' using errcode='42501';
 end if;
end $$;
revoke all on function public.workflow_require_manager() from public,anon,authenticated;

-- Serializing these short writes also protects conflict validation against a
-- concurrent standalone booking. STATEMENT triggers run before tuple locks,
-- avoiding the row-lock/advisory-lock inversion of a row-only design.
create function public.workflow_lock_writes() returns trigger language plpgsql
set search_path=public,pg_temp as $$ begin
 perform pg_advisory_xact_lock(639024,1); return null;
end $$;
revoke all on function public.workflow_lock_writes() from public,anon,authenticated;
create function public.workflow_guard_linked_record() returns trigger language plpgsql
set search_path=public,pg_temp as $$
declare old_id uuid; new_id uuid; linked boolean;
begin
 -- Only our definer RPCs (or a database administrator) materialize a plan.
 if current_user = 'postgres' then return coalesce(new,old); end if;
 if tg_table_name in ('schedule_assignments','trips') then
  if tg_op <> 'INSERT' then old_id:=old.id; end if;
  if tg_op <> 'DELETE' then new_id:=new.id; end if;
 elsif tg_table_name in ('schedule_assignment_members','vehicle_project_assignments') then
  if tg_op <> 'INSERT' then old_id:=old.assignment_id; end if;
  if tg_op <> 'DELETE' then new_id:=new.assignment_id; end if;
 else
  if tg_op <> 'INSERT' then old_id:=old.trip_id; end if;
  if tg_op <> 'DELETE' then new_id:=new.trip_id; end if;
 end if;
 if tg_table_name in ('schedule_assignments','schedule_assignment_members','vehicle_project_assignments') then
  select exists(select 1 from public.workflow_plan_assignments where assignment_id in (old_id,new_id)) into linked;
 else
  select exists(select 1 from public.workflow_plan_trips where trip_id in (old_id,new_id)) into linked;
 end if;
 if linked then raise exception 'Open the connected plan to review and publish this change.' using errcode='P0001'; end if;
 return coalesce(new,old);
end $$;
revoke all on function public.workflow_guard_linked_record() from public,anon,authenticated;
create trigger workflow_write_lock before insert or update or delete on public.schedule_assignments for each statement execute function public.workflow_lock_writes();
create trigger workflow_link_guard before insert or update or delete on public.schedule_assignments for each row execute function public.workflow_guard_linked_record();
create trigger workflow_write_lock before insert or update or delete on public.schedule_assignment_members for each statement execute function public.workflow_lock_writes();
create trigger workflow_link_guard before insert or update or delete on public.schedule_assignment_members for each row execute function public.workflow_guard_linked_record();
create trigger workflow_write_lock before insert or update or delete on public.vehicle_project_assignments for each statement execute function public.workflow_lock_writes();
create trigger workflow_link_guard before insert or update or delete on public.vehicle_project_assignments for each row execute function public.workflow_guard_linked_record();
create trigger workflow_write_lock before insert or update or delete on public.trips for each statement execute function public.workflow_lock_writes();
create trigger workflow_link_guard before insert or update or delete on public.trips for each row execute function public.workflow_guard_linked_record();
create trigger workflow_write_lock before insert or update or delete on public.trip_crew for each statement execute function public.workflow_lock_writes();
create trigger workflow_link_guard before insert or update or delete on public.trip_crew for each row execute function public.workflow_guard_linked_record();
create trigger workflow_write_lock before insert or update or delete on public.flights for each statement execute function public.workflow_lock_writes();
create trigger workflow_link_guard before insert or update or delete on public.flights for each row execute function public.workflow_guard_linked_record();
create trigger workflow_write_lock before insert or update or delete on public.lodging for each statement execute function public.workflow_lock_writes();
create trigger workflow_link_guard before insert or update or delete on public.lodging for each row execute function public.workflow_guard_linked_record();
create trigger workflow_write_lock before insert or update or delete on public.ground_transport for each statement execute function public.workflow_lock_writes();
create trigger workflow_link_guard before insert or update or delete on public.ground_transport for each row execute function public.workflow_guard_linked_record();
create trigger workflow_write_lock before insert or update or delete on public.procedures for each statement execute function public.workflow_lock_writes();
create trigger workflow_link_guard before insert or update or delete on public.procedures for each row execute function public.workflow_guard_linked_record();
create trigger workflow_write_lock before insert or update or delete on public.trip_contacts for each statement execute function public.workflow_lock_writes();
create trigger workflow_link_guard before insert or update or delete on public.trip_contacts for each row execute function public.workflow_guard_linked_record();
create trigger workflow_write_lock before insert or update or delete on public.trip_attachments for each statement execute function public.workflow_lock_writes();
create trigger workflow_link_guard before insert or update or delete on public.trip_attachments for each row execute function public.workflow_guard_linked_record();

-- Storage deletes happen before attachment metadata deletes in the old editor.
-- Block the byte operation itself, including renames into/out of linked packs.
create function public.workflow_guard_linked_storage() returns trigger language plpgsql security definer
set search_path=public,pg_temp as $$
begin
 if tg_op <> 'INSERT' and old.bucket_id='trip-attachments' and exists(
  select 1 from public.workflow_plan_trips where trip_id::text=split_part(old.name,'/',1)
 ) then raise exception 'Files in a connected plan are read-only.'; end if;
 if tg_op <> 'DELETE' and new.bucket_id='trip-attachments' and exists(
  select 1 from public.workflow_plan_trips where trip_id::text=split_part(new.name,'/',1)
 ) then raise exception 'Files in a connected plan are read-only.'; end if;
 return coalesce(new,old);
end $$;
revoke all on function public.workflow_guard_linked_storage() from public,anon,authenticated;
create trigger workflow_write_lock before insert or update or delete on storage.objects for each statement execute function public.workflow_lock_writes();
create trigger workflow_link_guard before insert or update or delete on storage.objects for each row execute function public.workflow_guard_linked_storage();

create function public.workflow_snapshot(p_plan uuid) returns jsonb language sql stable security definer
set search_path=public,pg_temp as $$
 select jsonb_build_object(
  'assignments',coalesce((select jsonb_agg(to_jsonb(a)||jsonb_build_object('members',
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
revoke all on function public.workflow_snapshot(uuid) from public,anon,authenticated;

create function public.workflow_create_plan(p_id uuid,p_name text,p_assignments uuid[],p_trips uuid[])
returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare project uuid; graph jsonb;
begin
 perform public.workflow_require_manager(); perform pg_advisory_xact_lock(639024,1);
 if p_id is null or nullif(trim(p_name),'') is null or coalesce(cardinality(p_assignments),0) not between 1 and 40
 or coalesce(cardinality(p_trips),0) not between 1 and 20 then
  raise exception 'Choose work and travel drafts for one job.';
 end if;
 -- Caller supplies a UUID so retries after a lost response do not make copies.
 if exists(select 1 from public.workflow_plans where id=p_id) then
  if (select name from public.workflow_plans where id=p_id)=trim(p_name)
   and (select array_agg(assignment_id order by assignment_id) from public.workflow_plan_assignments where plan_id=p_id)=(select array_agg(x order by x) from unnest(p_assignments) x)
   and (select array_agg(trip_id order by trip_id) from public.workflow_plan_trips where plan_id=p_id)=(select array_agg(x order by x) from unnest(p_trips) x)
  then return p_id; end if;
  raise exception 'This request was already used for another plan.';
 end if;
 select a.project_id into project from public.schedule_assignments a where a.id=p_assignments[1];
 if project is null or (select count(*) from public.schedule_assignments where id=any(p_assignments) and project_id=project and kind='install' and status='draft')<>cardinality(p_assignments)
 or (select count(*) from public.trips where id=any(p_trips) and project_id=project and status='draft')<>cardinality(p_trips) then
  raise exception 'Choose existing unpublished work and trips for the same job.';
 end if;
 insert into public.workflow_plans(id,project_id,name,created_by) values(p_id,project,trim(p_name),auth.uid());
 insert into public.workflow_plan_assignments select p_id,x from unnest(p_assignments) x;
 insert into public.workflow_plan_trips select p_id,x from unnest(p_trips) x;
 graph:=public.workflow_snapshot(p_id);
 update public.workflow_plans set draft=graph,source_snapshot=graph where id=p_id;
 return p_id;
end $$;
revoke all on function public.workflow_create_plan(uuid,text,uuid[],uuid[]) from public,anon;
grant execute on function public.workflow_create_plan(uuid,text,uuid[],uuid[]) to authenticated;

-- Patch only fields exposed by this review, never identity, role provenance,
-- attachment ownership or publication metadata. Detail rows/attachments remain
-- intact; adding/removing those belongs to their existing editors before linking.
create function public.workflow_save_draft(p_plan uuid,p_expected bigint,p_draft jsonb)
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
  select value into original from jsonb_array_elements(plan.draft->'assignments') where value->>'id'=a->>'id';
  if original is null or (a-array['start_date','end_date','start_time','note','members']) is distinct from (original-array['start_date','end_date','start_time','note','members']) then raise exception 'The work identity cannot be changed.'; end if;
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
revoke all on function public.workflow_save_draft(uuid,bigint,jsonb) from public,anon;
grant execute on function public.workflow_save_draft(uuid,bigint,jsonb) to authenticated;

-- JSON array estimates greatly overstate this bounded (40-block) review.
-- Avoid seconds of JIT compilation for a millisecond-scale conflict lookup.
create function public.workflow_conflicts(p_plan uuid) returns jsonb language sql stable security definer
set search_path=public,pg_temp set jit=off as $$
 with draft as (select draft from public.workflow_plans where id=p_plan),
 planned as (select a->>'id' as id,(a->>'start_date')::date as starts,(a->>'end_date')::date as ends,a->'members' as members from draft,jsonb_array_elements(draft->'assignments') a),
 others as (select a.id::text as id,a.start_date as starts,a.end_date as ends,
  coalesce((select jsonb_agg(jsonb_build_object('profile_id',m.profile_id)) from public.schedule_assignment_members m where m.assignment_id=a.id),'[]'::jsonb) as members
  from public.schedule_assignments a where a.status<>'canceled' and not exists(select 1 from planned p where p.id=a.id::text)),
 crew as (select distinct 'crew'::text as kind,p.id as assignment_id,o.id as other_id,m->>'profile_id' as resource_id
  from planned p cross join lateral jsonb_array_elements(p.members) m
  join (select * from others union all select * from planned) o on p.id<>o.id and p.starts<=o.ends and o.starts<=p.ends
  where exists(select 1 from jsonb_array_elements(o.members) om where om->>'profile_id'=m->>'profile_id')),
 vehicles as (select 'vehicle'::text as kind,p.id as assignment_id,v.assignment_id::text as other_id,v.vehicle_id::text as resource_id
  from draft cross join lateral jsonb_array_elements(draft->'vehicles') b join planned p on p.id=b->>'assignment_id'
  join public.vehicle_project_assignments v on v.vehicle_id=(b->>'vehicle_id')::uuid and v.assignment_id is not null
   and not exists(select 1 from planned own where own.id=v.assignment_id::text)
   and v.start_date<=p.ends and p.starts<=v.end_date
  join public.schedule_assignments a on a.id=v.assignment_id and a.status<>'canceled'),
 within_vehicles as (select 'vehicle'::text as kind,p.id as assignment_id,q.id as other_id,b->>'vehicle_id' as resource_id
  from draft cross join lateral jsonb_array_elements(draft->'vehicles') b
  cross join lateral jsonb_array_elements(draft->'vehicles') c
  join planned p on p.id=b->>'assignment_id' join planned q on q.id=c->>'assignment_id'
  where b->>'vehicle_id'=c->>'vehicle_id' and p.id<>q.id and p.starts<=q.ends and q.starts<=p.ends)
 select coalesce(jsonb_agg(to_jsonb(c)||jsonb_build_object('other_start_date',o.starts,'other_end_date',o.ends,'other_project_id',a.project_id) order by c.kind,c.assignment_id,c.other_id,c.resource_id),'[]'::jsonb)
 from (select * from crew union select * from vehicles union select * from within_vehicles) c
 left join (select * from others union all select * from planned) o on o.id=c.other_id
 left join public.schedule_assignments a on a.id::text=c.other_id;
$$;
revoke all on function public.workflow_conflicts(uuid) from public,anon,authenticated;

create function public.workflow_review_plan(p_plan uuid) returns jsonb language plpgsql security definer
set search_path=public,pg_temp as $$
declare p public.workflow_plans; conflicts jsonb;
begin
 perform public.workflow_require_manager();
 select * into strict p from public.workflow_plans where id=p_plan;
 conflicts:=public.workflow_conflicts(p_plan);
 return to_jsonb(p)||jsonb_build_object('conflicts',conflicts,'review_token',md5(p.draft::text||conflicts::text),
  'conflict_assignments',coalesce((select jsonb_agg(to_jsonb(a)) from public.schedule_assignments a where a.id::text in (select c->>'other_id' from jsonb_array_elements(conflicts) c)),'[]'::jsonb),
  'notices',coalesce((select jsonb_agg(jsonb_build_object('state',state,'count',n)) from
   (select state,count(*) n from public.workflow_notice_outbox where plan_id=p_plan group by state) x),'[]'::jsonb));
end $$;
revoke all on function public.workflow_review_plan(uuid) from public,anon;
grant execute on function public.workflow_review_plan(uuid) to authenticated;

create function public.workflow_publish_plan(p_plan uuid,p_expected bigint,p_request uuid,p_review_token text,p_allow_crew_conflicts boolean default false,p_cancel boolean default false)
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
    start_time=(a->>'start_time')::time,note=a->>'note',status='published',published_at=now(),updated_at=now() where id=(a->>'id')::uuid;
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
revoke all on function public.workflow_publish_plan(uuid,bigint,uuid,text,boolean,boolean) from public,anon;
grant execute on function public.workflow_publish_plan(uuid,bigint,uuid,text,boolean,boolean) to authenticated;

-- Published crew navigation uses explicit plan links, not one guessed trip per
-- project. Two rotations remain two named links and work/travel dates stay apart.
create function public.workflow_my_trip_links() returns table(assignment_id uuid,trip_id uuid,name text,start_date date,end_date date)
language sql stable security definer set search_path=public,pg_temp as $$
 select a.assignment_id,t.id,t.name,t.start_date,t.end_date from public.workflow_plan_assignments a
 join public.workflow_plans p on p.id=a.plan_id and p.state='active' and p.published_revision is not null
 join public.workflow_plan_trips l on l.plan_id=p.id join public.trips t on t.id=l.trip_id
 where auth.uid() is not null and not public.is_partner_user() and public.travel_can_read_trip(t.id)
 and (public.travel_is_supervisor() or exists(select 1 from public.schedule_assignment_members m where m.assignment_id=a.assignment_id and m.profile_id=auth.uid()));
$$;
revoke all on function public.workflow_my_trip_links() from public,anon;
grant execute on function public.workflow_my_trip_links() to authenticated;

-- Claim/finish are service-role only. Leases permit a crashed sender to retry;
-- the stable browser notification tag collapses at-least-once push delivery.
create function public.workflow_claim_notices(p_plan uuid,p_lease uuid) returns setof public.workflow_notice_outbox
language sql security definer set search_path=public,pg_temp as $$
 update public.workflow_notice_outbox set state='sending',lease_id=p_lease,lease_until=now()+interval '2 minutes',attempts=attempts+1
 where id in(select id from public.workflow_notice_outbox where plan_id=p_plan
 and exists(select 1 from public.workflow_plans p where p.id=p_plan and p.project_id is not null)
 and (state in ('pending','failed') or (state='sending' and lease_until<now())) order by created_at,id limit 20 for update skip locked)
 returning *;
$$;
revoke all on function public.workflow_claim_notices(uuid,uuid) from public,anon,authenticated;
grant execute on function public.workflow_claim_notices(uuid,uuid) to service_role;
create function public.workflow_finish_notice(p_id uuid,p_lease uuid,p_sent boolean) returns void
language sql security definer set search_path=public,pg_temp as $$
 update public.workflow_notice_outbox set state=case when p_sent then 'sent' else 'failed' end,
 sent_at=case when p_sent then now() else null end,last_error=case when p_sent then null else 'Push delivery failed or no subscribed device.' end,
 lease_id=null,lease_until=null where id=p_id and lease_id=p_lease and state='sending';
$$;
revoke all on function public.workflow_finish_notice(uuid,uuid,boolean) from public,anon,authenticated;
grant execute on function public.workflow_finish_notice(uuid,uuid,boolean) to service_role;

create function public.workflow_discard_plan(p_plan uuid,p_expected bigint) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
declare p public.workflow_plans;
begin
 perform public.workflow_require_manager(); perform pg_advisory_xact_lock(639024,1);
 select * into strict p from public.workflow_plans where id=p_plan for update;
 if p.revision<>p_expected or p.published_revision is not null then raise exception 'Only an unpublished plan can be disconnected.'; end if;
 delete from public.workflow_plans where id=p_plan;
end $$;
revoke all on function public.workflow_discard_plan(uuid,bigint) from public,anon;
grant execute on function public.workflow_discard_plan(uuid,bigint) to authenticated;

-- Preserve plan authorship and notice history when an owner removes a login.
create or replace function public.person_record_counts(p_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'workflow_plans.created_by', (select count(*) from workflow_plans where created_by = p_id),
    'workflow_plan_revisions.actor', (select count(*) from workflow_plan_revisions where actor = p_id),
    'workflow_notice_outbox.profile_id', (select count(*) from workflow_notice_outbox where profile_id = p_id),
    -- Time and money.
    'time_shifts.profile_id',
      (select count(*) from time_shifts where profile_id = p_id),
    'unit_sessions.profile_id',
      (select count(*) from unit_sessions where profile_id = p_id),
    'install_events.installer_id',
      (select count(*) from install_events where installer_id = p_id),
    'install_events.credited_to',
      (select count(*) from install_events where credited_to = p_id),
    'receipts.uploaded_by',
      (select count(*) from receipts where uploaded_by = p_id),
    'pay_rates.profile_id',
      (select count(*) from pay_rates where profile_id = p_id),
    'overtime_rules.profile_id',
      (select count(*) from overtime_rules where profile_id = p_id),
    'timecard_periods.profile_id',
      (select count(*) from timecard_periods where profile_id = p_id),
    'time_shift_edits.edited_by',
      (select count(*) from time_shift_edits where edited_by = p_id),
    -- Safety and training.
    'certifications.profile_id',
      (select count(*) from certifications where profile_id = p_id),
    'toolbox_completions.profile_id',
      (select count(*) from toolbox_completions where profile_id = p_id),
    'safety_acks.profile_id',
      (select count(*) from safety_acks where profile_id = p_id),
    'capability_badges.installer_id',
      (select count(*) from capability_badges where installer_id = p_id),
    'installer_clearance.installer_id',
      (select count(*) from installer_clearance where installer_id = p_id),
    'learn_progress.profile_id',
      (select count(*) from learn_progress where profile_id = p_id),
    'learning_video_quiz_attempts.profile_id',
      (select count(*) from learning_video_quiz_attempts where profile_id = p_id),
    'education_credits.profile_id',
      (select count(*) from education_credits where profile_id = p_id),
    -- The job site.
    'daily_logs.filed_by',
      (select count(*) from daily_logs where filed_by = p_id),
    'opening_phases.started_by',
      (select count(*) from opening_phases where started_by = p_id),
    'opening_phases.submitted_by',
      (select count(*) from opening_phases where submitted_by = p_id),
    'flash_run_assignments.assigned_by',
      (select count(*) from flash_run_assignments where assigned_by = p_id),
    'flash_run_assignments.profile_id',
      (select count(*) from flash_run_assignments where profile_id = p_id),
    'summons.requested_by',
      (select count(*) from summons where requested_by = p_id),
    'summon_helpers.profile_id',
      (select count(*) from summon_helpers where profile_id = p_id),
    'summon_declines.profile_id',
      (select count(*) from summon_declines where profile_id = p_id),
    'unit_redos.pressed_by',
      (select count(*) from unit_redos where pressed_by = p_id),
    'schedule_assignment_members.profile_id',
      (select count(*) from schedule_assignment_members where profile_id = p_id),
    'trip_crew.profile_id',
      (select count(*) from trip_crew where profile_id = p_id),
    'vehicle_drivers.profile_id',
      (select count(*) from vehicle_drivers where profile_id = p_id),
    -- What they said and what they were given credit for.
    'points_ledger.profile_id',
      (select count(*) from points_ledger where profile_id = p_id),
    'task_sessions.profile_id',
      (select count(*) from task_sessions where profile_id = p_id),
    'project_messages.author_id',
      (select count(*) from project_messages where author_id = p_id),
    'ask_question_log.asker_id',
      (select count(*) from ask_question_log where asker_id = p_id)
  );
$$;

comment on function public.person_record_counts(uuid) is
  'How many rows of work, money and safety record one person has, keyed table.column. The input to "remove this login": nothing anywhere means the account can be deleted outright, anything at all means it is retired and every row kept. Service role only — manage-crew-access checks the caller is the owner before it asks.';

revoke all on function public.person_record_counts(uuid) from public, anon, authenticated;
grant execute on function public.person_record_counts(uuid) to service_role;

-- Preserve the existing detach/purge order when a connected job is erased.
create or replace function public.purge_project(p_project_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_project projects;
  v_job_name text;
  v_install_media_paths text[];
  v_issue_photo_paths text[];
begin
  if auth.uid() is not null and not _is_supervisor(auth.uid()) then
    raise exception 'Only a supervisor or above can permanently delete a job.' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(639024,1);

  select * into v_project from projects where id = p_project_id for update;
  if v_project.id is null then
    raise exception 'That job does not exist.';
  end if;
  if v_project.deleted_at is null then
    raise exception 'That job is not in the trash.';
  end if;
  v_job_name := v_project.name;

  -- ---------------------------------------------------------------------
  -- STEP 0 — every detach runs first, inside this one transaction, so no
  -- FK can block a delete below (movements' FK carries NO on-delete rule
  -- at all — it would abort the whole purge if it still pointed at this
  -- job when the projects row goes).
  -- ---------------------------------------------------------------------
  -- Retain plan/revision history with the surviving travel instructions, but
  -- release live links before Schedule rows are purged. No queued notice for
  -- a purged job is claimable (workflow_claim_notices requires project_id).
  delete from workflow_plan_assignments where plan_id in (select id from workflow_plans where project_id=p_project_id);
  delete from workflow_plan_trips where plan_id in (select id from workflow_plans where project_id=p_project_id);
  update workflow_plans set project_id=null,state='canceled',updated_at=now() where project_id=p_project_id;

  update movements set project_id = null, job_name = coalesce(job_name, v_job_name)
   where project_id = p_project_id;
  update windows set project_id = null, job_name = coalesce(job_name, v_job_name)
   where project_id = p_project_id;
  update packages set project_id = null, pending_job_name = coalesce(pending_job_name, v_job_name)
   where project_id = p_project_id;
  update time_shifts set project_id = null, job_name = coalesce(job_name, v_job_name)
   where project_id = p_project_id;
  update task_sessions set project_id = null
   where project_id = p_project_id;
  update incidents set project_id = null, job_name = coalesce(job_name, v_job_name)
   where project_id = p_project_id;
  update service_cases set project_id = null, job_name = coalesce(job_name, v_job_name)
   where project_id = p_project_id;
  update trips set project_id = null, job_name = coalesce(job_name, v_job_name)
   where project_id = p_project_id;
  update receipts set project_id = null, pending_job_name = coalesce(pending_job_name, v_job_name)
   where project_id = p_project_id;
  update studio_projects set project_id = null
   where project_id = p_project_id;
  update monday_jobs set project_id = null
   where project_id = p_project_id;
  update job_costs set project_id = null, job_name = coalesce(job_name, v_job_name)
   where project_id = p_project_id;
  update change_orders set project_id = null, job_name = coalesce(job_name, v_job_name)
   where project_id = p_project_id;
  update daily_logs set project_id = null, job_name = coalesce(job_name, v_job_name)
   where project_id = p_project_id;

  -- OPEN Q4: a damage report on a package that survives detaches WITH the
  -- package (project_id nulled, row and photo kept); every other issue on
  -- this job purges below.
  update issues
     set project_id = null
   where project_id = p_project_id
     and kind = 'damage' and package_id is not null;

  -- AUDIT HOLES 3+4: attachments dual-anchored to a surviving physical thing
  -- (window, package, or service case) detach — unlink install_event_id and
  -- project_id, keep the row and its storage file untouched. Two passes:
  -- rows already carrying this project's id, and (defense in depth, in case
  -- a row was ever written without project_id set) rows reached only via
  -- install_event_id whose event belongs to one of this job's openings.
  update attachments
     set install_event_id = null, project_id = null
   where project_id = p_project_id
     and (window_id is not null or package_id is not null or service_case_id is not null);

  update attachments a
     set install_event_id = null, project_id = null
    from install_events ie, project_openings po
   where a.install_event_id = ie.id
     and ie.project_opening_id = po.id
     and po.project_id = p_project_id
     and (a.window_id is not null or a.package_id is not null or a.service_case_id is not null);

  -- OPEN Q3 / ADR-0004: snapshot the mark's text onto every package_marks
  -- row still pointing at one of this job's marks, THEN unlink — must
  -- happen before project_marks purges below, or the RESTRICT FK aborts.
  update package_marks pm
     set mark_code = coalesce(pm.mark_code, pmk.mark_code)
    from project_marks pmk
   where pm.mark_id = pmk.id and pmk.project_id = p_project_id;

  update package_marks
     set mark_id = null
   where mark_id in (select id from project_marks where project_id = p_project_id);

  -- ---------------------------------------------------------------------
  -- The purge order. summon_helpers/summon_declines cascade from summons;
  -- install_events/qc_checks/opening_phases/opening_notes/unit_redos/
  -- unit_sessions/project_opening_pin_moves/install_event_time_repairs all
  -- cascade from project_openings (verified against each table's own
  -- migration) — one delete of the parent takes the whole branch.
  -- project_planset_pages cascades from project_plansets the same way.
  -- ---------------------------------------------------------------------
  delete from summons where project_id = p_project_id;

  -- Gather storage paths BEFORE deleting the rows that name them: install
  -- photos anchored only to this job's install_events (no surviving window/
  -- package/service_case — the survivors above already lost that link), and
  -- opening_phases' finished-work photos, which carry no attachments row of
  -- their own and are about to cascade away with project_openings below.
  select coalesce(array_agg(path), '{}') into v_install_media_paths
    from (
      select a.storage_path as path
        from attachments a
        join install_events ie on ie.id = a.install_event_id
        join project_openings po on po.id = ie.project_opening_id
       where po.project_id = p_project_id
      union all
      select op.photo_path
        from opening_phases op
        join project_openings po on po.id = op.opening_id
       where po.project_id = p_project_id and op.photo_path is not null
    ) paths;

  delete from attachments a
   using install_events ie, project_openings po
   where a.install_event_id = ie.id
     and ie.project_opening_id = po.id
     and po.project_id = p_project_id;

  -- Issues: gather photo paths of what purges (the surviving package-damage
  -- carve-out above already left this project, so it is excluded here).
  select coalesce(array_agg(photo_path), '{}') into v_issue_photo_paths
    from issues where project_id = p_project_id and photo_path is not null;

  delete from issues where project_id = p_project_id;

  -- Takes install_events, qc_checks, opening_phases, opening_notes,
  -- unit_redos, unit_sessions, project_opening_pin_moves and
  -- install_event_time_repairs with it.
  delete from project_openings where project_id = p_project_id;

  -- Takes project_planset_pages with it.
  delete from project_mark_elevation_views where project_id = p_project_id;
  delete from project_plan_outlines where project_id = p_project_id;
  delete from project_plansets where project_id = p_project_id;
  delete from project_spec_discrepancies where project_id = p_project_id;
  delete from project_mark_specs where project_id = p_project_id;
  -- package_marks already unlinked above, so this can never hit RESTRICT.
  delete from project_marks where project_id = p_project_id;
  delete from project_windows where project_id = p_project_id;
  delete from job_notes where project_id = p_project_id;
  delete from supply_orders where project_id = p_project_id;
  delete from flash_run_assignments where project_id = p_project_id;
  delete from schedule_assignments where project_id = p_project_id;
  delete from vehicle_project_assignments where project_id = p_project_id;
  delete from takeoffs where project_id = p_project_id;
  delete from project_message_reads where project_id = p_project_id;
  delete from project_messages where project_id = p_project_id;
  delete from project_cost_codes where project_id = p_project_id;
  delete from sandbox_projects where project_id = p_project_id;
  delete from partner_job_grants where project_id = p_project_id;

  -- Storage cleanup: SQL DELETE against storage.objects — the bytes become
  -- unreachable in the bucket, there is no separate "delete the file" step
  -- this migration can call from SQL. Files go second-to-last, right before
  -- the projects row, so a crash mid-purge leaves harmless orphan files in
  -- the bucket, never a row pointing at a file that is already gone.
  delete from storage.objects
   where bucket_id = 'plansets' and name like p_project_id::text || '/%';

  delete from storage.objects
   where bucket_id = 'install-media' and name = any (v_install_media_paths);

  delete from storage.objects
   where bucket_id = 'issue-photos' and name = any (v_issue_photo_paths);

  delete from projects where id = p_project_id;
end;
$$;

comment on function public.purge_project(uuid) is
  'The permanent erase: supervisor+ when called directly, and fed expired ids by purge_expired_projects (nightly pg_cron sweep, no auth.uid() in that context — trusted the same way a migration or the service key is). Refuses a job that does not exist or is not currently in the trash; does NOT re-check the 30-day deadline itself. Runs the full detach-then-purge order the census specifies. Preserves detached connected-plan history and releases its live links before the existing purge order.';

revoke all on function public.purge_project(uuid) from public, anon;
grant execute on function public.purge_project(uuid) to authenticated;
