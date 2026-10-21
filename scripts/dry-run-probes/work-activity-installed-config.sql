-- Installed routine settings and schema authority only. No application rows.
-- Known built-in execution settings are emitted; unknown/custom setting values
-- are withheld, with key names/hash so incomplete preservation cannot look green.
do $$
declare catalog jsonb; encoded text; checksum text; parts integer; i integer;
begin
 perform pg_temp.dry_run_as_system();
 select jsonb_build_object(
  'functions',(select jsonb_agg(jsonb_build_object('oid',p.oid,'name',p.proname,'identity',pg_get_function_identity_arguments(p.oid),
   'config',(select coalesce(jsonb_agg(c order by ordinal),'[]'::jsonb) from unnest(p.proconfig) with ordinality t(c,ordinal) where lower(split_part(c,'=',1))=any(array['search_path','row_security','statement_timeout','lock_timeout','timezone','client_min_messages','check_function_bodies','default_transaction_isolation','default_transaction_read_only','default_transaction_deferrable'])),
   'withheldKeys',(select coalesce(jsonb_agg(split_part(c,'=',1) order by ordinal),'[]'::jsonb) from unnest(p.proconfig) with ordinality t(c,ordinal) where not(lower(split_part(c,'=',1))=any(array['search_path','row_security','statement_timeout','lock_timeout','timezone','client_min_messages','check_function_bodies','default_transaction_isolation','default_transaction_read_only','default_transaction_deferrable']))),
   'configIsNull',p.proconfig is null,'configSha256',case when p.proconfig is null then null else encode(sha256(convert_to(p.proconfig::text,'UTF8')),'hex') end) order by p.oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'),
  'schemas',(select jsonb_agg(jsonb_build_object('name',n.nspname,'owner',pg_get_userbyid(n.nspowner),'acl',n.nspacl,
   'roleCreate',(select jsonb_agg(jsonb_build_object('role',r.rolname,'canCreate',has_schema_privilege(r.oid,n.oid,'CREATE')) order by r.rolname) from pg_roles r where r.rolname=any(array['anon','authenticated','service_role','postgres','supabase_admin','supabase_auth_admin','authenticator']))) order by n.nspname) from pg_namespace n where n.nspname in('public','auth'))) into catalog;
 encoded:=catalog::text; checksum:=encode(sha256(convert_to(encoded,'UTF8')),'hex'); parts:=ceil(length(encoded)/450.0)::integer;
 perform pg_temp.dry_run_check('catalogHeader',true,jsonb_build_object('sha256',checksum,'characters',length(encoded),'parts',parts,'functions',jsonb_array_length(catalog->'functions'),'schemas',jsonb_array_length(catalog->'schemas'))::text);
 for i in 1..parts loop perform pg_temp.dry_run_check('catalogPart/'||lpad(i::text,6,'0'),true,substring(encoded from (i-1)*450+1 for 450));end loop;
end $$;
