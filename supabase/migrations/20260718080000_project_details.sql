-- Horizon-style project intake fields for the windows-install add/edit flow.
--
-- Mirrors the fields Horizon captures when a job is created (customer/contact,
-- site location detail, scheduled dates, freeform notes) mapped onto our
-- existing `projects` table. Windows-install terminology throughout — no solar
-- wording. Every add is idempotent so this can be re-applied safely.

alter table projects add column if not exists customer_name text;
alter table projects add column if not exists contact_phone text;
alter table projects add column if not exists contact_email text;
-- 2-letter state, mirrors Horizon's by-state grouping of jobs.
alter table projects add column if not exists site_state text;
-- Building / unit / lot detail (e.g. "Building 14", "Lots 173-183").
alter table projects add column if not exists unit_number text;
-- Scheduled install window.
alter table projects add column if not exists start_date date;
alter table projects add column if not exists end_date date;
-- Freeform job notes (scope, access, gate codes, etc.).
alter table projects add column if not exists notes text;
