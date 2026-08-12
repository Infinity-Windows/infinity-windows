-- Monday.com connector, stage 1 (owner decisions, 2026-08-11):
--
-- The office plans jobs on the "Ops Gantt Chart" board; the app should see
-- them coming. A staging table mirrors jobs from the "Ready to Schedule"
-- and "Scheduled" groups (synced by the monday-sync edge function every
-- ~15 min while anyone uses the app). Rows are PROPOSALS, not projects —
-- the office reviews each one on the Jobs page and builds it with a real
-- job code (Monday has no job codes; review-then-build was the owner's
-- pick). After building, the sync keeps the linked project's dates fresh
-- from Monday until install work actually starts, then the app owns it.

create table if not exists monday_jobs (
  id uuid primary key default gen_random_uuid(),
  monday_item_id text not null unique,
  board_id text not null,
  name text not null,
  group_title text,
  status text,
  job_type text,
  start_date date,
  end_date date,
  est_arrival date,
  budget numeric,
  flashing_note text,
  raw jsonb,
  synced_at timestamptz not null default now(),
  /** Set when the office builds the app project from this row. */
  project_id uuid references projects(id) on delete set null,
  /** Office said "not this one" — hidden from the incoming list. */
  dismissed_at timestamptz,
  /** No longer in the synced groups (moved on / canceled in Monday). */
  left_groups_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists monday_jobs_incoming_idx
  on monday_jobs (synced_at desc)
  where project_id is null and dismissed_at is null;

alter table monday_jobs enable row level security;

-- Leads read and act on the incoming list; the edge function writes with
-- the service role (bypasses RLS).
do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'monday_jobs' and policyname = 'lead read'
  ) then
    create policy "lead read" on monday_jobs
      for select to authenticated using (_is_lead(auth.uid()));
  end if;
  if not exists (
    select 1 from pg_policies
    where tablename = 'monday_jobs' and policyname = 'lead update'
  ) then
    create policy "lead update" on monday_jobs
      for update to authenticated
      using (_is_lead(auth.uid())) with check (_is_lead(auth.uid()));
  end if;
end;
$$;
