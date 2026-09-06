-- Stop a signed-out visitor calling any function in schema public.
--
-- THE INCIDENT. The live security probe (scripts/verify_invariants.py, PR #546)
-- ran against production for the first time on 2026-09-06 and listed 152
-- SECURITY DEFINER functions in public that the `anon` role may EXECUTE —
-- nearly every RPC the app has, finish_unit and set_project_status included.
-- Nobody granted any of them. Supabase ships an ALTER DEFAULT PRIVILEGES rule
-- for role postgres in schema public that hands EXECUTE on every new function
-- to anon, authenticated and service_role, on top of Postgres's own default
-- that grants EXECUTE to PUBLIC. So each migration that creates a function has
-- to remember to take it back, and most did not.
-- docs/security-followups-2026-07-29.md §6b measured 31 of these on
-- 2026-07-29 and wrote this fix down; by September the count had grown to 152
-- because the default kept granting.
--
-- THE RULE is 20260729200000's (section 1) and 20260729200100's: a function is
-- executable by authenticated (or by service_role alone), never by anon — and
-- the revoke must name anon as well as PUBLIC, because the direct grant from
-- the default rule survives a revoke from PUBLIC alone. This migration applies
-- that rule to every function at once and, like 20260729210000 did for
-- TRUNCATE, removes it from the default so the next `create function` does not
-- quietly undo it.
--
-- WHY ONE SWEEP IS SAFE — every signed-out path was read on 2026-09-05:
--   * The GC portal (app/src/pages/GcPage.tsx) talks only to the gc-link edge
--     function, which calls gc_link_open/answer/say on the service-role key.
--   * An access request (app/src/lib/install/api.ts) is a plain INSERT into
--     access_requests under the `anon can request` policy, whose WITH CHECK is
--     (true) — no function in it. Every other policy in public and storage is
--     `to authenticated`, so no policy expression runs a function as anon.
--   * Sign-in and password reset are GoTrue calls; nothing in public.
--   * Crew-invite redemption and access-request approval are edge functions on
--     the service-role key (redeem-crew-invite, approve-access-request).
--   * vault_pin_is_set() was the one function ever granted to anon on purpose
--     (20260721030000), but that migration's own comment says "any signed-in
--     user", and its only caller (app/src/lib/knowledge.ts) is the Knowledge
--     page, which sits behind the login. It goes too.
--   * Triggers fire without an EXECUTE check on the caller, so the anon insert
--     above still runs its triggers.
-- So the keep-list is EMPTY. If a signed-out flow ever needs a function, add
-- it to section 4 here AND to ANON_FUNCTIONS_ALLOWED in
-- scripts/verify_invariants.py — the probe fails on anything else.
--
-- WHAT IS LEFT ALONE: the 93 functions of the `vector` extension, which
-- 20260721020000 installed into public (no `with schema extensions`). They
-- are pure arithmetic — distances, casts, the index handlers — executable by
-- PUBLIC in every install of pgvector on earth, and owned by the bootstrap
-- superuser because the extension is trusted, so postgres could not revoke on
-- them if it wanted to. Every statement below skips anything that belongs to
-- an extension (pg_depend, deptype 'e'), and the probe asks the same question
-- with the same exclusion.
--
-- WHAT DOES NOT CHANGE: what authenticated and service_role can call.
-- Stripping PUBLIC could take EXECUTE away from a role that only ever held it
-- that way, so section 2 records who could run what, section 3 puts back by
-- name anything that went missing, and section 6 refuses to commit if either
-- role lost a function.
--
-- Rehearsed on 2026-09-05 against a throwaway Postgres 15 carrying Supabase's
-- roles and both of its default-privilege rules: the sweep, the re-grant, a
-- function created afterwards (anon: no; authenticated and service_role:
-- yes), and a second run of this file (no-op).
--
-- Idempotent and safe to re-run.

begin;

-- ---------------------------------------------------------------------------
-- 1. Refuse to run against a schema we cannot act on
-- ---------------------------------------------------------------------------
-- REVOKE needs the owner (or a member of it). Migrations run as postgres, and
-- every function this repo creates is owned by postgres; a function owned by a
-- role postgres cannot act for would abort the sweep half-way with a cryptic
-- 42501. Say which one instead, before anything is changed. Extension members
-- are the known case (see the header) and are not the sweep's business.
create temp table _ours on commit drop as
select p.oid, p.oid::regprocedure as sig, p.proname, p.proowner
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and not exists (
    select 1 from pg_depend d
    where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e'
  );

do $$
declare
  stranger text;
  skipped text;
begin
  select string_agg(proname || ' (owner ' || pg_get_userbyid(proowner) || ')', ', ')
    into stranger
  from _ours
  where not pg_has_role(current_user, proowner, 'USAGE');
  if stranger is not null then
    raise exception
      'refusing: function(s) in public owned by a role this migration cannot act for: %', stranger;
  end if;

  select string_agg(e.extname || ' (' || cnt || ')', ', ')
    into skipped
  from (
    select d.refobjid, count(*) as cnt
    from pg_depend d
    join pg_proc p on p.oid = d.objid
    join pg_namespace n on n.oid = p.pronamespace
    where d.classid = 'pg_proc'::regclass and d.deptype = 'e' and n.nspname = 'public'
    group by d.refobjid
  ) x
  join pg_extension e on e.oid = x.refobjid;
  raise notice 'extension functions in public left as they are: %', coalesce(skipped, 'none');
end $$;

-- ---------------------------------------------------------------------------
-- 2. Remember who could execute what, before anything changes
-- ---------------------------------------------------------------------------
-- The two roles that call functions in public and must not lose one: a
-- signed-in phone (authenticated) and the edge functions and sweeps
-- (service_role). authenticator is deliberately absent — PostgREST connects
-- as it and SET ROLEs to anon or authenticated, so it "has" EXECUTE only
-- through anon and must not be handed a direct grant to make up for the
-- revoke. The platform roles (supabase_auth_admin and friends) call nothing
-- in public: this project has no auth hooks, and Supabase's own docs have a
-- hook's migration grant that role by name.
create temp table _exec_before on commit drop as
select r.rolname, o.oid as fn_oid
from pg_roles r
cross join _ours o
where r.rolname in ('authenticated', 'service_role')
  and has_function_privilege(r.rolname, o.oid, 'EXECUTE');

-- ---------------------------------------------------------------------------
-- 3. The revoke, and the re-grant that keeps it from hurting anyone else
-- ---------------------------------------------------------------------------
-- One routine at a time rather than `all routines in schema public`, so the
-- extension's are never touched. ROUTINE covers functions, aggregates and
-- procedures alike. PUBLIC has to go as well as anon:
-- has_function_privilege('anon', …) — and PostgREST — see a grant to PUBLIC
-- as a grant to anon.
do $$
declare
  rec record;
  n int := 0;
begin
  for rec in select sig from _ours loop
    execute format('revoke execute on routine %s from public, anon', rec.sig);
  end loop;
  for rec in
    select b.rolname, b.fn_oid, b.fn_oid::regprocedure as sig
    from _exec_before b
    where not has_function_privilege(b.rolname, b.fn_oid, 'EXECUTE')
  loop
    execute format('grant execute on routine %s to %I', rec.sig, rec.rolname);
    n := n + 1;
  end loop;
  raise notice '% EXECUTE grant(s) that had rested on PUBLIC were re-issued by name', n;
end $$;

-- ---------------------------------------------------------------------------
-- 4. The keep-list: functions a signed-out caller genuinely needs
-- ---------------------------------------------------------------------------
-- None today (see the header). The form, should one arrive, mirrored in
-- ANON_FUNCTIONS_ALLOWED in scripts/verify_invariants.py:
--   grant execute on function public.<name>(<args>) to anon;

-- ---------------------------------------------------------------------------
-- 5. The source of the pattern
-- ---------------------------------------------------------------------------
-- Without this the very next `create function` in a migration hands EXECUTE
-- back to anon and the sweep above silently decays. Only the rules owned by
-- postgres are touched, for the reason 20260729210000 gives: everything this
-- repo creates is created as postgres (all 166 functions, every one in
-- public), and the second rule in public, owned by supabase_admin, cannot be
-- altered from a migration (42501) and governs nothing this project makes.
--
-- Two statements, because a per-schema default is ADDED to the global one and
-- cannot subtract from it. Supabase's per-schema rule is where anon's direct
-- grant lives, so it is revoked there. PUBLIC's EXECUTE comes from Postgres's
-- own built-in default, which only a rule with no IN SCHEMA can override —
-- the rehearsal proved a per-schema `revoke ... from public` changes nothing.
-- The global rule reaches functions postgres creates in any schema, which for
-- this repo means public and nothing else. authenticated and service_role
-- keep their per-schema grant, so a new function is callable by a signed-in
-- user unless its migration says otherwise — the same shape as before, minus
-- the stranger.
alter default privileges for role postgres in schema public
  revoke execute on functions from anon;
alter default privileges for role postgres
  revoke execute on functions from public;

-- ---------------------------------------------------------------------------
-- 6. Prove it, in the same transaction, and refuse to commit otherwise
-- ---------------------------------------------------------------------------
-- A revoke that matched nothing exits 0 exactly like one that worked, so "no
-- error" is not evidence.
do $$
declare
  still_open text;
  lost text;
  default_still_grants boolean;
begin
  -- Nobody signed out can call anything of ours.
  select string_agg(proname, ', ' order by proname) into still_open
  from _ours
  where has_function_privilege('anon', oid, 'EXECUTE');
  if still_open is not null then
    raise exception 'anon can still execute: %', still_open;
  end if;

  -- Nobody else lost a thing.
  select string_agg(b.rolname || ' -> ' || b.fn_oid::regprocedure::text, ', ') into lost
  from _exec_before b
  where not has_function_privilege(b.rolname, b.fn_oid, 'EXECUTE');
  if lost is not null then
    raise exception 'authenticated or service_role lost EXECUTE; refusing to commit: %', lost;
  end if;

  -- The default for new functions no longer reaches anon. Asked the direct
  -- way — create one and look — because the answer is the merge of two rules
  -- and Postgres's built-in default, and reading pg_default_acl by eye got
  -- that wrong once already (scripts/invariants.sql carries the read-only
  -- formula the nightly probe uses).
  execute 'create function public._anon_probe_20260992() returns void language sql as $f$ select 1 $f$';
  select has_function_privilege('anon', 'public._anon_probe_20260992()', 'EXECUTE')
    into default_still_grants;
  execute 'drop function public._anon_probe_20260992()';
  if default_still_grants then
    raise exception
      'a function created now is still executable by anon: the default privileges for role postgres still grant EXECUTE to anon or PUBLIC';
  end if;

  raise notice 'EXECUTE revoked from anon and PUBLIC on every routine of ours in schema public, and removed from the default for new functions';
end $$;

commit;
