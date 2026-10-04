-- Held additive read contract. No payroll/capture mutation, counter or callback.
begin;
do $$begin if not public._work_unit_review_coverage() then raise exception using errcode='55000',message='Activity totals source is unavailable.';end if;end$$;

-- Normalize the observed provider default grant on this private held table.
-- SECURITY DEFINER safety writers retain owner access; raw service access is denied.
revoke all on table public.work_activity_safety_events from service_role;

create function public._work_totals_coverage() returns boolean language sql stable security definer set search_path=public,pg_temp as $$ select false $$;
revoke all on function public._work_totals_coverage() from public,anon,authenticated,service_role;

-- Expression indexes preserve OLD and NEW original-scope closure without a
-- history-wide lateral expansion. Index maintenance does not inspect QC.
create index work_totals_history_old_project on public.work_activity_source_history ((before_value->>'project_id')) where source_kind in ('custom_work_sessions','service_time_sessions','time_shifts','task_sessions','project_openings');
create index work_totals_history_new_project on public.work_activity_source_history ((after_value->>'project_id')) where source_kind in ('custom_work_sessions','service_time_sessions','time_shifts','task_sessions','project_openings');
create index work_totals_history_old_unit on public.work_activity_source_history ((before_value->>'unit_id')) where source_kind in ('custom_work_sessions','service_time_sessions','time_shifts','task_sessions','project_openings');
create index work_totals_history_new_unit on public.work_activity_source_history ((after_value->>'unit_id')) where source_kind in ('custom_work_sessions','service_time_sessions','time_shifts','task_sessions','project_openings');

create index work_totals_transition_old_project on public.personal_activity_transition_sources ((before_evidence->>'project_id'));
create index work_totals_transition_new_project on public.personal_activity_transition_sources ((after_evidence->>'project_id'));
create index work_totals_transition_opening on public.personal_activity_transition_sources ((coalesce(after_evidence->>'opening_id',before_evidence->>'opening_id')));

-- Matched catalog already has transitions(source_shift_id,selected_effective_at).
-- These three leading-key lookups were absent; do not duplicate that index.
create index work_totals_sources_shift on public.personal_activity_transition_sources (source_shift_id);
create index work_totals_sources_identity on public.personal_activity_transition_sources (source_kind,source_id);
create index work_totals_safety_profile on public.work_activity_safety_events (profile_id);

-- Indexed exact-source history. Causal edges, never timestamps, define latest.
create function public._work_totals_source(p_kind text,p_id text) returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare live jsonb;hist jsonb;ok boolean;col text:='id';
begin
 if p_kind<>all(array['time_shifts','custom_work_sessions','unit_sessions','task_sessions','service_time_sessions','opening_phases','work_setup_sessions','work_session_capture_metadata','custom_work_units','project_openings','service_visit_units','service_visits','summons']) then return null;end if;
 if p_kind='work_session_capture_metadata' then col:='session_id';end if;
 execute format('select public._work_activity_source_material(%L,to_jsonb(r)) from public.%I r where %I::text=$1',p_kind,p_kind,col) into live using p_id;
 select coalesce(jsonb_agg(to_jsonb(h) order by id),'[]') into hist from public.work_activity_source_history h where source_kind=p_kind and source_id=p_id;
 if jsonb_array_length(hist)>10000 or octet_length(hist::text)>2500000 then return null;end if;
 with recursive rows as materialized(select h.* from public.work_activity_source_history h where source_kind=p_kind and source_id=p_id),
 heads as(select h.* from rows h where not exists(select 1 from rows n where n.predecessor_id=h.id)),
 chain(id,predecessor_id) as(select id,predecessor_id from heads union select h.id,h.predecessor_id from rows h join chain n on h.id=n.predecessor_id)
 select (select count(*) from heads)=1 and (select count(*) from rows where predecessor_id is null)=1
 and (select count(*) from chain)=(select count(*) from rows)
 and not exists(select 1 from rows where legacy_baseline)
 and not exists(select 1 from rows r where predecessor_id is not null and not exists(select 1 from rows p where p.id=r.predecessor_id))
 and not exists(select 1 from rows where predecessor_id is not null group by predecessor_id having count(*)>1)
 and coalesce((select after_value from heads order by id limit 1),'{}')=coalesce(live,'{}') into ok;
 return jsonb_build_object('proven',coalesce(ok,false),'history',hist,'current',coalesce(live,'{}'));
end$$;
revoke all on function public._work_totals_source(text,text) from public,anon,authenticated,service_role;

-- Every original/current binding is checked before the RPC returns any count.
-- No guessed profile aliases: changed person identity invalidates proof later.
create function public._work_totals_visible(actor uuid,kind text,evidence jsonb,depth integer default 0,p_final_qc boolean default false) returns boolean
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare v jsonb;j uuid;o uuid;u uuid;r record;related jsonb;
begin
 if evidence is null or depth>4 then return false;end if;
 for v in select x.value from jsonb_array_elements(evidence->'history') h cross join lateral(values(h->'before_value'),(h->'after_value')) x(value)
 union select evidence->'current' loop
 if v='{}' then continue;end if;
 j:=(v->>'project_id')::uuid;
 if j is not null and (not public._ai_job_visible(j,actor) or (p_final_qc and not public._work_unit_review_authority(actor,jsonb_build_array(j),'final_qc'))) then return false;end if;
 if kind in ('service_time_sessions','service_visit_units','service_visits') and j is not null and not public.service_job_access(j) then return false;end if;
 o:=coalesce((v->>'opening_id')::uuid,(v->>'project_opening_id')::uuid);
 if o is not null and kind<>'project_openings' then
 related:=public._work_totals_source('project_openings',o::text);
 if related is null or related->'current'='{}' or not public._work_totals_visible(actor,'project_openings',related,depth+1,p_final_qc) then return false;end if;
 end if;
 u:=case when kind in ('custom_work_sessions','work_session_capture_metadata') then (v->>'unit_id')::uuid when kind='service_visit_units' then (v->>'work_unit_id')::uuid end;
 if u is not null then
 if public._work_activity_unit_basis(u,actor) is null then return false;end if;
 related:=public._work_totals_source('custom_work_units',u::text);
 if not public._work_totals_visible(actor,'custom_work_units',related,depth+1,p_final_qc) then return false;end if;
 for r in select * from public.work_unit_fact_revisions where unit_id=u loop
 if not public._work_unit_fact_context_visible(actor,r.origin_kind,r.origin_project_id,r.origin_opening_id,r.origin_author_id,r.origin_is_test,true) then return false;end if;
 if p_final_qc and r.origin_project_id is not null and not public._work_unit_review_authority(actor,jsonb_build_array(r.origin_project_id),'final_qc') then return false;end if;
 end loop;
 end if;
 if kind='service_time_sessions' then
 related:=public._work_totals_source('service_visits',v->>'visit_id');
 if not public._work_totals_visible(actor,'service_visits',related,depth+1,p_final_qc) then return false;end if;
 if v->>'unit_id' is not null then
 related:=public._work_totals_source('service_visit_units',v->>'unit_id');
 if not public._work_totals_visible(actor,'service_visit_units',related,depth+1,p_final_qc) then return false;end if;
 end if;end if;
 end loop;
 return true;
end$$;
revoke all on function public._work_totals_visible(uuid,text,jsonb,integer,boolean) from public,anon,authenticated,service_role;

-- Resume ancestry is actual server break-return lineage, not a copied label.
create function public._work_totals_capture(p_meta public.work_session_capture_metadata,p_shift uuid) returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
 with recursive ancestry(id,path) as (
 select p_meta.session_id,array[p_meta.session_id]
 union all select (t.before_evidence#>>'{state,resume_source_id}')::uuid,a.path||(t.before_evidence#>>'{state,resume_source_id}')::uuid
 from ancestry a join public.personal_activity_transitions t on t.after_evidence#>>'{state,active_source_id}'=a.id::text
 join public.personal_activity_transition_sources birth on birth.transition_id=t.id and birth.source_kind='custom' and birth.source_id=a.id and birth.before_evidence='{}'
 where t.profile_id=p_meta.profile_id and t.source_shift_id=p_shift and t.cause='break_end'
 and t.before_evidence#>>'{state,resume_source_kind}'='custom' and t.before_evidence#>>'{state,resume_shift_id}'=p_shift::text
 and t.before_evidence#>>'{state,resume_token}' is not null and not (t.before_evidence#>>'{state,resume_source_id}')::uuid=any(a.path) and cardinality(a.path)<100
 ), matching as (
 select a.id from ancestry a join public.work_session_capture_metadata m on m.session_id=a.id
 where row(m.profile_id,m.project_id,m.definition_version_id,m.menu_version_id,m.scope,m.unit_id,m.fact_revision,m.unit_facts,m.machine_kind,m.selection_id,m.selection_revision,m.answers)
 is not distinct from row(p_meta.profile_id,p_meta.project_id,p_meta.definition_version_id,p_meta.menu_version_id,p_meta.scope,p_meta.unit_id,p_meta.fact_revision,p_meta.unit_facts,p_meta.machine_kind,p_meta.selection_id,p_meta.selection_revision,p_meta.answers)
 ) select (select count(*) from matching)=(select count(*) from ancestry) and exists(
 select 1 from matching a join public.work_session_capture_metadata root_meta on root_meta.session_id=a.id join public.personal_activity_transition_sources child on child.source_kind='custom' and child.source_id=a.id and child.before_evidence='{}'
 join public.personal_activity_transitions tx on tx.id=child.transition_id join public.personal_activity_commands c on c.command_id=tx.command_id
 where c.status='applied' and c.transition_id=tx.id and tx.source_shift_id=p_shift and child.source_shift_id=p_shift and c.actor_id=p_meta.profile_id and c.subject_profile_id=p_meta.profile_id
 and c.normalized_payload#>>'{intent,kind}'='switch' and c.normalized_payload#>>'{intent,projectId}'=p_meta.project_id::text
 and c.normalized_payload#>>'{intent,menuVersionId}'=p_meta.menu_version_id::text
 and c.normalized_payload#>'{intent,values}'=p_meta.answers
 and nullif(c.normalized_payload#>'{intent,unit}','null'::jsonb) is not distinct from root_meta.unit_basis
 and c.normalized_payload#>>'{intent,definitionVersionId}'=p_meta.definition_version_id::text and c.normalized_payload#>>'{intent,scope}'=p_meta.scope
 and c.normalized_payload#>>'{intent,unit,id}' is not distinct from p_meta.unit_id::text
 and c.normalized_payload#>>'{intent,machineKind}' is not distinct from p_meta.machine_kind
 and c.normalized_payload#>>'{intent,selectionId}'=p_meta.selection_id::text and c.normalized_payload#>>'{intent,selectionRevision}'=p_meta.selection_revision::text)
$$;
revoke all on function public._work_totals_capture(public.work_session_capture_metadata,uuid) from public,anon,authenticated,service_role;

-- One shift ledger. Transition state supplies one effective interval; typed
-- source children corroborate it and never add companion clocks.
create function public._work_totals_shift(actor uuid,shift_id uuid,as_of timestamptz) returns jsonb
language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare sh public.time_shifts;ps public.personal_activity_state;t record;n record;h jsonb;proof jsonb;sourceproof jsonb;meta public.work_session_capture_metadata;dv public.work_activity_definition_versions;
 item jsonb;beforej jsonb;afterj jsonb;claims jsonb:='[]';breaks jsonb:='[]';issues text[]:='{}';seen jsonb:='{}';tr jsonb;state jsonb;prior jsonb;
 start_at timestamptz;end_at timestamptz;finish timestamptz;break_end timestamptz;last_at timestamptz;v_source_kind text;table_kind text;v_source_id text;
 gross numeric;deduction numeric;placed numeric:=0;classified numeric:=0;setup numeric:=0;unknown numeric:=0;conflict numeric:=0;us numeric;overlap boolean;proven boolean:=true;live_allowed boolean:=false;mapping_complete boolean:=true;last_revision bigint;reconciliation_authorized boolean:=false;
begin
 select * into sh from public.time_shifts where id=shift_id;
 if sh.id is null then return jsonb_build_object('availability','unavailable');end if;
 proof:=public._work_totals_source('time_shifts',sh.id::text);
 if not public._work_totals_visible(actor,'time_shifts',proof) then return jsonb_build_object('availability','unavailable');end if;
 proven:=coalesce((proof->>'proven')::boolean,false);
 reconciliation_authorized:=public._work_totals_visible(actor,'time_shifts',proof,0,true);
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
 sourceproof:=public._work_totals_source(table_kind,n.source_id::text);
 if not public._work_totals_visible(actor,table_kind,sourceproof) then return jsonb_build_object('availability','unavailable');end if;
 reconciliation_authorized:=reconciliation_authorized and public._work_totals_visible(actor,table_kind,sourceproof,0,true);
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
 if end_at is null or end_at<=start_at then continue;end if;
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
 h:=public._work_totals_source('work_session_capture_metadata',v_source_id);
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
 claims:=claims||jsonb_build_array(jsonb_build_object('profileId',sh.profile_id,'projectId',meta.project_id,'unitId',meta.unit_id,'definitionId',dv.definition_id,'definitionVersionId',dv.id,'definitionVersion',dv.version,'scope',meta.scope,'labelEn',dv.label_en,'labelEs',dv.label_es,'machineKind',meta.machine_kind,'microseconds',us::text,'live',sh.clock_out_at is null and t.ord=jsonb_array_length(tr)));
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
 return jsonb_build_object('availability','available','profileId',sh.profile_id,'shiftId',sh.id,'proven',proven,'complete',proven and finish is not null and mapping_complete,
 'reconciliationAuthorized',reconciliation_authorized,'approved',sh.status='approved' and sh.clock_out_at is not null,'claims',claims,'issues',to_jsonb(array(select distinct unnest(issues))),
 'grossMicros',gross::text,'payrollMicros',(gross-deduction)::text,'classifiedMicros',classified::text,'setupMicros',setup::text,'unclassifiedMicros',unknown::text,
 'breakElapsedMicros',placed::text,'breakDeductionMicros',deduction::text,'policyAdjustmentMicros',(placed-deduction)::text);
end$$;
revoke all on function public._work_totals_shift(uuid,uuid,timestamptz) from public,anon,authenticated,service_role;

create function public.work_activity_totals_read(p_project_id uuid,p_unit_id uuid default null) returns jsonb
language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare actor uuid;stamp timestamptz;ids uuid[];sid uuid;ledger jsonb;ledgers jsonb:='[]';rows jsonb;unit_scope jsonb;review jsonb;unitrow public.custom_work_units;
 available constant jsonb:='{"protocolVersion":1,"availability":"unavailable","totals":null}';complete boolean:=true;personal_complete boolean:=true;trusted boolean:=false;
 orphan record;orphan_proof jsonb;scope_unproven boolean:=false;own_scope_unproven boolean:=false;reconciliation_authorized boolean:=false;reconciliation_ledgers jsonb;orphan_count integer:=0;cohort jsonb;reason text[]:='{}';area numeric;factor_num numeric;factor_den numeric;labor numeric;own_labor numeric;actual numeric;cohort_scope boolean;
begin
 perform public._work_activity_read_committed();perform public._work_activity_gate();actor:=public._work_activity_actor();
 perform pg_advisory_xact_lock(7710,0);actor:=public._work_activity_actor();stamp:=clock_timestamp();
 if p_project_id is null or not public._ai_job_visible(p_project_id,actor) or not public._work_unit_review_coverage() or not public._work_totals_coverage() then return available;end if;
 reconciliation_authorized:=public._work_unit_review_authority(actor,jsonb_build_array(p_project_id),'final_qc');
 if p_unit_id is not null then
 select * into unitrow from public.custom_work_units where id=p_unit_id;
 if unitrow.id is null or unitrow.project_id<>p_project_id then return available;end if;
 unit_scope:=public._work_unit_review_scope(actor,p_unit_id);if unit_scope is null then return available;end if;
 review:=public._work_unit_review_view(actor,unit_scope);if review is null then return available;end if;
 reconciliation_authorized:=reconciliation_authorized and public._work_unit_review_authority(actor,unit_scope->'jobs','final_qc');
 own_scope_unproven:=exists(select 1 from jsonb_array_elements(unit_scope#>'{manifest,history}') h where h->>'source_kind' in ('custom_work_sessions','unit_sessions','task_sessions','service_time_sessions') and (h#>>'{before_value,profile_id}'=actor::text or h#>>'{after_value,profile_id}'=actor::text) and not exists(select 1 from jsonb_array_elements(unit_scope#>'{manifest,transitions}') t where t#>>'{source,source_id}'=h->>'source_id' and t#>>'{source,source_shift_id}' is not null));
 scope_unproven:=not coalesce((unit_scope->>'proven')::boolean,false) or exists(
 select 1 from jsonb_array_elements(unit_scope#>'{manifest,history}') h where h->>'source_kind' in ('custom_work_sessions','unit_sessions','task_sessions','service_time_sessions')
 and not exists(select 1 from jsonb_array_elements(unit_scope#>'{manifest,transitions}') t where t#>>'{source,source_id}'=h->>'source_id' and t#>>'{source,source_shift_id}' is not null));
 end if;
 -- A legacy source without a retained payroll/transition binding cannot
 -- silently disappear into a zero. Check its original grants before the flag.
 for orphan in
 select distinct h.source_kind,h.source_id from public.work_activity_source_history h
 where h.source_kind in ('custom_work_sessions','service_time_sessions','task_sessions')
 and p_unit_id is null and (h.before_value->>'project_id'=p_project_id::text or h.after_value->>'project_id'=p_project_id::text)
 and not exists(select 1 from public.personal_activity_transition_sources e where e.source_id=h.source_id::uuid and e.source_shift_id is not null
 and e.source_kind=case h.source_kind when 'custom_work_sessions' then 'custom' when 'service_time_sessions' then 'service' else 'task' end)
 loop
 orphan_count:=orphan_count+1;if orphan_count>500 then return available;end if;
 orphan_proof:=public._work_totals_source(orphan.source_kind,orphan.source_id);
 if not public._work_totals_visible(actor,orphan.source_kind,orphan_proof) then return available;end if;
 scope_unproven:=true;
 reconciliation_authorized:=reconciliation_authorized and public._work_totals_visible(actor,orphan.source_kind,orphan_proof,0,true);
 own_scope_unproven:=own_scope_unproven or orphan_proof#>>'{current,profile_id}'=actor::text or exists(select 1 from jsonb_array_elements(orphan_proof->'history') h where h#>>'{before_value,profile_id}'=actor::text or h#>>'{after_value,profile_id}'=actor::text);
 end loop;
 complete:=not scope_unproven;personal_complete:=not scope_unproven;
 -- Include current payroll allocations and original captured project bindings.
 -- A missing retained shift is unavailable; it never becomes synthetic zero.
 select array_agg(distinct id) into ids from (
 select id from public.time_shifts where p_unit_id is null and project_id=p_project_id
 union select s.shift_id from public.custom_work_sessions s where (p_unit_id is null and s.project_id=p_project_id) or (p_unit_id is not null and s.unit_id=p_unit_id)
 union select s.shift_id from public.custom_work_sessions s join public.work_session_capture_metadata m on m.session_id=s.id where (p_unit_id is null and m.project_id=p_project_id) or (p_unit_id is not null and m.unit_id=p_unit_id)
 union select (case when source_kind='time_shifts' then source_id else before_value->>'shift_id' end)::uuid from public.work_activity_source_history where source_kind in ('custom_work_sessions','service_time_sessions','time_shifts','task_sessions','project_openings') and p_unit_id is null and before_value->>'project_id'=p_project_id::text
 union select (case when source_kind='time_shifts' then source_id else after_value->>'shift_id' end)::uuid from public.work_activity_source_history where source_kind in ('custom_work_sessions','service_time_sessions','time_shifts','task_sessions','project_openings') and p_unit_id is null and after_value->>'project_id'=p_project_id::text
 union select (case when source_kind='time_shifts' then source_id else before_value->>'shift_id' end)::uuid from public.work_activity_source_history where source_kind='custom_work_sessions' and p_unit_id is not null and before_value->>'unit_id'=p_unit_id::text
 union select (case when source_kind='time_shifts' then source_id else after_value->>'shift_id' end)::uuid from public.work_activity_source_history where source_kind='custom_work_sessions' and p_unit_id is not null and after_value->>'unit_id'=p_unit_id::text
 union select (n#>>'{source,source_shift_id}')::uuid from jsonb_array_elements(unit_scope#>'{manifest,transitions}') n
 union select e.source_shift_id from public.personal_activity_transition_sources e where p_unit_id is null and (e.before_evidence->>'project_id'=p_project_id::text or e.after_evidence->>'project_id'=p_project_id::text)
 union select e.source_shift_id from public.personal_activity_transition_sources e join public.project_openings o on o.id::text=coalesce(e.after_evidence->>'opening_id',e.before_evidence->>'opening_id') where p_unit_id is null and o.project_id=p_project_id
 union select e.source_shift_id from public.personal_activity_transition_sources e join public.work_activity_source_history h on h.source_kind='project_openings' and h.source_id=coalesce(e.after_evidence->>'opening_id',e.before_evidence->>'opening_id') where p_unit_id is null and (h.before_value->>'project_id'=p_project_id::text or h.after_value->>'project_id'=p_project_id::text)
 ) q where id is not null;
 if coalesce(array_length(ids,1),0)>500 then return available;end if;
 foreach sid in array coalesce(ids,'{}') loop
 ledger:=public._work_totals_shift(actor,sid,stamp);
 if ledger->>'availability'<>'available' then return available;end if;
 ledgers:=ledgers||jsonb_build_array(ledger);
 reconciliation_authorized:=reconciliation_authorized and coalesce((ledger->>'reconciliationAuthorized')::boolean,false);
 complete:=complete and (ledger->>'complete')::boolean;
 if ledger->>'profileId'=actor::text then personal_complete:=personal_complete and (ledger->>'complete')::boolean;end if;
 end loop;
 if octet_length(ledgers::text)>5000000 then return available;end if;
 -- Detailed payroll/review evidence has a stricter boundary than activity totals.
 select coalesce(jsonb_agg(l),'[]') into reconciliation_ledgers from jsonb_array_elements(ledgers) l where reconciliation_authorized or l->>'profileId'=actor::text;
 own_scope_unproven:=coalesce(own_scope_unproven,false) or exists(select 1 from jsonb_array_elements(reconciliation_ledgers) l where l->>'profileId'=actor::text and not (l->>'complete')::boolean);
 with claims as(select c.* from jsonb_array_elements(ledgers) l cross join lateral jsonb_to_recordset(l->'claims') as c("profileId" uuid,"projectId" uuid,"unitId" uuid,"definitionId" uuid,"definitionVersionId" uuid,"definitionVersion" integer,scope text,"labelEn" text,"labelEs" text,"machineKind" text,microseconds text,live boolean)
 where ((p_unit_id is null and c."projectId"=p_project_id and c.scope='general') or (p_unit_id is not null and c.scope='specific' and c."unitId"=p_unit_id))),
 grouped as(select "definitionId","definitionVersionId","definitionVersion",scope,"labelEn","labelEs",sum(microseconds::numeric) us,
 coalesce(sum(microseconds::numeric) filter(where "profileId"=actor),0) own,bool_or(live and "profileId"=actor) live from claims group by 1,2,3,4,5,6)
 select coalesce(jsonb_agg(jsonb_build_object('definitionId',g."definitionId",'definitionVersionId',g."definitionVersionId",'definitionVersion',g."definitionVersion",'scope',g.scope,
 'labelEn',g."labelEn",'labelEs',g."labelEs",'retired',d.retired_at is not null,
 'personal',jsonb_build_object('state',case when personal_complete then 'known' else 'partial' end,'microseconds',case when personal_complete then g.own::text end,'knownMicros',g.own::text,'includesLive',g.live),
 'scopeTotal',jsonb_build_object('state',case when complete then 'known' else 'partial' end,'microseconds',case when complete then g.us::text end,'knownMicros',g.us::text),
 'machineSubsets',(select coalesce(jsonb_agg(jsonb_build_object('machineKind',m.kind,'microseconds',m.us::text) order by m.kind),'[]') from(
 select "machineKind" kind,sum(microseconds::numeric) us from claims c where c."definitionVersionId"=g."definitionVersionId" and "machineKind" is not null group by 1)m)
 ) order by g."definitionId",g."definitionVersion"),'[]') into rows from grouped g join public.work_activity_definitions d on d.id=g."definitionId";
 select coalesce(sum((c->>'microseconds')::numeric),0),coalesce(sum((c->>'microseconds')::numeric)filter(where c->>'profileId'=actor::text),0) into labor,own_labor
 from jsonb_array_elements(ledgers) l cross join lateral jsonb_array_elements(l->'claims')c
 where ((p_unit_id is null and c->>'projectId'=p_project_id::text and c->>'scope'='general') or (p_unit_id is not null and c->>'scope'='specific' and c->>'unitId'=p_unit_id::text));
 cohort_scope:=p_unit_id is not null and reconciliation_authorized and public._work_unit_review_authority(actor,unit_scope->'jobs','final_qc');
 if not cohort_scope then cohort:=jsonb_build_object('availability','unavailable','reason',case when p_unit_id is null then 'unit_selection_required' else 'role_restricted' end);
 else
 if not complete then reason:=array_append(reason,'coverage_incomplete');end if;
 if exists(select 1 from jsonb_array_elements(ledgers)l where (l->>'unclassifiedMicros')::numeric>0) then reason:=array_append(reason,'unclassified_coverage');end if;
 if exists(select 1 from jsonb_array_elements(ledgers)l where not (l->>'approved')::boolean or (l->>'policyAdjustmentMicros')::numeric<>0) then reason:=array_append(reason,'payroll_not_trusted');end if;
 if review#>>'{dimensionVerification,state}'<>'verified' then reason:=array_append(reason,'dimensions_unverified');end if;
 if review#>>'{qc,qcAccepted}' is distinct from 'true' then reason:=array_append(reason,'qc_not_current_accepted');end if;
 if (unit_scope->>'active')::integer<>0 or (unit_scope->>'pending')::integer<>0 then reason:=array_append(reason,'active_or_rework');end if;
 if labor<=0 then reason:=array_append(reason,'no_attributed_labor');end if;
 factor_num:=case unit_scope#>>'{observation,unit}' when 'in' then 1 when 'ft' then 12 when 'mm' then 5 when 'cm' then 50 end;
 factor_den:=case unit_scope#>>'{observation,unit}' when 'mm' then 127 when 'cm' then 127 else 1 end;
 -- Exact rational area, no floating-point transport or rounded comparisons.
 if factor_num is null or unit_scope#>>'{observation,widthDecimal}' is null then reason:=array_append(reason,'area_unknown');
 else area:=(unit_scope#>>'{observation,widthDecimal}')::numeric*(unit_scope#>>'{observation,heightDecimal}')::numeric*factor_num*factor_num;end if;
 trusted:=cardinality(reason)=0;
 cohort:=jsonb_build_object('availability','available','unitId',p_unit_id,'eligible',trusted,'exclusions',to_jsonb(reason),
 'actualLaborMicros',labor::text,'excludedLaborMicros',case when trusted then '0' else labor::text end,
 'eligibleUnitIds',case when trusted then jsonb_build_array(p_unit_id) else '[]'::jsonb end,
 'laborNumeratorMicros',case when trusted then labor::text else '0' end,
 'areaSquareFeetNumerator',case when trusted then trim_scale(area)::text else '0' end,
 'areaSquareFeetDenominator',trim_scale(factor_den*factor_den*144)::text,
 'dimensionSource',unit_scope#>'{observation,source}','dimensionVerification',review#>'{dimensionVerification,state}',
 'floor',jsonb_build_object('state','unallocated','label',nullif(unitrow.facts->>'story',''),'areaCountedOnce',true),'generalOverheadIncluded',false);
 end if;
 return jsonb_build_object('protocolVersion',1,'availability','available','totals',jsonb_build_object('asOf',public._work_activity_iso(stamp),'actorId',actor,'projectId',p_project_id,'unitId',p_unit_id,
 'window',jsonb_build_object('kind','all_retained_selected_scope','from',null,'until',public._work_activity_iso(stamp),'personalScope','actual_actor_selected_scope'),
 'complete',complete,'personalComplete',personal_complete,'activities',rows,'scopeKnownMicros',labor::text,'personalKnownMicros',own_labor::text,
 'reconciliation',(select jsonb_build_object('scope',case when reconciliation_authorized then 'authorized_scope' else 'personal' end,'unresolvedScope',case when reconciliation_authorized then scope_unproven else own_scope_unproven end,'ledgerCount',count(*),'grossMicros',case when count(*)filter(where l->>'grossMicros' is null)=0 then sum((l->>'grossMicros')::numeric)::text end,
 'payrollMicros',case when count(*)filter(where l->>'payrollMicros' is null)=0 then sum((l->>'payrollMicros')::numeric)::text end,
 'classifiedMicros',coalesce(sum((l->>'classifiedMicros')::numeric),0)::text,'setupMicros',coalesce(sum((l->>'setupMicros')::numeric),0)::text,
 'unclassifiedMicros',coalesce(sum((l->>'unclassifiedMicros')::numeric),0)::text,'breakElapsedMicros',coalesce(sum((l->>'breakElapsedMicros')::numeric),0)::text,
 'breakDeductionMicros',coalesce(sum((l->>'breakDeductionMicros')::numeric),0)::text,'policyAdjustmentMicros',coalesce(sum((l->>'policyAdjustmentMicros')::numeric),0)::text,
 'issues',(select coalesce(jsonb_agg(distinct i),'[]') from jsonb_array_elements(reconciliation_ledgers)z cross join lateral jsonb_array_elements(z->'issues')i)) from jsonb_array_elements(reconciliation_ledgers)l),
 'cohort',cohort));
end$$;
revoke all on function public.work_activity_totals_read(uuid,uuid) from public,anon,service_role;
grant execute on function public.work_activity_totals_read(uuid,uuid) to authenticated;
-- TOTALS_COVERAGE_BEGIN
-- Generated exact source/column/trigger coverage; unknown source shape fails closed.
create or replace function public._work_totals_coverage() returns boolean
language sql stable security definer set search_path=public,pg_temp as $coverage$
 select encode(sha256(convert_to(c.value::text,'UTF8')),'hex')='a4a3a7b5c1a1a6aabacecd3520a0edc217ac572e22f7fcb334c7a8703c19904a' from (select jsonb_build_object(
 'functions',(select jsonb_agg(jsonb_build_object('name',p.proname,'args',pg_get_function_identity_arguments(p.oid),'body',encode(sha256(convert_to(p.prosrc,'UTF8')),'hex'),'config',p.proconfig,'owner',pg_get_userbyid(p.proowner),'definer',p.prosecdef,'volatility',p.provolatile) order by p.proname,pg_get_function_identity_arguments(p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=any(array['_work_activity_actor','_work_activity_answers','_work_activity_authority_changed','_work_activity_authority_guard','_work_activity_authority_revision','_work_activity_bookkeeping_guard','_work_activity_claim_clock_setup','_work_activity_clock_replay_guard','_work_activity_clock_review','_work_activity_clock_setup_digest','_work_activity_close_all','_work_activity_close_source','_work_activity_command_basis','_work_activity_consume','_work_activity_context_assert','_work_activity_context_close','_work_activity_context_commit_guard','_work_activity_context_for','_work_activity_context_guard','_work_activity_context_open','_work_activity_ensure_state','_work_activity_ephemeral_commit_guard','_work_activity_establish_payload','_work_activity_establish_stream','_work_activity_event','_work_activity_evidence','_work_activity_expect','_work_activity_expected_guard','_work_activity_fact_snapshot','_work_activity_finish','_work_activity_gate','_work_activity_insert_source','_work_activity_instant','_work_activity_integer','_work_activity_iso','_work_activity_keep_clock_receipt','_work_activity_live_sources','_work_activity_no_truncate','_work_activity_object','_work_activity_observe','_work_activity_operation','_work_activity_operation_enter','_work_activity_operation_exit','_work_activity_parent_gate','_work_activity_parent_source_history','_work_activity_payload','_work_activity_profile_delete_guard','_work_activity_project_view','_work_activity_read_committed','_work_activity_refresh_state','_work_activity_resume','_work_activity_retain_source','_work_activity_review_visit','_work_activity_row_allowance','_work_activity_row_before','_work_activity_row_event','_work_activity_safety_exit','_work_activity_safety_guard','_work_activity_setup_guard','_work_activity_setup_ledger_guard','_work_activity_shift_lifecycle','_work_activity_source_material','_work_activity_source_view','_work_activity_start_setup','_work_activity_statement_begin','_work_activity_statement_end','_work_activity_stream_guard','_work_activity_touch','_work_activity_transition_source_guard','_work_activity_unit_basis','_work_activity_uuid','_work_activity_validate_switch','_work_config_can_manage_menu','_work_config_internal','_work_config_is_foreman','_work_config_is_owner','_work_config_is_supervisor','_work_config_replay','_work_config_store_receipt','_work_config_validate_menu_draft_items','_work_config_validate_typed_fields','_work_totals_capture','_work_totals_shift','_work_totals_source','_work_totals_visible','_work_unit_review_coverage','clock_in','clock_out','end_break','shift_cap_hours','start_break','work_activity_command','work_activity_snapshot','work_activity_totals_read','work_capture_immutable_record','work_publish_activity_version','work_publish_menu_version','work_select_job_menu'])),
 'triggers',(select jsonb_agg(jsonb_build_object('table',c.relname,'name',t.tgname,'definition',pg_get_triggerdef(t.oid,true),'enabled',t.tgenabled) order by c.relname,t.tgname) from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname=any(array['time_shifts','personal_activity_state','personal_activity_transition_sources','personal_activity_transitions','work_activity_safety_events','work_unit_fact_revisions','work_unit_fact_current','work_unit_fact_context_epochs','custom_work_units','project_openings','service_visit_units','service_visits','summons','unit_redos','qc_checks','install_events','crew_work_records','crew_work_record_people','work_session_capture_metadata','custom_work_history','custom_work_sessions','unit_sessions','task_sessions','service_time_sessions','opening_phases','summon_helpers','work_activity_source_history','work_unit_review_commands','work_unit_dimension_verifications','work_unit_review_events','work_unit_review_current','work_unit_review_defects','work_unit_review_defect_events','work_setup_sessions','personal_activity_commands','work_activity_definitions','work_activity_definition_versions','work_capture_menus','work_capture_menu_versions','work_capture_menu_items','work_job_menu_selections']) and not t.tgisinternal),
 'columns',(select jsonb_agg(jsonb_build_object('table',c.relname,'column',a.attname,'type',format_type(a.atttypid,a.atttypmod),'nullable',not a.attnotnull,'notNullValidated',coalesce(nn.validated,true),'notNullEnforced',coalesce(nn.enforced,true),'notNullNoInherit',coalesce(nn.no_inherit,false),'generated',a.attgenerated,'identity',a.attidentity) order by c.relname,a.attnum) from pg_class c join pg_namespace n on n.oid=c.relnamespace join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped left join lateral (select bool_and(k.convalidated) validated,bool_and(coalesce((to_jsonb(k)->>'conenforced')::boolean,true)) enforced,bool_or(k.connoinherit) no_inherit from pg_constraint k where k.conrelid=a.attrelid and k.contype='n' and a.attnum=any(k.conkey)) nn on true where n.nspname='public' and c.relname=any(array['time_shifts','personal_activity_state','personal_activity_transition_sources','personal_activity_transitions','work_activity_safety_events','work_unit_fact_revisions','work_unit_fact_current','work_unit_fact_context_epochs','custom_work_units','project_openings','service_visit_units','service_visits','summons','unit_redos','qc_checks','install_events','crew_work_records','crew_work_record_people','work_session_capture_metadata','custom_work_history','custom_work_sessions','unit_sessions','task_sessions','service_time_sessions','opening_phases','summon_helpers','work_activity_source_history','work_unit_review_commands','work_unit_dimension_verifications','work_unit_review_events','work_unit_review_current','work_unit_review_defects','work_unit_review_defect_events','work_setup_sessions','personal_activity_commands','work_activity_definitions','work_activity_definition_versions','work_capture_menus','work_capture_menu_versions','work_capture_menu_items','work_job_menu_selections'])),
 'functionAccess',(select jsonb_agg(jsonb_build_object('name',p.proname,'args',pg_get_function_identity_arguments(p.oid),'role',r.rolname,'execute',has_function_privilege(r.oid,p.oid,'EXECUTE')) order by p.proname,pg_get_function_identity_arguments(p.oid),r.rolname) from pg_proc p join pg_namespace n on n.oid=p.pronamespace cross join pg_roles r where n.nspname='public' and p.proname=any(array['_work_activity_actor','_work_activity_answers','_work_activity_authority_changed','_work_activity_authority_guard','_work_activity_authority_revision','_work_activity_bookkeeping_guard','_work_activity_claim_clock_setup','_work_activity_clock_replay_guard','_work_activity_clock_review','_work_activity_clock_setup_digest','_work_activity_close_all','_work_activity_close_source','_work_activity_command_basis','_work_activity_consume','_work_activity_context_assert','_work_activity_context_close','_work_activity_context_commit_guard','_work_activity_context_for','_work_activity_context_guard','_work_activity_context_open','_work_activity_ensure_state','_work_activity_ephemeral_commit_guard','_work_activity_establish_payload','_work_activity_establish_stream','_work_activity_event','_work_activity_evidence','_work_activity_expect','_work_activity_expected_guard','_work_activity_fact_snapshot','_work_activity_finish','_work_activity_gate','_work_activity_insert_source','_work_activity_instant','_work_activity_integer','_work_activity_iso','_work_activity_keep_clock_receipt','_work_activity_live_sources','_work_activity_no_truncate','_work_activity_object','_work_activity_observe','_work_activity_operation','_work_activity_operation_enter','_work_activity_operation_exit','_work_activity_parent_gate','_work_activity_parent_source_history','_work_activity_payload','_work_activity_profile_delete_guard','_work_activity_project_view','_work_activity_read_committed','_work_activity_refresh_state','_work_activity_resume','_work_activity_retain_source','_work_activity_review_visit','_work_activity_row_allowance','_work_activity_row_before','_work_activity_row_event','_work_activity_safety_exit','_work_activity_safety_guard','_work_activity_setup_guard','_work_activity_setup_ledger_guard','_work_activity_shift_lifecycle','_work_activity_source_material','_work_activity_source_view','_work_activity_start_setup','_work_activity_statement_begin','_work_activity_statement_end','_work_activity_stream_guard','_work_activity_touch','_work_activity_transition_source_guard','_work_activity_unit_basis','_work_activity_uuid','_work_activity_validate_switch','_work_config_can_manage_menu','_work_config_internal','_work_config_is_foreman','_work_config_is_owner','_work_config_is_supervisor','_work_config_replay','_work_config_store_receipt','_work_config_validate_menu_draft_items','_work_config_validate_typed_fields','_work_totals_capture','_work_totals_shift','_work_totals_source','_work_totals_visible','_work_unit_review_coverage','clock_in','clock_out','end_break','shift_cap_hours','start_break','work_activity_command','work_activity_snapshot','work_activity_totals_read','work_capture_immutable_record','work_publish_activity_version','work_publish_menu_version','work_select_job_menu','_work_totals_coverage']) and r.rolname in('anon','authenticated','service_role')),
 'privateAccess',(select jsonb_agg(jsonb_build_object('table',c.relname,'role',r.rolname,'privilege',v.name,'allowed',has_table_privilege(r.oid,c.oid,v.name)) order by c.relname,r.rolname,v.name) from pg_class c join pg_namespace n on n.oid=c.relnamespace cross join pg_roles r cross join (values('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')) v(name) where n.nspname='public' and c.relname=any(array['time_shifts','personal_activity_state','personal_activity_transition_sources','personal_activity_transitions','work_activity_safety_events','work_unit_fact_revisions','work_unit_fact_current','work_unit_fact_context_epochs','custom_work_units','project_openings','service_visit_units','service_visits','summons','unit_redos','qc_checks','install_events','crew_work_records','crew_work_record_people','work_session_capture_metadata','custom_work_history','custom_work_sessions','unit_sessions','task_sessions','service_time_sessions','opening_phases','summon_helpers','work_activity_source_history','work_unit_review_commands','work_unit_dimension_verifications','work_unit_review_events','work_unit_review_current','work_unit_review_defects','work_unit_review_defect_events','work_setup_sessions','personal_activity_commands','work_activity_definitions','work_activity_definition_versions','work_capture_menus','work_capture_menu_versions','work_capture_menu_items','work_job_menu_selections','_work_unit_review_live_sources']) and r.rolname in('anon','authenticated','service_role')),
 'constraints',(select jsonb_agg(jsonb_build_object('table',c.relname,'name',k.conname,'definition',pg_get_constraintdef(k.oid,true),'validated',k.convalidated) order by c.relname,k.conname) from pg_constraint k join pg_class c on c.oid=k.conrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and k.contype<>'n' and c.relname=any(array['time_shifts','personal_activity_state','personal_activity_transition_sources','personal_activity_transitions','work_activity_safety_events','work_unit_fact_revisions','work_unit_fact_current','work_unit_fact_context_epochs','custom_work_units','project_openings','service_visit_units','service_visits','summons','unit_redos','qc_checks','install_events','crew_work_records','crew_work_record_people','work_session_capture_metadata','custom_work_history','custom_work_sessions','unit_sessions','task_sessions','service_time_sessions','opening_phases','summon_helpers','work_activity_source_history','work_unit_review_commands','work_unit_dimension_verifications','work_unit_review_events','work_unit_review_current','work_unit_review_defects','work_unit_review_defect_events','work_setup_sessions','personal_activity_commands','work_activity_definitions','work_activity_definition_versions','work_capture_menus','work_capture_menu_versions','work_capture_menu_items','work_job_menu_selections'])),
 'policies',(select jsonb_agg(jsonb_build_object('table',tablename,'name',policyname,'permissive',permissive,'roles',roles,'command',cmd,'using',qual,'check',with_check) order by tablename,policyname) from pg_policies where schemaname='public' and tablename=any(array['time_shifts','personal_activity_state','personal_activity_transition_sources','personal_activity_transitions','work_activity_safety_events','work_unit_fact_revisions','work_unit_fact_current','work_unit_fact_context_epochs','custom_work_units','project_openings','service_visit_units','service_visits','summons','unit_redos','qc_checks','install_events','crew_work_records','crew_work_record_people','work_session_capture_metadata','custom_work_history','custom_work_sessions','unit_sessions','task_sessions','service_time_sessions','opening_phases','summon_helpers','work_activity_source_history','work_unit_review_commands','work_unit_dimension_verifications','work_unit_review_events','work_unit_review_current','work_unit_review_defects','work_unit_review_defect_events','work_setup_sessions','personal_activity_commands','work_activity_definitions','work_activity_definition_versions','work_capture_menus','work_capture_menu_versions','work_capture_menu_items','work_job_menu_selections'])),
 'view',pg_get_viewdef('public._work_unit_review_live_sources'::regclass,true),
 'tables',(select jsonb_agg(jsonb_build_object('table',c.relname,'rls',c.relrowsecurity,'owner',pg_get_userbyid(c.relowner)) order by c.relname) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname=any(array['time_shifts','personal_activity_state','personal_activity_transition_sources','personal_activity_transitions','work_activity_safety_events','work_unit_fact_revisions','work_unit_fact_current','work_unit_fact_context_epochs','custom_work_units','project_openings','service_visit_units','service_visits','summons','unit_redos','qc_checks','install_events','crew_work_records','crew_work_record_people','work_session_capture_metadata','custom_work_history','custom_work_sessions','unit_sessions','task_sessions','service_time_sessions','opening_phases','summon_helpers','work_activity_source_history','work_unit_review_commands','work_unit_dimension_verifications','work_unit_review_events','work_unit_review_current','work_unit_review_defects','work_unit_review_defect_events','work_setup_sessions','personal_activity_commands','work_activity_definitions','work_activity_definition_versions','work_capture_menus','work_capture_menu_versions','work_capture_menu_items','work_job_menu_selections']))
) value) c
$coverage$;
revoke all on function public._work_totals_coverage() from public,anon,authenticated,service_role;
-- TOTALS_COVERAGE_END
rollback;
