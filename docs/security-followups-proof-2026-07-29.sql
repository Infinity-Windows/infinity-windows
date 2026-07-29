-- Proof for docs/security-followups-2026-07-29.md, re-runnable against
-- production. Everything happens inside one transaction that is ROLLED BACK, so
-- running this changes nothing.
--
-- The rule this file obeys, learned the hard way on the profiles work: row-level
-- security makes a forbidden write match zero rows and return SUCCESS. "No error
-- was raised" is therefore not evidence of anything. Every attack step below
-- asserts its own EFFECT — it raises if the attack failed to take effect — so a
-- line that reads REJECTED means the database actually stopped it, and a line
-- that reads ALLOWED means the thing really happened.
--
--   SUPABASE_PROJECT_REF=czprjcskmzzagdztqonm scripts/pgq.sh \
--     docs/security-followups-proof-2026-07-29.sql
--
-- (pgq.sh refuses non-SELECT statements, so in practice this is run through the
-- Management API directly; the transaction is rolled back either way.)

begin;

create temporary table proof(step text, actor text, attempt text, result text)
  on commit drop;

-- Chris, a plain installer, is 88e9158c-c299-4abf-86e2-4d6c1134d0be.
-- Impersonation is the same shape auth.uid() sees for a real signed-in request:
-- a request.jwt.claims GUC carrying the real production `sub`, plus
-- `set local role authenticated`.

--------------------------------------------------------------------------------
-- T0: is the TRUNCATE test below vacuous?
--
-- A test that would pass whatever the database did is worth nothing. So before
-- asserting that the attack is refused, hand the privilege back by hand and
-- check the attack then works. `project_windows` is used because it is a table
-- with rows that no foreign key references — TRUNCATE on a referenced table is
-- refused with 0A000 for reasons that have nothing to do with privileges, which
-- would have made the test look like a pass for the wrong reason.
--------------------------------------------------------------------------------
do $$
declare before_rows int; after_rows int;
begin
  grant truncate on table public.project_windows to authenticated;
  select count(*) into before_rows from public.project_windows;
  begin
    perform set_config('request.jwt.claims',
      '{"sub":"88e9158c-c299-4abf-86e2-4d6c1134d0be","role":"authenticated"}', true);
    set local role authenticated;
    truncate table public.project_windows;
    reset role;
    select count(*) into after_rows from public.project_windows;
    insert into proof values ('T0', 'installer',
      'TRUNCATE project_windows AFTER handing the privilege back (control)',
      case when after_rows < before_rows
        then format('ALLOWED - went from %s rows to %s, so the test below is real', before_rows, after_rows)
        else 'INCONCLUSIVE - the control did not take effect either' end);
  exception when others then
    reset role;
    insert into proof values ('T0', 'installer',
      'TRUNCATE project_windows AFTER handing the privilege back (control)',
      format('REJECTED %s %s - the control should have succeeded', SQLSTATE, SQLERRM));
  end;
  reset role;
  revoke truncate on table public.project_windows from authenticated;
end $$;

--------------------------------------------------------------------------------
-- T1..T6: TRUNCATE, the write that row-level security cannot see.
--------------------------------------------------------------------------------
do $$
declare
  before_rows int;
  after_rows int;
begin
  select count(*) into before_rows from public.projects;

  begin
    perform set_config('request.jwt.claims',
      '{"sub":"88e9158c-c299-4abf-86e2-4d6c1134d0be","role":"authenticated","email":"chris@crew.demo"}',
      true);
    set local role authenticated;

    truncate table public.projects;

    -- Reached only if TRUNCATE did NOT raise. Check the effect before believing
    -- it: a statement that "succeeded" without emptying the table would be a
    -- false alarm, and one that did empty it is a genuine failure of this fix.
    reset role;
    select count(*) into after_rows from public.projects;
    insert into proof values ('T1', 'installer', 'TRUNCATE public.projects',
      case when after_rows < before_rows
        then format('ALLOWED - table went from %s rows to %s', before_rows, after_rows)
        else 'INCONCLUSIVE - no error, but nothing was emptied either' end);
  exception when others then
    reset role;
    insert into proof values ('T1', 'installer', 'TRUNCATE public.projects',
      format('REJECTED %s %s', SQLSTATE, SQLERRM));
  end;
end $$;

do $$
begin
  begin
    perform set_config('request.jwt.claims',
      '{"sub":"88e9158c-c299-4abf-86e2-4d6c1134d0be","role":"authenticated"}', true);
    set local role authenticated;
    truncate table public.time_shifts;
    reset role;
    insert into proof values ('T2', 'installer', 'TRUNCATE public.time_shifts (everyone''s hours)',
      'ALLOWED');
  exception when others then
    reset role;
    insert into proof values ('T2', 'installer', 'TRUNCATE public.time_shifts (everyone''s hours)',
      format('REJECTED %s %s', SQLSTATE, SQLERRM));
  end;
end $$;

do $$
begin
  begin
    set local role anon;
    truncate table public.access_requests;
    reset role;
    insert into proof values ('T3', 'anon', 'TRUNCATE public.access_requests while signed out',
      'ALLOWED');
  exception when others then
    reset role;
    insert into proof values ('T3', 'anon', 'TRUNCATE public.access_requests while signed out',
      format('REJECTED %s %s', SQLSTATE, SQLERRM));
  end;
end $$;

-- The count that matters more than any single attempt: how many relations in
-- `public` still hand TRUNCATE to a browser role.
insert into proof
select 'T4', 'n/a', 'relations in public still granting TRUNCATE to anon/authenticated',
       case when count(*) = 0 then 'NONE' else count(*)::text || ' STILL GRANTED' end
from information_schema.role_table_grants
where table_schema = 'public'
  and privilege_type = 'TRUNCATE'
  and grantee in ('anon', 'authenticated');

-- And the reason it cannot come back on the next `create table`.
insert into proof
select 'T5', 'n/a', 'default privileges for new tables in public (role postgres)',
       case when count(*) = 0 then 'no TRUNCATE for anon/authenticated'
            else count(*)::text || ' entr(y/ies) STILL GRANT TRUNCATE' end
from pg_default_acl d
join pg_namespace n on n.oid = d.defaclnamespace
cross join lateral unnest(d.defaclacl) as acl(entry)
where n.nspname = 'public'
  and d.defaclobjtype = 'r'
  and pg_get_userbyid(d.defaclrole) = 'postgres'
  and (acl.entry::text like 'anon=%D%' or acl.entry::text like 'authenticated=%D%');

-- The other half: the roles that legitimately need TRUNCATE must still have it,
-- or this "fix" has broken the service role instead of the attacker.
insert into proof
select 'T6', 'service role', 'service_role can still TRUNCATE (migrations, seeds, edge functions)',
       case when has_table_privilege('service_role', 'public.projects', 'TRUNCATE')
            then 'ALLOWED - unchanged' else 'BROKEN - service_role lost TRUNCATE' end;

--------------------------------------------------------------------------------
-- S1: every SECURITY DEFINER function in public has a pinned search_path.
--------------------------------------------------------------------------------
insert into proof
select 'S1', 'n/a', 'SECURITY DEFINER functions in public with no pinned search_path',
       case when count(*) = 0 then 'NONE'
            else count(*)::text || ' UNPINNED: ' || string_agg(p.proname, ', ') end
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.prosecdef
  and not exists (
    select 1 from unnest(coalesce(p.proconfig, array[]::text[])) c
    where c like 'search_path=%'
  );

--------------------------------------------------------------------------------
-- P1: the leftover experiment is gone and no table in public has RLS off.
--------------------------------------------------------------------------------
insert into proof
select 'P1', 'n/a', '_naive_probe and its two probe functions',
       case when to_regclass('public._naive_probe') is null
                 and not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                                 where n.nspname = 'public' and p.proname in ('_atomic_probe','_naive_reserve'))
            then 'GONE' else 'STILL PRESENT' end;

insert into proof
select 'P2', 'n/a', 'tables in public with row-level security switched off',
       case when count(*) = 0 then 'NONE' else string_agg(c.relname, ', ') end
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;

--------------------------------------------------------------------------------
-- L1..L6: the legitimate flows that had to keep working.
--------------------------------------------------------------------------------
do $$
declare n int;
begin
  perform set_config('request.jwt.claims',
    '{"sub":"88e9158c-c299-4abf-86e2-4d6c1134d0be","role":"authenticated"}', true);
  set local role authenticated;
  select count(*) into n from public.profiles where id = auth.uid();
  reset role;
  insert into proof values ('L1', 'installer', 'read my own profile',
    case when n = 1 then 'ALLOWED' else 'BROKEN - got ' || n || ' rows' end);
exception when others then
  reset role;
  insert into proof values ('L1', 'installer', 'read my own profile',
    format('BROKEN %s %s', SQLSTATE, SQLERRM));
end $$;

do $$
declare n int;
begin
  perform set_config('request.jwt.claims',
    '{"sub":"88e9158c-c299-4abf-86e2-4d6c1134d0be","role":"authenticated"}', true);
  set local role authenticated;
  select count(*) into n from public.profiles;
  reset role;
  insert into proof values ('L2', 'installer', 'read the crew list',
    case when n = 6 then 'ALLOWED - all 6' else 'CHANGED - got ' || n || ' rows' end);
exception when others then
  reset role;
  insert into proof values ('L2', 'installer', 'read the crew list',
    format('BROKEN %s %s', SQLSTATE, SQLERRM));
end $$;

do $$
declare n int;
begin
  perform set_config('request.jwt.claims',
    '{"sub":"958d3bfc-946e-46b3-a84c-a84d5f586a2e","role":"authenticated","email":"taylor@horizonsolarusa.com"}',
    true);
  set local role authenticated;
  select count(*) into n from public.access_requests;
  reset role;
  insert into proof values ('L3', 'owner', 'read the access-request queue (Admin screen)',
    case when n >= 0 then 'ALLOWED - ' || n || ' rows' end);
exception when others then
  reset role;
  insert into proof values ('L3', 'owner', 'read the access-request queue (Admin screen)',
    format('BROKEN %s %s', SQLSTATE, SQLERRM));
end $$;

do $$
declare updated int;
begin
  perform set_config('request.jwt.claims',
    '{"sub":"958d3bfc-946e-46b3-a84c-a84d5f586a2e","role":"authenticated","email":"taylor@horizonsolarusa.com"}',
    true);
  set local role authenticated;
  update public.access_requests set status = 'approved', decided_at = now()
    where id = (select id from public.access_requests order by created_at limit 1);
  get diagnostics updated = row_count;
  reset role;
  insert into proof values ('L4', 'owner', 'mark an access request approved',
    case when updated = 1 then 'ALLOWED' else 'BROKEN - matched ' || updated || ' rows' end);
exception when others then
  reset role;
  insert into proof values ('L4', 'owner', 'mark an access request approved',
    format('BROKEN %s %s', SQLSTATE, SQLERRM));
end $$;

do $$
declare n int;
begin
  set local role service_role;
  select count(*) into n from public.profiles;
  reset role;
  insert into proof values ('L5', 'service role', 'edge functions read profiles.role on the service key',
    case when n = 6 then 'ALLOWED - all 6' else 'CHANGED - got ' || n || ' rows' end);
exception when others then
  reset role;
  insert into proof values ('L5', 'service role', 'edge functions read profiles.role on the service key',
    format('BROKEN %s %s', SQLSTATE, SQLERRM));
end $$;

do $$
declare r jsonb;
begin
  perform set_config('request.jwt.claims',
    '{"sub":"88e9158c-c299-4abf-86e2-4d6c1134d0be","role":"authenticated"}', true);
  set local role authenticated;
  -- One of the seven functions whose search_path was just pinned. Calling it
  -- with a nonexistent id proves the signature and the pin did not change its
  -- behaviour; it is expected to refuse, not to crash on a missing symbol.
  select to_jsonb(public.undo_install('00000000-0000-0000-0000-000000000000'::uuid, 'proof'))
    into r;
  reset role;
  insert into proof values ('L6', 'installer', 'call a re-pinned function (undo_install)',
    'RAN - returned ' || coalesce(r::text, 'null'));
exception when others then
  reset role;
  insert into proof values ('L6', 'installer', 'call a re-pinned function (undo_install)',
    format('RAN - refused as before: %s %s', SQLSTATE, SQLERRM));
end $$;

--------------------------------------------------------------------------------
-- The roster must be untouched.
--------------------------------------------------------------------------------
insert into proof
select 'R1', 'n/a', 'roster', string_agg(display_name || '=' || role, ', ' order by display_name)
from public.profiles;

insert into proof
select 'R2', 'n/a', 'accounts in auth.users', count(*)::text from auth.users;

select step, actor, attempt, result from proof order by step;

rollback;
