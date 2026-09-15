-- Field observations and per-person activity, without changing payroll or QC.
begin;
create table public.custom_work_types (
  id uuid primary key default gen_random_uuid(),
  label text not null check (length(btrim(label)) between 1 and 100),
  archived boolean not null default false,
  revision integer not null default 1
);
create unique index custom_work_types_label on public.custom_work_types(lower(btrim(label)));
insert into public.custom_work_types(label) values ('Fixed window'),('Operable window'),('Storefront window'),('Bifold door'),('Sliding door'),('Hinged door'),('Pivot door');

create table public.custom_work_units (
  id uuid primary key,
  project_id uuid references public.projects(id) on delete cascade,
  opening_id uuid references public.project_openings(id) on delete set null,
  created_by uuid not null references public.profiles(id),
  label text not null check(length(btrim(label)) between 1 and 120),
  type_label text not null default 'Unknown' check(length(type_label) between 1 and 100),
  facts jsonb not null default '{}',
  legacy_time_present boolean not null default false,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- A mapped physical unit has one custom record, regardless of how many helpers join.
create unique index custom_work_unit_opening on public.custom_work_units(opening_id) where opening_id is not null;
create index custom_work_units_job on public.custom_work_units(project_id);

create table public.custom_work_sessions (
  id uuid primary key,
  profile_id uuid not null references public.profiles(id),
  shift_id uuid not null references public.time_shifts(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  unit_id uuid references public.custom_work_units(id) on delete cascade,
  kind text not null check(kind in ('unit','idle')),
  participation text not null default 'install' check(participation in ('install','helper')),
  stage text not null default 'Installing' check(length(stage) between 1 and 100),
  description text not null default '' check(length(description) <= 4000),
  outcome text check(outcome in ('finished','partial','blocked','rework')),
  delay_reason text not null default '' check(length(delay_reason) <= 1000),
  started_at timestamptz not null,
  ended_at timestamptz,
  end_reason text,
  shift_status text not null default 'open',
  review_required boolean not null default false,
  revision integer not null default 1,
  check(ended_at is null or ended_at >= started_at),
  check((kind = 'unit') = (unit_id is not null))
);
create unique index custom_work_one_open on public.custom_work_sessions(profile_id) where ended_at is null;
create index custom_work_sessions_job on public.custom_work_sessions(project_id,started_at);
create index custom_work_sessions_unit on public.custom_work_sessions(unit_id);

create table public.custom_work_history (
  id bigint generated always as identity primary key,
  project_id uuid references public.projects(id) on delete cascade,
  actor_id uuid not null references public.profiles(id),
  entity_id uuid not null,
  action text not null,
  before_value jsonb,
  after_value jsonb,
  reason text not null default '',
  created_at timestamptz not null default now()
);
create table public.custom_work_commands (
  id uuid primary key,
  profile_id uuid not null references public.profiles(id),
  -- No snapshots of job data here: replay cannot resurrect deleted/private records.
  payload jsonb not null,
  result_id uuid,
  created_at timestamptz not null default now()
);

create function public.custom_work_internal() returns boolean language sql stable security definer set search_path=public,pg_temp as $$
  select auth.uid() is not null and not public.is_partner_user() and exists (
    select 1 from profiles where id=auth.uid() and active and role in ('installer','foreman','supervisor','owner')
  )
$$;
revoke all on function public.custom_work_internal() from public, anon;
grant execute on function public.custom_work_internal() to authenticated;

alter table public.custom_work_types enable row level security;
alter table public.custom_work_units enable row level security;
alter table public.custom_work_sessions enable row level security;
alter table public.custom_work_history enable row level security;
alter table public.custom_work_commands enable row level security;
revoke all on public.custom_work_types from public, anon, authenticated;
revoke all on public.custom_work_units from public, anon, authenticated;
revoke all on public.custom_work_sessions from public, anon, authenticated;
revoke all on public.custom_work_history from public, anon, authenticated;
revoke all on public.custom_work_commands from public, anon, authenticated;
grant select on public.custom_work_types to authenticated;
grant select on public.custom_work_units to authenticated;
grant select on public.custom_work_sessions to authenticated;
grant select on public.custom_work_history to authenticated;
create policy custom_types_read on public.custom_work_types for select to authenticated using(not public.is_partner_user() and public.custom_work_internal());
create policy custom_units_read on public.custom_work_units for select to authenticated using(not public.is_partner_user() and public.custom_work_internal() and (
  (project_id is null and (created_by=auth.uid() or public._is_lead(auth.uid()))) or
  exists(select 1 from public.projects p where p.id=project_id and p.deleted_at is null)
));
create policy custom_sessions_read on public.custom_work_sessions for select to authenticated using(not public.is_partner_user() and public.custom_work_internal() and (
  (project_id is null and (profile_id=auth.uid() or public._is_lead(auth.uid()))) or
  exists(select 1 from public.projects p where p.id=project_id and p.deleted_at is null)
));
create policy custom_history_read on public.custom_work_history for select to authenticated using(not public.is_partner_user() and public.custom_work_internal() and (
  (project_id is null and (actor_id=auth.uid() or public._is_lead(auth.uid()))) or
  exists(select 1 from public.projects p where p.id=project_id and p.deleted_at is null)
));

-- Validate typed observations without making any field a prerequisite to timing.
create function public.validate_custom_work_facts(f jsonb) returns void language plpgsql set search_path=public,pg_temp as $$
declare k text; v jsonb;
begin
  if f is null or jsonb_typeof(f)<>'object' or octet_length(f::text)>20000 then raise exception 'Unit details are too large or invalid.'; end if;
  for k,v in select * from jsonb_each(f) loop
    if k not in ('width_in','height_in','weight_lb','story','location','material','electrical','complexity','access','equipment_needed','equipment','equipment_minutes','note','named_helpers','area_source','installation_complete') then raise exception 'Unknown unit detail.'; end if;
    if k in ('width_in','height_in','weight_lb','equipment_minutes') then
      if jsonb_typeof(v)<>'number' or (v::text)::numeric < 0 or (v::text)::numeric > 100000 or (k in ('width_in','height_in') and (v::text)::numeric=0) then raise exception 'Enter a valid positive measurement or leave it unknown.'; end if;
    elsif jsonb_typeof(v)<>'string' or length(v #>> '{}')>4000 then raise exception 'Enter a short text detail.';
    end if;
  end loop;
end; $$;
revoke all on function public.validate_custom_work_facts(jsonb) from public,anon,authenticated;

-- All actions are serialized by caller and retry-safe. Revisions protect shared edits.
create function public.custom_work_command(p_id uuid,p_action text,p_data jsonb) returns uuid
language plpgsql security definer set search_path=public,pg_temp as $$
declare
  uid uuid:=auth.uid(); c public.custom_work_commands; u public.custom_work_units;
  s public.custom_work_sessions; sh public.time_shifts; oldj jsonb; outid uuid;
  jid uuid; oid uuid; at_time timestamptz; typ public.custom_work_types;
  expected uuid; target uuid; f jsonb; finish_time timestamptz;
begin
  if not public.custom_work_internal() then raise exception 'An active Forge crew login is required.' using errcode='42501'; end if;
  if p_id is null or p_data is null or jsonb_typeof(p_data)<>'object' then raise exception 'Invalid work request.'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_id::text,7282));
  -- Shares the lock with legacy-session inserts, preventing two surfaces/devices accruing together.
  perform pg_advisory_xact_lock(hashtextextended(uid::text,7281));
  select * into c from public.custom_work_commands where id=p_id;
  if found then
    if c.profile_id<>uid or c.payload<>jsonb_build_object('action',p_action,'data',p_data) then raise exception 'This retry belongs to a different request.'; end if;
    return c.result_id;
  end if;
  if p_action='type' then
    if not public._is_lead(uid) or public.is_test_profile(uid) then raise exception 'Only foremen and above can manage shared types.'; end if;
    target:=(p_data->>'id')::uuid;
    select * into typ from public.custom_work_types where id=target for update;
    if coalesce(typ.revision,0)<>coalesce((p_data->>'revision')::int,-1) then raise exception 'This type changed. Refresh before saving.'; end if;
    oldj:=to_jsonb(typ);
    insert into public.custom_work_types(id,label,archived,revision) values(target,btrim(p_data->>'label'),coalesce((p_data->>'archived')::boolean,false),coalesce(typ.revision,0)+1)
    on conflict(id) do update set label=excluded.label,archived=excluded.archived,revision=excluded.revision;
    outid:=target;
  elsif p_action in ('unit','link') then
    target:=(p_data->>'id')::uuid;
    select * into u from public.custom_work_units where id=target for update;
    if u.id is not null and u.created_by<>uid and not public._is_lead(uid) then raise exception 'Only the author or a foreman can edit this unit.'; end if;
    if coalesce(u.revision,0)<>coalesce((p_data->>'revision')::int,-1) then raise exception 'Unit details changed. Refresh before saving.'; end if;
    if u.project_id is not null and not exists(select 1 from projects where id=u.project_id and deleted_at is null) then raise exception 'That job is unavailable.'; end if;
    jid:=nullif(p_data->>'project_id','')::uuid;
    oid:=nullif(p_data->>'opening_id','')::uuid;
    if jid is not null and not exists(select 1 from projects where id=jid and deleted_at is null) then raise exception 'That job is unavailable.'; end if;
    if oid is not null and not exists(select 1 from project_openings where id=oid and project_id=jid and removed_at is null) then raise exception 'That map unit is not on this job.'; end if;
    if u.project_id is not null and jid is distinct from u.project_id and not public._is_lead(uid) then raise exception 'Ask a foreman to move a record already assigned to a job.'; end if;
    if u.id is not null and (jid is distinct from u.project_id or oid is distinct from u.opening_id) and length(btrim(coalesce(p_data->>'reason','')))<3 then raise exception 'Add a short reason for assigning or linking this record.'; end if;
    f:=coalesce(p_data->'facts','{}'); perform public.validate_custom_work_facts(f);
    oldj:=to_jsonb(u);
    insert into public.custom_work_units(id,project_id,opening_id,created_by,label,type_label,facts,revision)
    values(target,jid,oid,uid,btrim(p_data->>'label'),coalesce(nullif(btrim(p_data->>'type_label'),''),'Unknown'),f,coalesce(u.revision,0)+1)
    on conflict(id) do update set project_id=excluded.project_id,opening_id=excluded.opening_id,label=excluded.label,type_label=excluded.type_label,facts=excluded.facts,revision=excluded.revision,updated_at=now();
    update public.custom_work_units set legacy_time_present=exists(select 1 from unit_sessions where opening_id=oid) or exists(select 1 from task_sessions where opening_id=oid) where id=target;
    -- Attribution moves the observation, never the underlying payroll shift.
    update public.custom_work_sessions set project_id=jid,review_required=review_required or exists(select 1 from time_shifts t where t.id=shift_id and (t.project_id is distinct from jid or t.status in ('needs_finish','rejected','voided'))),revision=revision+1 where unit_id=target and project_id is distinct from jid;
    outid:=target;
  elsif p_action in ('start','stop') then
    at_time:=coalesce((p_data->>'at')::timestamptz,now());
    if at_time>now()+interval '2 minutes' or at_time<now()-interval '7 days' then raise exception 'This work time needs a foreman review. Check the device clock.'; end if;
    expected:=nullif(p_data->>'expected_session_id','')::uuid;
    select * into s from public.custom_work_sessions where profile_id=uid and ended_at is null for update;
    if s.id is null and expected is not null then
      select * into s from public.custom_work_sessions where id=expected and profile_id=uid and ended_at is not null and end_reason in ('clock_out','stop') for update;
      if s.id is not null and (at_time<s.started_at or at_time>s.ended_at) then s.id:=null; end if;
    end if;
    if s.id is distinct from expected then raise exception 'Your current work changed. Sync and review before retrying.'; end if;
    if s.id is not null and at_time<s.started_at then raise exception 'The finish cannot be before the start.'; end if;
    if p_action='start' then
      select * into sh from public.time_shifts where id=(p_data->>'shift_id')::uuid and profile_id=uid for update;
      if sh.id is null or sh.status not in ('open','submitted','approved') or sh.clock_in_at>at_time or (sh.clock_out_at is not null and sh.clock_out_at<=at_time) or (sh.break_started_at is not null and sh.break_started_at<=at_time) then raise exception 'Clock in or resume your job clock before starting work.'; end if;
      -- The job clock already enforces its safety step; do not ask a second time.
      if now()-sh.clock_in_at>interval '16 hours' and sh.clock_out_at is null then raise exception 'Finish the older job clock before starting new work.'; end if;
      target:=nullif(p_data->>'unit_id','')::uuid;
      jid:=sh.project_id;
      if target is not null then
        select * into u from public.custom_work_units where id=target for update;
        if u.id is null or (u.project_id is null and u.created_by<>uid and not public._is_lead(uid)) then raise exception 'That custom unit is unavailable.'; end if;
        if u.project_id is not null and u.project_id is distinct from sh.project_id then raise exception 'Switch your job clock to this unit''s job first.'; end if;
        jid:=u.project_id;
      elsif length(btrim(coalesce(p_data->>'description','')))=0 then raise exception 'Describe your idle time.';
      end if;
      if jid is not null and not exists(select 1 from projects where id=jid and deleted_at is null) then raise exception 'That job is unavailable.'; end if;
      -- Never rewrite a newer activity based on a stale/offline start.
      if exists(select 1 from public.custom_work_sessions where profile_id=uid and id is distinct from s.id and coalesce(ended_at,'infinity')>at_time) or exists(select 1 from public.unit_sessions where profile_id=uid and (started_at>at_time or (ended_at is not null and ended_at>at_time))) or exists(select 1 from public.task_sessions where profile_id=uid and (started_at>at_time or (ended_at is not null and ended_at>at_time))) then raise exception 'This overlaps recorded work. Ask a foreman to review the timeline.'; end if;
      if at_time<now()-interval '2 minutes' and exists(select 1 from opening_phases where started_by=uid and status='active' and paused_at is null) then raise exception 'A flashing timer is now running. Ask a foreman to reconcile the older work.'; end if;
      update public.task_sessions set ended_at=at_time where profile_id=uid and ended_at is null;
      update public.unit_sessions set ended_at=at_time,end_reason='handoff' where profile_id=uid and ended_at is null;
      update public.opening_phases set paused_at=at_time where started_by=uid and status='active' and paused_at is null;
    end if;
    if s.id is not null then
      oldj:=to_jsonb(s);
      update public.custom_work_sessions set ended_at=at_time,end_reason=case when p_action='start' then 'switch' else 'stop' end,
        outcome=nullif(p_data->>'outcome',''),description=coalesce(p_data->>'finish_note',description),delay_reason=coalesce(p_data->>'delay_reason',delay_reason),revision=revision+1 where id=s.id;
      insert into public.custom_work_history(project_id,actor_id,entity_id,action,before_value,after_value) select project_id,uid,id,'stop',oldj,to_jsonb(x) from public.custom_work_sessions x where id=s.id;
    end if;
    if p_action='start' then
      -- A later visit reopens completion; the worker can mark the whole install done again.
      update public.custom_work_units set facts=jsonb_set(facts,'{installation_complete}','"No"'),revision=revision+1,updated_at=now() where id=target and facts->>'installation_complete'='Yes';
      if found then
        insert into custom_work_history(project_id,actor_id,entity_id,action,before_value,after_value,reason) select jid,uid,id,'reopen',to_jsonb(u),to_jsonb(x),'New work visit' from custom_work_units x where id=target;
      end if;
      outid:=(p_data->>'id')::uuid;
      insert into public.custom_work_sessions(id,profile_id,shift_id,project_id,unit_id,kind,participation,stage,description,started_at,ended_at,end_reason,shift_status,review_required)
      values(outid,uid,sh.id,jid,target,case when target is null then 'idle' else 'unit' end,coalesce(p_data->>'participation','install'),case when target is null then 'Idle time' else coalesce(p_data->>'stage','Installing') end,coalesce(p_data->>'description',''),at_time,sh.clock_out_at,case when sh.clock_out_at is not null then 'clock_out' end,sh.status,jid is distinct from sh.project_id or (sh.clock_out_at is not null and coalesce(sh.break_seconds,0)>0));
      oldj:=null;
    else outid:=s.id; jid:=s.project_id;
    end if;
  elsif p_action='session' then
    select * into s from public.custom_work_sessions where id=(p_data->>'id')::uuid for update;
    if s.id is null or (s.profile_id<>uid and not public._is_lead(uid)) then raise exception 'Only the worker or a foreman can correct this record.'; end if;
    if s.project_id is not null and not exists(select 1 from projects where id=s.project_id and deleted_at is null) then raise exception 'That job is unavailable.'; end if;
    if s.revision<>coalesce((p_data->>'revision')::int,-1) then raise exception 'This record changed. Refresh before saving.'; end if;
    if length(btrim(coalesce(p_data->>'reason','')))<3 then raise exception 'Add a correction reason.'; end if;
    if s.kind='idle' and length(btrim(coalesce(p_data->>'description',s.description)))=0 then raise exception 'Describe your idle time.'; end if;
    oldj:=to_jsonb(s); jid:=s.project_id; outid:=s.id;
    if coalesce((p_data->>'review_time')::boolean,false) or p_data ? 'started_at' or p_data ? 'ended_at' then
      if not public._is_lead(uid) then raise exception 'Only foremen and above can correct captured times.'; end if;
      if s.ended_at is null then raise exception 'Stop the activity before correcting its time.'; end if;
      select * into sh from time_shifts where id=s.shift_id for update;
      at_time:=coalesce((p_data->>'started_at')::timestamptz,s.started_at);
      finish_time:=coalesce((p_data->>'ended_at')::timestamptz,s.ended_at);
      if sh.status not in ('submitted','approved') or sh.clock_out_at is null or s.project_id is distinct from sh.project_id or s.project_id is null
        or at_time<sh.clock_in_at or finish_time>sh.clock_out_at or finish_time<at_time or finish_time-at_time>interval '16 hours' then
        raise exception 'First resolve the job, timecard, or shift bounds. Captured time must fit its closed job clock.';
      end if;
      if exists(select 1 from custom_work_sessions x where x.profile_id=s.profile_id and x.id<>s.id and x.started_at<finish_time and coalesce(x.ended_at,'infinity')>at_time)
        or exists(select 1 from unit_sessions x where x.profile_id=s.profile_id and x.started_at<finish_time and coalesce(x.ended_at,'infinity')>at_time)
        or exists(select 1 from task_sessions x where x.profile_id=s.profile_id and x.started_at<finish_time and coalesce(x.ended_at,'infinity')>at_time) then
        raise exception 'The corrected interval overlaps other recorded work.';
      end if;
      if extract(epoch from finish_time-at_time)+(select coalesce(sum(extract(epoch from ended_at-started_at)),0) from custom_work_sessions where shift_id=s.shift_id and id<>s.id)
        >extract(epoch from sh.clock_out_at-sh.clock_in_at)-coalesce(sh.break_seconds,0)+1 then
        raise exception 'Captured activity exceeds the worked shift time after breaks. Review the other intervals too.';
      end if;
      update public.custom_work_sessions set started_at=at_time,ended_at=finish_time,review_required=false,end_reason='reviewed' where id=s.id;
    end if;
    update public.custom_work_sessions set description=coalesce(p_data->>'description',description),outcome=nullif(p_data->>'outcome',''),delay_reason=coalesce(p_data->>'delay_reason',delay_reason),revision=revision+1 where id=s.id;
  else raise exception 'Unknown work action.';
  end if;
  -- Audit values live behind the same job/author boundary as the records.
  insert into public.custom_work_history(project_id,actor_id,entity_id,action,before_value,after_value,reason)
  values(jid,uid,coalesce(outid,p_id),p_action,oldj,
    case when p_action in ('unit','link') then (select to_jsonb(x) from public.custom_work_units x where id=outid)
      when p_action='type' then (select to_jsonb(x) from public.custom_work_types x where id=outid)
      else (select to_jsonb(x) from public.custom_work_sessions x where id=outid) end,coalesce(p_data->>'reason',''));
  insert into public.custom_work_commands(id,profile_id,payload,result_id) values(p_id,uid,jsonb_build_object('action',p_action,'data',p_data),outid);
  return outid;
end; $$;
revoke all on function public.custom_work_command(uuid,text,jsonb) from public,anon;
grant execute on function public.custom_work_command(uuid,text,jsonb) to authenticated;

-- Legacy entry points keep working, but stop custom activity for that worker.
create function public.custom_work_follow_legacy() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  update public.custom_work_units set legacy_time_present=true where opening_id=new.opening_id and not legacy_time_present;
  if new.ended_at is null then
    perform pg_advisory_xact_lock(hashtextextended(new.profile_id::text,7281));
    update public.custom_work_sessions set ended_at=greatest(started_at,new.started_at),end_reason='legacy_unit',revision=revision+1 where profile_id=new.profile_id and ended_at is null;
  end if;
  return new;
end; $$;
create trigger custom_work_legacy before insert or update of ended_at on public.unit_sessions for each row execute function public.custom_work_follow_legacy();

create trigger custom_work_oldtask before insert or update of ended_at on public.task_sessions for each row execute function public.custom_work_follow_legacy();

-- The existing flashing timer is a third entry point for field activity.
create function public.custom_work_follow_phase() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if new.started_by is not null and new.status='active' and new.paused_at is null then
    if TG_OP='UPDATE' and old.status='active' and old.paused_at is null then return new; end if;
    perform pg_advisory_xact_lock(hashtextextended(new.started_by::text,7281));
    update public.custom_work_sessions set ended_at=greatest(started_at,now()),end_reason='legacy_phase',revision=revision+1 where profile_id=new.started_by and ended_at is null;
  end if;
  return new;
end; $$;
create trigger custom_work_phase after insert or update on public.opening_phases for each row execute function public.custom_work_follow_phase();
revoke all on function public.custom_work_follow_phase() from public,anon,authenticated;

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
    if exists(select 1 from custom_work_sessions where shift_id=new.id and end_reason='break' and ended_at=old.break_started_at) then
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


create function public.custom_work_follow_shift() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare finish_at timestamptz;
begin
  update public.custom_work_sessions set shift_status=new.status,
    review_required=review_required or new.status in ('needs_finish','rejected','voided') or project_id is distinct from new.project_id
      or started_at<new.clock_in_at or (ended_at is not null and new.clock_out_at is not null and ended_at>new.clock_out_at)
    where shift_id=new.id;
  finish_at:=coalesce(new.clock_out_at,new.break_started_at);
  if finish_at is null and new.status<>'open' then finish_at:=now(); end if;
  if finish_at is not null then
    update public.custom_work_sessions set review_required=review_required or started_at>finish_at,ended_at=greatest(started_at,finish_at),end_reason=case when new.break_started_at is not null and new.clock_out_at is null then 'break' when new.status in ('needs_finish','rejected','voided') then 'needs_review' else 'clock_out' end,revision=revision+1 where shift_id=new.id and ended_at is null;
  end if;
  return new;
end; $$;
create trigger custom_work_shift after update on public.time_shifts for each row execute function public.custom_work_follow_shift();
revoke all on function public.custom_work_follow_shift(),public.custom_work_follow_legacy() from public,anon,authenticated;
create or replace function public.person_record_counts(p_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
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
revoke all on function public.person_record_counts(uuid) from public,anon,authenticated;
grant execute on function public.person_record_counts(uuid) to service_role;
select public.attach_sandbox_guards();
commit;
