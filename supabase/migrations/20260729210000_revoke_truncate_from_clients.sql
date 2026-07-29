-- Take TRUNCATE away from the browser roles, on every table in `public`.
--
-- Why this matters. TRUNCATE is the one write that row-level security does not
-- see. Every policy in this database is a filter on rows; TRUNCATE does not
-- touch rows one at a time, it empties the file. So a table can have a perfect
-- set of policies and still be wiped in full by anybody holding the privilege.
-- On 2026-07-29 that privilege was held by `anon` (a signed-out visitor) on 70
-- tables and by `authenticated` (any crew member) on 75 relations — everything
-- except `profiles`, which was fixed earlier the same day.
--
-- Nobody granted it. Supabase ships an ALTER DEFAULT PRIVILEGES rule that hands
-- `anon`, `authenticated` and `service_role` every privilege on each new table
-- in `public`, so the grant arrives automatically with each `create table` and
-- would have come back on the next migration if only the current instances were
-- revoked. This file therefore does both: it revokes what exists, and it edits
-- the default so new tables never receive it.
--
-- Behaviour-neutral for the app. PostgREST has no way to issue a TRUNCATE:
-- there is no REST verb for it and `.rpc()` can only reach functions. Nothing
-- in app/src, supabase/functions or supabase/migrations issues one. The service
-- role and the table owner (postgres) keep it, so migrations, seeds and edge
-- functions are untouched.
--
-- Rollback is at the bottom of docs/security-followups-2026-07-29.md.

begin;

-- 1. Current instances. `all tables in schema` covers views too, where TRUNCATE
--    is meaningless but was granted anyway by the same default.
revoke truncate on all tables in schema public from anon, authenticated;

-- 2. The source of the pattern. Without this, the very next `create table` in a
--    migration re-grants TRUNCATE to both roles and this fix silently decays.
--
--    Only the rule owned by `postgres` is touched, and only TRUNCATE is
--    subtracted from it. Every table and view in `public` is owned by
--    `postgres` (74 tables, 3 views on 2026-07-29), and the default privileges
--    that apply to a new object are the ones belonging to the role that creates
--    it, so this is the rule that governs everything this repo creates.
--
--    There is a second rule in `public` owned by `supabase_admin`. It cannot be
--    altered from a migration — `postgres` is not a member of that role and
--    Postgres answers `42501 permission denied to change default privileges` —
--    and it does not need to be, because nothing in this project creates
--    objects as `supabase_admin`. It is recorded in the doc as a known
--    platform-side leftover rather than pretended away.
alter default privileges for role postgres in schema public
  revoke truncate on tables from anon, authenticated;

-- 3. Prove it took effect, in the same transaction, and refuse to commit if it
--    did not. A revoke that matched nothing exits 0 exactly like one that
--    worked, so "no error" is not evidence.
do $$
declare
  remaining int;
  default_still_grants boolean;
begin
  select count(*) into remaining
  from information_schema.role_table_grants
  where table_schema = 'public'
    and privilege_type = 'TRUNCATE'
    and grantee in ('anon', 'authenticated');

  if remaining <> 0 then
    raise exception
      'TRUNCATE is still granted to a client role on % relation(s) in public', remaining;
  end if;

  select exists (
    select 1
    from pg_default_acl d
    join pg_namespace n on n.oid = d.defaclnamespace
    cross join lateral unnest(d.defaclacl) as acl(entry)
    where n.nspname = 'public'
      and d.defaclobjtype = 'r'
      and pg_get_userbyid(d.defaclrole) = 'postgres'
      and (acl.entry::text like 'anon=%D%' or acl.entry::text like 'authenticated=%D%')
  ) into default_still_grants;

  if default_still_grants then
    raise exception
      'the default privileges for role postgres in schema public still grant TRUNCATE to a client role';
  end if;

  -- The other side of the assertion: the roles that legitimately need TRUNCATE
  -- must still have it, or this migration has broken the service role instead
  -- of the attacker.
  if not has_table_privilege('service_role', 'public.projects', 'TRUNCATE') then
    raise exception 'service_role lost TRUNCATE; refusing to commit';
  end if;

  raise notice 'TRUNCATE revoked from anon and authenticated across schema public, and removed from the default for new tables';
end $$;

commit;
