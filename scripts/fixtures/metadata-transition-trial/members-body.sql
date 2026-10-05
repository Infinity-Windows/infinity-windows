
with versions as materialized (
 select source_kind kind,source_id,b.value from public.work_activity_source_history h cross join lateral(values(h.before_value),(h.after_value)) b(value) where b.value<>'{}'
 union all select case e.source_kind when 'custom' then 'custom_work_sessions' when 'unit' then 'unit_sessions' when 'task' then 'task_sessions' when 'service' then 'service_time_sessions' when 'phase' then 'opening_phases' when 'helper' then 'summon_helpers' end,e.source_id::text,b.value
 from public.personal_activity_transition_sources e cross join lateral(values(e.before_evidence),(e.after_evidence))b(value) where e.source_kind in ('custom','unit','task','service','phase','helper') and b.value<>'{}'
), units as materialized(select u.id uid,u.opening_id from public.custom_work_units u where u.id=any(p_units)),
roots as materialized(
 select u.uid,v.value->>'opening_id' id from units u join versions v on v.kind='custom_work_units' and v.source_id=u.uid::text
 union select u.uid,u.opening_id::text from units u),
mapped as materialized(select uid,id from roots where id is not null),
windows as materialized(
 select m.uid,v.value->>'assigned_window_id' id from mapped m join versions v on v.kind='project_openings' and v.source_id=m.id
 union select m.uid,r.assigned_window_id::text from mapped m join public.project_openings r on r.id::text=m.id),
service_units as materialized(
 select u.uid,v.source_id id from units u join versions v on v.kind='service_visit_units' and v.value->>'work_unit_id'=u.uid::text
 union select m.uid,v.source_id from mapped m join versions v on v.kind='service_visit_units' and v.value->>'opening_id'=m.id
 union select w.uid,v.source_id from windows w join versions v on v.kind='service_visit_units' and v.value->>'window_id'=w.id
 union select u.uid,r.id::text from units u join public.service_visit_units r on r.work_unit_id=u.uid
 union select m.uid,r.id::text from mapped m join public.service_visit_units r on r.opening_id::text=m.id
 union select w.uid,r.id::text from windows w join public.service_visit_units r on r.window_id::text=w.id),
summons_for_unit as materialized(
 select m.uid,v.source_id id from mapped m join versions v on v.kind='summons' and v.value->>'opening_id'=m.id
 union select m.uid,r.id::text from mapped m join public.summons r on r.opening_id::text=m.id),
crew as materialized(
 select u.uid,v.source_id id from units u join versions v on v.kind='crew_work_records' and v.value->>'unit_id'=u.uid::text
 union select u.uid,r.id::text from units u join public.crew_work_records r on r.unit_id=u.uid),
custom_sessions as materialized(
 select u.uid,v.source_id id from units u join versions v on v.kind='custom_work_sessions' and v.value->>'unit_id'=u.uid::text
 union select u.uid,v.value->>'session_id' from units u join versions v on v.kind='work_session_capture_metadata' and v.value->>'unit_id'=u.uid::text
 union select u.uid,r.id::text from units u join public.custom_work_sessions r on r.unit_id=u.uid
 union select u.uid,r.session_id::text from units u join public.work_session_capture_metadata r on r.unit_id=u.uid),
visits as materialized(
 select su.uid,v.value->>'visit_id' id from service_units su join versions v on v.kind='service_visit_units' and v.source_id=su.id
 union select su.uid,r.visit_id::text from service_units su join public.service_visit_units r on r.id::text=su.id),
selected as materialized(
 select u.uid,v.kind,v.source_id from units u join versions v on v.kind='custom_work_units' and v.source_id=u.uid::text
 union select m.uid,v.kind,v.source_id from mapped m join versions v on v.kind='project_openings' and v.source_id=m.id
 union select m.uid,v.kind,v.source_id from mapped m join versions v on v.kind in('unit_sessions','task_sessions','opening_phases','unit_redos') and v.value->>'opening_id'=m.id
 union select m.uid,v.kind,v.source_id from mapped m join versions v on v.kind in('qc_checks','install_events') and v.value->>'project_opening_id'=m.id
 union select c.uid,v.kind,v.source_id from custom_sessions c join versions v on v.kind='custom_work_sessions' and v.source_id=c.id
 union select su.uid,v.kind,v.source_id from service_units su join versions v on v.kind='service_visit_units' and v.source_id=su.id
 union select su.uid,v.kind,v.source_id from service_units su join versions v on v.kind='service_time_sessions' and v.value->>'unit_id'=su.id
 union select vi.uid,v.kind,v.source_id from visits vi join versions v on v.kind='service_visits' and v.source_id=vi.id
 union select sm.uid,v.kind,v.source_id from summons_for_unit sm join versions v on v.kind='summons' and v.source_id=sm.id
 union select sm.uid,v.kind,v.source_id from summons_for_unit sm join versions v on v.kind='summon_helpers' and v.value->>'summon_id'=sm.id
 union select c.uid,v.kind,v.source_id from crew c join versions v on v.kind='crew_work_records' and v.source_id=c.id
 union select c.uid,v.kind,v.source_id from crew c join versions v on v.kind='crew_work_record_people' and v.value->>'record_id'=c.id
 union select u.uid,v.kind,v.source_id from units u join versions v on v.kind='work_session_capture_metadata' and v.value->>'unit_id'=u.uid::text
 union select c.uid,v.kind,v.source_id from custom_sessions c join versions v on v.kind='work_session_capture_metadata' and v.source_id=c.id
 union select c.uid,v.kind,v.source_id from custom_sessions c join versions v on v.kind='custom_work_history' and v.value->>'entity_id'=c.id
 union select u.uid,v.kind,v.source_id from units u join versions v on v.kind='custom_work_history' and v.value->>'entity_id'=u.uid::text
 and (v.value->>'action' not in('unit','link') or v.value#>'{before_value,facts,installation_complete}' is distinct from v.value#>'{after_value,facts,installation_complete}')
 union select u.uid,'custom_work_units'::text,r.id::text from units u join public.custom_work_units r on r.id=u.uid
 union select u.uid,'project_openings'::text,r.id::text from mapped u join public.project_openings r on r.id::text=u.id
 union select u.uid,'unit_sessions'::text,r.id::text from mapped u join public.unit_sessions r on r.opening_id::text=u.id
 union select u.uid,'task_sessions'::text,r.id::text from mapped u join public.task_sessions r on r.opening_id::text=u.id
 union select u.uid,'opening_phases'::text,r.id::text from mapped u join public.opening_phases r on r.opening_id::text=u.id
 union select u.uid,'unit_redos'::text,r.id::text from mapped u join public.unit_redos r on r.opening_id::text=u.id
 union select u.uid,'qc_checks'::text,r.id::text from mapped u join public.qc_checks r on r.project_opening_id::text=u.id
 union select u.uid,'install_events'::text,r.id::text from mapped u join public.install_events r on r.project_opening_id::text=u.id
 union select u.uid,'custom_work_sessions'::text,r.id::text from custom_sessions u join public.custom_work_sessions r on r.id::text=u.id
 union select u.uid,'service_visit_units'::text,r.id::text from service_units u join public.service_visit_units r on r.id::text=u.id
 union select u.uid,'service_time_sessions'::text,r.id::text from service_units u join public.service_time_sessions r on r.unit_id::text=u.id
 union select u.uid,'service_visits'::text,r.id::text from visits u join public.service_visits r on r.id::text=u.id
 union select u.uid,'summons'::text,r.id::text from summons_for_unit u join public.summons r on r.id::text=u.id
 union select u.uid,'summon_helpers'::text,r.id::text from summons_for_unit u join public.summon_helpers r on r.summon_id::text=u.id
 union select u.uid,'crew_work_records'::text,r.id::text from crew u join public.crew_work_records r on r.id::text=u.id
 union select u.uid,'crew_work_record_people'::text,r.record_id::text||':'||r.profile_id::text from crew u join public.crew_work_record_people r on r.record_id::text=u.id
 union select u.uid,'work_session_capture_metadata'::text,r.session_id::text from units u join public.work_session_capture_metadata r on r.unit_id=u.uid
 union select u.uid,'work_session_capture_metadata'::text,r.session_id::text from custom_sessions u join public.work_session_capture_metadata r on r.session_id::text=u.id
 union select u.uid,'custom_work_history'::text,r.id::text from custom_sessions u join public.custom_work_history r on r.entity_id::text=u.id
 union select u.uid,'custom_work_history'::text,r.id::text from units u join public.custom_work_history r on r.entity_id=u.uid and (r.action not in('unit','link') or r.before_value#>'{facts,installation_complete}' is distinct from r.after_value#>'{facts,installation_complete}')
), grouped as(select u.uid,coalesce(jsonb_agg(jsonb_build_object('kind',s.kind,'id',s.source_id) order by s.kind,s.source_id) filter(where s.source_id is not null),'[]') sources
 from units u left join selected s on s.uid=u.uid group by u.uid)
 select case when (select count(*) from selected)>200000 or (select count(distinct(kind,source_id)) from selected)>20000 then null
 else coalesce(jsonb_object_agg(uid::text,sources),'{}') end from grouped
