-- Merge: Safety, Tools, Supplies, and QC modules.

-- Safety: toolbox talks + acknowledgements + incident log.
create table if not exists safety_talks (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  body text not null,
  talk_date date not null default current_date,
  created_at timestamptz not null default now()
);
create table if not exists safety_acks (
  talk_id uuid not null references safety_talks(id) on delete cascade,
  profile_id uuid not null references profiles(id) on delete cascade,
  ack_at timestamptz not null default now(),
  primary key (talk_id, profile_id)
);
create table if not exists incidents (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid references profiles(id) on delete set null,
  project_id uuid references projects(id) on delete set null,
  description text not null,
  severity text not null default 'near_miss'
    check (severity in ('near_miss','first_aid','recordable','serious')),
  created_at timestamptz not null default now()
);

-- Tools: who has what + calibration due.
create table if not exists tools (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  holder_id uuid references profiles(id) on delete set null,
  calibration_due date,
  note text,
  created_at timestamptz not null default now()
);

-- Supplies: company catalog + per-job orders / pull lists.
create table if not exists supplies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  unit text default 'ea',
  created_at timestamptz not null default now()
);
create table if not exists supply_orders (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references projects(id) on delete cascade,
  supply_id uuid references supplies(id) on delete set null,
  name text,
  qty numeric not null default 1,
  status text not null default 'needed'
    check (status in ('needed','ordered','picked','used')),
  created_at timestamptz not null default now()
);

-- QC: per-opening quality sign-off.
create table if not exists qc_checks (
  id uuid primary key default gen_random_uuid(),
  project_opening_id uuid not null references project_openings(id) on delete cascade,
  status text not null default 'pending'
    check (status in ('pending','passed','callback')),
  note text,
  checked_by uuid references profiles(id) on delete set null,
  checked_at timestamptz,
  created_at timestamptz not null default now(),
  unique (project_opening_id)
);

do $$
declare t text;
begin
  foreach t in array array['safety_talks','safety_acks','incidents','tools','supplies','supply_orders','qc_checks']
  loop
    execute format('alter table %I enable row level security', t);
    if not exists (select 1 from pg_policies where tablename=t and policyname='authenticated full access') then
      execute format('create policy "authenticated full access" on %I for all to authenticated using (true) with check (true)', t);
    end if;
  end loop;
end;
$$;

-- Demo seed content.
insert into safety_talks (title, body) values
  ('Elevated work check', 'Before any work above 6 ft: inspect the ladder/lift, tie off, and clear the drop zone below. Nobody works overhead without a spotter.')
on conflict do nothing;

insert into supplies (name, unit) values
  ('Flashing tape 4"', 'roll'), ('Backer rod 1/2"', 'roll'), ('Low-exp foam', 'can'),
  ('Shims (cedar)', 'bundle'), ('Sealant (grey)', 'tube'), ('Setting blocks', 'bag')
on conflict do nothing;
