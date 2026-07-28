-- Automatic driving timer + mileage log for the fleet (for year-end mileage
-- write-offs). Each row is one detected DRIVE for a vehicle — when/where it
-- started and ended, how long it ran, and how far it went — derived from the
-- vehicle's GPS fix stream (vehicle_locations_history from
-- 20260723010000_vehicles_machinery). A drive counts as BUSINESS mileage only
-- when the driver was CLOCKED IN during it (time_shifts); `business` carries
-- that, and the year-end total sums business drives only.
--
-- Additive + idempotent: guarded with `if not exists`, safe on live data. The
-- app degrades gracefully (empty log, browser-local fallback) until applied, so
-- nothing crashes pre-migration. When a real tracker feeds fixes, drives log
-- automatically.

create table if not exists vehicle_drive_sessions (
  id uuid primary key default gen_random_uuid(),
  vehicle_id uuid not null references vehicles(id) on delete cascade,
  started_at timestamptz not null,
  ended_at timestamptz not null,
  duration_seconds int not null default 0,
  distance_miles numeric not null default 0,
  start_lat numeric null,
  start_lng numeric null,
  end_lat numeric null,
  end_lng numeric null,
  -- Business (clocked-in) vs personal. Safety default false → uncounted until a
  -- clocked-in overlap proves the drive was for work (keeps the write-off
  -- defensible).
  business boolean not null default false,
  -- Who was driving (best-effort: the vehicle's main/assigned driver, or the
  -- listed driver whose clock-in overlapped the drive).
  driver_id uuid null references profiles(id) on delete set null,
  source text not null default 'gps',
  created_at timestamptz not null default now(),
  -- One session per (vehicle, start) so recompute is idempotent (upsert).
  constraint vehicle_drive_sessions_vehicle_start_key unique (vehicle_id, started_at)
);

create index if not exists vehicle_drive_sessions_vehicle_idx
  on vehicle_drive_sessions (vehicle_id, started_at desc);
create index if not exists vehicle_drive_sessions_started_idx
  on vehicle_drive_sessions (started_at);

-- =============================================================================
-- Row-level security
-- =============================================================================
-- This is tax/financial data, so it is owner/supervisor-only (one rank below
-- the strict owner-only financials, matching the UI gate). The check reads the
-- caller's TRUE role from profiles by auth.uid() — a previewed/client role can
-- never satisfy it. Legacy role names (big_boss → owner, admin → supervisor)
-- are included so old profiles keep the same access. The service role bypasses
-- RLS, so a real tracker's server-side ingestion can insert freely.
alter table vehicle_drive_sessions enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'vehicle_drive_sessions'
      and policyname = 'owner supervisor drive sessions'
  ) then
    create policy "owner supervisor drive sessions" on vehicle_drive_sessions
      for all to authenticated
      using (
        (select role from profiles where id = auth.uid())
          in ('owner','big_boss','supervisor','admin')
      )
      with check (
        (select role from profiles where id = auth.uid())
          in ('owner','big_boss','supervisor','admin')
      );
  end if;
end;
$$;
