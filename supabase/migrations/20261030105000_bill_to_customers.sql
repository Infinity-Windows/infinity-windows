-- Who each job's labor is billed to (owner decisions Q1-Q4, 2026-09-25).
--
-- THE PROBLEM. Every Friday the invoice script (forge-stg-invoice, week.py)
-- reads Enrique's "Job timecards" export and has to decide, per job, which
-- QuickBooks customer gets the invoice. The app never said. The script kept its
-- own map and asked Enrique, and an invoice PDF made outside Forge once guessed
-- from the job's builder name ("Bill To: Richardson Brothers" on ESH-18, a blank
-- on HURRICANE24). Both were wrong: every current job bills to STG Windows and
-- Doors. A job's customer or builder is NOT who pays us, so nothing here ever
-- derives the bill-to from projects.customer_name or the GC fields. It comes
-- from one place: the per-job choice below.
--
-- WHAT THIS ADDS
--   1. bill_to_customers: the short list of companies we bill (name, optional
--      billing email, optional QuickBooks customer id as bare digits). Seeded
--      with the two NAMES only, spelled exactly as they are in QuickBooks so the
--      script can match before anybody types an id. The repo is public, so
--      emails and ids are typed in the app, never written here. Supervisors and
--      the owner manage it. A customer is RETIRED, never deleted: old exports
--      and the change log keep pointing at it.
--   2. project_bill_to: one row per job, bill_to_customer_id NOT NULL. Every
--      existing job is backfilled to the default (STG Windows and Doors, per the
--      owner: no exceptions, ESH-18 and HURRICANE24 included) and a trigger on
--      `projects` gives every NEW job the default the moment it is inserted, so
--      every create path is covered without touching any of them: the Jobs
--      screen, one-tap tracking jobs, the Monday intake, Forge AI field jobs, a
--      migration, a SQL console.
--   3. project_bill_to_history: who changed a job's bill-to, from what, to
--      what, and when.
--
-- WHY A SIDE TABLE AND NOT A COLUMN ON `projects`. `projects` is read whole
-- (select("*")) by every crew phone and by a granted builder login, and RLS
-- cannot hide one column of a row. Who pays us is money, so it follows the road
-- project_financials (20260978000000) and project_pipeline (20260981000000)
-- already took: a table of its own with a policy of its own, one row per job,
-- the job id as its primary key.
--
-- WHO SEES IT: supervisors, the owner, and anybody the owner granted "Sees
-- costs" (profiles.can_see_costs). Never a builder login, never a retired or
-- revoked login. can_see_bill_to() below is the one predicate every policy
-- here calls. It is wider than can_see_costs() on purpose: that one opens at
-- owner rank, this one at supervisor, because supervisors run the billing week.
--
-- WHO CHANGES IT: supervisors and the owner, through the three RPCs below and
-- nothing else. None of the three tables grants a client role any write.
--
-- WHY NOT project_execution_history FOR THE LOG. It is the right shape and the
-- wrong audience: its read policy opens at foreman, and a foreman must not
-- learn who a job bills to from its change log. So the log copies that
-- table's shape (job, before, after, who, when) under this file's policy.
--
-- Idempotent: create ... if not exists, create or replace, on conflict, and a
-- drop before every policy and trigger.


-- ===========================================================================
-- 1. The two predicates
-- ===========================================================================
-- SECURITY DEFINER for the reasons can_see_costs() gives: policies on other
-- tables call them, and they read profiles columns a caller may hold no
-- privilege on. STABLE so a policy evaluates them once per statement.
-- A missing profile answers false: "we do not know who this is" has one safe
-- reading.

create or replace function public.can_see_bill_to(p_uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select (public.role_rank(p.role) >= 2 or p.can_see_costs)
            and not coalesce(p.is_partner, false)
            and p.retired_at is null
            and p.access_revoked_at is null
       from public.profiles p
      where p.id = p_uid),
    false);
$$;

comment on function public.can_see_bill_to(uuid) is
  'True when this person may read who a job bills to: a supervisor, the owner, or somebody the owner granted "Sees costs" (profiles.can_see_costs) - never a builder login, a retired or a revoked login. The single predicate every bill-to policy calls (20261030105000).';

revoke all on function public.can_see_bill_to(uuid) from public, anon;
grant execute on function public.can_see_bill_to(uuid) to authenticated, service_role;

create or replace function public.can_manage_bill_to(p_uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select public.role_rank(p.role) >= 2
            and not coalesce(p.is_partner, false)
            and p.retired_at is null
            and p.access_revoked_at is null
       from public.profiles p
      where p.id = p_uid),
    false);
$$;

comment on function public.can_manage_bill_to(uuid) is
  'True when this person may change the bill-to list or a job''s bill-to: a supervisor or the owner who is a current login. "Sees costs" alone reads, it does not write (owner decision Q1, 2026-09-25).';

revoke all on function public.can_manage_bill_to(uuid) from public, anon;
grant execute on function public.can_manage_bill_to(uuid) to authenticated, service_role;


-- ===========================================================================
-- 2. The list
-- ===========================================================================
create table if not exists public.bill_to_customers (
  id uuid primary key default gen_random_uuid(),
  -- Exactly as QuickBooks spells it: the export writes it verbatim and the
  -- invoice script matches on it when no id has been typed yet.
  name text not null,
  billing_email text,
  -- Bare digits, as QuickBooks shows them; typed in the app, never seeded
  -- here (the repo is public). Text, not a number,
  -- so the export writes exactly what was typed and a spreadsheet never turns
  -- it into 4.0.
  quickbooks_customer_id text,
  -- The one customer a new job starts on. At most one row can hold it (index
  -- below) and it cannot be retired (check below and the retire RPC).
  is_default boolean not null default false,
  retired_at timestamptz,
  retired_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null,
  constraint bill_to_customers_name_ck
    check (name = btrim(name) and length(name) between 1 and 120),
  constraint bill_to_customers_email_ck
    check (billing_email is null
           or (length(billing_email) <= 254
               and billing_email ~ '^[^[:space:]@]+@[^[:space:]@]+$')),
  constraint bill_to_customers_quickbooks_id_ck
    check (quickbooks_customer_id is null
           or quickbooks_customer_id ~ '^[0-9]{1,20}$'),
  constraint bill_to_customers_default_is_active_ck
    check (not (is_default and retired_at is not null))
);

-- Two rows called "Strata" and "strata" would leave the invoice script two
-- answers for one name, and two rows with one QuickBooks id two names for one
-- customer. Retired rows count: un-retire the old one instead of re-adding it.
create unique index if not exists bill_to_customers_name_key
  on public.bill_to_customers (lower(name));
create unique index if not exists bill_to_customers_quickbooks_id_key
  on public.bill_to_customers (quickbooks_customer_id)
  where quickbooks_customer_id is not null;
create unique index if not exists bill_to_customers_one_default
  on public.bill_to_customers ((true))
  where is_default;

comment on table public.bill_to_customers is
  'The companies Forge bills for its labor (owner decisions Q1-Q4, 2026-09-25). Read by supervisors, the owner and "Sees costs" holders (can_see_bill_to); written only by save_bill_to_customer / set_bill_to_customer_retired (supervisor+). Retired, never deleted.';

-- The names only, exactly as QuickBooks has them. No email, no id: the repo is
-- public, and those are typed in the app.
insert into public.bill_to_customers (name, is_default)
values ('STG Windows and Doors', true),
       ('Strata', false)
on conflict do nothing;


-- ===========================================================================
-- 3. Each job's bill-to, and its change log
-- ===========================================================================
create table if not exists public.project_bill_to (
  project_id uuid primary key references public.projects(id) on delete cascade,
  bill_to_customer_id uuid not null references public.bill_to_customers(id),
  updated_at timestamptz not null default now(),
  -- auth.uid() from the RPC, never the browser's claim. Null for the default a
  -- job was born with, which nobody chose.
  updated_by uuid references public.profiles(id) on delete set null
);

create index if not exists project_bill_to_customer_idx
  on public.project_bill_to (bill_to_customer_id);

comment on table public.project_bill_to is
  'Who this job''s labor is billed to: one row per job, NOT NULL, default STG Windows and Doors (20261030105000). A side table, not a projects column, because projects is read whole by every crew phone and by builder logins. Read by can_see_bill_to(); written only by the default trigger on projects and by set_project_bill_to (supervisor+).';

create table if not exists public.project_bill_to_history (
  id bigint generated always as identity primary key,
  project_id uuid not null references public.projects(id) on delete cascade,
  from_customer_id uuid references public.bill_to_customers(id),
  to_customer_id uuid not null references public.bill_to_customers(id),
  changed_by uuid references public.profiles(id) on delete set null,
  changed_at timestamptz not null default now()
);

create index if not exists project_bill_to_history_job_idx
  on public.project_bill_to_history (project_id, changed_at desc);

comment on table public.project_bill_to_history is
  'Every change of a job''s bill-to: from, to, who and when. Append-only; written only by set_project_bill_to. Same shape as project_execution_history, kept apart because that log is readable at foreman rank.';

-- Every job that exists today bills to the default (owner, 2026-09-25: no
-- exceptions). Trashed jobs too, so an owner restoring one finds it complete.
insert into public.project_bill_to (project_id, bill_to_customer_id)
select p.id, c.id
  from public.projects p
 cross join public.bill_to_customers c
 where c.is_default
on conflict (project_id) do nothing;

-- Every job made from now on is born with the default, whichever path made it.
-- SECURITY DEFINER because no client role may write project_bill_to; the
-- trigger is the one writer that does not check a rank, and all it can ever
-- write is the default for a job being created in the same statement.
-- If somebody has removed the default by hand, the job is still created: a
-- job with no bill-to exports a blank, which the invoice script holds and asks
-- about, while a refused insert would stop the Monday intake and every new
-- job in the company.
create or replace function public.project_bill_to_default()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.project_bill_to (project_id, bill_to_customer_id)
  select new.id, c.id
    from public.bill_to_customers c
   where c.is_default
  on conflict (project_id) do nothing;
  return null;
end;
$$;

comment on function public.project_bill_to_default() is
  'AFTER INSERT on projects: gives the new job the default bill-to (STG Windows and Doors), so no create path can leave a job without one (20261030105000).';

revoke all on function public.project_bill_to_default() from public, anon, authenticated;

drop trigger if exists project_bill_to_default on public.projects;
create trigger project_bill_to_default
  after insert on public.projects
  for each row execute function public.project_bill_to_default();


-- ===========================================================================
-- 4. Row security: read by can_see_bill_to(), written by nobody directly
-- ===========================================================================
-- Every policy also names is_partner_user() out loud, as the partner wall
-- (20260950000000, scripts/test_partner_wall.py) requires of every SELECT
-- policy, even though can_see_bill_to() already refuses a builder login.
alter table public.bill_to_customers enable row level security;
alter table public.project_bill_to enable row level security;
alter table public.project_bill_to_history enable row level security;

-- Supabase's default privileges hand every new public table the full set to
-- anon and authenticated. Take it all back first (TRUNCATE included: it is not
-- subject to row security), then give back SELECT and nothing else.
revoke all on table public.bill_to_customers from public, anon, authenticated;
revoke all on table public.project_bill_to from public, anon, authenticated;
revoke all on table public.project_bill_to_history from public, anon, authenticated;
grant select on table public.bill_to_customers to authenticated;
grant select on table public.project_bill_to to authenticated;
grant select on table public.project_bill_to_history to authenticated;
grant all on table public.bill_to_customers to service_role;
grant all on table public.project_bill_to to service_role;
grant all on table public.project_bill_to_history to service_role;

drop policy if exists bill_to_customers_read on public.bill_to_customers;
create policy bill_to_customers_read on public.bill_to_customers
  for select to authenticated
  using (not public.is_partner_user() and public.can_see_bill_to(auth.uid()));

drop policy if exists project_bill_to_read on public.project_bill_to;
create policy project_bill_to_read on public.project_bill_to
  for select to authenticated
  using (not public.is_partner_user() and public.can_see_bill_to(auth.uid()));

drop policy if exists project_bill_to_history_read on public.project_bill_to_history;
create policy project_bill_to_history_read on public.project_bill_to_history
  for select to authenticated
  using (not public.is_partner_user() and public.can_see_bill_to(auth.uid()));


-- ===========================================================================
-- 5. The writers (supervisor+)
-- ===========================================================================
-- Add a customer (p_id null) or change one. Blank email or id means "none".
create or replace function public.save_bill_to_customer(
  p_id uuid,
  p_name text,
  p_billing_email text,
  p_quickbooks_customer_id text
)
returns public.bill_to_customers
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.bill_to_customers;
  v_name text := btrim(coalesce(p_name, ''));
  v_email text := nullif(btrim(coalesce(p_billing_email, '')), '');
  v_qb text := nullif(btrim(coalesce(p_quickbooks_customer_id, '')), '');
begin
  if not public.can_manage_bill_to(auth.uid()) then
    raise exception 'Only a supervisor or the owner can change the bill-to list.'
      using errcode = '42501';
  end if;
  if length(v_name) = 0 or length(v_name) > 120 then
    raise exception 'Give the customer a name, up to 120 letters.'
      using errcode = '22023';
  end if;
  if v_email is not null
     and (length(v_email) > 254 or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+$') then
    raise exception 'That billing email does not look right. Check it or leave it blank.'
      using errcode = '22023';
  end if;
  if v_qb is not null and v_qb !~ '^[0-9]{1,20}$' then
    raise exception 'The QuickBooks customer ID is digits only. Leave it blank if you do not know it.'
      using errcode = '22023';
  end if;
  if exists (select 1 from public.bill_to_customers c
              where lower(c.name) = lower(v_name) and c.id is distinct from p_id) then
    raise exception 'A customer with that name is already on the list. If it was retired, bring it back instead.'
      using errcode = '23505';
  end if;
  if v_qb is not null and exists (
       select 1 from public.bill_to_customers c
        where c.quickbooks_customer_id = v_qb and c.id is distinct from p_id) then
    raise exception 'Another customer on the list already has that QuickBooks ID.'
      using errcode = '23505';
  end if;

  if p_id is null then
    insert into public.bill_to_customers
      (name, billing_email, quickbooks_customer_id, created_by, updated_by)
    values (v_name, v_email, v_qb, auth.uid(), auth.uid())
    returning * into v_row;
  else
    update public.bill_to_customers c
       set name = v_name,
           billing_email = v_email,
           quickbooks_customer_id = v_qb,
           updated_at = now(),
           updated_by = auth.uid()
     where c.id = p_id
    returning * into v_row;
    if not found then
      raise exception 'That customer is not on the bill-to list.'
        using errcode = 'P0002';
    end if;
  end if;

  return v_row;
end;
$$;

comment on function public.save_bill_to_customer(uuid, text, text, text) is
  'Supervisor+: add a bill-to customer (p_id null) or change one''s name, billing email or QuickBooks customer id (digits). Blank email/id means none (20261030105000).';

revoke all on function public.save_bill_to_customer(uuid, text, text, text) from public, anon;
grant execute on function public.save_bill_to_customer(uuid, text, text, text) to authenticated;

-- Retire (true) or bring back (false). Never a delete: exports and the change
-- log keep naming a retired customer, and a job already billed to one keeps
-- it. A retired customer simply cannot be picked for a job any more.
create or replace function public.set_bill_to_customer_retired(
  p_id uuid,
  p_retired boolean
)
returns public.bill_to_customers
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.bill_to_customers;
begin
  if not public.can_manage_bill_to(auth.uid()) then
    raise exception 'Only a supervisor or the owner can change the bill-to list.'
      using errcode = '42501';
  end if;
  if p_retired is null then
    raise exception 'Say whether to retire the customer or bring it back.'
      using errcode = '22023';
  end if;

  select * into v_row from public.bill_to_customers c where c.id = p_id for update;
  if not found then
    raise exception 'That customer is not on the bill-to list.'
      using errcode = 'P0002';
  end if;
  if p_retired and v_row.is_default then
    raise exception '% is what every new job bills to, so it cannot be retired.', v_row.name
      using errcode = '22023';
  end if;

  update public.bill_to_customers c
     set retired_at = case when p_retired then coalesce(c.retired_at, now()) end,
         retired_by = case when p_retired then coalesce(c.retired_by, auth.uid()) end,
         updated_at = now(),
         updated_by = auth.uid()
   where c.id = p_id
  returning * into v_row;

  return v_row;
end;
$$;

comment on function public.set_bill_to_customer_retired(uuid, boolean) is
  'Supervisor+: retire a bill-to customer (it can no longer be picked for a job) or bring it back. Never deletes. The default customer cannot be retired (20261030105000).';

revoke all on function public.set_bill_to_customer_retired(uuid, boolean) from public, anon;
grant execute on function public.set_bill_to_customer_retired(uuid, boolean) to authenticated;

-- Change one job's bill-to, and log it. Choosing what it already is changes
-- nothing and logs nothing.
create or replace function public.set_project_bill_to(
  p_project_id uuid,
  p_bill_to_customer_id uuid
)
returns public.project_bill_to
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.project_bill_to;
  v_old uuid;
  v_retired timestamptz;
begin
  if not public.can_manage_bill_to(auth.uid()) then
    raise exception 'Only a supervisor or the owner can change who a job bills to.'
      using errcode = '42501';
  end if;

  select c.retired_at into v_retired
    from public.bill_to_customers c where c.id = p_bill_to_customer_id;
  if not found then
    raise exception 'That customer is not on the bill-to list.'
      using errcode = 'P0002';
  end if;
  if v_retired is not null then
    raise exception 'That customer is retired. Pick one that is still on the list.'
      using errcode = '22023';
  end if;

  perform 1 from public.projects p
    where p.id = p_project_id and p.deleted_at is null;
  if not found then
    raise exception 'That job does not exist or is in the trash.'
      using errcode = 'P0002';
  end if;

  select b.bill_to_customer_id into v_old
    from public.project_bill_to b where b.project_id = p_project_id
    for update;

  if v_old is not distinct from p_bill_to_customer_id then
    select * into v_row from public.project_bill_to b where b.project_id = p_project_id;
    return v_row;
  end if;

  insert into public.project_bill_to
    (project_id, bill_to_customer_id, updated_at, updated_by)
  values (p_project_id, p_bill_to_customer_id, now(), auth.uid())
  on conflict (project_id) do update
    set bill_to_customer_id = excluded.bill_to_customer_id,
        updated_at = excluded.updated_at,
        updated_by = excluded.updated_by
  returning * into v_row;

  insert into public.project_bill_to_history
    (project_id, from_customer_id, to_customer_id, changed_by)
  values (p_project_id, v_old, p_bill_to_customer_id, auth.uid());

  return v_row;
end;
$$;

comment on function public.set_project_bill_to(uuid, uuid) is
  'Supervisor+: choose who a job''s labor is billed to, from the active bill-to list, and log who changed it and when (project_bill_to_history). No-op when unchanged (20261030105000).';

revoke all on function public.set_project_bill_to(uuid, uuid) from public, anon;
grant execute on function public.set_project_bill_to(uuid, uuid) to authenticated;


-- ===========================================================================
-- 6. The test-login fence
-- ===========================================================================
-- project_bill_to and project_bill_to_history carry project_id, so they are
-- project-scoped: a test login may write them only on the sandbox job. Arming
-- it in this same file is what scripts/test_sandbox_guard.py requires.
select public.attach_sandbox_guards();
