-- Catalog-only role/runtime authority evidence. No passwords, auth user IDs,
-- operational rows, role changes, function calls into application code or DML.
-- The normal harness owns BEGIN/ROLLBACK and stages unchanged private0840.
do $activity_role_parity$
declare catalog jsonb; encoded text; checksum text; parts integer; i integer;
 root_names text[]:=array['anon','authenticated','service_role','postgres','supabase_admin','supabase_auth_admin','authenticator'];
 safe_settings text[]:=array['search_path','row_security','statement_timeout','lock_timeout','idle_in_transaction_session_timeout',
  'idle_session_timeout','transaction_timeout','default_transaction_isolation','default_transaction_read_only',
  'default_transaction_deferrable','timezone','datestyle','client_encoding','standard_conforming_strings','check_function_bodies','jit'];
begin
 perform pg_temp.dry_run_as_system();
 with recursive closure(roleid) as (
  select r.oid from pg_roles r where r.rolname=any(root_names)
  union
  select m.roleid from pg_auth_members m join closure c on c.roleid=m.member
 ), relevant as (select r.oid,r.rolname,r.rolsuper,r.rolinherit,r.rolcreaterole,r.rolcreatedb,r.rolcanlogin,r.rolreplication,r.rolbypassrls,r.rolconnlimit from pg_roles r join closure c on c.roleid=r.oid)
 select jsonb_build_object(
  'serverVersionNum',current_setting('server_version_num'),
  'database',(
   select jsonb_build_object('owner',pg_get_userbyid(d.datdba),'acl',to_jsonb(d.datacl))
   from pg_database d where d.datname=current_database()),
  'roles',(
   select jsonb_agg(jsonb_build_object('name',r.rolname,'superuser',r.rolsuper,'inherit',r.rolinherit,
    'createRole',r.rolcreaterole,'createDatabase',r.rolcreatedb,'canLogin',r.rolcanlogin,
    'replication',r.rolreplication,'bypassRls',r.rolbypassrls,'connectionLimit',r.rolconnlimit) order by r.rolname)
   from relevant r),
  'memberships',(
   select coalesce(jsonb_agg(jsonb_build_object('role',granted.rolname,'member',member.rolname,'grantor',grantor.rolname,
    'adminOption',m.admin_option,'inheritOption',m.inherit_option,'setOption',m.set_option)
    order by granted.rolname,member.rolname,grantor.rolname),'[]'::jsonb)
   from pg_auth_members m join relevant member on member.oid=m.member
   join pg_roles granted on granted.oid=m.roleid join pg_roles grantor on grantor.oid=m.grantor),
  'capabilities',(
   select jsonb_agg(jsonb_build_object('role',r.rolname,
    'databaseConnect',has_database_privilege(r.oid,current_database(),'CONNECT'),
    'databaseCreate',has_database_privilege(r.oid,current_database(),'CREATE'),
    'databaseTemp',has_database_privilege(r.oid,current_database(),'TEMPORARY'),
    'publicUsage',has_schema_privilege(r.oid,'public','USAGE'),'publicCreate',has_schema_privilege(r.oid,'public','CREATE'),
    'authUsage',has_schema_privilege(r.oid,'auth','USAGE'),'authCreate',has_schema_privilege(r.oid,'auth','CREATE')) order by r.rolname)
   from relevant r where r.rolname=any(root_names)),
  'rolePaths',(
   select jsonb_agg(jsonb_build_object('actor',actor.rolname,'target',target.rolname,
    'member',pg_has_role(actor.oid,target.oid,'MEMBER'),'usage',pg_has_role(actor.oid,target.oid,'USAGE'),
    'set',pg_has_role(actor.oid,target.oid,'SET')) order by actor.rolname,target.rolname)
   from relevant actor cross join relevant target where actor.rolname=any(root_names)),
  'settings',(
   select coalesce(jsonb_agg(jsonb_build_object('role',case when s.setrole=0 then null else pg_get_userbyid(s.setrole) end,
    'scope',case when s.setdatabase=0 then 'all_databases' else 'current_database' end,
    'settingsSha256',encode(sha256(convert_to(s.setconfig::text,'UTF8')),'hex'),
    'safeValues',(select coalesce(jsonb_agg(v order by ord),'[]'::jsonb) from unnest(s.setconfig) with ordinality x(v,ord)
      where lower(split_part(v,'=',1))=any(safe_settings)),
    'withheldKeys',(select coalesce(jsonb_agg(split_part(v,'=',1) order by ord),'[]'::jsonb) from unnest(s.setconfig) with ordinality x(v,ord)
      where not lower(split_part(v,'=',1))=any(safe_settings))) order by s.setdatabase,s.setrole),'[]'::jsonb)
   from pg_db_role_setting s where (s.setrole=0 or s.setrole in(select oid from relevant))
    and (s.setdatabase=0 or s.setdatabase=(select oid from pg_database where datname=current_database())))) into catalog;
 encoded:=catalog::text;checksum:=encode(sha256(convert_to(encoded,'UTF8')),'hex');parts:=ceil(length(encoded)/450.0)::integer;
 perform pg_temp.dry_run_check('roleParityHeader',true,jsonb_build_object('sha256',checksum,'characters',length(encoded),'parts',parts)::text);
 for i in 1..parts loop
  perform pg_temp.dry_run_check('roleParityPart/'||lpad(i::text,6,'0'),true,substring(encoded from (i-1)*450+1 for 450));
 end loop;
end;
$activity_role_parity$;
