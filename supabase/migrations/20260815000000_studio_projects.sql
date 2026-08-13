-- Standalone Studio projects (owner decision 2026-08-13: Studio leaves the
-- job tabs and stands alone; supervisors can start BLANK to author a
-- planset + 3D model with no job attached, and link one later).
--
-- Relationship to jobs is "linked but independent": a row may reference a
-- project (enables Publish-to-map into that job's outline), and existing
-- job-attached models keep living in project_plan_outlines.features
-- .modelstudio — the Studio list shows both kinds side by side.
--
-- Same security shape as storage tracking: reads open to the crew, ZERO
-- direct-write policies — writes only through the SECURITY DEFINER RPC
-- below (Studio authoring is supervisor+, matching the tab gate).

create table if not exists studio_projects (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  -- Optional job link; publishing requires it. Losing the job keeps the model.
  project_id uuid references projects (id) on delete set null,
  -- { serialized: string, savedAt: iso } — the same shape the job outline
  -- carries under features.modelstudio, so the editor loads either.
  model jsonb,
  archived boolean not null default false,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists studio_projects_project_idx on studio_projects (project_id);

alter table studio_projects enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'studio_projects' and policyname = 'crew read'
  ) then
    create policy "crew read" on studio_projects
      for select to authenticated using (true);
  end if;
end;
$$;

-- Supervisor+: create, rename, save the model, link/unlink a job, archive.
-- One RPC because every field is part of one authoring session; null p_id
-- inserts, otherwise updates.
create or replace function save_studio_project(
  p_id uuid,
  p_name text,
  p_project uuid default null,
  p_model jsonb default null,
  p_archived boolean default false
)
returns studio_projects
language plpgsql
security definer
as $$
declare
  v_role text;
  v_row studio_projects;
begin
  select role into v_role from profiles where id = auth.uid();
  if v_role is null or v_role in ('installer', 'foreman') then
    raise exception 'only a supervisor or above can author Studio projects';
  end if;
  if p_name is null or length(trim(p_name)) = 0 then
    raise exception 'a Studio project needs a name';
  end if;

  if p_id is null then
    insert into studio_projects (name, project_id, model, archived, created_by)
    values (trim(p_name), p_project, p_model, coalesce(p_archived, false), auth.uid()::text)
    returning * into v_row;
  else
    update studio_projects
    set name = trim(p_name),
        project_id = p_project,
        -- Passing null model on a rename/link must not erase the drawing.
        model = coalesce(p_model, model),
        archived = coalesce(p_archived, false),
        updated_at = now()
    where id = p_id
    returning * into v_row;
    if not found then
      raise exception 'Studio project not found';
    end if;
  end if;
  return v_row;
end;
$$;
