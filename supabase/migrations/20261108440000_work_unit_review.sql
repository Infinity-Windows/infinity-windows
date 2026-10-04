-- Private unit review. Held candidate; no production activation.
-- Source retention belongs to the engine: review reads it, payroll never reads review.
begin;
select public._work_activity_read_committed();
select public._work_activity_gate();
-- Exact prerequisite: do not replace an unreviewed event writer.
do $$ begin
 if encode(sha256(convert_to((select prosrc from pg_proc where oid='public._work_activity_row_event()'::regprocedure),'UTF8')),'hex') <> 'feaeec9dd1e5158f58f965042bac2ee0a3b60a4e3cf9d23e49fe8c71de7f6ae3' then
 raise exception using errcode='55000',message='Unit review source contract is unavailable.'; end if;
end; $$;

-- No source FK, finite sequence, bounded payload CHECK, or review-domain validation
-- in this append. Actual OLD/NEW source changes survive parent cascade and purge.
-- UUID order is canonical encoding order; tx_order preserves intermediate order.
create table public.work_activity_source_history (
 id uuid primary key default gen_random_uuid(), source_kind text not null, source_id text not null,
 operation_id uuid, transition_ids uuid[] not null default '{}', transaction_id xid8 not null, tx_order numeric not null,
 actor_id uuid, recorded_at timestamptz not null default clock_timestamp(),
 before_value jsonb not null, after_value jsonb not null, legacy_baseline boolean not null default false
);
create index work_activity_source_history_source on public.work_activity_source_history(source_kind,source_id);
create index work_activity_source_history_order on public.work_activity_source_history(transaction_id,tx_order);
alter table public.work_activity_source_history enable row level security;
revoke all on public.work_activity_source_history from public,anon,authenticated,service_role;
create trigger work_activity_source_history_immutable before update or delete on public.work_activity_source_history
 for each row execute function public.work_capture_immutable_record();
create trigger work_activity_source_history_no_truncate before truncate on public.work_activity_source_history
 for each statement execute function public.work_capture_immutable_record();
create function public._work_activity_retain_source(p_kind text,p_id text,p_before jsonb,p_after jsonb) returns void
language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare o public.work_activity_operations;
begin
 o:=public._work_activity_operation();
 insert into public.work_activity_source_history(source_kind,source_id,operation_id,transition_ids,transaction_id,tx_order,actor_id,before_value,after_value,legacy_baseline)
 select p_kind,p_id,o.id,(select coalesce(array_agg(transition_id order by profile_id),'{}') from public.work_activity_operation_people where operation_id=o.id and profile_id::text in (p_before->>'profile_id',p_after->>'profile_id',p_before->>'started_by',p_after->>'started_by')),pg_current_xact_id(),coalesce(max(tx_order),0::numeric)+1,auth.uid(),coalesce(p_before,'{}'),coalesce(p_after,'{}'),
 -- A captured mutation cannot invent the missing origin of a previously
 -- uncaptured source/state. Keep uncertainty even after later deletion/reuse.
 coalesce(p_before,'{}')<>'{}' and not exists(select 1 from public.work_activity_source_history h where h.source_kind=p_kind and h.source_id=p_id and h.after_value=p_before)
 from public.work_activity_source_history where transaction_id=pg_current_xact_id();
end; $$;
revoke all on function public._work_activity_retain_source(text,text,jsonb,jsonb) from public,anon,authenticated,service_role;

create or replace function public._work_activity_row_event() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare oldj jsonb; newj jsonb; before_value jsonb; after_value jsonb; who uuid; oldwho uuid; kind text;
 boundary timestamptz; cause text; frame public.work_activity_transaction_context; o public.work_activity_operations;
begin
 o:=public._work_activity_operation();
 oldj:=case when tg_op<>'INSERT' then to_jsonb(old) end;newj:=case when tg_op<>'DELETE' then to_jsonb(new) end;
 before_value:=public._work_activity_source_material(tg_table_name,oldj);after_value:=public._work_activity_source_material(tg_table_name,newj);
 if before_value=after_value then return null;end if;
 who:=(coalesce(newj,oldj)->>case when tg_table_name='opening_phases' then 'started_by' else 'profile_id' end)::uuid;
 oldwho:=(oldj->>case when tg_table_name='opening_phases' then 'started_by' else 'profile_id' end)::uuid;
 kind:=case tg_table_name when 'time_shifts' then 'shift' when 'custom_work_sessions' then 'custom' when 'unit_sessions' then 'unit' when 'task_sessions' then 'task' when 'service_time_sessions' then 'service' when 'opening_phases' then 'phase' when 'work_setup_sessions' then 'setup' when 'summon_helpers' then 'helper' end;
 select c.* into frame from public.work_activity_transaction_context c where c.top_xid=o.top_xid and c.backend_pid=o.backend_pid
   and c.subject_profile_id=who and not exists(select 1 from public.work_activity_transaction_context child where child.parent_id=c.id);
 boundary:=coalesce(frame.selected_effective_at,o.arrival_at);cause:=coalesce(frame.cause,'legacy_transition');
 if frame.id is null then
   if tg_op='DELETE' then cause:='correction';
   elsif kind='shift' then
     if tg_op='INSERT' then boundary:=(newj->>'clock_in_at')::timestamptz;cause:=case when newj->'source_import' is not null and newj->'source_import'<>'null'::jsonb then 'import' else 'clock_in' end;
     elsif newj->>'status'='voided' and oldj->>'status'<>'voided' then cause:='void';
     elsif oldj->>'status'='voided' and newj->>'status'<>'voided' then cause:='restore';
     elsif newj->'clock_out_at'<>'null'::jsonb and oldj->'clock_out_at'='null'::jsonb then boundary:=(newj->>'clock_out_at')::timestamptz;cause:='clock_out';
     elsif newj->'break_started_at'<>'null'::jsonb and oldj->'break_started_at'='null'::jsonb then boundary:=(newj->>'break_started_at')::timestamptz;cause:='break_start';
     elsif newj->'break_started_at'='null'::jsonb and oldj->'break_started_at'<>'null'::jsonb then boundary:=coalesce((newj->>'last_punch_at')::timestamptz,o.arrival_at);cause:='break_end';
     else cause:='correction';end if;
   elsif kind='phase' then boundary:=coalesce((newj->>'paused_at')::timestamptz,(newj->>'submitted_at')::timestamptz,case when tg_op='INSERT' then (newj->>'started_at')::timestamptz else o.arrival_at end);
   elsif kind='helper' then boundary:=coalesce((newj->>'completed_at')::timestamptz,(newj->>'canceled_at')::timestamptz,(newj->>'joined_at')::timestamptz);
   else boundary:=coalesce((newj->>'selected_end_at')::timestamptz,(newj->>'ended_at')::timestamptz,(newj->>'started_at')::timestamptz,o.arrival_at);end if;
 end if;
 perform public._work_activity_retain_source(tg_table_name,coalesce(newj,oldj)->>'id',before_value,after_value);
 -- Preserve the existing personal/payroll event projection exactly.
 before_value:=public._work_activity_evidence(tg_table_name,oldj);after_value:=public._work_activity_evidence(tg_table_name,newj);
 if before_value=after_value then return null;end if;
 if oldwho is not null and oldwho is distinct from who then
   perform public._work_activity_event(oldwho,kind,(oldj->>'id')::uuid,tg_op,boundary,'correction',before_value,'{}');
   before_value:='{}';
 end if;
 if who is not null then perform public._work_activity_event(who,kind,(coalesce(newj,oldj)->>'id')::uuid,tg_op,boundary,cause,before_value,after_value);end if;
 return null;
end; $$;

create function public._work_activity_source_material(p_kind text,p_row jsonb) returns jsonb
language plpgsql immutable set search_path=public,pg_temp as $$
declare fields text[];
begin
 if p_row is null then return '{}'::jsonb; end if;
 fields:=case p_kind
 when 'opening_phases' then array['id','opening_id','kind','status','started_by','started_at','paused_at','paused_seconds','submitted_at','submitted_by','minutes']
 when 'custom_work_sessions' then array['id','profile_id','shift_id','project_id','unit_id','kind','participation','stage','outcome','started_at','ended_at','end_reason','revision','review_required','shift_status']
 when 'custom_work_units' then array['id','project_id','opening_id','created_by']
 when 'project_openings' then array['id','project_id','removed_at','assigned_window_id','status','confirmed','work_started_at','work_ended_at','needs_flashing']
 when 'service_visit_units' then array['id','visit_id','project_id','work_unit_id','opening_id','window_id','created_by','outcome','facts','issue','fail_point','cause','repair','verification','prevention','next_steps']
 when 'service_visits' then array['id','project_id','created_by']
 when 'summons' then array['id','project_id','opening_id','requested_by','status']
 when 'unit_redos' then array['id','opening_id','pressed_by','pressed_at','resolved_at']
 when 'qc_checks' then array['id','project_opening_id','status','checked_by','checked_at']
 when 'install_events' then array['id','project_opening_id','started_at','minutes','installer_id','voided_at','voided_by','credited_to','quality_grade','ai_confirmed']
 when 'crew_work_records' then array['id','project_id','unit_id','filed_by','work_date','stage','outcome','whole_complete']
 when 'crew_work_record_people' then array['record_id','profile_id','voided_at','voided_by']
 when 'work_session_capture_metadata' then array['session_id','profile_id','project_id','scope','unit_id','fact_revision','unit_facts','recorded_at']
 when 'custom_work_history' then array['id','project_id','actor_id','entity_id','action','before_value','after_value','created_at']
 else null end;
 if fields is null then return public._work_activity_evidence(p_kind,p_row); end if;
 return (select jsonb_object_agg(key,value) from jsonb_each(p_row) where key=any(fields));
end; $$;
revoke all on function public._work_activity_source_material(text,jsonb) from public,anon,authenticated,service_role;
create function public._work_activity_parent_source_history() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare b jsonb; a jsonb; identity text;
begin
 b:=public._work_activity_source_material(tg_table_name,case when tg_op<>'INSERT' then to_jsonb(old) end);
 a:=public._work_activity_source_material(tg_table_name,case when tg_op<>'DELETE' then to_jsonb(new) end);
 if a is distinct from b then
 identity:=case tg_table_name when 'crew_work_record_people' then coalesce(a->>'record_id',b->>'record_id')||':'||coalesce(a->>'profile_id',b->>'profile_id')
 when 'work_session_capture_metadata' then coalesce(a->>'session_id',b->>'session_id') else coalesce(a->>'id',b->>'id') end;
 perform public._work_activity_retain_source(tg_table_name,identity,b,a);
 end if;
 return null;
end; $$;
revoke all on function public._work_activity_parent_source_history() from public,anon,authenticated,service_role;
create trigger z_work_activity_source_history after insert or update or delete on public.custom_work_units
 for each row execute function public._work_activity_parent_source_history();
create trigger z_work_activity_source_history after insert or update or delete on public.project_openings
 for each row execute function public._work_activity_parent_source_history();
create trigger z_work_activity_source_history after insert or update or delete on public.service_visit_units
 for each row execute function public._work_activity_parent_source_history();
create trigger z_work_activity_source_history after insert or update or delete on public.service_visits
 for each row execute function public._work_activity_parent_source_history();
create trigger z_work_activity_source_history after insert or update or delete on public.summons
 for each row execute function public._work_activity_parent_source_history();
create trigger z_work_activity_source_history after insert or update or delete on public.unit_redos
 for each row execute function public._work_activity_parent_source_history();
create trigger "000_work_activity_source_gate" before insert or update or delete on public.unit_redos
 for each statement execute function public._work_activity_parent_gate();
create trigger "000_work_activity_source_no_truncate" before truncate on public.unit_redos
 for each statement execute function public._work_activity_no_truncate();
create trigger z_work_activity_source_history after insert or update or delete on public.qc_checks
 for each row execute function public._work_activity_parent_source_history();
create trigger z_work_activity_source_history after insert or update or delete on public.install_events
 for each row execute function public._work_activity_parent_source_history();
create trigger z_work_activity_source_history after insert or update or delete on public.crew_work_records
 for each row execute function public._work_activity_parent_source_history();
create trigger "000_work_activity_source_gate" before insert or update or delete on public.crew_work_records
 for each statement execute function public._work_activity_parent_gate();
create trigger "000_work_activity_source_no_truncate" before truncate on public.crew_work_records
 for each statement execute function public._work_activity_no_truncate();
create trigger z_work_activity_source_history after insert or update or delete on public.crew_work_record_people
 for each row execute function public._work_activity_parent_source_history();
create trigger "000_work_activity_source_gate" before insert or update or delete on public.crew_work_record_people
 for each statement execute function public._work_activity_parent_gate();
create trigger "000_work_activity_source_no_truncate" before truncate on public.crew_work_record_people
 for each statement execute function public._work_activity_no_truncate();
create trigger z_work_activity_source_history after insert or update or delete on public.work_session_capture_metadata
 for each row execute function public._work_activity_parent_source_history();
create trigger "000_work_activity_source_gate" before insert or update or delete on public.work_session_capture_metadata
 for each statement execute function public._work_activity_parent_gate();
create trigger "000_work_activity_source_no_truncate" before truncate on public.work_session_capture_metadata
 for each statement execute function public._work_activity_no_truncate();
create trigger z_work_activity_source_history after insert or update or delete on public.custom_work_history
 for each row execute function public._work_activity_parent_source_history();
create trigger "000_work_activity_source_gate" before insert or update or delete on public.custom_work_history
 for each statement execute function public._work_activity_parent_gate();
create trigger "000_work_activity_source_no_truncate" before truncate on public.custom_work_history
 for each statement execute function public._work_activity_no_truncate();
-- Baseline is explicitly legacy; no original event/observer is invented.
insert into public.work_activity_source_history(source_kind,source_id,transaction_id,tx_order,before_value,after_value,legacy_baseline) select 'custom_work_units',r.id::text,pg_current_xact_id(),0,'{}',public._work_activity_source_material('custom_work_units',to_jsonb(r)),true from public.custom_work_units r;
insert into public.work_activity_source_history(source_kind,source_id,transaction_id,tx_order,before_value,after_value,legacy_baseline) select 'project_openings',r.id::text,pg_current_xact_id(),0,'{}',public._work_activity_source_material('project_openings',to_jsonb(r)),true from public.project_openings r;
insert into public.work_activity_source_history(source_kind,source_id,transaction_id,tx_order,before_value,after_value,legacy_baseline) select 'service_visit_units',r.id::text,pg_current_xact_id(),0,'{}',public._work_activity_source_material('service_visit_units',to_jsonb(r)),true from public.service_visit_units r;
insert into public.work_activity_source_history(source_kind,source_id,transaction_id,tx_order,before_value,after_value,legacy_baseline) select 'service_visits',r.id::text,pg_current_xact_id(),0,'{}',public._work_activity_source_material('service_visits',to_jsonb(r)),true from public.service_visits r;
insert into public.work_activity_source_history(source_kind,source_id,transaction_id,tx_order,before_value,after_value,legacy_baseline) select 'summons',r.id::text,pg_current_xact_id(),0,'{}',public._work_activity_source_material('summons',to_jsonb(r)),true from public.summons r;
insert into public.work_activity_source_history(source_kind,source_id,transaction_id,tx_order,before_value,after_value,legacy_baseline) select 'unit_redos',r.id::text,pg_current_xact_id(),0,'{}',public._work_activity_source_material('unit_redos',to_jsonb(r)),true from public.unit_redos r;
insert into public.work_activity_source_history(source_kind,source_id,transaction_id,tx_order,before_value,after_value,legacy_baseline) select 'qc_checks',r.id::text,pg_current_xact_id(),0,'{}',public._work_activity_source_material('qc_checks',to_jsonb(r)),true from public.qc_checks r;
insert into public.work_activity_source_history(source_kind,source_id,transaction_id,tx_order,before_value,after_value,legacy_baseline) select 'install_events',r.id::text,pg_current_xact_id(),0,'{}',public._work_activity_source_material('install_events',to_jsonb(r)),true from public.install_events r;
insert into public.work_activity_source_history(source_kind,source_id,transaction_id,tx_order,before_value,after_value,legacy_baseline) select 'crew_work_records',r.id::text,pg_current_xact_id(),0,'{}',public._work_activity_source_material('crew_work_records',to_jsonb(r)),true from public.crew_work_records r;
insert into public.work_activity_source_history(source_kind,source_id,transaction_id,tx_order,before_value,after_value,legacy_baseline) select 'crew_work_record_people',r.record_id::text||':'||r.profile_id::text,pg_current_xact_id(),0,'{}',public._work_activity_source_material('crew_work_record_people',to_jsonb(r)),true from public.crew_work_record_people r;
insert into public.work_activity_source_history(source_kind,source_id,transaction_id,tx_order,before_value,after_value,legacy_baseline) select 'work_session_capture_metadata',r.session_id::text,pg_current_xact_id(),0,'{}',public._work_activity_source_material('work_session_capture_metadata',to_jsonb(r)),true from public.work_session_capture_metadata r;
insert into public.work_activity_source_history(source_kind,source_id,transaction_id,tx_order,before_value,after_value,legacy_baseline) select 'custom_work_history',r.id::text,pg_current_xact_id(),0,'{}',public._work_activity_source_material('custom_work_history',to_jsonb(r)),true from public.custom_work_history r;
insert into public.work_activity_source_history(source_kind,source_id,transaction_id,tx_order,before_value,after_value,legacy_baseline) select 'custom_work_sessions',r.id::text,pg_current_xact_id(),0,'{}',public._work_activity_source_material('custom_work_sessions',to_jsonb(r)),true from public.custom_work_sessions r;
insert into public.work_activity_source_history(source_kind,source_id,transaction_id,tx_order,before_value,after_value,legacy_baseline) select 'unit_sessions',r.id::text,pg_current_xact_id(),0,'{}',public._work_activity_source_material('unit_sessions',to_jsonb(r)),true from public.unit_sessions r;
insert into public.work_activity_source_history(source_kind,source_id,transaction_id,tx_order,before_value,after_value,legacy_baseline) select 'task_sessions',r.id::text,pg_current_xact_id(),0,'{}',public._work_activity_source_material('task_sessions',to_jsonb(r)),true from public.task_sessions r;
insert into public.work_activity_source_history(source_kind,source_id,transaction_id,tx_order,before_value,after_value,legacy_baseline) select 'service_time_sessions',r.id::text,pg_current_xact_id(),0,'{}',public._work_activity_source_material('service_time_sessions',to_jsonb(r)),true from public.service_time_sessions r;
insert into public.work_activity_source_history(source_kind,source_id,transaction_id,tx_order,before_value,after_value,legacy_baseline) select 'opening_phases',r.id::text,pg_current_xact_id(),0,'{}',public._work_activity_source_material('opening_phases',to_jsonb(r)),true from public.opening_phases r;
insert into public.work_activity_source_history(source_kind,source_id,transaction_id,tx_order,before_value,after_value,legacy_baseline) select 'summon_helpers',r.id::text,pg_current_xact_id(),0,'{}',public._work_activity_source_material('summon_helpers',to_jsonb(r)),true from public.summon_helpers r;

create table public.work_unit_review_commands (
 command_id uuid primary key, actor_id uuid not null, protocol_version integer not null check(protocol_version=1),
 action text not null, unit_id uuid not null, incarnation bigint not null,
 normalized_request jsonb not null, request_digest text not null, receipt jsonb not null,
 recorded_at timestamptz not null default clock_timestamp()
);
create table public.work_unit_dimension_verifications (
 id uuid primary key,command_id uuid not null unique,unit_id uuid not null,incarnation bigint not null,
 fact_id uuid not null,fact_revision bigint not null,observation_actor_id uuid not null,reviewer_id uuid not null,
 corroboration jsonb not null,dimension_manifest jsonb not null,recorded_at timestamptz not null default clock_timestamp(),
 check(observation_actor_id<>reviewer_id)
);
create table public.work_unit_review_events (
 id uuid primary key,unit_id uuid not null,incarnation bigint not null,review_revision bigint not null,
 command_id uuid not null unique,action text not null,actor_id uuid not null,predecessor_event_id uuid,
 generation bigint not null,submission_id uuid,basis jsonb not null,scope_manifest jsonb not null,
 scope_token text not null,coverage_version integer not null,note text,prior_state text not null,resulting_state text not null,
 recorded_at timestamptz not null default clock_timestamp(),unique(unit_id,incarnation,review_revision)
);
create table public.work_unit_review_current (
 unit_id uuid not null,incarnation bigint not null,review_revision bigint not null default 0,
 generation bigint not null default 0,latest_event_id uuid,latest_qc_event_id uuid,current_submission_id uuid,
 dimension_verification_id uuid,qc_state text not null default 'not_submitted',primary key(unit_id,incarnation),
 check(review_revision between 0 and 9007199254740991),check(generation between 0 and 9007199254740991),
 check(qc_state in ('not_submitted','awaiting_review','passed','failed'))
);
create table public.work_unit_review_defects (
 id uuid primary key,unit_id uuid not null,incarnation bigint not null,origin_event_id uuid not null,
 origin_submission_id uuid not null,origin_generation bigint not null,creator_id uuid not null,
 original_project_id uuid,original_opening_id uuid,summary text not null,recorded_at timestamptz not null default clock_timestamp()
);
create table public.work_unit_review_defect_events (
 id uuid primary key default gen_random_uuid(),defect_id uuid not null references public.work_unit_review_defects(id),
 review_event_id uuid not null,review_revision bigint not null,active_generation bigint not null,
 actor_id uuid not null,state text not null check(state in ('open','claimed_resolved','verified_resolved')),
 note text,recorded_at timestamptz not null default clock_timestamp()
);
create index work_unit_review_events_unit on public.work_unit_review_events(unit_id,incarnation,review_revision);
create index work_unit_review_defects_unit on public.work_unit_review_defects(unit_id,incarnation);
create index work_unit_review_defect_events_latest on public.work_unit_review_defect_events(defect_id,review_revision desc);
alter table public.work_unit_review_commands enable row level security;
revoke all on public.work_unit_review_commands from public,anon,authenticated,service_role;
alter table public.work_unit_dimension_verifications enable row level security;
revoke all on public.work_unit_dimension_verifications from public,anon,authenticated,service_role;
alter table public.work_unit_review_events enable row level security;
revoke all on public.work_unit_review_events from public,anon,authenticated,service_role;
alter table public.work_unit_review_current enable row level security;
revoke all on public.work_unit_review_current from public,anon,authenticated,service_role;
alter table public.work_unit_review_defects enable row level security;
revoke all on public.work_unit_review_defects from public,anon,authenticated,service_role;
alter table public.work_unit_review_defect_events enable row level security;
revoke all on public.work_unit_review_defect_events from public,anon,authenticated,service_role;
do $$ declare t text; begin
 foreach t in array array['work_unit_review_commands','work_unit_dimension_verifications','work_unit_review_events','work_unit_review_current','work_unit_review_defects','work_unit_review_defect_events'] loop
 execute format('create trigger review_no_truncate before truncate on public.%I for each statement execute function public.work_capture_immutable_record()',t);
 if t<>'work_unit_review_current' then execute format('create trigger review_immutable before update or delete on public.%I for each row execute function public.work_capture_immutable_record()',t);end if;
 end loop;
end; $$;

create function public._work_unit_review_decimal(p_value jsonb) returns text
language plpgsql immutable set search_path=public,pg_temp as $$
declare s text;n numeric;
begin
 if jsonb_typeof(p_value) is distinct from 'string' then raise exception using errcode='23514',message='Invalid review request.';end if;
 s:=p_value#>>'{}';
 if length(s) not between 1 and 100 or s !~ '^[0-9]+(\.[0-9]+)?$' then raise exception using errcode='23514',message='Invalid review request.';end if;
 n:=s::numeric;if n<=0 then raise exception using errcode='23514',message='Invalid review request.';end if;
 return trim_scale(n)::text;
end; $$;
create function public._work_unit_review_text(v jsonb,nullable boolean,maximum integer,nonblank boolean default false) returns text
language plpgsql immutable set search_path=public,pg_temp as $$
begin
 if nullable and v='null'::jsonb then return null;end if;
 if jsonb_typeof(v) is distinct from 'string' or length(v#>>'{}')>maximum
 or (nonblank and length(btrim(v#>>'{}',E' \t\r\n'))=0) then raise exception using errcode='23514',message='Invalid review request.';end if;
 return v#>>'{}';
end; $$;
create function public._work_unit_review_payload(p jsonb) returns jsonb
language plpgsql immutable set search_path=public,pg_temp as $$
declare a text;b jsonb;d jsonb;k text;e jsonb;ids uuid[]:='{}';n uuid;items jsonb:='[]';
begin
 if p is null or octet_length(p::text)>32768 then raise exception using errcode='23514',message='Invalid review request.';end if;
 perform public._work_activity_object(p,array['action','basis','data']);
 a:=public._work_unit_review_text(p->'action',false,30,true);b:=p->'basis';d:=p->'data';
 perform public._work_activity_object(b,array['unitId','unitRevision','factId','factRevision','scopeToken','reviewRevision','submissionId','generation']);
 foreach k in array array['unitId','factId','submissionId'] loop
 b:=jsonb_set(b,array[k],coalesce(to_jsonb(public._work_activity_uuid(b->k,k='submissionId')),'null'));
 end loop;
 foreach k in array array['unitRevision','factRevision','reviewRevision','generation'] loop
 b:=jsonb_set(b,array[k],to_jsonb(public._work_activity_integer(b->k,case when k='factRevision' then 1 else 0 end)));
 end loop;
 if public._work_unit_review_text(b->'scopeToken',false,68,true) !~ '^ur1:[0-9a-f]{64}$' then raise exception using errcode='23514',message='Invalid review request.';end if;
 if a='verify_dimensions' then
 perform public._work_activity_object(d,array['widthDecimal','heightDecimal','unit','source','sourceReference']);
 d:=jsonb_set(d,'{widthDecimal}',to_jsonb(public._work_unit_review_decimal(d->'widthDecimal')));
 d:=jsonb_set(d,'{heightDecimal}',to_jsonb(public._work_unit_review_decimal(d->'heightDecimal')));
 if public._work_unit_review_text(d->'unit',false,2) not in ('in','ft','mm','cm') or public._work_unit_review_text(d->'source',false,8) not in ('measured','plans') then raise exception using errcode='23514',message='Invalid review request.';end if;
 perform public._work_unit_review_text(d->'sourceReference',true,1000,true);
 elsif a in ('submit','pass','reopen') then
 perform public._work_activity_object(d,array['note']);perform public._work_unit_review_text(d->'note',true,2000);
 elsif a='fail' then
 perform public._work_activity_object(d,array['note','defects']);perform public._work_unit_review_text(d->'note',false,2000,true);
 if jsonb_typeof(d->'defects') is distinct from 'array' or jsonb_array_length(d->'defects')>20 then raise exception using errcode='23514',message='Invalid review request.';end if;
 for e in select value from jsonb_array_elements(d->'defects') loop
 perform public._work_activity_object(e,array['id','summary']);n:=public._work_activity_uuid(e->'id');
 if n=any(ids) then raise exception using errcode='23514',message='Invalid review request.';end if;ids:=array_append(ids,n);
 items:=items||jsonb_build_array(jsonb_build_object('id',n,'summary',public._work_unit_review_text(e->'summary',false,1000,true)));
 end loop;
 d:=jsonb_set(d,'{defects}',(select coalesce(jsonb_agg(value order by value->>'id'),'[]') from jsonb_array_elements(items)));
 elsif a='claim_resolved' then
 perform public._work_activity_object(d,array['note','defectIds']);perform public._work_unit_review_text(d->'note',true,2000);
 if jsonb_typeof(d->'defectIds') is distinct from 'array' or jsonb_array_length(d->'defectIds') not between 1 and 200 then raise exception using errcode='23514',message='Invalid review request.';end if;
 for e in select value from jsonb_array_elements(d->'defectIds') loop
 n:=public._work_activity_uuid(e);if n=any(ids) then raise exception using errcode='23514',message='Invalid review request.';end if;ids:=array_append(ids,n);
 end loop;
 d:=jsonb_set(d,'{defectIds}',(select jsonb_agg(x order by x) from unnest(ids) x));
 else raise exception using errcode='23514',message='Invalid review request.';end if;
 return jsonb_build_object('action',a,'basis',b,'data',d);
end; $$;

create function public._work_unit_review_authority(actor uuid,jobs jsonb,capability_name text) returns boolean
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare j jsonb;
begin
 if not public._work_config_internal(actor) then return false;end if;
 if public._work_config_is_supervisor(actor) then return true;end if;
 if not public._work_config_is_foreman(actor) or jsonb_array_length(jobs)=0 then return false;end if;
 for j in select value from jsonb_array_elements(jobs) loop
 if not exists(select 1 from public.work_job_management_grants where project_id=(j#>>'{}')::uuid and profile_id=actor and capability=capability_name and revoked_at is null) then return false;end if;
 end loop;return true;
end; $$;

create view public._work_unit_review_live_sources as
select 'custom_work_units'::text kind,r.id::text source_id,public._work_activity_source_material('custom_work_units',to_jsonb(r)) value from public.custom_work_units r
union all
select 'project_openings'::text kind,r.id::text source_id,public._work_activity_source_material('project_openings',to_jsonb(r)) value from public.project_openings r
union all
select 'service_visit_units'::text kind,r.id::text source_id,public._work_activity_source_material('service_visit_units',to_jsonb(r)) value from public.service_visit_units r
union all
select 'service_visits'::text kind,r.id::text source_id,public._work_activity_source_material('service_visits',to_jsonb(r)) value from public.service_visits r
union all
select 'summons'::text kind,r.id::text source_id,public._work_activity_source_material('summons',to_jsonb(r)) value from public.summons r
union all
select 'unit_redos'::text kind,r.id::text source_id,public._work_activity_source_material('unit_redos',to_jsonb(r)) value from public.unit_redos r
union all
select 'qc_checks'::text kind,r.id::text source_id,public._work_activity_source_material('qc_checks',to_jsonb(r)) value from public.qc_checks r
union all
select 'install_events'::text kind,r.id::text source_id,public._work_activity_source_material('install_events',to_jsonb(r)) value from public.install_events r
union all
select 'crew_work_records'::text kind,r.id::text source_id,public._work_activity_source_material('crew_work_records',to_jsonb(r)) value from public.crew_work_records r
union all
select 'crew_work_record_people'::text kind,r.record_id::text||':'||r.profile_id::text source_id,public._work_activity_source_material('crew_work_record_people',to_jsonb(r)) value from public.crew_work_record_people r
union all
select 'work_session_capture_metadata'::text kind,r.session_id::text source_id,public._work_activity_source_material('work_session_capture_metadata',to_jsonb(r)) value from public.work_session_capture_metadata r
union all
select 'custom_work_history'::text kind,r.id::text source_id,public._work_activity_source_material('custom_work_history',to_jsonb(r)) value from public.custom_work_history r
union all
select 'custom_work_sessions'::text kind,r.id::text source_id,public._work_activity_source_material('custom_work_sessions',to_jsonb(r)) value from public.custom_work_sessions r
union all
select 'unit_sessions'::text kind,r.id::text source_id,public._work_activity_source_material('unit_sessions',to_jsonb(r)) value from public.unit_sessions r
union all
select 'task_sessions'::text kind,r.id::text source_id,public._work_activity_source_material('task_sessions',to_jsonb(r)) value from public.task_sessions r
union all
select 'service_time_sessions'::text kind,r.id::text source_id,public._work_activity_source_material('service_time_sessions',to_jsonb(r)) value from public.service_time_sessions r
union all
select 'opening_phases'::text kind,r.id::text source_id,public._work_activity_source_material('opening_phases',to_jsonb(r)) value from public.opening_phases r
union all
select 'summon_helpers'::text kind,r.id::text source_id,public._work_activity_source_material('summon_helpers',to_jsonb(r)) value from public.summon_helpers r
;
revoke all on public._work_unit_review_live_sources from public,anon,authenticated,service_role;

-- Private complete source closure. Authorization precedes every returned identity
-- or digest. Legacy baseline plus every OLD/NEW version prevents current-row ABA.
create function public._work_unit_review_scope(actor uuid,unit_id uuid) returns jsonb
language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare ub jsonb;u public.custom_work_units;f public.work_unit_fact_revisions;
 history jsonb;live jsonb;jobs jsonb;openings jsonb;fact_origins jsonb;people uuid[];sourceids jsonb;v jsonb;w jsonb;j uuid;o uuid;
 active integer:=0;pending integer:=0;proven boolean:=true;dimension_proven boolean:=true;normal_sources jsonb;shift_history jsonb;dimension jsonb;manifest jsonb;integrity jsonb;inc bigint;
begin
 ub:=public._work_activity_unit_basis(unit_id,actor);if ub is null then return null;end if;
 select * into u from public.custom_work_units where id=unit_id;
 select r.* into f from public.work_unit_fact_revisions r join public.work_unit_fact_current c on c.current_revision_id=r.id where c.unit_id=u.id;
 inc:=(ub->>'incarnationEpoch')::bigint;
 if f.id is not null and (f.unit_id is distinct from u.id or not exists(select 1 from public.work_unit_fact_current c where c.unit_id=u.id and c.current_revision_id=f.id and c.current_revision=f.revision)) then return null;end if;
 -- A reused physical UUID cannot inherit a pre-existing history partition.
 -- Canonical writers already refuse it; administrative reconciliation is explicit.
 if inc<>0 then proven:=false;end if;
 with versions as materialized (
 select source_kind kind,source_id,b.value from public.work_activity_source_history h
 cross join lateral (values(h.before_value),(h.after_value)) b(value) where b.value<>'{}'
 union all
 select case e.source_kind when 'custom' then 'custom_work_sessions' when 'unit' then 'unit_sessions' when 'task' then 'task_sessions' when 'service' then 'service_time_sessions' when 'phase' then 'opening_phases' when 'helper' then 'summon_helpers' end,e.source_id::text,b.value
 from public.personal_activity_transition_sources e cross join lateral(values(e.before_evidence),(e.after_evidence)) b(value)
 where e.source_kind in ('custom','unit','task','service','phase','helper') and b.value<>'{}'
 union all select kind,source_id,value from public._work_unit_review_live_sources
 ), roots as (
 select value from versions where kind='custom_work_units' and source_id=u.id::text
 ), mapped as (
 select value->>'opening_id' id from roots where value->>'opening_id' is not null
 union select u.opening_id::text where u.opening_id is not null
 ), service_units as (
 select distinct source_id id from versions where kind='service_visit_units' and (value->>'work_unit_id'=u.id::text or value->>'opening_id' in(select id from mapped) or value->>'window_id' in(select value->>'assigned_window_id' from versions where kind='project_openings' and source_id in(select id from mapped)))
 ), summons_for_unit as (
 select distinct source_id id from versions where kind='summons' and value->>'opening_id' in(select id from mapped)
 ), crew as (
 select distinct source_id id from versions where kind='crew_work_records' and value->>'unit_id'=u.id::text
 ), custom_sessions as (
 select distinct source_id id from versions where kind='custom_work_sessions' and value->>'unit_id'=u.id::text
 union select value->>'session_id' from versions where kind='work_session_capture_metadata' and value->>'unit_id'=u.id::text
 ), visits as (
 select distinct value->>'visit_id' id from versions where kind='service_visit_units' and source_id in(select id from service_units)
 ), selected as (
 select distinct kind,source_id from versions where
 (kind='custom_work_units' and source_id=u.id::text)
 or (kind='project_openings' and source_id in(select id from mapped))
 or (kind in ('unit_sessions','task_sessions','opening_phases','unit_redos') and value->>'opening_id' in(select id from mapped))
 or (kind in ('qc_checks','install_events') and value->>'project_opening_id' in(select id from mapped))
 or (kind='custom_work_sessions' and source_id in(select id from custom_sessions))
 or (kind='service_visit_units' and source_id in(select id from service_units))
 or (kind='service_time_sessions' and value->>'unit_id' in(select id from service_units))
 or (kind='service_visits' and source_id in(select id from visits))
 or (kind='summons' and source_id in(select id from summons_for_unit))
 or (kind='summon_helpers' and value->>'summon_id' in(select id from summons_for_unit))
 or (kind='crew_work_records' and source_id in(select id from crew))
 or (kind='crew_work_record_people' and value->>'record_id' in(select id from crew))
 or (kind='work_session_capture_metadata' and (value->>'unit_id'=u.id::text or source_id in(select id from custom_sessions)))
 or (kind='custom_work_history' and (value->>'entity_id' in(select id from custom_sessions)
 or (value->>'entity_id'=u.id::text and (value->>'action' not in ('unit','link')
 or value#>'{before_value,facts,installation_complete}' is distinct from value#>'{after_value,facts,installation_complete}'))))
 ) select coalesce(jsonb_agg(jsonb_build_object('kind',kind,'id',source_id) order by kind,source_id),'[]') into sourceids from selected;
 if jsonb_array_length(sourceids)>4000 then return null;end if;
 select coalesce(jsonb_agg(to_jsonb(h) order by h.id),'[]') into history from public.work_activity_source_history h
 where exists(select 1 from jsonb_array_elements(sourceids) x where x->>'kind'=h.source_kind and x->>'id'=h.source_id);
 -- Baseline captures current rows only; missing pre-install intermediate work is unknown.
 if exists(select 1 from jsonb_array_elements(history) h where h->>'legacy_baseline'='true') then proven:=false;end if;
 if jsonb_array_length(history)>10000 or octet_length(history::text)>2000000 then return null;end if;
 select coalesce(jsonb_agg(jsonb_build_object('kind',s.kind,'id',s.source_id,'value',s.value) order by s.kind,s.source_id),'[]') into live
 from public._work_unit_review_live_sources s where exists(select 1 from jsonb_array_elements(sourceids) x where x->>'kind'=s.kind and x->>'id'=s.source_id);
 -- Re-enabled triggers cannot make an uncaptured live source trustworthy.
 -- Also reject current material never retained for that exact source identity.
 if exists(select 1 from jsonb_array_elements(live) l where not exists(
 select 1 from public.work_activity_source_history h where h.source_kind=l->>'kind' and h.source_id=l->>'id' and h.after_value=l->'value')) then proven:=false;end if;
 select coalesce(jsonb_agg(jsonb_build_object('source',to_jsonb(e),'actor',t.actor_id,'recordedAt',t.received_at,
 'selectedAt',t.selected_effective_at,'timeReason',t.time_selection_reason,'commandId',t.command_id,'requestId',t.source_request_id) order by e.id),'[]') into normal_sources
 from public.personal_activity_transition_sources e join public.personal_activity_transitions t on t.id=e.transition_id
 where exists(select 1 from jsonb_array_elements(sourceids) x where x->>'id'=e.source_id::text and x->>'kind'=case e.source_kind when 'custom' then 'custom_work_sessions' when 'unit' then 'unit_sessions' when 'task' then 'task_sessions' when 'service' then 'service_time_sessions' when 'phase' then 'opening_phases' when 'helper' then 'summon_helpers' end);
 -- Only shift mutations that affect an included interval/binding enter its
 -- lifecycle. A later unrelated activity or break on the same shift does not.
 with intervals as (
 select distinct r.value v from jsonb_array_elements(history) h
 cross join lateral(values(h->'before_value'),(h->'after_value')) r(value)
 where h->>'source_kind' in ('custom_work_sessions','service_time_sessions') and r.value->>'shift_id' is not null
 ), relevant as (
 select distinct h.* from public.work_activity_source_history h join intervals i on h.source_kind='time_shifts' and h.source_id=i.v->>'shift_id'
 where h.legacy_baseline or h.after_value='{}'
 or (h.before_value<>'{}' and (h.before_value->'profile_id' is distinct from h.after_value->'profile_id' or h.before_value->'project_id' is distinct from h.after_value->'project_id'))
 or exists(select 1 from (values(h.before_value),(h.after_value)) b(v) where b.v<>'{}' and
 (b.v->>'status' in ('needs_finish','rejected','voided') or b.v->>'profile_id' is distinct from i.v->>'profile_id'
 or (b.v->>'clock_in_at')::timestamptz>(i.v->>'started_at')::timestamptz
 or (i.v->>'ended_at' is not null and b.v->>'clock_out_at' is not null and (b.v->>'clock_out_at')::timestamptz<(i.v->>'ended_at')::timestamptz)))
 ) select coalesce(jsonb_agg(to_jsonb(h) order by h.id),'[]') into shift_history from relevant h;
 if exists(select 1 from jsonb_array_elements(shift_history) h where h->>'legacy_baseline'='true') then proven:=false;end if;
 -- Old collapsed engine events do not prove their lost intermediate bindings.
 if exists(select 1 from jsonb_array_elements(normal_sources) n where not exists(
 select 1 from public.work_activity_source_history h where h.source_id=n#>>'{source,source_id}' and not h.legacy_baseline
 and (n#>>'{source,transition_id}')::uuid=any(h.transition_ids)
 and h.source_kind=case n#>>'{source,source_kind}' when 'custom' then 'custom_work_sessions' when 'unit' then 'unit_sessions' when 'task' then 'task_sessions' when 'service' then 'service_time_sessions' when 'phase' then 'opening_phases' when 'helper' then 'summon_helpers' end)) then proven:=false;end if;
 -- Captured and prior-review facts keep their original source partition even
 -- after a replacement observation moves the current fact to another context.
 select coalesce(jsonb_agg(to_jsonb(r) order by r.id),'[]') into fact_origins
 from public.work_unit_fact_revisions r where r.unit_id=u.id and r.unit_incarnation_epoch=inc and
 (r.id=f.id or exists(select 1 from jsonb_array_elements(live) m where m->>'kind'='work_session_capture_metadata' and m#>>'{value,unit_id}'=u.id::text and (m#>>'{value,fact_revision}')::bigint=r.revision)
 or exists(select 1 from public.work_unit_review_events e where e.unit_id=u.id and e.incarnation=inc and e.basis->>'factId'=r.id::text));
 for v in select value from jsonb_array_elements(fact_origins) loop
 if not public._work_unit_fact_context_visible(actor,v->>'origin_kind',(v->>'origin_project_id')::uuid,(v->>'origin_opening_id')::uuid,(v->>'origin_author_id')::uuid,(v->>'origin_is_test')::boolean,true) then return null;end if;
 end loop;
 -- Every historical/current direct job and opening, plus retained review origins.
 with material as (
 select r.value from jsonb_array_elements(history) h cross join lateral(values(h->'before_value'),(h->'after_value')) r(value)
 union all select x->'value' from jsonb_array_elements(live) x
 union all select r.value from jsonb_array_elements(normal_sources) e cross join lateral(values(e#>'{source,before_evidence}'),(e#>'{source,after_evidence}')) r(value)
 ), shift_refs as (
 select distinct value->>'shift_id' id from material where value->>'shift_id' is not null
 union select n#>>'{source,source_shift_id}' from jsonb_array_elements(normal_sources) n where n#>>'{source,source_shift_id}' is not null
 ), deps as (
 select value->>'project_id' job,coalesce(value->>'opening_id',value->>'project_opening_id') opening from material
 union all select t.project_id::text,null from public.time_shifts t where t.id::text in(select id from shift_refs)
 union all select r.value->>'project_id',null from public.work_activity_source_history h cross join lateral(values(h.before_value),(h.after_value)) r(value) where h.source_kind='time_shifts' and h.source_id in(select id from shift_refs)
 union all select u.project_id::text,u.opening_id::text
 union all select f.origin_project_id::text,f.origin_opening_id::text
 union all select x->>'origin_project_id',x->>'origin_opening_id' from jsonb_array_elements(fact_origins) x
 union all select x#>>'{}',null from public.work_unit_review_events e cross join lateral jsonb_array_elements(e.scope_manifest->'jobs') x where e.unit_id=u.id and e.incarnation=inc
 union all select null,x#>>'{}' from public.work_unit_review_events e cross join lateral jsonb_array_elements(e.scope_manifest->'openings') x where e.unit_id=u.id and e.incarnation=inc
 ) select (select coalesce(jsonb_agg(job order by job),'[]') from(select distinct job from deps where job is not null) a),
 (select coalesce(jsonb_agg(opening order by opening),'[]') from(select distinct opening from deps where opening is not null) b) into jobs,openings;
 for v in select value from jsonb_array_elements(openings) loop
 select project_id into j from public.project_openings where id=(v#>>'{}')::uuid and removed_at is null;
 if j is null or not public._ai_job_visible(j,actor) then return null;end if;
 jobs:=jobs||to_jsonb(j);
 end loop;
 select coalesce(jsonb_agg(distinct value order by value),'[]') into jobs from jsonb_array_elements(jobs);
 for v in select value from jsonb_array_elements(jobs) loop
 if not public._ai_job_visible((v#>>'{}')::uuid,actor) then return null;end if;
 end loop;
 -- Service grants are an additional source gate, never replaced by job visibility.
 for v in select h->'value' from jsonb_array_elements(live) h where h->>'kind' like 'service_%'
 union all select r.value from jsonb_array_elements(history) h cross join lateral(values(h->'before_value'),(h->'after_value')) r(value) where h->>'source_kind' like 'service_%' and r.value<>'{}' loop
 if v->>'project_id' is null or not public.service_job_access((v->>'project_id')::uuid) then return null;end if;
 end loop;
 -- Source transfer retains and authorizes BOTH unit contexts, without treating
 -- all work on that destination unit as work on this unit.
 for v in select r.value from jsonb_array_elements(history) h cross join lateral(values(h->'before_value'),(h->'after_value')) r(value)
 where h->>'source_kind' in ('custom_work_sessions','work_session_capture_metadata','service_visit_units') loop
 j:=coalesce(v->>'work_unit_id',v->>'unit_id')::uuid;
 if j is not null and public._work_activity_unit_basis(j,actor) is null then return null;end if;
 end loop;
 -- Only actual engine subjects belong here: sessions/helpers use profile_id,
 -- phases use started_by. Creators/reviewers are not guessed work subjects.
 select array_agg(distinct p.id::uuid) filter(where p.id is not null) into people
 from (select h->>'source_kind' kind,r.value v from jsonb_array_elements(history) h
 cross join lateral(values(h->'before_value'),(h->'after_value')) r(value)
 union all select l->>'kind',l->'value' from jsonb_array_elements(live) l) x
 cross join lateral(values(x.v->>'profile_id'),(case when x.kind='opening_phases' then x.v->>'started_by' end)) p(id);
 -- Exact source safety never depends on an independently collected person set.
 -- Source-less state uncertainty remains conservative: backdated or missing
 -- intervals cannot prove that it affected only some other unit.
 select coalesce(jsonb_agg(to_jsonb(e) order by e.id),'[]') into integrity from public.work_activity_safety_events e
 where (e.source_kind='state' and e.profile_id=any(coalesce(people,'{}')))
 or exists(select 1 from jsonb_array_elements(sourceids) x where x->>'id'=e.source_id::text and x->>'kind'=case e.source_kind when 'custom' then 'custom_work_sessions' when 'unit' then 'unit_sessions' when 'task' then 'task_sessions' when 'service' then 'service_time_sessions' when 'phase' then 'opening_phases' when 'helper' then 'summon_helpers' end);
 if integrity<>'[]' then proven:=false;end if;
 if exists(select 1 from public.personal_activity_state where profile_id=any(coalesce(people,'{}')) and (revision>=9007199254740991 or integrity_state<>'clean')) then proven:=false;end if;
 if exists(select 1 from public.service_time_sessions t where t.unit_id is not null and to_jsonb(t.project_id) in(select value from jsonb_array_elements(jobs)) and not exists(select 1 from public.work_activity_source_history h where h.source_kind='service_visit_units' and h.source_id=t.unit_id::text)) then proven:=false;end if;
 if exists(select 1 from public.work_unit_fact_context_epochs where epoch>=9007199254740991 and
 ((scope_kind like 'unit_%' and scope_id=u.id) or (scope_kind='opening' and to_jsonb(scope_id) in(select value from jsonb_array_elements(openings))) or (scope_kind='project' and to_jsonb(scope_id) in(select value from jsonb_array_elements(jobs))))) then proven:=false;dimension_proven:=false;end if;
 for v in select value from jsonb_array_elements(live) loop
 w:=v->'value';
 if v->>'kind' in ('custom_work_sessions','unit_sessions','task_sessions','service_time_sessions') then
 if w->>'started_at' is null or (w->>'ended_at' is not null and (w->>'ended_at')::timestamptz<(w->>'started_at')::timestamptz) then proven:=false;end if;
 if w->>'ended_at' is null and (v->>'kind'<>'task_sessions' or w->>'state'='on_task') then active:=active+1;end if;
 if w->>'review_required'='true' or w->>'shift_status' in ('needs_finish','rejected','voided') then pending:=pending+1;proven:=false;end if;
 if w->>'shift_id' is not null then
 if not exists(select 1 from public.time_shifts s where s.id=(w->>'shift_id')::uuid and s.status not in ('needs_finish','rejected','voided') and s.profile_id=(w->>'profile_id')::uuid
 and s.clock_in_at<=(w->>'started_at')::timestamptz and (s.clock_out_at is null or (w->>'ended_at' is not null and s.clock_out_at>=(w->>'ended_at')::timestamptz))) then proven:=false;pending:=pending+1;end if;
 end if;
 elsif v->>'kind'='opening_phases' and w->>'status' not in ('submitted','approved','done','complete') then pending:=pending+1;
 elsif v->>'kind'='summon_helpers' and w->>'completed_at' is null and w->>'canceled_at' is null then active:=active+1;
 elsif v->>'kind'='unit_redos' and w->>'resolved_at' is null then pending:=pending+1;
 elsif v->>'kind'='qc_checks' and w->>'status'='callback' then pending:=pending+1;
 elsif v->>'kind'='service_visit_units' and w->>'outcome'<>'resolved' then pending:=pending+1;
 end if;
 end loop;
 select pending+count(*)::integer into pending from public.personal_activity_state s where s.resume_token is not null and exists(
 select 1 from jsonb_array_elements(sourceids) x where x->>'id'=s.resume_source_id::text and x->>'kind'=case s.resume_source_kind when 'custom' then 'custom_work_sessions' when 'unit' then 'unit_sessions' when 'task' then 'task_sessions' when 'service' then 'service_time_sessions' when 'phase' then 'opening_phases' end);
 -- Snapshot the current intervals/review-required state; no global authority
 -- generation or unrelated person's revision appears in the unit token.
 dimension:=jsonb_build_object('version',1,'unit',ub-array['operationalRevision','eligibleForCapture','ineligibleReason'],'fact',to_jsonb(f));
 manifest:=jsonb_build_object('version',1,'unitId',u.id,'incarnation',inc,'dimension',dimension,
 'jobs',jobs,'openings',openings,'factOrigins',fact_origins,'completion',u.facts->'installation_complete','history',history,'current',live,'transitions',normal_sources,'shiftLifecycle',shift_history,'safety',integrity,'active',active,'pending',pending);
 if octet_length(manifest::text)>2500000 then return null;end if;
 return jsonb_build_object('unit',ub,'dimension',dimension,'manifest',manifest,'jobs',jobs,'openings',openings,
 'scopeToken','ur1:'||encode(sha256(convert_to(manifest::text,'UTF8')),'hex'),
 'proven',proven,'dimensionProven',dimension_proven,'active',active,'pending',pending,'observation',case when f.raw_observation is null then null else
 jsonb_build_object('observerId',f.observation_actor_id,'source',f.measurement_source,'widthDecimal',trim_scale((f.raw_observation->>'width')::numeric)::text,
 'heightDecimal',trim_scale((f.raw_observation->>'height')::numeric)::text,'unit',f.measurement_unit,'sourceReference',f.source_reference) end);
end; $$;

-- Replaced only by the generated exact installed coverage contract below.
create function public._work_unit_review_coverage() returns boolean language sql stable security definer set search_path=public,pg_temp as $$ select false $$;

create function public._work_unit_review_defect_projection(p_unit uuid,p_inc bigint) returns jsonb
language sql stable security definer set search_path=public,pg_temp as $$
 select coalesce(jsonb_agg(jsonb_build_object('id',d.id,'summary',d.summary,'state',s.state) order by d.id),'[]')
 from public.work_unit_review_defects d cross join lateral (
 select state from public.work_unit_review_defect_events where defect_id=d.id order by review_revision desc limit 1) s
 where d.unit_id=p_unit and d.incarnation=p_inc
$$;
create function public._work_unit_review_view(actor uuid,s jsonb) returns jsonb
language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare c public.work_unit_review_current;verification public.work_unit_dimension_verifications;submission public.work_unit_review_events;
 q public.work_unit_review_events;b jsonb;defects jsonb;observation jsonb;inc bigint;uid uuid;ready boolean;proof boolean;matches boolean;qcstate text;acceptance text;dvstate text;
 verify_allowed boolean;reviewer boolean;factusable boolean;
begin
 if s is null then return null;end if;uid:=(s#>>'{unit,id}')::uuid;inc:=(s#>>'{unit,incarnationEpoch}')::bigint;
 select * into c from public.work_unit_review_current where unit_id=uid and incarnation=inc;
 if c.unit_id is null and exists(select 1 from public.work_unit_review_events where unit_id=uid and incarnation=inc) then return null;end if;
 if c.unit_id is not null and not exists(select 1 from public.work_unit_review_events e where e.id=c.latest_event_id and e.unit_id=uid and e.incarnation=inc and e.review_revision=c.review_revision and e.generation=c.generation) then return null;end if;
 select * into verification from public.work_unit_dimension_verifications where id=c.dimension_verification_id;
 if verification.id is not null and (verification.unit_id<>uid or verification.incarnation<>inc) then return null;end if;
 select * into submission from public.work_unit_review_events where id=c.current_submission_id;
 select * into q from public.work_unit_review_events where id=c.latest_qc_event_id;
 defects:=public._work_unit_review_defect_projection(uid,inc);
 if jsonb_array_length(defects)>200 or jsonb_array_length(defects)<>(select count(*) from public.work_unit_review_defects where unit_id=uid and incarnation=inc) then return null;end if;
 observation:=s->'observation';
 factusable:=s#>>'{unit,fact,id}' is not null and observation<>'null'::jsonb
 and s#>>'{unit,fact,eventKind}' not in ('incomplete','cleared')
 and (s#>>'{dimension,fact,unit_binding_epoch}')::bigint=(s#>>'{unit,bindingEpoch}')::bigint;
 factusable:=coalesce(factusable,false);
 proof:=(s->>'proven')::boolean and public._work_unit_review_coverage();
 ready:=(s->>'active')::integer=0 and (s->>'pending')::integer=0;
 matches:=submission.id is not null and submission.scope_manifest=s->'manifest' and submission.scope_token=s->>'scopeToken';
 qcstate:=coalesce(c.qc_state,'not_submitted');
 acceptance:='not_accepted';
 if qcstate in ('passed','awaiting_review') and not coalesce(matches,false) then qcstate:='not_submitted';acceptance:='noncurrent';end if;
 if c.qc_state='passed' and coalesce(matches,false) then
 if q.action<>'pass' or q.unit_id is distinct from uid or q.incarnation is distinct from inc or q.generation is distinct from c.generation or q.submission_id is distinct from c.current_submission_id then return null;end if;
 acceptance:=case when not proof then 'recorded_only' when ready and not exists(select 1 from jsonb_array_elements(defects) x where x->>'state'<>'verified_resolved') then 'accepted' else 'noncurrent' end;
 end if;
 dvstate:=case when verification.id is null then 'unverified' when verification.dimension_manifest=s->'dimension' and (s->>'dimensionProven')::boolean then 'verified' else 'noncurrent' end;
 reviewer:=public._work_unit_review_authority(actor,s->'jobs','final_qc');
 verify_allowed:=factusable and (s->>'dimensionProven')::boolean and observation->>'observerId' is not null and observation->>'observerId'<>actor::text and public._work_unit_review_authority(actor,s->'jobs','dimensions_edit');
 b:=case when s#>>'{unit,fact,id}' is null then null else jsonb_build_object('unitId',uid,'unitRevision',s#>'{unit,operationalRevision}',
 'factId',s#>'{unit,fact,id}','factRevision',s#>'{unit,fact,revision}','scopeToken',s->'scopeToken',
 'reviewRevision',coalesce(c.review_revision,0),'submissionId',c.current_submission_id,'generation',coalesce(c.generation,0)) end;
 return jsonb_build_object('basis',b,'basisStatus',case when b is null then 'unavailable' else 'current' end,
 'capabilities',jsonb_build_object('verifyDimensions',coalesce(verify_allowed,false),'submit',factusable and ready,
 'pass',factusable and reviewer and ready and coalesce(matches,false) and qcstate='awaiting_review' and not exists(select 1 from jsonb_array_elements(defects) x where x->>'state'='open'),
 'fail',factusable and reviewer and c.current_submission_id is not null,
 'claimResolved',factusable and exists(select 1 from jsonb_array_elements(defects) x where x->>'state'='open'),
 'reopen',factusable and reviewer),
 'observation',observation,'dimensionVerification',jsonb_build_object('state',dvstate,'verificationId',verification.id),
 'qc',jsonb_build_object('state',qcstate,'acceptance',acceptance,'lifecycle',case when proof then 'proven' else 'unproven' end,'qcAccepted',acceptance='accepted'),
 'work',jsonb_build_object('availability','available','activeCount',s->'active','pendingCount',s->'pending'),'defects',defects);
end; $$;

create function public.work_unit_review_read(p_unit_id uuid) returns jsonb
language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare actor uuid;s jsonb;v jsonb;t timestamptz;
begin
 perform public._work_activity_read_committed();perform public._work_activity_gate();actor:=public._work_activity_actor();
 perform pg_advisory_xact_lock(7710,0);actor:=public._work_activity_actor();t:=clock_timestamp();
 s:=public._work_unit_review_scope(actor,p_unit_id);v:=public._work_unit_review_view(actor,s);
 if octet_length(v::text)>102400 then v:=null;end if;
 return jsonb_build_object('protocolVersion',1,'asOf',public._work_activity_iso(t),'availability',case when v is null then 'unavailable' else 'available' end,'review',v);
end; $$;

create function public.work_unit_review_command_receipt(p_command_id uuid) returns jsonb
language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare actor uuid;c public.work_unit_review_commands;s jsonb;
begin
 perform public._work_activity_read_committed();perform public._work_activity_gate();actor:=public._work_activity_actor();
 perform pg_advisory_xact_lock(7710,0);actor:=public._work_activity_actor();
 select * into c from public.work_unit_review_commands where command_id=p_command_id and actor_id=actor;
 if c.command_id is not null then s:=public._work_unit_review_scope(actor,c.unit_id);end if;
 if s is null or (s#>>'{unit,incarnationEpoch}')::bigint is distinct from c.incarnation then
 return jsonb_build_object('protocolVersion',1,'availability','unavailable','receipt',null);end if;
 return jsonb_build_object('protocolVersion',1,'availability','available','receipt',c.receipt);
end; $$;

create function public.work_unit_review_command(p_command_id uuid,p_protocol_version integer,p_payload jsonb) returns jsonb
language plpgsql volatile security definer set search_path=public,pg_temp as $$
#variable_conflict use_column
declare actor uuid;p jsonb;a text;b jsonb;d jsonb;s jsonb;v jsonb;prior public.work_unit_review_commands;
 u public.custom_work_units;c public.work_unit_review_current;inc bigint;eid uuid:=gen_random_uuid();vid uuid;stamp timestamptz;
 defects jsonb;x jsonb;selected uuid[];state text;revision bigint;generation bigint;submission uuid;qc uuid;receipt jsonb;
 nw numeric;nh numeric;ow numeric;oh numeric;nn numeric;nd numeric;onum numeric;oden numeric;factor text;cap text;
begin
 -- Caller-owned syntax only before G; no source reads or IDs are disclosed here.
 if p_command_id is null or p_protocol_version is distinct from 1 then raise exception using errcode='23514',message='Invalid review request.';end if;
 p:=public._work_unit_review_payload(p_payload);a:=p->>'action';b:=p->'basis';d:=p->'data';
 perform public._work_activity_read_committed();perform public._work_activity_gate();actor:=public._work_activity_actor();
 perform pg_advisory_xact_lock(7710,0);actor:=public._work_activity_actor();
 select * into prior from public.work_unit_review_commands where command_id=p_command_id;
 if prior.command_id is not null then
 if prior.actor_id<>actor or prior.normalized_request<>p or prior.protocol_version<>p_protocol_version then raise exception using errcode='42501',message='Unit review is unavailable.';end if;
 s:=public._work_unit_review_scope(actor,prior.unit_id);
 if s is null or (s#>>'{unit,incarnationEpoch}')::bigint is distinct from prior.incarnation then raise exception using errcode='42501',message='Unit review is unavailable.';end if;
 return prior.receipt;
 end if;
 select * into u from public.custom_work_units where id=(b->>'unitId')::uuid for update;
 actor:=public._work_activity_actor();s:=public._work_unit_review_scope(actor,u.id);v:=public._work_unit_review_view(actor,s);
 if v is null then raise exception using errcode='42501',message='Unit review is unavailable.';end if;
 if v->'basis' is distinct from b then raise exception using errcode='40001',message='Unit review changed. Refresh before saving.';end if;
 cap:=case a when 'verify_dimensions' then 'verifyDimensions' when 'claim_resolved' then 'claimResolved' else a end;
 if coalesce((v#>>array['capabilities',cap])::boolean,false) is not true then raise exception using errcode='42501',message='Unit review is unavailable.';end if;
 inc:=(s#>>'{unit,incarnationEpoch}')::bigint;
 select * into c from public.work_unit_review_current where unit_id=u.id and incarnation=inc;
 revision:=coalesce(c.review_revision,0)+1;generation:=coalesce(c.generation,0);submission:=c.current_submission_id;qc:=c.latest_qc_event_id;vid:=c.dimension_verification_id;
 if revision>9007199254740991 then raise exception using errcode='55000',message='Unit review is unavailable.';end if;
 state:=coalesce(c.qc_state,'not_submitted');defects:=v->'defects';stamp:=clock_timestamp();
 if a='verify_dimensions' then
 nw:=(d->>'widthDecimal')::numeric;nh:=(d->>'heightDecimal')::numeric;
 ow:=(s#>>'{observation,widthDecimal}')::numeric;oh:=(s#>>'{observation,heightDecimal}')::numeric;
 nn:=case d->>'unit' when 'in' then 1 when 'ft' then 12 when 'mm' then 5 when 'cm' then 50 end;
 nd:=case when d->>'unit' in ('mm','cm') then 127 else 1 end;
 onum:=case s#>>'{observation,unit}' when 'in' then 1 when 'ft' then 12 when 'mm' then 5 when 'cm' then 50 end;
 oden:=case when s#>>'{observation,unit}' in ('mm','cm') then 127 else 1 end;
 if nn is null or onum is null or nw*nn>100000*nd or nh*nn>100000*nd
 or nw*nn*oden is distinct from ow*onum*nd or nh*nn*oden is distinct from oh*onum*nd then raise exception using errcode='23514',message='The corroborating dimensions do not match this observation.';end if;
 vid:=gen_random_uuid();
 insert into public.work_unit_dimension_verifications(id,command_id,unit_id,incarnation,fact_id,fact_revision,observation_actor_id,reviewer_id,corroboration,dimension_manifest,recorded_at)
 values(vid,p_command_id,u.id,inc,(b->>'factId')::uuid,(b->>'factRevision')::bigint,(s#>>'{observation,observerId}')::uuid,actor,d,s->'dimension',stamp);
 elsif a='submit' then
 generation:=case when submission is null then greatest(generation,1) else generation+1 end;submission:=eid;state:='awaiting_review';
 elsif a='reopen' then
 generation:=generation+1;submission:=null;state:=case when exists(select 1 from jsonb_array_elements(defects) x where x->>'state'<>'verified_resolved') then 'failed' else 'not_submitted' end;qc:=eid;
 elsif a='fail' then
 if jsonb_array_length(d->'defects')=0 and not exists(select 1 from jsonb_array_elements(defects) x where x->>'state'='claimed_resolved') then raise exception using errcode='23514',message='A failed review needs a defect or an existing correction claim.';end if;
 if jsonb_array_length(defects)+jsonb_array_length(d->'defects')>200 or exists(select 1 from jsonb_array_elements(d->'defects') x join public.work_unit_review_defects z on z.id=(x->>'id')::uuid) then raise exception using errcode='23514',message='Unit review is unavailable.';end if;
 if octet_length(jsonb_set(v,'{defects}',defects||(select coalesce(jsonb_agg(value||jsonb_build_object('state','open')),'[]') from jsonb_array_elements(d->'defects')))::text)>102400 then raise exception using errcode='23514',message='Unit review is too large.';end if;
 state:='failed';qc:=eid;
 elsif a='claim_resolved' then
 select array_agg((value#>>'{}')::uuid) into selected from jsonb_array_elements(d->'defectIds');
 if exists(select 1 from unnest(selected) i where not exists(select 1 from jsonb_array_elements(defects) x where x->>'id'=i::text and x->>'state'='open')) then raise exception using errcode='23514',message='Unit review is unavailable.';end if;
 if not exists(select 1 from jsonb_array_elements(defects) x where x->>'state'='open' and not((x->>'id')::uuid=any(selected))) then
 if (s->>'active')::integer<>0 or (s->>'pending')::integer<>0 then raise exception using errcode='23514',message='Finish this unit work before submitting corrections.';end if;
 generation:=generation+1;submission:=eid;state:='awaiting_review';
 else state:='failed';end if;
 elsif a='pass' then state:='passed';qc:=eid;
 end if;
 if generation>9007199254740991 then raise exception using errcode='55000',message='Unit review is unavailable.';end if;
 insert into public.work_unit_review_events(id,unit_id,incarnation,review_revision,command_id,action,actor_id,predecessor_event_id,generation,submission_id,basis,scope_manifest,scope_token,coverage_version,note,prior_state,resulting_state,recorded_at)
 values(eid,u.id,inc,revision,p_command_id,a,actor,c.latest_event_id,generation,submission,b,s->'manifest',s->>'scopeToken',case when (s->>'proven')::boolean and public._work_unit_review_coverage() then 1 else 0 end,d->>'note',coalesce(c.qc_state,'not_submitted'),state,stamp);
 -- Every carried unresolved defect gets an explicit generation-membership event.
 for x in select value from jsonb_array_elements(defects) loop
 factor:=x->>'state';
 if a='claim_resolved' and (x->>'id')::uuid=any(selected) then factor:='claimed_resolved';
 elsif a='pass' and factor='claimed_resolved' then factor:='verified_resolved';
 elsif a='fail' and factor='claimed_resolved' then factor:='open';end if;
 if factor is distinct from x->>'state' or (generation<>coalesce(c.generation,0) and factor<>'verified_resolved') then
 insert into public.work_unit_review_defect_events(defect_id,review_event_id,review_revision,active_generation,actor_id,state,note,recorded_at)
 values((x->>'id')::uuid,eid,revision,generation,actor,factor,d->>'note',stamp);end if;
 end loop;
 if a='fail' then
 for x in select value from jsonb_array_elements(d->'defects') loop
 insert into public.work_unit_review_defects(id,unit_id,incarnation,origin_event_id,origin_submission_id,origin_generation,creator_id,original_project_id,original_opening_id,summary,recorded_at)
 values((x->>'id')::uuid,u.id,inc,eid,submission,generation,actor,u.project_id,u.opening_id,x->>'summary',stamp);
 insert into public.work_unit_review_defect_events(defect_id,review_event_id,review_revision,active_generation,actor_id,state,note,recorded_at)
 values((x->>'id')::uuid,eid,revision,generation,actor,'open',d->>'note',stamp);end loop;
 end if;
 insert into public.work_unit_review_current(unit_id,incarnation,review_revision,generation,latest_event_id,latest_qc_event_id,current_submission_id,dimension_verification_id,qc_state)
 values(u.id,inc,revision,generation,eid,qc,submission,vid,state)
 on conflict(unit_id,incarnation) do update set review_revision=excluded.review_revision,generation=excluded.generation,latest_event_id=excluded.latest_event_id,
 latest_qc_event_id=excluded.latest_qc_event_id,current_submission_id=excluded.current_submission_id,dimension_verification_id=excluded.dimension_verification_id,qc_state=excluded.qc_state;
 receipt:=jsonb_build_object('protocolVersion',1,'commandId',p_command_id,'action',a,'unitId',u.id,'eventId',eid,'reviewRevision',revision,'generation',generation,'submissionId',submission,'recordedAt',public._work_activity_iso(stamp),'outcome','applied');
 insert into public.work_unit_review_commands(command_id,actor_id,protocol_version,action,unit_id,incarnation,normalized_request,request_digest,receipt,recorded_at)
 values(p_command_id,actor,1,a,u.id,inc,p,encode(sha256(convert_to(p::text,'UTF8')),'hex'),receipt,stamp);
 return receipt;
end; $$;

-- All helpers and private projections deny even service_role raw access.
revoke all on function public._work_unit_review_decimal(jsonb) from public,anon,authenticated,service_role;
revoke all on function public._work_unit_review_text(jsonb,boolean,integer,boolean) from public,anon,authenticated,service_role;
revoke all on function public._work_unit_review_payload(jsonb) from public,anon,authenticated,service_role;
revoke all on function public._work_unit_review_authority(uuid,jsonb,text) from public,anon,authenticated,service_role;
revoke all on function public._work_unit_review_scope(uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function public._work_unit_review_coverage() from public,anon,authenticated,service_role;
revoke all on function public._work_unit_review_defect_projection(uuid,bigint) from public,anon,authenticated,service_role;
revoke all on function public._work_unit_review_view(uuid,jsonb) from public,anon,authenticated,service_role;
revoke all on function public.work_unit_review_read(uuid) from public,anon,authenticated,service_role;
revoke all on function public.work_unit_review_command(uuid,integer,jsonb) from public,anon,authenticated,service_role;
revoke all on function public.work_unit_review_command_receipt(uuid) from public,anon,authenticated,service_role;
grant execute on function public.work_unit_review_read(uuid) to authenticated;
grant execute on function public.work_unit_review_command(uuid,integer,jsonb) to authenticated;
grant execute on function public.work_unit_review_command_receipt(uuid) to authenticated;


-- Extend the exact existing service-only identity census. Immutable nested
-- source snapshots retain every original participant, including transferred rows.
do $$ begin
 if encode(sha256(convert_to((select prosrc from pg_proc where oid='public.person_record_counts(uuid)'::regprocedure),'UTF8')),'hex')<>'07d7d29160e2e009292ce6a28620c1499c7e58235c7369467d594c968a444056' then
 raise exception using errcode='55000',message='Unit review identity contract is unavailable.';end if;
end; $$;
create or replace function public.person_record_counts(p_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'hex_learning_reviews.author_id', (select count(*) from hex_learning_reviews where author_id = p_id),
    'hex_learning_reviews.reviewer_id', (select count(*) from hex_learning_reviews where reviewer_id = p_id),
    'hex_learning_reviews.decided_by', (select count(*) from hex_learning_reviews where decided_by = p_id),
    'hex_learning_review_events.actor_id', (select count(*) from hex_learning_review_events where actor_id = p_id),
    'hex_learning_reviews.withdrawn_by', (select count(*) from hex_learning_reviews where withdrawn_by = p_id),
    'hex_learning_deliveries.last_caller', (select count(*) from hex_learning_deliveries where last_caller = p_id),
    'hex_learning_withdrawals.last_caller', (select count(*) from hex_learning_withdrawals where last_caller = p_id),
    'ai_field_requests.profile_id', (select count(*) from ai_field_requests where profile_id = p_id),
    'ai_field_actions.profile_id', (select count(*) from ai_field_actions where profile_id = p_id),
    'daily_log_contributions.actor_id', (select count(*) from daily_log_contributions where actor_id = p_id),
    'crew_work_records.filed_by', (select count(*) from crew_work_records where filed_by = p_id),
    'crew_work_record_people.profile_id', (select count(*) from crew_work_record_people where profile_id = p_id),
 'hex_portal_cases.asker_id',(select count(*) from public.hex_portal_cases where asker_id=p_id),
 'hex_portal_outcomes.actor_id',(select count(*) from public.hex_portal_outcomes where actor_id=p_id),
 'hex_portal_guidance_receipts.actor_id',(select count(*) from public.hex_portal_guidance_receipts where actor_id=p_id),'time_off_requests.profile_id',(select count(*) from time_off_requests where profile_id=p_id),'crew_reminders.profile_id',(select count(*) from crew_reminders where profile_id=p_id)) || jsonb_build_object('service_visits.created_by',(select count(*) from service_visits where created_by=p_id),'service_visit_units.created_by',(select count(*) from service_visit_units where created_by=p_id),'service_time_sessions.profile_id',(select count(*) from service_time_sessions where profile_id=p_id),'service_media.created_by',(select count(*) from service_media where created_by=p_id),'service_audit.actor_id',(select count(*) from service_audit where actor_id=p_id),'service_commands.profile_id',(select count(*) from service_commands where profile_id=p_id)) || jsonb_build_object(
    'custom_work_units.created_by', (select count(*) from custom_work_units where created_by = p_id),
    'custom_work_sessions.profile_id', (select count(*) from custom_work_sessions where profile_id = p_id),
    'custom_work_history.actor_id', (select count(*) from custom_work_history where actor_id = p_id),
    'custom_work_commands.profile_id', (select count(*) from custom_work_commands where profile_id = p_id),

    'workflow_plans.created_by', (select count(*) from workflow_plans where created_by = p_id),
    'workflow_plan_revisions.actor', (select count(*) from workflow_plan_revisions where actor = p_id),
    'workflow_notice_outbox.profile_id', (select count(*) from workflow_notice_outbox where profile_id = p_id),
    -- Time and money.
    'time_clock_actions.profile_id',
      (select count(*) from time_clock_actions where profile_id = p_id),
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
    'semimonthly_timecard_periods.profile_id',
      (select count(*) from semimonthly_timecard_periods where profile_id = p_id),
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
  ) || jsonb_build_object(
    -- Monthly core-value reviews (20261106000000). All seven profile-reference CASCADE columns
    -- (see the table definitions above) — losing them with the account would
    -- lose a record of review work given or received.
    'values_assignments.rater_id', (select count(*) from values_assignments where rater_id = p_id),
    'values_assignments.subject_id', (select count(*) from values_assignments where subject_id = p_id),
    'values_submissions.rater_id', (select count(*) from values_submissions where rater_id = p_id),
    'values_submissions.subject_id', (select count(*) from values_submissions where subject_id = p_id),
    'values_quarterly_ratings.subject_id', (select count(*) from values_quarterly_ratings where subject_id = p_id),
    'values_quarterly_manifest.rater_id', (select count(*) from values_quarterly_manifest where rater_id = p_id),
    'values_reminder_claims.profile_id', (select count(*) from values_reminder_claims where profile_id = p_id)
  ) || jsonb_build_object(
    'work_activity_definitions.created_by',(select count(*) from public.work_activity_definitions where created_by=p_id),
    'work_activity_definition_versions.published_by',(select count(*) from public.work_activity_definition_versions where published_by=p_id),
    'work_capture_menus.created_by',(select count(*) from public.work_capture_menus where created_by=p_id),
    'work_capture_menu_versions.published_by',(select count(*) from public.work_capture_menu_versions where published_by=p_id),
    'work_job_menu_selections.selected_by',(select count(*) from public.work_job_menu_selections where selected_by=p_id),
    'work_job_management_grants.profile_id',(select count(*) from public.work_job_management_grants where profile_id=p_id),
    'work_job_management_grants.granted_by',(select count(*) from public.work_job_management_grants where granted_by=p_id),
    'work_job_management_grants.revoked_by',(select count(*) from public.work_job_management_grants where revoked_by=p_id),
    'personal_activity_state.profile_id',(select count(*) from public.personal_activity_state where profile_id=p_id),
    'personal_activity_commands.actor_id',(select count(*) from public.personal_activity_commands where actor_id=p_id),
    'personal_activity_commands.subject_profile_id',(select count(*) from public.personal_activity_commands where subject_profile_id=p_id),
    'personal_activity_transitions.profile_id',(select count(*) from public.personal_activity_transitions where profile_id=p_id),
    'personal_activity_transitions.actor_id',(select count(*) from public.personal_activity_transitions where actor_id=p_id),
    'work_session_capture_metadata.profile_id',(select count(*) from public.work_session_capture_metadata where profile_id=p_id),
    'work_configuration_commands.actor_id',(select count(*) from public.work_configuration_commands where actor_id=p_id),
    'work_configuration_draft_revisions.proposed_by',(select count(*) from public.work_configuration_draft_revisions where proposed_by=p_id),
    'work_unit_fact_revisions.actor_id',(select count(*) from public.work_unit_fact_revisions where actor_id=p_id),
    'work_unit_fact_revisions.observation_actor_id',(select count(*) from public.work_unit_fact_revisions where observation_actor_id=p_id),
    'work_unit_fact_revisions.origin_author_id',(select count(*) from public.work_unit_fact_revisions where origin_author_id=p_id),
    'work_activity_observations.actor_id',(select count(*) from public.work_activity_observations where actor_id=p_id),
    'work_activity_streams.actor_id',(select count(*) from public.work_activity_streams where actor_id=p_id),
    'work_setup_sessions.profile_id',(select count(*) from public.work_setup_sessions where profile_id=p_id),
    'personal_activity_transition_sources.profile_id',(select count(*) from public.personal_activity_transition_sources where profile_id=p_id),
    'work_activity_safety_events.profile_id',(select count(*) from public.work_activity_safety_events where profile_id=p_id),
    'work_activity_safety_events.actor_id',(select count(*) from public.work_activity_safety_events where actor_id=p_id),
    'work_activity_clock_receipts.profile_id',(select count(*) from public.work_activity_clock_receipts where profile_id=p_id)
  ) || jsonb_build_object(
'work_activity_source_history.actor_id',(select count(*) from public.work_activity_source_history where actor_id=p_id),
'work_unit_review_commands.actor_id',(select count(*) from public.work_unit_review_commands where actor_id=p_id),
'work_unit_dimension_verifications.observation_actor_id',(select count(*) from public.work_unit_dimension_verifications where observation_actor_id=p_id),
'work_unit_dimension_verifications.reviewer_id',(select count(*) from public.work_unit_dimension_verifications where reviewer_id=p_id),
'work_unit_review_events.actor_id',(select count(*) from public.work_unit_review_events where actor_id=p_id),
'work_unit_review_defects.creator_id',(select count(*) from public.work_unit_review_defects where creator_id=p_id),
'work_unit_review_defect_events.actor_id',(select count(*) from public.work_unit_review_defect_events where actor_id=p_id),
'work_activity_source_history.original_identities',(select count(*) from public.work_activity_source_history where jsonb_path_exists(before_value,'$.** ? (@ == $person)',jsonb_build_object('person',p_id::text)) or jsonb_path_exists(after_value,'$.** ? (@ == $person)',jsonb_build_object('person',p_id::text))),
'work_unit_review_events.original_identities',(select count(*) from public.work_unit_review_events where jsonb_path_exists(scope_manifest,'$.** ? (@ == $person)',jsonb_build_object('person',p_id::text)))
);
$$;
revoke all on function public.person_record_counts(uuid) from public,anon,authenticated;
grant execute on function public.person_record_counts(uuid) to service_role;

-- COVERAGE_CONTRACT_BEGIN
-- Generated exact source/column/trigger coverage; unknown source shape fails closed.
create or replace function public._work_unit_review_coverage() returns boolean
language sql stable security definer set search_path=public,pg_temp as $coverage$
 select encode(sha256(convert_to(c.value::text,'UTF8')),'hex')='57bef054df03f0591dc0d22d81c2c4ca17f4795431b451880d392eff040573bc' from (select jsonb_build_object(
 'functions',(select jsonb_agg(jsonb_build_object('name',p.proname,'args',pg_get_function_identity_arguments(p.oid),'body',encode(sha256(convert_to(p.prosrc,'UTF8')),'hex'),'config',p.proconfig,'owner',pg_get_userbyid(p.proowner),'definer',p.prosecdef,'volatility',p.provolatile) order by p.proname,pg_get_function_identity_arguments(p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=any(array['_work_activity_operation_exit','_work_activity_event','_work_activity_touch','_work_activity_safety_exit','_work_activity_shift_lifecycle','_work_activity_retain_source','_work_activity_parent_source_history','_work_activity_source_material','_work_activity_row_event','_work_activity_gate','_work_activity_parent_gate','_work_activity_statement_begin','_work_activity_statement_end','_work_activity_row_before','_work_activity_read_committed','_work_activity_actor','_work_activity_unit_basis','_work_unit_fact_context_visible','_work_unit_fact_peek_epoch','_work_unit_fact_bump_epoch','_ai_job_visible','_work_config_internal','_work_config_is_supervisor','_work_config_is_foreman','is_test_profile','is_sandbox_project','service_job_access','service_internal','_work_unit_review_scope','_work_unit_review_view','_work_unit_review_authority','_work_unit_review_defect_projection','_work_unit_review_payload','_work_unit_review_decimal','_work_unit_review_text','person_record_counts','_work_activity_evidence','_work_activity_operation','work_capture_immutable_record','_work_activity_no_truncate','_work_activity_uuid','_work_activity_integer','_work_activity_object','work_unit_review_command','work_unit_review_read','work_unit_review_command_receipt'])),
 'triggers',(select jsonb_agg(jsonb_build_object('table',c.relname,'name',t.tgname,'definition',pg_get_triggerdef(t.oid,true),'enabled',t.tgenabled) order by c.relname,t.tgname) from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname=any(array['time_shifts','personal_activity_state','personal_activity_transition_sources','personal_activity_transitions','work_activity_safety_events','work_unit_fact_revisions','work_unit_fact_current','work_unit_fact_context_epochs','custom_work_units','project_openings','service_visit_units','service_visits','summons','unit_redos','qc_checks','install_events','crew_work_records','crew_work_record_people','work_session_capture_metadata','custom_work_history','custom_work_sessions','unit_sessions','task_sessions','service_time_sessions','opening_phases','summon_helpers','work_activity_source_history','work_unit_review_commands','work_unit_dimension_verifications','work_unit_review_events','work_unit_review_current','work_unit_review_defects','work_unit_review_defect_events']) and not t.tgisinternal),
 'columns',(select jsonb_agg(jsonb_build_object('table',c.relname,'column',a.attname,'type',format_type(a.atttypid,a.atttypmod),'nullable',not a.attnotnull,'generated',a.attgenerated,'identity',a.attidentity) order by c.relname,a.attnum) from pg_class c join pg_namespace n on n.oid=c.relnamespace join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped where n.nspname='public' and c.relname=any(array['time_shifts','personal_activity_state','personal_activity_transition_sources','personal_activity_transitions','work_activity_safety_events','work_unit_fact_revisions','work_unit_fact_current','work_unit_fact_context_epochs','custom_work_units','project_openings','service_visit_units','service_visits','summons','unit_redos','qc_checks','install_events','crew_work_records','crew_work_record_people','work_session_capture_metadata','custom_work_history','custom_work_sessions','unit_sessions','task_sessions','service_time_sessions','opening_phases','summon_helpers','work_activity_source_history','work_unit_review_commands','work_unit_dimension_verifications','work_unit_review_events','work_unit_review_current','work_unit_review_defects','work_unit_review_defect_events'])),
 'functionAccess',(select jsonb_agg(jsonb_build_object('name',p.proname,'args',pg_get_function_identity_arguments(p.oid),'role',r.rolname,'execute',has_function_privilege(r.oid,p.oid,'EXECUTE')) order by p.proname,pg_get_function_identity_arguments(p.oid),r.rolname) from pg_proc p join pg_namespace n on n.oid=p.pronamespace cross join pg_roles r where n.nspname='public' and p.proname=any(array['_work_activity_operation_exit','_work_activity_event','_work_activity_touch','_work_activity_safety_exit','_work_activity_shift_lifecycle','_work_activity_retain_source','_work_activity_parent_source_history','_work_activity_source_material','_work_activity_row_event','_work_activity_gate','_work_activity_parent_gate','_work_activity_statement_begin','_work_activity_statement_end','_work_activity_row_before','_work_activity_read_committed','_work_activity_actor','_work_activity_unit_basis','_work_unit_fact_context_visible','_work_unit_fact_peek_epoch','_work_unit_fact_bump_epoch','_ai_job_visible','_work_config_internal','_work_config_is_supervisor','_work_config_is_foreman','is_test_profile','is_sandbox_project','service_job_access','service_internal','_work_unit_review_scope','_work_unit_review_view','_work_unit_review_authority','_work_unit_review_defect_projection','_work_unit_review_payload','_work_unit_review_decimal','_work_unit_review_text','person_record_counts','_work_activity_evidence','_work_activity_operation','work_capture_immutable_record','_work_activity_no_truncate','_work_activity_uuid','_work_activity_integer','_work_activity_object','work_unit_review_command','work_unit_review_read','work_unit_review_command_receipt','_work_unit_review_coverage']) and r.rolname in('anon','authenticated','service_role')),
 'privateAccess',(select jsonb_agg(jsonb_build_object('table',c.relname,'role',r.rolname,'privilege',v.name,'allowed',has_table_privilege(r.oid,c.oid,v.name)) order by c.relname,r.rolname,v.name) from pg_class c join pg_namespace n on n.oid=c.relnamespace cross join pg_roles r cross join (values('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')) v(name) where n.nspname='public' and c.relname=any(array['work_unit_fact_revisions','work_unit_fact_current','work_unit_fact_context_epochs','work_activity_source_history','work_unit_review_commands','work_unit_dimension_verifications','work_unit_review_events','work_unit_review_current','work_unit_review_defects','work_unit_review_defect_events','_work_unit_review_live_sources']) and r.rolname in('anon','authenticated','service_role')),
 'view',pg_get_viewdef('public._work_unit_review_live_sources'::regclass,true),
 'tables',(select jsonb_agg(jsonb_build_object('table',c.relname,'rls',c.relrowsecurity,'owner',pg_get_userbyid(c.relowner)) order by c.relname) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname=any(array['time_shifts','personal_activity_state','personal_activity_transition_sources','personal_activity_transitions','work_activity_safety_events','work_unit_fact_revisions','work_unit_fact_current','work_unit_fact_context_epochs','custom_work_units','project_openings','service_visit_units','service_visits','summons','unit_redos','qc_checks','install_events','crew_work_records','crew_work_record_people','work_session_capture_metadata','custom_work_history','custom_work_sessions','unit_sessions','task_sessions','service_time_sessions','opening_phases','summon_helpers','work_activity_source_history','work_unit_review_commands','work_unit_dimension_verifications','work_unit_review_events','work_unit_review_current','work_unit_review_defects','work_unit_review_defect_events']))
) value) c
$coverage$;
revoke all on function public._work_unit_review_coverage() from public,anon,authenticated,service_role;
-- COVERAGE_CONTRACT_END

-- Held candidate: integration/provider/review gates remain.
rollback;
