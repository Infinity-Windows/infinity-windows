-- Catalog-only installed-schema evidence after the unchanged private substrate.
-- No operational rows, employees, secrets, source payloads or timing writes.
-- The candidate adds only the six private substrate tables/helpers; legacy
-- procedure/trigger/FK catalogs otherwise remain the installed production ones.
do $$
declare catalog jsonb; encoded text; checksum text; parts integer; i integer;
begin
  perform pg_temp.dry_run_as_system();
  select jsonb_build_object(
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
      where n.nspname='public'),
    'functions',(select coalesce(jsonb_agg(jsonb_build_object(
      'oid',p.oid,'name',p.proname,'identity',pg_get_function_identity_arguments(p.oid),'securityDefiner',p.prosecdef,
      'acl',p.proacl,'owner',pg_get_userbyid(p.proowner),'volatility',p.provolatile,'kind',p.prokind,'configuration',p.proconfig) order by p.oid),'[]'::jsonb)
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public')) into catalog;
  encoded:=catalog::text; checksum:=encode(sha256(convert_to(encoded,'UTF8')),'hex'); parts:=ceil(length(encoded)/450.0)::integer;
  perform pg_temp.dry_run_check('catalogHeader',true,jsonb_build_object('sha256',checksum,'characters',length(encoded),'parts',parts,
    'foreignKeys',jsonb_array_length(catalog->'foreignKeys'),'triggers',jsonb_array_length(catalog->'triggers'),'functions',jsonb_array_length(catalog->'functions'))::text);
  for i in 1..parts loop
    perform pg_temp.dry_run_check('catalogPart/'||lpad(i::text,6,'0'),true,substring(encoded from (i-1)*450+1 for 450));
  end loop;
end $$;
