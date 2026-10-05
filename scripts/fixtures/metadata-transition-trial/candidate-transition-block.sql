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
