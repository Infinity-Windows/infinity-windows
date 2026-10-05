-- HELD701-only unit metadata and cohort candidate. Production capture unchanged.
-- Final promotion, v2 compatibility and retention integration are separate gates.
begin;
do $namespace$ begin
 if exists(select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and
  (starts_with(p.proname,'_work_unit_metadata_') or starts_with(p.proname,'work_unit_metadata_') or p.proname='work_unit_cohorts_read'))
 or exists(select 1 from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and (starts_with(c.relname,'_work_unit_metadata_') or starts_with(c.relname,'work_unit_metadata_')))
 or exists(select 1 from pg_catalog.pg_type t join pg_catalog.pg_namespace n on n.oid=t.typnamespace where n.nspname='public' and (starts_with(t.typname,'_work_unit_metadata_') or starts_with(t.typname,'work_unit_metadata_'))) then
 raise exception using errcode='55000',message='Unit metadata source is unavailable.';end if;
end $namespace$;
-- METADATA_BASE_PREFLIGHT_BEGIN
do $metadata_source$ begin
 if not public._work_unit_review_coverage() or not public._work_totals_coverage() or not public._work_unit_contributors_coverage() or not coalesce((select encode(sha256(convert_to(c.value::text,'UTF8')),'hex')='2631d3339a577efb31ba99334c9639ad36c6d7248e3eb7eae20293ab1d2e6ee0' from (select jsonb_build_object('namespaceRelations',(select coalesce(jsonb_agg(jsonb_build_object('name',c.relname,'kind',c.relkind) order by c.relname),'[]') from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and starts_with(c.relname,'_work_unit_contributors_')),'namespace',(select coalesce(jsonb_agg(jsonb_build_object('name',p.proname,'args',pg_get_function_identity_arguments(p.oid)) order by p.proname,pg_get_function_identity_arguments(p.oid)),'[]') from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and (p.proname='work_unit_contributors_read' or starts_with(p.proname,'_work_unit_contributors_'))),
 'functions',(select jsonb_agg(jsonb_build_object('name',p.proname,'args',pg_get_function_identity_arguments(p.oid),'language',(select lanname from pg_language where oid=p.prolang),'kind',p.prokind,'result',pg_get_function_result(p.oid),'defaults',pg_get_expr(p.proargdefaults,0),'strict',p.proisstrict,'parallel',p.proparallel,'leakproof',p.proleakproof,'cost',p.procost,'rows',p.prorows,'support',p.prosupport::regprocedure::text,'setReturning',p.proretset,'rawAcl',p.proacl::text,'body',encode(sha256(convert_to(p.prosrc,'UTF8')),'hex'),'config',p.proconfig,'owner',pg_get_userbyid(p.proowner),'definer',p.prosecdef,'volatility',p.provolatile) order by p.proname,pg_get_function_identity_arguments(p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=any(array['_ai_job_visible','_is_lead','_is_supervisor','_work_activity_actor','_work_activity_answers','_work_activity_authority_changed','_work_activity_authority_guard','_work_activity_authority_revision','_work_activity_bookkeeping_guard','_work_activity_claim_clock_setup','_work_activity_clock_replay_guard','_work_activity_clock_review','_work_activity_clock_setup_digest','_work_activity_close_all','_work_activity_close_source','_work_activity_command_basis','_work_activity_consume','_work_activity_context_assert','_work_activity_context_close','_work_activity_context_commit_guard','_work_activity_context_for','_work_activity_context_guard','_work_activity_context_open','_work_activity_ensure_state','_work_activity_ephemeral_commit_guard','_work_activity_establish_payload','_work_activity_establish_stream','_work_activity_event','_work_activity_evidence','_work_activity_expect','_work_activity_expected_guard','_work_activity_fact_snapshot','_work_activity_finish','_work_activity_gate','_work_activity_insert_source','_work_activity_instant','_work_activity_integer','_work_activity_iso','_work_activity_keep_clock_receipt','_work_activity_live_sources','_work_activity_no_truncate','_work_activity_object','_work_activity_observe','_work_activity_operation','_work_activity_operation_enter','_work_activity_operation_exit','_work_activity_parent_gate','_work_activity_parent_source_history','_work_activity_payload','_work_activity_profile_delete_guard','_work_activity_project_view','_work_activity_read_committed','_work_activity_refresh_state','_work_activity_resume','_work_activity_retain_source','_work_activity_review_visit','_work_activity_row_allowance','_work_activity_row_before','_work_activity_row_event','_work_activity_safety_exit','_work_activity_safety_guard','_work_activity_setup_guard','_work_activity_setup_ledger_guard','_work_activity_shift_lifecycle','_work_activity_source_material','_work_activity_source_view','_work_activity_start_setup','_work_activity_statement_begin','_work_activity_statement_end','_work_activity_stream_guard','_work_activity_touch','_work_activity_transition_source_guard','_work_activity_unit_basis','_work_activity_uuid','_work_activity_validate_switch','_work_config_can_manage_menu','_work_config_internal','_work_config_is_foreman','_work_config_is_owner','_work_config_is_supervisor','_work_config_replay','_work_config_store_receipt','_work_config_validate_menu_draft_items','_work_config_validate_typed_fields','_work_totals_capture','_work_totals_coverage','_work_totals_shift','_work_totals_source','_work_totals_visible','_work_unit_contributors_coverage','_work_unit_contributors_person','_work_unit_contributors_shift','_work_unit_fact_bump_epoch','_work_unit_fact_context_visible','_work_unit_fact_peek_epoch','_work_unit_review_authority','_work_unit_review_coverage','_work_unit_review_defect_projection','_work_unit_review_scope','_work_unit_review_view','attach_sandbox_guards','clock_in','clock_out','custom_work_internal','end_break','guard_test_account_sandbox_only','is_partner_user','is_sandbox_project','is_test_profile','person_record_counts','row_project_id','sandbox_scoped_tables','service_job_access','shift_cap_hours','start_break','work_activity_command','work_activity_snapshot','work_activity_totals_read','work_capture_immutable_record','work_publish_activity_version','work_publish_menu_version','work_select_job_menu','work_unit_contributors_read'])),
 'triggers',(select jsonb_agg(jsonb_build_object('table',c.relname,'name',t.tgname,'definition',pg_get_triggerdef(t.oid,true),'enabled',t.tgenabled) order by c.relname,t.tgname) from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname=any(array['time_shifts','personal_activity_state','personal_activity_transition_sources','personal_activity_transitions','work_activity_safety_events','work_unit_fact_revisions','work_unit_fact_current','work_unit_fact_context_epochs','custom_work_units','project_openings','service_visit_units','service_visits','summons','unit_redos','qc_checks','install_events','crew_work_records','crew_work_record_people','work_session_capture_metadata','custom_work_history','custom_work_sessions','unit_sessions','task_sessions','service_time_sessions','opening_phases','summon_helpers','work_activity_source_history','work_unit_review_commands','work_unit_dimension_verifications','work_unit_review_events','work_unit_review_current','work_unit_review_defects','work_unit_review_defect_events','work_setup_sessions','personal_activity_commands','work_activity_definitions','work_activity_definition_versions','work_capture_menus','work_capture_menu_versions','work_capture_menu_items','work_job_menu_selections','profiles','projects','sandbox_projects','work_job_management_grants']) and not t.tgisinternal),
 'columns',(select jsonb_agg(jsonb_build_object('table',c.relname,'column',a.attname,'type',format_type(a.atttypid,a.atttypmod),'nullable',not a.attnotnull,'default',(select pg_get_expr(d.adbin,d.adrelid) from pg_attrdef d where d.adrelid=a.attrelid and d.adnum=a.attnum),'collation',a.attcollation::regcollation::text,'rawAcl',a.attacl::text,'notNullValidated',coalesce(nn.validated,true),'notNullEnforced',coalesce(nn.enforced,true),'notNullNoInherit',coalesce(nn.no_inherit,false),'generated',a.attgenerated,'identity',a.attidentity) order by c.relname,a.attnum) from pg_class c join pg_namespace n on n.oid=c.relnamespace join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped left join lateral (select bool_and(k.convalidated) validated,bool_and(coalesce((to_jsonb(k)->>'conenforced')::boolean,true)) enforced,bool_or(k.connoinherit) no_inherit from pg_constraint k where k.conrelid=a.attrelid and k.contype='n' and a.attnum=any(k.conkey)) nn on true where n.nspname='public' and c.relname=any(array['time_shifts','personal_activity_state','personal_activity_transition_sources','personal_activity_transitions','work_activity_safety_events','work_unit_fact_revisions','work_unit_fact_current','work_unit_fact_context_epochs','custom_work_units','project_openings','service_visit_units','service_visits','summons','unit_redos','qc_checks','install_events','crew_work_records','crew_work_record_people','work_session_capture_metadata','custom_work_history','custom_work_sessions','unit_sessions','task_sessions','service_time_sessions','opening_phases','summon_helpers','work_activity_source_history','work_unit_review_commands','work_unit_dimension_verifications','work_unit_review_events','work_unit_review_current','work_unit_review_defects','work_unit_review_defect_events','work_setup_sessions','personal_activity_commands','work_activity_definitions','work_activity_definition_versions','work_capture_menus','work_capture_menu_versions','work_capture_menu_items','work_job_menu_selections','profiles','projects','sandbox_projects','work_job_management_grants'])),
 'functionAccess',(select jsonb_agg(jsonb_build_object('name',p.proname,'args',pg_get_function_identity_arguments(p.oid),'role',r.rolname,'execute',has_function_privilege(r.oid,p.oid,'EXECUTE')) order by p.proname,pg_get_function_identity_arguments(p.oid),r.rolname) from pg_proc p join pg_namespace n on n.oid=p.pronamespace cross join pg_roles r where n.nspname='public' and p.proname=any(array['_ai_job_visible','_is_lead','_is_supervisor','_work_activity_actor','_work_activity_answers','_work_activity_authority_changed','_work_activity_authority_guard','_work_activity_authority_revision','_work_activity_bookkeeping_guard','_work_activity_claim_clock_setup','_work_activity_clock_replay_guard','_work_activity_clock_review','_work_activity_clock_setup_digest','_work_activity_close_all','_work_activity_close_source','_work_activity_command_basis','_work_activity_consume','_work_activity_context_assert','_work_activity_context_close','_work_activity_context_commit_guard','_work_activity_context_for','_work_activity_context_guard','_work_activity_context_open','_work_activity_ensure_state','_work_activity_ephemeral_commit_guard','_work_activity_establish_payload','_work_activity_establish_stream','_work_activity_event','_work_activity_evidence','_work_activity_expect','_work_activity_expected_guard','_work_activity_fact_snapshot','_work_activity_finish','_work_activity_gate','_work_activity_insert_source','_work_activity_instant','_work_activity_integer','_work_activity_iso','_work_activity_keep_clock_receipt','_work_activity_live_sources','_work_activity_no_truncate','_work_activity_object','_work_activity_observe','_work_activity_operation','_work_activity_operation_enter','_work_activity_operation_exit','_work_activity_parent_gate','_work_activity_parent_source_history','_work_activity_payload','_work_activity_profile_delete_guard','_work_activity_project_view','_work_activity_read_committed','_work_activity_refresh_state','_work_activity_resume','_work_activity_retain_source','_work_activity_review_visit','_work_activity_row_allowance','_work_activity_row_before','_work_activity_row_event','_work_activity_safety_exit','_work_activity_safety_guard','_work_activity_setup_guard','_work_activity_setup_ledger_guard','_work_activity_shift_lifecycle','_work_activity_source_material','_work_activity_source_view','_work_activity_start_setup','_work_activity_statement_begin','_work_activity_statement_end','_work_activity_stream_guard','_work_activity_touch','_work_activity_transition_source_guard','_work_activity_unit_basis','_work_activity_uuid','_work_activity_validate_switch','_work_config_can_manage_menu','_work_config_internal','_work_config_is_foreman','_work_config_is_owner','_work_config_is_supervisor','_work_config_replay','_work_config_store_receipt','_work_config_validate_menu_draft_items','_work_config_validate_typed_fields','_work_totals_capture','_work_totals_coverage','_work_totals_shift','_work_totals_source','_work_totals_visible','_work_unit_contributors_coverage','_work_unit_contributors_person','_work_unit_contributors_shift','_work_unit_fact_bump_epoch','_work_unit_fact_context_visible','_work_unit_fact_peek_epoch','_work_unit_review_authority','_work_unit_review_coverage','_work_unit_review_defect_projection','_work_unit_review_scope','_work_unit_review_view','attach_sandbox_guards','clock_in','clock_out','custom_work_internal','end_break','guard_test_account_sandbox_only','is_partner_user','is_sandbox_project','is_test_profile','person_record_counts','row_project_id','sandbox_scoped_tables','service_job_access','shift_cap_hours','start_break','work_activity_command','work_activity_snapshot','work_activity_totals_read','work_capture_immutable_record','work_publish_activity_version','work_publish_menu_version','work_select_job_menu','work_unit_contributors_read','_work_unit_contributors_coverage']) and r.rolname in('anon','authenticated','service_role')),
 'privateAccess',(select jsonb_agg(jsonb_build_object('table',c.relname,'role',r.rolname,'privilege',v.name,'allowed',has_table_privilege(r.oid,c.oid,v.name)) order by c.relname,r.rolname,v.name) from pg_class c join pg_namespace n on n.oid=c.relnamespace cross join pg_roles r cross join (values('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')) v(name) where n.nspname='public' and c.relname=any(array['time_shifts','personal_activity_state','personal_activity_transition_sources','personal_activity_transitions','work_activity_safety_events','work_unit_fact_revisions','work_unit_fact_current','work_unit_fact_context_epochs','custom_work_units','project_openings','service_visit_units','service_visits','summons','unit_redos','qc_checks','install_events','crew_work_records','crew_work_record_people','work_session_capture_metadata','custom_work_history','custom_work_sessions','unit_sessions','task_sessions','service_time_sessions','opening_phases','summon_helpers','work_activity_source_history','work_unit_review_commands','work_unit_dimension_verifications','work_unit_review_events','work_unit_review_current','work_unit_review_defects','work_unit_review_defect_events','work_setup_sessions','personal_activity_commands','work_activity_definitions','work_activity_definition_versions','work_capture_menus','work_capture_menu_versions','work_capture_menu_items','work_job_menu_selections','profiles','projects','sandbox_projects','work_job_management_grants','_work_unit_review_live_sources']) and r.rolname in('anon','authenticated','service_role')),
 -- Effective access includes table-derived rights, role inheritance and PUBLIC.
 'columnAccess',(select jsonb_agg(jsonb_build_object('table',c.relname,'role',r.rolname,'privilege',v.name,'allowed',has_any_column_privilege(r.oid,c.oid,v.name)) order by c.relname,r.rolname,v.name) from pg_class c join pg_namespace n on n.oid=c.relnamespace cross join pg_roles r cross join (values('SELECT'),('INSERT'),('UPDATE'),('REFERENCES')) v(name) where n.nspname='public' and c.relname=any(array['time_shifts','personal_activity_state','personal_activity_transition_sources','personal_activity_transitions','work_activity_safety_events','work_unit_fact_revisions','work_unit_fact_current','work_unit_fact_context_epochs','custom_work_units','project_openings','service_visit_units','service_visits','summons','unit_redos','qc_checks','install_events','crew_work_records','crew_work_record_people','work_session_capture_metadata','custom_work_history','custom_work_sessions','unit_sessions','task_sessions','service_time_sessions','opening_phases','summon_helpers','work_activity_source_history','work_unit_review_commands','work_unit_dimension_verifications','work_unit_review_events','work_unit_review_current','work_unit_review_defects','work_unit_review_defect_events','work_setup_sessions','personal_activity_commands','work_activity_definitions','work_activity_definition_versions','work_capture_menus','work_capture_menu_versions','work_capture_menu_items','work_job_menu_selections','profiles','projects','sandbox_projects','work_job_management_grants','_work_unit_review_live_sources']) and r.rolname in('anon','authenticated','service_role')),
 'constraints',(select jsonb_agg(jsonb_build_object('table',c.relname,'name',k.conname,'definition',pg_get_constraintdef(k.oid,true),'validated',k.convalidated,'enforced',coalesce((to_jsonb(k)->>'conenforced')::boolean,true),'deferrable',k.condeferrable,'deferred',k.condeferred) order by c.relname,k.conname) from pg_constraint k join pg_class c on c.oid=k.conrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and k.contype<>'n' and c.relname=any(array['time_shifts','personal_activity_state','personal_activity_transition_sources','personal_activity_transitions','work_activity_safety_events','work_unit_fact_revisions','work_unit_fact_current','work_unit_fact_context_epochs','custom_work_units','project_openings','service_visit_units','service_visits','summons','unit_redos','qc_checks','install_events','crew_work_records','crew_work_record_people','work_session_capture_metadata','custom_work_history','custom_work_sessions','unit_sessions','task_sessions','service_time_sessions','opening_phases','summon_helpers','work_activity_source_history','work_unit_review_commands','work_unit_dimension_verifications','work_unit_review_events','work_unit_review_current','work_unit_review_defects','work_unit_review_defect_events','work_setup_sessions','personal_activity_commands','work_activity_definitions','work_activity_definition_versions','work_capture_menus','work_capture_menu_versions','work_capture_menu_items','work_job_menu_selections','profiles','projects','sandbox_projects','work_job_management_grants'])),
 'policies',(select jsonb_agg(jsonb_build_object('table',tablename,'name',policyname,'permissive',permissive,'roles',roles,'command',cmd,'using',qual,'check',with_check) order by tablename,policyname) from pg_policies where schemaname='public' and tablename=any(array['time_shifts','personal_activity_state','personal_activity_transition_sources','personal_activity_transitions','work_activity_safety_events','work_unit_fact_revisions','work_unit_fact_current','work_unit_fact_context_epochs','custom_work_units','project_openings','service_visit_units','service_visits','summons','unit_redos','qc_checks','install_events','crew_work_records','crew_work_record_people','work_session_capture_metadata','custom_work_history','custom_work_sessions','unit_sessions','task_sessions','service_time_sessions','opening_phases','summon_helpers','work_activity_source_history','work_unit_review_commands','work_unit_dimension_verifications','work_unit_review_events','work_unit_review_current','work_unit_review_defects','work_unit_review_defect_events','work_setup_sessions','personal_activity_commands','work_activity_definitions','work_activity_definition_versions','work_capture_menus','work_capture_menu_versions','work_capture_menu_items','work_job_menu_selections','profiles','projects','sandbox_projects','work_job_management_grants'])),
 'view',pg_get_viewdef('public._work_unit_review_live_sources'::regclass,true),
 'tables',(select jsonb_agg(jsonb_build_object('table',c.relname,'rls',c.relrowsecurity,'forcedRls',c.relforcerowsecurity,'kind',c.relkind,'persistence',c.relpersistence,'rawAcl',c.relacl::text,'owner',pg_get_userbyid(c.relowner)) order by c.relname) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname=any(array['time_shifts','personal_activity_state','personal_activity_transition_sources','personal_activity_transitions','work_activity_safety_events','work_unit_fact_revisions','work_unit_fact_current','work_unit_fact_context_epochs','custom_work_units','project_openings','service_visit_units','service_visits','summons','unit_redos','qc_checks','install_events','crew_work_records','crew_work_record_people','work_session_capture_metadata','custom_work_history','custom_work_sessions','unit_sessions','task_sessions','service_time_sessions','opening_phases','summon_helpers','work_activity_source_history','work_unit_review_commands','work_unit_dimension_verifications','work_unit_review_events','work_unit_review_current','work_unit_review_defects','work_unit_review_defect_events','work_setup_sessions','personal_activity_commands','work_activity_definitions','work_activity_definition_versions','work_capture_menus','work_capture_menu_versions','work_capture_menu_items','work_job_menu_selections','profiles','projects','sandbox_projects','work_job_management_grants']))
) value)c),false) then raise exception using errcode='55000',message='Unit metadata source is unavailable.';end if;
end $metadata_source$;
-- METADATA_BASE_PREFLIGHT_END

create table public._work_unit_metadata_definitions(
 id uuid primary key,kind text not null check(kind in ('category','subtype','material','component','field','floor','group')),
 code text not null check(code ~ '^[a-z][a-z0-9_]{0,79}$'),project_id uuid,actor_id uuid not null,recorded_at timestamptz not null default clock_timestamp(),
 check((kind='floor')=(project_id is not null))
);
create unique index work_unit_metadata_definition_global on public._work_unit_metadata_definitions(kind,code) where project_id is null;
create unique index work_unit_metadata_definition_project on public._work_unit_metadata_definitions(project_id,kind,code) where project_id is not null;
create table public._work_unit_metadata_versions(
 id uuid primary key,definition_id uuid not null references public._work_unit_metadata_definitions(id),version integer not null check(version>0),
 predecessor_id uuid references public._work_unit_metadata_versions(id),state text not null check(state in ('published','retired')),
 value jsonb not null check(jsonb_typeof(value)='object' and octet_length(value::text)<=24000),actor_id uuid not null,command_id uuid not null,recorded_at timestamptz not null default clock_timestamp(),unique(definition_id,version)
);
create table public._work_unit_metadata_proposals(
 id uuid primary key,actor_id uuid not null,command_id uuid not null,project_id uuid,value jsonb not null check(jsonb_typeof(value)='object' and octet_length(value::text)<=32768),recorded_at timestamptz not null default clock_timestamp()
);
create table public._work_unit_metadata_revisions(
 id uuid primary key,unit_id uuid not null,incarnation bigint not null check(incarnation between 0 and 9007199254740991),revision integer not null check(revision>0),
 predecessor_id uuid references public._work_unit_metadata_revisions(id),binding jsonb not null,origin_jobs jsonb not null,
 value jsonb not null check(jsonb_typeof(value)='object' and octet_length(value::text)<=24000),observed_fact_id uuid,
 actor_id uuid not null,command_id uuid not null,recorded_at timestamptz not null default clock_timestamp(),unique(unit_id,revision)
);
create table public._work_unit_metadata_current(unit_id uuid primary key,revision_id uuid not null references public._work_unit_metadata_revisions(id));
create table public._work_unit_metadata_floors(
 id uuid primary key,unit_id uuid not null,incarnation bigint not null check(incarnation between 0 and 9007199254740991),revision integer not null check(revision>0),
 predecessor_id uuid references public._work_unit_metadata_floors(id),basis jsonb not null,origin_jobs jsonb not null,
 state text not null check(state in ('unknown','unallocated','single','multilevel')),shares jsonb not null check(jsonb_typeof(shares)='array' and jsonb_array_length(shares)<=32),
 reason text not null check(length(btrim(reason)) between 3 and 500),actor_id uuid not null,command_id uuid not null,recorded_at timestamptz not null default clock_timestamp(),unique(unit_id,revision)
);
create table public._work_unit_metadata_floor_current(unit_id uuid primary key,revision_id uuid not null references public._work_unit_metadata_floors(id));
create table public._work_unit_metadata_commands(
 command_id uuid primary key,actor_id uuid not null,unit_id uuid,unit_binding jsonb,project_id uuid,origin_jobs jsonb not null,
 check((unit_id is null and unit_binding is null) or (unit_id is not null and unit_binding is not null and jsonb_typeof(unit_binding)='object' and unit_binding->>'unitId'=unit_id::text)),
 request jsonb not null check(jsonb_typeof(request)='object' and octet_length(request::text)<=32768),result jsonb not null,
 recorded_at timestamptz not null default clock_timestamp()
);

-- Actor history keeps the named profile. RESTRICT never erases or detaches evidence.
alter table public._work_unit_metadata_definitions add constraint metadata_actor_retention foreign key(actor_id) references public.profiles(id) on delete restrict not deferrable;
create index work_unit_metadata_actor_definitions on public._work_unit_metadata_definitions(actor_id);
alter table public._work_unit_metadata_versions add constraint metadata_actor_retention foreign key(actor_id) references public.profiles(id) on delete restrict not deferrable;
create index work_unit_metadata_actor_versions on public._work_unit_metadata_versions(actor_id);
alter table public._work_unit_metadata_proposals add constraint metadata_actor_retention foreign key(actor_id) references public.profiles(id) on delete restrict not deferrable;
create index work_unit_metadata_actor_proposals on public._work_unit_metadata_proposals(actor_id);
alter table public._work_unit_metadata_revisions add constraint metadata_actor_retention foreign key(actor_id) references public.profiles(id) on delete restrict not deferrable;
create index work_unit_metadata_actor_revisions on public._work_unit_metadata_revisions(actor_id);
alter table public._work_unit_metadata_floors add constraint metadata_actor_retention foreign key(actor_id) references public.profiles(id) on delete restrict not deferrable;
create index work_unit_metadata_actor_floors on public._work_unit_metadata_floors(actor_id);
alter table public._work_unit_metadata_commands add constraint metadata_actor_retention foreign key(actor_id) references public.profiles(id) on delete restrict not deferrable;
create index work_unit_metadata_actor_commands on public._work_unit_metadata_commands(actor_id);

create index work_unit_metadata_commands_unit on public._work_unit_metadata_commands(unit_id) where unit_id is not null;

create table public._work_unit_metadata_contract(proof_key text primary key check(proof_key='metadata_v1'),expected_catalog_sha256 text not null check(expected_catalog_sha256 ~ '^[0-9a-f]{64}$'));

create function public._work_unit_metadata_immutable() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin raise exception using errcode='23514',message='Unit metadata history is immutable.';end$$;
create function public._work_unit_metadata_gate() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin perform public._work_activity_read_committed();perform public._work_activity_gate();perform pg_advisory_xact_lock(7710,0);return null;end$$;
-- METADATA_TABLE_CONTROLS_BEGIN
alter table public._work_unit_metadata_definitions enable row level security;
revoke all on table public._work_unit_metadata_definitions from public,anon,authenticated,service_role;
create trigger metadata_gate before insert or update or delete or truncate on public._work_unit_metadata_definitions for each statement execute function public._work_unit_metadata_gate();
create trigger metadata_immutable before update or delete or truncate on public._work_unit_metadata_definitions for each statement execute function public._work_unit_metadata_immutable();
alter table public._work_unit_metadata_versions enable row level security;
revoke all on table public._work_unit_metadata_versions from public,anon,authenticated,service_role;
create trigger metadata_gate before insert or update or delete or truncate on public._work_unit_metadata_versions for each statement execute function public._work_unit_metadata_gate();
create trigger metadata_immutable before update or delete or truncate on public._work_unit_metadata_versions for each statement execute function public._work_unit_metadata_immutable();
alter table public._work_unit_metadata_proposals enable row level security;
revoke all on table public._work_unit_metadata_proposals from public,anon,authenticated,service_role;
create trigger metadata_gate before insert or update or delete or truncate on public._work_unit_metadata_proposals for each statement execute function public._work_unit_metadata_gate();
create trigger metadata_immutable before update or delete or truncate on public._work_unit_metadata_proposals for each statement execute function public._work_unit_metadata_immutable();
alter table public._work_unit_metadata_revisions enable row level security;
revoke all on table public._work_unit_metadata_revisions from public,anon,authenticated,service_role;
create trigger metadata_gate before insert or update or delete or truncate on public._work_unit_metadata_revisions for each statement execute function public._work_unit_metadata_gate();
create trigger metadata_immutable before update or delete or truncate on public._work_unit_metadata_revisions for each statement execute function public._work_unit_metadata_immutable();
alter table public._work_unit_metadata_current enable row level security;
revoke all on table public._work_unit_metadata_current from public,anon,authenticated,service_role;
create trigger metadata_gate before insert or update or delete or truncate on public._work_unit_metadata_current for each statement execute function public._work_unit_metadata_gate();
alter table public._work_unit_metadata_floors enable row level security;
revoke all on table public._work_unit_metadata_floors from public,anon,authenticated,service_role;
create trigger metadata_gate before insert or update or delete or truncate on public._work_unit_metadata_floors for each statement execute function public._work_unit_metadata_gate();
create trigger metadata_immutable before update or delete or truncate on public._work_unit_metadata_floors for each statement execute function public._work_unit_metadata_immutable();
alter table public._work_unit_metadata_floor_current enable row level security;
revoke all on table public._work_unit_metadata_floor_current from public,anon,authenticated,service_role;
create trigger metadata_gate before insert or update or delete or truncate on public._work_unit_metadata_floor_current for each statement execute function public._work_unit_metadata_gate();
alter table public._work_unit_metadata_commands enable row level security;
revoke all on table public._work_unit_metadata_commands from public,anon,authenticated,service_role;
create trigger metadata_gate before insert or update or delete or truncate on public._work_unit_metadata_commands for each statement execute function public._work_unit_metadata_gate();
create trigger metadata_immutable before update or delete or truncate on public._work_unit_metadata_commands for each statement execute function public._work_unit_metadata_immutable();
alter table public._work_unit_metadata_contract enable row level security;
revoke all on table public._work_unit_metadata_contract from public,anon,authenticated,service_role;
create trigger metadata_gate before insert or update or delete or truncate on public._work_unit_metadata_contract for each statement execute function public._work_unit_metadata_gate();
create trigger metadata_immutable before update or delete or truncate on public._work_unit_metadata_contract for each statement execute function public._work_unit_metadata_immutable();
-- METADATA_TABLE_CONTROLS_END

-- Refuse any unrelated repair: the existing attacher may add only these three
-- newly constructed project-scoped tables. No old trigger is normalized.
do $metadata_sandbox$ begin
 if exists(select 1 from public.sandbox_scoped_tables() s where s.table_name not in ('_work_unit_metadata_commands','_work_unit_metadata_definitions','_work_unit_metadata_proposals') and not exists(
 select 1 from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
 where n.nspname='public' and c.relname=s.table_name and t.tgname='guard_test_account_sandbox_only' and not t.tgisinternal
 and t.tgfoid='public.guard_test_account_sandbox_only()'::regprocedure and t.tgtype=31 and t.tgenabled in ('O','A')
 and t.tgargs=convert_to(s.link_column,'UTF8')||decode('00','hex')||convert_to(s.link_kind,'UTF8')||decode('00','hex'))) then
 raise exception using errcode='55000',message='Unit metadata sandbox source is unavailable.';end if;
end $metadata_sandbox$;
select public.attach_sandbox_guards();

create function public._work_unit_metadata_object(v jsonb,required text[],optional text[] default '{}') returns boolean
language sql immutable set search_path=public,pg_temp as $$
 select case when jsonb_typeof(v)='object' then v?&required and not exists(select 1 from jsonb_object_keys(v) k where not k=any(required||optional)) else false end
$$;
create function public._work_unit_metadata_decimal(v jsonb,positive boolean default false) returns numeric
language plpgsql immutable set search_path=public,pg_temp as $$
declare s text;n numeric;begin
 if jsonb_typeof(v) is distinct from 'string' then raise exception using errcode='23514',message='Invalid exact decimal.';end if;
 s:=v#>>'{}';if length(s) not between 1 and 100 or s!~'^[0-9]+([.][0-9]+)?$' then raise exception using errcode='23514',message='Invalid exact decimal.';end if;
 n:=s::numeric;if positive and n<=0 then raise exception using errcode='23514',message='A positive exact decimal is required.';end if;return n;end$$;
create function public._work_unit_metadata_uuid(v jsonb) returns uuid language plpgsql immutable set search_path=public,pg_temp as $$
begin if jsonb_typeof(v) is distinct from 'string' or (v#>>'{}')!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception using errcode='23514',message='Invalid metadata identity.';end if;return (v#>>'{}')::uuid;end$$;
create function public._work_unit_metadata_binding(p_unit uuid) returns jsonb language sql stable security definer set search_path=public,pg_temp as $$
 select jsonb_build_object('unitId',u.id,'incarnation',public._work_unit_fact_peek_epoch('unit_incarnation',u.id)::text,
 'projectId',u.project_id,'openingId',u.opening_id,'authorId',u.created_by,'authorIsTest',public.is_test_profile(u.created_by),'bindingEpoch',public._work_unit_fact_peek_epoch('unit_binding',u.id)::text,
 'projectEpoch',case when u.project_id is null then null else public._work_unit_fact_peek_epoch('project',u.project_id)::text end,
 'openingEpoch',case when u.opening_id is null then null else public._work_unit_fact_peek_epoch('opening',u.opening_id)::text end)
 from public.custom_work_units u where u.id=p_unit
$$;
create function public._work_unit_metadata_jobs_visible(actor uuid,jobs jsonb) returns boolean language plpgsql stable security definer set search_path=public,pg_temp as $$
declare j jsonb;begin if jsonb_typeof(jobs) is distinct from 'array' then return false;end if;for j in select value from jsonb_array_elements(jobs) loop
 if not public._ai_job_visible((j#>>'{}')::uuid,actor) then return false;end if;end loop;return true;end$$;
create function public._work_unit_metadata_origins(actor uuid,p_unit uuid) returns boolean language plpgsql stable security definer set search_path=public,pg_temp as $$
declare jobs jsonb;origin jsonb;begin
 for jobs in select origin_jobs from public._work_unit_metadata_revisions where unit_id=p_unit
 union all select origin_jobs from public._work_unit_metadata_floors where unit_id=p_unit
 union all select origin_jobs from public._work_unit_metadata_commands where unit_id=p_unit loop
 if not public._work_unit_metadata_jobs_visible(actor,jobs) then return false;end if;end loop;
 for origin in select binding from public._work_unit_metadata_revisions where unit_id=p_unit
 union all select basis->'binding' from public._work_unit_metadata_floors where unit_id=p_unit
 union all select unit_binding from public._work_unit_metadata_commands where unit_id=p_unit loop
 if origin is null or not public._work_unit_fact_context_visible(actor,case when origin->>'projectId' is null then 'unassigned' else 'job' end,
 (origin->>'projectId')::uuid,(origin->>'openingId')::uuid,(origin->>'authorId')::uuid,(origin->>'authorIsTest')::boolean,true) then return false;end if;end loop;
 return true;end$$;
create function public._work_unit_metadata_coverage() returns boolean language sql stable security definer set search_path=public,pg_temp as $$ select false $$;
create function public._work_unit_metadata_number(v jsonb) returns numeric language plpgsql immutable set search_path=public,pg_temp as $$
declare s text;begin s:=v#>>'{}';if jsonb_typeof(v) is distinct from 'string' or length(s) not between 1 and 100 or s!~'^-?[0-9]+([.][0-9]+)?$' then raise exception using errcode='23514',message='Invalid exact number.';end if;return s::numeric;end$$;
create function public._work_unit_metadata_version(p_id uuid,p_kind text,p_project uuid,p_active boolean default true) returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare r public._work_unit_metadata_versions;d public._work_unit_metadata_definitions;lastrow public._work_unit_metadata_versions;
begin
 select * into r from public._work_unit_metadata_versions where id=p_id;select * into d from public._work_unit_metadata_definitions where id=r.definition_id;
 if r.id is null or d.kind is distinct from p_kind or d.project_id is distinct from p_project or r.state<>'published' then return null;end if;
 if not exists(select 1 from public._work_unit_metadata_commands c where c.command_id=r.command_id and c.actor_id=r.actor_id
 and c.request->>'action'='publish' and c.request#>>'{data,definitionId}'=d.id::text and c.request#>'{data,definition}'=r.value
 and c.result#>>'{result,versionId}'=r.id::text and (c.request#>>'{data,expectedVersion}')::integer=r.version-1)
 or r.predecessor_id is distinct from (select id from public._work_unit_metadata_versions where definition_id=d.id and version=r.version-1)
 or d.kind is distinct from r.value->>'kind' or d.code is distinct from r.value->>'code' then return null;end if;
 select * into lastrow from public._work_unit_metadata_versions where definition_id=d.id order by version desc limit 1;
 if p_active and (lastrow.id<>r.id or lastrow.state<>'published') then return null;end if;
 return jsonb_build_object('id',r.id,'definitionId',d.id,'version',r.version,'kind',d.kind,'projectId',d.project_id,'code',d.code,'value',r.value,'retired',lastrow.state='retired');
end$$;
create function public._work_unit_metadata_validate_definition(v jsonb,p_project uuid) returns void
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare k text;parent jsonb;x jsonb;ids text[]:='{}';t text;lo numeric;hi numeric;begin
 if not public._work_unit_metadata_object(v,array['kind','code','labelEn','labelEs'],array['parentVersionId','fieldType','required','unit','min','max','options','dimension','members']) then raise exception using errcode='23514',message='Invalid metadata definition.';end if;
 k:=v->>'kind';if k is null or k not in ('category','subtype','material','component','field','floor','group') or jsonb_typeof(v->'code') is distinct from 'string' or (v->>'code')!~'^[a-z][a-z0-9_]{0,79}$'
 or jsonb_typeof(v->'labelEn') is distinct from 'string' or length(btrim(v->>'labelEn')) not between 1 and 120 or jsonb_typeof(v->'labelEs') is distinct from 'string' or length(btrim(v->>'labelEs')) not between 1 and 120
 or ((k='floor') is distinct from (p_project is not null)) then raise exception using errcode='23514',message='Invalid metadata definition.';end if;
 if k='category' and v->>'code' not in ('window','door','storefront') then raise exception using errcode='23514',message='Unknown root category.';end if;
 if k not in ('subtype','group') and v?'parentVersionId' or k<>'field' and v?|array['fieldType','required','min','max','options'] or k not in ('field','component') and v?'unit' or k<>'group' and v?|array['dimension','members'] then raise exception using errcode='23514',message='Invalid definition attributes.';end if;
 if k='subtype' then
 parent:=public._work_unit_metadata_version(public._work_unit_metadata_uuid(v->'parentVersionId'),'category',null);if parent is null then raise exception using errcode='23514',message='Category version is unavailable.';end if;
 end if;
 if k='component' and (jsonb_typeof(v->'unit') is distinct from 'string' or v->>'unit' not in ('count','in','ft','mm','cm','sq_ft','sq_m')) then raise exception using errcode='23514',message='Component quantity unit is required.';end if;
 if k='field' then
 t:=v->>'fieldType';if t is null or t not in ('text','number','boolean','single_select','multi_select') or jsonb_typeof(v->'required') is distinct from 'boolean' then raise exception using errcode='23514',message='Invalid typed field.';end if;
 if t<>'number' and v?|array['min','max','unit'] or t not in ('single_select','multi_select') and v?'options' then raise exception using errcode='23514',message='Invalid typed field attributes.';end if;
 if t='number' then
 if v?'min' then lo:=public._work_unit_metadata_number(v->'min');end if;if v?'max' then hi:=public._work_unit_metadata_number(v->'max');end if;
 if lo>hi or (v?'unit' and (jsonb_typeof(v->'unit')<>'string' or v->>'unit' not in ('count','in','ft','mm','cm','sq_ft','sq_m','min','h','lb','kg'))) then raise exception using errcode='23514',message='Invalid numeric field bounds.';end if;
 end if;
 if t in ('single_select','multi_select') then
 if jsonb_typeof(v->'options') is distinct from 'array' or jsonb_array_length(v->'options') not between 1 and 40 then raise exception using errcode='23514',message='Invalid field options.';end if;
 for x in select value from jsonb_array_elements(v->'options') loop
 if not public._work_unit_metadata_object(x,array['id','labelEn','labelEs']) or jsonb_typeof(x->'id')<>'string' or (x->>'id')!~'^[a-z][a-z0-9_]{0,79}$' or x->>'id'=any(ids)
 or jsonb_typeof(x->'labelEn')<>'string' or length(btrim(x->>'labelEn')) not between 1 and 120 or jsonb_typeof(x->'labelEs')<>'string' or length(btrim(x->>'labelEs')) not between 1 and 120 then raise exception using errcode='23514',message='Invalid field option.';end if;ids:=array_append(ids,x->>'id');end loop;
 end if;
 end if;
 if k='group' then
 if jsonb_typeof(v->'dimension') is distinct from 'string' or v->>'dimension' not in ('category','subtype','material') or jsonb_typeof(v->'members') is distinct from 'array' or jsonb_array_length(v->'members') not between 1 and 100 then raise exception using errcode='23514',message='Invalid exclusive group.';end if;
 if v?'parentVersionId' and v->'parentVersionId'<>'null' then parent:=public._work_unit_metadata_version(public._work_unit_metadata_uuid(v->'parentVersionId'),'group',null);if parent is null or parent#>>'{value,dimension}'<>v->>'dimension' then raise exception using errcode='23514',message='Parent group is unavailable.';end if;end if;
 for x in select value from jsonb_array_elements(v->'members') loop
 if public._work_unit_metadata_version(public._work_unit_metadata_uuid(x),v->>'dimension',null) is null or x#>>'{}'=any(ids) then raise exception using errcode='23514',message='Invalid group membership.';end if;
 if parent is not null and not (parent#>'{value,members}')@>jsonb_build_array(x) then raise exception using errcode='23514',message='Group is outside its parent.';end if;ids:=array_append(ids,x#>>'{}');end loop;
 end if;
end$$;
create function public._work_unit_metadata_validate_values(v jsonb,p_active boolean default true) returns void language plpgsql stable security definer set search_path=public,pg_temp as $$
declare k text;x jsonb;d jsonb;category_id text;ids text[]:='{}';options text[];item jsonb;n numeric;t text;begin
 if not public._work_unit_metadata_object(v,array['category','subtype','frameMaterial','components','fields']) then raise exception using errcode='23514',message='Invalid unit classification.';end if;
 foreach k in array array['category','subtype','frameMaterial'] loop
 x:=v->k;if x=jsonb_build_object('state','unknown') then continue;end if;
 if not public._work_unit_metadata_object(x,array['state','versionId']) or x->>'state' is distinct from 'known' then raise exception using errcode='23514',message='Invalid classification value.';end if;
 d:=public._work_unit_metadata_version(public._work_unit_metadata_uuid(x->'versionId'),case k when 'frameMaterial' then 'material' else k end,null,p_active);
 if d is null then raise exception using errcode='23514',message='Classification version is unavailable.';end if;
 if k='category' then category_id:=x->>'versionId';elsif k='subtype' and d#>>'{value,parentVersionId}' is distinct from category_id then raise exception using errcode='23514',message='Subtype requires its exact category version.';end if;
 end loop;
 if jsonb_typeof(v->'components') is distinct from 'array' or jsonb_array_length(v->'components')>30 or jsonb_typeof(v->'fields') is distinct from 'array' or jsonb_array_length(v->'fields')>40 then raise exception using errcode='23514',message='Classification list is too large.';end if;
 for x in select value from jsonb_array_elements(v->'components') loop
 if not public._work_unit_metadata_object(x,array['versionId','quantity']) then raise exception using errcode='23514',message='Invalid component.';end if;
 d:=public._work_unit_metadata_version(public._work_unit_metadata_uuid(x->'versionId'),'component',null,p_active);if d is null or x->>'versionId'=any(ids) then raise exception using errcode='23514',message='Component version is unavailable or duplicated.';end if;
 perform public._work_unit_metadata_decimal(x->'quantity',true);ids:=array_append(ids,x->>'versionId');end loop;
 ids:='{}';
 for x in select value from jsonb_array_elements(v->'fields') loop
 if not public._work_unit_metadata_object(x,array['versionId','state'],array['value']) or jsonb_typeof(x->'state') is distinct from 'string' or x->>'state' not in ('known','unknown','not_applicable') then raise exception using errcode='23514',message='Invalid field answer.';end if;
 d:=public._work_unit_metadata_version(public._work_unit_metadata_uuid(x->'versionId'),'field',null,p_active);if d is null or x->>'versionId'=any(ids) then raise exception using errcode='23514',message='Field version is unavailable or duplicated.';end if;ids:=array_append(ids,x->>'versionId');
 if x->>'state'<>'known' then if x?'value' or (d#>>'{value,required}')::boolean then raise exception using errcode='23514',message='Required field needs a known value.';end if;continue;end if;
 if not x?'value' then raise exception using errcode='23514',message='A known field needs its value.';end if;t:=d#>>'{value,fieldType}';
 if t='text' and (jsonb_typeof(x->'value')<>'string' or length(x->>'value')>1000 or ((d#>>'{value,required}')::boolean and length(btrim(x->>'value'))=0)) or t='boolean' and jsonb_typeof(x->'value')<>'boolean' then raise exception using errcode='23514',message='Invalid field value type.';end if;
 if t='number' then n:=public._work_unit_metadata_number(x->'value');if (d->'value'?'min' and n<public._work_unit_metadata_number(d#>'{value,min}')) or (d->'value'?'max' and n>public._work_unit_metadata_number(d#>'{value,max}')) then raise exception using errcode='23514',message='Field value is outside its bounds.';end if;end if;
 if t in ('single_select','multi_select') then
 select array_agg(z->>'id') into options from jsonb_array_elements(d#>'{value,options}')z;
 if t='single_select' then if jsonb_typeof(x->'value')<>'string' or not x->>'value'=any(options) then raise exception using errcode='23514',message='Unknown field option.';end if;
 else
 if jsonb_typeof(x->'value')<>'array' or jsonb_array_length(x->'value')>40 or ((d#>>'{value,required}')::boolean and jsonb_array_length(x->'value')=0) or (select count(*) from jsonb_array_elements(x->'value'))<>(select count(distinct a) from jsonb_array_elements(x->'value')a) then raise exception using errcode='23514',message='Invalid multiple selection.';end if;
 for item in select value from jsonb_array_elements(x->'value') loop if jsonb_typeof(item)<>'string' or not item#>>'{}'=any(options) then raise exception using errcode='23514',message='Unknown field option.';end if;end loop;
 end if;end if;
 end loop;
end$$;
create function public._work_unit_metadata_floor_basis(s jsonb,r jsonb) returns jsonb language sql stable security definer set search_path=public,pg_temp as $$
 select jsonb_build_object('binding',public._work_unit_metadata_binding((s#>>'{unit,id}')::uuid),'factId',s#>'{unit,fact,id}','factRevision',s#>'{unit,fact,revision}',
 'verificationId',r#>'{dimensionVerification,verificationId}','dimensionManifest',s->'dimension','scopeToken',s->'scopeToken',
 'reviewRevision',coalesce((r#>>'{basis,reviewRevision}')::integer,0),'submissionId',r#>'{basis,submissionId}','generation',r#>'{basis,generation}',
 'qcEventId',(select latest_qc_event_id from public.work_unit_review_current where unit_id=(s#>>'{unit,id}')::uuid and incarnation=(s#>>'{unit,incarnationEpoch}')::bigint))
$$;
create function public._work_unit_metadata_state(actor uuid,s jsonb,r jsonb) returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare u uuid:=(s#>>'{unit,id}')::uuid;m public._work_unit_metadata_revisions;f public._work_unit_metadata_floors;b jsonb;fb jsonb;floorok boolean:=true;x jsonb;v jsonb;begin
 if s is null or r is null or not public._work_unit_metadata_origins(actor,u) then return null;end if;
 select q.* into m from public._work_unit_metadata_revisions q join public._work_unit_metadata_current c on c.revision_id=q.id where c.unit_id=u;
 select q.* into f from public._work_unit_metadata_floors q join public._work_unit_metadata_floor_current c on c.revision_id=q.id where c.unit_id=u;
 if coalesce(m.revision,0)<>(select count(*) from public._work_unit_metadata_revisions where unit_id=u) or m.unit_id is distinct from u and m.id is not null
 or coalesce(f.revision,0)<>(select count(*) from public._work_unit_metadata_floors where unit_id=u) or f.unit_id is distinct from u and f.id is not null then return null;end if;
 if exists(select 1 from public._work_unit_metadata_revisions a where a.unit_id=u and
 ((a.revision=1 and a.predecessor_id is not null) or (a.revision>1 and not exists(select 1 from public._work_unit_metadata_revisions p where p.id=a.predecessor_id and p.unit_id=u and p.revision=a.revision-1)) or not exists(select 1 from public._work_unit_metadata_commands c where c.command_id=a.command_id and c.actor_id=a.actor_id and c.unit_id=u))) then return null;end if;
 if exists(select 1 from public._work_unit_metadata_floors a where a.unit_id=u and
 ((a.revision=1 and a.predecessor_id is not null) or (a.revision>1 and not exists(select 1 from public._work_unit_metadata_floors p where p.id=a.predecessor_id and p.unit_id=u and p.revision=a.revision-1)) or not exists(select 1 from public._work_unit_metadata_commands c where c.command_id=a.command_id and c.actor_id=a.actor_id and c.unit_id=u))) then return null;end if;
 if m.id is not null then
 begin perform public._work_unit_metadata_validate_values(m.value,false);exception when check_violation or invalid_text_representation or numeric_value_out_of_range then return null;end;
 if not exists(select 1 from public._work_unit_metadata_commands c where c.command_id=m.command_id and c.request->>'action'='assign'
 and c.request#>'{data,classification}'=m.value and c.request#>'{data,basis,binding}'=m.binding and c.result#>>'{result,revisionId}'=m.id::text) then return null;end if;
 end if;
 if f.id is not null then
 if not exists(select 1 from public._work_unit_metadata_commands c where c.command_id=f.command_id and c.request->>'action'='allocate'
 and (c.request#>'{data,basis}')-'floorRevision'=f.basis-'dimensionManifest' and c.request#>>'{data,state}'=f.state and c.result#>>'{result,revisionId}'=f.id::text
 and c.origin_jobs=f.origin_jobs and jsonb_array_length(c.request#>'{data,shares}')=jsonb_array_length(f.shares)
 and not exists(select 1 from jsonb_array_elements(f.shares) stored where not exists(select 1 from jsonb_array_elements(c.request#>'{data,shares}') requested
 where stored->>'versionId'=requested->>'versionId' and (stored->>'numerator')::numeric*(requested->>'denominator')::numeric=(requested->>'numerator')::numeric*(stored->>'denominator')::numeric))) then return null;end if;
 end if;
 b:=public._work_unit_metadata_binding(u);fb:=public._work_unit_metadata_floor_basis(s,r);
 if f.id is not null then for x in select value from jsonb_array_elements(f.shares) loop
 v:=public._work_unit_metadata_version((x->>'versionId')::uuid,'floor',(b->>'projectId')::uuid);if v is null then floorok:=false;end if;end loop;end if;
 return jsonb_build_object('unitId',u,'metadataBasis',jsonb_build_object('binding',b,'metadataRevision',coalesce(m.revision,0)),
 'floorBasis',(fb-'dimensionManifest')||jsonb_build_object('floorRevision',coalesce(f.revision,0)),
 'classification',jsonb_build_object('state',case when m.id is null then 'unknown' when m.binding=b then 'current' else 'noncurrent' end,'revisionId',m.id,'revision',coalesce(m.revision,0),'values',m.value),
 'floor',jsonb_build_object('state',coalesce(f.state,'unallocated'),'revisionId',f.id,'revision',coalesce(f.revision,0),'current',f.id is not null and f.basis=fb and floorok and r#>>'{dimensionVerification,state}'='verified' and r#>>'{qc,qcAccepted}'='true','shares',coalesce(f.shares,'[]')));
end$$;

create function public._work_unit_metadata_basis(v jsonb,p_floor boolean) returns void language plpgsql immutable set search_path=public,pg_temp as $$
declare b jsonb;k text;begin
 if not public._work_unit_metadata_object(v,case when p_floor then array['binding','factId','factRevision','verificationId','scopeToken','reviewRevision','submissionId','generation','qcEventId','floorRevision'] else array['binding','metadataRevision'] end) then raise exception using errcode='23514',message='Invalid metadata basis.';end if;
 b:=v->'binding';if not public._work_unit_metadata_object(b,array['unitId','incarnation','projectId','openingId','authorId','authorIsTest','bindingEpoch','projectEpoch','openingEpoch']) or jsonb_typeof(b->'authorIsTest') is distinct from 'boolean' then raise exception using errcode='23514',message='Invalid binding basis.';end if;
 perform public._work_unit_metadata_uuid(b->'unitId');
 foreach k in array array['projectId','openingId','authorId'] loop if b->k<>'null' then perform public._work_unit_metadata_uuid(b->k);end if;end loop;
 foreach k in array array['incarnation','bindingEpoch','projectEpoch','openingEpoch'] loop
 if b->k='null' and k in ('projectEpoch','openingEpoch') then continue;end if;
 if jsonb_typeof(b->k) is distinct from 'string' or (b->>k)!~'^[0-9]{1,16}$' or (b->>k)::numeric>9007199254740991 then raise exception using errcode='23514',message='Invalid binding epoch.';end if;end loop;
 foreach k in array case when p_floor then array['floorRevision','reviewRevision','generation','factRevision'] else array['metadataRevision'] end loop
 if p_floor and k='factRevision' and v->k='null' then continue;end if;
 if jsonb_typeof(v->k) is distinct from 'number' or (v->>k)!~'^[0-9]{1,10}$' or (v->>k)::numeric>2147483647 then raise exception using errcode='23514',message='Invalid metadata revision.';end if;end loop;
 if p_floor then
 foreach k in array array['factId','verificationId','submissionId','qcEventId'] loop if v->k<>'null' then perform public._work_unit_metadata_uuid(v->k);end if;end loop;
 if jsonb_typeof(v->'scopeToken') is distinct from 'string' or (v->>'scopeToken')!~'^ur1:[0-9a-f]{64}$' then raise exception using errcode='23514',message='Invalid floor scope token.';end if;
 end if;
end$$;
create function public.work_unit_metadata_read(p_unit_id uuid,p_protocol_version integer default 1) returns jsonb
language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare a uuid;s jsonb;r jsonb;m jsonb;catalog jsonb;begin
 if p_protocol_version is distinct from 1 or p_unit_id is null then raise exception using errcode='23514',message='Invalid metadata request.';end if;
 -- METADATA_BOUNDARY_a_BEGIN
 perform public._work_activity_read_committed();perform public._work_activity_gate();a:=public._work_activity_actor();perform pg_advisory_xact_lock(7710,0);a:=public._work_activity_actor();
 if not coalesce((select encode(sha256(convert_to(pin.value::text,'UTF8')),'hex')='63eb01e50016563968e2056c8997bc2a7b87d7221b20b5d253d7a1e751bc16b8' from (select jsonb_build_object('body',p.prosrc,'owner',pg_get_userbyid(p.proowner),'acl',p.proacl::text,'definer',p.prosecdef,'config',p.proconfig,'volatility',p.provolatile,'strict',p.proisstrict,'leakproof',p.proleakproof,'parallel',p.proparallel,'kind',p.prokind,'set',p.proretset,'result',pg_get_function_result(p.oid),'args',pg_get_function_identity_arguments(p.oid),'defaults',pg_get_expr(p.proargdefaults,0),'cost',p.procost,'rows',p.prorows,'support',p.prosupport::regprocedure::text,'language',(select lanname from pg_language where oid=p.prolang)) value from pg_proc p where p.oid=to_regprocedure('public._work_unit_metadata_coverage()'))pin),false) then a:=null;
 elsif not public._work_unit_metadata_coverage() or not public._work_unit_review_coverage() or not public._work_totals_coverage() or not public._work_unit_contributors_coverage() then a:=null;end if;
 -- METADATA_BOUNDARY_a_END
if a is not null then s:=public._work_unit_review_scope(a,p_unit_id);r:=public._work_unit_review_view(a,s);m:=public._work_unit_metadata_state(a,s,r);end if;
 if m is null then return jsonb_build_object('protocolVersion',1,'availability','unavailable','metadata',null);end if;
 select coalesce(jsonb_agg(jsonb_build_object('definitionId',d.id,'versionId',v.id,'version',v.version,'kind',d.kind,'projectId',d.project_id,'code',d.code,'state',v.state,'definition',v.value) order by d.kind,d.id,v.version),'[]') into catalog
 from public._work_unit_metadata_definitions d join public._work_unit_metadata_versions v on v.definition_id=d.id
 where d.project_id is null or d.project_id=(s#>>'{unit,projectId}')::uuid;
 if jsonb_array_length(catalog)>500 or octet_length(catalog::text)>1000000 then return jsonb_build_object('protocolVersion',1,'availability','unavailable','metadata',null);end if;
 return jsonb_build_object('protocolVersion',1,'availability','available','metadata',m||jsonb_build_object('asOf',public._work_activity_iso(clock_timestamp()),'catalog',catalog,
 'capabilities',jsonb_build_object('assign',public._is_lead(a) or exists(select 1 from public.custom_work_units where id=p_unit_id and created_by=a),'allocate',public._work_unit_review_authority(a,s->'jobs','dimensions_edit'),'publish',public._work_config_is_owner(a),'propose',public._work_config_is_supervisor(a))));
end$$;
create function public.work_unit_metadata_receipt(p_command_id uuid,p_protocol_version integer default 1) returns jsonb
language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare a uuid;c public._work_unit_metadata_commands;s jsonb;begin
 if p_protocol_version is distinct from 1 or p_command_id is null then raise exception using errcode='23514',message='Invalid metadata receipt request.';end if;
 -- METADATA_BOUNDARY_a_BEGIN
 perform public._work_activity_read_committed();perform public._work_activity_gate();a:=public._work_activity_actor();perform pg_advisory_xact_lock(7710,0);a:=public._work_activity_actor();
 if not coalesce((select encode(sha256(convert_to(pin.value::text,'UTF8')),'hex')='63eb01e50016563968e2056c8997bc2a7b87d7221b20b5d253d7a1e751bc16b8' from (select jsonb_build_object('body',p.prosrc,'owner',pg_get_userbyid(p.proowner),'acl',p.proacl::text,'definer',p.prosecdef,'config',p.proconfig,'volatility',p.provolatile,'strict',p.proisstrict,'leakproof',p.proleakproof,'parallel',p.proparallel,'kind',p.prokind,'set',p.proretset,'result',pg_get_function_result(p.oid),'args',pg_get_function_identity_arguments(p.oid),'defaults',pg_get_expr(p.proargdefaults,0),'cost',p.procost,'rows',p.prorows,'support',p.prosupport::regprocedure::text,'language',(select lanname from pg_language where oid=p.prolang)) value from pg_proc p where p.oid=to_regprocedure('public._work_unit_metadata_coverage()'))pin),false) then a:=null;
 elsif not public._work_unit_metadata_coverage() or not public._work_unit_review_coverage() or not public._work_totals_coverage() or not public._work_unit_contributors_coverage() then a:=null;end if;
 -- METADATA_BOUNDARY_a_END
 if a is null then return jsonb_build_object('protocolVersion',1,'availability','unavailable','receipt',null);end if;
 select * into c from public._work_unit_metadata_commands where command_id=p_command_id and actor_id=a;
 if a is null or c.command_id is null or not public._work_unit_metadata_jobs_visible(a,c.origin_jobs) then return jsonb_build_object('protocolVersion',1,'availability','unavailable','receipt',null);end if;
 if c.unit_id is not null then
 s:=public._work_unit_review_scope(a,c.unit_id);if s is null or c.unit_binding->>'incarnation' is distinct from s#>>'{unit,incarnationEpoch}' or not public._work_unit_metadata_origins(a,c.unit_id) then return jsonb_build_object('protocolVersion',1,'availability','unavailable','receipt',null);end if;
 end if;
 return jsonb_build_object('protocolVersion',1,'availability','available','receipt',c.result);
end$$;
create function public.work_unit_metadata_command(p_command_id uuid,p_protocol_version integer,p_request jsonb) returns jsonb
language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare a uuid;act text;data jsonb;target uuid;project uuid;d public._work_unit_metadata_definitions;v public._work_unit_metadata_versions;
 unitrow public.custom_work_units;c public._work_unit_metadata_commands;s jsonb;r jsonb;m jsonb;jobs jsonb:='[]';result jsonb;outid uuid:=gen_random_uuid();reason text;applied boolean:=true;
 mr public._work_unit_metadata_revisions;fr public._work_unit_metadata_floors;binding jsonb;definition jsonb;k text;prev uuid;ver integer;expected integer;
 x jsonb;fv jsonb;shares jsonb:='[]';seen uuid[]:='{}';n numeric;den numeric;sn numeric:=0;sd numeric:=1;g numeric;parent uuid;depth integer;
begin
 -- METADATA_BOUNDARY_a_BEGIN
 perform public._work_activity_read_committed();perform public._work_activity_gate();a:=public._work_activity_actor();perform pg_advisory_xact_lock(7710,0);a:=public._work_activity_actor();
 if not coalesce((select encode(sha256(convert_to(pin.value::text,'UTF8')),'hex')='63eb01e50016563968e2056c8997bc2a7b87d7221b20b5d253d7a1e751bc16b8' from (select jsonb_build_object('body',p.prosrc,'owner',pg_get_userbyid(p.proowner),'acl',p.proacl::text,'definer',p.prosecdef,'config',p.proconfig,'volatility',p.provolatile,'strict',p.proisstrict,'leakproof',p.proleakproof,'parallel',p.proparallel,'kind',p.prokind,'set',p.proretset,'result',pg_get_function_result(p.oid),'args',pg_get_function_identity_arguments(p.oid),'defaults',pg_get_expr(p.proargdefaults,0),'cost',p.procost,'rows',p.prorows,'support',p.prosupport::regprocedure::text,'language',(select lanname from pg_language where oid=p.prolang)) value from pg_proc p where p.oid=to_regprocedure('public._work_unit_metadata_coverage()'))pin),false) then a:=null;
 elsif not public._work_unit_metadata_coverage() or not public._work_unit_review_coverage() or not public._work_totals_coverage() or not public._work_unit_contributors_coverage() then a:=null;end if;
 -- METADATA_BOUNDARY_a_END
 if a is null then return jsonb_build_object('protocolVersion',1,'availability','unavailable','receipt',null);end if;
 if p_command_id is null or p_protocol_version is distinct from 1 or not public._work_unit_metadata_object(p_request,array['action','data']) or octet_length(p_request::text)>32768 or jsonb_typeof(p_request->'action')<>'string' or jsonb_typeof(p_request->'data')<>'object' then raise exception using errcode='23514',message='Invalid metadata command.';end if;
 act:=p_request->>'action';data:=p_request->'data';if act not in ('publish','propose','retire','assign','allocate') then raise exception using errcode='23514',message='Unknown metadata command.';end if;
 

 if act in ('publish','propose','retire') then
 if not public._work_config_is_supervisor(a) or (act<>'propose' and not public._work_config_is_owner(a)) then raise exception using errcode='42501',message='Metadata publishing authority is required.';end if;
 if act='retire' then
 if not public._work_unit_metadata_object(data,array['definitionId','expectedVersion']) then raise exception using errcode='23514',message='Invalid retire command.';end if;
 else
 if not public._work_unit_metadata_object(data,array['definitionId','expectedVersion','projectId','definition']) then raise exception using errcode='23514',message='Invalid definition command.';end if;
 end if;
 target:=public._work_unit_metadata_uuid(data->'definitionId');select * into d from public._work_unit_metadata_definitions where id=target;
 project:=case when act='retire' then d.project_id when data->'projectId'='null' then null else public._work_unit_metadata_uuid(data->'projectId') end;
 if project is not null and not public._ai_job_visible(project,a) or d.project_id is not null and not public._ai_job_visible(d.project_id,a) then return jsonb_build_object('protocolVersion',1,'availability','unavailable','receipt',null);end if;
 if project is not null then jobs:=jsonb_build_array(project);end if;
 if d.id is not null and d.project_id is distinct from project then raise exception using errcode='23514',message='A definition cannot move between projects.';end if;
 else
 if act='assign' then
 if not public._work_unit_metadata_object(data,array['unitId','basis','classification']) then raise exception using errcode='23514',message='Invalid classification command.';end if;
 else if not public._work_unit_metadata_object(data,array['unitId','basis','state','shares','reason']) then raise exception using errcode='23514',message='Invalid floor command.';end if;end if;
 perform public._work_unit_metadata_basis(data->'basis',act='allocate');
 target:=public._work_unit_metadata_uuid(data->'unitId');s:=public._work_unit_review_scope(a,target);r:=public._work_unit_review_view(a,s);m:=public._work_unit_metadata_state(a,s,r);
 if m is null then return jsonb_build_object('protocolVersion',1,'availability','unavailable','receipt',null);end if;
 select * into unitrow from public.custom_work_units where id=target;project:=unitrow.project_id;jobs:=s->'jobs';
 if act='assign' and not (unitrow.created_by=a or public._is_lead(a)) or act='allocate' and not public._work_unit_review_authority(a,jobs,'dimensions_edit') then raise exception using errcode='42501',message='Unit metadata authority is required.';end if;
 end if;
 -- Fresh authority precedes lookup. Global G serializes even missing-key retries.
 select * into c from public._work_unit_metadata_commands where command_id=p_command_id;
 if found then
 if c.actor_id<>a or c.request<>p_request or (c.unit_id is not null and (c.unit_id is distinct from target or c.unit_binding->>'incarnation' is distinct from m#>>'{metadataBasis,binding,incarnation}')) or not public._work_unit_metadata_jobs_visible(a,c.origin_jobs) then return jsonb_build_object('protocolVersion',1,'availability','unavailable','receipt',null);end if;
 return jsonb_build_object('protocolVersion',1,'availability','available','receipt',c.result);end if;
 if act in ('publish','propose','retire') then
 if jsonb_typeof(data->'expectedVersion') is distinct from 'number' or (data->>'expectedVersion')!~'^[0-9]{1,9}$' then raise exception using errcode='23514',message='Invalid definition revision.';end if;expected:=(data->>'expectedVersion')::integer;
 select * into d from public._work_unit_metadata_definitions where id=target for update;
 select * into v from public._work_unit_metadata_versions where definition_id=target order by version desc limit 1;
 ver:=coalesce(v.version,0);if expected<>ver or ver>=2147483646 then applied:=false;reason:='stale_basis';end if;
 if act='retire' then if d.id is null then applied:=false;reason:='stale_basis';end if;definition:=v.value;
 else definition:=data->'definition';perform public._work_unit_metadata_validate_definition(definition,project);end if;
 if d.id is not null and act<>'retire' and (d.kind is distinct from definition->>'kind' or d.code is distinct from definition->>'code') then raise exception using errcode='23514',message='Definition identity cannot change kind or code.';end if;
 if act='propose' then
 insert into public._work_unit_metadata_proposals values(outid,a,p_command_id,project,data,clock_timestamp());result:=jsonb_build_object('proposalId',outid);applied:=true;
 elsif applied then
 if definition->>'kind'='group' then
 parent:=nullif(definition->>'parentVersionId','')::uuid;depth:=0;
 while parent is not null loop
 select * into v from public._work_unit_metadata_versions where id=parent;depth:=depth+1;
 if v.definition_id=target or depth>=8 then raise exception using errcode='23514',message='Group ancestry is cyclic or too deep.';end if;parent:=nullif(v.value->>'parentVersionId','')::uuid;end loop;
 if exists(select 1 from public._work_unit_metadata_versions z join public._work_unit_metadata_definitions zd on zd.id=z.definition_id
 where zd.kind='group' and zd.id<>target and z.state='published' and not exists(select 1 from public._work_unit_metadata_versions newer where newer.definition_id=zd.id and newer.version>z.version)
 and z.value->>'dimension'=definition->>'dimension' and z.value->>'parentVersionId' is not distinct from definition->>'parentVersionId'
 and exists(select 1 from jsonb_array_elements(z.value->'members') item(value) where definition->'members'@>jsonb_build_array(item.value))) then raise exception using errcode='23514',message='Exclusive sibling groups overlap.';end if;
 end if;
 if d.id is null then insert into public._work_unit_metadata_definitions(id,kind,code,project_id,actor_id) values(target,definition->>'kind',definition->>'code',project,a);end if;
 select id into prev from public._work_unit_metadata_versions where definition_id=target order by version desc limit 1;
 insert into public._work_unit_metadata_versions(id,definition_id,version,predecessor_id,state,value,actor_id,command_id) values(outid,target,ver+1,prev,case when act='retire' then 'retired' else 'published' end,definition,a,p_command_id);
 result:=jsonb_build_object('definitionId',target,'versionId',outid,'version',ver+1);
 end if;
 else
 perform 1 from public.custom_work_units where id=target for update;
 -- No physical fact/operational revision occurs in classification CAS.
 if act='assign' then
 select q.* into mr from public._work_unit_metadata_revisions q join public._work_unit_metadata_current cc on cc.revision_id=q.id where cc.unit_id=target;
 if data->'basis' is distinct from m->'metadataBasis' or coalesce(mr.revision,0)>=2147483646 then applied:=false;reason:='stale_basis';end if;
 perform public._work_unit_metadata_validate_values(data->'classification');
 if applied then
 binding:=public._work_unit_metadata_binding(target);
 insert into public._work_unit_metadata_revisions(id,unit_id,incarnation,revision,predecessor_id,binding,origin_jobs,value,observed_fact_id,actor_id,command_id)
 values(outid,target,(binding->>'incarnation')::bigint,coalesce(mr.revision,0)+1,mr.id,binding,jobs,data->'classification',(s#>>'{unit,fact,id}')::uuid,a,p_command_id);
 insert into public._work_unit_metadata_current values(target,outid) on conflict(unit_id) do update set revision_id=excluded.revision_id;
 result:=jsonb_build_object('unitId',target,'revisionId',outid,'revision',coalesce(mr.revision,0)+1);end if;
 else
 select q.* into fr from public._work_unit_metadata_floors q join public._work_unit_metadata_floor_current cc on cc.revision_id=q.id where cc.unit_id=target;
 if data->'basis' is distinct from m->'floorBasis' or coalesce(fr.revision,0)>=2147483646 then applied:=false;reason:='stale_basis';end if;
 if data->>'state' not in ('unknown','unallocated','single','multilevel') or jsonb_typeof(data->'state') is distinct from 'string' or jsonb_typeof(data->'shares') is distinct from 'array' or jsonb_array_length(data->'shares')>32 or jsonb_typeof(data->'reason') is distinct from 'string' or length(btrim(data->>'reason')) not between 3 and 500 then raise exception using errcode='23514',message='Invalid floor allocation.';end if;
 if data->>'state' in ('unknown','unallocated') then if data->'shares'<>'[]' then raise exception using errcode='23514',message='Unallocated floors cannot contain trusted shares.';end if;
 else
 if r#>>'{dimensionVerification,state}'<>'verified' or r#>>'{qc,qcAccepted}'<>'true' then applied:=false;reason:='physical_proof_required';end if;
 if (data->>'state'='single' and jsonb_array_length(data->'shares')<>1) or (data->>'state'='multilevel' and jsonb_array_length(data->'shares')<2) then raise exception using errcode='23514',message='Allocation state disagrees with its shares.';end if;
 for x in select value from jsonb_array_elements(data->'shares') loop
 if not public._work_unit_metadata_object(x,array['versionId','numerator','denominator']) then raise exception using errcode='23514',message='Invalid floor share.';end if;
 fv:=public._work_unit_metadata_version(public._work_unit_metadata_uuid(x->'versionId'),'floor',project);
 if fv is null or (fv->>'definitionId')::uuid=any(seen) then raise exception using errcode='23514',message='Floor version is unavailable or duplicated.';end if;seen:=array_append(seen,(fv->>'definitionId')::uuid);
 if (x->>'numerator')!~'^[0-9]{1,100}$' or (x->>'denominator')!~'^[0-9]{1,100}$' then raise exception using errcode='23514',message='Floor shares require exact integers.';end if;
 n:=public._work_unit_metadata_decimal(x->'numerator',true);den:=public._work_unit_metadata_decimal(x->'denominator',true);g:=gcd(n,den);n:=n/g;den:=den/g;sn:=sn*den+n*sd;sd:=sd*den;g:=gcd(sn,sd);sn:=sn/g;sd:=sd/g;
 shares:=shares||jsonb_build_array(jsonb_build_object('versionId',x->'versionId','floorId',fv->'definitionId','numerator',trim_scale(n)::text,'denominator',trim_scale(den)::text));end loop;
 if sn<>sd then raise exception using errcode='23514',message='Floor shares must sum exactly to one.';end if;
 end if;
 if applied then
 binding:=public._work_unit_metadata_binding(target);
 insert into public._work_unit_metadata_floors(id,unit_id,incarnation,revision,predecessor_id,basis,origin_jobs,state,shares,reason,actor_id,command_id)
 values(outid,target,(binding->>'incarnation')::bigint,coalesce(fr.revision,0)+1,fr.id,public._work_unit_metadata_floor_basis(s,r),jobs,data->>'state',shares,data->>'reason',a,p_command_id);
 insert into public._work_unit_metadata_floor_current values(target,outid) on conflict(unit_id) do update set revision_id=excluded.revision_id;
 result:=jsonb_build_object('unitId',target,'revisionId',outid,'revision',coalesce(fr.revision,0)+1);end if;
 end if;
 end if;
 result:=jsonb_build_object('commandId',p_command_id,'action',act,'status',case when applied then 'applied' else 'rejected' end,'reason',case when applied then null else reason end,'result',case when applied then result else null end);
 insert into public._work_unit_metadata_commands(command_id,actor_id,unit_id,unit_binding,project_id,origin_jobs,request,result) values(p_command_id,a,case when act in ('assign','allocate') then target else null end,case when act in ('assign','allocate') then m#>'{metadataBasis,binding}' else null end,project,jobs,p_request,result);
 return jsonb_build_object('protocolVersion',1,'availability','available','receipt',result);
end$$;

create function public._work_unit_metadata_members(p_units uuid[]) returns jsonb language sql stable security definer set search_path=public,pg_temp as $$
 with versions as materialized (
 select source_kind kind,source_id,b.value from public.work_activity_source_history h cross join lateral(values(h.before_value),(h.after_value)) b(value) where b.value<>'{}'
 union all select case e.source_kind when 'custom' then 'custom_work_sessions' when 'unit' then 'unit_sessions' when 'task' then 'task_sessions' when 'service' then 'service_time_sessions' when 'phase' then 'opening_phases' when 'helper' then 'summon_helpers' end,e.source_id::text,b.value
 from public.personal_activity_transition_sources e cross join lateral(values(e.before_evidence),(e.after_evidence))b(value) where e.source_kind in ('custom','unit','task','service','phase','helper') and b.value<>'{}'
 union all select kind,source_id,value from public._work_unit_review_live_sources
 ), units as materialized(select u.id uid,u.opening_id from public.custom_work_units u where u.id=any(p_units)),
 roots as materialized(select u.uid,v.value from units u join versions v on v.kind='custom_work_units' and v.source_id=u.uid::text),
 mapped as materialized(select uid,value->>'opening_id' id from roots where value->>'opening_id' is not null union select uid,opening_id::text from units where opening_id is not null),
 windows as materialized(select distinct m.uid,v.value->>'assigned_window_id' id from mapped m join versions v on v.kind='project_openings' and v.source_id=m.id),
 service_units as materialized(
 select u.uid,v.source_id id from units u join versions v on v.kind='service_visit_units' and v.value->>'work_unit_id'=u.uid::text
 union select m.uid,v.source_id from mapped m join versions v on v.kind='service_visit_units' and v.value->>'opening_id'=m.id
 union select w.uid,v.source_id from windows w join versions v on v.kind='service_visit_units' and v.value->>'window_id'=w.id),
 summons_for_unit as materialized(select distinct m.uid,v.source_id id from mapped m join versions v on v.kind='summons' and v.value->>'opening_id'=m.id),
 crew as materialized(select distinct u.uid,v.source_id id from units u join versions v on v.kind='crew_work_records' and v.value->>'unit_id'=u.uid::text),
 custom_sessions as materialized(
 select u.uid,v.source_id id from units u join versions v on v.kind='custom_work_sessions' and v.value->>'unit_id'=u.uid::text
 union select u.uid,v.value->>'session_id' from units u join versions v on v.kind='work_session_capture_metadata' and v.value->>'unit_id'=u.uid::text),
 visits as materialized(select distinct su.uid,v.value->>'visit_id' id from service_units su join versions v on v.kind='service_visit_units' and v.source_id=su.id),
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
 ), grouped as(select u.uid,coalesce(jsonb_agg(jsonb_build_object('kind',s.kind,'id',s.source_id) order by s.kind,s.source_id) filter(where s.source_id is not null),'[]') sources
 from units u left join selected s on s.uid=u.uid group by u.uid)
 select case when (select count(*) from selected)>200000 or (select count(distinct(kind,source_id)) from selected)>20000 then null
 else coalesce(jsonb_object_agg(uid::text,sources),'{}') end from grouped
$$;

-- METADATA_REVIEW_ADAPTER_BEGIN
create function public._work_unit_metadata_live(p_sourceids jsonb) returns table(kind text,source_id text,value jsonb)
language sql stable security definer set search_path=public,pg_temp as $$
 with selected as materialized(select distinct x->>'kind' kind,x->>'id' id from jsonb_array_elements(p_sourceids)x)
 select 'custom_work_units'::text kind,r.id::text source_id,public._work_activity_source_material('custom_work_units',to_jsonb(r)) value from public.custom_work_units r where exists(select 1 from selected x where x.kind='custom_work_units' and x.id=r.id::text)
 union all
 select 'project_openings'::text kind,r.id::text source_id,public._work_activity_source_material('project_openings',to_jsonb(r)) value from public.project_openings r where exists(select 1 from selected x where x.kind='project_openings' and x.id=r.id::text)
 union all
 select 'service_visit_units'::text kind,r.id::text source_id,public._work_activity_source_material('service_visit_units',to_jsonb(r)) value from public.service_visit_units r where exists(select 1 from selected x where x.kind='service_visit_units' and x.id=r.id::text)
 union all
 select 'service_visits'::text kind,r.id::text source_id,public._work_activity_source_material('service_visits',to_jsonb(r)) value from public.service_visits r where exists(select 1 from selected x where x.kind='service_visits' and x.id=r.id::text)
 union all
 select 'summons'::text kind,r.id::text source_id,public._work_activity_source_material('summons',to_jsonb(r)) value from public.summons r where exists(select 1 from selected x where x.kind='summons' and x.id=r.id::text)
 union all
 select 'unit_redos'::text kind,r.id::text source_id,public._work_activity_source_material('unit_redos',to_jsonb(r)) value from public.unit_redos r where exists(select 1 from selected x where x.kind='unit_redos' and x.id=r.id::text)
 union all
 select 'qc_checks'::text kind,r.id::text source_id,public._work_activity_source_material('qc_checks',to_jsonb(r)) value from public.qc_checks r where exists(select 1 from selected x where x.kind='qc_checks' and x.id=r.id::text)
 union all
 select 'install_events'::text kind,r.id::text source_id,public._work_activity_source_material('install_events',to_jsonb(r)) value from public.install_events r where exists(select 1 from selected x where x.kind='install_events' and x.id=r.id::text)
 union all
 select 'crew_work_records'::text kind,r.id::text source_id,public._work_activity_source_material('crew_work_records',to_jsonb(r)) value from public.crew_work_records r where exists(select 1 from selected x where x.kind='crew_work_records' and x.id=r.id::text)
 union all
 select 'crew_work_record_people'::text kind,r.record_id::text||':'||r.profile_id::text source_id,public._work_activity_source_material('crew_work_record_people',to_jsonb(r)) value from public.crew_work_record_people r where exists(select 1 from selected x where x.kind='crew_work_record_people' and x.id=r.record_id::text||':'||r.profile_id::text)
 union all
 select 'work_session_capture_metadata'::text kind,r.session_id::text source_id,public._work_activity_source_material('work_session_capture_metadata',to_jsonb(r)) value from public.work_session_capture_metadata r where exists(select 1 from selected x where x.kind='work_session_capture_metadata' and x.id=r.session_id::text)
 union all
 select 'custom_work_history'::text kind,r.id::text source_id,public._work_activity_source_material('custom_work_history',to_jsonb(r)) value from public.custom_work_history r where exists(select 1 from selected x where x.kind='custom_work_history' and x.id=r.id::text)
 union all
 select 'custom_work_sessions'::text kind,r.id::text source_id,public._work_activity_source_material('custom_work_sessions',to_jsonb(r)) value from public.custom_work_sessions r where exists(select 1 from selected x where x.kind='custom_work_sessions' and x.id=r.id::text)
 union all
 select 'unit_sessions'::text kind,r.id::text source_id,public._work_activity_source_material('unit_sessions',to_jsonb(r)) value from public.unit_sessions r where exists(select 1 from selected x where x.kind='unit_sessions' and x.id=r.id::text)
 union all
 select 'task_sessions'::text kind,r.id::text source_id,public._work_activity_source_material('task_sessions',to_jsonb(r)) value from public.task_sessions r where exists(select 1 from selected x where x.kind='task_sessions' and x.id=r.id::text)
 union all
 select 'service_time_sessions'::text kind,r.id::text source_id,public._work_activity_source_material('service_time_sessions',to_jsonb(r)) value from public.service_time_sessions r where exists(select 1 from selected x where x.kind='service_time_sessions' and x.id=r.id::text)
 union all
 select 'opening_phases'::text kind,r.id::text source_id,public._work_activity_source_material('opening_phases',to_jsonb(r)) value from public.opening_phases r where exists(select 1 from selected x where x.kind='opening_phases' and x.id=r.id::text)
 union all
 select 'summon_helpers'::text kind,r.id::text source_id,public._work_activity_source_material('summon_helpers',to_jsonb(r)) value from public.summon_helpers r where exists(select 1 from selected x where x.kind='summon_helpers' and x.id=r.id::text)
$$;
create function public._work_unit_metadata_scope(actor uuid,unit_id uuid,p_sourceids jsonb) returns jsonb
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
create function public._work_unit_metadata_review(actor uuid,s jsonb) returns jsonb
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
 proof:=(s->>'proven')::boolean; -- Top-level admission already attested exact coverage.
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
-- METADATA_REVIEW_ADAPTER_END
-- METADATA_PARTITION_ADAPTER_BEGIN
create function public._work_unit_metadata_shift_ids(p_project_id uuid,p_unit_id uuid,unit_scope jsonb) returns uuid[]
language sql stable security definer set search_path=public,pg_temp as $$
 select array_agg(distinct id) from (
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
$$;
create function public._work_unit_metadata_partition(actor uuid,p_project_id uuid,p_unit_id uuid,stamp timestamptz,unit_scope jsonb,review jsonb,ids uuid[],p_ledgers jsonb) returns jsonb
language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare sid uuid;ledger jsonb;ledgers jsonb:='[]';rows jsonb;unitrow public.custom_work_units;
 available constant jsonb:='{"protocolVersion":1,"availability":"unavailable","totals":null}';complete boolean:=true;personal_complete boolean:=true;trusted boolean:=false;
 orphan record;orphan_proof jsonb;scope_unproven boolean:=false;own_scope_unproven boolean:=false;reconciliation_authorized boolean:=false;reconciliation_ledgers jsonb;orphan_count integer:=0;cohort jsonb;reason text[]:='{}';area numeric;factor_num numeric;factor_den numeric;labor numeric;own_labor numeric;actual numeric;cohort_scope boolean;
begin
 reconciliation_authorized:=public._work_unit_review_authority(actor,jsonb_build_array(p_project_id),'final_qc');
 if p_unit_id is not null then
 select * into unitrow from public.custom_work_units where id=p_unit_id;
 if unitrow.id is null or unitrow.project_id<>p_project_id then return available;end if;
 if unit_scope is null or review is null then return available;end if;
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
 if coalesce(array_length(ids,1),0)>500 then return available;end if;
 foreach sid in array coalesce(ids,'{}') loop
 ledger:=p_ledgers->sid::text;
 if ledger is null or ledger->>'availability' is distinct from 'available' then return available;end if;
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
-- METADATA_PARTITION_ADAPTER_END
create function public._work_unit_metadata_fraction(n numeric,d numeric) returns jsonb language plpgsql immutable set search_path=public,pg_temp as $$
declare f numeric;g numeric;begin if n is null or d is null or n<0 or d<=0 then return null;end if;f:=('1'||repeat('0',greatest(scale(n),scale(d))))::numeric;n:=n*f;d:=d*f;g:=gcd(n,d);return jsonb_build_object('numerator',trim_scale(n/g)::text,'denominator',trim_scale(d/g)::text);end$$;
create function public._work_unit_metadata_area(s jsonb) returns jsonb language plpgsql immutable set search_path=public,pg_temp as $$
declare n numeric;d numeric;begin
 n:=case s#>>'{observation,unit}' when 'in' then 1 when 'ft' then 12 when 'mm' then 5 when 'cm' then 50 end;d:=case s#>>'{observation,unit}' when 'mm' then 127 when 'cm' then 127 else 1 end;
 if n is null or s#>>'{observation,widthDecimal}' is null or s#>>'{observation,heightDecimal}' is null then return null;end if;
 return public._work_unit_metadata_fraction((s#>>'{observation,widthDecimal}')::numeric*(s#>>'{observation,heightDecimal}')::numeric*n*n,d*d*144);end$$;
create function public._work_unit_metadata_area_add(a jsonb,b jsonb) returns jsonb language sql immutable set search_path=public,pg_temp as $$
 select public._work_unit_metadata_fraction((a->>'numerator')::numeric*(b->>'denominator')::numeric+(b->>'numerator')::numeric*(a->>'denominator')::numeric,(a->>'denominator')::numeric*(b->>'denominator')::numeric)
$$;
create function public._work_unit_metadata_ratio(us numeric,area jsonb) returns jsonb language sql immutable set search_path=public,pg_temp as $$
 select case when (area->>'numerator')::numeric>0 then public._work_unit_metadata_fraction(us*(area->>'denominator')::numeric,3600000000*(area->>'numerator')::numeric) else null end
$$;
create function public._work_unit_metadata_bucket(m jsonb,k text) returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare x jsonb;v jsonb;begin
 if m#>>'{classification,state}'='noncurrent' then return jsonb_build_object('state','noncurrent','versionId',null,'label',null);end if;
 x:=m#>array['classification','values',k];if m#>>'{classification,state}'='unknown' or x->>'state'='unknown' then return jsonb_build_object('state','unknown','versionId',null,'label',null);end if;
 v:=public._work_unit_metadata_version((x->>'versionId')::uuid,case k when 'frameMaterial' then 'material' else k end,null,false);
 if v is null then return null;end if;return jsonb_build_object('state','known','versionId',v->'id','label',v#>'{value,labelEn}');end$$;
create function public._work_unit_metadata_sum_bucket(groups jsonb,key text,bucket jsonb,unit_id uuid,us numeric,area jsonb) returns jsonb
language plpgsql immutable set search_path=public,pg_temp as $$
declare v jsonb;total numeric;ar jsonb;begin
 v:=groups->key;if v is null then v:=bucket||jsonb_build_object('eligibleUnitIds','[]'::jsonb,'laborMicros','0','area',jsonb_build_object('numerator','0','denominator','1'));end if;
 if v->'eligibleUnitIds'@>jsonb_build_array(unit_id) then return groups;end if;
 total:=(v->>'laborMicros')::numeric+us;ar:=public._work_unit_metadata_area_add(v->'area',area);
 v:=v||jsonb_build_object('eligibleUnitIds',(v->'eligibleUnitIds')||jsonb_build_array(unit_id),'laborMicros',trim_scale(total)::text,'area',ar,'hoursPerSquareFoot',public._work_unit_metadata_ratio(total,ar));
 return groups||jsonb_build_object(key,v);end$$;
create function public._work_unit_metadata_aggregate(p_rows jsonb) returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare row jsonb;u uuid;us numeric;area jsonb;raw jsonb:='{"numerator":"0","denominator":"1"}';eligible_area jsonb:=raw;labor numeric:=0;actual numeric:=0;eligible_ids jsonb:='[]';
 groups jsonb:='{}';facets jsonb:='{}';floors jsonb:='{}';floorproductivity jsonb:='{}';customgroups jsonb:='{}';b jsonb;k text;key text;x jsonb;v jsonb;sharearea jsonb;fr jsonb;gr record;level record;group_rows jsonb;all_group_rows jsonb;blocked_dimensions text[]:='{}';chosen jsonb;matches integer;residual text;
begin
 select coalesce(jsonb_agg(jsonb_build_object('id',v.id,'value',v.value) order by v.id),'[]') into group_rows
 from public._work_unit_metadata_versions v join public._work_unit_metadata_definitions d on d.id=v.definition_id
 where d.kind='group' and v.state='published' and not exists(select 1 from public._work_unit_metadata_versions n where n.definition_id=d.id and n.version>v.version);
 -- Current trees require exact currently published parents. Renaming/retiring
 -- a parent never silently adopts its children into another grouping version.
 all_group_rows:=group_rows;
 for gr in select value item from jsonb_array_elements(group_rows) loop
 if gr.item#>>'{value,dimension}' not in ('category','subtype','material') or gr.item#>>'{value,dimension}' is null then blocked_dimensions:=array['category','subtype','material'];continue;end if;
 if public._work_unit_metadata_version((gr.item->>'id')::uuid,'group',null) is null
 or (gr.item#>>'{value,parentVersionId}' is not null and not exists(select 1 from jsonb_array_elements(group_rows)p where p->>'id'=gr.item#>>'{value,parentVersionId}' and p#>>'{value,dimension}'=gr.item#>>'{value,dimension}' and p#>'{value,members}'@>(gr.item#>'{value,members}'))) then
 blocked_dimensions:=array_append(blocked_dimensions,gr.item#>>'{value,dimension}');end if;
 end loop;
 select coalesce(jsonb_agg(item),'[]') into group_rows from jsonb_array_elements(group_rows)item where not item#>>'{value,dimension}'=any(blocked_dimensions);
 for row in select value from jsonb_array_elements(p_rows) loop
 if row->>'selected'='true' then actual:=actual+(row#>>'{recorded,knownMicros}')::numeric;if row->'rawArea'<>'null' then raw:=public._work_unit_metadata_area_add(raw,row->'rawArea');end if;end if;
 if row->>'eligible'<>'true' then continue;end if;u:=(row->>'unitId')::uuid;us:=(row#>>'{recorded,knownMicros}')::numeric;area:=row->'rawArea';labor:=labor+us;eligible_area:=public._work_unit_metadata_area_add(eligible_area,area);eligible_ids:=eligible_ids||jsonb_build_array(u);
 foreach k in array array['category','subtype','frameMaterial'] loop
 b:=row#>array['classificationBuckets',k];key:=k||':'||coalesce(b->>'versionId',b->>'state');groups:=public._work_unit_metadata_sum_bucket(groups,key,b||jsonb_build_object('dimension',k,'additive',true),u,us,area);end loop;
 if row#>>'{metadata,classification,state}'='current' then
 for x in select value from jsonb_array_elements(row#>'{metadata,classification,values,components}') loop
 v:=public._work_unit_metadata_version((x->>'versionId')::uuid,'component',null,false);if v is null then return null;end if;
 facets:=public._work_unit_metadata_sum_bucket(facets,'component:'||(x->>'versionId'),jsonb_build_object('dimension','component','versionId',x->'versionId','label',v#>'{value,labelEn}','additive',false),u,us,area);end loop;
 end if;
 fr:=row#>'{metadata,floor}';
 if fr->>'current'='true' and fr->>'state' in ('single','multilevel') then
 for x in select value from jsonb_array_elements(fr->'shares') loop
 v:=public._work_unit_metadata_version((x->>'versionId')::uuid,'floor',(row->>'projectId')::uuid);if v is null then return null;end if;
 sharearea:=public._work_unit_metadata_fraction((area->>'numerator')::numeric*(x->>'numerator')::numeric,(area->>'denominator')::numeric*(x->>'denominator')::numeric);
 key:=x->>'versionId';b:=jsonb_build_object('state','allocated','versionId',x->'versionId','floorId',x->'floorId','label',v#>'{value,labelEn}');
 floors:=public._work_unit_metadata_sum_bucket(floors,key,b,u,0,sharearea);
 if fr->>'state'='single' then floorproductivity:=public._work_unit_metadata_sum_bucket(floorproductivity,key,b,u,us,area);end if;
 end loop;
 else
 key:=case when fr->>'state'='unknown' then 'unknown' when fr->>'state'='unallocated' then 'unallocated' else 'noncurrent' end;
 floors:=public._work_unit_metadata_sum_bucket(floors,key,jsonb_build_object('state',key,'versionId',null,'floorId',null,'label',null),u,0,area);
 end if;
 -- At each exact parent, children plus explicit residuals partition that
 -- parent's eligible unit set. These levels remain nonadditive across levels.
 for level in
 select distinct item#>>'{value,dimension}' dimension,null::text parent_id,null::jsonb members from jsonb_array_elements(group_rows)item
 union all
 select item#>>'{value,dimension}',item->>'id',item#>'{value,members}' from jsonb_array_elements(group_rows)item
 where exists(select 1 from jsonb_array_elements(group_rows)child where child#>>'{value,parentVersionId}'=item->>'id')
 loop
 k:=case level.dimension when 'material' then 'frameMaterial' else level.dimension end;b:=row#>array['classificationBuckets',k];
 if level.parent_id is not null and (b->>'state'<>'known' or not level.members@>jsonb_build_array(b->'versionId')) then continue;end if;
 select count(*),jsonb_agg(child)->0 into matches,chosen from jsonb_array_elements(group_rows)child
 where child#>>'{value,dimension}'=level.dimension and child#>>'{value,parentVersionId}' is not distinct from level.parent_id
 and b->>'state'='known' and child#>'{value,members}'@>jsonb_build_array(b->'versionId');
 if matches>1 then blocked_dimensions:=array_append(blocked_dimensions,level.dimension);continue;end if;
 if matches=1 then
 key:=chosen->>'id';v:=jsonb_build_object('versionId',chosen->'id','dimension',k,'label',chosen#>'{value,labelEn}','parentVersionId',level.parent_id,'state','known','additive',false,'exclusiveWithinExactParentVersion',true);
 else
 residual:=case b->>'state' when 'unknown' then 'unknown' when 'noncurrent' then 'noncurrent' else 'unassigned' end;
 key:='residual:'||level.dimension||':'||coalesce(level.parent_id,'root')||':'||residual;
 v:=jsonb_build_object('versionId',null,'dimension',k,'label',null,'parentVersionId',level.parent_id,'state',residual,'additive',false,'exclusiveWithinExactParentVersion',true);
 end if;
 customgroups:=public._work_unit_metadata_sum_bucket(customgroups,key,v,u,us,area);
 end loop;
 end loop;
 return jsonb_build_object('actualKnownMicros',trim_scale(actual)::text,'eligibleUnitIds',eligible_ids,'laborMicros',trim_scale(labor)::text,'area',eligible_area,'hoursPerSquareFoot',public._work_unit_metadata_ratio(labor,eligible_area),'rawKnownArea',raw,
 'groups',(select coalesce(jsonb_agg(entry.value order by entry.key),'[]') from jsonb_each(groups)entry),
 'componentFacets',(select coalesce(jsonb_agg(entry.value order by entry.key),'[]') from jsonb_each(facets)entry),
 'customGroups',jsonb_build_object('availability',case when cardinality(blocked_dimensions)=0 then 'available' when not exists(select 1 from jsonb_array_elements(all_group_rows)item where not item#>>'{value,dimension}'=any(blocked_dimensions)) then 'unavailable' else 'partial' end,
 'trees',(select coalesce(jsonb_agg(jsonb_build_object('dimension',case dimensions.dimension when 'material' then 'frameMaterial' else dimensions.dimension end,
 'availability',case when dimensions.dimension=any(blocked_dimensions) then 'unavailable' else 'available' end,
 'groups',case when dimensions.dimension=any(blocked_dimensions) then null else (select coalesce(jsonb_agg(entry.value order by entry.key),'[]') from jsonb_each(customgroups)entry where entry.value->>'dimension'=case dimensions.dimension when 'material' then 'frameMaterial' else dimensions.dimension end) end) order by dimensions.dimension),'[]')
 from (select distinct item#>>'{value,dimension}' dimension from jsonb_array_elements(all_group_rows)item where item#>>'{value,dimension}' in ('category','subtype','material') union select unnest(blocked_dimensions))dimensions)),
 'floors',(select coalesce(jsonb_agg((entry.value-array['laborMicros','hoursPerSquareFoot'])||jsonb_build_object('areaOnly',true,'singleFloorProductivity',floorproductivity->entry.key) order by entry.key),'[]') from jsonb_each(floors)entry));
end$$;
create function public.work_unit_cohorts_read(p_project_id uuid,p_protocol_version integer default 1,p_filter jsonb default '{}') returns jsonb
language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare actor uuid;stamp timestamptz;units uuid[];uid uuid;sid uuid;members jsonb;scopes jsonb:='{}';reviews jsonb:='{}';metadatas jsonb:='{}';partitions jsonb:='{}';ledgers jsonb:='{}';s jsonb;r jsonb;m jsonb;l jsonb;part jsonb;general jsonb;summary jsonb;rows jsonb:='[]';
 ids uuid[];allids uuid[]:='{}';ar jsonb;buckets jsonb;bucket jsonb;k text;x jsonb;selected boolean;eligible boolean;complete boolean:=true;result jsonb;bytes bigint:=0;history_count bigint:=0;transition_count bigint:=0;
 unavailable constant jsonb:='{"protocolVersion":1,"availability":"unavailable","cohort":null}';
begin
 -- METADATA_BOUNDARY_actor_BEGIN
 perform public._work_activity_read_committed();perform public._work_activity_gate();actor:=public._work_activity_actor();perform pg_advisory_xact_lock(7710,0);actor:=public._work_activity_actor();
 if not coalesce((select encode(sha256(convert_to(pin.value::text,'UTF8')),'hex')='63eb01e50016563968e2056c8997bc2a7b87d7221b20b5d253d7a1e751bc16b8' from (select jsonb_build_object('body',p.prosrc,'owner',pg_get_userbyid(p.proowner),'acl',p.proacl::text,'definer',p.prosecdef,'config',p.proconfig,'volatility',p.provolatile,'strict',p.proisstrict,'leakproof',p.proleakproof,'parallel',p.proparallel,'kind',p.prokind,'set',p.proretset,'result',pg_get_function_result(p.oid),'args',pg_get_function_identity_arguments(p.oid),'defaults',pg_get_expr(p.proargdefaults,0),'cost',p.procost,'rows',p.prorows,'support',p.prosupport::regprocedure::text,'language',(select lanname from pg_language where oid=p.prolang)) value from pg_proc p where p.oid=to_regprocedure('public._work_unit_metadata_coverage()'))pin),false) then actor:=null;
 elsif not public._work_unit_metadata_coverage() or not public._work_unit_review_coverage() or not public._work_totals_coverage() or not public._work_unit_contributors_coverage() then actor:=null;end if;
 -- METADATA_BOUNDARY_actor_END
 if actor is null then return unavailable;end if;
 if p_project_id is null or p_protocol_version is distinct from 1 or not public._work_unit_metadata_object(p_filter,'{}',array['categoryVersionIds','subtypeVersionIds','materialVersionIds']) or octet_length(p_filter::text)>16384 then raise exception using errcode='23514',message='Invalid cohort request.';end if;
 for k,x in select key,value from jsonb_each(p_filter) loop
 if jsonb_typeof(x)<>'array' or jsonb_array_length(x)>100 then raise exception using errcode='23514',message='Invalid cohort filter.';end if;for bucket in select value from jsonb_array_elements(x) loop perform public._work_unit_metadata_uuid(bucket);end loop;end loop;
 

 if not public._work_config_is_supervisor(actor) then raise exception using errcode='42501',message='A current supervisor or owner is required.';end if;
 stamp:=clock_timestamp();if not public._ai_job_visible(p_project_id,actor) then return unavailable;end if;
 if (select count(*) from public._work_unit_metadata_versions v join public._work_unit_metadata_definitions d on d.id=v.definition_id where d.project_id is null or d.project_id=p_project_id)>500 then return unavailable;end if;
 for k,x in select key,value from jsonb_each(p_filter) loop
 for bucket in select value from jsonb_array_elements(x) loop
 if public._work_unit_metadata_version((bucket#>>'{}')::uuid,case k when 'categoryVersionIds' then 'category' when 'subtypeVersionIds' then 'subtype' else 'material' end,null,false) is null then return unavailable;end if;end loop;end loop;
 select array_agg(id order by id) into units from public.custom_work_units where project_id=p_project_id;
 if coalesce(cardinality(units),0)>100 then return unavailable;end if;
 members:=public._work_unit_metadata_members(coalesce(units,'{}'));if members is null then return unavailable;end if;bytes:=octet_length(members::text);
 foreach uid in array coalesce(units,'{}') loop
 s:=public._work_unit_metadata_scope(actor,uid,members->uid::text);r:=public._work_unit_metadata_review(actor,s);m:=public._work_unit_metadata_state(actor,s,r);
 if s is null or r is null or m is null then return unavailable;end if;
 history_count:=history_count+jsonb_array_length(s#>'{manifest,history}');transition_count:=transition_count+jsonb_array_length(s#>'{manifest,transitions}');
 bytes:=bytes+octet_length(s::text)+octet_length(r::text)+octet_length(m::text);
 if bytes>20000000 or history_count>100000 or transition_count>50000 then return unavailable;end if;
 scopes:=scopes||jsonb_build_object(uid::text,s);reviews:=reviews||jsonb_build_object(uid::text,r);metadatas:=metadatas||jsonb_build_object(uid::text,m);
 ids:=public._work_unit_metadata_shift_ids(p_project_id,uid,s);if coalesce(cardinality(ids),0)>500 then return unavailable;end if;
 partitions:=partitions||jsonb_build_object(uid::text,to_jsonb(coalesce(ids,'{}')));allids:=allids||coalesce(ids,'{}');end loop;
 ids:=public._work_unit_metadata_shift_ids(p_project_id,null,null);if coalesce(cardinality(ids),0)>500 then return unavailable;end if;
 partitions:=partitions||jsonb_build_object('general',to_jsonb(coalesce(ids,'{}')));allids:=allids||coalesce(ids,'{}');
 select coalesce(array_agg(distinct i order by i),'{}') into allids from unnest(allids)i;
 if cardinality(allids)>2000 then return unavailable;end if;
 foreach sid in array allids loop
 -- Exactly one actual frozen ledger invocation per distinct union identity.
 l:=public._work_totals_shift(actor,sid,stamp);if l->>'availability' is distinct from 'available' then return unavailable;end if;
 bytes:=bytes+octet_length(l::text);if bytes>20000000 then return unavailable;end if;ledgers:=ledgers||jsonb_build_object(sid::text,l);end loop;
 select coalesce(array_agg(item.value::uuid),'{}') into ids from jsonb_array_elements_text(partitions->'general')item(value);
 general:=public._work_unit_metadata_partition(actor,p_project_id,null,stamp,null,null,ids,ledgers);if general->>'availability' is distinct from 'available' then return unavailable;end if;complete:=(general#>>'{totals,complete}')::boolean;
 foreach uid in array coalesce(units,'{}') loop
 s:=scopes->uid::text;r:=reviews->uid::text;m:=metadatas->uid::text;
 select coalesce(array_agg(item.value::uuid),'{}') into ids from jsonb_array_elements_text(partitions->uid::text)item(value);
 part:=public._work_unit_metadata_partition(actor,p_project_id,uid,stamp,s,r,ids,ledgers);if part->>'availability' is distinct from 'available' then return unavailable;end if;
 complete:=complete and (part#>>'{totals,complete}')::boolean;selected:=true;buckets:='{}';
 foreach k in array array['category','subtype','frameMaterial'] loop
 bucket:=public._work_unit_metadata_bucket(m,k);if bucket is null then return unavailable;end if;buckets:=buckets||jsonb_build_object(k,bucket);
 x:=p_filter->case k when 'category' then 'categoryVersionIds' when 'subtype' then 'subtypeVersionIds' else 'materialVersionIds' end;
 if x is not null and (bucket->>'state'<>'known' or not x@>jsonb_build_array(bucket->'versionId')) then selected:=false;end if;end loop;
 ar:=public._work_unit_metadata_area(s);eligible:=selected and coalesce((part#>>'{totals,cohort,eligible}')::boolean,false);
 rows:=rows||jsonb_build_array(jsonb_build_object('unitId',uid,'projectId',p_project_id,'incarnation',s#>>'{unit,incarnationEpoch}','selected',selected,'eligible',eligible,
 'physicalEligible',coalesce((part#>>'{totals,cohort,eligible}')::boolean,false),'exclusions',coalesce(part#>'{totals,cohort,exclusions}','[]'),
 'proof',jsonb_build_object('factId',s#>'{unit,fact,id}','factRevision',s#>'{unit,fact,revision}','scopeToken',s->'scopeToken','reviewBasis',r->'basis'),
 'rawArea',ar,'dimensionVerification',r->'dimensionVerification','qc',r->'qc','metadata',m-array['metadataBasis','floorBasis'],'classificationBuckets',buckets,
 'recorded',jsonb_build_object('knownMicros',part#>'{totals,scopeKnownMicros}','complete',part#>'{totals,complete}','personalKnownMicros',part#>'{totals,personalKnownMicros}','personalComplete',part#>'{totals,personalComplete}','activities',part#>'{totals,activities}','reconciliation',part#>'{totals,reconciliation}')));
 end loop;
 summary:=public._work_unit_metadata_aggregate(rows);if summary is null then return unavailable;end if;
 result:=jsonb_build_object('protocolVersion',1,'availability','available','cohort',jsonb_build_object('asOf',public._work_activity_iso(stamp),'projectId',p_project_id,'window','all_retained_unit_labor_current_inventory','filter',p_filter,'complete',complete,'units',rows,'summary',summary,'general',general->'totals','generalOverheadIncluded',false,'sourceVersion','701-only'));
 if octet_length(result::text)>2000000 then return unavailable;end if;return result;
end$$;

-- METADATA_IMPLEMENTATION_CONTINUE
-- A supplemental service census preserves the exact frozen predecessor census.
-- Its G lock makes this count coherent with metadata writers; the later Auth
-- delete is a different transaction, protected independently by actor RESTRICT.
create function public._work_unit_metadata_person_counts(p_id uuid,p_actor_id uuid default null) returns jsonb
language plpgsql volatile security definer set search_path=public,pg_temp as $$
begin
 -- METADATA_BOUNDARY_service_BEGIN
 perform public._work_activity_read_committed();perform public._work_activity_gate();perform pg_advisory_xact_lock(7710,0);
 if not coalesce((select encode(sha256(convert_to(pin.value::text,'UTF8')),'hex')='63eb01e50016563968e2056c8997bc2a7b87d7221b20b5d253d7a1e751bc16b8' from (select jsonb_build_object('body',p.prosrc,'owner',pg_get_userbyid(p.proowner),'acl',p.proacl::text,'definer',p.prosecdef,'config',p.proconfig,'volatility',p.provolatile,'strict',p.proisstrict,'leakproof',p.proleakproof,'parallel',p.proparallel,'kind',p.prokind,'set',p.proretset,'result',pg_get_function_result(p.oid),'args',pg_get_function_identity_arguments(p.oid),'defaults',pg_get_expr(p.proargdefaults,0),'cost',p.procost,'rows',p.prorows,'support',p.prosupport::regprocedure::text,'language',(select lanname from pg_language where oid=p.prolang)) value from pg_proc p where p.oid=to_regprocedure('public._work_unit_metadata_coverage()'))pin),false) then raise exception using errcode='55000',message='Person history source is unavailable.';
 elsif not public._work_unit_metadata_coverage() or not public._work_unit_review_coverage() or not public._work_totals_coverage() or not public._work_unit_contributors_coverage() then raise exception using errcode='55000',message='Person history source is unavailable.';end if;
 -- METADATA_BOUNDARY_service_END
 if p_actor_id is not null and not exists(select 1 from public.profiles where id=p_actor_id and role in ('owner','big_boss') and access_revoked_at is null and retired_at is null and not coalesce(is_partner,false)) then raise exception using errcode='42501',message='A current owner is required.';end if;
 if p_id is null then raise exception using errcode='23514',message='A person identity is required.';end if;
 if not exists(select 1 from public.profiles where id=p_id) then raise exception using errcode='P0002',message='Person is unavailable.';end if;
 return public.person_record_counts(p_id)||jsonb_build_object(
 '_work_unit_metadata_definitions.actor_id',(select count(*) from public._work_unit_metadata_definitions where actor_id=p_id),
 '_work_unit_metadata_versions.actor_id',(select count(*) from public._work_unit_metadata_versions where actor_id=p_id),
 '_work_unit_metadata_proposals.actor_id',(select count(*) from public._work_unit_metadata_proposals where actor_id=p_id),
 '_work_unit_metadata_revisions.actor_id',(select count(*) from public._work_unit_metadata_revisions where actor_id=p_id),
 '_work_unit_metadata_floors.actor_id',(select count(*) from public._work_unit_metadata_floors where actor_id=p_id),
 '_work_unit_metadata_commands.actor_id',(select count(*) from public._work_unit_metadata_commands where actor_id=p_id));
end$$;

-- METADATA_FUNCTION_ACLS_BEGIN
revoke all on function public._work_unit_metadata_aggregate(p_rows jsonb) from public,anon,authenticated,service_role;
revoke all on function public._work_unit_metadata_area(s jsonb) from public,anon,authenticated,service_role;
revoke all on function public._work_unit_metadata_area_add(a jsonb, b jsonb) from public,anon,authenticated,service_role;
revoke all on function public._work_unit_metadata_basis(v jsonb, p_floor boolean) from public,anon,authenticated,service_role;
revoke all on function public._work_unit_metadata_binding(p_unit uuid) from public,anon,authenticated,service_role;
revoke all on function public._work_unit_metadata_bucket(m jsonb, k text) from public,anon,authenticated,service_role;
revoke all on function public._work_unit_metadata_coverage() from public,anon,authenticated,service_role;
revoke all on function public._work_unit_metadata_decimal(v jsonb, positive boolean) from public,anon,authenticated,service_role;
revoke all on function public._work_unit_metadata_floor_basis(s jsonb, r jsonb) from public,anon,authenticated,service_role;
revoke all on function public._work_unit_metadata_fraction(n numeric, d numeric) from public,anon,authenticated,service_role;
revoke all on function public._work_unit_metadata_gate() from public,anon,authenticated,service_role;
revoke all on function public._work_unit_metadata_immutable() from public,anon,authenticated,service_role;
revoke all on function public._work_unit_metadata_jobs_visible(actor uuid, jobs jsonb) from public,anon,authenticated,service_role;
revoke all on function public._work_unit_metadata_live(p_sourceids jsonb) from public,anon,authenticated,service_role;
revoke all on function public._work_unit_metadata_members(p_units uuid[]) from public,anon,authenticated,service_role;
revoke all on function public._work_unit_metadata_number(v jsonb) from public,anon,authenticated,service_role;
revoke all on function public._work_unit_metadata_object(v jsonb, required text[], optional text[]) from public,anon,authenticated,service_role;
revoke all on function public._work_unit_metadata_origins(actor uuid, p_unit uuid) from public,anon,authenticated,service_role;
revoke all on function public._work_unit_metadata_partition(actor uuid, p_project_id uuid, p_unit_id uuid, stamp timestamp with time zone, unit_scope jsonb, review jsonb, ids uuid[], p_ledgers jsonb) from public,anon,authenticated,service_role;
revoke all on function public._work_unit_metadata_person_counts(p_id uuid, p_actor_id uuid) from public,anon,authenticated,service_role;
grant execute on function public._work_unit_metadata_person_counts(p_id uuid, p_actor_id uuid) to service_role;
revoke all on function public._work_unit_metadata_ratio(us numeric, area jsonb) from public,anon,authenticated,service_role;
revoke all on function public._work_unit_metadata_review(actor uuid, s jsonb) from public,anon,authenticated,service_role;
revoke all on function public._work_unit_metadata_scope(actor uuid, unit_id uuid, p_sourceids jsonb) from public,anon,authenticated,service_role;
revoke all on function public._work_unit_metadata_shift_ids(p_project_id uuid, p_unit_id uuid, unit_scope jsonb) from public,anon,authenticated,service_role;
revoke all on function public._work_unit_metadata_state(actor uuid, s jsonb, r jsonb) from public,anon,authenticated,service_role;
revoke all on function public._work_unit_metadata_sum_bucket(groups jsonb, key text, bucket jsonb, unit_id uuid, us numeric, area jsonb) from public,anon,authenticated,service_role;
revoke all on function public._work_unit_metadata_uuid(v jsonb) from public,anon,authenticated,service_role;
revoke all on function public._work_unit_metadata_validate_definition(v jsonb, p_project uuid) from public,anon,authenticated,service_role;
revoke all on function public._work_unit_metadata_validate_values(v jsonb, p_active boolean) from public,anon,authenticated,service_role;
revoke all on function public._work_unit_metadata_version(p_id uuid, p_kind text, p_project uuid, p_active boolean) from public,anon,authenticated,service_role;
revoke all on function public.work_unit_cohorts_read(p_project_id uuid, p_protocol_version integer, p_filter jsonb) from public,anon,service_role;
grant execute on function public.work_unit_cohorts_read(p_project_id uuid, p_protocol_version integer, p_filter jsonb) to authenticated;
revoke all on function public.work_unit_metadata_command(p_command_id uuid, p_protocol_version integer, p_request jsonb) from public,anon,service_role;
grant execute on function public.work_unit_metadata_command(p_command_id uuid, p_protocol_version integer, p_request jsonb) to authenticated;
revoke all on function public.work_unit_metadata_read(p_unit_id uuid, p_protocol_version integer) from public,anon,service_role;
grant execute on function public.work_unit_metadata_read(p_unit_id uuid, p_protocol_version integer) to authenticated;
revoke all on function public.work_unit_metadata_receipt(p_command_id uuid, p_protocol_version integer) from public,anon,service_role;
grant execute on function public.work_unit_metadata_receipt(p_command_id uuid, p_protocol_version integer) to authenticated;
-- METADATA_FUNCTION_ACLS_END
-- METADATA_COVERAGE_BEGIN
create or replace function public._work_unit_metadata_coverage() returns boolean
language sql stable security definer set search_path=public,pg_temp as $coverage$
 select coalesce((select encode(sha256(convert_to(c.value::text,'UTF8')),'hex')=p.expected_catalog_sha256 from public._work_unit_metadata_contract p cross join (select jsonb_build_object('metadataActorRetentionTriggers',(select coalesce(jsonb_agg(jsonb_build_object('table',c.relname,'constraintTable',d.relname,'constraint',k.conname,'function',t.tgfoid::regprocedure::text,'type',t.tgtype,'enabled',t.tgenabled,'internal',t.tgisinternal,'deferrable',t.tgdeferrable,'initiallyDeferred',t.tginitdeferred,'attributes',t.tgattr::text,'arguments',encode(t.tgargs,'hex'),'qual',pg_get_expr(t.tgqual,t.tgrelid)) order by d.relname,c.relname,t.tgfoid::regprocedure::text),'[]') from pg_trigger t join pg_constraint k on k.oid=t.tgconstraint join pg_class c on c.oid=t.tgrelid join pg_class d on d.oid=k.conrelid join pg_namespace n on n.oid=d.relnamespace where n.nspname='public' and starts_with(d.relname,'_work_unit_metadata_') and k.conname='metadata_actor_retention'),'metadataIndexes',(select coalesce(jsonb_agg(jsonb_build_object('name',c.relname,'definition',pg_get_indexdef(c.oid),'unique',i.indisunique,'valid',i.indisvalid,'ready',i.indisready) order by c.relname),'[]') from pg_index i join pg_class c on c.oid=i.indexrelid join pg_class t on t.oid=i.indrelid join pg_namespace n on n.oid=t.relnamespace where n.nspname='public' and starts_with(t.relname,'_work_unit_metadata_')),'metadataNamespaceTypes',(select coalesce(jsonb_agg(jsonb_build_object('name',t.typname,'kind',t.typtype,'relation',c.relname) order by t.typname),'[]') from pg_type t join pg_namespace n on n.oid=t.typnamespace left join pg_class c on c.oid=t.typrelid where n.nspname='public' and (starts_with(t.typname,'_work_unit_metadata_') or starts_with(t.typname,'work_unit_metadata_'))),'namespaceRelations',(select coalesce(jsonb_agg(jsonb_build_object('name',c.relname,'kind',c.relkind) order by c.relname),'[]') from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and (starts_with(c.relname,'_work_unit_contributors_') or starts_with(c.relname,'_work_unit_metadata_') or starts_with(c.relname,'work_unit_metadata_'))),'namespace',(select coalesce(jsonb_agg(jsonb_build_object('name',p.proname,'args',pg_get_function_identity_arguments(p.oid)) order by p.proname,pg_get_function_identity_arguments(p.oid)),'[]') from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and (p.proname='work_unit_contributors_read' or (starts_with(p.proname,'_work_unit_contributors_') or starts_with(p.proname,'_work_unit_metadata_') or starts_with(p.proname,'work_unit_metadata_') or p.proname=any(array['work_unit_metadata_read','work_unit_metadata_command','work_unit_metadata_receipt','work_unit_cohorts_read'])))),
 'functions',(select jsonb_agg(jsonb_build_object('name',p.proname,'args',pg_get_function_identity_arguments(p.oid),'language',(select lanname from pg_language where oid=p.prolang),'kind',p.prokind,'result',pg_get_function_result(p.oid),'defaults',pg_get_expr(p.proargdefaults,0),'strict',p.proisstrict,'parallel',p.proparallel,'leakproof',p.proleakproof,'cost',p.procost,'rows',p.prorows,'support',p.prosupport::regprocedure::text,'setReturning',p.proretset,'rawAcl',p.proacl::text,'body',encode(sha256(convert_to(p.prosrc,'UTF8')),'hex'),'config',p.proconfig,'owner',pg_get_userbyid(p.proowner),'definer',p.prosecdef,'volatility',p.provolatile) order by p.proname,pg_get_function_identity_arguments(p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=any(array['_ai_job_visible','_is_lead','_is_supervisor','_work_activity_actor','_work_activity_answers','_work_activity_authority_changed','_work_activity_authority_guard','_work_activity_authority_revision','_work_activity_bookkeeping_guard','_work_activity_claim_clock_setup','_work_activity_clock_replay_guard','_work_activity_clock_review','_work_activity_clock_setup_digest','_work_activity_close_all','_work_activity_close_source','_work_activity_command_basis','_work_activity_consume','_work_activity_context_assert','_work_activity_context_close','_work_activity_context_commit_guard','_work_activity_context_for','_work_activity_context_guard','_work_activity_context_open','_work_activity_ensure_state','_work_activity_ephemeral_commit_guard','_work_activity_establish_payload','_work_activity_establish_stream','_work_activity_event','_work_activity_evidence','_work_activity_expect','_work_activity_expected_guard','_work_activity_fact_snapshot','_work_activity_finish','_work_activity_gate','_work_activity_insert_source','_work_activity_instant','_work_activity_integer','_work_activity_iso','_work_activity_keep_clock_receipt','_work_activity_live_sources','_work_activity_no_truncate','_work_activity_object','_work_activity_observe','_work_activity_operation','_work_activity_operation_enter','_work_activity_operation_exit','_work_activity_parent_gate','_work_activity_parent_source_history','_work_activity_payload','_work_activity_profile_delete_guard','_work_activity_project_view','_work_activity_read_committed','_work_activity_refresh_state','_work_activity_resume','_work_activity_retain_source','_work_activity_review_visit','_work_activity_row_allowance','_work_activity_row_before','_work_activity_row_event','_work_activity_safety_exit','_work_activity_safety_guard','_work_activity_setup_guard','_work_activity_setup_ledger_guard','_work_activity_shift_lifecycle','_work_activity_source_material','_work_activity_source_view','_work_activity_start_setup','_work_activity_statement_begin','_work_activity_statement_end','_work_activity_stream_guard','_work_activity_touch','_work_activity_transition_source_guard','_work_activity_unit_basis','_work_activity_uuid','_work_activity_validate_switch','_work_config_can_manage_menu','_work_config_internal','_work_config_is_foreman','_work_config_is_owner','_work_config_is_supervisor','_work_config_replay','_work_config_store_receipt','_work_config_validate_menu_draft_items','_work_config_validate_typed_fields','_work_totals_capture','_work_totals_coverage','_work_totals_shift','_work_totals_source','_work_totals_visible','_work_unit_contributors_coverage','_work_unit_contributors_person','_work_unit_contributors_shift','_work_unit_fact_bump_epoch','_work_unit_fact_context_visible','_work_unit_fact_peek_epoch','_work_unit_metadata_aggregate','_work_unit_metadata_area','_work_unit_metadata_area_add','_work_unit_metadata_basis','_work_unit_metadata_binding','_work_unit_metadata_bucket','_work_unit_metadata_coverage','_work_unit_metadata_decimal','_work_unit_metadata_floor_basis','_work_unit_metadata_fraction','_work_unit_metadata_gate','_work_unit_metadata_immutable','_work_unit_metadata_jobs_visible','_work_unit_metadata_live','_work_unit_metadata_members','_work_unit_metadata_number','_work_unit_metadata_object','_work_unit_metadata_origins','_work_unit_metadata_partition','_work_unit_metadata_person_counts','_work_unit_metadata_ratio','_work_unit_metadata_review','_work_unit_metadata_scope','_work_unit_metadata_shift_ids','_work_unit_metadata_state','_work_unit_metadata_sum_bucket','_work_unit_metadata_uuid','_work_unit_metadata_validate_definition','_work_unit_metadata_validate_values','_work_unit_metadata_version','_work_unit_review_authority','_work_unit_review_coverage','_work_unit_review_defect_projection','_work_unit_review_scope','_work_unit_review_view','attach_sandbox_guards','clock_in','clock_out','custom_work_internal','end_break','guard_test_account_sandbox_only','is_partner_user','is_sandbox_project','is_test_profile','person_record_counts','row_project_id','sandbox_scoped_tables','service_job_access','shift_cap_hours','start_break','work_activity_command','work_activity_snapshot','work_activity_totals_read','work_capture_immutable_record','work_publish_activity_version','work_publish_menu_version','work_select_job_menu','work_unit_cohorts_read','work_unit_contributors_read','work_unit_metadata_command','work_unit_metadata_read','work_unit_metadata_receipt'])),
 'triggers',(select jsonb_agg(jsonb_build_object('table',c.relname,'name',t.tgname,'definition',pg_get_triggerdef(t.oid,true),'enabled',t.tgenabled) order by c.relname,t.tgname) from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname=any(array['time_shifts','personal_activity_state','personal_activity_transition_sources','personal_activity_transitions','work_activity_safety_events','work_unit_fact_revisions','work_unit_fact_current','work_unit_fact_context_epochs','custom_work_units','project_openings','service_visit_units','service_visits','summons','unit_redos','qc_checks','install_events','crew_work_records','crew_work_record_people','work_session_capture_metadata','custom_work_history','custom_work_sessions','unit_sessions','task_sessions','service_time_sessions','opening_phases','summon_helpers','work_activity_source_history','work_unit_review_commands','work_unit_dimension_verifications','work_unit_review_events','work_unit_review_current','work_unit_review_defects','work_unit_review_defect_events','work_setup_sessions','personal_activity_commands','work_activity_definitions','work_activity_definition_versions','work_capture_menus','work_capture_menu_versions','work_capture_menu_items','work_job_menu_selections','profiles','projects','sandbox_projects','work_job_management_grants','_work_unit_metadata_definitions','_work_unit_metadata_versions','_work_unit_metadata_proposals','_work_unit_metadata_revisions','_work_unit_metadata_current','_work_unit_metadata_floors','_work_unit_metadata_floor_current','_work_unit_metadata_commands','_work_unit_metadata_contract']) and not t.tgisinternal),
 'columns',(select jsonb_agg(jsonb_build_object('table',c.relname,'column',a.attname,'type',format_type(a.atttypid,a.atttypmod),'nullable',not a.attnotnull,'default',(select pg_get_expr(d.adbin,d.adrelid) from pg_attrdef d where d.adrelid=a.attrelid and d.adnum=a.attnum),'collation',a.attcollation::regcollation::text,'rawAcl',a.attacl::text,'notNullValidated',coalesce(nn.validated,true),'notNullEnforced',coalesce(nn.enforced,true),'notNullNoInherit',coalesce(nn.no_inherit,false),'generated',a.attgenerated,'identity',a.attidentity) order by c.relname,a.attnum) from pg_class c join pg_namespace n on n.oid=c.relnamespace join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped left join lateral (select bool_and(k.convalidated) validated,bool_and(coalesce((to_jsonb(k)->>'conenforced')::boolean,true)) enforced,bool_or(k.connoinherit) no_inherit from pg_constraint k where k.conrelid=a.attrelid and k.contype='n' and a.attnum=any(k.conkey)) nn on true where n.nspname='public' and c.relname=any(array['time_shifts','personal_activity_state','personal_activity_transition_sources','personal_activity_transitions','work_activity_safety_events','work_unit_fact_revisions','work_unit_fact_current','work_unit_fact_context_epochs','custom_work_units','project_openings','service_visit_units','service_visits','summons','unit_redos','qc_checks','install_events','crew_work_records','crew_work_record_people','work_session_capture_metadata','custom_work_history','custom_work_sessions','unit_sessions','task_sessions','service_time_sessions','opening_phases','summon_helpers','work_activity_source_history','work_unit_review_commands','work_unit_dimension_verifications','work_unit_review_events','work_unit_review_current','work_unit_review_defects','work_unit_review_defect_events','work_setup_sessions','personal_activity_commands','work_activity_definitions','work_activity_definition_versions','work_capture_menus','work_capture_menu_versions','work_capture_menu_items','work_job_menu_selections','profiles','projects','sandbox_projects','work_job_management_grants','_work_unit_metadata_definitions','_work_unit_metadata_versions','_work_unit_metadata_proposals','_work_unit_metadata_revisions','_work_unit_metadata_current','_work_unit_metadata_floors','_work_unit_metadata_floor_current','_work_unit_metadata_commands','_work_unit_metadata_contract'])),
 'functionAccess',(select jsonb_agg(jsonb_build_object('name',p.proname,'args',pg_get_function_identity_arguments(p.oid),'role',r.rolname,'execute',has_function_privilege(r.oid,p.oid,'EXECUTE')) order by p.proname,pg_get_function_identity_arguments(p.oid),r.rolname) from pg_proc p join pg_namespace n on n.oid=p.pronamespace cross join pg_roles r where n.nspname='public' and p.proname=any(array['_ai_job_visible','_is_lead','_is_supervisor','_work_activity_actor','_work_activity_answers','_work_activity_authority_changed','_work_activity_authority_guard','_work_activity_authority_revision','_work_activity_bookkeeping_guard','_work_activity_claim_clock_setup','_work_activity_clock_replay_guard','_work_activity_clock_review','_work_activity_clock_setup_digest','_work_activity_close_all','_work_activity_close_source','_work_activity_command_basis','_work_activity_consume','_work_activity_context_assert','_work_activity_context_close','_work_activity_context_commit_guard','_work_activity_context_for','_work_activity_context_guard','_work_activity_context_open','_work_activity_ensure_state','_work_activity_ephemeral_commit_guard','_work_activity_establish_payload','_work_activity_establish_stream','_work_activity_event','_work_activity_evidence','_work_activity_expect','_work_activity_expected_guard','_work_activity_fact_snapshot','_work_activity_finish','_work_activity_gate','_work_activity_insert_source','_work_activity_instant','_work_activity_integer','_work_activity_iso','_work_activity_keep_clock_receipt','_work_activity_live_sources','_work_activity_no_truncate','_work_activity_object','_work_activity_observe','_work_activity_operation','_work_activity_operation_enter','_work_activity_operation_exit','_work_activity_parent_gate','_work_activity_parent_source_history','_work_activity_payload','_work_activity_profile_delete_guard','_work_activity_project_view','_work_activity_read_committed','_work_activity_refresh_state','_work_activity_resume','_work_activity_retain_source','_work_activity_review_visit','_work_activity_row_allowance','_work_activity_row_before','_work_activity_row_event','_work_activity_safety_exit','_work_activity_safety_guard','_work_activity_setup_guard','_work_activity_setup_ledger_guard','_work_activity_shift_lifecycle','_work_activity_source_material','_work_activity_source_view','_work_activity_start_setup','_work_activity_statement_begin','_work_activity_statement_end','_work_activity_stream_guard','_work_activity_touch','_work_activity_transition_source_guard','_work_activity_unit_basis','_work_activity_uuid','_work_activity_validate_switch','_work_config_can_manage_menu','_work_config_internal','_work_config_is_foreman','_work_config_is_owner','_work_config_is_supervisor','_work_config_replay','_work_config_store_receipt','_work_config_validate_menu_draft_items','_work_config_validate_typed_fields','_work_totals_capture','_work_totals_coverage','_work_totals_shift','_work_totals_source','_work_totals_visible','_work_unit_contributors_coverage','_work_unit_contributors_person','_work_unit_contributors_shift','_work_unit_fact_bump_epoch','_work_unit_fact_context_visible','_work_unit_fact_peek_epoch','_work_unit_metadata_aggregate','_work_unit_metadata_area','_work_unit_metadata_area_add','_work_unit_metadata_basis','_work_unit_metadata_binding','_work_unit_metadata_bucket','_work_unit_metadata_coverage','_work_unit_metadata_decimal','_work_unit_metadata_floor_basis','_work_unit_metadata_fraction','_work_unit_metadata_gate','_work_unit_metadata_immutable','_work_unit_metadata_jobs_visible','_work_unit_metadata_live','_work_unit_metadata_members','_work_unit_metadata_number','_work_unit_metadata_object','_work_unit_metadata_origins','_work_unit_metadata_partition','_work_unit_metadata_person_counts','_work_unit_metadata_ratio','_work_unit_metadata_review','_work_unit_metadata_scope','_work_unit_metadata_shift_ids','_work_unit_metadata_state','_work_unit_metadata_sum_bucket','_work_unit_metadata_uuid','_work_unit_metadata_validate_definition','_work_unit_metadata_validate_values','_work_unit_metadata_version','_work_unit_review_authority','_work_unit_review_coverage','_work_unit_review_defect_projection','_work_unit_review_scope','_work_unit_review_view','attach_sandbox_guards','clock_in','clock_out','custom_work_internal','end_break','guard_test_account_sandbox_only','is_partner_user','is_sandbox_project','is_test_profile','person_record_counts','row_project_id','sandbox_scoped_tables','service_job_access','shift_cap_hours','start_break','work_activity_command','work_activity_snapshot','work_activity_totals_read','work_capture_immutable_record','work_publish_activity_version','work_publish_menu_version','work_select_job_menu','work_unit_cohorts_read','work_unit_contributors_read','work_unit_metadata_command','work_unit_metadata_read','work_unit_metadata_receipt','_work_unit_contributors_coverage','_work_unit_metadata_coverage']) and r.rolname in('anon','authenticated','service_role')),
 'privateAccess',(select jsonb_agg(jsonb_build_object('table',c.relname,'role',r.rolname,'privilege',v.name,'allowed',has_table_privilege(r.oid,c.oid,v.name)) order by c.relname,r.rolname,v.name) from pg_class c join pg_namespace n on n.oid=c.relnamespace cross join pg_roles r cross join (values('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')) v(name) where n.nspname='public' and c.relname=any(array['time_shifts','personal_activity_state','personal_activity_transition_sources','personal_activity_transitions','work_activity_safety_events','work_unit_fact_revisions','work_unit_fact_current','work_unit_fact_context_epochs','custom_work_units','project_openings','service_visit_units','service_visits','summons','unit_redos','qc_checks','install_events','crew_work_records','crew_work_record_people','work_session_capture_metadata','custom_work_history','custom_work_sessions','unit_sessions','task_sessions','service_time_sessions','opening_phases','summon_helpers','work_activity_source_history','work_unit_review_commands','work_unit_dimension_verifications','work_unit_review_events','work_unit_review_current','work_unit_review_defects','work_unit_review_defect_events','work_setup_sessions','personal_activity_commands','work_activity_definitions','work_activity_definition_versions','work_capture_menus','work_capture_menu_versions','work_capture_menu_items','work_job_menu_selections','profiles','projects','sandbox_projects','work_job_management_grants','_work_unit_metadata_definitions','_work_unit_metadata_versions','_work_unit_metadata_proposals','_work_unit_metadata_revisions','_work_unit_metadata_current','_work_unit_metadata_floors','_work_unit_metadata_floor_current','_work_unit_metadata_commands','_work_unit_metadata_contract','_work_unit_review_live_sources']) and r.rolname in('anon','authenticated','service_role')),
 -- Effective access includes table-derived rights, role inheritance and PUBLIC.
 'columnAccess',(select jsonb_agg(jsonb_build_object('table',c.relname,'role',r.rolname,'privilege',v.name,'allowed',has_any_column_privilege(r.oid,c.oid,v.name)) order by c.relname,r.rolname,v.name) from pg_class c join pg_namespace n on n.oid=c.relnamespace cross join pg_roles r cross join (values('SELECT'),('INSERT'),('UPDATE'),('REFERENCES')) v(name) where n.nspname='public' and c.relname=any(array['time_shifts','personal_activity_state','personal_activity_transition_sources','personal_activity_transitions','work_activity_safety_events','work_unit_fact_revisions','work_unit_fact_current','work_unit_fact_context_epochs','custom_work_units','project_openings','service_visit_units','service_visits','summons','unit_redos','qc_checks','install_events','crew_work_records','crew_work_record_people','work_session_capture_metadata','custom_work_history','custom_work_sessions','unit_sessions','task_sessions','service_time_sessions','opening_phases','summon_helpers','work_activity_source_history','work_unit_review_commands','work_unit_dimension_verifications','work_unit_review_events','work_unit_review_current','work_unit_review_defects','work_unit_review_defect_events','work_setup_sessions','personal_activity_commands','work_activity_definitions','work_activity_definition_versions','work_capture_menus','work_capture_menu_versions','work_capture_menu_items','work_job_menu_selections','profiles','projects','sandbox_projects','work_job_management_grants','_work_unit_metadata_definitions','_work_unit_metadata_versions','_work_unit_metadata_proposals','_work_unit_metadata_revisions','_work_unit_metadata_current','_work_unit_metadata_floors','_work_unit_metadata_floor_current','_work_unit_metadata_commands','_work_unit_metadata_contract','_work_unit_review_live_sources']) and r.rolname in('anon','authenticated','service_role')),
 'constraints',(select jsonb_agg(jsonb_build_object('table',c.relname,'name',k.conname,'definition',pg_get_constraintdef(k.oid,true),'validated',k.convalidated,'enforced',coalesce((to_jsonb(k)->>'conenforced')::boolean,true),'deferrable',k.condeferrable,'deferred',k.condeferred) order by c.relname,k.conname) from pg_constraint k join pg_class c on c.oid=k.conrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and k.contype<>'n' and c.relname=any(array['time_shifts','personal_activity_state','personal_activity_transition_sources','personal_activity_transitions','work_activity_safety_events','work_unit_fact_revisions','work_unit_fact_current','work_unit_fact_context_epochs','custom_work_units','project_openings','service_visit_units','service_visits','summons','unit_redos','qc_checks','install_events','crew_work_records','crew_work_record_people','work_session_capture_metadata','custom_work_history','custom_work_sessions','unit_sessions','task_sessions','service_time_sessions','opening_phases','summon_helpers','work_activity_source_history','work_unit_review_commands','work_unit_dimension_verifications','work_unit_review_events','work_unit_review_current','work_unit_review_defects','work_unit_review_defect_events','work_setup_sessions','personal_activity_commands','work_activity_definitions','work_activity_definition_versions','work_capture_menus','work_capture_menu_versions','work_capture_menu_items','work_job_menu_selections','profiles','projects','sandbox_projects','work_job_management_grants','_work_unit_metadata_definitions','_work_unit_metadata_versions','_work_unit_metadata_proposals','_work_unit_metadata_revisions','_work_unit_metadata_current','_work_unit_metadata_floors','_work_unit_metadata_floor_current','_work_unit_metadata_commands','_work_unit_metadata_contract'])),
 'policies',(select jsonb_agg(jsonb_build_object('table',tablename,'name',policyname,'permissive',permissive,'roles',roles,'command',cmd,'using',qual,'check',with_check) order by tablename,policyname) from pg_policies where schemaname='public' and tablename=any(array['time_shifts','personal_activity_state','personal_activity_transition_sources','personal_activity_transitions','work_activity_safety_events','work_unit_fact_revisions','work_unit_fact_current','work_unit_fact_context_epochs','custom_work_units','project_openings','service_visit_units','service_visits','summons','unit_redos','qc_checks','install_events','crew_work_records','crew_work_record_people','work_session_capture_metadata','custom_work_history','custom_work_sessions','unit_sessions','task_sessions','service_time_sessions','opening_phases','summon_helpers','work_activity_source_history','work_unit_review_commands','work_unit_dimension_verifications','work_unit_review_events','work_unit_review_current','work_unit_review_defects','work_unit_review_defect_events','work_setup_sessions','personal_activity_commands','work_activity_definitions','work_activity_definition_versions','work_capture_menus','work_capture_menu_versions','work_capture_menu_items','work_job_menu_selections','profiles','projects','sandbox_projects','work_job_management_grants','_work_unit_metadata_definitions','_work_unit_metadata_versions','_work_unit_metadata_proposals','_work_unit_metadata_revisions','_work_unit_metadata_current','_work_unit_metadata_floors','_work_unit_metadata_floor_current','_work_unit_metadata_commands','_work_unit_metadata_contract'])),
 'view',pg_get_viewdef('public._work_unit_review_live_sources'::regclass,true),
 'tables',(select jsonb_agg(jsonb_build_object('table',c.relname,'rls',c.relrowsecurity,'forcedRls',c.relforcerowsecurity,'kind',c.relkind,'persistence',c.relpersistence,'rawAcl',c.relacl::text,'owner',pg_get_userbyid(c.relowner)) order by c.relname) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname=any(array['time_shifts','personal_activity_state','personal_activity_transition_sources','personal_activity_transitions','work_activity_safety_events','work_unit_fact_revisions','work_unit_fact_current','work_unit_fact_context_epochs','custom_work_units','project_openings','service_visit_units','service_visits','summons','unit_redos','qc_checks','install_events','crew_work_records','crew_work_record_people','work_session_capture_metadata','custom_work_history','custom_work_sessions','unit_sessions','task_sessions','service_time_sessions','opening_phases','summon_helpers','work_activity_source_history','work_unit_review_commands','work_unit_dimension_verifications','work_unit_review_events','work_unit_review_current','work_unit_review_defects','work_unit_review_defect_events','work_setup_sessions','personal_activity_commands','work_activity_definitions','work_activity_definition_versions','work_capture_menus','work_capture_menu_versions','work_capture_menu_items','work_job_menu_selections','profiles','projects','sandbox_projects','work_job_management_grants','_work_unit_metadata_definitions','_work_unit_metadata_versions','_work_unit_metadata_proposals','_work_unit_metadata_revisions','_work_unit_metadata_current','_work_unit_metadata_floors','_work_unit_metadata_floor_current','_work_unit_metadata_commands','_work_unit_metadata_contract']))
) value)c where p.proof_key='metadata_v1'),false)
$coverage$;
revoke all on function public._work_unit_metadata_coverage() from public,anon,authenticated,service_role;
-- METADATA_COVERAGE_END
-- METADATA_PROOF_SEED_BEGIN
insert into public._work_unit_metadata_contract(proof_key,expected_catalog_sha256) values('metadata_v1','a31d12d7a819d5b232e1206b9783edad62c5c648e0df747c8c36d2ba92329024');
-- METADATA_PROOF_SEED_END
rollback;
