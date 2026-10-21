-- Held unit-contributors candidate. No payroll, source or prior ACL mutation.
-- Promotion requires a reviewed non-ROLLBACK migration and new exact receipts.
begin;
-- Namespace-only first preflight: unknown existing names/overloads must refuse.
do $namespace$ begin
 if exists(select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and (p.proname='work_unit_contributors_read' or starts_with(p.proname,'_work_unit_contributors_')))
 or exists(select 1 from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and starts_with(c.relname,'_work_unit_contributors_')) then
  raise exception using errcode='55000',message='Unit contributors source is unavailable.';
 end if;
end $namespace$;
do $$begin
 if not public._work_unit_review_coverage() or not public._work_totals_coverage() then
  raise exception using errcode='55000',message='Unit contributors source is unavailable.';
 end if;
end$$;

-- Validator copied from frozen0845 e0e74c2d; only interval provenance and zero
-- validation differ. Positive parity is tested at one supplied asOf, not twice
-- at runtime. Zero claims reach every identity/capture check before admission.
create function public._work_unit_contributors_shift(actor uuid,shift_id uuid,as_of timestamptz,p_cache jsonb default '{}'::jsonb) returns jsonb
language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare cache_key text;cache_entry jsonb;sh public.time_shifts;ps public.personal_activity_state;t record;n record;h jsonb;proof jsonb;sourceproof jsonb;meta public.work_session_capture_metadata;dv public.work_activity_definition_versions;
 item jsonb;beforej jsonb;afterj jsonb;claims jsonb:='[]';breaks jsonb:='[]';issues text[]:='{}';seen jsonb:='{}';tr jsonb;state jsonb;prior jsonb;
 start_at timestamptz;end_at timestamptz;finish timestamptz;break_end timestamptz;last_at timestamptz;v_source_kind text;table_kind text;v_source_id text;
 gross numeric;deduction numeric;placed numeric:=0;classified numeric:=0;setup numeric:=0;unknown numeric:=0;conflict numeric:=0;us numeric;overlap boolean;proven boolean:=true;live_allowed boolean:=false;mapping_complete boolean:=true;last_revision bigint;reconciliation_authorized boolean:=false;
begin
 if p_cache->>'actorId' is distinct from actor::text then p_cache:=jsonb_build_object('actorId',actor);end if;
 select * into sh from public.time_shifts where id=shift_id;
 if sh.id is null then return jsonb_build_object('availability','unavailable');end if;
 cache_key:='time_shifts:'||sh.id;cache_entry:=p_cache->cache_key;
 if cache_entry is null then
 proof:=public._work_totals_source('time_shifts',sh.id::text);
 cache_entry:=jsonb_build_object('proof',proof,'visible',public._work_totals_visible(actor,'time_shifts',proof),'reconciliation',public._work_totals_visible(actor,'time_shifts',proof,0,true));
 p_cache:=p_cache||jsonb_build_object(cache_key,cache_entry);
 end if;
 proof:=cache_entry->'proof';
 if not coalesce((cache_entry->>'visible')::boolean,false) then return jsonb_build_object('availability','unavailable');end if;
 proven:=coalesce((proof->>'proven')::boolean,false);
 reconciliation_authorized:=(cache_entry->>'reconciliation')::boolean;
 select * into ps from public.personal_activity_state where profile_id=sh.profile_id;
 -- No live extrapolation for somebody else, an ambiguous source, or old rows.
 live_allowed:=sh.profile_id=actor and sh.status='open' and sh.clock_out_at is null and ps.shift_id=sh.id and ps.integrity_state='clean'
 and ps.revision<9007199254740991 and not exists(select 1 from public.work_activity_safety_events where profile_id=sh.profile_id)
 and (select count(*) from public.time_shifts where profile_id=sh.profile_id and status='open' and clock_out_at is null)=1
 and (select count(*) from public._work_activity_live_sources(sh.profile_id))<=1
 and not exists(select 1 from public.work_activity_operations where actor_id=sh.profile_id)
 and as_of<sh.clock_in_at+make_interval(hours=>public.shift_cap_hours());
 finish:=case when sh.clock_out_at is not null then sh.clock_out_at when live_allowed then as_of else null end;
 if sh.status in ('needs_finish','rejected','voided') or sh.review_reason is not null then proven:=false;issues:=array_append(issues,'payroll_review');end if;
 if sh.clock_out_at is null then issues:=array_append(issues,case when live_allowed then 'own_live_provisional' else 'open_not_extrapolated' end);end if;
 if not proven then issues:=array_append(issues,'source_history_unproven');end if;
 if exists(select 1 from public.time_shifts s where s.profile_id=sh.profile_id and s.id<>sh.id and s.status<>'voided' and sh.status<>'voided'
 and s.clock_in_at<coalesce(sh.clock_out_at,as_of) and coalesce(s.clock_out_at,as_of)>sh.clock_in_at) then proven:=false;issues:=array_append(issues,'overlapping_payroll');end if;
 if exists(select 1 from public.work_activity_safety_events where profile_id=sh.profile_id) then proven:=false;issues:=array_append(issues,'source_safety');end if;
 -- Preserve exact break placement; scalar seconds cannot create an interval.
 for h in select value from jsonb_array_elements(proof->'history') loop
 beforej:=h->'before_value';afterj:=h->'after_value';
 if beforej->>'status' in ('needs_finish','rejected','voided') or afterj->>'status' in ('needs_finish','rejected','voided') then proven:=false;issues:=array_append(issues,'historical_payroll_review');end if;
 if beforej<>'{}' and (beforej->>'profile_id' is distinct from sh.profile_id::text or beforej->>'clock_in_at' is distinct from afterj->>'clock_in_at') then proven:=false;issues:=array_append(issues,'payroll_identity_or_start_changed');end if;
 if beforej->>'break_started_at' is not null and afterj->>'break_started_at' is null then
 break_end:=coalesce((afterj->>'clock_out_at')::timestamptz,(afterj->>'last_punch_at')::timestamptz);
 if break_end is null or break_end<(beforej->>'break_started_at')::timestamptz then proven:=false;issues:=array_append(issues,'break_placement_unknown');
 else breaks:=breaks||jsonb_build_array(jsonb_build_object('start',beforej->>'break_started_at','end',break_end));end if;
 end if;
 end loop;
 if sh.break_started_at is not null and finish is not null then breaks:=breaks||jsonb_build_array(jsonb_build_object('start',sh.break_started_at,'end',finish));end if;
 select trunc(coalesce(sum(extract(epoch from ((b->>'end')::timestamptz-(b->>'start')::timestamptz))*1000000),0)) into placed from jsonb_array_elements(breaks)b;
 deduction:=coalesce(sh.break_seconds,0)::numeric*1000000+case when sh.clock_out_at is null and sh.break_started_at is not null and live_allowed then greatest(0,floor(extract(epoch from (as_of-sh.break_started_at))))*1000000 else 0 end;
 if exists(select 1 from jsonb_array_elements(breaks) with ordinality a(v,n) join jsonb_array_elements(breaks) with ordinality b(v,n) on a.n<b.n
 where (a.v->>'start')::timestamptz<(b.v->>'end')::timestamptz and (b.v->>'start')::timestamptz<(a.v->>'end')::timestamptz) then proven:=false;issues:=array_append(issues,'overlapping_breaks');end if;
 if placed<>deduction then issues:=array_append(issues,'break_policy_adjustment');end if;
 -- Permission-check every typed child and original parent before any ledger.
 for n in select distinct s.source_kind,s.source_id from public.personal_activity_transition_sources s where s.source_shift_id=sh.id loop
 table_kind:=case n.source_kind when 'custom' then 'custom_work_sessions' when 'unit' then 'unit_sessions' when 'task' then 'task_sessions' when 'service' then 'service_time_sessions' when 'phase' then 'opening_phases' when 'setup' then 'work_setup_sessions' when 'shift' then 'time_shifts' end;
 if table_kind is null then continue;end if;
 cache_key:=table_kind||':'||n.source_id;cache_entry:=p_cache->cache_key;
 if cache_entry is null then
 sourceproof:=public._work_totals_source(table_kind,n.source_id::text);
 cache_entry:=jsonb_build_object('proof',sourceproof,'visible',public._work_totals_visible(actor,table_kind,sourceproof),'reconciliation',public._work_totals_visible(actor,table_kind,sourceproof,0,true));
 p_cache:=p_cache||jsonb_build_object(cache_key,cache_entry);
 end if;
 sourceproof:=cache_entry->'proof';
 if not coalesce((cache_entry->>'visible')::boolean,false) then return jsonb_build_object('availability','unavailable');end if;
 reconciliation_authorized:=reconciliation_authorized and (cache_entry->>'reconciliation')::boolean;
 if octet_length(p_cache::text)>5000000 then return jsonb_build_object('availability','unavailable');end if;
 seen:=seen||jsonb_build_object(n.source_kind||':'||n.source_id,sourceproof);
 end loop;
 select coalesce(jsonb_agg(to_jsonb(q) order by revision_after),'[]') into tr from public.personal_activity_transitions q where q.profile_id=sh.profile_id and q.source_shift_id=sh.id
 and (q.before_evidence#>>'{state,shift_id}'=sh.id::text or q.after_evidence#>>'{state,shift_id}'=sh.id::text);
 if jsonb_array_length(tr)>5000 or octet_length(tr::text)>5000000 then return jsonb_build_object('availability','unavailable');end if;
 if jsonb_array_length(tr)=0 then proven:=false;issues:=array_append(issues,'transition_history_missing');end if;
 for t in select x.value v,x.ordinality ord from jsonb_array_elements(tr) with ordinality x loop
 start_at:=(t.v->>'selected_effective_at')::timestamptz;state:=t.v#>'{after_evidence,state}';
 if t.ord=1 and (t.v->>'cause'<>'clock_in' or start_at<>sh.clock_in_at) then proven:=false;issues:=array_append(issues,'transition_origin_missing');end if;
 if prior is not null and ((t.v->>'revision_before')::bigint<>last_revision or ((t.v#>'{before_evidence,state}')-'updated_at') is distinct from (prior-'updated_at') or start_at<last_at) then proven:=false;issues:=array_append(issues,'transition_chain_broken');end if;
 if (t.v->>'revision_after')::bigint<>(t.v->>'revision_before')::bigint+1 or t.v->>'review_reason' is not null or t.v->>'supersedes_transition_id' is not null then proven:=false;issues:=array_append(issues,'transition_review');end if;
 prior:=state;last_revision:=(t.v->>'revision_after')::bigint;last_at:=start_at;
 end_at:=case when t.ord<jsonb_array_length(tr) then (tr->(t.ord::integer)->>'selected_effective_at')::timestamptz else finish end;
 if end_at is null then continue;end if;
 if end_at<start_at then proven:=false;issues:=array_append(issues,'negative_interval');continue;end if;
 if start_at<sh.clock_in_at or (finish is not null and end_at>finish) then proven:=false;issues:=array_append(issues,'outside_payroll');continue;end if;
 us:=trunc(extract(epoch from(end_at-start_at))*1000000);
 v_source_kind:=state->>'active_source_kind';v_source_id:=state->>'active_source_id';
 select exists(select 1 from jsonb_array_elements(breaks)b where (b->>'start')::timestamptz<end_at and (b->>'end')::timestamptz>start_at) into overlap;
 if overlap then
 if v_source_id is not null then proven:=false;issues:=array_append(issues,'activity_during_break');end if;
 continue;
 end if;
 if v_source_id is null then unknown:=unknown+us;continue;end if;
 sourceproof:=seen->(v_source_kind||':'||v_source_id);
 if sourceproof is null or not coalesce((sourceproof->>'proven')::boolean,false) or state->>'integrity_state'<>'clean' or state->>'shift_id' is distinct from sh.id::text then unknown:=unknown+us;mapping_complete:=false;issues:=array_append(issues,'activity_source_unproven');continue;end if;
 -- The retained source must still describe this same person and interval.
 -- Reused UUIDs and reviewed edits are not repaired by a matching old event.
 if sourceproof->'current'='{}' or sourceproof#>>'{current,profile_id}' is distinct from sh.profile_id::text
 or (sourceproof#>>'{current,started_at}')::timestamptz>start_at
 or (sourceproof#>>'{current,ended_at}' is not null and (sourceproof#>>'{current,ended_at}')::timestamptz<end_at)
 or sourceproof#>>'{current,review_required}'='true'
 or (select count(*) from jsonb_array_elements(sourceproof->'history') x where x->'before_value'='{}')<>1
 or exists(select 1 from jsonb_array_elements(sourceproof->'history') x where x->'after_value'='{}'
 or (x->'before_value'<>'{}' and (x#>'{before_value,profile_id}' is distinct from x#>'{after_value,profile_id}'
 or x#>'{before_value,started_at}' is distinct from x#>'{after_value,started_at}'
 or (x#>>'{before_value,ended_at}' is not null and x#>'{before_value,ended_at}' is distinct from x#>'{after_value,ended_at}')))) then
 unknown:=unknown+us;mapping_complete:=false;issues:=array_append(issues,'source_interval_changed');continue;end if;
 -- A normal transition child at this boundary must name the effective source.
 if not exists(select 1 from public.personal_activity_transition_sources e join public.personal_activity_transitions et on et.id=e.transition_id where et.revision_after<=(t.v->>'revision_after')::bigint and e.profile_id=sh.profile_id and e.source_kind=v_source_kind and e.source_id=v_source_id::uuid and e.source_shift_id=sh.id) then unknown:=unknown+us;mapping_complete:=false;issues:=array_append(issues,'effective_source_unlinked');continue;end if;
 if v_source_kind='setup' then setup:=setup+us;continue;end if;
 if v_source_kind<>'custom' then unknown:=unknown+us;mapping_complete:=false;issues:=array_append(issues,'legacy_activity_unmapped');continue;end if;
 select * into meta from public.work_session_capture_metadata where session_id=v_source_id::uuid;
 if meta.session_id is null then unknown:=unknown+us;mapping_complete:=false;issues:=array_append(issues,'capture_metadata_missing');continue;end if;
 cache_key:='work_session_capture_metadata:'||v_source_id;cache_entry:=p_cache->cache_key;
 if cache_entry is null then
 h:=public._work_totals_source('work_session_capture_metadata',v_source_id);
 cache_entry:=jsonb_build_object('proof',h);p_cache:=p_cache||jsonb_build_object(cache_key,cache_entry);
 end if;
 h:=cache_entry->'proof';
 if octet_length(p_cache::text)>5000000 then return jsonb_build_object('availability','unavailable');end if;
 if not public._work_totals_visible(actor,'work_session_capture_metadata',h) then return jsonb_build_object('availability','unavailable');end if;
 reconciliation_authorized:=reconciliation_authorized and public._work_totals_visible(actor,'work_session_capture_metadata',h,0,true);
 select * into dv from public.work_activity_definition_versions where id=meta.definition_version_id;
 if not coalesce((h->>'proven')::boolean,false) or meta.profile_id<>sh.profile_id or dv.id is null or dv.scope<>meta.scope
 or not exists(select 1 from public.work_job_menu_selections s where s.id=meta.selection_id and s.project_id=meta.project_id and s.revision=meta.selection_revision and s.menu_version_id=meta.menu_version_id)
 or not public._work_totals_capture(meta,sh.id) then
 unknown:=unknown+us;mapping_complete:=false;issues:=array_append(issues,'capture_lineage_unproven');continue;end if;
 if meta.scope='specific' and (meta.unit_basis is null or not exists(select 1 from public.work_unit_fact_revisions f where f.id=(meta.unit_facts->>'factId')::uuid
 and f.unit_id=meta.unit_id and f.revision=meta.fact_revision and f.unit_incarnation_epoch=(meta.unit_basis->>'incarnationEpoch')::bigint
 and f.unit_incarnation_epoch=public._work_unit_fact_peek_epoch('unit_incarnation',meta.unit_id))) then
 unknown:=unknown+us;mapping_complete:=false;issues:=array_append(issues,'captured_unit_identity_unproven');continue;end if;
 -- Cross-job work is justified by that immutable applied server command, not
 -- by equality with today's mutable payroll project or a client boolean.
 claims:=claims||jsonb_build_array(jsonb_build_object('intervalId',t.v->>'id','shiftId',sh.id,'sourceId',v_source_id,'startedAt',public._work_activity_iso(start_at),'endedAt',public._work_activity_iso(end_at),'unitIncarnation',meta.unit_basis->>'incarnationEpoch','profileId',sh.profile_id,'projectId',meta.project_id,'unitId',meta.unit_id,'definitionId',dv.definition_id,'definitionVersionId',dv.id,'definitionVersion',dv.version,'scope',meta.scope,'labelEn',dv.label_en,'labelEs',dv.label_es,'machineKind',meta.machine_kind,'microseconds',us::text,'live',sh.clock_out_at is null and t.ord=jsonb_array_length(tr)));
 classified:=classified+us;
 end loop;
 if live_allowed and ((to_jsonb(ps)-'updated_at') is distinct from (prior-'updated_at')
 or not exists(select 1 from public.personal_activity_transitions e where e.id=ps.last_transition_id and e.profile_id=sh.profile_id and e.revision_after=ps.revision)
 or (ps.active_source_id is not null and not exists(select 1 from public._work_activity_live_sources(sh.profile_id) l where l.source_id=ps.active_source_id and l.source_kind=ps.active_source_kind and l.shift_id=sh.id))
 or (ps.active_source_id is null and exists(select 1 from public._work_activity_live_sources(sh.profile_id)))) then proven:=false;issues:=array_append(issues,'live_state_unconfirmed');end if;
 if sh.clock_out_at is not null and (last_at is distinct from sh.clock_out_at or prior->>'shift_id'=sh.id::text) then proven:=false;issues:=array_append(issues,'transition_close_missing');end if;
 if finish is not null then gross:=trunc(extract(epoch from(finish-sh.clock_in_at))*1000000);else gross:=null;end if;
 if gross is not null and gross<>classified+setup+unknown+placed then proven:=false;issues:=array_append(issues,'partition_mismatch');end if;
 if gross is not null and (gross<deduction or gross<0) then proven:=false;issues:=array_append(issues,'invalid_payroll');end if;
 if not proven then claims:='[]';classified:=0;setup:=0;unknown:=case when gross is not null then greatest(0,gross-placed) else 0 end;end if;
 return jsonb_build_object('proofCache',p_cache,'availability','available','profileId',sh.profile_id,'shiftId',sh.id,'proven',proven,'complete',proven and finish is not null and mapping_complete,
 'reconciliationAuthorized',reconciliation_authorized,'approved',sh.status='approved' and sh.clock_out_at is not null,'claims',claims,'issues',to_jsonb(array(select distinct unnest(issues))),
 'grossMicros',gross::text,'payrollMicros',(gross-deduction)::text,'classifiedMicros',classified::text,'setupMicros',setup::text,'unclassifiedMicros',unknown::text,
 'breakElapsedMicros',placed::text,'breakDeductionMicros',deduction::text,'policyAdjustmentMicros',(placed-deduction)::text);
end$$;
revoke all on function public._work_unit_contributors_shift(uuid,uuid,timestamptz,jsonb) from public,anon,authenticated,service_role;

create function public._work_unit_contributors_person(p_profile uuid,p_claims jsonb,p_reasons text[],p_unit_micros numeric,p_unit_reasons text[]) returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare person record;identity_found boolean;micros numeric;live boolean;activities jsonb;reasons text[]:=p_reasons;share_reasons text[]:=p_unit_reasons;
begin
 select display_name,retired_at into person from public.profiles where id=p_profile;
 identity_found:=found;
 if not identity_found then reasons:=array_append(reasons,'identity_unproven');end if;
 if length(person.display_name)>500 then return null;end if;
 -- Match the strict wire's UTF-16 length bound, including astral characters.
 if (select coalesce(sum(case when ascii(ch)>65535 then 2 else 1 end),0) from regexp_split_to_table(person.display_name,'')ch)>500 then return null;end if;
 select coalesce(sum((c->>'microseconds')::numeric),0),coalesce(bool_or((c->>'live')::boolean and (c->>'microseconds')::numeric>0),false) into micros,live
 from jsonb_array_elements(p_claims)c where c->>'profileId'=p_profile::text;
 with claims as(select c from jsonb_array_elements(p_claims)c where c->>'profileId'=p_profile::text),
 grouped as(select c->>'definitionId' definition_id,c->>'definitionVersionId' version_id,c->>'definitionVersion' version,c->>'labelEn' en,c->>'labelEs' es,sum((c->>'microseconds')::numeric) us
 from claims group by 1,2,3,4,5)
 select coalesce(jsonb_agg(jsonb_build_object('definitionId',g.definition_id,'definitionVersionId',g.version_id,'definitionVersion',g.version::integer,
 'labelEn',g.en,'labelEs',g.es,'retired',d.retired_at is not null,'knownMicros',g.us::text,
 'machineSubsets',(select coalesce(jsonb_agg(jsonb_build_object('machineKind',m.kind,'knownMicros',m.us::text) order by m.kind),'[]') from (
 select c->>'machineKind' kind,sum((c->>'microseconds')::numeric) us from claims where c->>'definitionVersionId'=g.version_id and c->>'machineKind' is not null group by 1)m)) order by g.definition_id,g.version::integer),'[]')
 into activities from grouped g join public.work_activity_definitions d on d.id=g.definition_id::uuid;
 select coalesce(array_agg(distinct r order by r),'{}') into reasons from unnest(reasons)r;
 if micros=0 then reasons:=array_append(reasons,'zero');end if;
 if p_unit_micros=0 then share_reasons:=array_append(share_reasons,'zero');end if;
 select coalesce(array_agg(distinct r order by r),'{}') into share_reasons from unnest(share_reasons)r;
 return jsonb_build_object('profileId',p_profile,'displayName',nullif(btrim(person.display_name),''),'nameState',case when nullif(btrim(person.display_name),'') is null then 'unavailable' else 'current' end,
 'retired',case when not identity_found then null else person.retired_at is not null end,'knownMicros',micros::text,
 'complete',not exists(select 1 from unnest(reasons)r where r<>'zero'),'completenessReasons',to_jsonb(reasons),'includesLive',live,
 'measurementState',case when micros>0 then 'recorded' when jsonb_array_length(activities)>0 then 'recorded_zero' else 'unproven' end,'activities',activities,
 'share',case when cardinality(share_reasons)=0 then jsonb_build_object('state','available','numeratorMicros',micros::text,'denominatorMicros',p_unit_micros::text)
 else jsonb_build_object('state','unavailable','reasons',to_jsonb(share_reasons)) end);
end$$;
revoke all on function public._work_unit_contributors_person(uuid,jsonb,text[],numeric,text[]) from public,anon,authenticated,service_role;

create function public.work_unit_contributors_read(p_project_id uuid,p_unit_id uuid,p_protocol_version integer default 1) returns jsonb
language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare actor uuid;stamp timestamptz;u public.custom_work_units;s jsonb;review jsonb;ids uuid[];sid uuid;ledger jsonb;proof_cache jsonb:='{}';ledgers jsonb:='[]';claims jsonb;v jsonb;w jsonb;r jsonb;n jsonb;
 reasons text[]:='{}';row_reasons text[];subject uuid;subjects uuid[];person jsonb;people jsonb:='[]';zero_only jsonb:='[]';named jsonb:='[]';untimed jsonb:='[]';entries jsonb;
 micros numeric;positive boolean;uncertain boolean;named_person boolean;live boolean;proof_bytes bigint:=0;
 unavailable constant jsonb:='{"protocolVersion":1,"availability":"unavailable","contributors":null}';
begin
 perform public._work_activity_read_committed();perform public._work_activity_gate();actor:=public._work_activity_actor();
 if not public._work_config_is_supervisor(actor) then raise exception using errcode='42501',message='A current supervisor or owner is required.';end if;
 perform pg_advisory_xact_lock(7710,0);actor:=public._work_activity_actor();
 if not public._work_config_is_supervisor(actor) then raise exception using errcode='42501',message='A current supervisor or owner is required.';end if;
 stamp:=clock_timestamp();
 if p_protocol_version is distinct from 1 or p_project_id is null or p_unit_id is null then raise exception using errcode='23514',message='A valid unit contributors request is required.';end if;
 if not public._ai_job_visible(p_project_id,actor) or not public._work_unit_review_coverage() or not public._work_totals_coverage() or not public._work_unit_contributors_coverage() then return unavailable;end if;
 select * into u from public.custom_work_units where id=p_unit_id;
 if u.id is null or u.project_id is distinct from p_project_id then return unavailable;end if;
 s:=public._work_unit_review_scope(actor,p_unit_id);if s is null then return unavailable;end if;
 review:=public._work_unit_review_view(actor,s);if review is null then return unavailable;end if;
 if not coalesce((s->>'proven')::boolean,false) then reasons:=array_append(reasons,'source_unproven');end if;
 if exists(select 1 from jsonb_array_elements(s#>'{manifest,history}')h where h->>'source_kind' in ('custom_work_sessions','unit_sessions','task_sessions','service_time_sessions','summon_helpers')
 and not exists(select 1 from jsonb_array_elements(s#>'{manifest,transitions}')t where t#>>'{source,source_id}'=h->>'source_id' and t#>>'{source,source_shift_id}' is not null)) then reasons:=array_append(reasons,'legacy_unmapped');end if;
 -- One distinct-shift assembly. No public v1 call, person fanout or new clock.
 select array_agg(id order by id) into ids from (
 select distinct id from (
 select c.shift_id id from public.custom_work_sessions c where c.unit_id=p_unit_id
 union select c.shift_id from public.custom_work_sessions c join public.work_session_capture_metadata m on m.session_id=c.id where m.unit_id=p_unit_id
 union select (h.before_value->>'shift_id')::uuid from public.work_activity_source_history h where h.source_kind='custom_work_sessions' and h.before_value->>'unit_id'=p_unit_id::text
 union select (h.after_value->>'shift_id')::uuid from public.work_activity_source_history h where h.source_kind='custom_work_sessions' and h.after_value->>'unit_id'=p_unit_id::text
 union select (t#>>'{source,source_shift_id}')::uuid from jsonb_array_elements(s#>'{manifest,transitions}')t
 )all_ids where id is not null limit 501)bounded;
 if coalesce(cardinality(ids),0)>500 then return unavailable;end if;
 if (select count(*) from(select 1 from public.personal_activity_transitions where source_shift_id=any(ids) limit 10001)x)>10000
 or (select count(*) from(select 1 from public.personal_activity_transition_sources where source_shift_id=any(ids) limit 10001)x)>10000 then return unavailable;end if;
 foreach sid in array coalesce(ids,'{}') loop
 ledger:=public._work_unit_contributors_shift(actor,sid,stamp,proof_cache);
 if ledger->>'availability'<>'available' then return unavailable;end if;
 proof_cache:=ledger->'proofCache';ledger:=ledger-'proofCache';
 if octet_length(proof_cache::text)>5000000 then return unavailable;end if;
 proof_bytes:=proof_bytes+octet_length(ledger::text);if proof_bytes>5000000 then return unavailable;end if;
 ledgers:=ledgers||jsonb_build_array(ledger);
 if not coalesce((ledger->>'complete')::boolean,false) then reasons:=array_append(reasons,'source_unproven');end if;
 if ledger->'issues' ?| array['open_not_extrapolated','own_live_provisional'] then reasons:=array_append(reasons,'open_shift');end if;
 if ledger->'issues' ? 'legacy_activity_unmapped' then reasons:=array_append(reasons,'legacy_unmapped');end if;
 if ledger->'issues' ? 'negative_interval' then reasons:=array_append(reasons,'negative_interval');end if;
 end loop;
 -- Match v1 positive scope exactly; zero is additional validated audit evidence.
 select coalesce(jsonb_agg(c order by c->>'profileId',c->>'shiftId',c->>'intervalId'),'[]') into claims
 from jsonb_array_elements(ledgers)l cross join lateral jsonb_array_elements(l->'claims')c
 where c->>'scope'='specific' and c->>'unitId'=p_unit_id::text;
 if exists(select 1 from jsonb_array_elements(claims)c group by c->>'shiftId',c->>'intervalId' having count(*)<>1)
 or exists(select 1 from jsonb_array_elements(claims)c where c->>'microseconds' !~ '^(0|[1-9][0-9]{0,39})$'
 or c->>'unitIncarnation' is distinct from s#>>'{manifest,incarnation}') then return unavailable;end if;
 -- Named work is never assigned time. Current effective links control display;
 -- retained originals already participate in the complete permission closure.
 for v in select value from jsonb_array_elements(s#>'{manifest,current}') loop
 w:=v->'value';subject:=null;n:=null;
 if v->>'kind'='crew_work_record_people' and w->>'voided_at' is null then
 select x->'value' into r from jsonb_array_elements(s#>'{manifest,current}')x where x->>'kind'='crew_work_records' and x->>'id'=w->>'record_id';
 if r->>'unit_id'=p_unit_id::text and r->>'outcome' in ('partial','finished') then subject:=(w->>'profile_id')::uuid;n:=jsonb_build_object('sourceKind','crew_work_record_people','sourceId',v->>'id','workDate',r->>'work_date','recordedAt',null,'activityLabel',r->>'stage','evidenceState','named');end if;
 elsif v->>'kind'='opening_phases' and w->>'started_by' is not null and w->>'started_at' is not null then
 if w->>'opening_id' is distinct from u.opening_id::text then reasons:=array_append(reasons,'source_unproven');continue;end if;
 -- An exact accepted transition child is corroboration, not extra named work.
 if not exists(select 1 from jsonb_array_elements(s#>'{manifest,transitions}')t join jsonb_array_elements(claims)c on c->>'intervalId'=t#>>'{source,transition_id}' and c->>'profileId'=w->>'started_by'
 where t#>>'{source,source_kind}'='phase' and t#>>'{source,source_id}'=v->>'id') then
 subject:=(w->>'started_by')::uuid;n:=jsonb_build_object('sourceKind','opening_phases','sourceId',v->>'id','workDate',((w->>'started_at')::timestamptz at time zone 'America/Denver')::date::text,'recordedAt',public._work_activity_iso((w->>'started_at')::timestamptz),'activityLabel',w->>'kind','evidenceState','named');end if;
 elsif v->>'kind'='install_events' and w->>'installer_id' is not null and w->>'voided_at' is null then
 if w->>'project_opening_id' is distinct from u.opening_id::text then reasons:=array_append(reasons,'source_unproven');continue;end if;
 subject:=(w->>'installer_id')::uuid;n:=jsonb_build_object('sourceKind','install_events','sourceId',v->>'id','workDate',case when w->>'started_at' is not null then ((w->>'started_at')::timestamptz at time zone 'America/Denver')::date::text end,'recordedAt',public._work_activity_iso((w->>'started_at')::timestamptz),'activityLabel','Install (legacy)','evidenceState','named');
 elsif v->>'kind'='qc_checks' and w->>'checked_by' is not null and w->>'checked_at' is not null then
 if w->>'project_opening_id' is distinct from u.opening_id::text then reasons:=array_append(reasons,'source_unproven');continue;end if;
 subject:=(w->>'checked_by')::uuid;n:=jsonb_build_object('sourceKind','qc_checks','sourceId',v->>'id','workDate',((w->>'checked_at')::timestamptz at time zone 'America/Denver')::date::text,'recordedAt',public._work_activity_iso((w->>'checked_at')::timestamptz),'activityLabel','Quality review','evidenceState','named');
 end if;
 if subject is not null then
 if (n->>'recordedAt')::timestamptz>stamp or (n->>'workDate')::date>(stamp at time zone 'America/Denver')::date then
 reasons:=array_append(reasons,'source_unproven');
 else named:=named||jsonb_build_array(jsonb_build_object('profileId',subject,'evidence',n));end if;
 end if;
 if jsonb_array_length(named)>4000 then return unavailable;end if;
 end loop;
 for r in select to_jsonb(e) from public.work_unit_review_events e where e.unit_id=p_unit_id and e.incarnation=(s#>>'{manifest,incarnation}')::bigint and e.action in ('pass','fail') loop
 named:=named||jsonb_build_array(jsonb_build_object('profileId',r->>'actor_id','evidence',jsonb_build_object('sourceKind','work_unit_review_events','sourceId',r->>'id','workDate',((r->>'recorded_at')::timestamptz at time zone 'America/Denver')::date::text,'recordedAt',public._work_activity_iso((r->>'recorded_at')::timestamptz),'activityLabel','Quality review','evidenceState','named')));
 if jsonb_array_length(named)>4000 then return unavailable;end if;
 end loop;
 if named<>'[]' then reasons:=array_append(reasons,'named_unlinked');end if;
 -- Include uncertainty subjects without inventing their measured amounts.
 select array_agg(profile order by profile) into subjects from (
 select distinct profile from (
 select (c->>'profileId')::uuid profile from jsonb_array_elements(claims)c
 union select (n.value->>'profileId')::uuid from jsonb_array_elements(named)n
 union select (h.value->>'profile_id')::uuid from jsonb_array_elements(s#>'{manifest,history}')x cross join lateral(values(x->'before_value'),(x->'after_value'))h(value)
 where x->>'source_kind' in ('custom_work_sessions','unit_sessions','task_sessions','service_time_sessions','summon_helpers')
 )p where profile is not null limit 201)bounded;
 if coalesce(cardinality(subjects),0)>200 then return unavailable;end if;
 if exists(select 1 from unnest(subjects)p where not exists(select 1 from public.profiles where id=p)) then reasons:=array_append(reasons,'identity_unproven');end if;
 select coalesce(array_agg(distinct rr.code order by rr.code),'{}') into reasons from unnest(reasons)rr(code);
 select coalesce(sum((c->>'microseconds')::numeric),0),coalesce(bool_or((c->>'live')::boolean and (c->>'microseconds')::numeric>0),false) into micros,live from jsonb_array_elements(claims)c;
 foreach subject in array coalesce(subjects,'{}') loop
 named_person:=exists(select 1 from jsonb_array_elements(named)n where n.value->>'profileId'=subject::text);
 positive:=exists(select 1 from jsonb_array_elements(claims)c where c->>'profileId'=subject::text and (c->>'microseconds')::numeric>0);
 uncertain:=not exists(select 1 from jsonb_array_elements(claims)c where c->>'profileId'=subject::text)
 and exists(select 1 from jsonb_array_elements(s#>'{manifest,history}')x cross join lateral(values(x->'before_value'),(x->'after_value'))h(value)
 where x->>'source_kind' in ('custom_work_sessions','unit_sessions','task_sessions','service_time_sessions','summon_helpers') and h.value->>'profile_id'=subject::text);
 row_reasons:=reasons;
 person:=public._work_unit_contributors_person(subject,claims,row_reasons,micros,reasons);if person is null then return unavailable;end if;
 if positive or uncertain then people:=people||jsonb_build_array(person);
 elsif exists(select 1 from jsonb_array_elements(claims)c where c->>'profileId'=subject::text) then
 -- Only an actual validated timer claim enters this branch. Pure named work
 -- without a claim or retained timer stays untimed-only, even on partial units.
 -- A zero audit requires complete, closed proof; zero elapsed time alone is
 -- insufficient. Uncertain zero claims cannot create a worked/tap count.
 if (person->>'complete')::boolean and person->>'measurementState'='recorded_zero' and not (person->>'includesLive')::boolean then
 person:=jsonb_set(person,'{share}',jsonb_build_object('state','unavailable','reasons',jsonb_build_array('zero')));
 zero_only:=zero_only||jsonb_build_array(person);
 else
 person:=person||jsonb_build_object('measurementState','unproven','activities','[]'::jsonb,'includesLive',false,'complete',false);
 people:=people||jsonb_build_array(person);
 end if;
 end if;
 if named_person then
 select jsonb_agg(n.value->'evidence' order by n.value#>>'{evidence,sourceKind}',n.value#>>'{evidence,sourceId}') into entries from jsonb_array_elements(named)n where n.value->>'profileId'=subject::text;
 untimed:=untimed||jsonb_build_array(jsonb_build_object('profileId',subject,'displayName',person->'displayName','nameState',person->'nameState','retired',person->'retired','evidence',entries));
 end if;
 end loop;
 if exists(select 1 from jsonb_array_elements(people)p where p->>'measurementState'='unproven') and cardinality(reasons)=0 then return unavailable;end if;
 select coalesce(jsonb_agg(p order by (p->>'knownMicros')::numeric desc,p->>'profileId'),'[]') into people from jsonb_array_elements(people)p;
 if (select coalesce(sum((p->>'knownMicros')::numeric),0) from jsonb_array_elements(people)p)<>micros then return unavailable;end if;
 if (select coalesce(sum(jsonb_array_length(p->'activities')),0) from jsonb_array_elements(people||zero_only)p)>2000 then return unavailable;end if;
 n:=jsonb_build_object('asOf',public._work_activity_iso(stamp),'actorId',actor,'projectId',p_project_id,'unitId',p_unit_id,'unitIncarnation',s#>>'{manifest,incarnation}',
 'window',jsonb_build_object('kind','all_retained_selected_unit','from',null,'until',public._work_activity_iso(stamp)),
 'unitKnownMicros',micros::text,'unitComplete',cardinality(reasons)=0,'completenessReasons',to_jsonb(case when micros=0 then reasons||array['zero'] else reasons end),'includesLive',live,
 'people',people,'zeroOnly',zero_only,'untimedParticipants',untimed,
 'participantCounts',jsonb_build_object('timed',(select count(*) from jsonb_array_elements(people)p where (p->>'knownMicros')::numeric>0),'timingUncertain',(select count(*) from jsonb_array_elements(people)p where p->>'measurementState'='unproven'),'untimedOnly',(select count(*) from jsonb_array_elements(untimed)n where not exists(select 1 from jsonb_array_elements(people)p where p->>'profileId'=n.value->>'profileId')),'zeroOnly',jsonb_array_length(zero_only),'total',(select count(distinct x->>'profileId') from jsonb_array_elements(people||untimed)x)),
 'unresolvedAttribution',jsonb_build_object('present',cardinality(reasons)>0,'unknownMicros',case when cardinality(reasons)=0 then '0' end,'reasons',to_jsonb(reasons)));
 if octet_length(n::text)>1000000 then return unavailable;end if;
 return jsonb_build_object('protocolVersion',1,'availability','available','contributors',n);
end$$;
revoke all on function public.work_unit_contributors_read(uuid,uuid,integer) from public,anon,authenticated,service_role;
grant execute on function public.work_unit_contributors_read(uuid,uuid,integer) to authenticated;

-- CONTRIBUTORS_COVERAGE_BEGIN
create function public._work_unit_contributors_coverage() returns boolean
language sql stable security definer set search_path=public,pg_temp as $coverage$
 select encode(sha256(convert_to(c.value::text,'UTF8')),'hex')='7393250af69c54b5688370fb7cfb53ef5f5138f11c799f07445d6367e2a201c8' from (select jsonb_build_object('namespaceRelations',(select coalesce(jsonb_agg(jsonb_build_object('name',c.relname,'kind',c.relkind) order by c.relname),'[]') from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and starts_with(c.relname,'_work_unit_contributors_')),'namespace',(select coalesce(jsonb_agg(jsonb_build_object('name',p.proname,'args',pg_get_function_identity_arguments(p.oid)) order by p.proname,pg_get_function_identity_arguments(p.oid)),'[]') from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and (p.proname='work_unit_contributors_read' or starts_with(p.proname,'_work_unit_contributors_'))),
 'functions',(select jsonb_agg(jsonb_build_object('name',p.proname,'args',pg_get_function_identity_arguments(p.oid),'language',(select lanname from pg_language where oid=p.prolang),'kind',p.prokind,'result',pg_get_function_result(p.oid),'defaults',pg_get_expr(p.proargdefaults,0),'strict',p.proisstrict,'parallel',p.proparallel,'body',encode(sha256(convert_to(p.prosrc,'UTF8')),'hex'),'config',p.proconfig,'owner',pg_get_userbyid(p.proowner),'definer',p.prosecdef,'volatility',p.provolatile) order by p.proname,pg_get_function_identity_arguments(p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=any(array['_ai_job_visible','_is_supervisor','_work_activity_actor','_work_activity_answers','_work_activity_authority_changed','_work_activity_authority_guard','_work_activity_authority_revision','_work_activity_bookkeeping_guard','_work_activity_claim_clock_setup','_work_activity_clock_replay_guard','_work_activity_clock_review','_work_activity_clock_setup_digest','_work_activity_close_all','_work_activity_close_source','_work_activity_command_basis','_work_activity_consume','_work_activity_context_assert','_work_activity_context_close','_work_activity_context_commit_guard','_work_activity_context_for','_work_activity_context_guard','_work_activity_context_open','_work_activity_ensure_state','_work_activity_ephemeral_commit_guard','_work_activity_establish_payload','_work_activity_establish_stream','_work_activity_event','_work_activity_evidence','_work_activity_expect','_work_activity_expected_guard','_work_activity_fact_snapshot','_work_activity_finish','_work_activity_gate','_work_activity_insert_source','_work_activity_instant','_work_activity_integer','_work_activity_iso','_work_activity_keep_clock_receipt','_work_activity_live_sources','_work_activity_no_truncate','_work_activity_object','_work_activity_observe','_work_activity_operation','_work_activity_operation_enter','_work_activity_operation_exit','_work_activity_parent_gate','_work_activity_parent_source_history','_work_activity_payload','_work_activity_profile_delete_guard','_work_activity_project_view','_work_activity_read_committed','_work_activity_refresh_state','_work_activity_resume','_work_activity_retain_source','_work_activity_review_visit','_work_activity_row_allowance','_work_activity_row_before','_work_activity_row_event','_work_activity_safety_exit','_work_activity_safety_guard','_work_activity_setup_guard','_work_activity_setup_ledger_guard','_work_activity_shift_lifecycle','_work_activity_source_material','_work_activity_source_view','_work_activity_start_setup','_work_activity_statement_begin','_work_activity_statement_end','_work_activity_stream_guard','_work_activity_touch','_work_activity_transition_source_guard','_work_activity_unit_basis','_work_activity_uuid','_work_activity_validate_switch','_work_config_can_manage_menu','_work_config_internal','_work_config_is_foreman','_work_config_is_owner','_work_config_is_supervisor','_work_config_replay','_work_config_store_receipt','_work_config_validate_menu_draft_items','_work_config_validate_typed_fields','_work_totals_capture','_work_totals_coverage','_work_totals_shift','_work_totals_source','_work_totals_visible','_work_unit_contributors_person','_work_unit_contributors_shift','_work_unit_fact_context_visible','_work_unit_review_authority','_work_unit_review_coverage','_work_unit_review_defect_projection','_work_unit_review_scope','_work_unit_review_view','clock_in','clock_out','custom_work_internal','end_break','is_partner_user','is_sandbox_project','is_test_profile','person_record_counts','service_job_access','shift_cap_hours','start_break','work_activity_command','work_activity_snapshot','work_activity_totals_read','work_capture_immutable_record','work_publish_activity_version','work_publish_menu_version','work_select_job_menu','work_unit_contributors_read'])),
 'triggers',(select jsonb_agg(jsonb_build_object('table',c.relname,'name',t.tgname,'definition',pg_get_triggerdef(t.oid,true),'enabled',t.tgenabled) order by c.relname,t.tgname) from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname=any(array['time_shifts','personal_activity_state','personal_activity_transition_sources','personal_activity_transitions','work_activity_safety_events','work_unit_fact_revisions','work_unit_fact_current','work_unit_fact_context_epochs','custom_work_units','project_openings','service_visit_units','service_visits','summons','unit_redos','qc_checks','install_events','crew_work_records','crew_work_record_people','work_session_capture_metadata','custom_work_history','custom_work_sessions','unit_sessions','task_sessions','service_time_sessions','opening_phases','summon_helpers','work_activity_source_history','work_unit_review_commands','work_unit_dimension_verifications','work_unit_review_events','work_unit_review_current','work_unit_review_defects','work_unit_review_defect_events','work_setup_sessions','personal_activity_commands','work_activity_definitions','work_activity_definition_versions','work_capture_menus','work_capture_menu_versions','work_capture_menu_items','work_job_menu_selections','profiles','projects','sandbox_projects','work_job_management_grants']) and not t.tgisinternal),
 'columns',(select jsonb_agg(jsonb_build_object('table',c.relname,'column',a.attname,'type',format_type(a.atttypid,a.atttypmod),'nullable',not a.attnotnull,'notNullValidated',coalesce(nn.validated,true),'notNullEnforced',coalesce(nn.enforced,true),'notNullNoInherit',coalesce(nn.no_inherit,false),'generated',a.attgenerated,'identity',a.attidentity) order by c.relname,a.attnum) from pg_class c join pg_namespace n on n.oid=c.relnamespace join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped left join lateral (select bool_and(k.convalidated) validated,bool_and(coalesce((to_jsonb(k)->>'conenforced')::boolean,true)) enforced,bool_or(k.connoinherit) no_inherit from pg_constraint k where k.conrelid=a.attrelid and k.contype='n' and a.attnum=any(k.conkey)) nn on true where n.nspname='public' and c.relname=any(array['time_shifts','personal_activity_state','personal_activity_transition_sources','personal_activity_transitions','work_activity_safety_events','work_unit_fact_revisions','work_unit_fact_current','work_unit_fact_context_epochs','custom_work_units','project_openings','service_visit_units','service_visits','summons','unit_redos','qc_checks','install_events','crew_work_records','crew_work_record_people','work_session_capture_metadata','custom_work_history','custom_work_sessions','unit_sessions','task_sessions','service_time_sessions','opening_phases','summon_helpers','work_activity_source_history','work_unit_review_commands','work_unit_dimension_verifications','work_unit_review_events','work_unit_review_current','work_unit_review_defects','work_unit_review_defect_events','work_setup_sessions','personal_activity_commands','work_activity_definitions','work_activity_definition_versions','work_capture_menus','work_capture_menu_versions','work_capture_menu_items','work_job_menu_selections','profiles','projects','sandbox_projects','work_job_management_grants'])),
 'functionAccess',(select jsonb_agg(jsonb_build_object('name',p.proname,'args',pg_get_function_identity_arguments(p.oid),'role',r.rolname,'execute',has_function_privilege(r.oid,p.oid,'EXECUTE')) order by p.proname,pg_get_function_identity_arguments(p.oid),r.rolname) from pg_proc p join pg_namespace n on n.oid=p.pronamespace cross join pg_roles r where n.nspname='public' and p.proname=any(array['_ai_job_visible','_is_supervisor','_work_activity_actor','_work_activity_answers','_work_activity_authority_changed','_work_activity_authority_guard','_work_activity_authority_revision','_work_activity_bookkeeping_guard','_work_activity_claim_clock_setup','_work_activity_clock_replay_guard','_work_activity_clock_review','_work_activity_clock_setup_digest','_work_activity_close_all','_work_activity_close_source','_work_activity_command_basis','_work_activity_consume','_work_activity_context_assert','_work_activity_context_close','_work_activity_context_commit_guard','_work_activity_context_for','_work_activity_context_guard','_work_activity_context_open','_work_activity_ensure_state','_work_activity_ephemeral_commit_guard','_work_activity_establish_payload','_work_activity_establish_stream','_work_activity_event','_work_activity_evidence','_work_activity_expect','_work_activity_expected_guard','_work_activity_fact_snapshot','_work_activity_finish','_work_activity_gate','_work_activity_insert_source','_work_activity_instant','_work_activity_integer','_work_activity_iso','_work_activity_keep_clock_receipt','_work_activity_live_sources','_work_activity_no_truncate','_work_activity_object','_work_activity_observe','_work_activity_operation','_work_activity_operation_enter','_work_activity_operation_exit','_work_activity_parent_gate','_work_activity_parent_source_history','_work_activity_payload','_work_activity_profile_delete_guard','_work_activity_project_view','_work_activity_read_committed','_work_activity_refresh_state','_work_activity_resume','_work_activity_retain_source','_work_activity_review_visit','_work_activity_row_allowance','_work_activity_row_before','_work_activity_row_event','_work_activity_safety_exit','_work_activity_safety_guard','_work_activity_setup_guard','_work_activity_setup_ledger_guard','_work_activity_shift_lifecycle','_work_activity_source_material','_work_activity_source_view','_work_activity_start_setup','_work_activity_statement_begin','_work_activity_statement_end','_work_activity_stream_guard','_work_activity_touch','_work_activity_transition_source_guard','_work_activity_unit_basis','_work_activity_uuid','_work_activity_validate_switch','_work_config_can_manage_menu','_work_config_internal','_work_config_is_foreman','_work_config_is_owner','_work_config_is_supervisor','_work_config_replay','_work_config_store_receipt','_work_config_validate_menu_draft_items','_work_config_validate_typed_fields','_work_totals_capture','_work_totals_coverage','_work_totals_shift','_work_totals_source','_work_totals_visible','_work_unit_contributors_person','_work_unit_contributors_shift','_work_unit_fact_context_visible','_work_unit_review_authority','_work_unit_review_coverage','_work_unit_review_defect_projection','_work_unit_review_scope','_work_unit_review_view','clock_in','clock_out','custom_work_internal','end_break','is_partner_user','is_sandbox_project','is_test_profile','person_record_counts','service_job_access','shift_cap_hours','start_break','work_activity_command','work_activity_snapshot','work_activity_totals_read','work_capture_immutable_record','work_publish_activity_version','work_publish_menu_version','work_select_job_menu','work_unit_contributors_read','_work_unit_contributors_coverage']) and r.rolname in('anon','authenticated','service_role')),
 'privateAccess',(select jsonb_agg(jsonb_build_object('table',c.relname,'role',r.rolname,'privilege',v.name,'allowed',has_table_privilege(r.oid,c.oid,v.name)) order by c.relname,r.rolname,v.name) from pg_class c join pg_namespace n on n.oid=c.relnamespace cross join pg_roles r cross join (values('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')) v(name) where n.nspname='public' and c.relname=any(array['time_shifts','personal_activity_state','personal_activity_transition_sources','personal_activity_transitions','work_activity_safety_events','work_unit_fact_revisions','work_unit_fact_current','work_unit_fact_context_epochs','custom_work_units','project_openings','service_visit_units','service_visits','summons','unit_redos','qc_checks','install_events','crew_work_records','crew_work_record_people','work_session_capture_metadata','custom_work_history','custom_work_sessions','unit_sessions','task_sessions','service_time_sessions','opening_phases','summon_helpers','work_activity_source_history','work_unit_review_commands','work_unit_dimension_verifications','work_unit_review_events','work_unit_review_current','work_unit_review_defects','work_unit_review_defect_events','work_setup_sessions','personal_activity_commands','work_activity_definitions','work_activity_definition_versions','work_capture_menus','work_capture_menu_versions','work_capture_menu_items','work_job_menu_selections','profiles','projects','sandbox_projects','work_job_management_grants','_work_unit_review_live_sources']) and r.rolname in('anon','authenticated','service_role')),
 -- Effective access includes table-derived rights, role inheritance and PUBLIC.
 'columnAccess',(select jsonb_agg(jsonb_build_object('table',c.relname,'role',r.rolname,'privilege',v.name,'allowed',has_any_column_privilege(r.oid,c.oid,v.name)) order by c.relname,r.rolname,v.name) from pg_class c join pg_namespace n on n.oid=c.relnamespace cross join pg_roles r cross join (values('SELECT'),('INSERT'),('UPDATE'),('REFERENCES')) v(name) where n.nspname='public' and c.relname=any(array['time_shifts','personal_activity_state','personal_activity_transition_sources','personal_activity_transitions','work_activity_safety_events','work_unit_fact_revisions','work_unit_fact_current','work_unit_fact_context_epochs','custom_work_units','project_openings','service_visit_units','service_visits','summons','unit_redos','qc_checks','install_events','crew_work_records','crew_work_record_people','work_session_capture_metadata','custom_work_history','custom_work_sessions','unit_sessions','task_sessions','service_time_sessions','opening_phases','summon_helpers','work_activity_source_history','work_unit_review_commands','work_unit_dimension_verifications','work_unit_review_events','work_unit_review_current','work_unit_review_defects','work_unit_review_defect_events','work_setup_sessions','personal_activity_commands','work_activity_definitions','work_activity_definition_versions','work_capture_menus','work_capture_menu_versions','work_capture_menu_items','work_job_menu_selections','profiles','projects','sandbox_projects','work_job_management_grants','_work_unit_review_live_sources']) and r.rolname in('anon','authenticated','service_role')),
 'constraints',(select jsonb_agg(jsonb_build_object('table',c.relname,'name',k.conname,'definition',pg_get_constraintdef(k.oid,true),'validated',k.convalidated) order by c.relname,k.conname) from pg_constraint k join pg_class c on c.oid=k.conrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and k.contype<>'n' and c.relname=any(array['time_shifts','personal_activity_state','personal_activity_transition_sources','personal_activity_transitions','work_activity_safety_events','work_unit_fact_revisions','work_unit_fact_current','work_unit_fact_context_epochs','custom_work_units','project_openings','service_visit_units','service_visits','summons','unit_redos','qc_checks','install_events','crew_work_records','crew_work_record_people','work_session_capture_metadata','custom_work_history','custom_work_sessions','unit_sessions','task_sessions','service_time_sessions','opening_phases','summon_helpers','work_activity_source_history','work_unit_review_commands','work_unit_dimension_verifications','work_unit_review_events','work_unit_review_current','work_unit_review_defects','work_unit_review_defect_events','work_setup_sessions','personal_activity_commands','work_activity_definitions','work_activity_definition_versions','work_capture_menus','work_capture_menu_versions','work_capture_menu_items','work_job_menu_selections','profiles','projects','sandbox_projects','work_job_management_grants'])),
 'policies',(select jsonb_agg(jsonb_build_object('table',tablename,'name',policyname,'permissive',permissive,'roles',roles,'command',cmd,'using',qual,'check',with_check) order by tablename,policyname) from pg_policies where schemaname='public' and tablename=any(array['time_shifts','personal_activity_state','personal_activity_transition_sources','personal_activity_transitions','work_activity_safety_events','work_unit_fact_revisions','work_unit_fact_current','work_unit_fact_context_epochs','custom_work_units','project_openings','service_visit_units','service_visits','summons','unit_redos','qc_checks','install_events','crew_work_records','crew_work_record_people','work_session_capture_metadata','custom_work_history','custom_work_sessions','unit_sessions','task_sessions','service_time_sessions','opening_phases','summon_helpers','work_activity_source_history','work_unit_review_commands','work_unit_dimension_verifications','work_unit_review_events','work_unit_review_current','work_unit_review_defects','work_unit_review_defect_events','work_setup_sessions','personal_activity_commands','work_activity_definitions','work_activity_definition_versions','work_capture_menus','work_capture_menu_versions','work_capture_menu_items','work_job_menu_selections','profiles','projects','sandbox_projects','work_job_management_grants'])),
 'view',pg_get_viewdef('public._work_unit_review_live_sources'::regclass,true),
 'tables',(select jsonb_agg(jsonb_build_object('table',c.relname,'rls',c.relrowsecurity,'owner',pg_get_userbyid(c.relowner)) order by c.relname) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname=any(array['time_shifts','personal_activity_state','personal_activity_transition_sources','personal_activity_transitions','work_activity_safety_events','work_unit_fact_revisions','work_unit_fact_current','work_unit_fact_context_epochs','custom_work_units','project_openings','service_visit_units','service_visits','summons','unit_redos','qc_checks','install_events','crew_work_records','crew_work_record_people','work_session_capture_metadata','custom_work_history','custom_work_sessions','unit_sessions','task_sessions','service_time_sessions','opening_phases','summon_helpers','work_activity_source_history','work_unit_review_commands','work_unit_dimension_verifications','work_unit_review_events','work_unit_review_current','work_unit_review_defects','work_unit_review_defect_events','work_setup_sessions','personal_activity_commands','work_activity_definitions','work_activity_definition_versions','work_capture_menus','work_capture_menu_versions','work_capture_menu_items','work_job_menu_selections','profiles','projects','sandbox_projects','work_job_management_grants']))
) value) c
$coverage$;
revoke all on function public._work_unit_contributors_coverage() from public,anon,authenticated,service_role;
-- CONTRIBUTORS_COVERAGE_END
rollback;
