 select coalesce(jsonb_agg(jsonb_build_object('source',to_jsonb(e),'actor',t.actor_id,'recordedAt',t.received_at,
 'selectedAt',t.selected_effective_at,'timeReason',t.time_selection_reason,'commandId',t.command_id,'requestId',t.source_request_id) order by e.id),'[]') into normal_sources
 from public.personal_activity_transition_sources e join public.personal_activity_transitions t on t.id=e.transition_id
 where exists(select 1 from jsonb_array_elements(sourceids) x where x->>'id'=e.source_id::text and x->>'kind'=case e.source_kind when 'custom' then 'custom_work_sessions' when 'unit' then 'unit_sessions' when 'task' then 'task_sessions' when 'service' then 'service_time_sessions' when 'phase' then 'opening_phases' when 'helper' then 'summon_helpers' end);
