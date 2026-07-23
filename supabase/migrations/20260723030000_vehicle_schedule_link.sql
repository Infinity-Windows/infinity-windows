-- Date-aware vehicle/trailer assignments so a truck can be linked to a specific
-- scheduled crew block (schedule_assignments) and double-bookings across
-- overlapping date ranges can be detected. Purely additive to the existing
-- vehicle_project_assignments table (from 20260723010000_vehicles_machinery):
-- the app degrades gracefully until this is applied (it falls back to a
-- browser-local store / date-less links), so nothing crashes pre-migration.

-- Which scheduled crew block this vehicle is tied to (null = a plain
-- job-level assignment made from the vehicle detail page). Cascade-delete so
-- unpublishing/removing an assignment cleans up its vehicle link.
alter table vehicle_project_assignments
  add column if not exists assignment_id uuid
    references schedule_assignments(id) on delete cascade;

-- The days this vehicle is committed to the job (mirrors the assignment's
-- range). Nullable so legacy rows and job-level links stay valid.
alter table vehicle_project_assignments
  add column if not exists start_date date;
alter table vehicle_project_assignments
  add column if not exists end_date date;

create index if not exists vehicle_project_assignments_assignment_idx
  on vehicle_project_assignments (assignment_id);
create index if not exists vehicle_project_assignments_dates_idx
  on vehicle_project_assignments (vehicle_id, start_date, end_date);
