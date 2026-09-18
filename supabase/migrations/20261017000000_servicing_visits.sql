-- Service visits are repair evidence; payroll stays in time_shifts and original installs stay intact.
begin;
create table public.service_job_supervisors (
  project_id uuid primary key references projects(id) on delete cascade,
  profile_id uuid references profiles(id) on delete set null
);
create table public.service_visits (
  id uuid primary key,
  project_id uuid not null references projects(id) on delete cascade,
  created_by uuid references profiles(id) on delete set null,
  previous_visit_id uuid references service_visits(id) on delete set null,
  status text not null default 'active' check(status in ('active','completed')),
  details jsonb not null default '{}',
  revision integer not null default 1,
  completed_at timestamptz,
  reviewed_by uuid references profiles(id) on delete set null,
  reviewed_at timestamptz,
  allocation jsonb,
  lodging_message_id uuid references project_messages(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.service_visit_units (
  id uuid primary key,
  visit_id uuid not null references service_visits(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  created_by uuid references profiles(id) on delete set null,
  work_unit_id uuid references custom_work_units(id) on delete set null,
  opening_id uuid references project_openings(id) on delete set null,
  window_id uuid references windows(id) on delete set null,
  legacy_case_id uuid references service_cases(id) on delete set null,
  label text not null check(length(btrim(label)) between 1 and 120),
  type_label text not null default 'Unknown' check(length(type_label) between 1 and 100),
  facts jsonb not null default '{}',
  issue text not null check(length(btrim(issue)) between 1 and 4000),
  fail_point text not null default '' check(length(fail_point)<=200),
  cause text not null default 'pending' check(cause in ('pending','manufacturer','customer','installer')),
  repair text not null default '' check(length(repair)<=8000),
  verification text not null default '' check(length(verification)<=4000),
  prevention text not null default '' check(length(prevention)<=4000),
  next_steps text not null default '' check(length(next_steps)<=4000),
  memo_text text not null default '' check(length(memo_text)<=20000),
  evidence_exception text not null default '' check(length(evidence_exception)<=2000),
  outcome text not null default 'open' check(outcome in ('open','resolved','temporary','return_needed')),
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index service_unit_work_once on service_visit_units(visit_id,work_unit_id) where work_unit_id is not null;
create unique index service_unit_opening_once on service_visit_units(visit_id,opening_id) where opening_id is not null;
create table public.service_time_sessions (
  id uuid primary key,
  visit_id uuid not null references service_visits(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  unit_id uuid references service_visit_units(id) on delete cascade,
  shift_id uuid not null references time_shifts(id) on delete cascade,
  profile_id uuid not null references profiles(id) on delete cascade,
  kind text not null check(kind in ('unit','idle','travel')),
  stage text not null check(length(stage) between 1 and 100),
  description text not null default '' check(length(description)<=4000),
  started_at timestamptz not null,
  ended_at timestamptz,
  end_reason text,
  review_required boolean not null default false,
  check((kind='unit')=(unit_id is not null)),
  check(ended_at is null or ended_at>=started_at)
);
create unique index service_one_open on service_time_sessions(profile_id) where ended_at is null;
create index service_time_visit on service_time_sessions(visit_id,started_at);
create table public.service_media (
  id uuid primary key,
  visit_id uuid not null references service_visits(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  unit_id uuid references service_visit_units(id) on delete cascade,
  created_by uuid references profiles(id) on delete set null,
  kind text not null check(kind in ('before','after','photo','voice','video','receipt')),
  storage_path text not null unique,
  filename text not null check(length(filename) between 1 and 240),
  content_type text not null,
  bytes bigint not null check(bytes>0 and bytes<=104857600),
  caption text not null default '' check(length(caption)<=2000),
  transcript text not null default '' check(length(transcript)<=20000),
  revision integer not null default 1,
  created_at timestamptz not null default now()
);
create table public.service_commands (
  id uuid primary key,
  profile_id uuid references profiles(id) on delete cascade,
  payload jsonb not null, result_id uuid, created_at timestamptz not null default now()
);
create table public.service_audit (
  id bigint generated always as identity primary key,
  project_id uuid not null references projects(id) on delete cascade,
  visit_id uuid references service_visits(id) on delete cascade,
  actor_id uuid references profiles(id) on delete set null,
  action text not null, entity_id uuid, before_value jsonb, after_value jsonb,
  created_at timestamptz not null default now()
);
create function public.service_internal() returns boolean language sql stable security definer set search_path=public,pg_temp as $$
  select auth.uid() is not null and not public.is_partner_user() and exists(
    select 1 from profiles where id=auth.uid() and active and retired_at is null and access_revoked_at is null
      and role in ('installer','foreman','supervisor','owner'))
$$;
create function public.service_job_access(j uuid) returns boolean language sql stable security definer set search_path=public,pg_temp as $$
  select public.service_internal() and exists(select 1 from projects where id=j and deleted_at is null
    and (not is_test or exists(select 1 from profiles where id=auth.uid() and role in ('supervisor','owner'))))
$$;
create function public.service_supervisor() returns boolean language sql stable security definer set search_path=public,pg_temp as $$
  select public.service_internal() and exists(select 1 from profiles where id=auth.uid() and role in ('supervisor','owner'))
$$;
revoke all on function public.service_internal() from public,anon;
grant execute on function public.service_internal() to authenticated;
revoke all on function public.service_job_access(uuid) from public,anon;
grant execute on function public.service_job_access(uuid) to authenticated;
revoke all on function public.service_supervisor() from public,anon;
grant execute on function public.service_supervisor() to authenticated;

alter table public.service_job_supervisors enable row level security;
revoke all on public.service_job_supervisors from public,anon,authenticated;
grant select on public.service_job_supervisors to authenticated;
create policy service_read on public.service_job_supervisors for select to authenticated using(not public.is_partner_user() and public.service_job_access(project_id));
alter table public.service_visits enable row level security;
revoke all on public.service_visits from public,anon,authenticated;
grant select on public.service_visits to authenticated;
create policy service_read on public.service_visits for select to authenticated using(not public.is_partner_user() and public.service_job_access(project_id));
alter table public.service_visit_units enable row level security;
revoke all on public.service_visit_units from public,anon,authenticated;
grant select on public.service_visit_units to authenticated;
create policy service_read on public.service_visit_units for select to authenticated using(not public.is_partner_user() and public.service_job_access(project_id));
alter table public.service_time_sessions enable row level security;
revoke all on public.service_time_sessions from public,anon,authenticated;
grant select on public.service_time_sessions to authenticated;
create policy service_read on public.service_time_sessions for select to authenticated using(not public.is_partner_user() and public.service_job_access(project_id));
alter table public.service_media enable row level security;
revoke all on public.service_media from public,anon,authenticated;
grant select on public.service_media to authenticated;
create policy service_read on public.service_media for select to authenticated using(not public.is_partner_user() and public.service_job_access(project_id));
alter table public.service_commands enable row level security;
revoke all on public.service_commands from public,anon,authenticated;
alter table public.service_audit enable row level security;
revoke all on public.service_audit from public,anon,authenticated;
grant select on public.service_audit to authenticated;
create policy service_read on public.service_audit for select to authenticated using(not public.is_partner_user() and public.service_job_access(project_id));

-- Installers may read a service crew report without gaining access to anyone else's
-- payroll card, rates, notes or location. Only the bounds needed to reconcile this visit.
create function public.service_shift_bounds(p_visit uuid) returns jsonb
language sql stable security definer set search_path=public,pg_temp as $$
  select coalesce(jsonb_object_agg(q.id::text,jsonb_build_object('clock_in_at',q.clock_in_at,'clock_out_at',q.clock_out_at,'break_seconds',q.break_seconds,'status',q.status,'project_id',q.project_id)),'{}'::jsonb)
  from (select distinct sh.id,sh.clock_in_at,sh.clock_out_at,sh.break_seconds,sh.status,sh.project_id
    from service_time_sessions ss join service_visits v on v.id=ss.visit_id join time_shifts sh on sh.id=ss.shift_id
    where v.id=p_visit and public.service_job_access(v.project_id)) q
$$;
revoke all on function public.service_shift_bounds(uuid) from public,anon;
grant execute on function public.service_shift_bounds(uuid) to authenticated;

-- Kept distinct from customer/installer evidence. Only supervisors decide shared costs.
create function public.service_validate_details(d jsonb) returns void language plpgsql set search_path=public,pg_temp as $$
declare k text; v jsonb; begin
  if jsonb_typeof(d) is distinct from 'object' or octet_length(d::text)>30000 then raise exception 'Service details are too large.'; end if;
  for k,v in select * from jsonb_each(d) loop
    if k not in ('crew_names','truck','truck_id','estimated_miles','actual_miles','lodging','travel_notes','scheduled_date','lodging_cost','parts_cost','other_cost') then raise exception 'Unknown service detail.'; end if;
    if k in ('estimated_miles','actual_miles','lodging_cost','parts_cost','other_cost') then
      if jsonb_typeof(v)<>'number' or (v::text)::numeric<0 or (v::text)::numeric>100000 then raise exception 'Enter a valid nonnegative amount.'; end if;
    elsif k='lodging' then
      if jsonb_typeof(v)<>'boolean' then raise exception 'Choose whether lodging is needed.'; end if;
    elsif jsonb_typeof(v)<>'string' or length(v #>> '{}')>4000 then raise exception 'Enter a short service detail.'; end if;
  end loop;
end $$;
revoke all on function public.service_validate_details(jsonb) from public,anon,authenticated;

-- Atomic chat creation means a saved lodging request cannot pretend that a local draft was delivered.
create function public.service_notify_lodging(target uuid) returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare v service_visits; recipients uuid[]; message_id uuid; job text;
begin
  select * into v from service_visits where id=target for update;
  if not coalesce((v.details->>'lodging')::boolean,false) or v.lodging_message_id is not null then return; end if;
  select array_agg(p.id) into recipients from service_job_supervisors s join profiles p on p.id=s.profile_id
    where s.project_id=v.project_id and p.active and p.retired_at is null and p.access_revoked_at is null and p.role in ('supervisor','owner');
  if coalesce(cardinality(recipients),0)=0 then
    select array_agg(id) into recipients from profiles where active and retired_at is null and access_revoked_at is null and role='supervisor';
  end if;
  if coalesce(cardinality(recipients),0)=0 then return; end if;
  select job_code||' · '||name into job from projects where id=v.project_id;
  message_id:=gen_random_uuid();
  insert into project_messages(id,project_id,author_id,body,mentions) values(message_id,v.project_id,auth.uid(),
    'Lodging needed for service: '||job||E'\nCrew: '||coalesce(nullif(v.details->>'crew_names',''),'See service visit')||E'\nDate: '||coalesce(nullif(v.details->>'scheduled_date',''),'Confirm with requester')||E'\nhttps://app.forgewd.com/service?visit='||v.id,recipients);
  update service_visits set lodging_message_id=message_id where id=v.id;
end $$;
revoke all on function public.service_notify_lodging(uuid) from public,anon,authenticated;

create function public.service_command(p_id uuid,p_action text,p_data jsonb) returns uuid
language plpgsql security definer set search_path=public,pg_temp as $$
declare uid uuid:=auth.uid(); c service_commands; v service_visits; u service_visit_units;
  s service_time_sessions; sh time_shifts; m service_media; oldj jsonb; afterj jsonb;
  target uuid; jid uuid; result uuid; at_time timestamptz; boundary timestamptz; expected uuid; v_details jsonb; recipient uuid; total numeric;
begin
  if not public.service_internal() then raise exception 'An active Forge crew login is required.' using errcode='42501'; end if;
  if p_id is null or jsonb_typeof(p_data) is distinct from 'object' or octet_length(p_data::text)>100000 then raise exception 'Invalid service request.'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_id::text,7482));
  perform pg_advisory_xact_lock(hashtextextended(uid::text,7281));
  select * into c from service_commands where id=p_id;
  if found then
    if c.profile_id<>uid or c.payload<>jsonb_build_object('action',p_action,'data',p_data) then raise exception 'This retry belongs to another request.'; end if;
    return c.result_id;
  end if;
  target:=nullif(p_data->>'visit_id','')::uuid;
  if target is not null then
    select * into v from service_visits where id=target for update;
    if not found or not public.service_job_access(v.project_id) then raise exception 'That service visit is unavailable.' using errcode='42501'; end if;
    jid:=v.project_id;
  else jid:=(p_data->>'project_id')::uuid;
  end if;
  if not public.service_job_access(jid) then raise exception 'That job is unavailable.' using errcode='42501'; end if;
  if p_action not in ('visit','supervisor') and v.id is null then raise exception 'Choose a service visit.'; end if;
  if p_action='supervisor' then
    if not public.service_supervisor() then raise exception 'Only a supervisor can assign the job supervisor.' using errcode='42501'; end if;
    recipient:=nullif(p_data->>'profile_id','')::uuid;
    if recipient is not null and not exists(select 1 from profiles where id=recipient and active and retired_at is null and access_revoked_at is null and role in ('supervisor','owner')) then raise exception 'Choose an active supervisor or owner.'; end if;
    select to_jsonb(x) into oldj from service_job_supervisors x where project_id=jid;
    insert into service_job_supervisors(project_id,profile_id) values(jid,recipient) on conflict(project_id) do update set profile_id=excluded.profile_id;
    result:=jid; afterj:=jsonb_build_object('profile_id',recipient);
  elsif p_action='visit' then
    v_details:=coalesce(p_data->'details','{}'); perform service_validate_details(v_details);
    if v.id is null then
      result:=(p_data->>'id')::uuid;
      if nullif(p_data->>'previous_visit_id','') is not null and not exists(select 1 from service_visits where id=(p_data->>'previous_visit_id')::uuid and project_id=jid) then raise exception 'The earlier visit belongs to another job.'; end if;
      insert into service_visits(id,project_id,created_by,previous_visit_id,details) values(result,jid,uid,nullif(p_data->>'previous_visit_id','')::uuid,v_details);
      target:=result;
    else
      if v.created_by is distinct from uid and not public._is_lead(uid) then raise exception 'The visit creator or a foreman can edit trip details.' using errcode='42501'; end if;
      if v.revision is distinct from (p_data->>'revision')::int then raise exception 'This visit changed. Refresh before saving.'; end if;
      oldj:=to_jsonb(v); result:=v.id;
      update service_visits x set details=p_data->'details',revision=x.revision+1,reviewed_at=null,reviewed_by=null,updated_at=now() where x.id=v.id;
    end if;
    perform service_notify_lodging(result);
    select to_jsonb(x) into afterj from service_visits x where id=result;
  elsif p_action='unit' then
    if v.id is null then raise exception 'Choose a service visit.'; end if;
    select * into u from service_visit_units where id=(p_data->>'id')::uuid for update;
    if found then
      if u.visit_id<>v.id or (u.created_by is distinct from uid and v.created_by is distinct from uid and not public._is_lead(uid)) then raise exception 'This unit is not editable from this visit.' using errcode='42501'; end if;
      if u.revision is distinct from (p_data->>'revision')::int then raise exception 'This unit changed. Refresh before saving.'; end if;
      oldj:=to_jsonb(u);
    end if;
    if nullif(p_data->>'work_unit_id','') is not null and not exists(select 1 from custom_work_units where id=(p_data->>'work_unit_id')::uuid and project_id=jid) then raise exception 'That saved unit belongs to another job.'; end if;
    if nullif(p_data->>'opening_id','') is not null and not exists(select 1 from project_openings where id=(p_data->>'opening_id')::uuid and project_id=jid and removed_at is null) then raise exception 'That mapped unit is unavailable.'; end if;
    if nullif(p_data->>'window_id','') is not null and not exists(select 1 from windows where id=(p_data->>'window_id')::uuid and project_id=jid) then raise exception 'That warehouse unit belongs to another job.'; end if;
    if nullif(p_data->>'legacy_case_id','') is not null and not exists(select 1 from service_cases where id=(p_data->>'legacy_case_id')::uuid and project_id=jid) then raise exception 'That earlier case belongs to another job.'; end if;
    perform validate_custom_work_facts(coalesce(p_data->'facts','{}'));
    result:=(p_data->>'id')::uuid;
    insert into service_visit_units(id,visit_id,project_id,created_by,work_unit_id,opening_id,window_id,legacy_case_id,label,type_label,facts,issue,fail_point,cause,repair,verification,prevention,next_steps,memo_text,evidence_exception,outcome)
    values(result,v.id,jid,uid,nullif(p_data->>'work_unit_id','')::uuid,nullif(p_data->>'opening_id','')::uuid,nullif(p_data->>'window_id','')::uuid,nullif(p_data->>'legacy_case_id','')::uuid,
      p_data->>'label',coalesce(p_data->>'type_label','Unknown'),coalesce(p_data->'facts','{}'),p_data->>'issue',coalesce(p_data->>'fail_point',''),coalesce(p_data->>'cause','pending'),coalesce(p_data->>'repair',''),coalesce(p_data->>'verification',''),coalesce(p_data->>'prevention',''),coalesce(p_data->>'next_steps',''),coalesce(p_data->>'memo_text',''),coalesce(p_data->>'evidence_exception',''),coalesce(p_data->>'outcome','open'))
    on conflict(id) do update set work_unit_id=excluded.work_unit_id,opening_id=excluded.opening_id,window_id=excluded.window_id,legacy_case_id=excluded.legacy_case_id,
      label=excluded.label,type_label=excluded.type_label,facts=excluded.facts,issue=excluded.issue,fail_point=excluded.fail_point,cause=excluded.cause,repair=excluded.repair,verification=excluded.verification,prevention=excluded.prevention,next_steps=excluded.next_steps,memo_text=excluded.memo_text,evidence_exception=excluded.evidence_exception,outcome=excluded.outcome,revision=service_visit_units.revision+1,updated_at=now();
    select to_jsonb(x) into afterj from service_visit_units x where id=result;
  elsif p_action in ('start','stop') then
    if v.id is null then raise exception 'Choose a service visit.'; end if;
    at_time:=coalesce((p_data->>'at')::timestamptz,now());
    if at_time>now()+interval '2 minutes' or at_time<now()-interval '7 days' then raise exception 'Check the device time; a foreman must review older work.'; end if;
    expected:=nullif(p_data->>'expected_session_id','')::uuid;
    select * into s from service_time_sessions where profile_id=uid and ended_at is null for update;
    -- An offline stop can arrive after the payroll clock already closed it. It may shorten,
    -- never extend, that automatic boundary. Other edits still require reconciliation.
    if s.id is null and expected is not null then
      select * into s from service_time_sessions where id=expected and profile_id=uid and visit_id=v.id
        and end_reason in ('clock_out','break','offline_boundary') for update;
      if s.id is not null then at_time:=least(at_time,s.ended_at); end if;
    end if;
    if s.id is distinct from expected then raise exception 'Your timer changed. Refresh before continuing.'; end if;
    if s.id is not null and (s.visit_id<>v.id or at_time<s.started_at) then raise exception 'Stop your other service visit first.'; end if;
    if p_action='start' then
      if v.status<>'active' then raise exception 'Start a new visit for a return trip.'; end if;
      select * into sh from time_shifts where id=(p_data->>'shift_id')::uuid and profile_id=uid for update;
      boundary:=coalesce(sh.clock_out_at,sh.break_started_at);
      if sh.id is null or sh.project_id is distinct from jid or sh.status not in ('open','submitted','approved') or at_time<sh.clock_in_at
        or (boundary is not null and at_time>=boundary) or (boundary is null and now()-sh.clock_in_at>interval '16 hours') then raise exception 'Clock into this job and finish any break before starting service.'; end if;
      if nullif(p_data->>'unit_id','') is not null and not exists(select 1 from service_visit_units where id=(p_data->>'unit_id')::uuid and visit_id=v.id) then raise exception 'Choose a unit on this service visit.'; end if;
      if p_data->>'kind' in ('idle','travel') and length(btrim(coalesce(p_data->>'description','')))=0 then raise exception 'Describe the travel or idle time.'; end if;
      if exists(select 1 from service_time_sessions where profile_id=uid and id is distinct from s.id and coalesce(ended_at,'infinity')>at_time)
        or exists(select 1 from custom_work_sessions where profile_id=uid and (started_at>at_time or ended_at>at_time))
        or exists(select 1 from unit_sessions where profile_id=uid and (started_at>at_time or ended_at>at_time))
        or exists(select 1 from task_sessions where profile_id=uid and (started_at>at_time or ended_at>at_time)) then raise exception 'This overlaps newer work. Refresh and review the timeline.'; end if;
      if at_time<now()-interval '2 minutes' and exists(select 1 from opening_phases where started_by=uid and status='active' and paused_at is null) then raise exception 'Review the existing flashing timer first.'; end if;
      update custom_work_sessions set ended_at=at_time,end_reason='service',revision=revision+1 where profile_id=uid and ended_at is null;
      update unit_sessions set ended_at=at_time,end_reason='handoff' where profile_id=uid and ended_at is null;
      update task_sessions set ended_at=at_time where profile_id=uid and ended_at is null;
      update opening_phases set paused_at=at_time where started_by=uid and status='active' and paused_at is null;
    end if;
    if s.id is not null then
      oldj:=to_jsonb(s);
      update service_time_sessions set ended_at=at_time,end_reason=case when p_action='start' then 'switch' else 'stop' end,description=coalesce(p_data->>'finish_note',description) where id=s.id;
    end if;
    if p_action='start' then
      result:=(p_data->>'id')::uuid;
      insert into service_time_sessions(id,visit_id,project_id,unit_id,shift_id,profile_id,kind,stage,description,started_at,ended_at,end_reason,review_required)
      values(result,v.id,jid,nullif(p_data->>'unit_id','')::uuid,sh.id,uid,p_data->>'kind',coalesce(p_data->>'stage','Diagnosis'),coalesce(p_data->>'description',''),at_time,boundary,case when boundary is not null then 'offline_boundary' end,boundary is not null);
    else result:=s.id; end if;
    select to_jsonb(x) into afterj from service_time_sessions x where id=result;
  elsif p_action='review_time' then
    if not public.service_supervisor() then raise exception 'Only a supervisor or owner can reconcile service time.' using errcode='42501'; end if;
    select * into s from service_time_sessions where id=(p_data->>'id')::uuid and visit_id=v.id for update;
    if s.id is null or s.ended_at is null then raise exception 'Stop this timer before reviewing it.'; end if;
    if s.started_at is distinct from (p_data->>'expected_start')::timestamptz or s.ended_at is distinct from (p_data->>'expected_end')::timestamptz then raise exception 'This time record changed. Refresh before saving.'; end if;
    if p_data->>'reason' is null or length(btrim(p_data->>'reason'))=0 then raise exception 'Explain the time correction.'; end if;
    select * into sh from time_shifts where id=s.shift_id for update;
    if sh.status not in ('open','submitted','approved') or sh.project_id is distinct from s.project_id then raise exception 'Correct the payroll shift and job before reconciling service time.'; end if;
    if (p_data->>'started_at')::timestamptz<sh.clock_in_at or (p_data->>'ended_at')::timestamptz>coalesce(sh.clock_out_at,now())
      or (p_data->>'started_at')::timestamptz>=(p_data->>'ended_at')::timestamptz or p_data->>'started_at' is null or p_data->>'ended_at' is null then raise exception 'Service time must fit inside the paid shift.'; end if;
    if exists(select 1 from service_time_sessions x where x.id<>s.id and x.profile_id=s.profile_id and x.started_at<(p_data->>'ended_at')::timestamptz and coalesce(x.ended_at,now())>(p_data->>'started_at')::timestamptz)
      or exists(select 1 from custom_work_sessions x where x.profile_id=s.profile_id and x.started_at<(p_data->>'ended_at')::timestamptz and coalesce(x.ended_at,now())>(p_data->>'started_at')::timestamptz)
      or exists(select 1 from unit_sessions x where x.profile_id=s.profile_id and x.started_at<(p_data->>'ended_at')::timestamptz and coalesce(x.ended_at,now())>(p_data->>'started_at')::timestamptz)
      or exists(select 1 from task_sessions x where x.profile_id=s.profile_id and x.started_at<(p_data->>'ended_at')::timestamptz and coalesce(x.ended_at,now())>(p_data->>'started_at')::timestamptz) then raise exception 'This overlaps another recorded activity.'; end if;
    oldj:=to_jsonb(s); result:=s.id;
    update service_time_sessions set started_at=(p_data->>'started_at')::timestamptz,ended_at=(p_data->>'ended_at')::timestamptz,review_required=false where id=s.id;
    if (select coalesce(sum(extract(epoch from coalesce(ended_at,now())-started_at)),0) from service_time_sessions where shift_id=sh.id)
       +(select coalesce(sum(extract(epoch from coalesce(ended_at,now())-started_at)),0) from custom_work_sessions where shift_id=sh.id)
       >extract(epoch from coalesce(sh.clock_out_at,now())-sh.clock_in_at)-sh.break_seconds then raise exception 'Tracked work exceeds paid time after breaks. Reconcile the intervals first.'; end if;
    select to_jsonb(x)||jsonb_build_object('review_reason',p_data->>'reason') into afterj from service_time_sessions x where id=result;
  elsif p_action in ('finish','review','notify') then
    if v.id is null then raise exception 'Choose a service visit.'; end if;
    if p_action='notify' then perform service_notify_lodging(v.id);
    else
      if v.created_by is distinct from uid and not public._is_lead(uid) then raise exception 'The visit creator or a foreman can finish the visit.' using errcode='42501'; end if;
      if v.revision is distinct from (p_data->>'revision')::int then raise exception 'This visit changed. Refresh before continuing.'; end if;
      if exists(select 1 from service_time_sessions where visit_id=v.id and ended_at is null) then raise exception 'Each worker must stop their service timer before finishing the visit.'; end if;
      if not exists(select 1 from service_visit_units where visit_id=v.id) then raise exception 'Add the serviced unit first.'; end if;
      if p_action='finish' then
        oldj:=to_jsonb(v);
        update service_visits set status='completed',completed_at=now(),revision=revision+1,updated_at=now(),reviewed_at=null,reviewed_by=null where id=v.id;
      else
        if not public.service_supervisor() then raise exception 'Only a supervisor or owner can approve billing.' using errcode='42501'; end if;
        if v.status<>'completed' then raise exception 'Finish the visit before billing review.'; end if;
        if exists(select 1 from service_visit_units where visit_id=v.id and (cause='pending' or btrim(fail_point)='' or btrim(repair)='' or btrim(verification)='' or outcome='open' or btrim(memo_text)='')) then raise exception 'Complete the unit explanation, responsibility and result first.'; end if;
        if exists(select 1 from service_time_sessions row_time join time_shifts t on t.id=row_time.shift_id where row_time.visit_id=v.id and (row_time.review_required or t.status in ('voided','rejected','needs_finish') or t.project_id is distinct from row_time.project_id)) then raise exception 'Reconcile flagged labor before billing review.'; end if;
        if exists(select 1 from service_visit_units row_unit where row_unit.visit_id=v.id and btrim(row_unit.evidence_exception)='' and (select count(distinct kind) from service_media row_media where row_media.unit_id=row_unit.id and kind in ('before','after','voice','video'))<4) then raise exception 'Attach the unit evidence or explain what is missing.'; end if;
        v_details:=p_data->'allocation';
        if jsonb_typeof(v_details) is distinct from 'object' or jsonb_typeof(v_details->'manufacturer') is distinct from 'number' or jsonb_typeof(v_details->'customer') is distinct from 'number' or jsonb_typeof(v_details->'installer') is distinct from 'number'
          or (v_details->>'manufacturer')::numeric<0 or (v_details->>'customer')::numeric<0 or (v_details->>'installer')::numeric<0
          or coalesce(v_details->>'reason','')='' or length(v_details->>'reason')>2000 then raise exception 'Explain how shared costs are split and enter all three percentages.'; end if;
        total:=(v_details->>'manufacturer')::numeric+(v_details->>'customer')::numeric+(v_details->>'installer')::numeric;
        if total<>100 then raise exception 'Shared cost percentages must total 100.'; end if;
        oldj:=to_jsonb(v);
        update service_visits set allocation=v_details,reviewed_at=now(),reviewed_by=uid,revision=revision+1,updated_at=now() where id=v.id;
      end if;
    end if;
    result:=v.id; select to_jsonb(x) into afterj from service_visits x where id=result;
  elsif p_action='media' then
    if v.id is null then raise exception 'Choose a service visit.'; end if;
    if nullif(p_data->>'unit_id','') is not null and not exists(select 1 from service_visit_units where id=(p_data->>'unit_id')::uuid and visit_id=v.id) then raise exception 'Choose a unit on this visit.'; end if;
    result:=(p_data->>'id')::uuid;
    if split_part(p_data->>'storage_path','/',1)<>uid::text or split_part(p_data->>'storage_path','/',2)<>v.id::text or split_part(split_part(p_data->>'storage_path','/',3),'.',1)<>result::text
      or not exists(select 1 from storage.objects where bucket_id='service-media' and name=p_data->>'storage_path') then raise exception 'Upload the original file before attaching it.'; end if;
    insert into service_media(id,visit_id,project_id,unit_id,created_by,kind,storage_path,filename,content_type,bytes,caption)
    values(result,v.id,jid,nullif(p_data->>'unit_id','')::uuid,uid,p_data->>'kind',p_data->>'storage_path',p_data->>'filename',p_data->>'content_type',(p_data->>'bytes')::bigint,coalesce(p_data->>'caption',''));
    select to_jsonb(x) into afterj from service_media x where id=result;
  elsif p_action='transcript' then
    select * into m from service_media where id=(p_data->>'id')::uuid for update;
    if m.id is null or m.visit_id<>v.id or (m.created_by is distinct from uid and not public._is_lead(uid)) then raise exception 'This memo is not editable.' using errcode='42501'; end if;
    if m.revision is distinct from (p_data->>'revision')::int then raise exception 'This transcript changed. Refresh first.'; end if;
    oldj:=to_jsonb(m); result:=m.id;
    update service_media set transcript=p_data->>'transcript',revision=revision+1 where id=m.id;
    select to_jsonb(x) into afterj from service_media x where id=result;
  else raise exception 'Unknown service action.';
  end if;
  if p_action in ('unit','start','stop','media','transcript','review_time') then
    update service_visits set reviewed_at=null,reviewed_by=null,revision=revision+1,updated_at=now() where id=target;
  end if;
  insert into service_commands(id,profile_id,payload,result_id) values(p_id,uid,jsonb_build_object('action',p_action,'data',p_data),result);
  insert into service_audit(project_id,visit_id,actor_id,action,entity_id,before_value,after_value) values(jid,target,uid,p_action,result,oldj,afterj);
  return result;
end $$;
revoke all on function public.service_command(uuid,text,jsonb) from public,anon;
grant execute on function public.service_command(uuid,text,jsonb) to authenticated;

-- Entering any existing work surface closes service time under the same per-worker lock.
create function public.service_follow_work() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare who uuid; at_time timestamptz;
begin
  if TG_TABLE_NAME='opening_phases' then
    if new.started_by is null or new.status<>'active' or new.paused_at is not null then return new; end if;
    if TG_OP='UPDATE' and old.status='active' and old.paused_at is null then return new; end if;
    who:=new.started_by; at_time:=now();
  else
    if new.ended_at is not null then return new; end if;
    if TG_OP='UPDATE' and old.ended_at is null then return new; end if;
    who:=new.profile_id; at_time:=new.started_at;
  end if;
  perform pg_advisory_xact_lock(hashtextextended(who::text,7281));
  if exists(select 1 from service_time_sessions where profile_id=who and (started_at>at_time or ended_at>at_time)) then raise exception 'Newer service time exists. Review the timeline first.'; end if;
  update service_visits set revision=revision+1,reviewed_at=null,reviewed_by=null,updated_at=now()
    where id in(select visit_id from service_time_sessions where profile_id=who and ended_at is null);
  update service_time_sessions set ended_at=greatest(started_at,at_time),end_reason='other_work' where profile_id=who and ended_at is null;
  return new;
end $$;
create trigger service_custom_work before insert or update of ended_at on custom_work_sessions for each row execute function service_follow_work();
create trigger service_unit_work before insert or update of ended_at on unit_sessions for each row execute function service_follow_work();
create trigger service_task_work before insert or update of ended_at on task_sessions for each row execute function service_follow_work();
create trigger service_phase_work before insert or update on opening_phases for each row execute function service_follow_work();

create function public.service_follow_shift() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare finish_at timestamptz;
begin
  perform pg_advisory_xact_lock(hashtextextended(new.profile_id::text,7281));
  finish_at:=coalesce(new.clock_out_at,new.break_started_at);
  if finish_at is null and new.status<>'open' then finish_at:=now(); end if;
  update service_time_sessions set review_required=review_required or new.status in ('needs_finish','rejected','voided') or project_id is distinct from new.project_id
    or started_at<new.clock_in_at or (ended_at is not null and new.clock_out_at is not null and ended_at>new.clock_out_at)
    or (new.break_seconds is distinct from old.break_seconds and old.break_started_at is null)
    where shift_id=new.id;
  if finish_at is not null then
    update service_time_sessions set ended_at=greatest(started_at,finish_at),end_reason=case when new.clock_out_at is null and new.break_started_at is not null then 'break' else 'clock_out' end
      where shift_id=new.id and ended_at is null;
  end if;
  update service_visits set reviewed_at=null,reviewed_by=null,revision=revision+1 where id in(select visit_id from service_time_sessions where shift_id=new.id);
  return new;
end $$;
create trigger service_shift after update on time_shifts for each row execute function service_follow_shift();
revoke all on function public.service_follow_work(),public.service_follow_shift() from public,anon,authenticated;

create or replace function unit_sessions_follow_shift()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_held uuid;
begin
  -- Clock-out (including every dangling-shift guard that stamps it).
  if new.clock_out_at is not null and old.clock_out_at is null then
    perform _end_open_session(new.profile_id, 'clock_out');
    return new;
  end if;
  -- Break starts: the session ends; the unit waits.
  if new.break_started_at is not null and old.break_started_at is null then
    perform _end_open_session(new.profile_id, 'break');
    return new;
  end if;
  -- Break ends: straight back on the held unit (owner call — a minute or
  -- two of walk-back inflation accepted for zero friction).
  if new.break_started_at is null and old.break_started_at is not null
     and new.clock_out_at is null then
    if exists(select 1 from custom_work_sessions where shift_id=new.id and end_reason='break' and ended_at=old.break_started_at) or exists(select 1 from service_time_sessions where shift_id=new.id) then
      return new; -- Custom work resumes explicitly on Current Work.
    end if;
    select s.opening_id into v_held
    from unit_sessions s
    join project_openings o on o.id = s.opening_id
    where s.profile_id = new.profile_id and s.end_reason = 'break'
      and o.status <> 'installed'
    order by s.ended_at desc
    limit 1;
    if v_held is not null then
      insert into unit_sessions (opening_id, profile_id, role, is_rework)
      values (v_held, new.profile_id, 'install', _has_open_redo(v_held));
    end if;
  end if;
  return new;
end;
$$;



insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values('service-media','service-media',false,104857600,array['image/jpeg','image/png','image/webp','image/heic','image/heif','audio/webm','audio/mp4','audio/ogg','audio/mpeg','audio/wav','audio/x-wav','video/mp4','video/webm','video/quicktime','application/pdf']) on conflict(id) do nothing;
create policy service_media_read on storage.objects for select to authenticated using(bucket_id='service-media' and not public.is_partner_user() and exists(select 1 from service_visits v where v.id::text=split_part(name,'/',2) and public.service_job_access(v.project_id)));
create policy service_media_insert on storage.objects for insert to authenticated with check(bucket_id='service-media' and not public.is_partner_user() and public.service_internal() and split_part(name,'/',1)=auth.uid()::text and exists(select 1 from service_visits v where v.id::text=split_part(name,'/',2) and public.service_job_access(v.project_id)));
create policy service_bucket_read_boundary on storage.objects as restrictive for select to authenticated using(bucket_id<>'service-media' or (not public.is_partner_user() and exists(select 1 from service_visits v where v.id::text=split_part(name,'/',2) and public.service_job_access(v.project_id))));
create policy service_bucket_insert_boundary on storage.objects as restrictive for insert to authenticated with check(bucket_id<>'service-media' or (not public.is_partner_user() and public.service_internal() and split_part(name,'/',1)=auth.uid()::text and exists(select 1 from service_visits v where v.id::text=split_part(name,'/',2) and public.service_job_access(v.project_id))));
create policy service_bucket_immutable_update on storage.objects as restrictive for update to authenticated using(bucket_id<>'service-media') with check(bucket_id<>'service-media');
create policy service_bucket_immutable_delete on storage.objects as restrictive for delete to authenticated using(bucket_id<>'service-media');
-- No object overwrite/delete grant: originals remain original; corrections append evidence.
create or replace function public.person_record_counts(p_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object('service_visits.created_by',(select count(*) from service_visits where created_by=p_id),'service_visit_units.created_by',(select count(*) from service_visit_units where created_by=p_id),'service_time_sessions.profile_id',(select count(*) from service_time_sessions where profile_id=p_id),'service_media.created_by',(select count(*) from service_media where created_by=p_id),'service_audit.actor_id',(select count(*) from service_audit where actor_id=p_id),'service_commands.profile_id',(select count(*) from service_commands where profile_id=p_id)) || jsonb_build_object(
    'custom_work_units.created_by', (select count(*) from custom_work_units where created_by = p_id),
    'custom_work_sessions.profile_id', (select count(*) from custom_work_sessions where profile_id = p_id),
    'custom_work_history.actor_id', (select count(*) from custom_work_history where actor_id = p_id),
    'custom_work_commands.profile_id', (select count(*) from custom_work_commands where profile_id = p_id),

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
select public.attach_sandbox_guards();
commit;
