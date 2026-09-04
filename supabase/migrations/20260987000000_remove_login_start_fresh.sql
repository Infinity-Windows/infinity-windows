-- Remove a login and start fresh, plus access-request hygiene
-- (owner's decision, 2026-09-04: "the ability to delete user accounts and
-- start fresh").
--
-- Two unrelated-looking halves ship together because they are the same
-- complaint: an account that came in wrong stays wrong forever. One half is
-- the login; the other is the request that asked for it.
--
--   1. profiles.retired_at / retired_by — the roster's word for a login that
--      was removed for good rather than merely switched off.
--   2. access_requests.decision_note, and RLS that finally matches who is
--      allowed to decide anything.
--   3. decide_access_request() — the one client-side writer of a decision,
--      supervisor+, which can deny, note a reason, and re-open a denial, and
--      can NEVER write 'approved'.
--
-- MERGE ORDER: this is 20260987000000 and it lands AFTER 20260985000000 and
-- 20260986000000, both in flight. It shares no object with either; the order
-- matters only because migration numbers land in sequence, one deploy at a
-- time.
--
-- IDEMPOTENT throughout (add column if not exists / create or replace / drop
-- policy if exists before create), so re-running it changes nothing.


-- ---------------------------------------------------------------------------
-- 1. profiles.retired_at / retired_by — "Removed", not "switched off"
-- ---------------------------------------------------------------------------
-- THREE COLUMNS NOW SAY THREE DIFFERENT THINGS ABOUT ONE PERSON, and they are
-- easy to confuse, so:
--
--   active            — "on site today". A foreman toggles it every morning.
--                       Availability, never permission.
--   access_revoked_at — "their login is switched off". Reversible; the auth
--                       user is banned and "Let them back in" un-bans them.
--   retired_at        — "this login was removed for good". The auth user is
--                       banned AND its email has been handed back (renamed to
--                       a tombstone by manage-crew-access), so there is nothing
--                       to switch back on: the address they used to sign in
--                       with belongs to nobody now, and the way back is a fresh
--                       invite. That is the whole point — an email that stays
--                       taken forever is what made "start fresh" impossible.
--
-- WHY A FLAG AND NOT A DELETE. `profiles.id` references `auth.users(id) ON
-- DELETE CASCADE` (20260715240000), so deleting the account deletes the
-- profile, and from there the person's record goes three ways at once:
-- CASCADE takes time_shifts, receipts, pay_rates, certifications,
-- toolbox_completions, points_ledger, task_sessions and project_messages with
-- it; SET NULL leaves install_events.installer_id pointing at nobody, so the
-- window stays installed and nobody installed it; and eight columns with no ON
-- DELETE clause at all (unit_sessions.profile_id, unit_redos.pressed_by,
-- daily_logs.filed_by, summons.requested_by, opening_phases.started_by and
-- .submitted_by, time_shift_edits.edited_by, flash_run_assignments.assigned_by)
-- make the delete FAIL outright. So a person with anything on file is retired,
-- never deleted, and the hard delete is reserved for a login with genuinely
-- nothing behind it — which the edge function establishes by counting, not by
-- asking. See supabase/functions/_shared/purgeLogin.ts.
--
-- The display name is deliberately NOT changed. Every screen that reads back
-- who did something joins to this row, and renaming it to "Removed" would
-- rewrite years of finished work into anonymity. The roster says "Removed"
-- beside the name it always had.

alter table public.profiles
  add column if not exists retired_at timestamptz,
  add column if not exists retired_by uuid references public.profiles(id) on delete set null;

comment on column public.profiles.retired_at is
  'When this login was removed for good (banned AND its email handed back to a tombstone by manage-crew-access purge_login). Distinct from access_revoked_at, which is reversible, and from active, which means "on site today". NULL = not retired. Never set from a client.';
comment on column public.profiles.retired_by is
  'The owner who removed the login. NULL for a removal done by the service role directly.';

create index if not exists profiles_retired_idx
  on public.profiles (retired_at)
  where retired_at is not null;

-- The profiles lockdown (20260729200000) replaced the table-level grants with
-- explicit column lists, so a new column is unreachable until it is named.
-- Read-only for clients: both are written by the edge function on the
-- service-role key, exactly like access_revoked_at.
grant select (retired_at, retired_by) on table public.profiles to authenticated;
revoke insert (retired_at, retired_by), update (retired_at, retired_by)
  on table public.profiles from anon, authenticated;

-- The Crew access screen reads this view rather than the table. security_invoker
-- keeps the CALLER's row-level security in force, so widening it cannot become
-- a way around the policies on profiles.
drop view if exists public.crew_access_directory;
create view public.crew_access_directory
  with (security_invoker = true)
  as select id, display_name, role, skill_level, active, access_revoked_at,
            retired_at, retired_by, created_at
     from public.profiles;

comment on view public.crew_access_directory is
  'Who has access: the crew directory plus access_revoked_at and retired_at/retired_by. security_invoker, so the caller''s RLS on profiles still applies.';

revoke all on public.crew_access_directory from public, anon, authenticated;
grant select on public.crew_access_directory to authenticated;


-- ---------------------------------------------------------------------------
-- 2. access_requests: a reason, and RLS that means something
-- ---------------------------------------------------------------------------
-- WHAT WAS WRONG. Since 20260717000000 this table has carried exactly one
-- policy for signed-in users:
--
--     "authenticated full access"  FOR ALL  USING (true)  WITH CHECK (true)
--
-- (wrapped in the partner guard by THE WALL, 20260950000000, and otherwise
-- untouched). So ANY signed-in user — an installer, anybody's first-day
-- account — could approve their own access request, deny somebody else's, or
-- delete the queue. Nothing in the app offers those taps, but a greyed-out
-- button is not a control; the row was writable by anyone who could open a
-- console. The Admin screen's own gate is supervisor+, and this makes the
-- database agree with it.
--
-- The four policies below replace that one. SELECT and INSERT stay exactly as
-- permissive as they were — the Admin queue reads it, and the public request
-- form must keep working (the separate `anon can request` INSERT policy from
-- 20260717000000 is left alone; an anonymous visitor has no rank to check).
-- UPDATE and DELETE become supervisor+.

alter table public.access_requests
  add column if not exists decision_note text;

comment on column public.access_requests.decision_note is
  'Why this request was decided the way it was, in the decider''s own words. Optional. Written only by decide_access_request (client side) or the approve-access-request edge function (service role).';

-- Every policy carries the partner guard, the same way THE WALL's sweep left
-- it: a builder's login is not crew and never reads or writes this queue.
drop policy if exists "authenticated full access" on public.access_requests;

drop policy if exists "access_requests_select" on public.access_requests;
create policy "access_requests_select" on public.access_requests
  for select to authenticated
  using (not public.is_partner_user() and (true));

-- INSERT stays open to any signed-in user: somebody already inside the app
-- asking for a different role is the same request as somebody outside asking
-- for one, and the `anon can request` policy already allows the anonymous case.
drop policy if exists "access_requests_insert" on public.access_requests;
create policy "access_requests_insert" on public.access_requests
  for insert to authenticated
  with check (not public.is_partner_user() and (true));

drop policy if exists "access_requests_update_supervisor" on public.access_requests;
create policy "access_requests_update_supervisor" on public.access_requests
  for update to authenticated
  using (not public.is_partner_user() and public.my_role_rank() >= 2)
  with check (not public.is_partner_user() and public.my_role_rank() >= 2);

drop policy if exists "access_requests_delete_supervisor" on public.access_requests;
create policy "access_requests_delete_supervisor" on public.access_requests
  for delete to authenticated
  using (not public.is_partner_user() and public.my_role_rank() >= 2);


-- ---------------------------------------------------------------------------
-- 3. decide_access_request — the only decision a client may write
-- ---------------------------------------------------------------------------
-- WHY AN RPC WHEN THE UPDATE POLICY ALREADY SAYS SUPERVISOR+. Because one
-- status is not the client's to write at all. 'approved' MEANS "an account now
-- exists": the approve-access-request edge function creates the auth user, the
-- profile and the one-time password, and only then marks the row. A client that
-- could write 'approved' itself would put the queue back in the state the owner
-- reported last time — "when I admin approve his login it still won't work" —
-- a row that says approved beside a person who cannot sign in. So this function
-- refuses that word outright, and the edge function stays the only writer of it.
--
-- 'denied' → 'pending' is deliberately allowed. Denying is one tap and a
-- mis-tap is the ordinary human error here; Re-open puts the request back in
-- the queue with the note that explains why, rather than making somebody ask
-- for access all over again to undo a slip.
--
-- SECURITY DEFINER, so the rank check is this function's rather than the
-- caller's policy — and so `decided_by` is written from auth.uid() and can
-- never be somebody else's id.
create or replace function public.decide_access_request(
  p_id uuid,
  p_status text,
  p_note text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_note text;
begin
  if public.my_role_rank() < 2 then
    raise exception 'only a supervisor or the owner can decide an access request'
      using errcode = '42501';
  end if;

  if p_status not in ('denied', 'pending') then
    raise exception
      'decide_access_request writes denied or pending only; approving creates an account and is the approve-access-request function''s job'
      using errcode = '22023';
  end if;

  v_note := nullif(btrim(coalesce(p_note, '')), '');

  update access_requests
     set status = p_status,
         decided_by = case when p_status = 'pending' then null else auth.uid() end,
         decided_at = case when p_status = 'pending' then null else now() end,
         -- Re-opening clears the old reason with the old decision: a note
         -- saying "no vacancies" sitting on a pending request would read as
         -- this decision rather than the one that was undone.
         decision_note = case when p_status = 'pending' then null else v_note end
   where id = p_id;

  if not found then
    raise exception 'no such access request' using errcode = 'P0002';
  end if;
end;
$$;

comment on function public.decide_access_request(uuid, text, text) is
  'Deny an access request with an optional reason, or re-open a denied one. Supervisor+. Never writes ''approved'' — approving creates a login and belongs to the approve-access-request edge function.';

revoke all on function public.decide_access_request(uuid, text, text)
  from public, anon;
grant execute on function public.decide_access_request(uuid, text, text)
  to authenticated, service_role;
