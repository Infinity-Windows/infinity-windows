-- Merge: job costing / margin (Big Boss). Bid/revenue on projects, cost ledger,
-- change orders. Margin is computed from these + labor from time_shifts.

alter table projects
  add column if not exists bid_amount numeric,
  add column if not exists target_margin_pct numeric;

create table if not exists job_costs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  category text not null default 'other'
    check (category in ('labor','materials','equipment','subs','other')),
  label text,
  amount numeric not null,
  cost_date date not null default current_date,
  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists change_orders (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  label text not null,
  amount numeric not null,
  created_at timestamptz not null default now()
);

create index if not exists job_costs_project_idx on job_costs (project_id, cost_date desc);
create index if not exists change_orders_project_idx on change_orders (project_id);

alter table job_costs enable row level security;
alter table change_orders enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where tablename='job_costs' and policyname='authenticated full access') then
    create policy "authenticated full access" on job_costs for all to authenticated using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename='change_orders' and policyname='authenticated full access') then
    create policy "authenticated full access" on change_orders for all to authenticated using (true) with check (true);
  end if;
end;
$$;
