-- Travel Info (v1): trip-centric travel packs for the crew. A trip is a
-- destination + date range + assigned crew, holding flights (optionally
-- per-person), lodging (house-manual), ground transport, living/cleanliness
-- procedures, emergency & host contacts, and private attachments (boarding
-- passes / reservations). Owner/supervisor edit; draft -> publish pushes the
-- pack to the assigned crew. Crew are READ-ONLY and only see trips they're on.
--
-- Additive + idempotent: the app degrades gracefully until this is applied (it
-- falls back to a browser-local draft store), so every object here is guarded
-- with `if not exists` / `create or replace` and is safe to run on live data.

-- The trip: destination + range + status. `timezone` is the trip's home IANA
-- zone (per-flight/lodging zones live on those rows). project_id optionally
-- links a trip to a job.
create table if not exists trips (
  id uuid primary key default gen_random_uuid(),
  project_id uuid null references projects(id) on delete set null,
  name text not null,
  destination text null,
  start_date date not null,
  end_date date not null,
  timezone text null,
  notes text null,
  status text not null default 'draft'
    check (status in ('draft','published')),
  published_at timestamptz null,
  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint trips_date_order check (end_date >= start_date)
);

-- Assigned crew for a trip. A person appears once; `role` mirrors their crew
-- role on this trip (free text so legacy roles never break the insert).
create table if not exists trip_crew (
  trip_id uuid not null references trips(id) on delete cascade,
  profile_id uuid not null references profiles(id) on delete cascade,
  role text not null default 'crew',
  created_at timestamptz not null default now(),
  primary key (trip_id, profile_id)
);

-- Flights. A row with profile_id set is that person's flight; null = the whole
-- crew. Times are stored in UTC (timestamptz) with an IANA zone per airport so
-- the app can render each leg in the AIRPORT'S local time. arrive-by /leave-by
-- are derived from depart_at using the per-flight buffers below.
create table if not exists flights (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references trips(id) on delete cascade,
  profile_id uuid null references profiles(id) on delete set null,
  airline text null,
  flight_number text null,
  confirmation_code text null,
  depart_airport text null,
  arrive_airport text null,
  depart_at timestamptz null,
  arrive_at timestamptz null,
  depart_timezone text null,
  arrive_timezone text null,
  minutes_before_departure int not null default 120,
  drive_minutes_to_airport int null,
  seat text null,
  notes text null,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Lodging, laid out house-manual style. wifi_password + door_code are pinned at
-- the top of the lodging view; they stay behind the same trip-membership RLS as
-- everything else. check_in_at/check_out_at are UTC + `timezone` for local
-- rendering.
create table if not exists lodging (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references trips(id) on delete cascade,
  name text null,
  address text null,
  timezone text null,
  wifi_ssid text null,
  wifi_password text null,
  door_code text null,
  entry_steps text null,
  backup_entry text null,
  host_name text null,
  host_phone text null,
  check_in_at timestamptz null,
  check_out_at timestamptz null,
  nights int null,
  bedrooms int null,
  beds int null,
  baths numeric null,
  washer_dryer boolean null,
  kitchen boolean null,
  parking text null,
  quiet_hours text null,
  checkout_tasks text null,
  notes text null,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Ground transport legs (rental car, shuttle, rideshare, etc.).
create table if not exists ground_transport (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references trips(id) on delete cascade,
  type text null,
  provider text null,
  confirmation_code text null,
  pickup_location text null,
  pickup_at timestamptz null,
  pickup_timezone text null,
  dropoff_location text null,
  dropoff_at timestamptz null,
  dropoff_timezone text null,
  notes text null,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Crew living / cleanliness procedures. trip_id null = a company-wide template
-- that applies to every trip; a trip-scoped row overrides/adds for one trip.
create table if not exists procedures (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid null references trips(id) on delete cascade,
  title text not null,
  body text null,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Emergency & host contacts for a trip (tap-to-call). `label` groups them
-- ("emergency", "host", "site", ...).
create table if not exists trip_contacts (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references trips(id) on delete cascade,
  name text not null,
  label text null,
  phone text null,
  notes text null,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

-- Private attachments: boarding passes, reservation PDFs, screenshots. Can hang
-- off the whole trip or a specific flight / lodging. Files live in the private
-- `trip-attachments` bucket; the app serves them via short-lived signed URLs.
create table if not exists trip_attachments (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references trips(id) on delete cascade,
  flight_id uuid null references flights(id) on delete cascade,
  lodging_id uuid null references lodging(id) on delete cascade,
  storage_path text not null,
  label text null,
  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists trip_crew_profile_idx on trip_crew (profile_id);
create index if not exists trips_range_idx on trips (start_date, end_date);
create index if not exists trips_status_idx on trips (status);
create index if not exists flights_trip_idx on flights (trip_id, sort_order);
create index if not exists lodging_trip_idx on lodging (trip_id, sort_order);
create index if not exists ground_transport_trip_idx on ground_transport (trip_id, sort_order);
create index if not exists procedures_trip_idx on procedures (trip_id, sort_order);
create index if not exists trip_contacts_trip_idx on trip_contacts (trip_id, sort_order);
create index if not exists trip_attachments_trip_idx on trip_attachments (trip_id);

-- =============================================================================
-- Access helpers (SECURITY DEFINER so they read profiles/trip_crew regardless
-- of the caller's own RLS, and can never be spoofed by a client-supplied role).
-- =============================================================================

-- TRUE role check: supervisor/owner (incl. legacy admin/big_boss) may edit and
-- see every trip. Runs entirely server-side against profiles by auth.uid().
create or replace function travel_is_supervisor()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select role in ('supervisor','owner','admin','big_boss')
       from profiles where id = auth.uid()),
    false
  );
$$;

-- Membership check: is the caller assigned to this trip? Drives crew read
-- access (crew see only trips they're on).
create or replace function travel_is_trip_member(p_trip uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from trip_crew tc
    where tc.trip_id = p_trip and tc.profile_id = auth.uid()
  );
$$;

-- =============================================================================
-- Row-level security
-- =============================================================================
-- SELECT: assigned crew OR a true supervisor/owner. INSERT/UPDATE/DELETE: true
-- supervisor/owner only. wifi_password/door_code live on `lodging`, so they are
-- covered by the same trip-membership SELECT gate as the rest of the pack.

alter table trips enable row level security;
alter table trip_crew enable row level security;
alter table flights enable row level security;
alter table lodging enable row level security;
alter table ground_transport enable row level security;
alter table procedures enable row level security;
alter table trip_contacts enable row level security;
alter table trip_attachments enable row level security;

do $$
begin
  -- trips
  if not exists (select 1 from pg_policies where tablename = 'trips' and policyname = 'trips read') then
    create policy "trips read" on trips for select to authenticated
      using (travel_is_trip_member(id) or travel_is_supervisor());
  end if;
  if not exists (select 1 from pg_policies where tablename = 'trips' and policyname = 'trips write') then
    create policy "trips write" on trips for all to authenticated
      using (travel_is_supervisor()) with check (travel_is_supervisor());
  end if;

  -- trip_crew (a crew member can see the roster of trips they're on)
  if not exists (select 1 from pg_policies where tablename = 'trip_crew' and policyname = 'trip_crew read') then
    create policy "trip_crew read" on trip_crew for select to authenticated
      using (travel_is_trip_member(trip_id) or travel_is_supervisor());
  end if;
  if not exists (select 1 from pg_policies where tablename = 'trip_crew' and policyname = 'trip_crew write') then
    create policy "trip_crew write" on trip_crew for all to authenticated
      using (travel_is_supervisor()) with check (travel_is_supervisor());
  end if;

  -- flights
  if not exists (select 1 from pg_policies where tablename = 'flights' and policyname = 'flights read') then
    create policy "flights read" on flights for select to authenticated
      using (travel_is_trip_member(trip_id) or travel_is_supervisor());
  end if;
  if not exists (select 1 from pg_policies where tablename = 'flights' and policyname = 'flights write') then
    create policy "flights write" on flights for all to authenticated
      using (travel_is_supervisor()) with check (travel_is_supervisor());
  end if;

  -- lodging
  if not exists (select 1 from pg_policies where tablename = 'lodging' and policyname = 'lodging read') then
    create policy "lodging read" on lodging for select to authenticated
      using (travel_is_trip_member(trip_id) or travel_is_supervisor());
  end if;
  if not exists (select 1 from pg_policies where tablename = 'lodging' and policyname = 'lodging write') then
    create policy "lodging write" on lodging for all to authenticated
      using (travel_is_supervisor()) with check (travel_is_supervisor());
  end if;

  -- ground_transport
  if not exists (select 1 from pg_policies where tablename = 'ground_transport' and policyname = 'ground read') then
    create policy "ground read" on ground_transport for select to authenticated
      using (travel_is_trip_member(trip_id) or travel_is_supervisor());
  end if;
  if not exists (select 1 from pg_policies where tablename = 'ground_transport' and policyname = 'ground write') then
    create policy "ground write" on ground_transport for all to authenticated
      using (travel_is_supervisor()) with check (travel_is_supervisor());
  end if;

  -- procedures: company-wide templates (trip_id null) are readable by everyone
  -- authenticated; trip-scoped rows follow trip membership. Writes are
  -- supervisor/owner only.
  if not exists (select 1 from pg_policies where tablename = 'procedures' and policyname = 'procedures read') then
    create policy "procedures read" on procedures for select to authenticated
      using (trip_id is null or travel_is_trip_member(trip_id) or travel_is_supervisor());
  end if;
  if not exists (select 1 from pg_policies where tablename = 'procedures' and policyname = 'procedures write') then
    create policy "procedures write" on procedures for all to authenticated
      using (travel_is_supervisor()) with check (travel_is_supervisor());
  end if;

  -- trip_contacts
  if not exists (select 1 from pg_policies where tablename = 'trip_contacts' and policyname = 'contacts read') then
    create policy "contacts read" on trip_contacts for select to authenticated
      using (travel_is_trip_member(trip_id) or travel_is_supervisor());
  end if;
  if not exists (select 1 from pg_policies where tablename = 'trip_contacts' and policyname = 'contacts write') then
    create policy "contacts write" on trip_contacts for all to authenticated
      using (travel_is_supervisor()) with check (travel_is_supervisor());
  end if;

  -- trip_attachments
  if not exists (select 1 from pg_policies where tablename = 'trip_attachments' and policyname = 'attachments read') then
    create policy "attachments read" on trip_attachments for select to authenticated
      using (travel_is_trip_member(trip_id) or travel_is_supervisor());
  end if;
  if not exists (select 1 from pg_policies where tablename = 'trip_attachments' and policyname = 'attachments write') then
    create policy "attachments write" on trip_attachments for all to authenticated
      using (travel_is_supervisor()) with check (travel_is_supervisor());
  end if;
end;
$$;

-- Private storage bucket for trip attachments (mirrors the toolbox-records /
-- install-media pattern). Reads happen through short-lived signed URLs; the
-- policies gate raw object access to authenticated users, with writes limited
-- to supervisors/owners.
insert into storage.buckets (id, name, public)
values ('trip-attachments', 'trip-attachments', false)
on conflict (id) do nothing;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'objects' and policyname = 'trip attachments read'
  ) then
    create policy "trip attachments read"
      on storage.objects for select to authenticated
      using (bucket_id = 'trip-attachments');
  end if;
  if not exists (
    select 1 from pg_policies
    where tablename = 'objects' and policyname = 'trip attachments write'
  ) then
    create policy "trip attachments write"
      on storage.objects for all to authenticated
      using (bucket_id = 'trip-attachments' and travel_is_supervisor())
      with check (bucket_id = 'trip-attachments' and travel_is_supervisor());
  end if;
end;
$$;
