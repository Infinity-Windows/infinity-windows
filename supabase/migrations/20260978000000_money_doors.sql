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
returns table (profile_id uuid, can_see_costs boolean, can_see_pay boolean)
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
