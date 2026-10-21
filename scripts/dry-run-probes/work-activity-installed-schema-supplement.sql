-- Catalog-only installed-schema supplement after the unchanged private substrate.
-- Routine bodies/configurations are hashed, not printed; no live body literals.
-- No operational rows, employees, secrets, source payloads or timing writes.
-- The candidate adds only the six private substrate tables/helpers; legacy
-- procedure/trigger/FK catalogs otherwise remain the installed production ones.
do $$
declare catalog jsonb; encoded text; checksum text; parts integer; i integer;
begin
  perform pg_temp.dry_run_as_system();
  select jsonb_build_object(
    'relations',(select coalesce(jsonb_agg(jsonb_build_object('oid',r.oid,'name',r.oid::regclass::text,'acl',r.relacl,'rls',r.relrowsecurity,'forceRls',r.relforcerowsecurity,'owner',pg_get_userbyid(r.relowner)) order by r.oid),'[]'::jsonb) from pg_class r where r.oid::regclass::text=any(array['auth.users','cost_codes','custom_work_sessions','custom_work_units','install_events','issues','locations','opening_phases','package_deliveries','packages','profiles','project_messages','project_openings','project_plansets','projects','service_cases','service_time_sessions','service_visit_units','service_visits','storage_containers','studio_projects','summon_helpers','summons','task_sessions','time_clock_actions','time_shifts','unit_sessions','window_types','windows'])),
    'policies',(select coalesce(jsonb_agg(jsonb_build_object('table',p.polrelid::regclass::text,'name',p.polname,'command',p.polcmd,'permissive',p.polpermissive,'roles',p.polroles,'using',pg_get_expr(p.polqual,p.polrelid),'check',pg_get_expr(p.polwithcheck,p.polrelid)) order by p.oid),'[]'::jsonb) from pg_policy p where p.polrelid::regclass::text=any(array['auth.users','cost_codes','custom_work_sessions','custom_work_units','install_events','issues','locations','opening_phases','package_deliveries','packages','profiles','project_messages','project_openings','project_plansets','projects','service_cases','service_time_sessions','service_visit_units','service_visits','storage_containers','studio_projects','summon_helpers','summons','task_sessions','time_clock_actions','time_shifts','unit_sessions','window_types','windows'])),
    'foreignKeys',(select coalesce(jsonb_agg(jsonb_build_object(
      'oid',c.oid,'name',c.conname,'child',c.conrelid::regclass::text,'parent',c.confrelid::regclass::text,
      'childColumns',c.conkey,'parentColumns',c.confkey,'deleteAction',c.confdeltype,'updateAction',c.confupdtype,
      'deferrable',c.condeferrable,'initiallyDeferred',c.condeferred,'validated',c.convalidated) order by c.oid),'[]'::jsonb)
      from pg_constraint c join pg_class r on r.oid=c.conrelid join pg_namespace n on n.oid=r.relnamespace
      where c.contype='f' and n.nspname='public'),
    'triggers',(select coalesce(jsonb_agg(jsonb_build_object(
      'oid',t.oid,'name',t.tgname,'table',t.tgrelid::regclass::text,'enabled',t.tgenabled,'internal',t.tgisinternal,
      'functionOid',t.tgfoid,'definition',pg_get_triggerdef(t.oid,true)) order by t.oid),'[]'::jsonb)
      from pg_trigger t join pg_class r on r.oid=t.tgrelid join pg_namespace n on n.oid=r.relnamespace
      where n.nspname='public' or t.tgrelid='auth.users'::regclass),
    'functions',(select coalesce(jsonb_agg(jsonb_build_object(
      'oid',p.oid,'name',p.proname,'identity',pg_get_function_identity_arguments(p.oid),'securityDefiner',p.prosecdef,
      'acl',p.proacl,'owner',pg_get_userbyid(p.proowner),'volatility',p.provolatile,'kind',p.prokind,'language',l.lanname,'bodySha256',encode(sha256(convert_to(p.prosrc,'UTF8')),'hex'),'definitionSha256',case when p.prokind in('f','p') then encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex') end,'binarySha256',case when p.probin is null then null else encode(sha256(convert_to(p.probin,'UTF8')),'hex') end,'configSha256',case when p.proconfig is null then null else encode(sha256(convert_to(p.proconfig::text,'UTF8')),'hex') end) order by p.oid),'[]'::jsonb)
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace join pg_language l on l.oid=p.prolang where n.nspname='public' or p.oid in(select tgfoid from pg_trigger where tgrelid='auth.users'::regclass))) into catalog;
  encoded:=catalog::text; checksum:=encode(sha256(convert_to(encoded,'UTF8')),'hex'); parts:=ceil(length(encoded)/450.0)::integer;
  perform pg_temp.dry_run_check('catalogHeader',true,jsonb_build_object('sha256',checksum,'characters',length(encoded),'parts',parts,
    'relations',jsonb_array_length(catalog->'relations'),'policies',jsonb_array_length(catalog->'policies'),'foreignKeys',jsonb_array_length(catalog->'foreignKeys'),'triggers',jsonb_array_length(catalog->'triggers'),'functions',jsonb_array_length(catalog->'functions'))::text);
  for i in 1..parts loop
    perform pg_temp.dry_run_check('catalogPart/'||lpad(i::text,6,'0'),true,substring(encoded from (i-1)*450+1 for 450));
  end loop;
end $$;
