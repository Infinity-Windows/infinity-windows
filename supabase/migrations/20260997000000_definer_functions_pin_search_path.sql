-- Pin `search_path` on the SECURITY DEFINER functions that lost it, or never
-- had it, since the last sweep.
--
-- APPLY AFTER 20260996000000 (pooled copies) — the highest number on master
-- and on every open pull request branch on 2026-09-06. Nothing here depends on
-- another migration's shape; number order is the whole ordering rule.
--
-- THE HOLE. A SECURITY DEFINER function runs as its owner (`postgres` here)
-- and ignores row security. If its search_path is not pinned, the CALLER
-- decides which schema an unqualified name resolves in, so a table or a
-- function planted in another schema decides what the owner reads and runs.
-- scripts/advisory-rules.sh states this as LAW_DEFINER; 20260995000000 shows
-- the shape every new function carries: `set search_path = public, pg_temp`.
--
-- WHY IT IS OPEN AGAIN — THE THIRD TIME. 20260718090000 pinned every definer
-- function that existed on its day. 20260729210100 found seven born after it
-- and pinned those, as a loop over the catalog with an assertion that zero
-- were left, on the grounds that a hard-coded list goes stale the moment the
-- next function is born. Both loops were right on their day and blind to
-- what happened next, and what happened next is not births: it is REBUILDS.
-- `create or replace function` rewrites the whole definition, SET clauses
-- included, so a later migration that pastes a function back without the
-- clause — to fix a body, to add a column — silently strips the pin the loop
-- had put on it. `open_service_case` was one of the seven pinned on
-- 2026-07-29 and lost the pin again in 20260982000000; `mint_packages` was
-- born two weeks after that sweep (20260814000000) without the clause and
-- rebuilt without it on 2026-09-04 (20260986000000, line 47). Nothing was
-- looking, because the assertion at the end of 20260729210100 ran once, on
-- its own day, and never again.
--
-- WHAT THIS DOES. `alter function ... set search_path` on each one, by name.
-- ALTER sets the configuration parameter without touching the body, so no
-- function is re-pasted here and nothing about what any of them does changes:
-- `public, pg_temp` is what every one of them already resolves against in
-- every real call, and every schema-qualified reference (`auth.uid()` and
-- friends) is unaffected because it is already qualified. `pg_temp` is named
-- LAST so a temporary table cannot shadow a real one, which is the shape
-- 20260995000000 uses and the earlier loops (`= public` alone) did not.
--
-- WHY BY NAME, WHEN THE LAST SWEEP SAID NOT TO. The loop's argument was that
-- a list is stale the day after it is written. That is true, and the answer
-- is not to hide the list inside a loop nobody can review: it is to keep the
-- catalog question running. scripts/invariants.sql now asks it on every pull
-- request and every night (`definer_unpinned`), scripts/verify_invariants.py
-- lists whatever it finds, and the day production shows the list empty that
-- listing is promoted to a failure — so the NEXT rebuild that drops the clause
-- is red on its own pull request, not found by a repository scan months later.
-- The names below are the live answer to that same question on 2026-09-06
-- (verify-invariants run 34043212162, dispatched on this branch), so a
-- reviewer can see exactly which functions change and check each one against
-- its migration. A file scan had found fifteen; the database said seventeen.
-- The assertion at the bottom still refuses to commit if the list has gone
-- stale between that read and this apply.
--
-- The three found first by reading the last forty commits on master:
--   mint_packages(integer)                          20260986000000:47
--   add_supply(text, text)                          20260986000000:606
--   open_service_case(uuid, text, text, text)       20260982000000:652
-- and the rest, found by asking the database rather than the diff — every one
-- born or rebuilt after 20260729210100 by a create statement that left the
-- clause out:
--   arrive_packages(uuid[], uuid[], uuid, text, jsonb)    20260922000000
--   checkout_packages(uuid[], text, uuid)                 20260825000000
--   count_supply(uuid, numeric)                           20260826000000
--   ensure_package_delivery(text)                         20260814000000
--   job_staging_bay(uuid)                                 20260827000000
--   list_issues()                                         20260730210000
--   merge_mark_spec_extra(uuid, jsonb, text[])            20260828000000
--   save_checkout_reason(uuid, text, integer, boolean)    20260814000000
--   save_studio_project(uuid, text, uuid, jsonb, boolean) 20260815000000
--   set_issue_fault_trade(uuid, text)                     20260816000000
--   stage_packages(uuid[], uuid)                          20260827000000
--   sync_project_mark()                                   20260822000000
--   take_supply(uuid, uuid, numeric, uuid)                20260830000000
--   undo_install(uuid, text)                              20260811050000
-- (`stage_packages(uuid[], uuid)` is the two-argument overload 20260827000000
-- created; 20260901000000 added the three-argument one, pinned, and never
-- dropped this one, so both are live and only this one is open.)
--
-- WHAT IS LEFT ALONE. The `vector` extension's functions, which live in public
-- (20260721020000) and belong to the bootstrap superuser; 20260992000000 says
-- why, and the probe skips them the same way (pg_depend, deptype 'e'). And
-- the functions the two loops pinned to `public` without `pg_temp`: they are
-- pinned, the law is satisfied, and rewriting two hundred SET clauses is a
-- separate decision from closing a hole.
--
-- Rollback: `alter function <sig> reset search_path;` per line, as the bottom
-- of docs/security-followups-2026-07-29.md shows for the 2026-07-29 seven.
-- There is no reason to run it.

begin;

-- ---------------------------------------------------------------------------
-- 1. The pins, one per function, in the order the probe listed them
-- ---------------------------------------------------------------------------
alter function public.add_supply(text, text) set search_path = public, pg_temp;
alter function public.arrive_packages(uuid[], uuid[], uuid, text, jsonb) set search_path = public, pg_temp;
alter function public.checkout_packages(uuid[], text, uuid) set search_path = public, pg_temp;
alter function public.count_supply(uuid, numeric) set search_path = public, pg_temp;
alter function public.ensure_package_delivery(text) set search_path = public, pg_temp;
alter function public.job_staging_bay(uuid) set search_path = public, pg_temp;
alter function public.list_issues() set search_path = public, pg_temp;
alter function public.merge_mark_spec_extra(uuid, jsonb, text[]) set search_path = public, pg_temp;
alter function public.mint_packages(integer) set search_path = public, pg_temp;
alter function public.open_service_case(uuid, text, text, text) set search_path = public, pg_temp;
alter function public.save_checkout_reason(uuid, text, integer, boolean) set search_path = public, pg_temp;
alter function public.save_studio_project(uuid, text, uuid, jsonb, boolean) set search_path = public, pg_temp;
alter function public.set_issue_fault_trade(uuid, text) set search_path = public, pg_temp;
alter function public.stage_packages(uuid[], uuid) set search_path = public, pg_temp;
alter function public.sync_project_mark() set search_path = public, pg_temp;
alter function public.take_supply(uuid, uuid, numeric, uuid) set search_path = public, pg_temp;
alter function public.undo_install(uuid, text) set search_path = public, pg_temp;

-- ---------------------------------------------------------------------------
-- 2. Prove it, in the same transaction, and refuse to commit otherwise
-- ---------------------------------------------------------------------------
-- The same question scripts/invariants.sql asks as `definer_unpinned`. An
-- ALTER that matched nothing looks exactly like one that worked, and a
-- function rebuilt between the read above and this apply would be missing
-- from the list, so the count is checked rather than assumed. A failure here
-- names the stragglers: add a line for each in section 1.
do $$
declare
  stragglers text;
begin
  select string_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', ', '
                    order by p.proname)
    into stragglers
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prosecdef
    and not exists (
      select 1 from unnest(coalesce(p.proconfig, array[]::text[])) c
      where c like 'search_path=%'
    )
    and not exists (
      select 1 from pg_depend d
      where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e'
    );

  if stragglers is not null then
    raise exception
      'SECURITY DEFINER function(s) in public still have no pinned search_path: %. Add an alter function line for each to this migration.',
      stragglers;
  end if;
end $$;

commit;
