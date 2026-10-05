-- Metadata only. No credential columns, role changes or application row writes.
do $$
declare catalog jsonb; encoded text; checksum text; parts integer; i integer;
begin
 perform pg_temp.dry_run_as_system();
 select jsonb_build_object(
  'serverVersionNum',current_setting('server_version_num'),
  'roles',(select jsonb_agg(jsonb_build_object('name',r.rolname,'superuser',r.rolsuper,'inherit',r.rolinherit,'createRole',r.rolcreaterole,'createDatabase',r.rolcreatedb,'canLogin',r.rolcanlogin,'bypassRls',r.rolbypassrls) order by r.rolname)
   from pg_roles r where r.rolname=any(array['anon','authenticated','service_role','postgres','supabase_admin','supabase_auth_admin','authenticator'])),
  'memberships',(select coalesce(jsonb_agg(jsonb_build_object('role',granted.rolname,'member',member.rolname,'grantor',grantor.rolname,
    'adminOption',m.admin_option,'inheritOption',to_jsonb(m)->'inherit_option','setOption',to_jsonb(m)->'set_option') order by granted.rolname,member.rolname),'[]'::jsonb)
   from pg_auth_members m join pg_roles granted on granted.oid=m.roleid join pg_roles member on member.oid=m.member join pg_roles grantor on grantor.oid=m.grantor
   where member.rolname=any(array['anon','authenticated','service_role','postgres','supabase_admin','supabase_auth_admin','authenticator']))) into catalog;
 encoded:=catalog::text; checksum:=encode(sha256(convert_to(encoded,'UTF8')),'hex'); parts:=ceil(length(encoded)/450.0)::integer;
 perform pg_temp.dry_run_check('catalogHeader',true,jsonb_build_object('sha256',checksum,'characters',length(encoded),'parts',parts)::text);
 for i in 1..parts loop perform pg_temp.dry_run_check('catalogPart/'||lpad(i::text,6,'0'),true,substring(encoded from (i-1)*450+1 for 450));end loop;
end $$;
