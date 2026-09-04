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
-- to the same predicate as every other money table.
--
-- These five policies are DEFENCE IN DEPTH and nothing more. Nothing in the app
-- selects from these tables; the only read path is the SECURITY DEFINER RPC
-- below, which bypasses RLS entirely. Tightening the policies without
-- tightening the RPC would have locked the window and left the door open — the
-- first draft of this migration did exactly that, and its comment claimed the
-- opposite. The lock that counts is `ai_spend_overview()`.
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

-- ---- and the door the app actually uses ------------------------------------
-- THE READ PATH. app/src/lib/aiSpend.ts calls exactly one thing —
-- `supabase.rpc("ai_spend_overview")` — and that function is SECURITY DEFINER,
-- so it runs as the table owner and the five policies above never fire for it.
-- Its gate was `ai_role_rank(auth.uid()) < 2`: supervisor+. A supervisor with
-- no cost grant could ask it for the month's spend, the cap, and every
-- person's cost by name.
--
-- Same body, same shape, same `can_edit` (still `v_rank >= 3`, so only an owner
-- may move the limits — ai_spend_set_limits enforces that itself and calls this
-- function to return the fresh picture, which keeps working because an owner
-- passes can_see_costs). Only the gate moves, onto the one predicate every
-- other money table in this migration answers to.
create or replace function public.ai_spend_overview()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cfg ai_spend_limits;
  v_month date;
  v_day date;
  v_rank integer := ai_role_rank(auth.uid());
begin
  if not public.can_see_costs(auth.uid()) then
    raise exception 'Only an owner, or somebody given "Sees costs", can see what the assistant costs.'
      using errcode = '42501';
  end if;

  select * into v_cfg from ai_spend_limits where id = 1;
  v_month := date_trunc('month', (now() at time zone coalesce(v_cfg.timezone, 'UTC')))::date;
  v_day := (now() at time zone coalesce(v_cfg.timezone, 'UTC'))::date;

  return jsonb_build_object(
    'can_edit', v_rank >= 3,
    'limits', jsonb_build_object(
      'per_user_daily_calls', v_cfg.per_user_daily_calls,
      'monthly_cap_cents', v_cfg.monthly_cap_cents,
      'content_multiplier', v_cfg.content_multiplier,
      'min_role', v_cfg.min_role,
      'alert_at_pct', v_cfg.alert_at_pct,
      'enforced', v_cfg.enforced,
      'timezone', v_cfg.timezone,
      'updated_at', v_cfg.updated_at
    ),
    'month', jsonb_build_object(
      'usage_month', v_month,
      'calls', coalesce((select calls from ai_spend_months where usage_month = v_month), 0),
      'spent_micros', coalesce((select spent_micros from ai_spend_months where usage_month = v_month), 0),
      'reserved_micros', coalesce((select reserved_micros from ai_spend_months where usage_month = v_month), 0),
      'cap_micros', v_cfg.monthly_cap_cents::bigint * 10000
    ),
    'people', coalesce((
      select jsonb_agg(row_to_json(t))
      from (
        select
          e.user_id,
          coalesce(p.display_name, 'Removed user') as display_name,
          coalesce(p.role, 'unknown') as role,
          count(*) filter (where e.outcome = 'allowed') as calls,
          coalesce(sum(e.cost_micros), 0) as cost_micros,
          count(*) filter (where e.outcome like 'denied%') as blocked,
          coalesce((
            select d.calls from ai_usage_days d
             where d.user_id = e.user_id and d.usage_day = v_day
          ), 0) as calls_today
        from ai_usage_events e
        left join profiles p on p.id = e.user_id
        where e.usage_month = v_month
        group by e.user_id, p.display_name, p.role
        order by coalesce(sum(e.cost_micros), 0) desc,
                 count(*) filter (where e.outcome = 'allowed') desc
        limit 25
      ) t
    ), '[]'::jsonb),
    'functions', coalesce((
      select jsonb_agg(row_to_json(f))
      from (
        select function_name,
               count(*) filter (where outcome = 'allowed') as calls,
               coalesce(sum(cost_micros), 0) as cost_micros
          from ai_usage_events
         where usage_month = v_month
         group by function_name
         order by coalesce(sum(cost_micros), 0) desc
      ) f
    ), '[]'::jsonb),
    'alerts', coalesce((
      select jsonb_agg(row_to_json(a))
      from (
        select level, reserved_micros, cap_micros, created_at
          from ai_spend_alerts
         where usage_month = v_month
         order by created_at desc
      ) a
    ), '[]'::jsonb)
  );
end;
$$;

comment on function public.ai_spend_overview() is
  'The AI spend picture. Wave Z moved its gate from supervisor+ to can_see_costs(auth.uid()) — owner, or somebody the owner granted "Sees costs" — because this SECURITY DEFINER function, not the tables, is what the app reads. can_edit stays owner-only.';

-- `create or replace` keeps the existing ACL, so these are a no-op today. Said
-- out loud anyway: a reader should be able to see what this function is
-- reachable by without opening 20260729230000.
revoke all on function public.ai_spend_overview() from public, anon;
grant execute on function public.ai_spend_overview() to authenticated, service_role;


-- ===========================================================================
-- 3. Z3 — real pay rates
-- ===========================================================================
-- Until now labor cost was hours × a hardcoded table of role rates in
-- app/src/lib/costing.ts (installer 35, foreman 50, …). Every margin the owner
-- has ever looked at was priced off four guesses. This is where the real
-- numbers live.
--
-- A HISTORY, not a column on profiles. A rate that changed in March must not
-- reprice January: a job costed last quarter has to keep costing what it cost,
-- or every historical margin silently moves the next time somebody gets a
-- raise. So a row per rate per start date, and the reader asks "what was in
-- force on the day of this shift".
--
-- NOT project-scoped (no project_id): a rate is about a person, not a job, so
-- it gets no sandbox guard — a test login has no business writing one anyway,
-- which set_pay_rate's owner check already settles.
create table if not exists pay_rates (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles(id) on delete cascade,
  -- Cents, like every other money figure the app stores (receipts.amount_cents,
  -- ai_spend_limits.monthly_cap_cents). Never a float: $32.335 is not a wage.
  hourly_cents integer not null check (hourly_cents >= 0),
  -- The day this rate STARTS. There is no end date on purpose — a rate runs
  -- until the next one begins, so ending one is writing the next, and there is
  -- no way to leave a gap or an overlap by getting two dates out of step.
  effective_from date not null default current_date,
  set_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  -- One rate per person per start date, so "the rate in force on a day" always
  -- has exactly one answer, and re-saving a typo overwrites rather than
  -- stacking a second row nobody can tell apart.
  unique (profile_id, effective_from)
);

create index if not exists pay_rates_profile_idx
  on pay_rates (profile_id, effective_from desc);

comment on table pay_rates is
  'What one person earns per hour, from a given day. A history, not a current value: a raise in March must never reprice January''s margins. Readable only by an owner or somebody granted "Sees pay rates"; written only by set_pay_rate (Wave Z, Z3).';

alter table pay_rates enable row level security;

-- Revoke first (Supabase's default privileges hand `authenticated` the full set
-- on every new public table), then grant back SELECT alone. Unlike
-- project_financials there is no write policy here at all: set_pay_rate,
-- SECURITY DEFINER, is the only writer, so there is no direct path that could
-- skip the owner check.
revoke all on pay_rates from anon, authenticated;
grant select on pay_rates to authenticated;
grant all on pay_rates to service_role;

-- No self arm. "You may read your own rate" sounds kind and is a leak: a
-- person's own rate is on their paycheck already, and the moment the policy
-- says `profile_id = auth.uid()` the table starts answering questions from
-- every phone in the company, one row at a time. Payroll tells people what
-- they earn; this table exists so the owner can cost a job.
drop policy if exists "pay_rates_select" on pay_rates;
create policy "pay_rates_select" on pay_rates
  for select to authenticated
  using (not public.is_partner_user() and public.can_see_pay(auth.uid()));

create or replace function public.set_pay_rate(
  p_profile_id uuid,
  p_hourly_cents integer,
  p_effective_from date default current_date
)
returns pay_rates
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row pay_rates;
begin
  if public.my_role_rank() < 3 then
    raise exception 'Only an owner can set what somebody is paid.'
      using errcode = '42501';
  end if;
  if p_hourly_cents is null or p_hourly_cents < 0 then
    raise exception 'An hourly rate has to be a number, and not a negative one.';
  end if;
  if not exists (select 1 from profiles where id = p_profile_id) then
    raise exception 'That person is not on the crew list.';
  end if;

  insert into pay_rates (profile_id, hourly_cents, effective_from, set_by)
  values (p_profile_id, p_hourly_cents, coalesce(p_effective_from, current_date), auth.uid())
  on conflict (profile_id, effective_from) do update
    set hourly_cents = excluded.hourly_cents,
        set_by = excluded.set_by,
        created_at = now()
  returning * into v_row;

  return v_row;
end;
$$;

comment on function public.set_pay_rate(uuid, integer, date) is
  'Owner-only: set what somebody earns per hour from a given day. Re-saving the same start date corrects that rate rather than stacking a second row, so a typo is fixable without a delete door.';

revoke all on function public.set_pay_rate(uuid, integer, date) from public, anon;
grant execute on function public.set_pay_rate(uuid, integer, date) to authenticated;


-- ===========================================================================
-- 4. Z4 — a reviewed receipt becomes a job cost, exactly once
-- ===========================================================================
-- Nothing has ever written `receipts` into `job_costs`. A crew member snaps a
-- receipt, a supervisor reviews it, and the money never reaches the job it was
-- spent on — the office retyped it, or nobody did. This is the bridge.
--
-- The whole rule, in one sentence: ONE receipt makes AT MOST ONE job cost line,
-- ever. `receipts.job_cost_id` is what enforces it — set once, never cleared —
-- so un-reviewing does not delete the line, re-reviewing does not post a second
-- one, and the receipt reads "posted" from then on.

-- Which kind of purchase this was, from the same cost-code library the clock
-- uses. Nullable: a receipt filed in a hurry with no code is still a receipt,
-- and the office can set it later.
alter table receipts
  add column if not exists cost_code_id uuid references cost_codes(id) on delete set null;

-- The line this receipt became. ON DELETE SET NULL rather than cascade: if a
-- cost line is ever removed, the receipt itself must survive — it is a photo of
-- a real purchase, and 20260959000000 already treats receipts as a record with
-- retention weight.
alter table receipts
  add column if not exists job_cost_id uuid references job_costs(id) on delete set null;

-- The other half of "one receipt, one line, ever", said in the schema rather
-- than only in the function. `_post_receipt_job_cost` takes a row lock so two
-- concurrent posts cannot both insert; this makes a duplicate impossible even
-- if some future caller forgets the lock. Partial, because "not posted yet" is
-- the normal state and every unposted receipt would otherwise collide on null.
create unique index if not exists receipts_one_job_cost
  on receipts (job_cost_id) where job_cost_id is not null;

-- "Bill this to the customer?" travels with the money. Nullable on purpose,
-- exactly like receipts.is_passthrough: null means nobody has answered yet, and
-- printing "not billable" over an unanswered question would be a claim the app
-- has no right to make.
alter table job_costs
  add column if not exists billable boolean;

comment on column receipts.job_cost_id is
  'The job_costs line this receipt became, stamped by review_receipt. Set once and never cleared — it is what makes "one receipt, at most one cost line, ever" true across un-reviewing, re-reviewing, and a later bank match (Wave Z, Z4).';
comment on column job_costs.billable is
  'Passed through to the customer? Copied from the receipt''s is_passthrough and kept in step with it. Null means nobody has answered yet.';

create index if not exists receipts_cost_code_idx on receipts (cost_code_id);

-- ---- set_receipt_cost_code ------------------------------------------------
-- A narrow writer rather than a tenth argument on update_receipt. That
-- function's full-record contract exists so a field edit cannot race the
-- fill-missing-only extraction — a real hazard for amount/vendor/date, which a
-- machine also writes. Nothing but a human ever writes a cost code, so it needs
-- no such protection, and adding an argument would mean DROPPING and recreating
-- update_receipt (a new argument list is a different function to Postgres, so
-- `create or replace` would leave an ambiguous overload behind) and would let
-- any phone still running yesterday's bundle blank the code on its next save.
create or replace function public.set_receipt_cost_code(
  p_id uuid,
  p_cost_code_id uuid
)
returns receipts
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_uploader uuid;
  v_row receipts;
begin
  select uploaded_by into v_uploader from receipts where id = p_id;
  if v_uploader is null then
    raise exception 'no such receipt';
  end if;
  -- The same floor update_receipt uses: the person who filed it, or the office.
  if not (v_uid = v_uploader or public.my_role_rank() >= 2) then
    raise exception 'only the uploader or a supervisor can change this receipt'
      using errcode = '42501';
  end if;
  if p_cost_code_id is not null
     and not exists (select 1 from cost_codes where id = p_cost_code_id) then
    raise exception 'that is not a cost code we have';
  end if;

  update receipts set cost_code_id = p_cost_code_id
   where id = p_id
  returning * into v_row;

  return v_row;
end;
$$;

comment on function public.set_receipt_cost_code(uuid, uuid) is
  'Uploader-or-supervisor: which kind of purchase this receipt was. A narrow writer on purpose — see the function body for why it is not a tenth argument on update_receipt.';

revoke all on function public.set_receipt_cost_code(uuid, uuid) from public, anon;
grant execute on function public.set_receipt_cost_code(uuid, uuid) to authenticated;


-- ---- the bridge itself ----------------------------------------------------
-- Internal: called by review_receipt, and by match_bank_transaction in Z5.
-- Never granted to any client role — a definer function calling it runs as the
-- table owner, which is the only caller it should ever have.
--
-- Refuses to post silently when it cannot: no job means the money is not on a
-- job, and no amount means there is nothing to post. Both return null and leave
-- the receipt exactly as it was.
create or replace function public._post_receipt_job_cost(p_receipt_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r receipts;
  v_label text;
  v_cost_id uuid;
begin
  -- FOR UPDATE, and it is the whole reason "one receipt, one line, ever" is a
  -- rule rather than a hope. Without it this is a read-then-write: review_receipt
  -- and match_bank_transaction can run against the same receipt at the same
  -- moment, both see job_cost_id null in their own READ COMMITTED snapshot, both
  -- insert a ledger line, and the second `update receipts` overwrites the first
  -- one's stamp — leaving an orphaned duplicate the job is billed for twice. The
  -- lock makes the second caller wait, re-read the committed stamp, and return
  -- the line that already exists. A disabled button in the client is not a lock.
  select * into r from receipts where id = p_receipt_id for update;
  if not found then return null; end if;
  -- Already posted. THE rule of this section: one receipt, one line, ever.
  if r.job_cost_id is not null then return r.job_cost_id; end if;
  if r.project_id is null then return null; end if;
  if r.amount_cents is null then return null; end if;

  -- The vendor is what a person reading the ledger recognises; the note is what
  -- they wrote to explain it. Both, when both exist.
  v_label := coalesce(nullif(btrim(r.vendor), ''), 'Receipt');
  if nullif(btrim(coalesce(r.note, '')), '') is not null then
    v_label := v_label || ' — ' || btrim(r.note);
  end if;

  insert into job_costs (project_id, category, label, amount, cost_date, billable, created_by)
  values (
    r.project_id,
    -- Every receipt posts as `materials`. Gas is the other category a receipt
    -- carries, and gas on a job IS a material cost of that job; splitting it
    -- into `other` would just make two lines nobody can add up.
    'materials',
    v_label,
    r.amount_cents / 100.0,
    coalesce(r.purchased_on, current_date),
    r.is_passthrough,
    coalesce(r.reviewed_by, r.uploaded_by)
  )
  returning id into v_cost_id;

  update receipts set job_cost_id = v_cost_id where id = p_receipt_id;
  return v_cost_id;
end;
$$;

comment on function public._post_receipt_job_cost(uuid) is
  'Internal: turn a receipt into its ONE job_costs line and stamp receipts.job_cost_id. Returns the existing line id if it already posted, or null when there is no job or no amount to post. Called by review_receipt and by match_bank_transaction — never by a client.';

revoke all on function public._post_receipt_job_cost(uuid) from public, anon, authenticated;


-- ---- review_receipt now posts ---------------------------------------------
-- Same signature, so every caller and every grant is untouched.
create or replace function public.review_receipt(
  p_id uuid,
  p_reviewed boolean default true
)
returns receipts
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row receipts;
begin
  if public.my_role_rank() < 2 then
    raise exception 'only a supervisor or above can review a receipt'
      using errcode = '42501';
  end if;

  -- Reviewing a receipt that is on a job and has no amount would mark it
  -- correct and post nothing, which is the quiet failure this bridge exists to
  -- end. Say so instead. A JOBLESS receipt (gas, the common case) reviews fine
  -- with or without an amount — there is nothing for it to post to.
  if p_reviewed and exists (
    select 1 from receipts
     where id = p_id and project_id is not null
       and amount_cents is null and job_cost_id is null
  ) then
    raise exception 'Add the amount before you review this one — the job cost line needs it.';
  end if;

  update receipts set
    reviewed_by = case when p_reviewed then auth.uid() else null end,
    reviewed_at = case when p_reviewed then now() else null end
  where id = p_id
  returning * into v_row;

  if v_row.id is null then
    raise exception 'no such receipt';
  end if;

  if p_reviewed then
    -- Un-reviewing deliberately does NOT unpost. The money left the company
    -- whatever the office later decides about the paperwork, and deleting a
    -- ledger line because somebody unticked a box is how a ledger stops being
    -- one. The receipt reads "posted" from here on.
    perform public._post_receipt_job_cost(p_id);
    select * into v_row from receipts where id = p_id;
  end if;

  return v_row;
end;
$$;

comment on function public.review_receipt(uuid, boolean) is
  'Supervisor+ marks (or unmarks) a receipt reviewed. Reviewing one that names a job posts its single job_costs line (Wave Z, Z4); un-reviewing leaves that line standing, because the money was still spent.';


-- ---- who may still edit a receipt once it has posted ----------------------
-- update_receipt is uploader-OR-supervisor (20260957000000): the installer who
-- snapped the photo can fix up their own receipt, which is right, because they
-- are the one who knows what they bought.
--
-- It stops being right the moment that receipt becomes a line in the cost
-- ledger. From then on the same call would move a posted ledger line — its
-- amount, its date, its label, its billable flag, even which JOB it is on —
-- through the sync trigger below, which runs as the table owner. A supervisor
-- reviewed that line; nobody would review it again, and nothing would say it
-- moved. That is a write path from an installer's phone into the company's
-- books, and it needs closing at the source rather than in the trigger, so the
-- refusal is a sentence a person reads instead of a silent no-op.
--
-- Supervisor+ keeps the edit, because the spec's own rule is that fixing the
-- amount afterwards moves the line with it — the office is who does that.
-- Everything else about this function is byte-for-byte 20260957000000's.
create or replace function public.update_receipt(
  p_id uuid,
  p_project_id uuid,
  p_pending_job_name text,
  p_amount_cents int,
  p_vendor text,
  p_purchased_on date,
  p_category text,
  p_is_passthrough boolean,
  p_note text
)
returns receipts
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_uploader uuid;
  v_job_cost uuid;
  v_pending text := nullif(btrim(coalesce(p_pending_job_name, '')), '');
  v_row receipts;
begin
  select uploaded_by, job_cost_id into v_uploader, v_job_cost
    from receipts where id = p_id;
  if v_uploader is null then
    raise exception 'no such receipt';
  end if;
  if not (v_uid = v_uploader or public.my_role_rank() >= 2) then
    raise exception 'only the uploader or a supervisor can edit this receipt'
      using errcode = '42501';
  end if;
  -- Wave Z: posted is posted. The uploader's own edit stops here.
  if v_job_cost is not null and public.my_role_rank() < 2 then
    raise exception 'This receipt is already on the job''s costs. Ask the office to change it.'
      using errcode = '42501';
  end if;
  if p_project_id is not null and v_pending is not null then
    raise exception 'a receipt names a real job or a waiting-job name, never both';
  end if;
  if p_category is not null and p_category not in ('gas', 'other') then
    raise exception 'category must be gas or other';
  end if;
  if p_amount_cents is not null and p_amount_cents < 0 then
    raise exception 'amount cannot be negative';
  end if;

  update receipts set
    project_id      = p_project_id,
    pending_job_name = v_pending,
    amount_cents    = p_amount_cents,
    vendor          = nullif(btrim(coalesce(p_vendor, '')), ''),
    purchased_on    = p_purchased_on,
    category        = p_category,
    category_by     = case
      when p_category is null then null
      when category is distinct from p_category then 'manual'
      else category_by
    end,
    is_passthrough  = p_is_passthrough,
    note            = nullif(btrim(coalesce(p_note, '')), '')
  where id = p_id
  returning * into v_row;

  return v_row;
end;
$$;

comment on function public.update_receipt(uuid, uuid, text, int, text, date, text, boolean, text) is
  'Uploader-or-supervisor field edits (full-record overwrite, file_daily_log-style). Changing category here pins category_by=''manual'' forever; resending the same category value leaves its provenance untouched. Wave Z: once the receipt has posted to job_costs only a supervisor+ may edit it, because the edit moves a reviewed ledger line.';

revoke all on function public.update_receipt(uuid, uuid, text, int, text, date, text, boolean, text) from public, anon;
grant execute on function public.update_receipt(uuid, uuid, text, int, text, date, text, boolean, text) to authenticated;


-- ---- the posted line follows the receipt ----------------------------------
-- Editing a receipt's amount after it posted has to move the ledger line with
-- it, or the two disagree and the receipt photo stops being evidence for the
-- number. A trigger rather than a line inside update_receipt, because
-- apply_receipt_extraction writes the same fields and a rule enforced in two
-- writers is a rule enforced in neither.
create or replace function public.sync_receipt_job_cost()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_label text;
begin
  v_label := coalesce(nullif(btrim(new.vendor), ''), 'Receipt');
  if nullif(btrim(coalesce(new.note, '')), '') is not null then
    v_label := v_label || ' — ' || btrim(new.note);
  end if;

  update job_costs set
    project_id = coalesce(new.project_id, project_id),
    label      = v_label,
    amount     = coalesce(new.amount_cents / 100.0, amount),
    cost_date  = coalesce(new.purchased_on, cost_date),
    billable   = new.is_passthrough
  where id = new.job_cost_id;

  return null;
end;
$$;

comment on function public.sync_receipt_job_cost() is
  'Keeps a posted receipt''s job_costs line in step with the receipt: one source of truth for the amount, the date, the vendor and the bill-to-customer flag (Wave Z, Z4).';

revoke all on function public.sync_receipt_job_cost() from public, anon, authenticated;

drop trigger if exists trg_receipt_syncs_its_job_cost on receipts;
create trigger trg_receipt_syncs_its_job_cost
  after update on receipts
  for each row
  when (
    new.job_cost_id is not null
    -- Unchanged, so this is an edit to an ALREADY posted receipt — not the
    -- stamp _post_receipt_job_cost just made, whose line was built from these
    -- very values a moment ago.
    and old.job_cost_id is not distinct from new.job_cost_id
    and (
      old.amount_cents is distinct from new.amount_cents
      or old.purchased_on is distinct from new.purchased_on
      or old.vendor is distinct from new.vendor
      or old.note is distinct from new.note
      or old.is_passthrough is distinct from new.is_passthrough
      or old.project_id is distinct from new.project_id
    )
  )
  execute function public.sync_receipt_job_cost();


-- ===========================================================================
-- 5. Z5 — the company card statement, and which charges have no receipt
-- ===========================================================================
-- The bookkeeper exports the card feed and wants one answer: which of these
-- charges has nobody handed in a receipt for? That is the whole feature.
--
-- NO BANK CREDENTIALS EVER TOUCH THIS APP. The handoff is a FILE — somebody
-- downloads the export and drops it in. There is no live feed here and there is
-- not going to be one; a live connection is parked with the future QuickBooks
-- link.
--
-- Neither table is project-scoped (a card charge is not about a job until it is
-- matched to a receipt that names one), so neither takes a sandbox guard.
create table if not exists bank_imports (
  id uuid primary key default gen_random_uuid(),
  imported_by uuid references profiles(id) on delete set null,
  filename text,
  imported_at timestamptz not null default now(),
  row_count integer not null default 0,
  -- Set by undo_bank_import. The batch row SURVIVES the undo, so "we imported
  -- that file on Tuesday and took it back on Wednesday" is still readable —
  -- an import that vanished would look like it never happened.
  undone_at timestamptz
);

create table if not exists bank_transactions (
  id uuid primary key default gen_random_uuid(),
  import_id uuid not null references bank_imports(id) on delete cascade,
  posted_on date,
  -- Cents, and NOT NULL: a charge with no amount is not a charge. Signed,
  -- because a refund is a real line on a statement and forcing it positive
  -- would make the month stop adding up.
  amount_cents integer not null,
  description text,
  vendor_guess text,
  cardholder text,
  -- The bank's own id for the charge when the export carries one.
  external_id text,
  receipt_id uuid references receipts(id) on delete set null,
  status text not null default 'unreceipted'
    check (status in ('matched', 'unreceipted', 'ignored')),
  -- What "the same charge" means, so re-importing an overlapping file adds
  -- nothing: the bank's own id when there is one, else a hash of date + amount
  -- + description + CARDHOLDER, plus which occurrence of that hash the line is
  -- within the file. Computed by the RPC (never by the client) and UNIQUE, so
  -- the dedup is the database's job and not a read-then-write somebody could
  -- race. Two crew filling up at the same pump for the same money on the same
  -- morning are two charges, and so are one person's two identical purchases.
  dedupe_key text not null unique,
  created_at timestamptz not null default now()
);

-- One receipt answers for at most one charge. A partial index rather than a
-- plain UNIQUE, because "no receipt yet" is the normal state and every
-- unmatched row would otherwise collide on null.
create unique index if not exists bank_transactions_one_receipt
  on bank_transactions (receipt_id) where receipt_id is not null;

create index if not exists bank_transactions_import_idx
  on bank_transactions (import_id);
create index if not exists bank_transactions_open_idx
  on bank_transactions (status, posted_on desc);

comment on table bank_imports is
  'One dropped-in card statement export. Undoable as a batch — undo_bank_import drops the rows nobody matched and unmatches the rest — and the batch row survives the undo so the history reads honestly (Wave Z, Z5).';
comment on table bank_transactions is
  'One charge off a company card statement, and the receipt somebody handed in for it (or the fact that nobody did). No bank credentials are involved anywhere: the handoff is a file a person exports and drops in.';
comment on column bank_transactions.dedupe_key is
  'What "the same charge" means across two imports of overlapping files: the bank''s external_id when the export has one, else a hash of date + amount + description + cardholder with the line''s occurrence number appended. UNIQUE, so re-importing last month adds nothing while two genuinely identical charges stay two charges.';

alter table bank_imports enable row level security;
alter table bank_transactions enable row level security;

-- Revoke first (Supabase's defaults grant `authenticated` everything on a new
-- public table), then grant back SELECT alone: the five RPCs below are the only
-- writers, so there is no direct path that could skip their checks.
revoke all on bank_imports from anon, authenticated;
revoke all on bank_transactions from anon, authenticated;
grant select on bank_imports to authenticated;
grant select on bank_transactions to authenticated;
grant all on bank_imports to service_role;
grant all on bank_transactions to service_role;

drop policy if exists "bank_imports_cost_seers" on bank_imports;
create policy "bank_imports_cost_seers" on bank_imports
  for select to authenticated
  using (not public.is_partner_user() and public.can_see_costs(auth.uid()));

drop policy if exists "bank_transactions_cost_seers" on bank_transactions;
create policy "bank_transactions_cost_seers" on bank_transactions
  for select to authenticated
  using (not public.is_partner_user() and public.can_see_costs(auth.uid()));


-- ---- import_bank_transactions ---------------------------------------------
-- Takes the rows the browser read out of the file, already mapped to the four
-- fields that matter. The MAPPING is deliberately the client's job and a step a
-- human confirms: nobody here knows what column names any particular export
-- uses, and guessing them in SQL would bake one bank's spelling into the
-- database forever.
--
-- Dedup is `on conflict (dedupe_key) do nothing`, so importing a file that
-- overlaps last month's adds only what is genuinely new, and the count of what
-- landed is the difference — no read-then-write, nothing to race.
create or replace function public.import_bank_transactions(
  p_rows jsonb,
  p_filename text default null
)
returns bank_imports
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_import bank_imports;
  v_added integer;
begin
  if not public.can_see_costs(auth.uid()) then
    raise exception 'Only an owner, or somebody given "Sees costs", can import the card statement.'
      using errcode = '42501';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'That file did not read as a list of charges.';
  end if;

  insert into bank_imports (imported_by, filename, row_count)
  values (auth.uid(), nullif(btrim(coalesce(p_filename, '')), ''), jsonb_array_length(p_rows))
  returning * into v_import;

  -- WITH ORDINALITY, because the position of a line in the file is the only
  -- thing that tells two genuinely identical lines apart — see the key below.
  with incoming as (
    select
      nullif(btrim(coalesce(t.r ->> 'posted_on', '')), '')::date       as posted_on,
      (t.r ->> 'amount_cents')::integer                                as amount_cents,
      nullif(btrim(coalesce(t.r ->> 'description', '')), '')           as description,
      nullif(btrim(coalesce(t.r ->> 'vendor_guess', '')), '')          as vendor_guess,
      nullif(btrim(coalesce(t.r ->> 'cardholder', '')), '')            as cardholder,
      nullif(btrim(coalesce(t.r ->> 'external_id', '')), '')           as external_id,
      t.ord                                                            as ord
    from jsonb_array_elements(p_rows) with ordinality as t(r, ord)
  ),
  -- CARDHOLDER IS PART OF THE KEY. Two people on the crew filling up at the
  -- same station on the same morning for the same $52.00 is an ordinary
  -- Tuesday, not a double entry — and the first draft of this hashed only date
  -- + amount + description, so one of those two charges silently never reached
  -- the "No receipt yet" list. Real money, gone from the one report this
  -- feature exists to produce.
  based as (
    select i.*,
           md5(
             coalesce(i.posted_on::text, '') || '|' ||
             i.amount_cents::text || '|' ||
             lower(coalesce(i.description, '')) || '|' ||
             lower(coalesce(i.cardholder, ''))
           ) as base
      from incoming i
     where i.amount_cents is not null
  ),
  -- And even with the cardholder in it, one person CAN buy the same thing
  -- twice in a day. So a charge with no id of its own is keyed by its base plus
  -- which occurrence of that base it is — "#1", "#2" — counted in file order.
  -- That is stable across re-imports (the same file yields the same numbering,
  -- so `on conflict do nothing` still swallows the whole overlap) while two
  -- identical lines stay two charges. Rows that carry the bank's own id are
  -- counted separately, so mixing them into a file cannot shift the numbering
  -- of the ones that do not.
  keyed as (
    select b.*,
           coalesce(
             b.external_id,
             b.base || '#' || row_number() over (
               partition by b.base, (b.external_id is null) order by b.ord
             )
           ) as dedupe_key
      from based b
  ),
  -- What is left to collapse is a file that repeats one of the bank's OWN ids,
  -- which is the bank claiming those are the same charge. Take it at its word.
  deduped as (
    select distinct on (dedupe_key) * from keyed order by dedupe_key, ord
  ),
  inserted as (
    insert into bank_transactions
      (import_id, posted_on, amount_cents, description, vendor_guess, cardholder,
       external_id, dedupe_key)
    select v_import.id, posted_on, amount_cents, description, vendor_guess, cardholder,
           external_id, dedupe_key
      from deduped
    on conflict (dedupe_key) do nothing
    returning 1
  )
  select count(*) into v_added from inserted;

  update bank_imports set row_count = v_added where id = v_import.id
  returning * into v_import;

  return v_import;
end;
$$;

comment on function public.import_bank_transactions(jsonb, text) is
  'Cost-seers only: file one dropped-in card statement. Rows arrive already mapped by the browser (the header-mapping step a human confirms), and a charge already imported from an overlapping file is dropped by the dedupe_key unique index. Two identical lines inside one file are two charges, not one. row_count is what actually LANDED, not what was in the file.';

revoke all on function public.import_bank_transactions(jsonb, text) from public, anon;
grant execute on function public.import_bank_transactions(jsonb, text) to authenticated;


-- ---- match / unmatch / ignore ---------------------------------------------
-- Matching is the moment a charge and a receipt become one fact. It is also,
-- per the spec, the moment the Z4 bridge fires: a card charge with a receipt
-- that names a job is money spent on that job, evidenced twice.
create or replace function public.match_bank_transaction(
  p_txn_id uuid,
  p_receipt_id uuid
)
returns bank_transactions
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row bank_transactions;
begin
  if not public.can_see_costs(auth.uid()) then
    raise exception 'Only an owner, or somebody given "Sees costs", can match a card charge.'
      using errcode = '42501';
  end if;
  if not exists (select 1 from receipts where id = p_receipt_id) then
    raise exception 'That receipt is not here any more.';
  end if;
  -- One receipt answers for one charge. The unique index would refuse anyway;
  -- this turns a constraint-violation string into a sentence a person can act
  -- on.
  if exists (
    select 1 from bank_transactions
     where receipt_id = p_receipt_id and id <> p_txn_id
  ) then
    raise exception 'That receipt is already matched to another charge.';
  end if;

  update bank_transactions
     set receipt_id = p_receipt_id, status = 'matched'
   where id = p_txn_id
  returning * into v_row;

  if v_row.id is null then
    raise exception 'no such charge';
  end if;

  -- The Z4 bridge. Does nothing unless the receipt names a job, has an amount,
  -- and has not already posted — see _post_receipt_job_cost.
  perform public._post_receipt_job_cost(p_receipt_id);

  return v_row;
end;
$$;

comment on function public.match_bank_transaction(uuid, uuid) is
  'Cost-seers only: this charge is that receipt. One receipt answers for at most one charge. Matching also fires the Z4 bridge, so a card charge whose receipt names a job reaches the cost ledger.';

create or replace function public.unmatch_bank_transaction(p_txn_id uuid)
returns bank_transactions
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row bank_transactions;
begin
  if not public.can_see_costs(auth.uid()) then
    raise exception 'Only an owner, or somebody given "Sees costs", can unmatch a card charge.'
      using errcode = '42501';
  end if;

  -- Unmatching says "that was the wrong receipt", not "that money was never
  -- spent". The job cost line the match posted stays exactly where it is, the
  -- same way un-reviewing does not unpost one.
  update bank_transactions
     set receipt_id = null, status = 'unreceipted'
   where id = p_txn_id
  returning * into v_row;

  if v_row.id is null then
    raise exception 'no such charge';
  end if;
  return v_row;
end;
$$;

create or replace function public.ignore_bank_transaction(
  p_txn_id uuid,
  p_ignored boolean default true
)
returns bank_transactions
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row bank_transactions;
begin
  if not public.can_see_costs(auth.uid()) then
    raise exception 'Only an owner, or somebody given "Sees costs", can set a card charge aside.'
      using errcode = '42501';
  end if;

  -- Set aside, never deleted. A charge somebody decided needs no receipt is
  -- still a charge, and the statement has to keep adding up.
  update bank_transactions
     set status = case
       when p_ignored then 'ignored'
       when receipt_id is not null then 'matched'
       else 'unreceipted'
     end
   where id = p_txn_id
  returning * into v_row;

  if v_row.id is null then
    raise exception 'no such charge';
  end if;
  return v_row;
end;
$$;

comment on function public.ignore_bank_transaction(uuid, boolean) is
  'Cost-seers only: set a charge aside as needing no receipt (or put it back). Never deletes — the statement still has to add up.';

revoke all on function public.match_bank_transaction(uuid, uuid) from public, anon;
revoke all on function public.unmatch_bank_transaction(uuid) from public, anon;
revoke all on function public.ignore_bank_transaction(uuid, boolean) from public, anon;
grant execute on function public.match_bank_transaction(uuid, uuid) to authenticated;
grant execute on function public.unmatch_bank_transaction(uuid) to authenticated;
grant execute on function public.ignore_bank_transaction(uuid, boolean) to authenticated;


-- ---- undo_bank_import ------------------------------------------------------
-- Every import is undoable as a batch, because the fix for "I dropped in the
-- wrong file" must not be forty taps.
--
-- Asymmetric on purpose: rows NOBODY touched are dropped, and rows somebody has
-- since matched or set aside are kept and merely unmatched. A person's decision
-- about which receipt answers which charge is work, and an undo that threw it
-- away would be a worse mistake than the one it is undoing.
create or replace function public.undo_bank_import(p_import_id uuid)
returns bank_imports
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row bank_imports;
begin
  if not public.can_see_costs(auth.uid()) then
    raise exception 'Only an owner, or somebody given "Sees costs", can undo an import.'
      using errcode = '42501';
  end if;

  -- Nobody has touched these: they go.
  delete from bank_transactions
   where import_id = p_import_id
     and receipt_id is null
     and status = 'unreceipted';

  -- Somebody said "that receipt answers for this charge". The charge stays and
  -- goes back on the list; the job cost line the match posted stands, because
  -- the money was still spent.
  update bank_transactions
     set receipt_id = null, status = 'unreceipted'
   where import_id = p_import_id
     and status = 'matched';

  -- Rows somebody set aside as needing no receipt are left exactly as they are.
  -- That is a decision about a charge, and an undo of the IMPORT has no
  -- business reversing it.

  update bank_imports set undone_at = now()
   where id = p_import_id
  returning * into v_row;

  if v_row.id is null then
    raise exception 'no such import';
  end if;
  return v_row;
end;
$$;

comment on function public.undo_bank_import(uuid) is
  'Cost-seers only: take one whole import back. Charges nobody touched are dropped; matched charges are kept and unmatched; charges somebody set aside stay set aside — a person''s decision is work an undo has no business throwing away. Any job cost lines the matches posted stand, because the money was still spent.';

revoke all on function public.undo_bank_import(uuid) from public, anon;
grant execute on function public.undo_bank_import(uuid) to authenticated;


-- ===========================================================================
-- 99. Re-arm the sandbox fence
-- ===========================================================================
-- project_financials carries a `project_id`, which is what makes a table
-- project-scoped (sandbox_scoped_tables, 20260967000000). Without this line a
-- QA test login could write a bid on ANY job, not only its sandbox ones —
-- scripts/test_sandbox_guard.py fails CI for exactly this omission. Idempotent:
-- a table already correctly guarded is left alone rather than re-triggered.
select public.attach_sandbox_guards();
