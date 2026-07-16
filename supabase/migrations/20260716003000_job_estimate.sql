-- Phase A4: capture a job's estimate at plan time so we can track bid accuracy
-- (estimate vs actual) as installs complete.

alter table projects
  add column if not exists estimated_minutes int,
  add column if not exists estimated_crew int,
  add column if not exists estimated_at timestamptz;
