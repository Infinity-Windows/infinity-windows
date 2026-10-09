-- Metadata only. Exact built-in library/logging settings for the already
-- identified role-parity gap. Never select custom GUC values or pg_authid.
do $role_libraries$
declare evidence jsonb;
begin
 perform pg_temp.dry_run_as_system();
 select coalesce(jsonb_agg(jsonb_build_object('role',pg_get_userbyid(s.setrole),
  'scope',case when s.setdatabase=0 then 'all_databases' else 'current_database' end,
  'key',split_part(v,'=',1),'value',substring(v from position('=' in v)+1))
  order by s.setrole,s.setdatabase,ord),'[]'::jsonb) into evidence
 from pg_db_role_setting s cross join lateral unnest(s.setconfig) with ordinality x(v,ord)
 where s.setrole in(select oid from pg_roles where rolname in('authenticator','supabase_admin','supabase_auth_admin'))
 and (s.setdatabase=0 or s.setdatabase=(select oid from pg_database where datname=current_database()))
 and lower(split_part(v,'=',1)) in('session_preload_libraries','log_statement');
 if octet_length(evidence::text)>12000 then raise exception using errcode='54000',message='Role library metadata exceeds bound.';end if;
 perform pg_temp.dry_run_check('roleLibrarySettings',true,evidence::text);
end;
$role_libraries$;
