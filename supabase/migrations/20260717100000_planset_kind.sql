-- Building plan vs specs schedule slots on project_plansets.
alter table project_plansets
  add column if not exists kind text not null default 'building'
    check (kind in ('building', 'specs'));

alter table project_plansets
  add column if not exists story_label text;

create index if not exists project_plansets_project_kind_idx
  on project_plansets(project_id, kind, created_at desc);

comment on column project_plansets.kind is
  'building = floor plans with #mark openings; specs = window/door schedule table';

-- Specs schedule marks (#14 → size/type/color). Building plans create openings
-- that reference these marks by normalized mark string.
create table if not exists project_marks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  mark text not null,
  window_type_id uuid references window_types(id) on delete set null,
  type_text text,
  size_text text,
  color_text text,
  unit_kind text not null default 'window'
    check (unit_kind in ('window', 'door')),
  specs_planset_id uuid references project_plansets(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (project_id, mark)
);

create index if not exists project_marks_project_idx
  on project_marks(project_id, mark);

alter table project_marks enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'project_marks' and policyname = 'authenticated full access'
  ) then
    create policy "authenticated full access" on project_marks
      for all to authenticated using (true) with check (true);
  end if;
end $$;
