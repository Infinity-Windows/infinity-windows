-- Crew scheduling: owner/supervisor assign ad-hoc crews (multiple foremen +
-- installers, chosen fresh per assignment) to projects over a date range, then
-- publish to push the schedule out to foreman/installers ("My Schedule").
--
-- Additive + idempotent: the app degrades gracefully until this is applied (it
-- falls back to a browser-local draft store), so every object here is guarded
-- with `if not exists` and safe to run on top of live data.

-- The schedulable unit: one crew on one project for a day range, with an
-- optional intra-day start time. Multiple assignments per project = multiple
-- crews; assignments span across many projects.
create table if not exists schedule_assignments (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  start_date date not null,
  end_date date not null,
  start_time time null,
  status text not null default 'draft'
    check (status in ('draft','published','in_progress','done','canceled')),
  color text null,
  note text null,
  created_by uuid references profiles(id) on delete set null,
  published_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint schedule_assignments_date_order check (end_date >= start_date)
);

-- Ad-hoc crew members for one assignment (no reusable saved crews). A person is
-- either a foreman or an installer on this assignment.
create table if not exists schedule_assignment_members (
  assignment_id uuid not null references schedule_assignments(id) on delete cascade,
  profile_id uuid not null references profiles(id) on delete cascade,
  role text not null check (role in ('foreman','installer')),
  created_at timestamptz not null default now(),
  primary key (assignment_id, profile_id)
);

-- Light audit so edits re-notify only affected people. assignment_id is kept
-- loose (no hard FK) so an event survives its assignment being deleted.
create table if not exists schedule_events (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid null,
  actor uuid references profiles(id) on delete set null,
  kind text check (kind in ('created','published','moved','resized','reassigned','removed','edited')),
  payload jsonb,
  created_at timestamptz not null default now()
);

create index if not exists schedule_assignments_project_idx
  on schedule_assignments (project_id);
create index if not exists schedule_assignments_range_idx
  on schedule_assignments (start_date, end_date);
create index if not exists schedule_assignments_status_idx
  on schedule_assignments (status);
create index if not exists schedule_assignment_members_profile_idx
  on schedule_assignment_members (profile_id);
create index if not exists schedule_events_assignment_idx
  on schedule_events (assignment_id, created_at desc);

-- RLS: same trusted-crew pattern as the other install tables (authenticated
-- full access). The app enforces owner/supervisor edit vs. read-only "My
-- Schedule" in the route guard + UI; keeping reads open avoids breaking the
-- crew's read-only agenda.
alter table schedule_assignments enable row level security;
alter table schedule_assignment_members enable row level security;
alter table schedule_events enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'schedule_assignments' and policyname = 'authenticated full access'
  ) then
    create policy "authenticated full access" on schedule_assignments
      for all to authenticated using (true) with check (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where tablename = 'schedule_assignment_members' and policyname = 'authenticated full access'
  ) then
    create policy "authenticated full access" on schedule_assignment_members
      for all to authenticated using (true) with check (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where tablename = 'schedule_events' and policyname = 'authenticated full access'
  ) then
    create policy "authenticated full access" on schedule_events
      for all to authenticated using (true) with check (true);
  end if;
end;
$$;
