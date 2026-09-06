-- One read of the security shape of the live database, for
-- scripts/verify_invariants.py to judge. Run through scripts/pgq.sh, which
-- refuses anything that is not a SELECT; scripts/verify-invariants.sh does the
-- plumbing.
--
-- Every question here has a static twin that replays the migration files in
-- CI (scripts/test_partner_wall.py, scripts/test_sandbox_guard.py, the
-- profiles lockdown in 20260729200000). The static twin proves the FILES say
-- the right thing. This proves the DATABASE does — which is a different
-- question the day someone edits a policy in the dashboard, or a migration is
-- applied by hand and never committed (July 2026 had twelve of those).
--
-- If this batch fails to parse on the server, the likeliest cause is that
-- 20260967000000_sandbox_guard_rearm.sql has not been applied, because
-- sandbox_guard_census() comes from it. The judge says so in those words.
select json_build_object(
  -- Every row-level policy on crew tables and on storage. roles is name[];
  -- '{public}' is what a policy written without a `to` clause carries, and
  -- it means "everyone, anon included".
  'policies', (
    select coalesce(json_agg(json_build_object(
      'schema', p.schemaname, 'table', p.tablename, 'name', p.policyname,
      'cmd', p.cmd, 'roles', p.roles::text[],
      'using', coalesce(p.qual, ''), 'check', coalesce(p.with_check, '')
    ) order by p.schemaname, p.tablename, p.policyname), '[]'::json)
    from pg_policies p
    where p.schemaname in ('public', 'storage')
  ),
  -- Which credential columns on profiles each client role can still read.
  -- Built from information_schema so a column that no longer exists is simply
  -- absent rather than an error.
  'profile_columns', (
    select coalesce(json_agg(json_build_object(
      'column', c.column_name, 'role', r.role,
      'select', has_column_privilege(r.role, 'public.profiles', c.column_name, 'SELECT')
    ) order by c.column_name, r.role), '[]'::json)
    from information_schema.columns c
    cross join (values ('anon'), ('authenticated')) as r(role)
    where c.table_schema = 'public' and c.table_name = 'profiles'
      and c.column_name in ('pin', 'pin_hash', 'pin_salt')
  ),
  'profile_truncate', (
    select json_build_object(
      'anon', has_table_privilege('anon', 'public.profiles', 'TRUNCATE'),
      'authenticated', has_table_privilege('authenticated', 'public.profiles', 'TRUNCATE')
    )
  ),
  -- The test-login fence: every project-scoped table missing the guard.
  'fence_unguarded', (
    select coalesce(json_agg(json_build_object(
      'table', table_name, 'column', link_column, 'reason', reason
    ) order by table_name), '[]'::json)
    from public.sandbox_guard_census()
  ),
  'test_logins', (select count(*) from public.profiles where is_test),
  -- Advisory: tables in public that a client role can touch but that have no
  -- row-level security switched on. Reported, not failed — see the judge.
  'rls_off', (
    select coalesce(json_agg(c.relname order by c.relname), '[]'::json)
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity
      and (has_table_privilege('authenticated', c.oid, 'SELECT')
        or has_table_privilege('anon', c.oid, 'SELECT'))
  ),
  -- Advisory: SECURITY DEFINER functions an anonymous caller may execute.
  'anon_definer_functions', (
    select coalesce(json_agg(p.proname order by p.proname), '[]'::json)
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef
      and has_function_privilege('anon', p.oid, 'EXECUTE')
  )
) as report
