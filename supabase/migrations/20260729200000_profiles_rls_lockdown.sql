-- Close the profiles privilege-escalation hole.
--
-- BEFORE: public.profiles carried exactly one RLS policy —
--     "authenticated full access"  FOR ALL  USING (true)  WITH CHECK (true)
-- so every signed-in user had unrestricted SELECT / INSERT / UPDATE / DELETE on
-- every row. The 2026-07-18 hardening added a BEFORE UPDATE trigger that stops
-- a direct `update profiles set role='owner'`, but a trigger on UPDATE does not
-- fire on DELETE or INSERT, so an installer could still escalate with:
--
--     delete from profiles where id = auth.uid();
--     insert into profiles(id, display_name, role) values (auth.uid(), 'me', 'owner');
--
-- That was verified against production on 2026-07-29 (in a rolled-back
-- transaction) and it SUCCEEDED. The same policy also let any installer read
-- and overwrite every other user's plain-text `pin`, rename any crew member,
-- and delete the owner's profile outright.
--
-- AFTER: read stays open (the app genuinely needs a crew directory — see
-- below), and every write is scoped. Three independent layers, so no single
-- mistake re-opens the hole:
--
--   1. Column privileges  — `role` and `pin` are revoked from anon and
--      authenticated, so a direct write to either fails with 42501 before RLS
--      is even consulted. This is the strongest control available: it cannot be
--      re-opened by a permissive policy.
--   2. RLS policies       — per-command, replacing the blanket ALL policy.
--      INSERT is own-row only, UPDATE is own-row or foreman+, DELETE is
--      supervisor+.
--   3. Triggers           — BEFORE UPDATE *and* BEFORE INSERT guards on `role`,
--      which also cover the SECURITY DEFINER RPC path (functions run as the
--      table owner and so bypass both layers above).
--
-- Why not column-level RLS: Postgres RLS is row-level only; a policy cannot say
-- "this UPDATE may touch every column except role". Column GRANTs are the
-- native way to express that, and a trigger is the native way to express
-- "…unless the caller is a supervisor", which GRANTs cannot express because
-- they are static. Hence both, per the layering above.
--
-- WHAT DELIBERATELY STAYS OPEN, and why:
--   * SELECT on all rows for authenticated. Twelve screens read other people's
--     rows (roster, dispatch board, assignment pickers, driver picker, trip
--     crew, points leaderboard, "who is clocked in", project chat roster,
--     timecards, tools, training, vehicles), and PostgREST foreign-key embeds
--     such as `time_shifts.profiles(display_name)` resolve against the base
--     table, so a view cannot stand in for them. With `pin` unreachable, the
--     remaining columns are a staff directory: name, role, skill tier, on-site
--     flag. `public.crew_directory` below is the narrow surface new code should
--     use; the table grant exists for the embeds.
--   * Service-role callers. Four edge functions (vault-config, ingest-knowledge,
--     ask, and the push sender) read profiles.role on the service-role key,
--     which bypasses RLS entirely. Nothing here touches that path, and the
--     `auth.uid() is null` branch in each trigger keeps migrations and seeds
--     working.
--
-- Idempotent and safe to re-run.


-- ---------------------------------------------------------------------------
-- 1. role_rank(): one source of truth for the ladder
-- ---------------------------------------------------------------------------
-- Mirrors roleRank() in app/src/lib/install/types.ts exactly, including the
-- legacy aliases, so a policy and the UI can never disagree about what a role
-- outranks. Unknown or NULL is the installer floor (0) — a missing or legacy
-- role can never over-grant.

create or replace function public.role_rank(p_role text)
returns int
language sql
immutable
set search_path = public
as $$
  select case p_role
    when 'owner'      then 3
    when 'big_boss'   then 3   -- legacy alias for owner
    when 'supervisor' then 2
    when 'admin'      then 2   -- legacy alias for supervisor
    when 'foreman'    then 1
    when 'lead'       then 1   -- legacy alias for foreman
    when 'installer'  then 0
    else 0                     -- unknown / null: installer floor
  end;
$$;

comment on function public.role_rank(text) is
  'Rank of a crew role (installer 0, foreman 1, supervisor 2, owner 3). Mirrors roleRank() in app/src/lib/install/types.ts. Unknown/NULL ranks 0.';

-- The caller''s own rank. SECURITY DEFINER for one specific reason: a policy on
-- profiles that reads profiles would recurse infinitely under RLS. Running as
-- the owner reads the row directly and terminates. It exposes only an integer
-- about the caller''s own account, so it leaks nothing.
create or replace function public.my_role_rank()
returns int
language sql
stable
security definer
set search_path = public
as $$
  select public.role_rank((select role from public.profiles where id = auth.uid()));
$$;

comment on function public.my_role_rank() is
  'Rank of the calling user''s own role. SECURITY DEFINER to break RLS recursion when used inside a profiles policy.';

-- Supabase's ALTER DEFAULT PRIVILEGES grants EXECUTE on new public functions to
-- anon, authenticated and service_role directly, so revoking from PUBLIC is not
-- enough — anon has to be named. Every function this migration creates is
-- revoked from anon explicitly, then granted only to the roles that need it.
revoke all on function public.role_rank(text) from public, anon;
revoke all on function public.my_role_rank() from public, anon;
grant execute on function public.role_rank(text) to authenticated, service_role;
grant execute on function public.my_role_rank() to authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 2. Column privileges: role and pin become unwritable / unreadable directly
-- ---------------------------------------------------------------------------
-- Postgres will not let you subtract a column from a table-level grant — while
-- `GRANT UPDATE ON profiles` stands, `REVOKE UPDATE (role)` is a no-op. So the
-- table-level SELECT/INSERT/UPDATE grants are dropped and re-granted column by
-- column. Anything absent from these lists (`pin` today, `pin_hash` after the
-- next migration, and any column added later) is unreachable by default, which
-- is the behaviour we want from a table that holds a credential.
--
-- TRUNCATE goes too: it is not subject to row-level security at all, so leaving
-- it granted leaves a way to empty the table past every policy below. (Supabase
-- grants ALL on every public table to anon/authenticated by default; this
-- migration fixes profiles. The rest is recorded as follow-up work in
-- docs/profiles-security-2026-07-29.md.)

revoke select, insert, update, truncate, trigger on table public.profiles
  from anon, authenticated;

-- Readable: the staff directory. `pin` is deliberately absent — it is a
-- credential, reachable only through the SECURITY DEFINER PIN functions.
grant select (id, display_name, skill_level, role, active, created_at, updated_at)
  on table public.profiles to authenticated;

-- Insertable on first sign-in (ensureMyProfile). `role` is absent, so a new
-- account always lands on the 'installer' column default.
grant insert (id, display_name, skill_level, active, updated_at)
  on table public.profiles to authenticated;

-- Updatable: the fields the Roster screen edits. `role` is absent — it may only
-- change through set_profile_role() / claim_owner_bootstrap(), which run as the
-- table owner.
grant update (display_name, skill_level, active, updated_at)
  on table public.profiles to authenticated;

-- DELETE has no column granularity; it is scoped by the RLS policy below.
grant delete on table public.profiles to authenticated;

-- anon has no policy on profiles, so RLS already denies it everything. Drop the
-- grants as well so the table is not one accidental `to anon` policy away from
-- being world-readable.
revoke all on table public.profiles from anon;


-- ---------------------------------------------------------------------------
-- 3. RLS policies: per-command, replacing the blanket ALL policy
-- ---------------------------------------------------------------------------

drop policy if exists "authenticated full access" on public.profiles;
drop policy if exists profiles_select_authenticated on public.profiles;
drop policy if exists profiles_insert_self on public.profiles;
drop policy if exists profiles_update_self_or_lead on public.profiles;
drop policy if exists profiles_delete_supervisor on public.profiles;

alter table public.profiles enable row level security;

-- Read: the crew directory. `pin` is unreachable by grant (above), so this is
-- name / role / skill / active only.
create policy profiles_select_authenticated on public.profiles
  for select to authenticated
  using (true);

-- Create: your own row on first sign-in (ensureMyProfile), or anyone's row if
-- you are a supervisor or owner.
create policy profiles_insert_self on public.profiles
  for insert to authenticated
  with check (id = auth.uid() or public.my_role_rank() >= 2);

-- Update: your own row, or anyone's if you are foreman or above — which is what
-- the Roster screen already offers (skill tier, on-site flag, display name).
-- `role` is excluded from this by the column revoke above.
create policy profiles_update_self_or_lead on public.profiles
  for update to authenticated
  using (id = auth.uid() or public.my_role_rank() >= 1)
  with check (id = auth.uid() or public.my_role_rank() >= 1);

-- Delete: supervisor or owner only. This is the step that closes the
-- delete-then-reinsert escalation; nothing in the app deletes a profile.
create policy profiles_delete_supervisor on public.profiles
  for delete to authenticated
  using (public.my_role_rank() >= 2);


-- ---------------------------------------------------------------------------
-- 4. Triggers: role changes, including through SECURITY DEFINER functions
-- ---------------------------------------------------------------------------
-- The column revoke stops a direct client write. These triggers are the layer
-- that still applies when the write arrives through a function running as the
-- table owner, which is how every legitimate role change happens.

create or replace function public.trg_guard_profile_role_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text;
begin
  -- Service role / no JWT: migrations, seeds, edge functions on the service
  -- key. RLS and the grants above already keep anon out.
  if auth.uid() is null then
    return new;
  end if;

  -- Supervisor or owner: the sanctioned path (set_profile_role).
  if public.my_role_rank() >= 2 then
    return new;
  end if;

  -- Founder bootstrap, narrowed. The previous version let either founder email
  -- make ANY role change to ANY row; this allows exactly one thing — that
  -- account promoting itself to owner on first sign-in, which is how the very
  -- first owner comes to exist. Reachable only via claim_owner_bootstrap().
  v_email := lower(coalesce(auth.jwt() ->> 'email', ''));
  if new.id = auth.uid()
     and new.role = 'owner'
     and v_email in ('ammon@horizonsolarusa.com', 'isaacammonbarlow@gmail.com')
  then
    return new;
  end if;

  raise exception
    'only a supervisor or owner can change a role (blocked: % -> % on %)',
    old.role, new.role, old.id
    using errcode = '42501';
end;
$$;

revoke all on function public.trg_guard_profile_role_change() from public, anon, authenticated;

drop trigger if exists guard_profile_role_change on public.profiles;
create trigger guard_profile_role_change
  before update on public.profiles
  for each row
  when (old.role is distinct from new.role)
  execute function public.trg_guard_profile_role_change();

-- The escalation path the UPDATE trigger could never see.
create or replace function public.trg_guard_profile_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text;
begin
  if auth.uid() is null then
    return new;
  end if;

  if new.id <> auth.uid() then
    if public.my_role_rank() < 2 then
      raise exception 'you may only create your own profile'
        using errcode = '42501';
    end if;
    return new;
  end if;

  v_email := lower(coalesce(auth.jwt() ->> 'email', ''));
  if new.role is distinct from 'installer'
     and v_email not in ('ammon@horizonsolarusa.com', 'isaacammonbarlow@gmail.com')
  then
    raise exception
      'a new profile starts as installer; a supervisor or owner assigns the role'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

revoke all on function public.trg_guard_profile_insert() from public, anon, authenticated;

drop trigger if exists guard_profile_insert on public.profiles;
create trigger guard_profile_insert
  before insert on public.profiles
  for each row
  execute function public.trg_guard_profile_insert();


-- ---------------------------------------------------------------------------
-- 5. The sanctioned role-change RPC
-- ---------------------------------------------------------------------------
-- Was: any caller whose own role was not literally 'installer' — so a foreman
-- could hand out owner. Now supervisor+ only, and nobody may promote themselves
-- above their own rank.
--
-- The return type changes from `profiles` (the whole row, which included the
-- plain-text pin, and which column GRANTs do not protect because the function
-- runs as the owner) to a narrow jsonb of the safe fields. app/src/lib/install/
-- api.ts already ignores the result.

drop function if exists public.set_profile_role(uuid, text);

create function public.set_profile_role(p_target uuid, p_role text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rank int := public.my_role_rank();
  v_row  public.profiles;
begin
  if p_role not in ('installer', 'foreman', 'supervisor', 'owner') then
    raise exception 'invalid role %', p_role using errcode = '22023';
  end if;

  if v_rank < 2 then
    raise exception 'only a supervisor or owner can change roles'
      using errcode = '42501';
  end if;

  -- No self-promotion above your own rank: a supervisor cannot make themselves
  -- the owner. Lateral and downward self-changes stay allowed.
  if p_target = auth.uid() and public.role_rank(p_role) > v_rank then
    raise exception 'you cannot promote yourself above your own role'
      using errcode = '42501';
  end if;

  update public.profiles
     set role = p_role, updated_at = now()
   where id = p_target
  returning * into v_row;

  if v_row.id is null then
    raise exception 'no such profile %', p_target using errcode = 'P0002';
  end if;

  return jsonb_build_object(
    'id', v_row.id,
    'display_name', v_row.display_name,
    'role', v_row.role,
    'skill_level', v_row.skill_level,
    'active', v_row.active,
    'updated_at', v_row.updated_at
  );
end;
$$;

comment on function public.set_profile_role(uuid, text) is
  'Supervisor/owner-only role change. The only client-reachable way to write profiles.role, which is revoked from anon and authenticated at the column level.';

revoke all on function public.set_profile_role(uuid, text) from public, anon;
grant execute on function public.set_profile_role(uuid, text) to authenticated;


-- ---------------------------------------------------------------------------
-- 6. Founder bootstrap, as an explicit RPC instead of a client-side write
-- ---------------------------------------------------------------------------
-- app/src/lib/install/api.ts used to promote the two founder emails to owner by
-- writing profiles.role straight from the browser. With that column revoked it
-- needs a server-side path, and an explicit named RPC is a far better record of
-- the exception than a magic string in the client. It grants owner to those two
-- addresses and to nothing else; the email comes from the verified JWT, not
-- from an argument.

create or replace function public.claim_owner_bootstrap()
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text;
begin
  if auth.uid() is null then
    return false;
  end if;

  v_email := lower(coalesce(auth.jwt() ->> 'email', ''));
  if v_email not in ('ammon@horizonsolarusa.com', 'isaacammonbarlow@gmail.com') then
    return false;
  end if;

  update public.profiles
     set role = 'owner',
         display_name = 'Ammon',
         active = true,
         updated_at = now()
   where id = auth.uid()
     and (role <> 'owner' or display_name <> 'Ammon' or not active);

  return true;
end;
$$;

comment on function public.claim_owner_bootstrap() is
  'First-run bootstrap: promotes the calling user to owner if and only if their verified JWT email is a founder address. Returns false for everyone else.';

revoke all on function public.claim_owner_bootstrap() from public, anon;
grant execute on function public.claim_owner_bootstrap() to authenticated;


-- ---------------------------------------------------------------------------
-- 7. crew_directory: the narrow cross-user surface
-- ---------------------------------------------------------------------------
-- The safe columns only, so new code has something to read that can never widen
-- into a credential. security_invoker keeps the caller's RLS in force rather
-- than the view owner's.

drop view if exists public.crew_directory;
create view public.crew_directory
  with (security_invoker = true)
  as select id, display_name, role, skill_level, active
     from public.profiles;

comment on view public.crew_directory is
  'Safe cross-user crew list: id, display_name, role, skill_level, active. Prefer this over selecting from profiles directly.';

-- Default privileges hand a new view every privilege to anon and authenticated,
-- so start from nothing and grant back only SELECT. (security_invoker means a
-- write through the view would be refused by the base table anyway; this makes
-- the intent visible instead of incidental.)
revoke all on public.crew_directory from public, anon, authenticated;
grant select on public.crew_directory to authenticated;
