select 'contributorsExactCoverage' check_name,
 public._work_unit_contributors_coverage() passed
union all select 'contributorsPriorCoverage',
 public._work_unit_review_coverage() and public._work_totals_coverage()
union all select 'contributorsCaptureStillDisabled',
 not capture_enabled from public.work_activity_authority_generation where singleton
union all select 'contributorsAuthenticatedReadOnlyGrant',
 has_function_privilege('authenticated','public.work_unit_contributors_read(uuid,uuid,integer)','EXECUTE')
 and not has_function_privilege('anon','public.work_unit_contributors_read(uuid,uuid,integer)','EXECUTE')
 and not has_function_privilege('service_role','public.work_unit_contributors_read(uuid,uuid,integer)','EXECUTE')
union all select 'contributorsPrivateHelpersDenied',not exists(
 select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 cross join (values('anon'),('authenticated'),('service_role')) r(name)
 where n.nspname='public' and starts_with(p.proname,'_work_unit_contributors_')
 and has_function_privilege(r.name,p.oid,'EXECUTE'))
union all select 'contributorsNoPersistentRelations',not exists(
 select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
 where n.nspname='public' and starts_with(c.relname,'_work_unit_contributors_'));
