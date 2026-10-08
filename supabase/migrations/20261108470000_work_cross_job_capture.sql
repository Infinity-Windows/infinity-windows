-- HELD CROSS-JOB CAPTURE: source-matched construction candidate, NEVER activation.
-- Owner boundary/latency policies and genuine/provider/client gates remain open.
-- Terminal ROLLBACK is intentional. No production application is authorized.
begin;
set local search_path=public,pg_temp;
-- CROSS_JOB_PREFLIGHT_BEGIN: metadata only; refusal precedes every DDL statement.
do $preflight$
begin
 if exists(select 1 from pg_class where relnamespace='public'::regnamespace and (starts_with(relname,'work_cross_job_') or starts_with(relname,'_work_cross_job_')))
 or exists(select 1 from pg_proc where pronamespace='public'::regnamespace and (starts_with(proname,'work_cross_job_') or starts_with(proname,'_work_cross_job_')))
 or exists(select 1 from pg_type where typnamespace='public'::regnamespace and (starts_with(typname,'work_cross_job_') or starts_with(typname,'_work_cross_job_'))) then
  raise exception using errcode='55000',message='Cross-job namespace is not empty; installation refused.';
 end if;
 if (select encode(sha256(convert_to(c.value::text,'UTF8')),'hex') from (
-- Deliberately closed source-derived public catalog. Unknown live drift refuses;
-- this is not a request to normalize a provider to the disposable fixture.
select jsonb_build_object(
 'types',(select jsonb_agg(jsonb_build_object('name',t.typname,'kind',t.typtype,'owner',pg_get_userbyid(t.typowner),'acl',t.typacl::text,'category',t.typcategory,'preferred',t.typispreferred,'defined',t.typisdefined,'notNull',t.typnotnull,'base',format_type(nullif(t.typbasetype,0),t.typtypmod),'element',format_type(nullif(t.typelem,0),null),'collation',case when t.typcollation<>0 then t.typcollation::regcollation::text end,'default',t.typdefault,'defaultExpression',pg_get_expr(t.typdefaultbin,0),'input',t.typinput::regprocedure::text,'output',t.typoutput::regprocedure::text,'receive',t.typreceive::regprocedure::text,'send',t.typsend::regprocedure::text,'length',t.typlen,'byValue',t.typbyval,'alignment',t.typalign,'storage',t.typstorage,'delimiter',t.typdelim,'access',(select jsonb_object_agg(r.rolname,has_type_privilege(r.oid,t.oid,'USAGE')) from pg_roles r where r.rolname in('anon','authenticated','service_role')),'enum',(select jsonb_agg(jsonb_build_object('label',e.enumlabel,'sort',e.enumsortorder) order by e.enumsortorder) from pg_enum e where e.enumtypid=t.oid),'constraints',(select jsonb_agg(jsonb_build_object('name',k.conname,'definition',pg_get_constraintdef(k.oid,true),'validated',k.convalidated) order by k.conname) from pg_constraint k where k.contypid=t.oid),'range',(select jsonb_build_object('subtype',format_type(r.rngsubtype,null),'collation',r.rngcollation::regcollation::text,'opclass',(select n.nspname||'.'||o.opcname from pg_opclass o join pg_namespace n on n.oid=o.opcnamespace where o.oid=r.rngsubopc),'canonical',r.rngcanonical::regprocedure::text,'subdiff',r.rngsubdiff::regprocedure::text) from pg_range r where r.rngtypid=t.oid)) order by t.typname) from pg_type t where t.typnamespace='public'::regnamespace),
 'sequences',(select jsonb_agg(jsonb_build_object('name',c.relname,'owner',pg_get_userbyid(c.relowner),'acl',c.relacl::text,'type',format_type(s.seqtypid,null),'start',s.seqstart,'increment',s.seqincrement,'max',s.seqmax,'min',s.seqmin,'cache',s.seqcache,'cycle',s.seqcycle,'access',(select jsonb_agg(jsonb_build_object('role',r.rolname,'privilege',v.p,'allowed',has_sequence_privilege(r.oid,c.oid,v.p)) order by r.rolname,v.p) from pg_roles r cross join unnest(array['SELECT','UPDATE','USAGE'])v(p) where r.rolname in('anon','authenticated','service_role'))) order by c.relname) from pg_class c join pg_sequence s on s.seqrelid=c.oid where c.relnamespace='public'::regnamespace),
 'foreignTables',(select jsonb_agg(jsonb_build_object('table',c.relname,'options',f.ftoptions,'server',s.srvname,'serverOwner',pg_get_userbyid(s.srvowner),'serverType',s.srvtype,'serverVersion',s.srvversion,'serverOptionsDigest',encode(sha256(convert_to(coalesce(s.srvoptions::text,''),'UTF8')),'hex'),'serverAcl',s.srvacl::text,'serverAccess',(select jsonb_object_agg(r.rolname,has_server_privilege(r.oid,s.oid,'USAGE')) from pg_roles r where r.rolname in('anon','authenticated','service_role')),'wrapper',w.fdwname,'wrapperOwner',pg_get_userbyid(w.fdwowner),'wrapperAcl',w.fdwacl::text,'wrapperAccess',(select jsonb_object_agg(r.rolname,has_foreign_data_wrapper_privilege(r.oid,w.oid,'USAGE')) from pg_roles r where r.rolname in('anon','authenticated','service_role')),'handler',w.fdwhandler::regprocedure::text,'validator',w.fdwvalidator::regprocedure::text,'wrapperOptionsDigest',encode(sha256(convert_to(coalesce(w.fdwoptions::text,''),'UTF8')),'hex')) order by c.relname) from pg_foreign_table f join pg_class c on c.oid=f.ftrelid join pg_foreign_server s on s.oid=f.ftserver join pg_foreign_data_wrapper w on w.oid=s.srvfdw where c.relnamespace='public'::regnamespace),
 'functions',(select jsonb_agg(jsonb_build_object('name',p.proname,'arguments',pg_get_function_identity_arguments(p.oid),'body',encode(sha256(convert_to(p.prosrc,'UTF8')),'hex'),'result',pg_get_function_result(p.oid),'owner',pg_get_userbyid(p.proowner),'acl',p.proacl::text,'language',l.lanname,'kind',p.prokind,'definer',p.prosecdef,'config',p.proconfig,'volatility',p.provolatile,'strict',p.proisstrict,'leakproof',p.proleakproof,'cost',p.procost,'rows',p.prorows,'support',p.prosupport::regprocedure::text,'parallel',p.proparallel,'defaults',pg_get_expr(p.proargdefaults,0),'access',(select jsonb_object_agg(r.rolname,has_function_privilege(r.oid,p.oid,'EXECUTE')) from pg_roles r where r.rolname in('anon','authenticated','service_role'))) order by p.proname,pg_get_function_identity_arguments(p.oid)) from pg_proc p join pg_language l on l.oid=p.prolang where p.pronamespace='public'::regnamespace and not exists(select 1 from pg_depend d where d.classid='pg_proc'::regclass and d.objid=p.oid and d.deptype='e')),
 'relations',(select jsonb_agg(jsonb_build_object('name',c.relname,'kind',c.relkind,'owner',pg_get_userbyid(c.relowner),'rls',c.relrowsecurity,'forcedRls',c.relforcerowsecurity,'acl',c.relacl::text,'access',(select jsonb_agg(jsonb_build_object('role',r.rolname,'privilege',v.p,'table',has_table_privilege(r.oid,c.oid,v.p),'column',case when v.p in('SELECT','INSERT','UPDATE','REFERENCES') then has_any_column_privilege(r.oid,c.oid,v.p) end) order by r.rolname,v.p) from pg_roles r cross join unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'])v(p) where r.rolname in('anon','authenticated','service_role'))) order by c.relname) from pg_class c where c.relnamespace='public'::regnamespace and c.relkind in('r','p','v','m','f','c')),
 'columns',(select jsonb_agg(jsonb_build_object('table',c.relname,'name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'notNull',a.attnotnull,'generated',a.attgenerated,'identity',a.attidentity,'acl',a.attacl::text,'default',pg_get_expr(d.adbin,d.adrelid),'access',(select jsonb_agg(jsonb_build_object('role',r.rolname,'privilege',v.p,'allowed',has_column_privilege(r.oid,c.oid,a.attnum,v.p)) order by r.rolname,v.p) from pg_roles r cross join unnest(array['SELECT','INSERT','UPDATE','REFERENCES'])v(p) where r.rolname in('anon','authenticated','service_role'))) order by c.relname,a.attnum) from pg_class c join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped left join pg_attrdef d on d.adrelid=c.oid and d.adnum=a.attnum where c.relnamespace='public'::regnamespace and c.relkind in('r','p','v','m','f','c')),
 'constraints',(select jsonb_agg(jsonb_build_object('table',c.relname,'name',k.conname,'definition',pg_get_constraintdef(k.oid,true),'validated',k.convalidated,'noInherit',k.connoinherit,'enforced',coalesce((to_jsonb(k)->>'conenforced')::boolean,true)) order by c.relname,k.conname) from pg_constraint k join pg_class c on c.oid=k.conrelid where c.relnamespace='public'::regnamespace and k.contype<>'n'),
 'notNullConstraints',(select jsonb_agg(jsonb_build_object('table',c.relname,'column',a.attname,'validated',coalesce(n.validated,true),'enforced',coalesce(n.enforced,true),'noInherit',coalesce(n.no_inherit,false)) order by c.relname,a.attnum) from pg_class c join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped left join lateral(select bool_and(k.convalidated) validated,bool_and(coalesce((to_jsonb(k)->>'conenforced')::boolean,true)) enforced,bool_or(k.connoinherit) no_inherit from pg_constraint k where k.conrelid=c.oid and k.contype='n' and a.attnum=any(k.conkey))n on true where c.relnamespace='public'::regnamespace and c.relkind in('r','p')),
 'indexes',(select jsonb_agg(jsonb_build_object('table',t.relname,'name',c.relname,'definition',pg_get_indexdef(i.indexrelid),'valid',i.indisvalid,'ready',i.indisready) order by t.relname,c.relname) from pg_index i join pg_class c on c.oid=i.indexrelid join pg_class t on t.oid=i.indrelid where t.relnamespace='public'::regnamespace),
 'triggers',(select jsonb_agg(jsonb_build_object('table',c.relname,'name',t.tgname,'definition',pg_get_triggerdef(t.oid,true),'enabled',t.tgenabled) order by c.relname,t.tgname) from pg_trigger t join pg_class c on c.oid=t.tgrelid where c.relnamespace='public'::regnamespace and not t.tgisinternal),
 'policies',(select jsonb_agg(to_jsonb(p) order by p.tablename,p.policyname) from pg_policies p where schemaname='public'),
 'views',(select jsonb_agg(jsonb_build_object('name',c.relname,'definition',pg_get_viewdef(c.oid,true)) order by c.relname) from pg_class c where c.relnamespace='public'::regnamespace and c.relkind in('v','m'))
) value
 )c) is distinct from '18f1f9048e57087987020441e0aff395c5094ec8f677643078f551aa4d705950' then
  raise exception using errcode='55000',message='Cross-job old source contract differs; installation refused before DDL.';
 end if;
end $preflight$;
-- CROSS_JOB_DDL_BEGIN
-- All identities are retained UUIDs. Operational deletes never cascade evidence.
create table public.work_cross_job_shifts (
 shift_id uuid primary key, profile_id uuid not null, clock_in_at timestamptz not null check(isfinite(clock_in_at)),
 birth_history_id uuid not null, birth_transition_id uuid not null, clock_request_id uuid not null,
 original_project_id uuid, original_cost_code_id uuid, generation integer not null check(generation=2),
 registered_at timestamptz not null default clock_timestamp()
);
create index work_cross_job_shifts_profile on public.work_cross_job_shifts(profile_id,shift_id);
create table public.work_cross_job_allocations (
 id uuid primary key, shift_id uuid not null references public.work_cross_job_shifts(shift_id), profile_id uuid not null,
 predecessor_id uuid references public.work_cross_job_allocations(id), event_kind text not null check(event_kind in('initial','handoff','amendment')),
 project_id uuid not null, cost_code_id uuid, original_tapped_at timestamptz not null check(isfinite(original_tapped_at)),
 clock_checked_at timestamptz not null check(isfinite(clock_checked_at)), clock_skew_ms integer not null,
 admitted_at timestamptz not null check(isfinite(admitted_at)), effective_at timestamptz not null check(isfinite(effective_at)),
 boundary_mode text not null check(boundary_mode='trusted_original_tap'), command_id uuid not null unique,
 transition_id uuid not null, authority_revision bigint not null, source_generation integer not null check(source_generation=2),
 check(effective_at<=admitted_at), check((event_kind='initial')=(predecessor_id is null))
);
create unique index work_cross_job_allocations_successor on public.work_cross_job_allocations(predecessor_id) where predecessor_id is not null;
create unique index work_cross_job_allocations_initial on public.work_cross_job_allocations(shift_id) where predecessor_id is null;
create index work_cross_job_allocations_shift on public.work_cross_job_allocations(shift_id,effective_at);
create table public.work_cross_job_heads (
 shift_id uuid primary key references public.work_cross_job_shifts(shift_id), allocation_id uuid not null references public.work_cross_job_allocations(id)
);
create table public.work_cross_job_bindings (
 source_kind text not null check(source_kind in('custom','unit','task','service','phase','setup')), source_id uuid not null,
 birth_history_id uuid not null, source_effective_at timestamptz not null check(isfinite(source_effective_at)),
 profile_id uuid not null, shift_id uuid not null references public.work_cross_job_shifts(shift_id),
 allocation_id uuid references public.work_cross_job_allocations(id), project_id uuid,
 command_id uuid, transition_id uuid not null, resumed_from_history_id uuid,
 generation integer not null check(generation=2),
 primary key(source_kind,source_id,birth_history_id),
 check((source_kind='setup')=(allocation_id is null)), check((source_kind='setup')=(project_id is null))
);
create index work_cross_job_bindings_shift on public.work_cross_job_bindings(shift_id,source_kind,source_id);
-- Optional bounded resume cache: never a new deferred paid-commit requirement.
create table public.work_cross_job_resume (
 profile_id uuid primary key, shift_id uuid not null, source_kind text not null, source_id uuid not null,
 closure_history_id uuid not null, birth_history_id uuid not null, break_transition_id uuid not null,
 break_started_at timestamptz not null, effective_started_at timestamptz not null,
 allocation_id uuid, authority_revision bigint not null, source_value jsonb not null
);
-- No activation function or writable switch exists in this held candidate.
create function public._work_cross_job_enabled() returns boolean language sql stable security definer set search_path=public,pg_temp as $$select false$$;
revoke all on function public._work_cross_job_enabled() from public,anon,authenticated,service_role;
revoke all on table public.work_cross_job_shifts from public,anon,authenticated,service_role;
revoke all on table public.work_cross_job_allocations from public,anon,authenticated,service_role;
revoke all on table public.work_cross_job_heads from public,anon,authenticated,service_role;
revoke all on table public.work_cross_job_bindings from public,anon,authenticated,service_role;
revoke all on table public.work_cross_job_resume from public,anon,authenticated,service_role;
alter table public.work_cross_job_shifts enable row level security;
alter table public.work_cross_job_allocations enable row level security;
alter table public.work_cross_job_heads enable row level security;
alter table public.work_cross_job_bindings enable row level security;
alter table public.work_cross_job_resume enable row level security;
-- CROSS_JOB_RUNTIME_BEGIN
-- New private implementation. Generation2 remains unreachable while held.
alter table public.personal_activity_commands drop constraint personal_activity_commands_protocol_version_check;
alter table public.personal_activity_commands add constraint personal_activity_commands_protocol_version_check check(protocol_version in(1,2));
alter table public.personal_activity_transitions drop constraint personal_activity_transitions_protocol_version_check;
alter table public.personal_activity_transitions add constraint personal_activity_transitions_protocol_version_check check(protocol_version in(1,2));
create index work_cross_job_source_history_operation on public.work_activity_source_history(source_kind,source_id,operation_id);
create table public.work_cross_job_write_frames (
 operation_id uuid not null, source_kind text not null, source_id uuid not null, profile_id uuid not null, shift_id uuid not null,
 allocation_id uuid, effective_at timestamptz not null, primary key(operation_id,source_kind,source_id)
);
revoke all on table public.work_cross_job_write_frames from public,anon,authenticated,service_role;
alter table public.work_cross_job_write_frames enable row level security;
create trigger work_cross_job_shifts_immutable before update or delete on public.work_cross_job_shifts for each row execute function public.work_capture_immutable_record();
create trigger work_cross_job_allocations_immutable before update or delete on public.work_cross_job_allocations for each row execute function public.work_capture_immutable_record();
create trigger work_cross_job_bindings_immutable before update or delete on public.work_cross_job_bindings for each row execute function public.work_capture_immutable_record();
create trigger work_cross_job_shifts_no_truncate before truncate on public.work_cross_job_shifts for each statement execute function public.work_capture_immutable_record();
create trigger work_cross_job_allocations_no_truncate before truncate on public.work_cross_job_allocations for each statement execute function public.work_capture_immutable_record();
create trigger work_cross_job_bindings_no_truncate before truncate on public.work_cross_job_bindings for each statement execute function public.work_capture_immutable_record();

create function public._work_cross_job_table(p_kind text) returns text language sql immutable set search_path=public,pg_temp as $$
 select case p_kind when 'custom' then 'custom_work_sessions' when 'service' then 'service_time_sessions' when 'unit' then 'unit_sessions' when 'task' then 'task_sessions' when 'phase' then 'opening_phases' when 'setup' then 'work_setup_sessions' when 'shift' then 'time_shifts' end
$$;
-- Indexed current history head; no ordering by time/UUID, no full proof walk.
create function public._work_cross_job_history(p_kind text,p_id uuid) returns public.work_activity_source_history
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare r public.work_activity_source_history; n integer; current_operation uuid;
begin
 current_operation:=(public._work_activity_operation()).id;
 if current_operation is null then return null;end if;
 select count(*) into n from public.work_activity_source_history h where h.source_kind=public._work_cross_job_table(p_kind) and h.source_id=p_id::text and h.operation_id=current_operation
 and not exists(select 1 from public.work_activity_source_history x where x.predecessor_id=h.id);
 if n<>1 then return null;end if;
 select h.* into r from public.work_activity_source_history h where h.source_kind=public._work_cross_job_table(p_kind) and h.source_id=p_id::text and h.operation_id=current_operation
 and not exists(select 1 from public.work_activity_source_history x where x.predecessor_id=h.id);
 if r.legacy_baseline then return null;end if;return r;
end$$;
create function public._work_cross_job_scope(p_shift uuid,p_actor uuid,p_full boolean default true) returns boolean
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare s public.work_cross_job_shifts; h public.time_shifts; b public.work_activity_source_history; source_row record; view_state public.personal_activity_state;
begin
 select * into s from public.work_cross_job_shifts where shift_id=p_shift;
 select * into h from public.time_shifts where id=p_shift;
 select * into b from public.work_activity_source_history where id=s.birth_history_id;
 if s.shift_id is null or h.id is null or s.profile_id is distinct from p_actor or h.profile_id is distinct from p_actor
 or h.clock_in_at is distinct from s.clock_in_at or h.project_id is distinct from s.original_project_id or h.cost_code_id is distinct from s.original_cost_code_id
 or b.before_value<>'{}'::jsonb or b.after_value->>'id' is distinct from h.id::text or b.legacy_baseline
 or not public._work_config_internal(p_actor) then return false;end if;
 if exists(select 1 from public.work_activity_source_history x where x.source_kind='time_shifts' and x.source_id=p_shift::text and (x.after_value='{}'::jsonb or (x.before_value='{}'::jsonb and x.id<>s.birth_history_id))) then return false;end if;
 if not public._work_cross_job_head_valid(p_shift) then return false;end if;
 if s.original_project_id is not null and not public._ai_job_visible(s.original_project_id,p_actor) then return false;end if;
 -- All retained original job dependencies must be visible before any receipt.
 if p_full then
  if exists(select 1 from public.work_cross_job_allocations a where a.shift_id=p_shift and not public._ai_job_visible(a.project_id,p_actor)) then return false;end if;
  select * into view_state from public.personal_activity_state where profile_id=p_actor;
  for source_row in select source_kind,source_id,source_effective_at from public.work_cross_job_bindings where shift_id=p_shift loop
   view_state.active_source_kind:=source_row.source_kind;view_state.active_source_id:=source_row.source_id;view_state.effective_since:=source_row.source_effective_at;
   if public._work_activity_source_view(view_state)->>'visibility' is distinct from 'available' then return false;end if;
  end loop;
 end if;
 return true;
end$$;
create function public._work_cross_job_register(p_shift public.time_shifts,p_request uuid) returns void
language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare o public.work_activity_operations; person public.work_activity_operation_people; birth public.work_activity_source_history;
begin
 o:=public._work_activity_operation();person:=public._work_activity_touch(p_shift.profile_id);birth:=public._work_cross_job_history('shift',p_shift.id);
 if not public._work_cross_job_enabled() or o.route<>'clock_in_setup' or o.arguments->>'setupVersion'<>'2' or o.request_id is distinct from p_request
 or o.actor_id is distinct from p_shift.profile_id or birth.operation_id is distinct from o.id or birth.before_value<>'{}'::jsonb
 or birth.after_value->>'id' is distinct from p_shift.id::text or birth.legacy_baseline then raise exception using errcode='23514',message='Unsupported cross-job physical origin.';end if;
 insert into public.work_cross_job_shifts(shift_id,profile_id,clock_in_at,birth_history_id,birth_transition_id,clock_request_id,original_project_id,original_cost_code_id,generation)
 values(p_shift.id,p_shift.profile_id,p_shift.clock_in_at,birth.id,person.transition_id,p_request,p_shift.project_id,p_shift.cost_code_id,2);
end$$;
-- No source is admitted merely because another source on this shift is v2.
create function public._work_cross_job_birth_guard(p_kind text,p_before jsonb,p_after jsonb) returns void
language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare who uuid; sh uuid; o public.work_activity_operations; starts boolean; open_count integer;
begin
 if p_kind not in('custom','service','unit','task','phase','setup') then return;end if;
 who:=(p_after->>case when p_kind='phase' then 'started_by' else 'profile_id' end)::uuid;
 starts:=case when p_kind='phase' then p_after->>'status'='active' and p_after->>'paused_at' is null and (p_before is null or p_before->>'paused_at' is not null or p_before->>'status' is distinct from 'active')
 else p_after->>'ended_at' is null and (p_before is null or p_before->>'ended_at' is not null) and (p_kind<>'task' or p_after->>'state'='on_task') end;
 if starts is distinct from true then return;end if;
 if not exists(select 1 from public.work_cross_job_shifts s join public.time_shifts h on h.id=s.shift_id where s.profile_id=who and h.status='open' and h.clock_out_at is null) then return;end if;
 select count(*) into open_count from public.time_shifts h where h.profile_id=who and h.status='open' and h.clock_out_at is null;
 if open_count<>1 then raise exception using errcode='23514',message='Choose work on one unambiguous paid shift.';end if;
 select s.shift_id into sh from public.work_cross_job_shifts s join public.time_shifts h on h.id=s.shift_id where s.profile_id=who and h.status='open' and h.clock_out_at is null;
 o:=public._work_activity_operation();
 if p_kind='setup' and o.actor_id=who and o.route in('clock_in_setup','end_break') then return;end if;
 if not exists(select 1 from public.work_cross_job_write_frames f where f.operation_id=o.id and f.profile_id=who and f.shift_id=sh
 and f.source_kind=p_kind and f.source_id=(p_after->>'id')::uuid) then
 raise exception using errcode='23514',message='Choose work using the current capture version.';end if;
end$$;
create function public._work_cross_job_bind(p_kind text,p_id uuid,p_shift uuid,p_allocation uuid,p_started timestamptz,p_prior uuid default null) returns void
language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare o public.work_activity_operations; person public.work_activity_operation_people; h public.work_activity_source_history; a public.work_cross_job_allocations; s public.work_cross_job_shifts;
begin
 o:=public._work_activity_operation();select * into s from public.work_cross_job_shifts where shift_id=p_shift;
 person:=public._work_activity_touch(s.profile_id);h:=public._work_cross_job_history(p_kind,p_id);
 select * into a from public.work_cross_job_allocations where id=p_allocation;
 if h.id is null or h.operation_id is distinct from o.id or h.after_value->>'id' is distinct from p_id::text
 or (p_kind<>'setup' and (a.shift_id is distinct from p_shift or a.profile_id is distinct from s.profile_id or a.effective_at>p_started)) then
 raise exception using errcode='23514',message='Source birth does not match allocation.';end if;
 insert into public.work_cross_job_bindings(source_kind,source_id,birth_history_id,source_effective_at,profile_id,shift_id,allocation_id,project_id,command_id,transition_id,resumed_from_history_id,generation)
 values(p_kind,p_id,h.id,p_started,s.profile_id,p_shift,p_allocation,a.project_id,o.command_id,person.transition_id,p_prior,2);
end$$;
create function public._work_cross_job_local_valid(p_kind text,p_row jsonb,p_shift public.time_shifts) returns boolean
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare b public.work_cross_job_bindings; a public.work_cross_job_allocations; s public.work_cross_job_shifts; n integer; birth public.work_activity_source_history;
begin
 select count(*) into n from public.work_cross_job_bindings where source_kind=p_kind and source_id=(p_row->>'id')::uuid;
 if n<>1 then return false;end if;
 select * into b from public.work_cross_job_bindings where source_kind=p_kind and source_id=(p_row->>'id')::uuid;
 select * into s from public.work_cross_job_shifts where shift_id=b.shift_id;
 select * into a from public.work_cross_job_allocations where id=b.allocation_id;
 select * into birth from public.work_activity_source_history where id=b.birth_history_id;
 return coalesce(b.shift_id=p_shift.id and b.profile_id=p_shift.profile_id and p_row->>'profile_id'=b.profile_id::text
 and p_row->>'shift_id'=b.shift_id::text and p_row->>'project_id'=b.project_id::text and a.project_id=b.project_id and a.shift_id=b.shift_id
 and (p_row->>'started_at')::timestamptz=b.source_effective_at and a.effective_at<=b.source_effective_at
 and not exists(select 1 from public.work_activity_source_history x where x.source_kind=public._work_cross_job_table(p_kind) and x.source_id=b.source_id::text and (x.after_value='{}'::jsonb or (x.before_value='{}'::jsonb and x.id<>b.birth_history_id)))
 and birth.before_value='{}'::jsonb and birth.after_value->>'id'=b.source_id::text and not birth.legacy_baseline
 and s.clock_in_at=p_shift.clock_in_at and s.original_project_id is not distinct from p_shift.project_id
 and s.original_cost_code_id is not distinct from p_shift.cost_code_id and p_shift.status not in('needs_finish','rejected','voided')
 and b.source_effective_at>=p_shift.clock_in_at
 -- Callbacks run before lifecycle closure. A live source is valid only when
 -- its actual/effective start is already within the paid boundary; a closed
 -- source must also end within it. Equality is a valid zero-length interval.
 and (p_shift.clock_out_at is null or (b.source_effective_at<=p_shift.clock_out_at
  and (p_row->>'ended_at' is null or (p_row->>'ended_at')::timestamptz<=p_shift.clock_out_at))),false);
end$$;

-- General and Specific direct/resumed births share this exact writer.
create function public._work_cross_job_custom(p_profile uuid,p_shift public.time_shifts,p_allocation uuid,p_intent jsonb,p_at timestamptz,p_cause text,p_prior uuid default null) returns uuid
language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare a public.work_cross_job_allocations; d public.work_activity_definition_versions; data jsonb; new_id uuid:=gen_random_uuid(); frame uuid; columns text[]; o public.work_activity_operations; basis jsonb;
begin
 o:=public._work_activity_operation();select * into a from public.work_cross_job_allocations where id=p_allocation;
 if o.actor_id is distinct from p_profile or p_shift.profile_id is distinct from p_profile or a.shift_id is distinct from p_shift.id
 or a.project_id is distinct from (p_intent->>'projectId')::uuid or not public._work_cross_job_scope(p_shift.id,p_profile,false)
 or public._work_activity_validate_switch(p_intent,p_profile) is not null or p_shift.break_started_at is not null or p_shift.clock_out_at is not null
 or p_shift.status<>'open' or p_at<a.effective_at or exists(select 1 from public._work_activity_live_sources(p_profile)) then
 raise exception using errcode='23514',message='Cross-job source is unavailable.';end if;
 if p_intent->>'scope'='specific' then perform public._unit_work_gate(p_profile);else perform public._prep_time_gate(p_profile);end if;
 select * into d from public.work_activity_definition_versions where id=(p_intent->>'definitionVersionId')::uuid;
 data:=jsonb_build_object('id',new_id,'profile_id',p_profile,'shift_id',p_shift.id,'project_id',a.project_id,'unit_id',p_intent#>'{unit,id}',
 'kind',case when p_intent->>'scope'='specific' then 'unit' else 'idle' end,'participation','install','stage',left(d.label_en,100),'description',d.label_en,'started_at',p_at,'shift_status',p_shift.status,'review_required',false);
 insert into public.work_cross_job_write_frames values(o.id,'custom',new_id,p_profile,p_shift.id,a.id,p_at);
 select array_agg(key order by key) into columns from jsonb_object_keys(data)key;frame:=public._work_activity_context_for(p_profile,p_cause,p_at);
 perform public._work_activity_expect(frame,'public.custom_work_sessions'::regclass,'INSERT',new_id,columns,null,public._work_activity_evidence('custom_work_sessions',data));
 insert into public.custom_work_sessions(id,profile_id,shift_id,project_id,unit_id,kind,participation,stage,description,started_at,shift_status,review_required)
 select r.id,r.profile_id,r.shift_id,r.project_id,r.unit_id,r.kind,r.participation,r.stage,r.description,r.started_at,r.shift_status,r.review_required from jsonb_populate_record(null::public.custom_work_sessions,data)r;
 perform public._work_activity_context_close(frame);
 if p_intent->>'scope'='specific' then basis:=public._work_activity_command_basis(public._work_activity_unit_basis((p_intent#>>'{unit,id}')::uuid,p_profile));end if;
 insert into public.work_session_capture_metadata(session_id,profile_id,project_id,definition_version_id,menu_version_id,scope,unit_id,fact_revision,unit_facts,machine_kind,selection_id,selection_revision,answers,unit_basis,continuation_unit_basis)
 values(new_id,p_profile,a.project_id,d.id,(p_intent->>'menuVersionId')::uuid,p_intent->>'scope',(p_intent#>>'{unit,id}')::uuid,(p_intent#>>'{unit,factRevision}')::bigint,
 case when p_intent->>'scope'='specific' then public._work_activity_fact_snapshot((p_intent#>>'{unit,id}')::uuid) end,p_intent->>'machineKind',(p_intent->>'selectionId')::uuid,(p_intent->>'selectionRevision')::bigint,p_intent->'values',nullif(p_intent->'unit','null'::jsonb),basis);
 perform public._work_cross_job_bind('custom',new_id,p_shift.id,p_allocation,p_at,p_prior);
 delete from public.work_cross_job_write_frames where operation_id=o.id and source_kind='custom' and source_id=new_id;
 return new_id;
end$$;

-- Exact eligibility is checked after close and again independently at resume.
create function public._work_cross_job_save(p_state public.personal_activity_state,p_shift uuid,p_break timestamptz,p_transition uuid) returns boolean
language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare h public.work_activity_source_history; r jsonb; b public.work_cross_job_bindings; a uuid; n integer; o public.work_activity_operations;
begin
 delete from public.work_cross_job_resume where profile_id=p_state.profile_id;
 begin
 if p_state.active_source_id is null or p_state.effective_since is null or p_state.effective_since>p_break then return false;end if;
 o:=public._work_activity_operation();h:=public._work_cross_job_history(p_state.active_source_kind,p_state.active_source_id);r:=h.after_value;
 if h.id is null or h.operation_id is distinct from o.id or not(p_transition=any(h.transition_ids))
 or (case when p_state.active_source_kind='phase' then (r->>'paused_at')::timestamptz else (r->>'ended_at')::timestamptz end) is distinct from p_break
 or coalesce((r->>'review_required')::boolean,false) or (p_state.active_source_kind in('custom','unit','service','setup') and r->>'end_reason' is distinct from 'break') then return false;end if;
 if exists(select 1 from public.work_cross_job_shifts where shift_id=p_shift) then
   select count(*) into n from public.work_cross_job_bindings where source_kind=p_state.active_source_kind and source_id=p_state.active_source_id and source_effective_at=p_state.effective_since;
   if n<>1 then return false;end if;
   select * into b from public.work_cross_job_bindings where source_kind=p_state.active_source_kind and source_id=p_state.active_source_id and source_effective_at=p_state.effective_since;
   select allocation_id into a from public.work_cross_job_heads where shift_id=p_shift;
   if b.allocation_id is distinct from a or b.shift_id is distinct from p_shift or b.profile_id is distinct from p_state.profile_id
   or exists(select 1 from public.work_cross_job_allocations where id=a and effective_at>p_break) then return false;end if;
 end if;
 insert into public.work_cross_job_resume(profile_id,shift_id,source_kind,source_id,closure_history_id,birth_history_id,break_transition_id,break_started_at,effective_started_at,allocation_id,authority_revision,source_value)
 values(p_state.profile_id,p_shift,p_state.active_source_kind,p_state.active_source_id,h.id,coalesce(b.birth_history_id,h.id),p_transition,p_break,p_state.effective_since,a,public._work_activity_authority_revision(),r);
 return true;
exception when raise_exception or check_violation or foreign_key_violation or unique_violation or insufficient_privilege or numeric_value_out_of_range then return false;
 end;
end$$;
create function public._work_cross_job_resume_basis(p_state public.personal_activity_state,p_shift public.time_shifts,p_at timestamptz) returns boolean
language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare b public.work_cross_job_resume; h public.work_activity_source_history; paid public.work_activity_source_history; o public.work_activity_operations; a uuid; t public.personal_activity_transitions; binding public.work_cross_job_bindings;
begin
 o:=public._work_activity_operation();select * into b from public.work_cross_job_resume where profile_id=p_state.profile_id;
 if b.profile_id is null or b.source_id is distinct from p_state.resume_source_id or b.source_kind is distinct from p_state.resume_source_kind
 or b.shift_id is distinct from p_shift.id or b.break_transition_id is distinct from p_state.resume_after_break_transition_id
 or b.effective_started_at>b.break_started_at or b.break_started_at>p_at or b.authority_revision is distinct from public._work_activity_authority_revision()
 or o.route<>'end_break' or o.actor_id is distinct from p_state.profile_id then return false;end if;
 select * into h from public.work_activity_source_history where id=b.closure_history_id and source_kind=public._work_cross_job_table(b.source_kind) and source_id=b.source_id::text;
 if exists(select 1 from public.work_activity_source_history where predecessor_id=h.id) then return false;end if;
 select * into paid from public.work_activity_source_history where operation_id=o.id and source_kind='time_shifts' and source_id=p_shift.id::text and before_value->>'break_started_at' is not null and after_value->>'break_started_at' is null;
 if not found then return false;end if;
 select * into t from public.personal_activity_transitions where id=b.break_transition_id;
 if t.id is null or t.profile_id is distinct from p_state.profile_id or t.source_shift_id is distinct from p_shift.id or t.cause<>'break_start'
 or t.selected_effective_at is distinct from b.break_started_at or not(b.break_transition_id=any(h.transition_ids))
 or t.before_evidence#>>'{state,active_source_kind}' is distinct from b.source_kind
 or t.before_evidence#>>'{state,active_source_id}' is distinct from b.source_id::text
 or (t.before_evidence#>>'{state,effective_since}')::timestamptz is distinct from b.effective_started_at then return false;end if;
 if exists(select 1 from public.work_cross_job_shifts where shift_id=p_shift.id) then
  select * into binding from public.work_cross_job_bindings where source_kind=b.source_kind and source_id=b.source_id and birth_history_id=b.birth_history_id;
  if binding.source_id is null or binding.source_effective_at is distinct from b.effective_started_at or binding.source_effective_at>b.break_started_at
   or binding.allocation_id is distinct from b.allocation_id or binding.shift_id is distinct from p_shift.id or binding.profile_id is distinct from p_state.profile_id
   or exists(select 1 from public.work_cross_job_allocations where id=binding.allocation_id and effective_at>b.break_started_at) then return false;end if;
 end if;
 if h.id is distinct from b.closure_history_id or h.after_value is distinct from b.source_value or h.legacy_baseline
 or paid.operation_id is distinct from o.id or (paid.before_value->>'break_started_at')::timestamptz is distinct from b.break_started_at
 or paid.after_value->>'break_started_at' is not null or (paid.after_value->>'last_punch_at')::timestamptz is distinct from p_at
 or (case when b.source_kind='phase' then (h.after_value->>'paused_at')::timestamptz else (h.after_value->>'ended_at')::timestamptz end) is distinct from b.break_started_at
 or coalesce((h.after_value->>'review_required')::boolean,false) then return false;end if;
 select allocation_id into a from public.work_cross_job_heads where shift_id=p_shift.id;
 if a is distinct from b.allocation_id or not public._work_cross_job_head_valid(p_shift.id) then return false;end if;
 if exists(select 1 from public.work_cross_job_shifts where shift_id=p_shift.id) and not public._work_cross_job_scope(p_shift.id,p_state.profile_id,false) then return false;end if;
 return true;
end$$;
create or replace function public.custom_work_follow_shift() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
 -- Unregistered sources retain the exact legacy callback behavior.
 update public.custom_work_sessions s set shift_status=new.status,
 review_required=review_required or new.status in('needs_finish','rejected','voided') or project_id is distinct from new.project_id
 or started_at<new.clock_in_at or (ended_at is not null and new.clock_out_at is not null and ended_at>new.clock_out_at)
 where shift_id=new.id and not exists(select 1 from public.work_cross_job_shifts x where x.shift_id=s.shift_id);
 update public.custom_work_sessions s set shift_status=new.status,review_required=coalesce(s.review_required,false) or
 not public._work_cross_job_local_valid('custom',to_jsonb(s),new)
 or coalesce((new.break_started_at is not null and old.break_started_at is null and (s.started_at>new.break_started_at or s.ended_at>new.break_started_at)),false)
 where shift_id=new.id and exists(select 1 from public.work_cross_job_shifts x where x.shift_id=s.shift_id)
 and (s.shift_status is distinct from new.status or (not coalesce(s.review_required,false) and (
 not public._work_cross_job_local_valid('custom',to_jsonb(s),new)
 or coalesce((new.break_started_at is not null and old.break_started_at is null and (s.started_at>new.break_started_at or s.ended_at>new.break_started_at)),false))));
 return new;
end$$;
create or replace function public.service_follow_shift() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare visit_id uuid; r public.service_time_sessions; bad boolean; affected uuid[]:='{}'; registered boolean;
begin
 registered:=exists(select 1 from public.work_cross_job_shifts where shift_id=new.id);
 for r in select * from public.service_time_sessions where shift_id=new.id loop
  if not registered then
   bad:=r.review_required or new.status in('needs_finish','rejected','voided') or r.project_id is distinct from new.project_id
    or r.started_at<new.clock_in_at or (r.ended_at is not null and new.clock_out_at is not null and r.ended_at>new.clock_out_at)
    or (new.break_seconds is distinct from old.break_seconds and old.break_started_at is null);
   update public.service_time_sessions set review_required=bad where id=r.id;
   affected:=array_append(affected,r.visit_id);
  else
   bad:=not public._work_cross_job_local_valid('service',to_jsonb(r),new)
    or (new.break_seconds is distinct from old.break_seconds and old.break_started_at is null)
    or coalesce((new.break_started_at is not null and old.break_started_at is null and (r.started_at>new.break_started_at or r.ended_at>new.break_started_at)),false);
   if bad and not r.review_required then update public.service_time_sessions set review_required=true where id=r.id;end if;
   -- Original trigger runs BEFORE lifecycle closure. Include active intervals
   -- at the selected boundary; unrelated earlier visits retain their stamps.
   if bad or (r.ended_at is null and ((new.break_started_at is not null and old.break_started_at is null)
    or (new.clock_out_at is not null and old.clock_out_at is null) or new.status is distinct from old.status)) then affected:=array_append(affected,r.visit_id);end if;
  end if;
 end loop;
 for visit_id in select distinct unnest(affected) order by 1 loop
  perform public._work_activity_review_visit(visit_id,(public._work_activity_operation()).arrival_at,'correction');
 end loop;
 return new;
end$$;
-- Shared version2 start/resume writer for remaining timing kinds. Public legacy
-- entries remain row-fenced until they explicitly carry this validated context.
create function public._work_cross_job_source(p_profile uuid,p_shift public.time_shifts,p_allocation uuid,p_kind text,p_data jsonb,p_at timestamptz,p_cause text,p_prior uuid default null) returns uuid
language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare a public.work_cross_job_allocations; o public.work_activity_operations; new_id uuid; opening public.project_openings; visit public.service_visits;
 data jsonb; frame uuid; columns text[]; oldj jsonb; paused numeric; table_name text;
begin
 o:=public._work_activity_operation();select * into a from public.work_cross_job_allocations where id=p_allocation;
 if p_kind not in('unit','task','service','phase') or o.actor_id is distinct from p_profile or p_shift.profile_id is distinct from p_profile
 or a.shift_id is distinct from p_shift.id or not public._work_cross_job_scope(p_shift.id,p_profile,false) or p_shift.status<>'open'
 or p_shift.break_started_at is not null or p_shift.clock_out_at is not null or p_at<a.effective_at
 or exists(select 1 from public._work_activity_live_sources(p_profile)) then raise exception using errcode='23514',message='Cross-job source is unavailable.';end if;
 perform public._unit_work_gate(p_profile);
 perform public._work_activity_touch(p_profile);
 if p_kind in('unit','task','phase') then
  select * into opening from public.project_openings where id=(p_data->>'opening_id')::uuid;
  if opening.id is null or opening.project_id is distinct from a.project_id or opening.removed_at is not null or opening.status='installed'
  or not public._ai_job_visible(opening.project_id,p_profile) then raise exception using errcode='23514',message='Cross-job opening is unavailable.';end if;
 end if;
 new_id:=gen_random_uuid();
 if p_kind='unit' then
  if p_data->>'role' is distinct from 'install' then raise exception using errcode='23514',message='Unsupported unit participation.';end if;
  data:=jsonb_build_object('id',new_id,'profile_id',p_profile,'opening_id',opening.id,'role','install','is_rework',public._has_open_redo(opening.id),'started_at',p_at);
 elsif p_kind='task' then
  data:=jsonb_build_object('id',new_id,'profile_id',p_profile,'opening_id',opening.id,'project_id',a.project_id,'state','on_task','started_at',p_at);
 elsif p_kind='service' then
  select * into visit from public.service_visits where id=(p_data->>'visit_id')::uuid;
  if visit.id is null or visit.project_id is distinct from a.project_id or visit.status<>'active' or not public.service_job_access(a.project_id)
  or (p_data->>'unit_id' is not null and not exists(select 1 from public.service_visit_units where id=(p_data->>'unit_id')::uuid and visit_id=visit.id and project_id=a.project_id)) then
  raise exception using errcode='23514',message='Cross-job visit is unavailable.';end if;
  data:=jsonb_build_object('id',new_id,'profile_id',p_profile,'visit_id',visit.id,'project_id',a.project_id,'unit_id',p_data->'unit_id','shift_id',p_shift.id,
  'kind',p_data->'kind','stage',p_data->'stage','description',p_data->'description','started_at',p_at);
 elsif p_kind='phase' then
  if p_prior is not null then
   select to_jsonb(x) into oldj from public.opening_phases x where id=(p_data->>'id')::uuid for update;
   if oldj is null or oldj->>'started_by' is distinct from p_profile::text or oldj->>'opening_id' is distinct from opening.id::text or oldj->>'status'<>'active' or oldj->>'paused_at' is null then
   raise exception using errcode='23514',message='Phase continuation is unavailable.';end if;
   paused:=(oldj->>'paused_seconds')::numeric+greatest(0,round(extract(epoch from p_at-(oldj->>'paused_at')::timestamptz)));
   if paused is null or paused<0 or paused>2147483647 then raise exception using errcode='23514',message='Phase continuation is unavailable.';end if;
   new_id:=(oldj->>'id')::uuid;data:=jsonb_build_object('paused_at',null,'paused_seconds',paused::integer);
  else
   data:=jsonb_build_object('id',new_id,'started_by',p_profile,'opening_id',opening.id,'kind',p_data->'kind','status','active','started_at',p_at,'paused_seconds',0);
  end if;
 end if;
 insert into public.work_cross_job_write_frames values(o.id,p_kind,new_id,p_profile,p_shift.id,a.id,p_at);
 if p_kind<>'phase' then
  perform public._work_activity_insert_source(p_profile,p_kind,data,p_at,p_cause);
 else
  frame:=public._work_activity_context_for(p_profile,p_cause,p_at);
  if oldj is null then
   select array_agg(key order by key) into columns from jsonb_object_keys(data)key;
   perform public._work_activity_expect(frame,'public.opening_phases'::regclass,'INSERT',new_id,columns,null,public._work_activity_evidence('opening_phases',data));
   insert into public.opening_phases(id,started_by,opening_id,kind,status,started_at,paused_seconds)
   select r.id,r.started_by,r.opening_id,r.kind,r.status,r.started_at,r.paused_seconds from jsonb_populate_record(null::public.opening_phases,data)r;
  else
   columns:=array['paused_at','paused_seconds'];
   perform public._work_activity_expect(frame,'public.opening_phases'::regclass,'UPDATE',new_id,columns,
   jsonb_build_object('id',new_id,'started_by',p_profile,'paused_at',oldj->'paused_at','paused_seconds',oldj->'paused_seconds'),
   jsonb_build_object('id',new_id,'started_by',p_profile)||data);
   update public.opening_phases set paused_at=null,paused_seconds=paused::integer where id=new_id;
  end if;
  perform public._work_activity_context_close(frame);
 end if;
 perform public._work_cross_job_bind(p_kind,new_id,p_shift.id,a.id,p_at,p_prior);
 delete from public.work_cross_job_write_frames where operation_id=o.id and source_kind=p_kind and source_id=new_id;
 return new_id;
end$$;
-- A mutable head can accelerate CAS but can never turn an ancestor into a head.
create function public._work_cross_job_head_valid(p_shift uuid) returns boolean language sql stable security definer set search_path=public,pg_temp as $$
 select case when not exists(select 1 from public.work_cross_job_allocations where shift_id=p_shift)
 then not exists(select 1 from public.work_cross_job_heads where shift_id=p_shift)
 else exists(select 1 from public.work_cross_job_heads h join public.work_cross_job_allocations a on a.id=h.allocation_id
 where h.shift_id=p_shift and a.shift_id=p_shift and not exists(select 1 from public.work_cross_job_allocations n where n.predecessor_id=a.id)) end
$$;
create function public._work_cross_job_allocation_guard() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare o public.work_activity_operations;p public.work_activity_operation_people;prior public.work_cross_job_allocations;head uuid;s public.work_cross_job_shifts;
begin
 o:=public._work_activity_operation();select * into p from public.work_activity_operation_people where operation_id=o.id and profile_id=new.profile_id;
 select * into s from public.work_cross_job_shifts where shift_id=new.shift_id;
 select allocation_id into head from public.work_cross_job_heads where shift_id=new.shift_id;
 select * into prior from public.work_cross_job_allocations where id=new.predecessor_id;
 if o.route is distinct from 'work_activity_command' or o.command_id is distinct from new.command_id or o.actor_id is distinct from new.profile_id
 or p.transition_id is distinct from new.transition_id or s.profile_id is distinct from new.profile_id or new.effective_at<s.clock_in_at
 or new.predecessor_id is distinct from head or not public._work_cross_job_head_valid(new.shift_id)
 or (new.predecessor_id is not null and (prior.shift_id is distinct from new.shift_id or prior.profile_id is distinct from new.profile_id or prior.effective_at>new.effective_at))
 or new.event_kind='amendment' then raise exception using errcode='23514',message='Allocation lacks its exact current command boundary.';end if;
 return new;
end$$;
create trigger work_cross_job_allocation_admission before insert on public.work_cross_job_allocations for each row execute function public._work_cross_job_allocation_guard();
create index work_cross_job_source_incarnations on public.work_activity_source_history(source_kind,source_id) where before_value='{}'::jsonb or after_value='{}'::jsonb;
-- Callback predicates are same-shift lookups, including historical closed visits.
create index work_cross_job_custom_shift on public.custom_work_sessions(shift_id,started_at,ended_at);
create index work_cross_job_service_shift on public.service_time_sessions(shift_id,started_at,ended_at,visit_id);

-- Original successful keyed setup request identity, including paid-only fallback.
-- Deliberately retained without profile/shift/operation FKs or cascade rewriting.
create table public.work_cross_job_clock_requests (
 client_id uuid primary key,
 profile_id uuid not null,
 shift_id uuid not null,
 operation_id uuid not null,
 setup_version integer not null check(setup_version in(1,2)),
 receipt_sha256 text not null check(receipt_sha256 ~ '^[0-9a-f]{64}$')
);
create index work_cross_job_clock_requests_profile on public.work_cross_job_clock_requests(profile_id);
revoke all on table public.work_cross_job_clock_requests from public,anon,authenticated,service_role;
alter table public.work_cross_job_clock_requests enable row level security;
-- Canonical receipt fingerprint v1. All 15 retained fields in fixed order;
-- timestamptz values are exact numeric epoch microseconds, never session text.
create function public._work_cross_job_clock_receipt_fingerprint(p_receipt public.work_activity_clock_receipts) returns text
language sql immutable strict security definer set search_path=public,pg_temp as $$
 select pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_array(
  'work_clock_receipt_fingerprint_v1'::text,
  p_receipt.client_id,p_receipt.profile_id,p_receipt.shift_id,p_receipt.action,p_receipt.outcome,
  extract(epoch from p_receipt.tapped_at)*1000000::numeric,
  extract(epoch from p_receipt.arrived_at)*1000000::numeric,
  extract(epoch from p_receipt.clock_checked_at)*1000000::numeric,
  p_receipt.clock_skew_ms,p_receipt.used_tap_time,p_receipt.review_reason,
  extract(epoch from p_receipt.source_created_at)*1000000::numeric,
  p_receipt.receipt_protocol,p_receipt.setup_payload_digest,
  extract(epoch from p_receipt.recorded_at)*1000000::numeric
 )::text,'UTF8')),'hex')
$$;
revoke all on function public._work_cross_job_clock_receipt_fingerprint(public.work_activity_clock_receipts) from public,anon,authenticated,service_role;
create function public._work_cross_job_clock_request_admit() returns trigger
language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare o public.work_activity_operations;r public.work_activity_clock_receipts;
begin
 perform pg_catalog.pg_advisory_xact_lock(7712,0);
 o:=public._work_activity_operation();
 select * into r from public.work_activity_clock_receipts where client_id=new.client_id;
 if o.id is null or o.route is distinct from 'clock_in_setup' or not o.clock_entry_claimed
  or o.actor_id is null or o.actor_id is distinct from auth.uid() or o.actor_id is distinct from new.profile_id
  or o.request_id is distinct from new.client_id or o.id is distinct from new.operation_id
  or o.top_xid is distinct from pg_current_xact_id() or o.backend_pid is distinct from pg_backend_pid() or o.command_id is not null
  or o.arguments->>'setupVersion' is distinct from new.setup_version::text
  or r.client_id is null or r.profile_id is distinct from new.profile_id or r.shift_id is distinct from new.shift_id
  or r.action is distinct from 'clock_in' or r.receipt_protocol is distinct from 'setup_v1'
  or r.setup_payload_digest is distinct from o.arguments->>'clockPayloadDigest'
  or new.receipt_sha256 is distinct from public._work_cross_job_clock_receipt_fingerprint(r) then
   raise exception using errcode='42501',message='Clock receipt unavailable.';
 end if;
 return new;
end$$;
create function public._work_cross_job_clock_request_stamp() returns trigger
language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare o public.work_activity_operations;
begin
 if new.action<>'clock_in' or new.receipt_protocol<>'setup_v1' then return new;end if;
 o:=public._work_activity_operation();
 if o.id is null or o.route is distinct from 'clock_in_setup'
  or o.arguments->>'setupVersion' is null or o.arguments->>'setupVersion' not in('1','2') then
  raise exception using errcode='42501',message='Clock receipt unavailable.';
 end if;
 insert into public.work_cross_job_clock_requests(client_id,profile_id,shift_id,operation_id,setup_version,receipt_sha256)
 values(new.client_id,new.profile_id,new.shift_id,o.id,(o.arguments->>'setupVersion')::integer,public._work_cross_job_clock_receipt_fingerprint(new));
 return new;
end$$;
revoke all on function public._work_cross_job_clock_request_admit() from public,anon,authenticated,service_role;
revoke all on function public._work_cross_job_clock_request_stamp() from public,anon,authenticated,service_role;
create trigger work_cross_job_clock_requests_admit before insert on public.work_cross_job_clock_requests for each row execute function public._work_cross_job_clock_request_admit();
create trigger work_cross_job_clock_requests_immutable before update or delete on public.work_cross_job_clock_requests for each row execute function public.work_capture_immutable_record();
create trigger work_cross_job_clock_requests_no_truncate before truncate on public.work_cross_job_clock_requests for each statement execute function public.work_capture_immutable_record();
create trigger work_cross_job_clock_request_stamp after insert on public.work_activity_clock_receipts for each row execute function public._work_cross_job_clock_request_stamp();

create or replace function public._work_activity_row_before() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare oldj jsonb; newj jsonb; who uuid; oldwho uuid; kind text; o public.work_activity_operations;
 allowance uuid; new_live boolean; old_live boolean; boundary timestamptz;
begin
 o:=public._work_activity_operation();
 if o.id is null then raise exception using errcode='23514',message='Activity source write lacks its statement.';end if;
 oldj:=case when tg_op<>'INSERT' then to_jsonb(old) end;
 newj:=case when tg_op<>'DELETE' then to_jsonb(new) end;
 who:=(coalesce(newj,oldj)->>case when tg_table_name='opening_phases' then 'started_by' else 'profile_id' end)::uuid;
 oldwho:=(oldj->>case when tg_table_name='opening_phases' then 'started_by' else 'profile_id' end)::uuid;
 perform public._work_cross_job_birth_guard(case tg_table_name when 'custom_work_sessions' then 'custom' when 'unit_sessions' then 'unit' when 'task_sessions' then 'task' when 'service_time_sessions' then 'service' when 'opening_phases' then 'phase' when 'work_setup_sessions' then 'setup' end,oldj,newj);
 if oldwho is not null then perform public._work_activity_touch(oldwho);end if;
 if who is not null then perform public._work_activity_touch(who);end if;
 -- Setup has its stronger exact-once private guard. Do not consume its
 -- allowance twice; its row guard remains installed and authoritative.
 if tg_table_name<>'work_setup_sessions' then allowance:=public._work_activity_row_allowance(tg_relid,tg_op,oldj,newj);end if;
 if allowance is not null or tg_op='DELETE' or tg_table_name in ('time_shifts','summon_helpers','work_setup_sessions') then
   if tg_op='DELETE' then return old;else return new;end if;
 end if;
 kind:=case tg_table_name when 'custom_work_sessions' then 'custom' when 'unit_sessions' then 'unit' when 'task_sessions' then 'task' when 'service_time_sessions' then 'service' when 'opening_phases' then 'phase' end;
 new_live:=case when kind='phase' then newj->>'status'='active' and newj->'paused_at'='null'::jsonb
   when kind='task' then newj->>'state'='on_task' and newj->'ended_at'='null'::jsonb else newj->'ended_at'='null'::jsonb end;
 old_live:=coalesce(case when kind='phase' then oldj->>'status'='active' and oldj->'paused_at'='null'::jsonb
   when kind='task' then oldj->>'state'='on_task' and oldj->'ended_at'='null'::jsonb else oldj->'ended_at'='null'::jsonb end,false);
 -- Shared progress may be resumed by another authorized worker, or by a
 -- starter off the clock. It is then untimed progress, never a transfer of
 -- that starter's personal claim or a closure of their unrelated activity.
 if kind='phase' and (who is distinct from o.actor_id or (select count(*) from public.time_shifts where profile_id=who and status='open' and clock_out_at is null and break_started_at is null)<>1) then return new;end if;
 if who is not null and new_live and (not old_live or oldwho is distinct from who) then
   boundary:=case when kind='phase' and tg_op='UPDATE' then o.arrival_at else (newj->>'started_at')::timestamptz end;
   if boundary is null or not isfinite(boundary) then raise exception using errcode='23514',message='A finite activity boundary is required.';end if;
   if exists(select 1 from public.time_shifts where profile_id=who and status='open' and clock_out_at is null and break_started_at is not null) then
     raise exception using errcode='23514',message='Resume the job clock before starting work.';
   end if;
   if kind<>'service' and exists(select 1 from public.service_time_sessions where profile_id=who and (started_at>boundary or ended_at>boundary)) then
     raise exception using errcode='23514',message='Newer service time requires timeline review.';
   end if;
   perform public._work_activity_close_all(who,boundary,'legacy_transition',kind,(newj->>'id')::uuid);
 elsif kind='task' and tg_op='INSERT' and newj->>'state'='off_task' then
   perform public._work_activity_close_all(who,(newj->>'started_at')::timestamptz,'stop');
 end if;
 return new;
end; $$;

create or replace function public._work_activity_operation_exit(p_operation uuid) returns void
language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare o public.work_activity_operations; person public.work_activity_operation_people; s public.personal_activity_state;
 before_s public.personal_activity_state; last_event public.work_activity_operation_events; event_row record;
 selected_time timestamptz; selected_cause text; shift_source uuid; relation_kind text; before_count bigint;
begin
 if p_operation is null then return; end if;
 o:=public._work_activity_operation();
 if o.id is distinct from p_operation then raise exception using errcode='42501',message='Activity operation is unavailable.'; end if;
 if exists(select 1 from public.work_activity_statement_frames where operation_id=o.id)
   or exists(select 1 from public.work_activity_transaction_context where top_xid=o.top_xid and backend_pid=o.backend_pid) then
   raise exception using errcode='23514',message='Activity statements and mutations must finish before their operation.';
 end if;
 for person in select * from public.work_activity_operation_people where operation_id=o.id order by profile_id loop
   before_s:=jsonb_populate_record(null::public.personal_activity_state,person.before_state);
   s:=public._work_activity_refresh_state(person.profile_id);
   select * into last_event from public.work_activity_operation_events where operation_id=o.id and profile_id=person.profile_id order by event_order desc limit 1;
   if last_event.id is null and (to_jsonb(s)-'updated_at')=(person.before_state-'updated_at') then continue; end if;
   selected_time:=coalesce(last_event.selected_at,o.arrival_at);
   selected_cause:=coalesce(last_event.cause,'legacy_transition');
   -- A payroll transition owns the root boundary even when its callback
   -- emits subsequent per-source rows at the same selected time.
   select source_id,selected_at,cause into shift_source,selected_time,selected_cause from public.work_activity_operation_events
     where operation_id=o.id and profile_id=person.profile_id and source_kind='shift' order by event_order desc limit 1;
   if not found then selected_time:=coalesce(last_event.selected_at,o.arrival_at);selected_cause:=coalesce(last_event.cause,'legacy_transition');shift_source:=coalesce(s.shift_id,before_s.shift_id); end if;
   if o.command_id is not null then selected_cause:=case o.arguments->>'kind' when 'switch' then 'switch' else 'stop' end; end if;
   if before_s.revision>=9007199254740991 or exists(select 1 from public.work_activity_safety_events where profile_id=person.profile_id) then
     perform public._work_activity_safety_exit(o.id,person.profile_id,case when before_s.revision>=9007199254740991 then 'revision_exhausted' else 'prior_safety_event' end);
     continue;
   end if;
   insert into public.personal_activity_transitions(id,profile_id,revision_before,revision_after,command_id,legacy_source_route,source_request_id,actor_id,cause,
     received_at,selected_effective_at,time_selection_reason,source_shift_id,before_evidence,after_evidence,protocol_version)
   values(person.transition_id,person.profile_id,before_s.revision,before_s.revision+1,o.command_id,case when o.command_id is null then o.route end,o.request_id,o.actor_id,
     selected_cause,o.arrival_at,selected_time,case when o.command_id is null then 'legacy_selected_boundary' else 'validated_activity_boundary' end,shift_source,
     jsonb_build_object('state',person.before_state),jsonb_build_object('state',(to_jsonb(s)-'updated_at')||jsonb_build_object('revision',before_s.revision+1,'last_transition_id',person.transition_id)),case when exists(select 1 from public.work_cross_job_shifts where shift_id=shift_source) then 2 else 1 end);
   -- Multiple writes to one source in one logical operation are one typed
   -- immutable child: exact first-before and last-after, never copied notes.
   for event_row in
     select source_kind,source_id,(array_agg(before_value order by event_order))[1] first_before,
       (array_agg(after_value order by event_order desc))[1] last_after,
       (array_agg(selected_at order by event_order desc))[1] boundary,
       (array_agg(cause order by event_order desc))[1] event_cause
     from public.work_activity_operation_events where operation_id=o.id and profile_id=person.profile_id group by source_kind,source_id
   loop
     relation_kind:=case event_row.source_kind when 'shift' then 'payroll' when 'helper' then 'attribution'
       when 'phase' then case when (before_s.active_source_kind='phase' and before_s.active_source_id=event_row.source_id)
         or (s.active_source_kind='phase' and s.active_source_id=event_row.source_id) then 'phase_participation' else 'attribution' end else 'effective' end;
     insert into public.personal_activity_transition_sources(transition_id,profile_id,source_kind,source_id,relation,source_shift_id,
       selected_effective_at,cause,before_revision,after_revision,before_evidence,after_evidence)
     values(person.transition_id,person.profile_id,event_row.source_kind,event_row.source_id,relation_kind,
       case when event_row.source_kind='shift' then event_row.source_id else coalesce((event_row.last_after->>'shift_id')::uuid,(event_row.first_before->>'shift_id')::uuid,shift_source) end,
       event_row.boundary,event_row.event_cause,(event_row.first_before->>'revision')::bigint,(event_row.last_after->>'revision')::bigint,event_row.first_before,event_row.last_after);
   end loop;
   update public.personal_activity_state set revision=before_s.revision+1,last_transition_id=person.transition_id,
     resume_after_break_transition_id=case when resume_token is not null and selected_cause='break_start' then person.transition_id else resume_after_break_transition_id end,
     updated_at=clock_timestamp() where profile_id=person.profile_id;
   -- A source's narrow integer counter may be exhausted while the personal
   -- counter remains usable. Keep the normal lifecycle transition AND exact
   -- exceptional evidence; do not wrap a source revision or block payroll.
   if exists(select 1 from public.work_activity_operation_events e where e.operation_id=o.id and e.profile_id=person.profile_id
      and ((e.source_kind='custom' and (e.before_value->>'revision')::bigint>=2147483647 and e.before_value is distinct from e.after_value)
        or e.after_value->'exhaustedVisitCounter' is not null)) then
     perform public._work_activity_safety_exit(o.id,person.profile_id,'source_revision_exhausted');
   end if;
 end loop;
 delete from public.work_activity_operation_events where operation_id=o.id;
 delete from public.work_activity_operation_people where operation_id=o.id;
 delete from public.work_activity_operations where id=o.id;
end; $$;

create or replace function public._work_activity_start_setup(p_shift public.time_shifts,p_clock_client uuid,p_prior uuid default null) returns uuid
language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare person public.work_activity_operation_people; o public.work_activity_operations; at_time timestamptz; created uuid;
begin
 o:=public._work_activity_operation();person:=public._work_activity_touch(p_shift.profile_id);
 if o.actor_id is distinct from p_shift.profile_id or not public._work_config_internal(p_shift.profile_id)
   or (person.before_state->>'revision')::bigint>=9007199254740991
   or exists(select 1 from public.work_activity_safety_events where profile_id=p_shift.profile_id) then return null;end if;
 if p_prior is null and (o.route<>'clock_in_setup' or o.request_id is distinct from p_clock_client) then
   raise exception using errcode='23514',message='Initial setup requires the explicit clock adapter.';
 end if;
 at_time:=case when p_prior is null then p_shift.clock_in_at else coalesce(p_shift.last_punch_at,o.arrival_at) end;
 created:=public._work_activity_insert_source(p_shift.profile_id,'setup',jsonb_build_object('id',gen_random_uuid(),'profile_id',p_shift.profile_id,
   'shift_id',p_shift.id,'clock_client_id',p_clock_client,'resumed_from_id',p_prior,'started_at',at_time,'start_transition_id',person.transition_id),
   at_time,case when p_prior is null then 'clock_in' else 'break_end' end);
 if exists(select 1 from public.work_cross_job_shifts where shift_id=p_shift.id) then perform public._work_cross_job_bind('setup',created,p_shift.id,null,at_time,case when p_prior is not null then (select closure_history_id from public.work_cross_job_resume where profile_id=p_shift.profile_id) end);end if;
 return created;
end; $$;

create or replace function public._work_activity_shift_lifecycle() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare person public.work_activity_operation_people; s public.personal_activity_state; o public.work_activity_operations; boundary timestamptz; cause text; saved boolean; resumed boolean;
begin
 o:=public._work_activity_operation();person:=public._work_activity_touch(case when tg_op='DELETE' then old.profile_id else new.profile_id end);
 select * into s from public.personal_activity_state where profile_id=person.profile_id;
 if tg_op='DELETE' then
   if s.shift_id=old.id then perform public._work_activity_close_all(old.profile_id,o.arrival_at,'correction');end if;
   return old;
 end if;
 if tg_op='INSERT' then
   -- Historical imports never start/close today's activity. Ordinary new
   -- clock-ins clear stale claims before explicit setup can be opened.
   if new.source_import is null and new.status='open' and new.clock_out_at is null then
     perform public._work_activity_close_all(new.profile_id,new.clock_in_at,'clock_in');
   end if;
   return new;
 end if;
 if new.clock_out_at is not null and old.clock_out_at is null then boundary:=new.clock_out_at;cause:='clock_out';
 elsif new.status<>'open' and old.status='open' then boundary:=coalesce(new.clock_out_at,o.arrival_at);cause:=case when new.status='voided' then 'void' else 'correction' end;
 elsif new.break_started_at is not null and old.break_started_at is null then boundary:=new.break_started_at;cause:='break_start';
 elsif new.break_started_at is null and old.break_started_at is not null and new.clock_out_at is null and new.status='open' then
   boundary:=coalesce(new.last_punch_at,o.arrival_at);
   resumed:=false;
   if o.route='end_break' and o.actor_id=new.profile_id then resumed:=public._work_activity_resume(s,new,boundary);end if;
   update public.personal_activity_state set resume_token=null,resume_source_kind=null,resume_source_id=null,resume_definition_version_id=null,
    resume_shift_id=null,resume_from_revision=null,resume_after_break_transition_id=null,resume_authority_revision=null,
    choice_required=not resumed where profile_id=new.profile_id;
   delete from public.work_cross_job_resume where profile_id=new.profile_id;
   return new;
 else return new;end if;
 -- A historical correction to another shift cannot end today's timer.
 if s.shift_id is distinct from new.id then return new;end if;
 saved:=cause='break_start' and s.integrity_state='clean' and s.active_source_id is not null and s.revision<9007199254740991
   and s.effective_since is not null and s.effective_since<=boundary
   and not exists(select 1 from public.work_activity_safety_events where profile_id=new.profile_id);
 perform public._work_activity_close_all(new.profile_id,boundary,cause);
 if saved then saved:=public._work_cross_job_save(s,new.id,boundary,person.transition_id);
 else delete from public.work_cross_job_resume where profile_id=new.profile_id;end if;
 update public.personal_activity_state set active_source_kind=null,active_source_id=null,active_definition_version_id=null,effective_since=null,
  resume_token=case when saved then gen_random_uuid() end,resume_source_kind=case when saved then s.active_source_kind end,
  resume_source_id=case when saved then s.active_source_id end,resume_definition_version_id=case when saved then s.active_definition_version_id end,
  resume_shift_id=case when saved then new.id end,resume_from_revision=case when saved then s.revision end,
  resume_after_break_transition_id=case when saved then person.transition_id end,
  resume_authority_revision=case when saved then public._work_activity_authority_revision() end,choice_required=false where profile_id=new.profile_id;
 return new;
end; $$;

create or replace function public._work_activity_resume(p_state public.personal_activity_state,p_shift public.time_shifts,p_at timestamptz) returns boolean
language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare view_state public.personal_activity_state; r jsonb; table_name text; prior_meta public.work_session_capture_metadata;
 intent jsonb; new_id uuid; frame uuid; config_enabled boolean; source_basis jsonb; changes jsonb; columns text[]; before_values jsonb; after_values jsonb; paused_total numeric; allocation uuid; closure uuid; version2 boolean;
begin
 if p_state.profile_id is distinct from auth.uid() or not public._work_config_internal(p_state.profile_id)
   or p_state.resume_token is null or p_state.resume_shift_id is distinct from p_shift.id
   or p_state.resume_after_break_transition_id is distinct from p_state.last_transition_id
   or p_state.resume_authority_revision is distinct from public._work_activity_authority_revision()
   or p_state.resume_authority_revision>=9007199254740991 or p_shift.status<>'open' or p_shift.clock_out_at is not null or p_shift.break_started_at is not null
   or exists(select 1 from public.work_activity_safety_events where profile_id=p_state.profile_id)
   or exists(select 1 from public._work_activity_live_sources(p_state.profile_id)) then return false;end if;
 if not pg_try_advisory_xact_lock(7710,0) then return false;end if;
 if not public._work_cross_job_resume_basis(p_state,p_shift,p_at) then return false;end if;
 version2:=exists(select 1 from public.work_cross_job_shifts where shift_id=p_shift.id);
 select allocation_id,closure_history_id into allocation,closure from public.work_cross_job_resume where profile_id=p_state.profile_id;
 -- Recheck after any domain-lock acquisition. G excludes installed writers;
 -- the check remains explicit so a future adapter cannot rely on old state.
 if p_state.resume_authority_revision is distinct from public._work_activity_authority_revision() then return false;end if;
 view_state:=p_state;view_state.active_source_kind:=p_state.resume_source_kind;view_state.active_source_id:=p_state.resume_source_id;
 view_state.active_definition_version_id:=p_state.resume_definition_version_id;view_state.effective_since:=p_at;
 if public._work_activity_source_view(view_state)->>'visibility' is distinct from 'available' then return false;end if;
 table_name:=case p_state.resume_source_kind when 'custom' then 'custom_work_sessions' when 'unit' then 'unit_sessions' when 'task' then 'task_sessions'
   when 'service' then 'service_time_sessions' when 'phase' then 'opening_phases' when 'setup' then 'work_setup_sessions' end;
 execute format('select to_jsonb(s) from public.%I s where id=$1 for update',table_name) into r using p_state.resume_source_id;
 if p_state.resume_source_kind<>'phase' and ((r->>'ended_at')::timestamptz is null or (r->>'ended_at')::timestamptz>p_at) then return false;end if;
 if p_state.resume_source_kind='setup' then
   if r->>'end_reason'<>'break' then return false;end if;
   select capture_enabled into config_enabled from public.work_activity_authority_generation where singleton;
   if not config_enabled then return false;end if;
   new_id:=public._work_activity_start_setup(p_shift,(r->>'clock_client_id')::uuid,p_state.resume_source_id);
   return new_id is not null;
 end if;
 -- A toolbox refusal is an eligibility outcome for auto-resume. Do not turn
 -- an expired signature into a failed paid break return.
 if p_state.resume_source_kind='custom' and r->>'unit_id' is null then perform public._prep_time_gate(p_state.profile_id);
 else perform public._unit_work_gate(p_state.profile_id);end if;
 if p_state.resume_source_kind in ('unit','task','phase') and not exists(
   select 1 from public.project_openings where id=(r->>'opening_id')::uuid and removed_at is null and status<>'installed' and public._ai_job_visible(project_id,p_state.profile_id)) then return false;end if;
 if p_state.resume_source_kind='custom' then
   if r->>'end_reason'<>'break' or exists(select 1 from public.custom_work_units where id=(r->>'unit_id')::uuid and facts->>'installation_complete'='Yes') then return false;end if;
   select * into prior_meta from public.work_session_capture_metadata where session_id=p_state.resume_source_id;
   if prior_meta.session_id is not null then
     select capture_enabled into config_enabled from public.work_activity_authority_generation where singleton;
     if not config_enabled then return false;end if;
     intent:=jsonb_build_object('kind','switch','projectId',prior_meta.project_id,'selectionId',prior_meta.selection_id,'selectionRevision',prior_meta.selection_revision,
      'menuVersionId',prior_meta.menu_version_id,'definitionVersionId',prior_meta.definition_version_id,'scope',prior_meta.scope,
      'unit',prior_meta.continuation_unit_basis,'machineKind',prior_meta.machine_kind,'values',prior_meta.answers);
     if public._work_activity_validate_switch(intent,p_state.profile_id) is not null then return false;end if;
   end if;
   if version2 then
    if prior_meta.session_id is null then return false;end if;
    new_id:=public._work_cross_job_custom(p_state.profile_id,p_shift,allocation,intent,p_at,'break_end',closure);
   else
   frame:=public._work_activity_context_for(p_state.profile_id,'break_end',p_at);
   new_id:=gen_random_uuid();
   perform public.custom_work_command(gen_random_uuid(),'start',jsonb_build_object('id',new_id,'shift_id',p_shift.id,'unit_id',r->'unit_id',
    'expected_session_id',null,'at',p_at,'participation',r->'participation','stage',r->'stage','description',r->'description'));
   perform public._work_activity_context_close(frame);
   if prior_meta.session_id is not null then
     source_basis:=case when prior_meta.unit_id is not null then public._work_activity_command_basis(public._work_activity_unit_basis(prior_meta.unit_id,p_state.profile_id)) end;
     insert into public.work_session_capture_metadata(session_id,profile_id,project_id,definition_version_id,menu_version_id,scope,unit_id,fact_revision,unit_facts,machine_kind,
       selection_id,selection_revision,answers,unit_basis,continuation_unit_basis)
     values(new_id,p_state.profile_id,prior_meta.project_id,prior_meta.definition_version_id,prior_meta.menu_version_id,prior_meta.scope,prior_meta.unit_id,
       prior_meta.fact_revision,prior_meta.unit_facts,prior_meta.machine_kind,prior_meta.selection_id,prior_meta.selection_revision,prior_meta.answers,
       prior_meta.continuation_unit_basis,source_basis);
   end if;
   end if;
 elsif version2 then
   new_id:=public._work_cross_job_source(p_state.profile_id,p_shift,allocation,p_state.resume_source_kind,r,p_at,'break_end',closure);
 elsif p_state.resume_source_kind='unit' then
   -- Old helper intervals lack an exact summon foreign key. Never infer a
   -- continuation from another helper's or yesterday's similarly named call.
   if r->>'end_reason'<>'break' or r->>'role'='helper' then return false;end if;
   new_id:=public._work_activity_insert_source(p_state.profile_id,'unit',jsonb_build_object('id',gen_random_uuid(),'profile_id',p_state.profile_id,
     'opening_id',r->'opening_id','role',r->'role','is_rework',public._has_open_redo((r->>'opening_id')::uuid),'started_at',p_at),p_at,'break_end');
 elsif p_state.resume_source_kind='task' then
   if r->>'state'<>'on_task' then return false;end if;
   new_id:=public._work_activity_insert_source(p_state.profile_id,'task',jsonb_build_object('id',gen_random_uuid(),'profile_id',p_state.profile_id,
     'opening_id',r->'opening_id','project_id',r->'project_id','state','on_task','started_at',p_at),p_at,'break_end');
 elsif p_state.resume_source_kind='service' then
   if r->>'end_reason'<>'break' or not exists(select 1 from public.service_visits where id=(r->>'visit_id')::uuid and status='active') then return false;end if;
   new_id:=public._work_activity_insert_source(p_state.profile_id,'service',jsonb_build_object('id',gen_random_uuid(),'profile_id',p_state.profile_id,
    'visit_id',r->'visit_id','project_id',r->'project_id','unit_id',r->'unit_id','shift_id',p_shift.id,'kind',r->'kind','stage',r->'stage','description',r->'description','started_at',p_at),p_at,'break_end');
 elsif p_state.resume_source_kind='phase' then
   if r->>'status'<>'active' or r->>'paused_at' is null or (r->>'paused_at')::timestamptz>p_at then return false;end if;
   -- A corrupt/exhausted activity duration must never reject paid break return.
   -- Compute before the integer cast so the eligibility path is deterministic.
   paused_total:=(r->>'paused_seconds')::numeric+greatest(0,round(extract(epoch from p_at-(r->>'paused_at')::timestamptz)));
   if paused_total is null or paused_total<0 or paused_total>2147483647 then return false;end if;
   changes:=jsonb_build_object('paused_at',null,'paused_seconds',paused_total::integer);
   frame:=public._work_activity_context_for(p_state.profile_id,'break_end',p_at);
   columns:=array['paused_at','paused_seconds'];
   select jsonb_object_agg(key,value) into before_values from jsonb_each(r) where key=any(columns||array['id','started_by']);after_values:=before_values||changes;
   perform public._work_activity_expect(frame,'public.opening_phases'::regclass,'UPDATE',p_state.resume_source_id,columns,before_values,after_values);
   update public.opening_phases set paused_at=null,paused_seconds=(changes->>'paused_seconds')::integer where id=p_state.resume_source_id;
   perform public._work_activity_context_close(frame);new_id:=p_state.resume_source_id;
 end if;
 return new_id is not null;
exception when raise_exception or check_violation or foreign_key_violation or unique_violation or insufficient_privilege or numeric_value_out_of_range then
 -- This subtransaction rolls back a partially constructed resume, including
 -- all private frames/events. The outer paid break return stays successful.
 return false;
end; $$;

create or replace function public.clock_in(
 p_project_id uuid,p_cost_code_id uuid,p_photo text,p_lat double precision,p_lng double precision,
 p_note text,p_mode text,p_client_id uuid,p_tapped_at timestamptz,p_clock_checked_at timestamptz,p_clock_skew_ms integer,p_setup_version integer
) returns public.time_shifts language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare actor uuid;operation uuid;h public.time_shifts;prior boolean;enabled boolean;digest text;
begin
 perform public._work_activity_read_committed();
 perform public._work_activity_gate();actor:=public._work_activity_actor();
 if p_setup_version not in(1,2) or p_setup_version is null or (p_setup_version=2 and (not public._work_cross_job_enabled() or not (coalesce((select p.prosrc is not null and encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')='bbebab5cc374c8233ba85a865428db4ac38ed8e0c4bf8b295edf645bb4d8e074' and pg_get_userbyid(p.proowner)='postgres' and p.proacl::text='{postgres=X/postgres}' and p.prosecdef and p.proconfig=array['search_path=public, pg_temp']::text[] and p.provolatile='s' and not p.proisstrict and not p.proleakproof and p.proparallel='u' and p.prokind='f' and not p.proretset and p.prorettype='boolean'::regtype and p.pronargs=0 and p.pronargdefaults=0 and p.procost=100 and p.prorows=0 and p.prosupport=0 and p.prolang=(select oid from pg_language where lanname='sql') from pg_proc p where p.oid=to_regprocedure('public._work_cross_job_coverage()')),false) and public._work_cross_job_coverage()))) then raise exception using errcode='23514',message='Unsupported paid setup protocol.';end if;
 if p_project_id is not null and not public._ai_job_visible(p_project_id,actor) then raise exception using errcode='42501',message='The clock source is unavailable.';end if;
 if p_client_id is null or p_tapped_at is null or not isfinite(p_tapped_at) or (p_clock_checked_at is not null and not isfinite(p_clock_checked_at)) then
   raise exception using errcode='23514',message='Paid setup requires its original keyed clock stamp.';end if;
 digest:=public._work_activity_clock_setup_digest(p_project_id,p_cost_code_id,p_photo,p_lat,p_lng,p_note,p_mode,p_client_id,p_tapped_at,p_clock_checked_at,p_clock_skew_ms);
 operation:=public._work_activity_operation_enter('clock_in_setup',jsonb_build_object('setupVersion',p_setup_version,'clockPayloadDigest',digest),p_client_id);
 if operation is null then raise exception using errcode='23514',message='Paid setup requires its original clock root.';end if;
 perform public._work_activity_clock_replay_guard(p_client_id,'clock_in');
 prior:=exists(select 1 from public.time_clock_actions where client_id=p_client_id and profile_id=actor)
   or exists(select 1 from public.time_shifts where client_id=p_client_id and profile_id=actor);
 h:=public.clock_in(p_project_id,p_cost_code_id,p_photo,p_lat,p_lng,p_note,p_mode,p_client_id,p_tapped_at,p_clock_checked_at,p_clock_skew_ms);
 select capture_enabled into enabled from public.work_activity_authority_generation where singleton;
 if not prior and enabled and h.profile_id=actor and h.status='open' and h.clock_out_at is null and h.break_started_at is null
  -- A reviewed/fallback payroll arrival remains paid under the original route,
  -- but cannot resurrect automatic capture from an untrusted/delayed tap.
  and exists(select 1 from public.time_clock_actions where client_id=p_client_id and profile_id=actor and shift_id=h.id and action='clock_in' and outcome='clocked_in' and used_tap_time and review_reason is null) then
   if p_setup_version=2 then perform public._work_cross_job_register(h,p_client_id);end if;
   perform public._work_activity_start_setup(h,p_client_id);
 end if;
 perform public._work_activity_operation_exit(operation);
 return h;
end; $$;

create or replace function public._work_activity_claim_clock_setup(p_project_id uuid,p_cost_code_id uuid,p_photo text,p_lat double precision,p_lng double precision,
 p_note text,p_mode text,p_client_id uuid,p_tapped_at timestamptz,p_clock_checked_at timestamptz,p_clock_skew_ms integer) returns boolean
language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare o public.work_activity_operations;actor uuid;enabled boolean;generation bigint;s public.personal_activity_state;
begin
 o:=public._work_activity_operation();
 -- All retained direct overloads keep their original admission policy.
 if o.id is null or o.route is distinct from 'clock_in_setup' then return false;end if;
 actor:=auth.uid();
 if actor is null or not public._work_config_internal(actor)
  or o.actor_id is distinct from actor or o.top_xid is distinct from pg_current_xact_id() or o.backend_pid is distinct from pg_backend_pid()
  or p_client_id is null or o.request_id is distinct from p_client_id or o.command_id is not null or o.clock_entry_claimed
  or coalesce(o.arguments->>'setupVersion','') not in('1','2') or (o.arguments->>'setupVersion'='2' and (not public._work_cross_job_enabled() or not (coalesce((select p.prosrc is not null and encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')='bbebab5cc374c8233ba85a865428db4ac38ed8e0c4bf8b295edf645bb4d8e074' and pg_get_userbyid(p.proowner)='postgres' and p.proacl::text='{postgres=X/postgres}' and p.prosecdef and p.proconfig=array['search_path=public, pg_temp']::text[] and p.provolatile='s' and not p.proisstrict and not p.proleakproof and p.proparallel='u' and p.prokind='f' and not p.proretset and p.prorettype='boolean'::regtype and p.pronargs=0 and p.pronargdefaults=0 and p.procost=100 and p.prorows=0 and p.prosupport=0 and p.prolang=(select oid from pg_language where lanname='sql') from pg_proc p where p.oid=to_regprocedure('public._work_cross_job_coverage()')),false) and public._work_cross_job_coverage())))
  or o.arguments is distinct from jsonb_build_object('setupVersion',(o.arguments->>'setupVersion')::integer,'clockPayloadDigest',public._work_activity_clock_setup_digest(p_project_id,p_cost_code_id,p_photo,p_lat,p_lng,p_note,p_mode,p_client_id,p_tapped_at,p_clock_checked_at,p_clock_skew_ms)) then
   raise exception using errcode='42501',message='Paid setup does not match its original clock entry.';
 end if;
 -- An ordinary caller cannot create this private row, consume this helper,
 -- or relabel a different root. Replays return before reaching this claim.
 update public.work_activity_operations set clock_entry_claimed=true where id=o.id;
 select capture_enabled,revision into enabled,generation from public.work_activity_authority_generation where singleton;
 select * into s from public.personal_activity_state where profile_id=actor;
 -- Closing-only retains existing payroll/replay policy, but cannot grant a
 -- NEW unsigned-start exemption. No setup counter/state is initialized here.
 return coalesce(enabled,false) and generation<9007199254740991
  and (s.profile_id is null or (s.integrity_state='clean' and s.revision<9007199254740991))
  and not exists(select 1 from public.work_activity_safety_events where profile_id=actor);
end; $$;

create or replace function public.work_activity_command(p_command_id uuid,p_protocol_version integer,p_payload jsonb) returns jsonb
language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare actor uuid; payload jsonb; hash text; prior public.personal_activity_commands; head public.personal_activity_commands;
 s public.personal_activity_state; after_s public.personal_activity_state; h public.time_shifts; obs public.work_activity_observations;
 stream public.work_activity_streams; anchor public.work_activity_observations; clock_action public.time_clock_actions;
 clock_transition public.personal_activity_transitions; definition public.work_activity_definition_versions;
 device uuid; generation uuid; expected bigint; sequence_number bigint; predecessor uuid; kind text; intent jsonb;
 v_status text:='noop'; reason text; source_reason text; result jsonb; arrival timestamptz; selected_at timestamptz;
 pick public.clock_time_pick; not_before timestamptz; operation uuid; frame uuid; nested_request uuid; session_id uuid; person public.work_activity_operation_people;
 enabled boolean; admitted boolean:=false; clock_bridge boolean:=false; observation_lineage boolean:=false; unit_basis jsonb; before_shift jsonb; after_shift jsonb; prior_allocation uuid; allocation uuid; cross_job boolean:=false;
begin
 perform public._work_activity_read_committed();
 perform public._work_activity_gate();
 actor:=public._work_activity_actor();
 if p_command_id is null or (p_protocol_version not in(1,2) or p_protocol_version is null) then raise exception using errcode='23514',message='Invalid activity protocol or command identity.';end if;
 if p_protocol_version=2 then
  if not public._work_cross_job_enabled() or not (coalesce((select p.prosrc is not null and encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')='bbebab5cc374c8233ba85a865428db4ac38ed8e0c4bf8b295edf645bb4d8e074' and pg_get_userbyid(p.proowner)='postgres' and p.proacl::text='{postgres=X/postgres}' and p.prosecdef and p.proconfig=array['search_path=public, pg_temp']::text[] and p.provolatile='s' and not p.proisstrict and not p.proleakproof and p.proparallel='u' and p.prokind='f' and not p.proretset and p.prorettype='boolean'::regtype and p.pronargs=0 and p.pronargdefaults=0 and p.procost=100 and p.prorows=0 and p.prosupport=0 and p.prolang=(select oid from pg_language where lanname='sql') from pg_proc p where p.oid=to_regprocedure('public._work_cross_job_coverage()')),false) and public._work_cross_job_coverage()) then return jsonb_build_object('protocolVersion',2,'availability','unavailable','receipt',null);end if;
  perform public._work_activity_object(p_payload,array['deviceId','clientGeneration','clientSequence','predecessorCommandId','expectedRevision','basis','shiftRef','tappedAt','clockCheckedAt','clockSkewMs','intent','expectedAllocationId','boundaryMode']);
  prior_allocation:=public._work_activity_uuid(p_payload->'expectedAllocationId',true);
  if p_payload->>'boundaryMode' is distinct from 'trusted_original_tap' then raise exception using errcode='23514',message='Unsupported boundary mode.';end if;
  payload:=public._work_activity_payload(p_payload-'expectedAllocationId'-'boundaryMode')||jsonb_build_object('expectedAllocationId',prior_allocation,'boundaryMode','trusted_original_tap');
 else payload:=public._work_activity_payload(p_payload);end if;hash:=encode(sha256(convert_to(payload::text,'UTF8')),'hex');
 select * into prior from public.personal_activity_commands where command_id=p_command_id;
 if prior.command_id is not null then
   if prior.actor_id is distinct from actor or prior.subject_profile_id is distinct from actor or prior.protocol_version is distinct from p_protocol_version
    or prior.payload_hash is distinct from hash or prior.normalized_payload is distinct from payload then
     return jsonb_build_object('protocolVersion',p_protocol_version,'availability','unavailable','receipt',null);
   end if;
   if p_protocol_version=2 and not public._work_cross_job_scope((prior.normalized_payload#>>'{shiftRef,id}')::uuid,actor) then return jsonb_build_object('protocolVersion',2,'availability','unavailable','receipt',null);end if;
   return jsonb_build_object('protocolVersion',p_protocol_version,'availability','available','receipt',prior.result);
 end if;
 -- G is first. Configuration/source authority is read again after its domain
 -- lock; no before-wait account or menu decision is reused.
 perform pg_advisory_xact_lock(7710,0);actor:=public._work_activity_actor();arrival:=clock_timestamp();
 device:=(payload->>'deviceId')::uuid;generation:=(payload->>'clientGeneration')::uuid;
 expected:=(payload->>'expectedRevision')::bigint;sequence_number:=(payload->>'clientSequence')::bigint;
 predecessor:=(payload->>'predecessorCommandId')::uuid;intent:=payload->'intent';kind:=intent->>'kind';
 if exists(select 1 from public.personal_activity_commands where actor_id=actor and device_id=device and client_generation=generation and client_sequence=sequence_number) then
   return jsonb_build_object('protocolVersion',p_protocol_version,'availability','unavailable','receipt',null);
 end if;
 select * into s from public.personal_activity_state where profile_id=actor for update;
 if s.profile_id is null then s:=public._work_activity_refresh_state(actor);end if;
 cross_job:=exists(select 1 from public.work_cross_job_shifts where shift_id=s.shift_id);
 if cross_job is distinct from (p_protocol_version=2) then return jsonb_build_object('protocolVersion',p_protocol_version,'availability','unavailable','receipt',null);end if;
 if cross_job and not public._work_cross_job_scope(s.shift_id,actor) then return jsonb_build_object('protocolVersion',2,'availability','unavailable','receipt',null);end if;
 select allocation_id into allocation from public.work_cross_job_heads where shift_id=s.shift_id;
 select * into obs from public.work_activity_observations where id=(payload#>>'{basis,observationId}')::uuid and actor_id=actor and device_id=device;
 select * into stream from public.work_activity_streams where actor_id=actor and device_id=device and status in ('active','blocked') for update;
 select capture_enabled into enabled from public.work_activity_authority_generation where singleton;
 -- Permission comes before any referenced source's eligibility/revision reason.
 if kind='switch' then source_reason:=public._work_activity_validate_switch(intent,actor);
 elsif kind='finish_setup' and not public._ai_job_visible((intent->>'projectId')::uuid,actor) then source_reason:='source_unavailable';end if;
 if source_reason='source_unavailable' then v_status:='refused';reason:=source_reason;
 elsif s.integrity_state<>'clean' or s.revision>=9007199254740991 or exists(select 1 from public.work_activity_safety_events where profile_id=actor) then
   v_status:='refused';reason:='reconciliation_required';
 elsif obs.id is null then v_status:='refused';reason:='observation_unavailable';
 elsif kind<>'stop' and obs.expires_at<=arrival then v_status:='refused';reason:='observation_expired';
 elsif kind<>'stop' and (obs.authority_revision is distinct from public._work_activity_authority_revision() or obs.authority_revision>=9007199254740991) then
   v_status:='conflict';reason:='state_changed';
 elsif s.revision<>expected then v_status:='conflict';reason:='state_changed';end if;
 if cross_job and allocation is distinct from prior_allocation and reason is null then v_status:='conflict';reason:='state_changed';end if;
 if kind='establish_stream' then
   if reason is null and (obs.revision<>expected or obs.last_transition_id is distinct from s.last_transition_id
     or obs.shift_id is distinct from s.shift_id or obs.shift_id is distinct from (payload#>>'{shiftRef,id}')::uuid) then
     v_status:='conflict';reason:='state_changed';
   elsif reason is null and (stream.client_generation is distinct from (intent->>'previousGeneration')::uuid
     or stream.head_command_id is distinct from (intent->>'previousHeadCommandId')::uuid
     or obs.current_generation is distinct from (intent->>'previousGeneration')::uuid
     or obs.current_head_command_id is distinct from (intent->>'previousHeadCommandId')::uuid
     or exists(select 1 from public.work_activity_streams where actor_id=actor and device_id=device and client_generation=generation)) then
     v_status:='conflict';reason:='stream_changed';
   end if;
 else
   select * into head from public.personal_activity_commands where command_id=predecessor and actor_id=actor and device_id=device and client_generation=generation;
   admitted:=stream.id is not null and stream.status='active' and stream.client_generation=generation and stream.head_sequence<9007199254740991
     and sequence_number=stream.head_sequence+1 and predecessor=stream.head_command_id and head.status in ('applied','noop');
   if reason is null and not admitted then v_status:='conflict';reason:='stream_changed';end if;
   if payload#>>'{shiftRef,kind}'='clock_command' then
     select * into clock_action from public.time_clock_actions where client_id=(payload#>>'{shiftRef,id}')::uuid and profile_id=actor and action='clock_in';
     select * into h from public.time_shifts where id=clock_action.shift_id and profile_id=actor for update;
     select * into clock_transition from public.personal_activity_transitions where id=s.last_transition_id and profile_id=actor
      and cause='clock_in' and source_request_id=clock_action.client_id and source_shift_id=h.id;
     clock_bridge:=obs.shift_id is null and obs.revision=head.after_revision and obs.last_transition_id is not distinct from
       (select id from public.personal_activity_transitions where profile_id=actor and revision_after=obs.revision)
       and clock_transition.revision_before=obs.revision and clock_transition.revision_after=expected
       and clock_transition.id is not null and head.after_revision+1=expected;
   else select * into h from public.time_shifts where id=(payload#>>'{shiftRef,id}')::uuid and profile_id=actor for update;end if;
   if reason is null and (h.id is null or h.id is distinct from s.shift_id or h.status<>'open' or h.clock_out_at is not null) then v_status:='refused';reason:='shift_unavailable';end if;
   if reason is null and h.break_started_at is not null then v_status:='refused';reason:='on_break';end if;
   if reason is null and head.after_revision<>expected and not coalesce(clock_bridge,false) then v_status:='conflict';reason:='state_changed';end if;
   if stream.id is not null then select * into anchor from public.work_activity_observations where id=stream.anchor_observation_id;end if;
   observation_lineage:=obs.id=stream.anchor_observation_id or (obs.current_generation=generation and exists(
     select 1 from public.personal_activity_commands c where c.command_id=obs.current_head_command_id and c.actor_id=actor and c.device_id=device
       and c.client_generation=generation and c.client_sequence<=head.client_sequence and c.status in ('applied','noop') and c.after_revision=obs.revision));
   if reason is null and (not coalesce(observation_lineage,false) or obs.revision>expected or obs.revision<anchor.revision
     or (not coalesce(clock_bridge,false) and (obs.shift_id is distinct from h.id or obs.shift_clock_in_at is distinct from h.clock_in_at))) then
     v_status:='conflict';reason:='state_changed';end if;
   if reason is null and kind<>'stop' and (not enabled or h.clock_in_at+make_interval(hours=>public.shift_cap_hours())<=arrival) then
     v_status:='refused';reason:=case when not enabled then 'starts_disabled' else 'observation_expired' end;end if;
   if reason is null and source_reason is not null then v_status:='conflict';reason:=source_reason;end if;
   if reason is null and kind='switch' and ((not cross_job and (intent->>'projectId')::uuid is distinct from h.project_id) or s.active_source_kind='setup') then
     v_status:='refused';reason:='shift_unavailable';end if;
   if reason is null and kind='finish_setup' then
     if s.active_source_kind is distinct from 'setup' then v_status:='conflict';reason:='state_changed';
     elsif intent->>'costCodeId' is not null and not exists(select 1 from public.cost_codes where id=(intent->>'costCodeId')::uuid) then
       v_status:='refused';reason:='source_unavailable';end if;
   end if;
   if reason is null and kind in ('switch','finish_setup') and not public._toolbox_signed_today(actor) then v_status:='refused';reason:='toolbox_required';end if;
   if reason is null then
     select greatest(h.clock_in_at,h.last_punch_at,s.effective_since,(select selected_effective_at from public.personal_activity_transitions where id=s.last_transition_id),(select effective_at from public.work_cross_job_allocations where id=allocation)) into not_before;
     pick:=public._clock_pick_time_at((payload->>'tappedAt')::timestamptz,(payload->>'clockCheckedAt')::timestamptz,(payload->>'clockSkewMs')::integer,not_before,arrival);
     if pick.pay_at is null or pick.reason in ('tap_out_of_order','tap_too_old') or (cross_job and not pick.used_tap) then v_status:='refused';reason:='time_out_of_order';else selected_at:=pick.pay_at;end if;
   end if;
   if reason is null and not(kind='stop' and s.active_source_id is null) then
     -- Only the expected legacy business refusal is converted. Integrity,
     -- schema, timeout and deadlock exceptions roll back the entire command.
     begin
       nested_request:=case when kind='switch' then gen_random_uuid() end;
       operation:=public._work_activity_operation_enter('work_activity_command',jsonb_build_object('kind',kind),nested_request,p_command_id);
       if operation is null then raise exception using errcode='23514',message='Activity command cannot nest in another source operation.';end if;
       person:=public._work_activity_touch(actor);
       perform public._work_activity_close_all(actor,selected_at,case when kind='switch' then 'switch' else 'stop' end);
       if cross_job and kind in('switch','finish_setup') then
        allocation:=p_command_id;
        insert into public.work_cross_job_allocations(id,shift_id,profile_id,predecessor_id,event_kind,project_id,cost_code_id,original_tapped_at,clock_checked_at,clock_skew_ms,admitted_at,effective_at,boundary_mode,command_id,transition_id,authority_revision,source_generation)
        values(allocation,h.id,actor,prior_allocation,case when prior_allocation is null then 'initial' else 'handoff' end,(intent->>'projectId')::uuid,case when kind='finish_setup' then (intent->>'costCodeId')::uuid end,
        (payload->>'tappedAt')::timestamptz,(payload->>'clockCheckedAt')::timestamptz,(payload->>'clockSkewMs')::integer,arrival,selected_at,'trusted_original_tap',p_command_id,person.transition_id,public._work_activity_authority_revision(),2);
        insert into public.work_cross_job_heads values(h.id,allocation) on conflict(shift_id) do update set allocation_id=excluded.allocation_id;
       end if;
       if kind='switch' and cross_job then
        session_id:=public._work_cross_job_custom(actor,h,allocation,intent,selected_at,'switch');
       elsif kind='switch' then
         select * into definition from public.work_activity_definition_versions where id=(intent->>'definitionVersionId')::uuid;
         session_id:=gen_random_uuid();frame:=public._work_activity_context_for(actor,'switch',selected_at);
         -- Classic's stage is a bounded display projection (100 characters).
         -- Preserve the complete published label in description and the exact
         -- immutable definition version in private metadata; identity never
         -- depends on this shortened legacy display.
         perform public.custom_work_command(nested_request,'start',jsonb_build_object('id',session_id,'shift_id',h.id,'unit_id',intent#>'{unit,id}',
           'expected_session_id',null,'at',selected_at,'participation','install','stage',left(definition.label_en,100),'description',definition.label_en));
         perform public._work_activity_context_close(frame);
         if intent->>'scope'='specific' then unit_basis:=public._work_activity_command_basis(public._work_activity_unit_basis((intent#>>'{unit,id}')::uuid,actor));end if;
         insert into public.work_session_capture_metadata(session_id,profile_id,project_id,definition_version_id,menu_version_id,scope,unit_id,fact_revision,unit_facts,machine_kind,
           selection_id,selection_revision,answers,unit_basis,continuation_unit_basis)
         values(session_id,actor,(intent->>'projectId')::uuid,definition.id,(intent->>'menuVersionId')::uuid,intent->>'scope',(intent#>>'{unit,id}')::uuid,
           (intent#>>'{unit,factRevision}')::bigint,case when intent->>'scope'='specific' then public._work_activity_fact_snapshot((intent#>>'{unit,id}')::uuid) end,
           intent->>'machineKind',(intent->>'selectionId')::uuid,(intent->>'selectionRevision')::bigint,intent->'values',nullif(intent->'unit','null'::jsonb),unit_basis);
       elsif kind='finish_setup' and not cross_job then
         before_shift:=public._work_activity_evidence('time_shifts',to_jsonb(h));
         after_shift:=before_shift||jsonb_build_object('project_id',intent->'projectId','cost_code_id',intent->'costCodeId');
         frame:=public._work_activity_context_for(actor,'stop',selected_at);
         perform public._work_activity_expect(frame,'public.time_shifts'::regclass,'UPDATE',h.id,array['project_id','cost_code_id'],before_shift,after_shift);
         update public.time_shifts set project_id=(intent->>'projectId')::uuid,cost_code_id=(intent->>'costCodeId')::uuid where id=h.id;
         perform public._work_activity_context_close(frame);
       end if;
       perform public._work_activity_operation_exit(operation);
       select * into after_s from public.personal_activity_state where profile_id=actor;
       if after_s.revision is distinct from s.revision+1 or after_s.last_transition_id is distinct from person.transition_id then
         raise exception using errcode='23514',message='Activity command lacks its one actual transition.';end if;
       v_status:='applied';
     exception when raise_exception then v_status:='refused';reason:='reconciliation_required';selected_at:=null;person.transition_id:=null;
     end;
   end if;
 end if;
 result:=jsonb_build_object('protocolVersion',p_protocol_version,'commandId',p_command_id,'status',v_status,'reasonCode',reason,
   'beforeRevision',s.revision,'afterRevision',case when v_status='applied' then after_s.revision else s.revision end,
   'transitionId',case when v_status='applied' then person.transition_id end,'effectiveAt',case when v_status='applied' then public._work_activity_iso(selected_at) end);
 insert into public.personal_activity_commands(command_id,actor_id,subject_profile_id,protocol_version,normalized_payload,payload_hash,received_at,
   device_id,client_generation,client_sequence,predecessor_command_id,expected_revision,status,reason_code,before_revision,after_revision,transition_id,effective_at,result)
 values(p_command_id,actor,actor,p_protocol_version,payload,hash,arrival,device,generation,sequence_number,predecessor,expected,v_status,reason,s.revision,
   case when v_status='applied' then after_s.revision else s.revision end,case when v_status='applied' then person.transition_id end,case when v_status='applied' then selected_at end,result);
 if kind='establish_stream' and v_status='noop' then
   if stream.id is not null then update public.work_activity_streams set status='retired',retired_at=clock_timestamp() where id=stream.id;end if;
   insert into public.work_activity_streams(actor_id,device_id,client_generation,head_sequence,head_command_id,anchor_observation_id,status)
   values(actor,device,generation,0,p_command_id,obs.id,'active');
 elsif kind<>'establish_stream' and admitted then
   update public.work_activity_streams set head_command_id=p_command_id,head_sequence=sequence_number,status=case when v_status in ('applied','noop') then 'active' else 'blocked' end where id=stream.id;
 end if;
 return jsonb_build_object('protocolVersion',p_protocol_version,'availability','available','receipt',result);
end; $$;

create or replace function public.work_activity_snapshot(p_device_id uuid) returns jsonb
language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare actor uuid; s public.personal_activity_state; h public.time_shifts; stream public.work_activity_streams; observation public.work_activity_observations;
 result jsonb; state_view jsonb; stream_view jsonb; observation_view jsonb; shift_view jsonb; enabled boolean; ready boolean; personal_status text; state_actions jsonb; as_of timestamptz;
begin
 perform public._work_activity_read_committed();
 perform public._work_activity_gate();actor:=public._work_activity_actor();
 if p_device_id is null then raise exception using errcode='23514',message='A device identity is required.';end if;
 perform pg_advisory_xact_lock(7710,0);actor:=public._work_activity_actor();as_of:=clock_timestamp();
 if exists(select 1 from public.work_activity_safety_events where profile_id=actor) then
   return jsonb_build_object('protocolVersion',1,'asOf',public._work_activity_iso(as_of),'deviceId',p_device_id,
     'capability',jsonb_build_object('mode','unavailable','reasonCode','not_ready'),'observation',null,'stream',null,'state',null);
 end if;
 select capture_enabled into enabled from public.work_activity_authority_generation where singleton;
 select * into s from public.personal_activity_state where profile_id=actor;
 if s.profile_id is null then s:=public._work_activity_refresh_state(actor);end if;
 select * into h from public.time_shifts where id=s.shift_id and profile_id=actor and status='open' and clock_out_at is null;
 ready:=s.integrity_state='clean' and s.revision<9007199254740991 and ((s.shift_id is null and not exists(select 1 from public._work_activity_live_sources(actor)))
   or (h.id is not null and isfinite(h.clock_in_at) and h.clock_in_at<=as_of and h.clock_in_at+make_interval(hours=>public.shift_cap_hours())>as_of));
 if ready then observation:=public._work_activity_observe(p_device_id);end if;
 select * into stream from public.work_activity_streams where actor_id=actor and device_id=p_device_id and status in ('active','blocked');
 if stream.id is not null then stream_view:=jsonb_build_object('clientGeneration',stream.client_generation,'headSequence',stream.head_sequence,'headCommandId',stream.head_command_id,
  'headAfterRevision',(select after_revision from public.personal_activity_commands where command_id=stream.head_command_id),'status',stream.status);end if;
 if observation.id is not null then observation_view:=jsonb_build_object('id',observation.id,'revision',observation.revision,'lastTransitionId',observation.last_transition_id,
  'issuedAt',public._work_activity_iso(observation.issued_at),'expiresAt',public._work_activity_iso(observation.expires_at),
  'shiftRef',case when observation.shift_id is not null then jsonb_build_object('kind','shift','id',observation.shift_id) end,
  'currentGeneration',observation.current_generation,'currentHeadCommandId',observation.current_head_command_id);end if;
 if exists(select 1 from public.work_cross_job_shifts where shift_id=h.id) then return jsonb_build_object('protocolVersion',1,'asOf',public._work_activity_iso(as_of),'deviceId',p_device_id,'capability',jsonb_build_object('mode','unavailable','reasonCode','not_ready'),'observation',null,'stream',null,'state',null);end if;
 if h.id is not null then shift_view:=jsonb_build_object('id',h.id,'clockInCommandId',h.client_id,'clockInAt',public._work_activity_iso(h.clock_in_at),
  'breakStartedAt',public._work_activity_iso(h.break_started_at),'breakType',h.break_type,'status','open','project',public._work_activity_project_view(h.project_id,actor));end if;
 personal_status:=case when s.integrity_state<>'clean' then 'review' when h.id is null then 'off_clock' when h.break_started_at is not null then 'on_break'
  when s.active_source_kind='setup' then 'setup' when s.active_source_id is not null then 'running' else 'unclassified' end;
 state_actions:=jsonb_build_object('canEstablishStream',ready,'canSwitch',ready and enabled and h.id is not null and h.break_started_at is null and s.active_source_kind is distinct from 'setup',
  'canFinishSetup',coalesce(ready and enabled and h.id is not null and h.break_started_at is null and s.active_source_kind='setup',false),
  'canStop',ready and h.id is not null and h.break_started_at is null and s.active_source_id is not null);
 state_view:=jsonb_build_object('revision',s.revision,'lastTransitionId',s.last_transition_id,'integrity',s.integrity_state,'status',personal_status,'choiceRequired',s.choice_required,
  'actions',state_actions,'shift',shift_view,'activity',case when h.id is not null and h.break_started_at is null then public._work_activity_source_view(s) end);
 result:=jsonb_build_object('protocolVersion',1,'asOf',public._work_activity_iso(as_of),'deviceId',p_device_id,
  'capability',jsonb_build_object('mode',case when enabled then 'active' else 'closing_only' end,'reasonCode',case when not enabled then 'starts_disabled' end),
  'observation',observation_view,'stream',stream_view,'state',state_view);
 if octet_length(result::text)>100000 then raise exception using errcode='54000',message='Activity projection is too large.';end if;
 return result;
end; $$;

create or replace function public.work_cross_job_snapshot(p_device_id uuid) returns jsonb
language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare actor uuid; s public.personal_activity_state; h public.time_shifts; stream public.work_activity_streams; observation public.work_activity_observations;
 result jsonb; state_view jsonb; stream_view jsonb; observation_view jsonb; shift_view jsonb; enabled boolean; ready boolean; personal_status text; state_actions jsonb; as_of timestamptz;
begin
 perform public._work_activity_read_committed();
 perform public._work_activity_gate();actor:=public._work_activity_actor();
 if p_device_id is null then raise exception using errcode='23514',message='A device identity is required.';end if;
 perform pg_advisory_xact_lock(7710,0);actor:=public._work_activity_actor();as_of:=clock_timestamp();
 if exists(select 1 from public.work_activity_safety_events where profile_id=actor) then
   return jsonb_build_object('protocolVersion',2,'asOf',public._work_activity_iso(as_of),'deviceId',p_device_id,
     'capability',jsonb_build_object('mode','unavailable','reasonCode','not_ready'),'observation',null,'stream',null,'state',null);
 end if;
 select capture_enabled into enabled from public.work_activity_authority_generation where singleton;
 select * into s from public.personal_activity_state where profile_id=actor;
 if s.profile_id is null then s:=public._work_activity_refresh_state(actor);end if;
 select * into h from public.time_shifts where id=s.shift_id and profile_id=actor and status='open' and clock_out_at is null;
 ready:=s.integrity_state='clean' and s.revision<9007199254740991 and ((s.shift_id is null and not exists(select 1 from public._work_activity_live_sources(actor)))
   or (h.id is not null and isfinite(h.clock_in_at) and h.clock_in_at<=as_of and h.clock_in_at+make_interval(hours=>public.shift_cap_hours())>as_of));
 if ready then observation:=public._work_activity_observe(p_device_id);end if;
 select * into stream from public.work_activity_streams where actor_id=actor and device_id=p_device_id and status in ('active','blocked');
 if stream.id is not null then stream_view:=jsonb_build_object('clientGeneration',stream.client_generation,'headSequence',stream.head_sequence,'headCommandId',stream.head_command_id,
  'headAfterRevision',(select after_revision from public.personal_activity_commands where command_id=stream.head_command_id),'status',stream.status);end if;
 if observation.id is not null then observation_view:=jsonb_build_object('id',observation.id,'revision',observation.revision,'lastTransitionId',observation.last_transition_id,
  'issuedAt',public._work_activity_iso(observation.issued_at),'expiresAt',public._work_activity_iso(observation.expires_at),
  'shiftRef',case when observation.shift_id is not null then jsonb_build_object('kind','shift','id',observation.shift_id) end,
  'currentGeneration',observation.current_generation,'currentHeadCommandId',observation.current_head_command_id);end if;
 if not public._work_cross_job_enabled() or not (coalesce((select p.prosrc is not null and encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')='bbebab5cc374c8233ba85a865428db4ac38ed8e0c4bf8b295edf645bb4d8e074' and pg_get_userbyid(p.proowner)='postgres' and p.proacl::text='{postgres=X/postgres}' and p.prosecdef and p.proconfig=array['search_path=public, pg_temp']::text[] and p.provolatile='s' and not p.proisstrict and not p.proleakproof and p.proparallel='u' and p.prokind='f' and not p.proretset and p.prorettype='boolean'::regtype and p.pronargs=0 and p.pronargdefaults=0 and p.procost=100 and p.prorows=0 and p.prosupport=0 and p.prolang=(select oid from pg_language where lanname='sql') from pg_proc p where p.oid=to_regprocedure('public._work_cross_job_coverage()')),false) and public._work_cross_job_coverage()) or not public._work_cross_job_scope(h.id,actor) then return jsonb_build_object('protocolVersion',2,'availability','unavailable','state',null);end if;
 if h.id is not null then shift_view:=jsonb_build_object('id',h.id,'clockInCommandId',h.client_id,'clockInAt',public._work_activity_iso(h.clock_in_at),
  'breakStartedAt',public._work_activity_iso(h.break_started_at),'breakType',h.break_type,'status','open','project',public._work_activity_project_view((select a.project_id from public.work_cross_job_heads x join public.work_cross_job_allocations a on a.id=x.allocation_id where x.shift_id=h.id),actor),'allocationId',(select allocation_id from public.work_cross_job_heads where shift_id=h.id));end if;
 personal_status:=case when s.integrity_state<>'clean' then 'review' when h.id is null then 'off_clock' when h.break_started_at is not null then 'on_break'
  when s.active_source_kind='setup' then 'setup' when s.active_source_id is not null then 'running' else 'unclassified' end;
 state_actions:=jsonb_build_object('canEstablishStream',ready,'canSwitch',ready and enabled and h.id is not null and h.break_started_at is null and s.active_source_kind is distinct from 'setup',
  'canFinishSetup',coalesce(ready and enabled and h.id is not null and h.break_started_at is null and s.active_source_kind='setup',false),
  'canStop',ready and h.id is not null and h.break_started_at is null and s.active_source_id is not null);
 state_view:=jsonb_build_object('revision',s.revision,'lastTransitionId',s.last_transition_id,'integrity',s.integrity_state,'status',personal_status,'choiceRequired',s.choice_required,
  'actions',state_actions,'shift',shift_view,'activity',case when h.id is not null and h.break_started_at is null then public._work_activity_source_view(s) end);
 result:=jsonb_build_object('protocolVersion',2,'asOf',public._work_activity_iso(as_of),'deviceId',p_device_id,
  'capability',jsonb_build_object('mode',case when enabled then 'active' else 'closing_only' end,'reasonCode',case when not enabled then 'starts_disabled' end),
  'observation',observation_view,'stream',stream_view,'state',state_view);
 if octet_length(result::text)>100000 then raise exception using errcode='54000',message='Activity projection is too large.';end if;
 return result;
end; $$;

create or replace function public.work_activity_command_receipt(p_command_id uuid) returns jsonb
language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare actor uuid; receipt jsonb;
begin
 perform public._work_activity_read_committed();
 perform public._work_activity_gate();actor:=public._work_activity_actor();
 if p_command_id is null then raise exception using errcode='23514',message='A command identity is required.';end if;
 select result into receipt from public.personal_activity_commands where command_id=p_command_id and actor_id=actor and subject_profile_id=actor and protocol_version=1;
 return jsonb_build_object('protocolVersion',1,'availability',case when receipt is null then 'unavailable' else 'available' end,'receipt',receipt);
end; $$;

create function public.work_cross_job_receipt(p_command_id uuid) returns jsonb language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare actor uuid;c public.personal_activity_commands;a public.work_cross_job_allocations;
begin
 perform public._work_activity_read_committed();perform public._work_activity_gate();perform pg_advisory_xact_lock(7710,0);actor:=public._work_activity_actor();
 select * into c from public.personal_activity_commands where command_id=p_command_id and actor_id=actor and subject_profile_id=actor and protocol_version=2;
 if c.command_id is null or not public._work_cross_job_enabled() or not (coalesce((select p.prosrc is not null and encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')='bbebab5cc374c8233ba85a865428db4ac38ed8e0c4bf8b295edf645bb4d8e074' and pg_get_userbyid(p.proowner)='postgres' and p.proacl::text='{postgres=X/postgres}' and p.prosecdef and p.proconfig=array['search_path=public, pg_temp']::text[] and p.provolatile='s' and not p.proisstrict and not p.proleakproof and p.proparallel='u' and p.prokind='f' and not p.proretset and p.prorettype='boolean'::regtype and p.pronargs=0 and p.pronargdefaults=0 and p.procost=100 and p.prorows=0 and p.prosupport=0 and p.prolang=(select oid from pg_language where lanname='sql') from pg_proc p where p.oid=to_regprocedure('public._work_cross_job_coverage()')),false) and public._work_cross_job_coverage()) or not public._work_cross_job_scope((c.normalized_payload#>>'{shiftRef,id}')::uuid,actor) then return jsonb_build_object('protocolVersion',2,'availability','unavailable','receipt',null,'allocation',null);end if;
 select * into a from public.work_cross_job_allocations where command_id=c.command_id;
 return jsonb_build_object('protocolVersion',2,'availability','available','receipt',c.result,'allocation',case when a.id is not null then jsonb_build_object('id',a.id,'predecessorId',a.predecessor_id,'boundaryMode',a.boundary_mode,'originalTappedAt',public._work_activity_iso(a.original_tapped_at),'effectiveAt',public._work_activity_iso(a.effective_at),'shiftId',a.shift_id,'transitionId',a.transition_id) end);
end$$;

create or replace function public._work_activity_clock_replay_guard(p_client uuid,p_action text,p_shift uuid default null) returns void
language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare r public.work_activity_clock_receipts;o public.work_activity_operations;v record;
begin
 if p_client is null then return;end if;
 o:=public._work_activity_operation();
 if o.id is null or o.actor_id is null or o.actor_id is distinct from auth.uid() then raise exception using errcode='42501',message='Clock receipt unavailable.';end if;
 select * into r from public.work_activity_clock_receipts where client_id=p_client;
 if r.client_id is null then
  if p_action='clock_in' and o.route in('clock_in','clock_in_setup') then
   if exists(select 1 from public.work_cross_job_clock_requests where client_id=p_client)
    or exists(select 1 from public.time_clock_actions where client_id=p_client and profile_id is distinct from o.actor_id)
    or exists(select 1 from public.time_shifts where client_id=p_client and profile_id is distinct from o.actor_id) then
    raise exception using errcode='42501',message='Clock receipt unavailable.';
   end if;
   if o.route='clock_in_setup' and o.arguments->>'setupVersion'='2'
    and (exists(select 1 from public.time_clock_actions where client_id=p_client and profile_id=o.actor_id)
      or exists(select 1 from public.time_shifts where client_id=p_client and profile_id=o.actor_id)) then
    raise exception using errcode='23514',message='Clock command identity conflicts.';
   end if;
  end if;
  return;
 end if;
 if r.profile_id is distinct from o.actor_id then raise exception using errcode='42501',message='Clock receipt unavailable.';end if;
 if r.action is distinct from p_action or (p_shift is not null and r.shift_id is distinct from p_shift) then raise exception using errcode='23514',message='Clock command identity conflicts.';end if;
 if o.route='clock_in_setup' and (r.receipt_protocol<>'setup_v1' or r.setup_payload_digest is distinct from o.arguments->>'clockPayloadDigest') then
   raise exception using errcode='23514',message='Clock command identity conflicts.';end if;
 if p_action='clock_in' and o.route in('clock_in','clock_in_setup') then
  select * into v from public.work_cross_job_clock_requests where client_id=r.client_id;
  if v.client_id is not null and (v.profile_id is distinct from r.profile_id or v.shift_id is distinct from r.shift_id or v.receipt_sha256 is distinct from public._work_cross_job_clock_receipt_fingerprint(r)) then raise exception using errcode='42501',message='Clock receipt unavailable.';end if;
  if (o.route='clock_in_setup' and coalesce(o.arguments->>'setupVersion','')='2') is distinct from coalesce(v.setup_version=2,false) then
   raise exception using errcode='23514',message='Clock command identity conflicts.';
  end if;
 end if;
 -- A retained acknowledgement survives source deletion. Never reapply the
 -- original command after its mutable/cascading legacy lookup disappeared.
 if not exists(select 1 from public.time_clock_actions where client_id=r.client_id and profile_id=r.profile_id and shift_id=r.shift_id and action=r.action)
    or not exists(select 1 from public.time_shifts where id=r.shift_id and profile_id=r.profile_id) then
   raise exception using errcode='42501',message='Clock receipt unavailable.';
 end if;
end; $$;

create or replace function public.work_activity_clock_receipt(p_client_id uuid) returns jsonb
language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare actor uuid;r record;t record;retention text;protocol text;present boolean;
 missing constant jsonb:='{"protocolVersion":1,"availability":"unavailable","receipt":null}'::jsonb;
begin
 perform public._work_activity_read_committed();perform public._work_activity_gate();actor:=public._work_activity_actor();
 if p_client_id is null then raise exception using errcode='23514',message='A clock command identity is required.';end if;
 select x.client_id,x.profile_id,x.shift_id,x.action,x.outcome,x.tapped_at,x.arrived_at,x.clock_checked_at,x.clock_skew_ms,x.used_tap_time,x.review_reason,x.receipt_protocol
 into r from public.work_activity_clock_receipts x where x.client_id=p_client_id and x.profile_id=actor;
 if found then retention:='retained';protocol:=r.receipt_protocol;
 else
  select x.client_id,x.profile_id,x.shift_id,x.action,x.outcome,x.tapped_at,x.arrived_at,x.clock_checked_at,x.clock_skew_ms,x.used_tap_time,x.review_reason,'legacy'::text receipt_protocol
  into r from public.time_clock_actions x where x.client_id=p_client_id and x.profile_id=actor;
  if not found then return missing;end if;retention:='legacy';protocol:='legacy';
 end if;
 if r.action='clock_in' and r.receipt_protocol='setup_v1'
  and exists(select 1 from public.work_cross_job_shifts where shift_id=r.shift_id) then return missing;end if;
 -- Unsupported historical evidence remains unavailable rather than coercing
 -- a nonfinite time or an unknown disposition into a truthful completion.
 if (r.review_reason is not null and length(r.review_reason)>80) or not isfinite(r.arrived_at) or (r.tapped_at is not null and not isfinite(r.tapped_at))
   or (r.clock_checked_at is not null and not isfinite(r.clock_checked_at))
   or r.outcome<>all(case r.action when 'clock_in' then array['clocked_in'] when 'clock_out' then array['clocked_out','requires_review']
      when 'break_start' then array['started','already_on_break','requires_review'] when 'break_end' then array['ended','no_break_running','shift_closed','requires_review'] else array[]::text[] end)
 then return missing;end if;
 select x.id,x.revision_before,x.revision_after into t from public.personal_activity_transitions x
 where x.profile_id=actor and x.source_request_id=p_client_id and x.actor_id=actor and x.source_shift_id=r.shift_id;
 present:=exists(select 1 from public.time_shifts where id=r.shift_id and profile_id=actor)
   and exists(select 1 from public.time_clock_actions where client_id=p_client_id and profile_id=actor and shift_id=r.shift_id);
 return jsonb_build_object('protocolVersion',1,'availability','available','receipt',jsonb_build_object(
  'clientId',r.client_id,'action',r.action,'outcome',r.outcome,'shiftId',r.shift_id,'tappedAt',public._work_activity_iso(r.tapped_at),
  'arrivedAt',public._work_activity_iso(r.arrived_at),'clockCheckedAt',public._work_activity_iso(r.clock_checked_at),'clockSkewMs',r.clock_skew_ms,
  'usedTapTime',r.used_tap_time,'reviewReason',r.review_reason,'receiptProtocol',protocol,'retention',retention,'sourcePresent',present,
  'activityTransition',case when t.id is not null then jsonb_build_object('id',t.id,'beforeRevision',t.revision_before,'afterRevision',t.revision_after) else 'null'::jsonb end));
end; $$;

create or replace function public._work_activity_clock_contract_marker() returns text
language sql immutable security definer set search_path=public,pg_temp as $marker$
 select '2ac3aad6d095d5bf9584bb656ce7123392884b946b0df46e2c6d84beeba3d32a'::text
$marker$;

create or replace function public.work_activity_clock_capability() returns jsonb
language plpgsql volatile security definer set search_path=public,pg_temp as $capability$
declare actor uuid;as_of timestamptz;enabled boolean;generation bigint;s public.personal_activity_state;
 mode text;reason text;author_setup boolean:=false;e jsonb;actual jsonb;
begin
 perform public._work_activity_read_committed();
 perform public._work_activity_gate();actor:=public._work_activity_actor();as_of:=clock_timestamp();
 if not coalesce((select p.prosrc is not null and encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')='3f4d03d090a1428ce0dd8b410a285029903d156576da41a86237daa30e0e1d25' and pg_get_userbyid(p.proowner)='postgres' and p.proacl::text='{postgres=X/postgres}' and p.prosecdef and p.proconfig=array['search_path=public, pg_temp']::text[] and p.provolatile='i' and p.proisstrict and not p.proleakproof and p.proparallel='u' and p.prokind='f' and not p.proretset and p.prorettype='text'::regtype and p.pronargs=1 and p.pronargdefaults=0 and p.procost=100 and p.prorows=0 and p.prosupport=0 and p.prolang=(select oid from pg_language where lanname='sql') from pg_proc p where p.oid=to_regprocedure('public._work_cross_job_clock_receipt_fingerprint(public.work_activity_clock_receipts)')),false) or not coalesce((select p.prosrc is not null and encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')='c3a7df2b8818e95a0962e6a6a2e87de398371a5e4d2a8812044324d001debd66' and pg_get_userbyid(p.proowner)='postgres' and p.proacl::text='{postgres=X/postgres}' and p.prosecdef and p.proconfig=array['search_path=public, pg_temp']::text[] and p.provolatile='i' and not p.proisstrict and not p.proleakproof and p.proparallel='u' and p.prokind='f' and not p.proretset and p.prorettype='text'::regtype and p.pronargs=0 and p.pronargdefaults=0 and p.procost=100 and p.prorows=0 and p.prosupport=0 and p.prolang=(select oid from pg_language where lanname='sql') from pg_proc p where p.oid=to_regprocedure('public._work_activity_clock_contract_marker()')),false) or public._work_activity_clock_contract_marker() is distinct from '2ac3aad6d095d5bf9584bb656ce7123392884b946b0df46e2c6d84beeba3d32a' then
 raise exception using errcode='55000',message='Clock protocol is unavailable.';end if;
 -- Bounded cheap runtime drift check, after caller permission. The complete
 -- installation contract above covers every transformed entry and callback.
 for e in select value from jsonb_array_elements($protocol$[{"name":"_toolbox_gate_open","args":"p_uid uuid","value":{"anon":false,"body":"ed3ecd2fafe012b9cd7a03da6dea485e29f20d591b9dd13960d7d37088f92f8f","kind":"f","owner":"postgres","config":["search_path=public, pg_temp"],"public":false,"definer":false,"returns":"boolean","language":"sql","volatility":"s","authenticated":true}},{"name":"_toolbox_signed_today","args":"p_uid uuid","value":{"anon":false,"body":"c6afbff1f69461549975380dfcc9dd3c8b345df37affa2359f087aa16d1b4ca0","kind":"f","owner":"postgres","config":["search_path=public, pg_temp"],"public":false,"definer":false,"returns":"boolean","language":"sql","volatility":"s","authenticated":true}},{"name":"_work_activity_actor","args":"","value":{"anon":false,"body":"7890c48b8af43f142610895f8da5d8361178470db58d384bf1ff2f48c52f8122","kind":"f","owner":"postgres","config":["search_path=public, pg_temp"],"public":false,"definer":true,"returns":"uuid","language":"plpgsql","volatility":"v","authenticated":false}},{"name":"_work_activity_claim_clock_setup","args":"p_project_id uuid, p_cost_code_id uuid, p_photo text, p_lat double precision, p_lng double precision, p_note text, p_mode text, p_client_id uuid, p_tapped_at timestamp with time zone, p_clock_checked_at timestamp with time zone, p_clock_skew_ms integer","value":{"anon":false,"body":"8c600c462e2825683cc474a648a85b217f3d04eca74c9a789ada1b612837c809","kind":"f","owner":"postgres","config":["search_path=public, pg_temp"],"public":false,"definer":true,"returns":"boolean","language":"plpgsql","volatility":"v","authenticated":false}},{"name":"_work_activity_clock_replay_guard","args":"p_client uuid, p_action text, p_shift uuid","value":{"anon":false,"body":"34a7483501a87bacd451d9ba6671b78edc48b526520f73ba2b70906b604e00ec","kind":"f","owner":"postgres","config":["search_path=public, pg_temp"],"public":false,"definer":true,"returns":"void","language":"plpgsql","volatility":"v","authenticated":false}},{"name":"_work_activity_clock_setup_digest","args":"p_project_id uuid, p_cost_code_id uuid, p_photo text, p_lat double precision, p_lng double precision, p_note text, p_mode text, p_client_id uuid, p_tapped_at timestamp with time zone, p_clock_checked_at timestamp with time zone, p_clock_skew_ms integer","value":{"anon":false,"body":"7cbf137bffb2f5134b3cd66a35bc7e207ea5c39a58cfed03acad2cbc017211d3","kind":"f","owner":"postgres","config":["search_path=public, pg_temp"],"public":false,"definer":false,"returns":"text","language":"sql","volatility":"s","authenticated":false}},{"name":"_work_activity_gate","args":"","value":{"anon":false,"body":"24e3624af1c057c5048b5e5e06206e802d17bb5a4aae1fdf5de9e48b87f4b6e8","kind":"f","owner":"postgres","config":["search_path=public, pg_temp"],"public":false,"definer":true,"returns":"void","language":"plpgsql","volatility":"v","authenticated":false}},{"name":"_work_activity_keep_clock_receipt","args":"","value":{"anon":false,"body":"0adc5b1eac8c882ea941c5c6bceea3242db7f9a66de8ded254bd96e8ad0a0291","kind":"f","owner":"postgres","config":["search_path=public, pg_temp"],"public":false,"definer":true,"returns":"trigger","language":"plpgsql","volatility":"v","authenticated":false}},{"name":"_work_activity_read_committed","args":"","value":{"anon":false,"body":"5c692d2459dd18fad5e0f49e698a619b1c26097e7ee335a69c460d44c4611b2a","kind":"f","owner":"postgres","config":["search_path=public, pg_temp"],"public":false,"definer":true,"returns":"void","language":"plpgsql","volatility":"v","authenticated":false}},{"name":"_work_config_internal","args":"p_uid uuid","value":{"anon":false,"body":"40350856480c2e8dc1c84247091981d9e70e9d766f7bb47b56fde7847a673407","kind":"f","owner":"postgres","config":["search_path=public, pg_temp"],"public":false,"definer":true,"returns":"boolean","language":"sql","volatility":"s","authenticated":false}},{"name":"clock_in","args":"p_project_id uuid, p_cost_code_id uuid, p_photo text, p_lat double precision, p_lng double precision","value":{"anon":false,"body":"c062f0c38a76f236bd2e4e459b2cdb39b99547865599717261334092d18d01e8","kind":"f","owner":"postgres","config":["search_path=public, pg_temp"],"public":false,"definer":true,"returns":"time_shifts","language":"plpgsql","volatility":"v","authenticated":true}},{"name":"clock_in","args":"p_project_id uuid, p_cost_code_id uuid, p_photo text, p_lat double precision, p_lng double precision, p_client_id uuid","value":{"anon":false,"body":"ee48d7b0c3fefd68678b570424c1cc2822f264a52f3099f5c0c98837c3dc9cb6","kind":"f","owner":"postgres","config":["search_path=public, pg_temp"],"public":false,"definer":true,"returns":"time_shifts","language":"plpgsql","volatility":"v","authenticated":true}},{"name":"clock_in","args":"p_project_id uuid, p_cost_code_id uuid, p_photo text, p_lat double precision, p_lng double precision, p_client_id uuid, p_note text","value":{"anon":false,"body":"4413958dd1c2e33a3e1bb5690dc33333bee29d57ca633610c444baf9547e439f","kind":"f","owner":"postgres","config":["search_path=public, pg_temp"],"public":false,"definer":true,"returns":"time_shifts","language":"plpgsql","volatility":"v","authenticated":true}},{"name":"clock_in","args":"p_project_id uuid, p_cost_code_id uuid, p_photo text, p_lat double precision, p_lng double precision, p_note text","value":{"anon":false,"body":"b1d566d9758bcab88df16b138f795c3792eff2a0a0c55750d089d2608c4a598b","kind":"f","owner":"postgres","config":["search_path=public, pg_temp"],"public":false,"definer":true,"returns":"time_shifts","language":"plpgsql","volatility":"v","authenticated":true}},{"name":"clock_in","args":"p_project_id uuid, p_cost_code_id uuid, p_photo text, p_lat double precision, p_lng double precision, p_note text, p_mode text","value":{"anon":false,"body":"c3fe0f2a5111f4d21bf5ef5149c79846ea53ec904f977765d75e5e7117fd5f09","kind":"f","owner":"postgres","config":["search_path=public, pg_temp"],"public":false,"definer":true,"returns":"time_shifts","language":"plpgsql","volatility":"v","authenticated":true}},{"name":"clock_in","args":"p_project_id uuid, p_cost_code_id uuid, p_photo text, p_lat double precision, p_lng double precision, p_note text, p_mode text, p_client_id uuid, p_tapped_at timestamp with time zone, p_clock_checked_at timestamp with time zone, p_clock_skew_ms integer","value":{"anon":false,"body":"ad7268b517980f7a4fc9f8cf7949bda734b127ccd2ee7eeec04119bffaf1c7e5","kind":"f","owner":"postgres","config":["search_path=public, pg_temp"],"public":false,"definer":true,"returns":"time_shifts","language":"plpgsql","volatility":"v","authenticated":true}},{"name":"clock_in","args":"p_project_id uuid, p_cost_code_id uuid, p_photo text, p_lat double precision, p_lng double precision, p_note text, p_mode text, p_client_id uuid, p_tapped_at timestamp with time zone, p_clock_checked_at timestamp with time zone, p_clock_skew_ms integer, p_setup_version integer","value":{"anon":false,"body":"bd9526a7263431db3d280f379f7af4641f4d97988e0ed4c36371b0b0c362ebcb","kind":"f","owner":"postgres","config":["search_path=public, pg_temp"],"public":false,"definer":true,"returns":"time_shifts","language":"plpgsql","volatility":"v","authenticated":true}},{"name":"clock_out","args":"p_shift_id uuid, p_photo text, p_injured boolean, p_time_confirmed boolean, p_break_seconds integer, p_lat double precision, p_lng double precision, p_injury_note text","value":{"anon":false,"body":"085e2e0382392ee105bf5dfb1322e786cb464f3dad2a43d981f1359ec562d1b4","kind":"f","owner":"postgres","config":["search_path=public, pg_temp"],"public":false,"definer":true,"returns":"time_shifts","language":"plpgsql","volatility":"v","authenticated":true}},{"name":"clock_out","args":"p_shift_id uuid, p_photo text, p_injured boolean, p_time_confirmed boolean, p_break_seconds integer, p_lat double precision, p_lng double precision, p_injury_note text, p_client_id uuid, p_tapped_at timestamp with time zone, p_clock_checked_at timestamp with time zone, p_clock_skew_ms integer","value":{"anon":false,"body":"2ddaca78ba00333dde9100492716df17f279c6ab1fc99d3b17ce20f77c0bb636","kind":"f","owner":"postgres","config":["search_path=public, pg_temp"],"public":false,"definer":true,"returns":"time_shifts","language":"plpgsql","volatility":"v","authenticated":true}},{"name":"end_break","args":"p_shift_id uuid","value":{"anon":false,"body":"f930e2e95a4d59e547eea6e7ee30135bfe39a13b002c76abfe6f72d1451c1ada","kind":"f","owner":"postgres","config":["search_path=public, pg_temp"],"public":false,"definer":true,"returns":"time_shifts","language":"plpgsql","volatility":"v","authenticated":true}},{"name":"end_break","args":"p_shift_id uuid, p_client_id uuid, p_tapped_at timestamp with time zone, p_clock_checked_at timestamp with time zone, p_clock_skew_ms integer","value":{"anon":false,"body":"470a0539693065c6cbd7ff51d8033fd74500570db13cdc2b990719a0eb2f7fc4","kind":"f","owner":"postgres","config":["search_path=public, pg_temp"],"public":false,"definer":true,"returns":"jsonb","language":"plpgsql","volatility":"v","authenticated":true}},{"name":"start_break","args":"p_shift_id uuid, p_break_type text","value":{"anon":false,"body":"4f12f25fc5d7060f59ad7cbe9d717c6a23de4a6ba860301200815063a1d24b06","kind":"f","owner":"postgres","config":["search_path=public, pg_temp"],"public":false,"definer":true,"returns":"time_shifts","language":"plpgsql","volatility":"v","authenticated":true}},{"name":"start_break","args":"p_shift_id uuid, p_break_type text, p_client_id uuid, p_tapped_at timestamp with time zone, p_clock_checked_at timestamp with time zone, p_clock_skew_ms integer","value":{"anon":false,"body":"02f00615f0264ad7f3b0b21a949df2c5e8a9257b9b66f714ef866df913d84cbc","kind":"f","owner":"postgres","config":["search_path=public, pg_temp"],"public":false,"definer":true,"returns":"time_shifts","language":"plpgsql","volatility":"v","authenticated":true}},{"name":"work_activity_clock_receipt","args":"p_client_id uuid","value":{"anon":false,"body":"e031a0d945fda344cafbdee6c5a2d228c368488d8cafdb0c75da60fcea7320b1","kind":"f","owner":"postgres","config":["search_path=public, pg_temp"],"public":false,"definer":true,"returns":"jsonb","language":"plpgsql","volatility":"v","authenticated":true}},{"name":"_work_cross_job_clock_request_admit","args":"","value":{"anon":false,"body":"acd71517a152215a32812a572df400ec9d3756d737e9ad8d4298a1fa035df836","kind":"f","owner":"postgres","config":["search_path=public, pg_temp"],"public":false,"definer":true,"returns":"trigger","language":"plpgsql","volatility":"v","authenticated":false}},{"name":"_work_cross_job_clock_request_stamp","args":"","value":{"anon":false,"body":"1cc06ac928c2a0a4c0cfd5244febac56eb275384f92dc8b57235bf98b3c4240c","kind":"f","owner":"postgres","config":["search_path=public, pg_temp"],"public":false,"definer":true,"returns":"trigger","language":"plpgsql","volatility":"v","authenticated":false}},{"name":"_work_cross_job_clock_receipt_fingerprint","args":"p_receipt work_activity_clock_receipts","value":{"anon":false,"body":"3f4d03d090a1428ce0dd8b410a285029903d156576da41a86237daa30e0e1d25","kind":"f","owner":"postgres","config":["search_path=public, pg_temp"],"public":false,"definer":true,"returns":"text","language":"sql","volatility":"i","authenticated":false}}]$protocol$::jsonb) loop
 select jsonb_build_object('body',encode(sha256(convert_to(p.prosrc,'UTF8')),'hex'),'owner',pg_get_userbyid(p.proowner),'definer',p.prosecdef,'volatility',p.provolatile,'kind',p.prokind,'language',l.lanname,'returns',pg_get_function_result(p.oid),'config',p.proconfig,'public',exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee=0 and a.privilege_type='EXECUTE'),'anon',has_function_privilege('anon',p.oid,'EXECUTE'),'authenticated',has_function_privilege('authenticated',p.oid,'EXECUTE')) into actual from pg_proc p join pg_namespace n on n.oid=p.pronamespace join pg_language l on l.oid=p.prolang
 where n.nspname='public' and p.proname=e->>'name' and pg_get_function_identity_arguments(p.oid)=e->>'args';
 if actual is distinct from e->'value' then raise exception using errcode='55000',message='Clock protocol is unavailable.';end if;
 end loop;
 select capture_enabled,revision into enabled,generation from public.work_activity_authority_generation where singleton;
 select * into s from public.personal_activity_state where profile_id=actor;
 if enabled is null or generation is null or generation>=9007199254740991
  or (s.profile_id is not null and (s.integrity_state<>'clean' or s.revision>=9007199254740991))
  or exists(select 1 from public.work_activity_safety_events where profile_id=actor) then
 mode:='unavailable';reason:='not_ready';
 elsif exists(select 1 from public.work_cross_job_shifts x join public.time_shifts h on h.id=x.shift_id where x.profile_id=actor and h.profile_id=actor and h.status='open' and h.clock_out_at is null) then
 mode:='unavailable';reason:='not_ready';
 elsif not enabled then mode:='closing_only';reason:='starts_disabled';
 else
 -- The exact setup_v1 root may start paid setup before signing. Ordinary
 -- overloads keep their existing toolbox/company-date policy.
 mode:='active';author_setup:=true;
 end if;
 return jsonb_build_object('protocolVersion',1,'asOf',public._work_activity_iso(as_of),
 'clockProtocol','setup_v1','receiptProtocol','retained_v1','mode',mode,'canAuthorSetup',author_setup,'setupReason',reason,
 'canDispatchExistingSetup',true,'canReadOwnReceipts',true,'canDispatchPayrollSafety',true);
exception when undefined_function or undefined_table or undefined_column then
 raise exception using errcode='55000',message='Clock protocol is unavailable.';
end;$capability$;

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
'work_cross_job_clock_requests.profile_id',(select count(*) from public.work_cross_job_clock_requests where profile_id=p_id),
'work_cross_job_shifts.profile_id',(select count(*) from public.work_cross_job_shifts where profile_id=p_id),
'work_cross_job_allocations.profile_id',(select count(*) from public.work_cross_job_allocations where profile_id=p_id),
'work_cross_job_bindings.profile_id',(select count(*) from public.work_cross_job_bindings where profile_id=p_id),
'work_cross_job_resume.profile_id',(select count(*) from public.work_cross_job_resume where profile_id=p_id),
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

do $acl$ declare f record;begin
 for f in select oid::regprocedure identity from pg_proc where pronamespace='public'::regnamespace and (starts_with(proname,'_work_cross_job_') or starts_with(proname,'work_cross_job_')) loop
 execute format('revoke all on function %s from public,anon,authenticated,service_role',f.identity);
 end loop;end $acl$;
grant execute on function public.work_cross_job_snapshot(uuid),public.work_cross_job_receipt(uuid) to authenticated;
-- CROSS_JOB_RUNTIME_END
select public.attach_sandbox_guards();
-- Exact revision2 contract. Seed is a reviewed assembly constant, not live drift.
create table public.work_cross_job_contract (
 proof_key text primary key check(proof_key='cross_job_kernel_2'),
 expected_catalog_sha256 text not null check(expected_catalog_sha256 ~ '^[0-9a-f]{64}$')
);
revoke all on table public.work_cross_job_contract from public,anon,authenticated,service_role;
alter table public.work_cross_job_contract enable row level security;
create function public._work_cross_job_coverage() returns boolean language sql stable security definer set search_path=public,pg_temp as $coverage$
 select coalesce((select count(*)=1 and bool_and(proof_key='cross_job_kernel_2' and expected_catalog_sha256 ~ '^[0-9a-f]{64}$' and expected_catalog_sha256=encode(sha256(convert_to(c.value::text,'UTF8')),'hex')) from public.work_cross_job_contract),false) from (
-- Deliberately closed source-derived public catalog. Unknown live drift refuses;
-- this is not a request to normalize a provider to the disposable fixture.
select jsonb_build_object(
 'types',(select jsonb_agg(jsonb_build_object('name',t.typname,'kind',t.typtype,'owner',pg_get_userbyid(t.typowner),'acl',t.typacl::text,'category',t.typcategory,'preferred',t.typispreferred,'defined',t.typisdefined,'notNull',t.typnotnull,'base',format_type(nullif(t.typbasetype,0),t.typtypmod),'element',format_type(nullif(t.typelem,0),null),'collation',case when t.typcollation<>0 then t.typcollation::regcollation::text end,'default',t.typdefault,'defaultExpression',pg_get_expr(t.typdefaultbin,0),'input',t.typinput::regprocedure::text,'output',t.typoutput::regprocedure::text,'receive',t.typreceive::regprocedure::text,'send',t.typsend::regprocedure::text,'length',t.typlen,'byValue',t.typbyval,'alignment',t.typalign,'storage',t.typstorage,'delimiter',t.typdelim,'access',(select jsonb_object_agg(r.rolname,has_type_privilege(r.oid,t.oid,'USAGE')) from pg_roles r where r.rolname in('anon','authenticated','service_role')),'enum',(select jsonb_agg(jsonb_build_object('label',e.enumlabel,'sort',e.enumsortorder) order by e.enumsortorder) from pg_enum e where e.enumtypid=t.oid),'constraints',(select jsonb_agg(jsonb_build_object('name',k.conname,'definition',pg_get_constraintdef(k.oid,true),'validated',k.convalidated) order by k.conname) from pg_constraint k where k.contypid=t.oid),'range',(select jsonb_build_object('subtype',format_type(r.rngsubtype,null),'collation',r.rngcollation::regcollation::text,'opclass',(select n.nspname||'.'||o.opcname from pg_opclass o join pg_namespace n on n.oid=o.opcnamespace where o.oid=r.rngsubopc),'canonical',r.rngcanonical::regprocedure::text,'subdiff',r.rngsubdiff::regprocedure::text) from pg_range r where r.rngtypid=t.oid)) order by t.typname) from pg_type t where t.typnamespace='public'::regnamespace),
 'sequences',(select jsonb_agg(jsonb_build_object('name',c.relname,'owner',pg_get_userbyid(c.relowner),'acl',c.relacl::text,'type',format_type(s.seqtypid,null),'start',s.seqstart,'increment',s.seqincrement,'max',s.seqmax,'min',s.seqmin,'cache',s.seqcache,'cycle',s.seqcycle,'access',(select jsonb_agg(jsonb_build_object('role',r.rolname,'privilege',v.p,'allowed',has_sequence_privilege(r.oid,c.oid,v.p)) order by r.rolname,v.p) from pg_roles r cross join unnest(array['SELECT','UPDATE','USAGE'])v(p) where r.rolname in('anon','authenticated','service_role'))) order by c.relname) from pg_class c join pg_sequence s on s.seqrelid=c.oid where c.relnamespace='public'::regnamespace),
 'foreignTables',(select jsonb_agg(jsonb_build_object('table',c.relname,'options',f.ftoptions,'server',s.srvname,'serverOwner',pg_get_userbyid(s.srvowner),'serverType',s.srvtype,'serverVersion',s.srvversion,'serverOptionsDigest',encode(sha256(convert_to(coalesce(s.srvoptions::text,''),'UTF8')),'hex'),'serverAcl',s.srvacl::text,'serverAccess',(select jsonb_object_agg(r.rolname,has_server_privilege(r.oid,s.oid,'USAGE')) from pg_roles r where r.rolname in('anon','authenticated','service_role')),'wrapper',w.fdwname,'wrapperOwner',pg_get_userbyid(w.fdwowner),'wrapperAcl',w.fdwacl::text,'wrapperAccess',(select jsonb_object_agg(r.rolname,has_foreign_data_wrapper_privilege(r.oid,w.oid,'USAGE')) from pg_roles r where r.rolname in('anon','authenticated','service_role')),'handler',w.fdwhandler::regprocedure::text,'validator',w.fdwvalidator::regprocedure::text,'wrapperOptionsDigest',encode(sha256(convert_to(coalesce(w.fdwoptions::text,''),'UTF8')),'hex')) order by c.relname) from pg_foreign_table f join pg_class c on c.oid=f.ftrelid join pg_foreign_server s on s.oid=f.ftserver join pg_foreign_data_wrapper w on w.oid=s.srvfdw where c.relnamespace='public'::regnamespace),
 'functions',(select jsonb_agg(jsonb_build_object('name',p.proname,'arguments',pg_get_function_identity_arguments(p.oid),'body',encode(sha256(convert_to(p.prosrc,'UTF8')),'hex'),'result',pg_get_function_result(p.oid),'owner',pg_get_userbyid(p.proowner),'acl',p.proacl::text,'language',l.lanname,'kind',p.prokind,'definer',p.prosecdef,'config',p.proconfig,'volatility',p.provolatile,'strict',p.proisstrict,'leakproof',p.proleakproof,'cost',p.procost,'rows',p.prorows,'support',p.prosupport::regprocedure::text,'parallel',p.proparallel,'defaults',pg_get_expr(p.proargdefaults,0),'access',(select jsonb_object_agg(r.rolname,has_function_privilege(r.oid,p.oid,'EXECUTE')) from pg_roles r where r.rolname in('anon','authenticated','service_role'))) order by p.proname,pg_get_function_identity_arguments(p.oid)) from pg_proc p join pg_language l on l.oid=p.prolang where p.pronamespace='public'::regnamespace and not exists(select 1 from pg_depend d where d.classid='pg_proc'::regclass and d.objid=p.oid and d.deptype='e')),
 'relations',(select jsonb_agg(jsonb_build_object('name',c.relname,'kind',c.relkind,'owner',pg_get_userbyid(c.relowner),'rls',c.relrowsecurity,'forcedRls',c.relforcerowsecurity,'acl',c.relacl::text,'access',(select jsonb_agg(jsonb_build_object('role',r.rolname,'privilege',v.p,'table',has_table_privilege(r.oid,c.oid,v.p),'column',case when v.p in('SELECT','INSERT','UPDATE','REFERENCES') then has_any_column_privilege(r.oid,c.oid,v.p) end) order by r.rolname,v.p) from pg_roles r cross join unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'])v(p) where r.rolname in('anon','authenticated','service_role'))) order by c.relname) from pg_class c where c.relnamespace='public'::regnamespace and c.relkind in('r','p','v','m','f','c')),
 'columns',(select jsonb_agg(jsonb_build_object('table',c.relname,'name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'notNull',a.attnotnull,'generated',a.attgenerated,'identity',a.attidentity,'acl',a.attacl::text,'default',pg_get_expr(d.adbin,d.adrelid),'access',(select jsonb_agg(jsonb_build_object('role',r.rolname,'privilege',v.p,'allowed',has_column_privilege(r.oid,c.oid,a.attnum,v.p)) order by r.rolname,v.p) from pg_roles r cross join unnest(array['SELECT','INSERT','UPDATE','REFERENCES'])v(p) where r.rolname in('anon','authenticated','service_role'))) order by c.relname,a.attnum) from pg_class c join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped left join pg_attrdef d on d.adrelid=c.oid and d.adnum=a.attnum where c.relnamespace='public'::regnamespace and c.relkind in('r','p','v','m','f','c')),
 'constraints',(select jsonb_agg(jsonb_build_object('table',c.relname,'name',k.conname,'definition',pg_get_constraintdef(k.oid,true),'validated',k.convalidated,'noInherit',k.connoinherit,'enforced',coalesce((to_jsonb(k)->>'conenforced')::boolean,true)) order by c.relname,k.conname) from pg_constraint k join pg_class c on c.oid=k.conrelid where c.relnamespace='public'::regnamespace and k.contype<>'n'),
 'notNullConstraints',(select jsonb_agg(jsonb_build_object('table',c.relname,'column',a.attname,'validated',coalesce(n.validated,true),'enforced',coalesce(n.enforced,true),'noInherit',coalesce(n.no_inherit,false)) order by c.relname,a.attnum) from pg_class c join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped left join lateral(select bool_and(k.convalidated) validated,bool_and(coalesce((to_jsonb(k)->>'conenforced')::boolean,true)) enforced,bool_or(k.connoinherit) no_inherit from pg_constraint k where k.conrelid=c.oid and k.contype='n' and a.attnum=any(k.conkey))n on true where c.relnamespace='public'::regnamespace and c.relkind in('r','p')),
 'indexes',(select jsonb_agg(jsonb_build_object('table',t.relname,'name',c.relname,'definition',pg_get_indexdef(i.indexrelid),'valid',i.indisvalid,'ready',i.indisready) order by t.relname,c.relname) from pg_index i join pg_class c on c.oid=i.indexrelid join pg_class t on t.oid=i.indrelid where t.relnamespace='public'::regnamespace),
 'triggers',(select jsonb_agg(jsonb_build_object('table',c.relname,'name',t.tgname,'definition',pg_get_triggerdef(t.oid,true),'enabled',t.tgenabled) order by c.relname,t.tgname) from pg_trigger t join pg_class c on c.oid=t.tgrelid where c.relnamespace='public'::regnamespace and not t.tgisinternal),
 'policies',(select jsonb_agg(to_jsonb(p) order by p.tablename,p.policyname) from pg_policies p where schemaname='public'),
 'views',(select jsonb_agg(jsonb_build_object('name',c.relname,'definition',pg_get_viewdef(c.oid,true)) order by c.relname) from pg_class c where c.relnamespace='public'::regnamespace and c.relkind in('v','m'))
) value
)c
$coverage$;
revoke all on function public._work_cross_job_coverage() from public,anon,authenticated,service_role;
insert into public.work_cross_job_contract values('cross_job_kernel_2','00db48aa715a066d2c3cd0ec73423a8af14e7338fa2c13e36ab2ff68b49f307e');
create trigger work_cross_job_contract_immutable before insert or update or delete on public.work_cross_job_contract for each row execute function public.work_capture_immutable_record();
create trigger work_cross_job_contract_no_truncate before truncate on public.work_cross_job_contract for each statement execute function public.work_capture_immutable_record();
create or replace function public._work_unit_review_coverage() returns boolean language sql stable security definer set search_path=public,pg_temp as $$
 select (coalesce((select p.prosrc is not null and encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')='bbebab5cc374c8233ba85a865428db4ac38ed8e0c4bf8b295edf645bb4d8e074' and pg_get_userbyid(p.proowner)='postgres' and p.proacl::text='{postgres=X/postgres}' and p.prosecdef and p.proconfig=array['search_path=public, pg_temp']::text[] and p.provolatile='s' and not p.proisstrict and not p.proleakproof and p.proparallel='u' and p.prokind='f' and not p.proretset and p.prorettype='boolean'::regtype and p.pronargs=0 and p.pronargdefaults=0 and p.procost=100 and p.prorows=0 and p.prosupport=0 and p.prolang=(select oid from pg_language where lanname='sql') from pg_proc p where p.oid=to_regprocedure('public._work_cross_job_coverage()')),false) and public._work_cross_job_coverage()) and not exists(select 1 from public.work_cross_job_shifts)
$$;
revoke all on function public._work_unit_review_coverage() from public,anon,authenticated,service_role;
create or replace function public._work_totals_coverage() returns boolean language sql stable security definer set search_path=public,pg_temp as $$
 select (coalesce((select p.prosrc is not null and encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')='bbebab5cc374c8233ba85a865428db4ac38ed8e0c4bf8b295edf645bb4d8e074' and pg_get_userbyid(p.proowner)='postgres' and p.proacl::text='{postgres=X/postgres}' and p.prosecdef and p.proconfig=array['search_path=public, pg_temp']::text[] and p.provolatile='s' and not p.proisstrict and not p.proleakproof and p.proparallel='u' and p.prokind='f' and not p.proretset and p.prorettype='boolean'::regtype and p.pronargs=0 and p.pronargdefaults=0 and p.procost=100 and p.prorows=0 and p.prosupport=0 and p.prolang=(select oid from pg_language where lanname='sql') from pg_proc p where p.oid=to_regprocedure('public._work_cross_job_coverage()')),false) and public._work_cross_job_coverage()) and not exists(select 1 from public.work_cross_job_shifts)
$$;
revoke all on function public._work_totals_coverage() from public,anon,authenticated,service_role;
create or replace function public._work_unit_contributors_coverage() returns boolean language sql stable security definer set search_path=public,pg_temp as $$
 select (coalesce((select p.prosrc is not null and encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')='bbebab5cc374c8233ba85a865428db4ac38ed8e0c4bf8b295edf645bb4d8e074' and pg_get_userbyid(p.proowner)='postgres' and p.proacl::text='{postgres=X/postgres}' and p.prosecdef and p.proconfig=array['search_path=public, pg_temp']::text[] and p.provolatile='s' and not p.proisstrict and not p.proleakproof and p.proparallel='u' and p.prokind='f' and not p.proretset and p.prorettype='boolean'::regtype and p.pronargs=0 and p.pronargdefaults=0 and p.procost=100 and p.prorows=0 and p.prosupport=0 and p.prolang=(select oid from pg_language where lanname='sql') from pg_proc p where p.oid=to_regprocedure('public._work_cross_job_coverage()')),false) and public._work_cross_job_coverage()) and not exists(select 1 from public.work_cross_job_shifts)
$$;
revoke all on function public._work_unit_contributors_coverage() from public,anon,authenticated,service_role;

-- Explicit frozen function ACLs for static review; no privilege expansion.
revoke all on function public._work_cross_job_enabled() from public, anon, authenticated, service_role;
revoke all on function public._work_cross_job_table(text) from public, anon, authenticated, service_role;
revoke all on function public._work_cross_job_history(text, uuid) from public, anon, authenticated, service_role;
revoke all on function public._work_cross_job_scope(uuid, uuid, boolean) from public, anon, authenticated, service_role;
revoke all on function public._work_cross_job_register(time_shifts, uuid) from public, anon, authenticated, service_role;
revoke all on function public._work_cross_job_birth_guard(text, jsonb, jsonb) from public, anon, authenticated, service_role;
revoke all on function public._work_cross_job_bind(text, uuid, uuid, uuid, timestamp with time zone, uuid) from public, anon, authenticated, service_role;
revoke all on function public._work_cross_job_local_valid(text, jsonb, time_shifts) from public, anon, authenticated, service_role;
revoke all on function public._work_cross_job_custom(uuid, time_shifts, uuid, jsonb, timestamp with time zone, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public._work_cross_job_save(personal_activity_state, uuid, timestamp with time zone, uuid) from public, anon, authenticated, service_role;
revoke all on function public._work_cross_job_resume_basis(personal_activity_state, time_shifts, timestamp with time zone) from public, anon, authenticated, service_role;
revoke all on function public.custom_work_follow_shift() from public, anon, authenticated;
grant execute on function public.custom_work_follow_shift() to service_role;
revoke all on function public.service_follow_shift() from public, anon, authenticated;
grant execute on function public.service_follow_shift() to service_role;
revoke all on function public._work_cross_job_source(uuid, time_shifts, uuid, text, jsonb, timestamp with time zone, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public._work_cross_job_head_valid(uuid) from public, anon, authenticated, service_role;
revoke all on function public._work_cross_job_allocation_guard() from public, anon, authenticated, service_role;
revoke all on function public._work_cross_job_clock_receipt_fingerprint(work_activity_clock_receipts) from public, anon, authenticated, service_role;
revoke all on function public._work_cross_job_clock_request_admit() from public, anon, authenticated, service_role;
revoke all on function public._work_cross_job_clock_request_stamp() from public, anon, authenticated, service_role;
revoke all on function public._work_activity_row_before() from public, anon, authenticated, service_role;
revoke all on function public._work_activity_operation_exit(uuid) from public, anon, authenticated, service_role;
revoke all on function public._work_activity_start_setup(time_shifts, uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public._work_activity_shift_lifecycle() from public, anon, authenticated, service_role;
revoke all on function public._work_activity_resume(personal_activity_state, time_shifts, timestamp with time zone) from public, anon, authenticated, service_role;
revoke all on function public.clock_in(uuid, uuid, text, double precision, double precision, text, text, uuid, timestamp with time zone, timestamp with time zone, integer, integer) from public, anon, service_role;
grant execute on function public.clock_in(uuid, uuid, text, double precision, double precision, text, text, uuid, timestamp with time zone, timestamp with time zone, integer, integer) to authenticated;
revoke all on function public._work_activity_claim_clock_setup(uuid, uuid, text, double precision, double precision, text, text, uuid, timestamp with time zone, timestamp with time zone, integer) from public, anon, authenticated, service_role;
revoke all on function public.work_activity_command(uuid, integer, jsonb) from public, anon, service_role;
grant execute on function public.work_activity_command(uuid, integer, jsonb) to authenticated;
revoke all on function public.work_activity_snapshot(uuid) from public, anon, service_role;
grant execute on function public.work_activity_snapshot(uuid) to authenticated;
revoke all on function public.work_cross_job_snapshot(uuid) from public, anon, service_role;
grant execute on function public.work_cross_job_snapshot(uuid) to authenticated;
revoke all on function public.work_activity_command_receipt(uuid) from public, anon, service_role;
grant execute on function public.work_activity_command_receipt(uuid) to authenticated;
revoke all on function public.work_cross_job_receipt(uuid) from public, anon, service_role;
grant execute on function public.work_cross_job_receipt(uuid) to authenticated;
revoke all on function public._work_activity_clock_replay_guard(uuid, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.work_activity_clock_receipt(uuid) from public, anon, service_role;
grant execute on function public.work_activity_clock_receipt(uuid) to authenticated;
revoke all on function public._work_activity_clock_contract_marker() from public, anon, authenticated, service_role;
revoke all on function public.work_activity_clock_capability() from public, anon, service_role;
grant execute on function public.work_activity_clock_capability() to authenticated;
revoke all on function public.person_record_counts(uuid) from public, anon, authenticated;
grant execute on function public.person_record_counts(uuid) to service_role;
revoke all on function public._work_cross_job_coverage() from public, anon, authenticated, service_role;
revoke all on function public._work_unit_review_coverage() from public, anon, authenticated, service_role;
revoke all on function public._work_totals_coverage() from public, anon, authenticated, service_role;
revoke all on function public._work_unit_contributors_coverage() from public, anon, authenticated, service_role;
rollback;
