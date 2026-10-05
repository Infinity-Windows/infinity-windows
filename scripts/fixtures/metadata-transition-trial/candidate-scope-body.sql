
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
 sourceids:=p_sourceids;
 if jsonb_typeof(sourceids) is distinct from 'array' then return null;end if;
 if jsonb_array_length(sourceids)>4000 then return null;end if;
 select coalesce(jsonb_agg(to_jsonb(h) order by h.id),'[]') into history from public.work_activity_source_history h
 where exists(select 1 from jsonb_array_elements(sourceids) x where x->>'kind'=h.source_kind and x->>'id'=h.source_id);
 -- Baseline captures current rows only; missing pre-install intermediate work is unknown.
 if exists(select 1 from jsonb_array_elements(history) h where h->>'legacy_baseline'='true') then proven:=false;end if;
 if jsonb_array_length(history)>10000 or octet_length(history::text)>2000000 then return null;end if;
 select coalesce(jsonb_agg(jsonb_build_object('kind',s.kind,'id',s.source_id,'value',s.value) order by s.kind,s.source_id),'[]') into live
 from public._work_unit_metadata_live(sourceids) s;
 -- Re-enabled triggers cannot make an uncaptured live source trustworthy.
 -- Compare only the terminal captured state, including captured tombstones.
 -- An older matching NEW cannot conceal a bypassed A -> B -> A reversal.
 with recursive included as materialized (
 select h.* from public.work_activity_source_history h where exists(
 select 1 from jsonb_array_elements(sourceids) s where s->>'kind'=h.source_kind and s->>'id'=h.source_id)
 ), heads as (
 select h.* from included h where not exists(select 1 from included n where n.predecessor_id=h.id)
 ), chain(id,predecessor_id) as (
 select id,predecessor_id from heads union select h.id,h.predecessor_id from included h join chain n on h.id=n.predecessor_id
 ) select proven and not (
 exists(select 1 from jsonb_array_elements(sourceids) s where
 (select count(*) from heads h where h.source_kind=s->>'kind' and h.source_id=s->>'id')<>1
 or (select count(*) from included h where h.source_kind=s->>'kind' and h.source_id=s->>'id' and h.predecessor_id is null)<>1
 or coalesce((select h.after_value from heads h where h.source_kind=s->>'kind' and h.source_id=s->>'id' order by h.id limit 1),'{}')
 is distinct from coalesce((select l->'value' from jsonb_array_elements(live) l where l->>'kind'=s->>'kind' and l->>'id'=s->>'id'),'{}'))
 or exists(select 1 from included h where h.predecessor_id is not null and not exists(
 select 1 from included p where p.id=h.predecessor_id and p.source_kind=h.source_kind and p.source_id=h.source_id))
 or exists(select 1 from included where predecessor_id is not null group by predecessor_id having count(*)>1)
 or (select count(*) from chain)<>(select count(*) from included)
 ) into proven;
 -- Prototype only: canonical UUID text is required to preserve the original
 -- UUID::text comparison exactly. Do not normalize uppercase/alternate spellings.
 -- Other source kinds cannot match the original six-arm CASE expression.
 if exists(select 1 from jsonb_array_elements(sourceids) x
 where x->>'kind' in ('custom_work_sessions','unit_sessions','task_sessions','service_time_sessions','opening_phases','summon_helpers')
 and x->>'id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
 with selected as materialized (
 select distinct case x->>'kind'
 when 'custom_work_sessions' then 'custom' when 'unit_sessions' then 'unit'
 when 'task_sessions' then 'task' when 'service_time_sessions' then 'service'
 when 'opening_phases' then 'phase' when 'summon_helpers' then 'helper' end source_kind,
 case when x->>'id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
 then (x->>'id')::uuid end source_id
 from jsonb_array_elements(sourceids) x
 ), matched as (
 select e.* from selected s join public.personal_activity_transition_sources e
 on e.source_kind=s.source_kind and e.source_id=s.source_id
 where s.source_kind is not null and s.source_id is not null
 )
 select coalesce(jsonb_agg(jsonb_build_object('source',to_jsonb(e),'actor',t.actor_id,'recordedAt',t.received_at,
 'selectedAt',t.selected_effective_at,'timeReason',t.time_selection_reason,'commandId',t.command_id,'requestId',t.source_request_id) order by e.id),'[]') into normal_sources
 from matched e join public.personal_activity_transitions t on t.id=e.transition_id;
 else normal_sources:='[]'::jsonb;end if;
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
end; 