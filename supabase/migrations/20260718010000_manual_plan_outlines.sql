-- Manual building outlines drawn over a planset page (one polygon per floor page).
-- Normalized points (0–1) match project_openings.pin_x / pin_y space.

create table project_plan_outlines (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  planset_id uuid not null references project_plansets(id) on delete cascade,
  page_number int not null check (page_number >= 1),
  -- [{ "x": 0..1, "y": 0..1 }, ...] closed polygon (first point not repeated).
  points jsonb not null default '[]'::jsonb,
  page_aspect numeric not null check (page_aspect > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (planset_id, page_number)
);

create index project_plan_outlines_project_idx
  on project_plan_outlines(project_id, planset_id);

comment on table project_plan_outlines is
  'Hand-traced building outline for a planset page; preferred over CAD auto-extract.';

alter table project_plan_outlines enable row level security;

do $$
begin
  create policy "authenticated full access" on project_plan_outlines
    for all to authenticated using (true) with check (true);
exception when duplicate_object then null;
end $$;
