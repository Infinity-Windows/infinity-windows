-- Wave Z — Money doors (transcripts program, grill of 2026-09-03).
--
-- THE GAP THIS CLOSES, found by reading the live policies rather than the UI:
-- `job_costs` and `change_orders` were `using (not is_partner_user() and
-- (true))` (20260950000000_partner_wall.sql), `projects.bid_amount` /
-- `target_margin_pct` rode the ordinary projects select policy, and
-- `receipts_select` opened at `my_role_rank() >= 1`. Every one of those is
-- readable by ANY crew login — an installer's phone could read the company's
-- bids, its margins and every receipt, while the Cost screen politely said
-- "Owner only". The nav floor was the whole lock, and a nav floor is not a
-- lock: it is a hidden button. This migration makes the database say no.
--
-- The shape of the answer (Q3/Q4/Q16, owner-approved): money is not a rank, it
-- is a GRANT. An owner can hand one supervisor the cost books without making
-- them an owner, and can hand one person pay rates without handing them costs.
-- Two booleans on `profiles`, written only by an owner-only RPC, read back by
-- two SQL helpers every money policy calls.
--
-- Order of business below:
--   1. Z1  the two grants, their helpers, and set_profile_grants
--   2. Z2  the locks: job_costs, change_orders, project_financials, receipts,
--          the AI spend meters
--   3. Z3  pay_rates and set_pay_rate
--   4. Z4  receipts.cost_code_id, job_costs.billable, and the one bridge that
--          turns a reviewed receipt into a job cost line
--   5. Z5  bank_imports / bank_transactions and their RPCs
--
-- Idempotent throughout (create ... if not exists / create or replace /
-- on conflict / drop policy if exists before create policy), so re-running it
-- changes nothing.


-- ===========================================================================
-- 1. Z1 — two grants: Sees costs, Sees pay rates
-- ===========================================================================
-- On `profiles` rather than a table of their own because they are facts about
-- a PERSON, read on every money policy evaluation — a join per policy check
-- would be a cost paid on every row of every cost query, for two booleans.
--
-- NOT NULL DEFAULT false: a policy must never have to reason about a null, and
-- "we do not know whether this person may see costs" has exactly one safe
-- reading. A brand-new account sees nothing until an owner says otherwise.
alter table public.profiles
  add column if not exists can_see_costs boolean not null default false,
  add column if not exists can_see_pay boolean not null default false;

comment on column public.profiles.can_see_costs is
  'Owner-granted: this person may read the money tables (job_costs, change_orders, project_financials, receipts, the AI spend meters) without being an owner. Written only by set_profile_grants(); the authenticated role holds SELECT but never UPDATE, the same way role, pin_hash and language are guarded (Wave Z, Z1).';
comment on column public.profiles.can_see_pay is
  'Owner-granted: this person may read pay_rates. Separate from can_see_costs on purpose — an office manager who books job costs has no business reading what the crew earns (Wave Z, Z1/Z3).';

-- Section 2 of 20260729200000_profiles_rls_lockdown.sql replaced this table's
-- blanket grants with explicit per-column lists, so a new column is unreadable
-- AND unwritable until it is named. Add both to the readable list only — the
-- Roster has to draw the checkboxes, and canAccess() has to know the grant
-- before it opens /costing.
grant select (can_see_costs, can_see_pay) on table public.profiles to authenticated;

-- A no-op today (the column is not in any grant list, so there is nothing to
-- take away), written out loud for the same reason 20260968000000 writes its
-- own: it states the intent, and it survives a future table-level re-grant.
-- set_profile_grants runs security definer, so the revoke does not touch it.
revoke insert (can_see_costs, can_see_pay), update (can_see_costs, can_see_pay)
  on table public.profiles from anon, authenticated;


-- --- the two helpers every money policy calls ------------------------------
-- SECURITY DEFINER for the same two reasons is_partner_user() gives: it reads
-- `profiles` from inside policies on other tables (and could one day be asked
-- from a policy on profiles itself) without tripping RLS recursion, and it can
-- read a column the calling role holds no privilege on — which matters here,
-- because if a future migration ever takes SELECT (can_see_costs) away from
-- `authenticated`, every policy that calls this keeps working.
--
-- STABLE, not VOLATILE: the planner is then free to evaluate it once per query
-- rather than once per row, which is the difference between a cheap policy and
-- a per-row profiles lookup on a thousand-row cost ledger.
--
-- Owner OR the flag. An owner is never granted anything explicitly — an owner
-- already sees the whole company, and a rule that made owners depend on a row
-- would be one bad UPDATE away from locking the owner out of their own books.
create or replace function public.can_see_costs(p_uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select public.role_rank(p.role) >= 3 or p.can_see_costs
       from public.profiles p
      where p.id = p_uid),
    false);
$$;

comment on function public.can_see_costs(uuid) is
  'True when this person may read the company''s money: an owner, or somebody an owner granted "Sees costs" (profiles.can_see_costs). The single predicate every money policy calls, so widening or narrowing who sees costs is one function, not fifteen policies (Wave Z, Z1).';

create or replace function public.can_see_pay(p_uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select public.role_rank(p.role) >= 3 or p.can_see_pay
       from public.profiles p
      where p.id = p_uid),
    false);
$$;

comment on function public.can_see_pay(uuid) is
  'True when this person may read pay rates: an owner, or somebody an owner granted "Sees pay rates" (profiles.can_see_pay). Deliberately NOT satisfied by reading your own rate — see pay_rates'' policy for why (Wave Z, Z1/Z3).';

revoke all on function public.can_see_costs(uuid) from public, anon;
revoke all on function public.can_see_pay(uuid) from public, anon;
grant execute on function public.can_see_costs(uuid) to authenticated, service_role;
grant execute on function public.can_see_pay(uuid) to authenticated, service_role;


-- --- the one writer --------------------------------------------------------
-- Owner-only, the same floor 20260939000000_owners_manage_owners.sql set for
-- "only owners manage owners" — handing somebody the cost books is the same
-- size of decision as making somebody an owner, so it gets the same door.
--
-- Returns a NARROW row, never `returns profiles`: the composite type of that
-- table includes pin_hash, and a function returning it would hand a credential
-- column back through PostgREST to anyone allowed to call it. The caller gets
-- back exactly what it set.
create or replace function public.set_profile_grants(
  p_profile_id uuid,
  p_costs boolean,
  p_pay boolean
)
-- The OUT columns are `sees_costs` / `sees_pay`, NOT the column names: a
-- `returns table` column in PL/pgSQL is a variable, and one spelled exactly
-- like a column of the table being updated is the classic ambiguous-reference
-- trap. Different words, no ambiguity to reason about.
returns table (profile_id uuid, sees_costs boolean, sees_pay boolean)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_is_partner boolean;
begin
  if public.my_role_rank() < 3 then
    raise exception 'Only an owner can change who sees costs.'
      using errcode = '42501';
  end if;

  select p.is_partner into v_is_partner from public.profiles p where p.id = p_profile_id;
  if not found then
    raise exception 'That person is not on the crew list.';
  end if;
  -- THE WALL (20260950000000) already ANDs `not is_partner_user()` into every
  -- money policy, so a granted partner would read nothing anyway. Refusing here
  -- as well means nobody ever has to work that out from two files: a builder's
  -- login cannot be handed the company's books, full stop.
  if coalesce(v_is_partner, false) then
    raise exception 'A builder login can never be given the company''s costs.'
      using errcode = '42501';
  end if;

  return query
  update public.profiles p
     set can_see_costs = coalesce(p_costs, p.can_see_costs),
         can_see_pay   = coalesce(p_pay, p.can_see_pay),
         updated_at    = now()
   where p.id = p_profile_id
  returning p.id, p.can_see_costs, p.can_see_pay;
end;
$$;

comment on function public.set_profile_grants(uuid, boolean, boolean) is
  'Owner-only: hand somebody (or take back) "Sees costs" and "Sees pay rates". Null leaves that grant alone, so the Roster''s two checkboxes can be flipped one at a time. Returns only the two flags — never the profiles row, which carries pin_hash.';

revoke all on function public.set_profile_grants(uuid, boolean, boolean) from public, anon;
grant execute on function public.set_profile_grants(uuid, boolean, boolean) to authenticated;


-- ===========================================================================
-- 2. Z2 — lock the money tables
-- ===========================================================================
-- Do this even if nothing else in wave Z ships. Everything below is a policy
-- that was open to every crew login until now.
--
-- Every policy keeps its EXISTING NAME. scripts/partner_wall_lib.py replays
-- `create policy` / `drop policy` across the migrations to recover the live
-- policy set; a renamed policy would leave the old name standing in that replay
-- as a second, wide-open policy that no longer exists. Same name, new predicate.

-- ---- job_costs / change_orders --------------------------------------------
-- The ledger and the change orders. `using (not is_partner_user() and (true))`
-- since 20260950000000 — the partner wall correctly kept a builder out and let
-- every installer in.
--
-- The predicate covers writes too (`for all`), which is deliberate: Costing's
-- "Add cost" and "Add change order" write these tables directly, and the person
-- allowed to type a cost line is exactly the person allowed to read them.
-- review_receipt's bridge (Z4) writes job_costs from a SECURITY DEFINER
-- function, so it is unaffected by the narrowing.
drop policy if exists "authenticated full access" on job_costs;
create policy "authenticated full access" on job_costs
  for all to authenticated
  using (not public.is_partner_user() and public.can_see_costs(auth.uid()))
  with check (not public.is_partner_user() and public.can_see_costs(auth.uid()));

drop policy if exists "authenticated full access" on change_orders;
create policy "authenticated full access" on change_orders
  for all to authenticated
  using (not public.is_partner_user() and public.can_see_costs(auth.uid()))
  with check (not public.is_partner_user() and public.can_see_costs(auth.uid()));


-- ---- project_financials: the bid moves off `projects` ----------------------
-- `projects.bid_amount` and `.target_margin_pct` (20260717002000) could not be
-- locked where they sat. A column has no policy of its own: it rides the
-- table's, and `projects` MUST stay readable — the app shell, the job list,
-- every screen with a job code on it reads that row, and a partner reads their
-- granted jobs through it. Column privileges do not help either, because RLS
-- and grants answer different questions: revoking SELECT (bid_amount) would
-- break the owner's own read through PostgREST as surely as an installer's.
--
-- So the money moves to a table that can carry its own policy. One row per job,
-- project_id as the primary key — a job has one bid, and a surrogate id would
-- invite two.
--
-- ON DELETE CASCADE, not the detach treatment `job_costs` and `receipts` get in
-- 20260959000000: a bid is not a money RECORD with retention weight, it is a
-- number about a job, and when the job is purged it goes with it — exactly what
-- happened when it was a column on `projects`. This migration changes where the
-- bid lives, not how long it lives.
create table if not exists project_financials (
  project_id uuid primary key references projects(id) on delete cascade,
  bid_amount numeric,
  target_margin_pct numeric,
  updated_at timestamptz not null default now(),
  -- `default auth.uid()` rather than a column the client fills: this is a
  -- direct table write from the Cost screen, and who last touched a bid is not
  -- something the browser should get to claim. Null under service_role or a
  -- SQL console, which is the honest answer there.
  updated_by uuid default auth.uid() references profiles(id) on delete set null
);

comment on table project_financials is
  'One job''s bid and target margin, moved off `projects` (20260717002000) so it can carry a policy of its own: `projects` has to stay readable by every crew login, and a column cannot be gated separately from its table. Readable and writable by an owner or anybody granted "Sees costs" (Wave Z, Z2).';

-- Backfill BEFORE the drop, and only while the old columns still exist, so a
-- re-run of this migration is a no-op rather than an error. `on conflict do
-- nothing` protects a row the Cost screen already wrote against being reset to
-- whatever the old column happened to hold.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'projects' and column_name = 'bid_amount'
  ) then
    execute $q$
      insert into project_financials (project_id, bid_amount, target_margin_pct)
      select id, bid_amount, target_margin_pct
        from projects
       where bid_amount is not null or target_margin_pct is not null
      on conflict (project_id) do nothing
    $q$;
  end if;
end;
$$;

alter table projects drop column if exists bid_amount;
alter table projects drop column if exists target_margin_pct;

-- THE PROJECTS GRANT LAW (wave D, 20260959000000): table-level INSERT/UPDATE on
-- `projects` is revoked and only the app-written columns are granted back.
-- Dropping a column drops its privilege with it, so the two lists are re-stated
-- here MINUS bid_amount / target_margin_pct — the law says the grant lists move
-- with the columns, and a reader of this file should not have to diff two
-- migrations to learn what is still writable.
revoke insert, update on table projects from anon, authenticated;
grant insert (job_code, name, address, customer_name, contact_phone,
              contact_email, site_state, unit_number, start_date, end_date,
              notes)
  on projects to authenticated;
grant update (name, address, customer_name, contact_phone, contact_email,
              site_state, unit_number, start_date, end_date, notes,
              estimated_minutes, estimated_crew, estimated_at)
  on projects to authenticated;

alter table project_financials enable row level security;

-- Revoke BEFORE granting: this project's default privileges hand every new
-- table in `public` the full set to `authenticated`, and RLS alone is not the
-- place to stand (20260729230000 / wave K's review). Here the policy IS meant
-- to allow writes — the Cost screen saves a bid directly, the same way it adds
-- a job cost line — so select/insert/update are granted back deliberately.
-- DELETE is not: nothing deletes a financials row except the job's own cascade.
revoke all on project_financials from anon, authenticated;
grant select, insert, update on project_financials to authenticated;
grant all on project_financials to service_role;

drop policy if exists "financials_cost_seers" on project_financials;
create policy "financials_cost_seers" on project_financials
  for all to authenticated
  using (not public.is_partner_user() and public.can_see_costs(auth.uid()))
  with check (not public.is_partner_user() and public.can_see_costs(auth.uid()));


-- ---- receipts: the foreman read goes ---------------------------------------
-- `my_role_rank() >= 1` (20260957000000) let every foreman read every receipt
-- the company has ever filed, while the office table itself is supervisor-only.
-- Supervisor+ keeps the office read, a cost-grant holder gains it (a bookkeeper
-- who is not a supervisor still has to reconcile the card statement), and an
-- uploader keeps seeing their OWN receipts — an installer who snapped a gas
-- receipt has to watch it land, and that has nothing to do with seeing the
-- company's spending.
drop policy if exists "receipts_select" on receipts;
create policy "receipts_select" on receipts
  for select to authenticated
  using (
    not public.is_partner_user()
    and (
      public.my_role_rank() >= 2
      or public.can_see_costs(auth.uid())
      or uploaded_by = auth.uid()
    )
  );


-- ---- the AI spend meters ---------------------------------------------------
-- `ai_role_rank(auth.uid()) >= 2` (20260729230000, swept by 20260950000000):
-- supervisor+. What these tables hold is money the company spent, so they move
-- to the same predicate as every other money table. The PAGE stays owner-only
-- in the nav (/ai-spend, minRole owner) — this only decides who the database
-- will answer, and it now answers exactly the people allowed to see spending.
drop policy if exists "ai_spend_alerts_select_office" on ai_spend_alerts;
create policy "ai_spend_alerts_select_office" on ai_spend_alerts
  for select to authenticated
  using (not public.is_partner_user() and public.can_see_costs(auth.uid()));

drop policy if exists "ai_spend_limits_select_office" on ai_spend_limits;
create policy "ai_spend_limits_select_office" on ai_spend_limits
  for select to authenticated
  using (not public.is_partner_user() and public.can_see_costs(auth.uid()));

drop policy if exists "ai_spend_months_select_office" on ai_spend_months;
create policy "ai_spend_months_select_office" on ai_spend_months
  for select to authenticated
  using (not public.is_partner_user() and public.can_see_costs(auth.uid()));

drop policy if exists "ai_usage_days_select_office" on ai_usage_days;
create policy "ai_usage_days_select_office" on ai_usage_days
  for select to authenticated
  using (not public.is_partner_user() and public.can_see_costs(auth.uid()));

drop policy if exists "ai_usage_events_select_office" on ai_usage_events;
create policy "ai_usage_events_select_office" on ai_usage_events
  for select to authenticated
  using (not public.is_partner_user() and public.can_see_costs(auth.uid()));


-- ===========================================================================
-- 99. Re-arm the sandbox fence
-- ===========================================================================
-- project_financials carries a `project_id`, which is what makes a table
-- project-scoped (sandbox_scoped_tables, 20260967000000). Without this line a
-- QA test login could write a bid on ANY job, not only its sandbox ones —
-- scripts/test_sandbox_guard.py fails CI for exactly this omission. Idempotent:
-- a table already correctly guarded is left alone rather than re-triggered.
select public.attach_sandbox_guards();
