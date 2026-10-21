-- Metadata-only fragment inside the exact candidate forced-rollback assembly.
with checks as (
 select 'totals_exact_source_contract' check_name, public._work_totals_coverage() passed
 union all select 'totals_frozen_review_dependency',public._work_unit_review_coverage()
 union all select 'totals_public_read_acl',p.prosecdef and pg_get_userbyid(p.proowner)='postgres'
 and has_function_privilege('authenticated',p.oid,'EXECUTE')
 and not has_function_privilege('anon',p.oid,'EXECUTE')
 and not has_function_privilege('service_role',p.oid,'EXECUTE')
 from pg_proc p where p.oid='public.work_activity_totals_read(uuid,uuid)'::regprocedure
 union all select 'totals_helpers_private',count(*)=15 and bool_and(not has_function_privilege(r.name,p.oid,'EXECUTE'))
 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 cross join (values('anon'),('authenticated'),('service_role')) r(name)
 where n.nspname='public' and p.proname=any(array['_work_totals_coverage','_work_totals_source','_work_totals_visible','_work_totals_capture','_work_totals_shift'])
 union all select 'totals_capture_remains_off',not capture_enabled from public.work_activity_authority_generation where singleton
) select check_name,passed from checks order by check_name;
