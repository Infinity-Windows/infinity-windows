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
-- 1b. person_record_counts — the count that decides which shape happens
-- ---------------------------------------------------------------------------
-- One row per table this person appears in, as one jsonb object, keyed
-- `table.column`. The keys here are the contract: they are the exact strings
-- WORK_HISTORY_PROBES uses in app/src/lib/purgeWords.ts, and
-- app/src/lib/purgeWords.test.ts reads THIS FILE and fails if the two lists
-- ever stop agreeing. The rule lives twice on purpose — SQL owns the counting,
-- TypeScript owns the words and the order they are said in — and the two copies
-- are pinned together rather than trusted to stay in step.
--
-- WHAT HAS TO BE IN HERE, and why the first cut of this list was dangerous.
-- The RESTRICT columns are the loud ones: a hard delete against a person who
-- appears in any of them FAILS, so missing one is a 500 on a phone and nothing
-- worse. The CASCADE columns are the quiet ones, and they are the reason this
-- list is now derived from the schema rather than written from memory: a
-- CASCADE column that is NOT counted here makes the person look empty, the
-- delete SUCCEEDS, and their rows go with it without a word. The first cut
-- counted nine of the twenty-seven CASCADE columns and missed, among others,
-- `safety_acks` (a signed safety talk, a DIFFERENT table from
-- toolbox_completions), `timecard_periods` (the row carrying the employee's
-- and the supervisor's signatures on a pay period), `overtime_rules` (a
-- person's own overtime deal) and `capability_badges` (what a foreman signed
-- them off to touch). Every one of those is exactly the record this feature
-- promises to keep.
--
-- purgeWords.test.ts now parses every `references profiles(id)` in
-- supabase/migrations and fails unless each CASCADE and RESTRICT column is
-- either counted below or on a short, commented allow-list of ephemera (push
-- subscriptions, notification dismissals, chat read receipts, and the two
-- partner-only tables — a builder login is refused by this door outright).
--
-- WHY THIS IS A DATABASE FUNCTION AND NOT NINETEEN READS FROM THE EDGE
-- FUNCTION. Two reasons, and the second is the binding one:
--
--   1. Nineteen round trips to decide one button is nineteen round trips.
--   2. Wave Z's standing guarantee is that NO edge function ever names
--      `pay_rates` — they hold the service-role key, which bypasses RLS
--      entirely, so a single `.from("pay_rates")` in one of them would put
--      every wage in the company one edit away from a model's context.
--      app/src/lib/payRates.test.ts enforces that by scanning the function
--      source. Counting a person's rows is not reading a wage, but the scan
--      cannot tell the difference and should not have to: the table names stay
--      in SQL, where that guarantee is not at stake.
--
-- SECURITY DEFINER so the counts are complete — daily_logs is foreman+ and
-- pay_rates is grant-gated, and a count that RLS quietly shortened would make a
-- person look emptier than they are, which is the one error that loses records.
-- Granted to service_role ONLY: the sole caller is manage-crew-access, which
-- does its own owner-rank check first, and nothing in a browser has any reason
-- to ask how many receipts somebody has.
create or replace function public.person_record_counts(p_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    -- Time and money.
    'time_shifts.profile_id',
      (select count(*) from time_shifts where profile_id = p_id),
    'unit_sessions.profile_id',
      (select count(*) from unit_sessions where profile_id = p_id),
    'install_events.installer_id',
      (select count(*) from install_events where installer_id = p_id),
    'install_events.credited_to',
      (select count(*) from install_events where credited_to = p_id),
    'receipts.uploaded_by',
      (select count(*) from receipts where uploaded_by = p_id),
    'pay_rates.profile_id',
      (select count(*) from pay_rates where profile_id = p_id),
    'overtime_rules.profile_id',
      (select count(*) from overtime_rules where profile_id = p_id),
    'timecard_periods.profile_id',
      (select count(*) from timecard_periods where profile_id = p_id),
    'time_shift_edits.edited_by',
      (select count(*) from time_shift_edits where edited_by = p_id),
    -- Safety and training.
    'certifications.profile_id',
      (select count(*) from certifications where profile_id = p_id),
    'toolbox_completions.profile_id',
      (select count(*) from toolbox_completions where profile_id = p_id),
    'safety_acks.profile_id',
      (select count(*) from safety_acks where profile_id = p_id),
    'capability_badges.installer_id',
      (select count(*) from capability_badges where installer_id = p_id),
    'installer_clearance.installer_id',
      (select count(*) from installer_clearance where installer_id = p_id),
    'learn_progress.profile_id',
      (select count(*) from learn_progress where profile_id = p_id),
    'learning_video_quiz_attempts.profile_id',
      (select count(*) from learning_video_quiz_attempts where profile_id = p_id),
    -- The job site.
    'daily_logs.filed_by',
      (select count(*) from daily_logs where filed_by = p_id),
    'opening_phases.started_by',
      (select count(*) from opening_phases where started_by = p_id),
    'opening_phases.submitted_by',
      (select count(*) from opening_phases where submitted_by = p_id),
    'flash_run_assignments.assigned_by',
      (select count(*) from flash_run_assignments where assigned_by = p_id),
    'flash_run_assignments.profile_id',
      (select count(*) from flash_run_assignments where profile_id = p_id),
    'summons.requested_by',
      (select count(*) from summons where requested_by = p_id),
    'summon_helpers.profile_id',
      (select count(*) from summon_helpers where profile_id = p_id),
    'summon_declines.profile_id',
      (select count(*) from summon_declines where profile_id = p_id),
    'unit_redos.pressed_by',
      (select count(*) from unit_redos where pressed_by = p_id),
    'schedule_assignment_members.profile_id',
      (select count(*) from schedule_assignment_members where profile_id = p_id),
    'trip_crew.profile_id',
      (select count(*) from trip_crew where profile_id = p_id),
    'vehicle_drivers.profile_id',
      (select count(*) from vehicle_drivers where profile_id = p_id),
    -- What they said and what they were given credit for.
    'points_ledger.profile_id',
      (select count(*) from points_ledger where profile_id = p_id),
    'task_sessions.profile_id',
      (select count(*) from task_sessions where profile_id = p_id),
    'project_messages.author_id',
      (select count(*) from project_messages where author_id = p_id),
    'ask_question_log.asker_id',
      (select count(*) from ask_question_log where asker_id = p_id)
  );
$$;

comment on function public.person_record_counts(uuid) is
  'How many rows of work, money and safety record one person has, keyed table.column. The input to "remove this login": nothing anywhere means the account can be deleted outright, anything at all means it is retired and every row kept. Service role only — manage-crew-access checks the caller is the owner before it asks.';

revoke all on function public.person_record_counts(uuid) from public, anon, authenticated;
grant execute on function public.person_record_counts(uuid) to service_role;


-- ---------------------------------------------------------------------------
-- 1c. Nobody removed ever hears a push again
-- ---------------------------------------------------------------------------
-- Both nightly audiences already exclude a removed person by accident:
-- pipeline_nudge_audience filters on `pr.active` and credential_nudge_audience
-- on `pr.access_revoked_at is null`, and purge_login sets both. "By accident"
-- is the problem. `active` means "on site today" and a foreman toggles it every
-- morning from the Roster — one tap on the wrong row would put a removed login
-- back on the 7 AM push list, addressed to a phone whose owner left. So each
-- one says it outright, beside the filter it already had.
--
-- Restated in full (create or replace) rather than patched, so the whole
-- predicate is readable in one place; the only change to either is the new
-- `retired_at is null` line.
create or replace function public.pipeline_nudge_audience(p_project_id uuid)
returns uuid[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(array_agg(distinct pr.id), '{}'::uuid[])
    from profiles pr
   where pr.active
     and pr.retired_at is null
     and not coalesce(pr.is_partner, false)
     and (
       public._is_supervisor(pr.id)
       or (
         public._is_lead(pr.id)
         and (
           exists (
             select 1
               from schedule_assignments sa
               join schedule_assignment_members sam on sam.assignment_id = sa.id
              where sa.project_id = p_project_id
                and sam.profile_id = pr.id
                -- Published, not drafted — a foreman pencilled into a plan
                -- nobody has published must not be pushed about it.
                and sa.status in ('published', 'in_progress', 'done')
                and sa.end_date >= (now() at time zone 'America/Denver')::date
                and sa.start_date <= (now() at time zone 'America/Denver')::date + 14
           )
           or exists (
             select 1
               from time_shifts ts
              where ts.project_id = p_project_id
                and ts.profile_id = pr.id
                and ts.status = 'open'
                and ts.clock_out_at is null
           )
         )
       )
     );
$$;

comment on function public.pipeline_nudge_audience(uuid) is
  'Who hears a pipeline warning about one job: every active supervisor+, plus every foreman on a PUBLISHED assignment for it within the next fortnight or clocked into it right now. A draft assignment does not count — the crew has not been shown it. Partner logins never, and removed logins never (retired_at).';

create or replace function public.credential_nudge_audience(p_profile_id uuid)
returns uuid[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(array_agg(distinct pr.id), '{}'::uuid[])
    from profiles pr
   where pr.access_revoked_at is null
     and pr.retired_at is null
     and not coalesce(pr.is_partner, false)
     and (pr.id = p_profile_id or public._is_supervisor(pr.id));
$$;

comment on function public.credential_nudge_audience(uuid) is
  'Who hears that a card is running out: the person it belongs to, plus every supervisor and owner whose login is still switched on. Deliberately NOT filtered on profiles.active, which means "on site today" — the warning is claimed once per expiry date, so a supervisor who happened to be off that one morning would never hear about that card again. Partner logins never (Wave O, O4); removed logins never (retired_at).';

-- And the third audience, which is the one that matters most: this is the only
-- function in the database that hands a raw email ADDRESS to a browser.
-- foreman_contacts_for_me (20260984000000) fills the To: line of the "Send a
-- recording" mailto:, and it filtered on `p.active` alone — the flag a foreman
-- toggles every morning from the Roster. One tap on the wrong row and a removed
-- login's address goes into a mail composer, and after a removal that address
-- is the tombstone `<uid>@removed.invalid`, which is not a mailbox at all.
-- Restated in full so the whole predicate is readable in one place; the only
-- change to either branch is the new `p.retired_at is null` line.
create or replace function public.foreman_contacts_for_me()
returns table (contact_name text, contact_email text)
language plpgsql
stable
security definer
set search_path = public, auth, pg_temp
as $fn$
declare
  v_uid uuid := auth.uid();
  v_project uuid;
begin
  if v_uid is null then
    raise exception 'Sign in first.';
  end if;
  if public.is_partner_user() then
    raise exception 'This is the crew address book, and a builder login is not crew.';
  end if;

  -- The job the caller is standing on, if any. Newest open shift wins, the
  -- same way getOpenShift() picks one on the phone.
  select ts.project_id into v_project
    from time_shifts ts
   where ts.profile_id = v_uid
     and ts.status = 'open'
     and ts.clock_out_at is null
   order by ts.clock_in_at desc
   limit 1;

  if v_project is not null then
    return query
      select p.display_name, u.email::text
        from profiles p
        join auth.users u on u.id = p.id
       where p.active
         and p.retired_at is null
         and not coalesce(p.is_partner, false)
         and public._is_lead(p.id)
         and p.id <> v_uid
         and u.email is not null
         and (
           exists (
             select 1
               from schedule_assignments sa
               join schedule_assignment_members sam on sam.assignment_id = sa.id
              where sa.project_id = v_project
                and sam.profile_id = p.id
                -- Published, not drafted — see pipeline_nudge_audience's own
                -- note on why a pencilled-in plan must not count.
                and sa.status in ('published', 'in_progress', 'done')
                and sa.end_date >= (now() at time zone 'America/Denver')::date
                and sa.start_date <= (now() at time zone 'America/Denver')::date
           )
           or exists (
             select 1
               from time_shifts ts2
              where ts2.project_id = v_project
                and ts2.profile_id = p.id
                and ts2.status = 'open'
                and ts2.clock_out_at is null
           )
         )
       order by p.display_name;
    -- RETURN QUERY sets FOUND. Somebody answered, so stop here rather than
    -- adding every other lead in the company to the To: line.
    if found then
      return;
    end if;
  end if;

  return query
    select p.display_name, u.email::text
      from profiles p
      join auth.users u on u.id = p.id
     where p.active
       and p.retired_at is null
       and not coalesce(p.is_partner, false)
       and public._is_lead(p.id)
       and p.id <> v_uid
       and u.email is not null
     order by p.display_name;
end;
$fn$;

comment on function public.foreman_contacts_for_me() is
  'The name and email of every foreman-and-up on the job the caller is clocked into, else every active one in the company. A MINIMAL PROJECTION — two columns, nothing else about anybody — because emails live in auth.users where no client role may read them. Refuses partner logins, and never answers with a removed login: its address is a tombstone by then.';

revoke all on function public.foreman_contacts_for_me() from public, anon;
grant execute on function public.foreman_contacts_for_me() to authenticated, service_role;


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
-- The four policies below replace that one. INSERT stays exactly as permissive
-- as it was — the public request form must keep working, and the separate
-- `anon can request` INSERT policy from 20260717000000 is left alone; an
-- anonymous visitor has no rank to check. SELECT, UPDATE and DELETE all become
-- supervisor+.
--
-- WHY SELECT NARROWED TOO, which the first cut of this migration left wide.
-- This queue now carries `decision_note`: free text a supervisor types about a
-- person the crew knows, under a sheet that tells him "only people who can see
-- this screen ever read it". The screen is gated at supervisor+ in the client
-- and nowhere else, so with a wide SELECT that sentence was not true — any
-- installer with a browser console could read the whole queue and the reason
-- each person was turned down. Nothing in the app reads this table below
-- supervisor: Admin.tsx and Notifications.tsx are the only two readers and both
-- are already gated there, and submitAccessRequest is an INSERT with no
-- read-back (scripts/prove-onboarding.py asserts exactly that shape, and reads
-- the queue back on the service role).

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
  using (not public.is_partner_user() and public.my_role_rank() >= 2);

-- INSERT stays open to any signed-in user: somebody already inside the app
-- asking for a different role is the same request as somebody outside asking
-- for one, and the `anon can request` policy already allows the anonymous case.
drop policy if exists "access_requests_insert" on public.access_requests;
create policy "access_requests_insert" on public.access_requests
  for insert to authenticated
  with check (not public.is_partner_user() and (true));

-- The WITH CHECK names the statuses a client may leave behind, and 'approved'
-- is not one of them. Rank alone is not enough here: 'approved' MEANS "an
-- account now exists", and a supervisor PATCHing this row to 'approved'
-- straight at PostgREST would reproduce the exact failure the RPC below was
-- written to prevent — a row that says approved beside a person who cannot
-- sign in. Two independent controls now say it: this clause, and
-- decide_access_request's own refusal. The approve-access-request edge function
-- writes on the service role, which is not subject to this policy at all, so
-- the one legitimate writer of 'approved' is unaffected.
drop policy if exists "access_requests_update_supervisor" on public.access_requests;
create policy "access_requests_update_supervisor" on public.access_requests
  for update to authenticated
  using (not public.is_partner_user() and public.my_role_rank() >= 2)
  with check (
    not public.is_partner_user()
    and public.my_role_rank() >= 2
    and status in ('denied', 'pending')
  );

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
