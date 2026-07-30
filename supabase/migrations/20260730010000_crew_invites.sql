-- Let an owner hand out logins himself, without re-opening public signup.
--
-- THE PROBLEM. The app is live and self-signup is off (`disable_signup: true`,
-- confirmed against the production auth settings on 2026-07-29), which is
-- correct — anyone with an email address used to be able to walk into the crew
-- directory. But it left exactly one person with a login and no way for the
-- owner to add a second without a developer opening the Supabase dashboard. The
-- existing `access_requests` path only works in the other direction: the new
-- person has to find the app and ask first, then be approved. An owner standing
-- next to a new hire needs to push, not wait.
--
-- WHAT THIS ADDS. One table of outstanding invitations. An invite names a person
-- and a role, carries a high-entropy code that is stored only as a slow hash,
-- expires after 7 days, and may be redeemed exactly once. Redeeming it creates
-- the login. See supabase/functions/_shared/crewInvites.ts for the rules (it is
-- the same module the browser uses, so the two cannot disagree) and
-- supabase/functions/manage-crew-access/ + redeem-crew-invite/ for enforcement.
--
-- WHY AN INVITE IS NOT A BACK DOOR INTO PUBLIC SIGNUP. `disable_signup` stays
-- on and nothing here touches it. The only way an account gets created is an
-- edge function running on the service-role key, and it will only do so when
-- handed an unexpired, unredeemed, unrevoked code that a supervisor or owner
-- minted. A visitor with no code is in exactly the position they are in today.
--
-- THE ESCALATION RULE, WHICH IS THE WHOLE POINT. On 2026-07-29 a hole was closed
-- where any signed-in user could promote themselves to owner
-- (20260729200000_profiles_rls_lockdown.sql). An invite is that same power in a
-- friendlier shape — "create an account at role X" — so it carries the same
-- ladder rule: the caller must be supervisor or above, and may never name a role
-- above their own rank. Enforced server-side from `profiles.role`, never from
-- anything the client sends. The client-side copy of the rule exists only to
-- grey out a button.
--
-- WHAT THIS TABLE DELIBERATELY CANNOT DO:
--   * No client role may write it. There is no INSERT, UPDATE or DELETE grant
--     for `anon` or `authenticated` at all, so the only writer is the
--     service-role key inside the two edge functions. A permissive policy added
--     later still could not write, because the grant is absent.
--   * No client role may read `code_hash`, by the same column-grant technique
--     the profiles lockdown used for `pin_hash`. A supervisor can see that an
--     invite for "Mike" is outstanding; nobody can read the material that
--     redeems it.
--
-- Idempotent and safe to re-run.


-- ---------------------------------------------------------------------------
-- 1. The table
-- ---------------------------------------------------------------------------

create table if not exists public.crew_invites (
  id uuid primary key default gen_random_uuid(),

  -- PBKDF2-SHA256, 100k iterations, fixed salt (see hashInviteCode). Unique so
  -- the astronomically-unlikely duplicate code is a constraint error rather
  -- than two rows one code can open.
  code_hash text not null unique,

  -- Who this is for, as the owner typed it. Shown on the roster afterwards, so
  -- the crew list reads "Mike Alvarez" rather than the local part of an email.
  display_name text not null,

  -- The login they will type. Frequently an address minted by the app
  -- (…@crew.infinitywindows.app) because a lot of installers have no email they
  -- can recall on a job site. It is a USERNAME: this project has no SMTP sender,
  -- so nothing is ever sent to it.
  email text not null,

  -- The role the account lands on. NOT a request — a decision already
  -- authorised against the inviter's own rank.
  role text not null
    check (role in ('installer', 'foreman', 'supervisor', 'owner')),

  -- NULL: this code creates a new account.
  -- Set:  this code re-issues a login for an account that already exists, i.e.
  --       the "forgot my password" path for a crew member who cannot receive
  --       a reset email (nobody here can). Guarded by the same ladder rule, or
  --       it would be an account-takeover button.
  target_user_id uuid references auth.users (id) on delete cascade,

  invited_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),

  -- Not nullable and not defaulted: an invite with no expiry is a password in a
  -- text message forever, so the writer is forced to say when it dies.
  expires_at timestamptz not null,

  redeemed_at timestamptz,
  redeemed_user_id uuid references auth.users (id) on delete set null,

  revoked_at timestamptz,
  revoked_by uuid references auth.users (id) on delete set null
);

comment on table public.crew_invites is
  'Outstanding crew invitations. One code, one account, seven days. The code is stored only as a slow deterministic hash and is unreadable by every client role; all writes go through the manage-crew-access / redeem-crew-invite edge functions on the service-role key.';
comment on column public.crew_invites.code_hash is
  'PBKDF2-SHA256(code, fixed salt, 100k) — see hashInviteCode() in supabase/functions/_shared/crewInvites.ts. No client role holds any privilege on this column.';
comment on column public.crew_invites.target_user_id is
  'NULL for a new account. Set when the code re-issues a login for an existing user (the no-email password-reset path), which is why it is gated by the same rank rule as inviting.';

-- The redemption lookup: by hash, and only ever for a live row.
create index if not exists crew_invites_code_hash_idx
  on public.crew_invites (code_hash);

-- The owner's list: newest first, outstanding ones first.
create index if not exists crew_invites_open_idx
  on public.crew_invites (created_at desc)
  where redeemed_at is null and revoked_at is null;


-- ---------------------------------------------------------------------------
-- 2. Privileges: readable by supervisors, writable by nobody
-- ---------------------------------------------------------------------------
-- Supabase grants ALL on every new public table to anon and authenticated, so
-- start by taking it all back. Everything below is added deliberately.
--
-- TRUNCATE is included in the revoke for the reason
-- 20260729210000_revoke_truncate_from_clients.sql spells out: it is not subject
-- to row-level security at all, so leaving it granted leaves a way to empty the
-- table past every policy.

revoke all on table public.crew_invites from anon, authenticated;

-- Read: the fields the "Crew access" screen shows. `code_hash` is absent, so it
-- is unreachable even for the owner — exactly as `pin_hash` is on profiles.
-- Which rows, is decided by the policy below.
grant select (
  id, display_name, email, role, target_user_id, invited_by,
  created_at, expires_at, redeemed_at, redeemed_user_id, revoked_at, revoked_by
) on table public.crew_invites to authenticated;

-- No INSERT, UPDATE or DELETE grant is issued to any client role, deliberately.
-- Creating, revoking and redeeming all happen inside an edge function on the
-- service-role key, which bypasses RLS. Absent grants beat any policy: someone
-- who later adds a permissive `for all using (true)` policy still cannot write.

alter table public.crew_invites enable row level security;

drop policy if exists crew_invites_select_supervisor on public.crew_invites;

-- Only the people who may hand out access may see who has been offered it. An
-- installer has no business knowing that a supervisor invite is outstanding.
create policy crew_invites_select_supervisor on public.crew_invites
  for select to authenticated
  using (public.my_role_rank() >= 2);


-- ---------------------------------------------------------------------------
-- 3. Belt-and-braces: the role on an invite cannot outrank its author
-- ---------------------------------------------------------------------------
-- The edge function already refuses this, reading the caller's role from
-- profiles. This trigger is the layer that still holds if that check is ever
-- edited out, or if a future code path writes the table directly on the
-- service-role key: the escalation is refused by the database itself.
--
-- It cannot use my_role_rank(), because the writer is the service role and
-- auth.uid() is NULL there. It compares against the stored role of the account
-- named in `invited_by`, which the function sets from the verified JWT and the
-- client never supplies.

create or replace function public.trg_guard_crew_invite_rank()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inviter_rank int;
begin
  -- A seed or migration with no author recorded. Nothing to compare against.
  if new.invited_by is null then
    return new;
  end if;

  select public.role_rank(role) into v_inviter_rank
    from public.profiles
   where id = new.invited_by;

  -- No profile for the author: treat as the installer floor rather than as
  -- permission. A missing row must never be a way past the check.
  v_inviter_rank := coalesce(v_inviter_rank, 0);

  if v_inviter_rank < 2 then
    raise exception
      'only a supervisor or owner can create an invite (author rank %)',
      v_inviter_rank
      using errcode = '42501';
  end if;

  if public.role_rank(new.role) > v_inviter_rank then
    raise exception
      'an invite cannot grant a role above its author (% > rank %)',
      new.role, v_inviter_rank
      using errcode = '42501';
  end if;

  return new;
end;
$$;

revoke all on function public.trg_guard_crew_invite_rank()
  from public, anon, authenticated;

drop trigger if exists guard_crew_invite_rank on public.crew_invites;
create trigger guard_crew_invite_rank
  before insert or update of role, invited_by on public.crew_invites
  for each row
  execute function public.trg_guard_crew_invite_rank();


-- ---------------------------------------------------------------------------
-- 4. Recording that someone's access was taken away
-- ---------------------------------------------------------------------------
-- `profiles.active` already exists but means "on site today" — the Roster
-- screen renders it as "On site / Off today" and a foreman toggles it daily. It
-- is availability, not permission, and overloading it would make "Mike quit"
-- indistinguishable from "Mike is off sick".
--
-- The revocation itself is a ban on the auth user, applied by the edge function
-- (see manage-crew-access). This column is so the app can SAY so: a login that
-- has been switched off looks identical to a working one from the database's
-- point of view.
--
-- Why ban rather than delete: a departed installer is still the author of real
-- production history — time shifts, installs, QC sign-offs, chat messages, the
-- Black Desert job. Deleting the auth user would cascade or orphan that record.
-- Banning ends the access and keeps the audit trail, which is the correct trade
-- for a company that may need to answer "who installed this window".

alter table public.profiles
  add column if not exists access_revoked_at timestamptz;

comment on column public.profiles.access_revoked_at is
  'When this person''s login was switched off (auth user banned by manage-crew-access). Distinct from `active`, which means "on site today". NULL = access is live.';

-- The profiles lockdown replaced the table-level grants with explicit column
-- lists, so a new column is unreachable until it is named. Read-only for
-- clients: it is set by the edge function on the service-role key.
grant select (access_revoked_at) on table public.profiles to authenticated;
revoke insert (access_revoked_at), update (access_revoked_at)
  on table public.profiles from anon, authenticated;


-- ---------------------------------------------------------------------------
-- 5. crew_access_directory: who has access, in one read
-- ---------------------------------------------------------------------------
-- The screen needs name + role + whether the login works. `crew_directory`
-- (from the profiles lockdown) is the safe cross-user surface but predates
-- access_revoked_at. security_invoker keeps the CALLER's row-level security in
-- force rather than the view owner's, so this cannot become a way around the
-- policies on profiles.

drop view if exists public.crew_access_directory;
create view public.crew_access_directory
  with (security_invoker = true)
  as select id, display_name, role, skill_level, active, access_revoked_at,
            created_at
     from public.profiles;

comment on view public.crew_access_directory is
  'Who has access: the crew directory plus access_revoked_at. security_invoker, so the caller''s RLS on profiles still applies.';

-- Default privileges hand a new view everything to anon and authenticated.
revoke all on public.crew_access_directory from public, anon, authenticated;
grant select on public.crew_access_directory to authenticated;
