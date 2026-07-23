-- Vehicles & Machinery fleet (v1): track the company's pickups, cars, heavy
-- machinery and trailers — who drives them, where they are (manual GPS now,
-- provider-ready later), service history + reminders, which job they're on, and
-- (owner-only) the money behind each one.
--
-- Additive + idempotent: the app degrades gracefully until this is applied (it
-- falls back to a browser-local store), so every object here is guarded with
-- `if not exists` and is safe to run on top of live data.
--
-- Single-tenant app: no org_id. A `locations` table already exists (warehouse
-- slots) — everything here is prefixed `vehicle_`/`vehicles` to avoid collision.

-- The fleet unit itself. `kind` splits trucks/cars/machinery/trailers;
-- `trailer_subtype` only applies to trailers. Odometer (miles) covers road
-- vehicles; engine_hours covers machinery. primary_driver_id is a convenience
-- mirror of the 'primary' row in vehicle_drivers when that driver is an app
-- profile (drivers table is the source of truth so a free-text primary works).
create table if not exists vehicles (
  id uuid primary key default gen_random_uuid(),
  kind text not null default 'pickup'
    check (kind in ('pickup','car','heavy_machinery','trailer')),
  trailer_subtype text null
    check (trailer_subtype in ('flatbed','tiltdeck','box','gooseneck')),
  year int null,
  make text null,
  model text null,
  color text null,
  vin text null,
  plate text null,
  odometer int null,
  engine_hours numeric null,
  last_service_date date null,
  next_service_date date null,
  status text not null default 'active'
    check (status in ('active','in_shop','out_of_service','sold')),
  primary_driver_id uuid null references profiles(id) on delete set null,
  notes text null,
  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Only trailers may carry a subtype.
  constraint vehicles_trailer_subtype_kind
    check (trailer_subtype is null or kind = 'trailer')
);

-- Drivers on a vehicle: the primary driver + any additional INSURED drivers.
-- Each driver is EITHER an app profile OR a typed free-text name (exactly one).
create table if not exists vehicle_drivers (
  id uuid primary key default gen_random_uuid(),
  vehicle_id uuid not null references vehicles(id) on delete cascade,
  profile_id uuid null references profiles(id) on delete cascade,
  name text null,
  relation text not null default 'insured'
    check (relation in ('primary','insured')),
  created_at timestamptz not null default now(),
  -- Exactly one of profile_id / name is set.
  constraint vehicle_drivers_profile_xor_name
    check ((profile_id is not null) <> (name is not null))
);

-- Future tracker link (Bouncie/Samsara/LandAirSea …). Unused by manual mode but
-- part of the provider-ready layer so wiring a real device later is additive.
create table if not exists vehicle_devices (
  id uuid primary key default gen_random_uuid(),
  vehicle_id uuid not null references vehicles(id) on delete cascade,
  provider text not null,
  provider_device_id text null,
  created_at timestamptz not null default now()
);

-- Latest known location (one row per vehicle). Manual updates write here + a
-- history row. `source` is 'manual' for now; a provider webhook fills it later.
create table if not exists vehicle_locations_latest (
  vehicle_id uuid primary key references vehicles(id) on delete cascade,
  lat double precision not null,
  lng double precision not null,
  speed_mph numeric null,
  heading_deg numeric null,
  battery_pct int null,
  ignition_on boolean null,
  recorded_at timestamptz not null default now(),
  source text not null default 'manual'
);

-- Append-only location trail for a vehicle (breadcrumbs / "last seen" history).
create table if not exists vehicle_locations_history (
  id uuid primary key default gen_random_uuid(),
  vehicle_id uuid not null references vehicles(id) on delete cascade,
  lat double precision not null,
  lng double precision not null,
  speed_mph numeric null,
  heading_deg numeric null,
  battery_pct int null,
  ignition_on boolean null,
  recorded_at timestamptz not null default now(),
  source text not null default 'manual'
);

-- Service history + cost log (oil changes, repairs, inspections …).
create table if not exists vehicle_service_records (
  id uuid primary key default gen_random_uuid(),
  vehicle_id uuid not null references vehicles(id) on delete cascade,
  performed_at date not null,
  odometer int null,
  engine_hours numeric null,
  category text null,
  description text null,
  cost numeric null,
  vendor text null,
  created_at timestamptz not null default now()
);

-- Recurring service tasks used to derive due/overdue reminders (optional; the
-- app also derives reminders from vehicles.next_service_date so it works either
-- way).
create table if not exists vehicle_service_schedules (
  id uuid primary key default gen_random_uuid(),
  vehicle_id uuid not null references vehicles(id) on delete cascade,
  task text not null,
  interval_miles int null,
  interval_days int null,
  last_done_odometer int null,
  last_done_at date null,
  created_at timestamptz not null default now()
);

-- Owner-only financials (kept in a SEPARATE table so the strict RLS below can
-- lock the money down without touching the general fleet read access).
create table if not exists vehicle_financials (
  vehicle_id uuid primary key references vehicles(id) on delete cascade,
  paid_cash boolean not null default false,
  loan_balance numeric null,
  interest_rate numeric null,
  lender_bank text null,
  monthly_payment numeric null,
  purchase_price numeric null,
  purchase_date date null,
  notes text null,
  updated_at timestamptz not null default now()
);

-- Assign a vehicle/trailer to a job/project.
create table if not exists vehicle_project_assignments (
  id uuid primary key default gen_random_uuid(),
  vehicle_id uuid not null references vehicles(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  assigned_at timestamptz not null default now(),
  note text null
);

create index if not exists vehicle_drivers_vehicle_idx
  on vehicle_drivers (vehicle_id);
create index if not exists vehicle_devices_vehicle_idx
  on vehicle_devices (vehicle_id);
create index if not exists vehicle_locations_history_vehicle_idx
  on vehicle_locations_history (vehicle_id, recorded_at desc);
create index if not exists vehicle_service_records_vehicle_idx
  on vehicle_service_records (vehicle_id, performed_at desc);
create index if not exists vehicle_service_schedules_vehicle_idx
  on vehicle_service_schedules (vehicle_id);
create index if not exists vehicle_project_assignments_vehicle_idx
  on vehicle_project_assignments (vehicle_id, assigned_at desc);
create index if not exists vehicle_project_assignments_project_idx
  on vehicle_project_assignments (project_id);

-- =============================================================================
-- Row-level security
-- =============================================================================
-- General fleet tables use the same trusted-crew pattern as the other install
-- tables (authenticated full access); the route guard + UI gate keep the tab
-- supervisor+. Financials are the exception: a STRICT owner-only policy that
-- checks the caller's TRUE role from profiles (never a client-supplied role).
alter table vehicles enable row level security;
alter table vehicle_drivers enable row level security;
alter table vehicle_devices enable row level security;
alter table vehicle_locations_latest enable row level security;
alter table vehicle_locations_history enable row level security;
alter table vehicle_service_records enable row level security;
alter table vehicle_service_schedules enable row level security;
alter table vehicle_project_assignments enable row level security;
alter table vehicle_financials enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'vehicles' and policyname = 'authenticated full access') then
    create policy "authenticated full access" on vehicles for all to authenticated using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'vehicle_drivers' and policyname = 'authenticated full access') then
    create policy "authenticated full access" on vehicle_drivers for all to authenticated using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'vehicle_devices' and policyname = 'authenticated full access') then
    create policy "authenticated full access" on vehicle_devices for all to authenticated using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'vehicle_locations_latest' and policyname = 'authenticated full access') then
    create policy "authenticated full access" on vehicle_locations_latest for all to authenticated using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'vehicle_locations_history' and policyname = 'authenticated full access') then
    create policy "authenticated full access" on vehicle_locations_history for all to authenticated using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'vehicle_service_records' and policyname = 'authenticated full access') then
    create policy "authenticated full access" on vehicle_service_records for all to authenticated using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'vehicle_service_schedules' and policyname = 'authenticated full access') then
    create policy "authenticated full access" on vehicle_service_schedules for all to authenticated using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'vehicle_project_assignments' and policyname = 'authenticated full access') then
    create policy "authenticated full access" on vehicle_project_assignments for all to authenticated using (true) with check (true);
  end if;

  -- STRICT owner-only: read AND write allowed only when the caller's TRUE role
  -- (looked up from profiles by auth.uid()) is 'owner'. A previewed/client role
  -- can never satisfy this — the check runs entirely server-side.
  if not exists (select 1 from pg_policies where tablename = 'vehicle_financials' and policyname = 'owner only financials') then
    create policy "owner only financials" on vehicle_financials
      for all to authenticated
      using (
        (select role from profiles where id = auth.uid()) = 'owner'
      )
      with check (
        (select role from profiles where id = auth.uid()) = 'owner'
      );
  end if;
end;
$$;
