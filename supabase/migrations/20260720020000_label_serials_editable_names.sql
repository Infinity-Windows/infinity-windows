-- Permanent serials + editable names for warehouse QR labels.
--
-- Why: today a slot label encodes its address (WOPS:L:<address>) and a window
-- label encodes its window_id (WOPS:W:<window_id>). That means renaming a slot
-- address or wanting a friendlier name would break every printed QR. This
-- migration gives each location and each window a PERMANENT, auto-generated
-- serial (SLOT-000123 / WIN-000123). New labels encode the serial, so the QR
-- keeps scanning forever even if the human-facing name/address changes.
--
-- ADDITIVE and safe: it only adds columns + sequences + immutability guards.
-- Existing WOPS:L:/WOPS:W: labels keep working (the client still parses them),
-- so nothing has to be reprinted. Reads via select('*') tolerate the new
-- columns even before this runs; only WRITES to the new columns need it.

-- 1) Locations: permanent serial + optional friendly display name -----------
-- NOTE: locations.address is a GENERATED column (zone || '-' || rack || '-' ||
-- slot). We deliberately do NOT touch it. Editing the "address" from the app
-- updates zone/rack/slot and the address regenerates automatically.

create sequence if not exists location_serial_seq;

alter table locations add column if not exists serial text;
alter table locations add column if not exists display_name text;

-- Backfill any existing rows (each gets its own serial from the sequence).
update locations
set serial = 'SLOT-' || lpad(nextval('location_serial_seq')::text, 6, '0')
where serial is null;

-- New rows auto-generate their serial once, on insert.
alter table locations
  alter column serial set default 'SLOT-' || lpad(nextval('location_serial_seq')::text, 6, '0');

create unique index if not exists locations_serial_key on locations (serial);

-- 2) Windows: permanent serial + optional friendly display name -------------
-- window_id stays the stable human identifier (referenced across movements and
-- RPCs) — it is NOT renameable. display_name is a separate, editable label.

create sequence if not exists window_serial_seq;

alter table windows add column if not exists serial text;
alter table windows add column if not exists display_name text;

update windows
set serial = 'WIN-' || lpad(nextval('window_serial_seq')::text, 6, '0')
where serial is null;

alter table windows
  alter column serial set default 'WIN-' || lpad(nextval('window_serial_seq')::text, 6, '0');

create unique index if not exists windows_serial_key on windows (serial);

-- 3) Serials are STABLE (set once, never regenerated) -----------------------
-- Defence in depth: once a serial is set, silently keep it on any UPDATE so an
-- accidental edit can never re-issue or change a printed serial.
create or replace function lock_serial()
returns trigger language plpgsql as $$
begin
  if OLD.serial is not null and NEW.serial is distinct from OLD.serial then
    NEW.serial := OLD.serial;
  end if;
  return NEW;
end;
$$;

drop trigger if exists locations_lock_serial on locations;
create trigger locations_lock_serial
  before update on locations
  for each row execute function lock_serial();

drop trigger if exists windows_lock_serial on windows;
create trigger windows_lock_serial
  before update on windows
  for each row execute function lock_serial();

-- 4) RLS ---------------------------------------------------------------------
-- No new policies needed: the inventory core migration already grants an
-- "authenticated full access" (for all) policy on both locations and windows,
-- which covers editing address/display_name for the trusted crew. We do NOT
-- add anything that would broaden or weaken that model for installers.
