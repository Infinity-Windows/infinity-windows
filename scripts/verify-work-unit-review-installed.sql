-- Read-only metadata fragment. Run ONLY inside the coordinator's exact-source,
-- forced-ROLLBACK candidate assembly. No production clock/employee/QC writes.
with private_tables(name) as (values
 ('work_activity_source_history'),('work_unit_review_commands'),
 ('work_unit_dimension_verifications'),('work_unit_review_events'),
 ('work_unit_review_current'),('work_unit_review_defects'),('work_unit_review_defect_events')),
 relations as (select c.* from pg_class c join pg_namespace n on n.oid=c.relnamespace
 join private_tables p on p.name=c.relname where n.nspname='public'),
 checks as (
 select 'unit_review_source_contract' check_name,public._work_unit_review_coverage() passed
 union all select 'unit_review_private_rls',count(*)=7 and bool_and(relrowsecurity) from relations
 union all select 'unit_review_no_raw_client_service_privileges',not exists(
 select 1 from relations c cross join (values('anon'),('authenticated'),('service_role')) r(name)
 cross join (values('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')) p(name)
 where has_table_privilege(r.name,c.oid,p.name))
 union all select 'unit_review_no_cascade_source_fks',not exists(
 select 1 from pg_constraint k join relations r on r.oid=k.conrelid where k.contype='f' and (k.confdeltype not in ('a','r') or not exists(select 1 from relations target where target.oid=k.confrelid)))
 union all select 'unit_review_public_rpc_acl',bool_and(
 has_function_privilege('authenticated',p.oid,'EXECUTE') and not has_function_privilege('anon',p.oid,'EXECUTE')
 and not has_function_privilege('service_role',p.oid,'EXECUTE') and p.prosecdef)
 from pg_proc p where p.oid in ('public.work_unit_review_read(uuid)'::regprocedure,
 'public.work_unit_review_command(uuid,integer,jsonb)'::regprocedure,'public.work_unit_review_command_receipt(uuid)'::regprocedure,
 'public.work_unit_review_cancel(uuid,integer,jsonb)'::regprocedure)
 union all select 'unit_review_cancel_helper_private',bool_and(not has_function_privilege(r.name,'public._work_unit_review_original_visible(uuid,jsonb,jsonb)'::regprocedure,'EXECUTE')) from (values('anon'),('authenticated'),('service_role')) r(name)
 union all select 'unit_review_census_retention',position('work_unit_review_events.original_identities' in p.prosrc)>0
 and position('work_activity_source_history.original_identities' in p.prosrc)>0
 from pg_proc p where p.oid='public.person_record_counts(uuid)'::regprocedure
 union all select 'unit_review_capture_remains_off',not capture_enabled from public.work_activity_authority_generation where singleton
) select check_name,passed from checks order by check_name;
