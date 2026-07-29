-- Pin `search_path` on the SECURITY DEFINER functions that were added after the
-- 2026-07-18 hardening.
--
-- A SECURITY DEFINER function runs with the privileges of the role that owns it
-- (`postgres` here), not the caller's. If its `search_path` is not pinned, the
-- caller chooses which schema an unqualified name resolves in, so somebody who
-- can create a schema can put their own `now()` or their own table in front of
-- the real one and have it executed with owner privileges. Pinning the path
-- closes that off.
--
-- `20260718090000_security_hardening.sql` pinned every function that existed
-- then. Seven have been added since and were never pinned:
--
--   assign_issue(uuid, uuid)
--   lead_add_shift(uuid, uuid, uuid, timestamptz, timestamptz, int, text)
--   lead_edit_shift(uuid, uuid, uuid, timestamptz, timestamptz, int, text)
--   open_service_case(uuid, text, text, text)
--   reject_shift(uuid, text)
--   set_issue_fault(uuid, uuid)
--   undo_install(uuid, text)
--
-- Behaviour-neutral. `search_path = public` is what those functions already
-- resolve against in every real call; every schema-qualified reference in them
-- (`auth.uid()` and friends) is unaffected because it is already qualified.
--
-- Written as a loop rather than seven hard-coded ALTERs on purpose: this is the
-- second time this gap has opened, because a list written down in a migration
-- is correct on the day it is written and wrong as soon as the next function is
-- added. The loop pins whatever is unpinned at the moment it runs, and the
-- assertion at the end fails the migration if anything is left.
--
-- Rollback is at the bottom of docs/security-followups-2026-07-29.md.

begin;

do $$
declare
  fn record;
  pinned int := 0;
begin
  for fn in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosecdef
      and not exists (
        select 1 from unnest(coalesce(p.proconfig, array[]::text[])) c
        where c like 'search_path=%'
      )
    order by 1
  loop
    execute format('alter function %s set search_path = public', fn.sig);
    pinned := pinned + 1;
    raise notice 'pinned search_path on %', fn.sig;
  end loop;

  raise notice 'pinned search_path on % SECURITY DEFINER function(s)', pinned;
end $$;

-- Assert the effect. An ALTER that matched nothing looks exactly like one that
-- worked, so the count is checked rather than assumed.
do $$
declare
  unpinned int;
begin
  select count(*) into unpinned
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prosecdef
    and not exists (
      select 1 from unnest(coalesce(p.proconfig, array[]::text[])) c
      where c like 'search_path=%'
    );

  if unpinned <> 0 then
    raise exception
      '% SECURITY DEFINER function(s) in public still have no pinned search_path', unpinned;
  end if;
end $$;

commit;
