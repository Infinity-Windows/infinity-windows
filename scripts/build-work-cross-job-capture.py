#!/usr/bin/env python3
"""Exact-source additive replacement generator. Never writes historical files."""
from pathlib import Path
import re,hashlib,json
root=Path(__file__).resolve().parent.parent
engine=(root/'supabase/migrations/20261108410000_work_activity_engine_cutover.sql').read_text()
fixture=(root/'scripts/fixtures/work-activity-engine-online-schema.sql').read_text()
assert hashlib.sha256(engine.encode()).hexdigest()=='aa767e67de301cd0ce5961758cc5afefe89bdf25fe27b3c4156a219c9cb2f648'
replacements=[]
# Expected proof is immutable DATA, so the FULL attester source can be hashed
# without a circular function-literal digest. It is never installed from an
# observed live catalog. Only the explicit disposable freeze updates this file.
contract=json.loads((root/'scripts/work-cross-job-contract.json').read_text())
catalog=(root/'scripts/work-cross-job-catalog.sql').read_text().strip().rstrip(';')
coverage_body="\n select coalesce((select count(*)=1 and bool_and(proof_key='cross_job_kernel_2' and expected_catalog_sha256 ~ '^[0-9a-f]{64}$' and expected_catalog_sha256=encode(sha256(convert_to(c.value::text,'UTF8')),'hex')) from public.work_cross_job_contract),false) from (\n"+catalog+"\n)c\n"
coverage_hash=hashlib.sha256(coverage_body.encode()).hexdigest()
# Repeated independently at each admitted public gate and each old report guard.
# No mutable helper can claim that its own replacement is trusted.
coverage_pin="coalesce((select p.prosrc is not null and encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')='"+coverage_hash+"' and pg_get_userbyid(p.proowner)='postgres' and p.proacl::text='{postgres=X/postgres}' and p.prosecdef and p.proconfig=array['search_path=public, pg_temp']::text[] and p.provolatile='s' and not p.proisstrict and not p.proleakproof and p.proparallel='u' and p.prokind='f' and not p.proretset and p.prorettype='boolean'::regtype and p.pronargs=0 and p.pronargdefaults=0 and p.procost=100 and p.prorows=0 and p.prosupport=0 and p.prolang=(select oid from pg_language where lanname='sql') from pg_proc p where p.oid=to_regprocedure('public._work_cross_job_coverage()')),false)"
admitted_coverage='('+coverage_pin+' and public._work_cross_job_coverage())'
coverage="""-- Exact revision2 contract. Seed is a reviewed assembly constant, not live drift.
create table public.work_cross_job_contract (
 proof_key text primary key check(proof_key='cross_job_kernel_2'),
 expected_catalog_sha256 text not null check(expected_catalog_sha256 ~ '^[0-9a-f]{64}$')
);
revoke all on table public.work_cross_job_contract from public,anon,authenticated,service_role;
alter table public.work_cross_job_contract enable row level security;
create function public._work_cross_job_coverage() returns boolean language sql stable security definer set search_path=public,pg_temp as $coverage$"""+coverage_body+"""$coverage$;
revoke all on function public._work_cross_job_coverage() from public,anon,authenticated,service_role;
insert into public.work_cross_job_contract values('cross_job_kernel_2','"""+contract['expectedCatalogSha256']+"""');
create trigger work_cross_job_contract_immutable before insert or update or delete on public.work_cross_job_contract for each row execute function public.work_capture_immutable_record();
create trigger work_cross_job_contract_no_truncate before truncate on public.work_cross_job_contract for each statement execute function public.work_capture_immutable_record();
"""
for guard in ['_work_unit_review_coverage','_work_totals_coverage','_work_unit_contributors_coverage']:
 coverage+="create or replace function public."+guard+"() returns boolean language sql stable security definer set search_path=public,pg_temp as $$\n select "+admitted_coverage+" and not exists(select 1 from public.work_cross_job_shifts)\n$$;\nrevoke all on function public."+guard+"() from public,anon,authenticated,service_role;\n"
(root/'scripts/work-cross-job-coverage.sql').write_text(coverage)
def extract(name,source=engine):
 pat=re.compile(r'^create (?:or replace )?function public\.'+re.escape(name)+r'\([\s\S]*?\bas\s+(\$[a-z0-9_]*\$)',re.M|re.I)
 matches=list(pat.finditer(source));assert len(matches)==1,(name,len(matches))
 m=matches[0];end=source.index(m[1],m.end())+len(m[1]);s=source[m.start():end]+';'
 return re.sub(r'^create (?:or replace )?function','create or replace function',s)
def once(s,old,new):
 assert s.count(old)==1,(old[:120],s.count(old));return s.replace(old,new)
def add(name,fn):
 old=extract(name);new=fn(old);replacements.append((name,old,new));return new
out=[]
out.append(add('_work_activity_row_before',lambda s:once(s," if oldwho is not null then perform public._work_activity_touch(oldwho);end if;", " perform public._work_cross_job_birth_guard(case tg_table_name when 'custom_work_sessions' then 'custom' when 'unit_sessions' then 'unit' when 'task_sessions' then 'task' when 'service_time_sessions' then 'service' when 'opening_phases' then 'phase' when 'work_setup_sessions' then 'setup' end,oldj,newj);\n if oldwho is not null then perform public._work_activity_touch(oldwho);end if;")))
out.append(add('_work_activity_operation_exit',lambda s:once(s,"'last_transition_id',person.transition_id)),1);","'last_transition_id',person.transition_id)),case when exists(select 1 from public.work_cross_job_shifts where shift_id=shift_source) then 2 else 1 end);")))
def setup(s):
 s=once(s,'at_time timestamptz;','at_time timestamptz; created uuid;')
 s=once(s," return public._work_activity_insert_source(p_shift.profile_id,'setup'"," created:=public._work_activity_insert_source(p_shift.profile_id,'setup'")
 s=once(s,"at_time,case when p_prior is null then 'clock_in' else 'break_end' end);", "at_time,case when p_prior is null then 'clock_in' else 'break_end' end);\n if exists(select 1 from public.work_cross_job_shifts where shift_id=p_shift.id) then perform public._work_cross_job_bind('setup',created,p_shift.id,null,at_time,case when p_prior is not null then (select closure_history_id from public.work_cross_job_resume where profile_id=p_shift.profile_id) end);end if;\n return created;")
 return s
out.append(add('_work_activity_start_setup',setup))
def lifecycle(s):
 s=once(s," or not exists", " or not exists") if False else s
 s=once(s," and not exists(select 1 from public.work_activity_safety_events where profile_id=new.profile_id);", " and s.effective_since is not null and s.effective_since<=boundary\n   and not exists(select 1 from public.work_activity_safety_events where profile_id=new.profile_id);")
 s=once(s," perform public._work_activity_close_all(new.profile_id,boundary,cause);", " perform public._work_activity_close_all(new.profile_id,boundary,cause);\n if saved then saved:=public._work_cross_job_save(s,new.id,boundary,person.transition_id);\n else delete from public.work_cross_job_resume where profile_id=new.profile_id;end if;")
 s=once(s,"    choice_required=not resumed where profile_id=new.profile_id;", "    choice_required=not resumed where profile_id=new.profile_id;\n   delete from public.work_cross_job_resume where profile_id=new.profile_id;")
 return s
out.append(add('_work_activity_shift_lifecycle',lifecycle))
def resume(s):
 s=once(s,' paused_total numeric;',' paused_total numeric; allocation uuid; closure uuid; version2 boolean;')
 s=once(s," if not pg_try_advisory_xact_lock(7710,0) then return false;end if;", " if not pg_try_advisory_xact_lock(7710,0) then return false;end if;\n if not public._work_cross_job_resume_basis(p_state,p_shift,p_at) then return false;end if;\n version2:=exists(select 1 from public.work_cross_job_shifts where shift_id=p_shift.id);\n select allocation_id,closure_history_id into allocation,closure from public.work_cross_job_resume where profile_id=p_state.profile_id;")
 start=s.index("   frame:=public._work_activity_context_for(p_state.profile_id,'break_end',p_at);")
 end=s.index(" elsif p_state.resume_source_kind='unit' then",start)
 legacy=s[start:end]
 s=s[:start]+"   if version2 then\n    if prior_meta.session_id is null then return false;end if;\n    new_id:=public._work_cross_job_custom(p_state.profile_id,p_shift,allocation,intent,p_at,'break_end',closure);\n   else\n"+legacy+"   end if;\n"+s[end:]
 # Until a supported exact allocation-aware adapter is present, v2 must never
 # drop into old unit/task/service/phase inserts. This construction gate is
 # explicit and must be closed before readiness; it does not reject payroll.
 s=once(s," elsif p_state.resume_source_kind='unit' then", " elsif version2 then\n   new_id:=public._work_cross_job_source(p_state.profile_id,p_shift,allocation,p_state.resume_source_kind,r,p_at,'break_end',closure);\n elsif p_state.resume_source_kind='unit' then")
 return s
out.append(add('_work_activity_resume',resume))
def clock(s):
 s=once(s," if p_setup_version is distinct from 1 then", " if p_setup_version not in(1,2) or p_setup_version is null or (p_setup_version=2 and (not public._work_cross_job_enabled() or not public._work_cross_job_coverage())) then")
 s=once(s,"jsonb_build_object('setupVersion',1,'clockPayloadDigest',digest)","jsonb_build_object('setupVersion',p_setup_version,'clockPayloadDigest',digest)")
 s=once(s,"   perform public._work_activity_start_setup(h,p_client_id);", "   if p_setup_version=2 then perform public._work_cross_job_register(h,p_client_id);end if;\n   perform public._work_activity_start_setup(h,p_client_id);")
 return s
# Exactly the explicitly opted-in twelve-argument source, not generated overloads.
clockm=re.search(r'create function public.clock_in\(\n p_project_id[\s\S]*?end; \$\$;',engine)
assert clockm
cl=clockm[0];out.append(clock(cl.replace('create function','create or replace function',1)))
def claim(s):
 s=once(s,"  or o.arguments is distinct from jsonb_build_object('setupVersion',1,", "  or coalesce(o.arguments->>'setupVersion','') not in('1','2') or (o.arguments->>'setupVersion'='2' and (not public._work_cross_job_enabled() or not public._work_cross_job_coverage()))\n  or o.arguments is distinct from jsonb_build_object('setupVersion',(o.arguments->>'setupVersion')::integer,")
 return s
out.append(add('_work_activity_claim_clock_setup',claim))
# Version2 shares the existing command/stream ledger and old intent parser.
def command(s):
 s=once(s,' unit_basis jsonb; before_shift jsonb; after_shift jsonb;', ' unit_basis jsonb; before_shift jsonb; after_shift jsonb; prior_allocation uuid; allocation uuid; cross_job boolean:=false;')
 s=once(s,'p_protocol_version is distinct from 1','(p_protocol_version not in(1,2) or p_protocol_version is null)')
 s=once(s,' payload:=public._work_activity_payload(p_payload);'," if p_protocol_version=2 then\n  if not public._work_cross_job_enabled() or not public._work_cross_job_coverage() then return jsonb_build_object('protocolVersion',2,'availability','unavailable','receipt',null);end if;\n  perform public._work_activity_object(p_payload,array['deviceId','clientGeneration','clientSequence','predecessorCommandId','expectedRevision','basis','shiftRef','tappedAt','clockCheckedAt','clockSkewMs','intent','expectedAllocationId','boundaryMode']);\n  prior_allocation:=public._work_activity_uuid(p_payload->'expectedAllocationId',true);\n  if p_payload->>'boundaryMode' is distinct from 'trusted_original_tap' then raise exception using errcode='23514',message='Unsupported boundary mode.';end if;\n  payload:=public._work_activity_payload(p_payload-'expectedAllocationId'-'boundaryMode')||jsonb_build_object('expectedAllocationId',prior_allocation,'boundaryMode','trusted_original_tap');\n else payload:=public._work_activity_payload(p_payload);end if;")
 s=s.replace("'protocolVersion',1","'protocolVersion',p_protocol_version").replace('prior.protocol_version is distinct from 1','prior.protocol_version is distinct from p_protocol_version')
 s=once(s,'   return jsonb_build_object(\'protocolVersion\',p_protocol_version,\'availability\',\'available\',\'receipt\',prior.result);',"   if p_protocol_version=2 and not public._work_cross_job_scope((prior.normalized_payload#>>'{shiftRef,id}')::uuid,actor) then return jsonb_build_object('protocolVersion',2,'availability','unavailable','receipt',null);end if;\n   return jsonb_build_object('protocolVersion',p_protocol_version,'availability','available','receipt',prior.result);")
 s=once(s," select * into obs from public.work_activity_observations", " cross_job:=exists(select 1 from public.work_cross_job_shifts where shift_id=s.shift_id);\n if cross_job is distinct from (p_protocol_version=2) then return jsonb_build_object('protocolVersion',p_protocol_version,'availability','unavailable','receipt',null);end if;\n if cross_job and not public._work_cross_job_scope(s.shift_id,actor) then return jsonb_build_object('protocolVersion',2,'availability','unavailable','receipt',null);end if;\n select allocation_id into allocation from public.work_cross_job_heads where shift_id=s.shift_id;\n select * into obs from public.work_activity_observations")
 s=once(s," if kind='establish_stream' then", " if cross_job and allocation is distinct from prior_allocation and reason is null then v_status:='conflict';reason:='state_changed';end if;\n if kind='establish_stream' then")
 s=once(s,"((intent->>'projectId')::uuid is distinct from h.project_id or s.active_source_kind='setup')", "((not cross_job and (intent->>'projectId')::uuid is distinct from h.project_id) or s.active_source_kind='setup')")
 s=once(s,"(select selected_effective_at from public.personal_activity_transitions where id=s.last_transition_id)) into not_before;", "(select selected_effective_at from public.personal_activity_transitions where id=s.last_transition_id),(select effective_at from public.work_cross_job_allocations where id=allocation)) into not_before;")
 s=once(s,"if pick.pay_at is null or pick.reason in ('tap_out_of_order','tap_too_old') then", "if pick.pay_at is null or pick.reason in ('tap_out_of_order','tap_too_old') or (cross_job and not pick.used_tap) then")
 s=once(s,"       if kind='switch' then\n         select", "       if cross_job and kind in('switch','finish_setup') then\n        allocation:=p_command_id;\n        insert into public.work_cross_job_allocations(id,shift_id,profile_id,predecessor_id,event_kind,project_id,cost_code_id,original_tapped_at,clock_checked_at,clock_skew_ms,admitted_at,effective_at,boundary_mode,command_id,transition_id,authority_revision,source_generation)\n        values(allocation,h.id,actor,prior_allocation,case when prior_allocation is null then 'initial' else 'handoff' end,(intent->>'projectId')::uuid,case when kind='finish_setup' then (intent->>'costCodeId')::uuid end,\n        (payload->>'tappedAt')::timestamptz,(payload->>'clockCheckedAt')::timestamptz,(payload->>'clockSkewMs')::integer,arrival,selected_at,'trusted_original_tap',p_command_id,person.transition_id,public._work_activity_authority_revision(),2);\n        insert into public.work_cross_job_heads values(h.id,allocation) on conflict(shift_id) do update set allocation_id=excluded.allocation_id;\n       end if;\n       if kind='switch' and cross_job then\n        session_id:=public._work_cross_job_custom(actor,h,allocation,intent,selected_at,'switch');\n       elsif kind='switch' then\n         select")
 s=once(s,"       elsif kind='finish_setup' then", "       elsif kind='finish_setup' and not cross_job then")
 s=once(s,' values(p_command_id,actor,actor,1,payload,hash,arrival,',' values(p_command_id,actor,actor,p_protocol_version,payload,hash,arrival,')
 return s
out.append(add('work_activity_command',command))
# Old reader cannot mislabel allocation2 as the physical anchor.
def snapshot(s):
 return once(s," if h.id is not null then shift_view:=", " if exists(select 1 from public.work_cross_job_shifts where shift_id=h.id) then return jsonb_build_object('protocolVersion',1,'asOf',public._work_activity_iso(as_of),'deviceId',p_device_id,'capability',jsonb_build_object('mode','unavailable','reasonCode','not_ready'),'observation',null,'stream',null,'state',null);end if;\n if h.id is not null then shift_view:=")
out.append(add('work_activity_snapshot',snapshot))
# Separate explicit v2 read, preserving the frozen v1 parser's shape.
snap=extract('work_activity_snapshot').replace('public.work_activity_snapshot(','public.work_cross_job_snapshot(',1)
snap=once(snap," if h.id is not null then shift_view:=", " if not public._work_cross_job_enabled() or not public._work_cross_job_coverage() or not public._work_cross_job_scope(h.id,actor) then return jsonb_build_object('protocolVersion',2,'availability','unavailable','state',null);end if;\n if h.id is not null then shift_view:=")
snap=snap.replace("'protocolVersion',1","'protocolVersion',2")
snap=once(snap,"'project',public._work_activity_project_view(h.project_id,actor)","'project',public._work_activity_project_view((select a.project_id from public.work_cross_job_heads x join public.work_cross_job_allocations a on a.id=x.allocation_id where x.shift_id=h.id),actor),'allocationId',(select allocation_id from public.work_cross_job_heads where shift_id=h.id)")
out.append(snap)
# Receipt1 remains unchanged for v1 rows and cannot deliver a v2 shape to old parser.
receipt=extract('work_activity_command_receipt');receipt=once(receipt,'and subject_profile_id=actor;','and subject_profile_id=actor and protocol_version=1;');out.append(receipt)
# New receipt is current/original-scope guarded. Its allocation links are retained
# by unique command_id in allocations, without changing the old stream invariant.
out.append("""create function public.work_cross_job_receipt(p_command_id uuid) returns jsonb language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare actor uuid;c public.personal_activity_commands;a public.work_cross_job_allocations;
begin
 perform public._work_activity_read_committed();perform public._work_activity_gate();perform pg_advisory_xact_lock(7710,0);actor:=public._work_activity_actor();
 select * into c from public.personal_activity_commands where command_id=p_command_id and actor_id=actor and subject_profile_id=actor and protocol_version=2;
 if c.command_id is null or not public._work_cross_job_enabled() or not public._work_cross_job_coverage() or not public._work_cross_job_scope((c.normalized_payload#>>'{shiftRef,id}')::uuid,actor) then return jsonb_build_object('protocolVersion',2,'availability','unavailable','receipt',null,'allocation',null);end if;
 select * into a from public.work_cross_job_allocations where command_id=c.command_id;
 return jsonb_build_object('protocolVersion',2,'availability','available','receipt',c.result,'allocation',case when a.id is not null then jsonb_build_object('id',a.id,'predecessorId',a.predecessor_id,'boundaryMode',a.boundary_mode,'originalTappedAt',public._work_activity_iso(a.original_tapped_at),'effectiveAt',public._work_activity_iso(a.effective_at),'shiftId',a.shift_id,'transitionId',a.transition_id) end);
end$$;""")
# Extend the exact current retained-person census; operational purge cannot
# remove or forget the new allocation identities.
review=(root/'supabase/migrations/20261108440000_work_unit_review.sql').read_text()
census=extract('person_record_counts',review)
census=once(census,"'work_activity_source_history.actor_id',", "'work_cross_job_shifts.profile_id',(select count(*) from public.work_cross_job_shifts where profile_id=p_id),\n'work_cross_job_allocations.profile_id',(select count(*) from public.work_cross_job_allocations where profile_id=p_id),\n'work_cross_job_bindings.profile_id',(select count(*) from public.work_cross_job_bindings where profile_id=p_id),\n'work_cross_job_resume.profile_id',(select count(*) from public.work_cross_job_resume where profile_id=p_id),\n'work_activity_source_history.actor_id',")
out.append(census)
# Explicit ACL closure; replacements retain existing ACLs, new helpers are private.
for name in re.findall(r'create (?:or replace )?function public\.([a-z_]+)\(', (root/'scripts/work-cross-job-runtime.sql').read_text()+'\n'.join(out)):
 pass
out.append("""do $acl$ declare f record;begin
 for f in select oid::regprocedure identity from pg_proc where pronamespace='public'::regnamespace and (starts_with(proname,'_work_cross_job_') or starts_with(proname,'work_cross_job_')) loop
 execute format('revoke all on function %s from public,anon,authenticated,service_role',f.identity);
 end loop;end $acl$;
grant execute on function public.work_cross_job_snapshot(uuid),public.work_cross_job_receipt(uuid) to authenticated;""")
path=root/'supabase/migrations/20261108470000_work_cross_job_capture.sql'
base=path.read_text().split('-- CROSS_JOB_RUNTIME_PENDING')[0].split('-- CROSS_JOB_RUNTIME_BEGIN')[0]
runtime=(root/'scripts/work-cross-job-runtime.sql').read_text()
out=[s.replace('public._work_cross_job_coverage()',admitted_coverage) for s in out]
path.write_text(base+'-- CROSS_JOB_RUNTIME_BEGIN\n'+runtime+'\n'+'\n\n'.join(out)+'\n-- CROSS_JOB_RUNTIME_END\n'+coverage+'\nrollback;\n')
(root/'scripts/work-cross-job-replacements.json').write_text(json.dumps([{'name':n,'oldCreateSha256':hashlib.sha256(o.encode()).hexdigest(),'newCreateSha256':hashlib.sha256(s.replace('public._work_cross_job_coverage()',admitted_coverage).encode()).hexdigest()} for n,o,s in replacements],indent=2)+'\n')
print('Generated held replacements',len(replacements))
