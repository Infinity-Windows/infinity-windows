-- Auto GPS + timestamp on every photo, plus a live per-job photo feed.
-- Additive + idempotent: the app degrades gracefully until this is applied, so
-- these columns must all be nullable and safe to add on top of live data.

alter table attachments
  add column if not exists project_id uuid references projects(id) on delete cascade;
alter table attachments add column if not exists lat numeric;
alter table attachments add column if not exists lng numeric;
alter table attachments add column if not exists accuracy_m numeric;
alter table attachments add column if not exists taken_at timestamptz;
alter table attachments add column if not exists caption text;

-- Feed reads pull a project's photos newest-first (and the global recent view
-- orders on created_at); this covers the project-scoped case.
create index if not exists attachments_project_idx
  on attachments(project_id, created_at desc);

-- RLS: attachments already has an "authenticated full access" for-all policy
-- (see 20260715000000_inventory_core.sql), which covers every column including
-- the new ones. No policy change needed.
