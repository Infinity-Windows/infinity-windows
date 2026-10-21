-- Narrow source-authority supplement: exactly six known application routines
-- whose installed bodies differ from repository source, plus FK column names.
-- No application rows, configuration values, credentials or operational writes.
do $$
declare catalog jsonb; encoded text; checksum text; parts integer; i integer;
begin
  perform pg_temp.dry_run_as_system();
  select jsonb_build_object(
    'functions',(select jsonb_agg(jsonb_build_object(
      'oid',p.oid,'name',p.proname,'identity',pg_get_function_identity_arguments(p.oid),
      'securityDefiner',p.prosecdef,'acl',p.proacl,'owner',pg_get_userbyid(p.proowner),
      'volatility',p.provolatile,'language',l.lanname,'body',p.prosrc,'definition',pg_get_functiondef(p.oid),
      'bodySha256',encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')) order by p.oid)
      from pg_proc p join pg_language l on l.oid=p.prolang where p.oid=any(array[
        'public.receive_window(uuid,uuid,text)'::regprocedure::oid,
        'public.trg_sync_project_windows_from_openings()'::regprocedure::oid,
        'public.set_opening_condition(uuid,text,text,text)'::regprocedure::oid,
        'public.activate_preissued_unit(text,uuid,boolean,text)'::regprocedure::oid,
        'public.unload_units(uuid[],uuid[],uuid,text,text)'::regprocedure::oid,
        'public.acknowledge_spec_discrepancy(uuid,text,text,text,text)'::regprocedure::oid])),
    'foreignKeys',(select coalesce(jsonb_agg(jsonb_build_object(
      'oid',c.oid,'name',c.conname,'child',c.conrelid::regclass::text,'parent',c.confrelid::regclass::text,
      'childColumns',(select jsonb_agg(a.attname order by k.n) from unnest(c.conkey) with ordinality k(attnum,n) join pg_attribute a on a.attrelid=c.conrelid and a.attnum=k.attnum),
      'parentColumns',(select jsonb_agg(a.attname order by k.n) from unnest(c.confkey) with ordinality k(attnum,n) join pg_attribute a on a.attrelid=c.confrelid and a.attnum=k.attnum),
      'deleteAction',c.confdeltype,'updateAction',c.confupdtype,'deferrable',c.condeferrable,'initiallyDeferred',c.condeferred,'validated',c.convalidated) order by c.oid),'[]'::jsonb)
      from pg_constraint c join pg_class r on r.oid=c.conrelid join pg_namespace n on n.oid=r.relnamespace where c.contype='f' and n.nspname='public')) into catalog;
  if jsonb_array_length(catalog->'functions')<>6 then raise exception 'Expected exactly six installed application definitions'; end if;
  encoded:=catalog::text; checksum:=encode(sha256(convert_to(encoded,'UTF8')),'hex'); parts:=ceil(length(encoded)/450.0)::integer;
  perform pg_temp.dry_run_check('catalogHeader',true,jsonb_build_object('sha256',checksum,'characters',length(encoded),'parts',parts,'functions',jsonb_array_length(catalog->'functions'),'foreignKeys',jsonb_array_length(catalog->'foreignKeys'))::text);
  for i in 1..parts loop
    perform pg_temp.dry_run_check('catalogPart/'||lpad(i::text,6,'0'),true,substring(encoded from (i-1)*450+1 for 450));
  end loop;
end $$;
