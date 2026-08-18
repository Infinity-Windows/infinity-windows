-- Ticket 22, first slice: a container record can carry its 3D model.
--
-- The owner unparked the warehouse map (2026-08-18). The plan is three
-- slices: true-dimension SHELLS of each conex and the building as standalone
-- Studio projects (this migration + the generator), the shelf object in
-- Studio (next), and the installer's read-only viewer with the package's
-- area zone glowing (after that). This slice is the link that makes a shell
-- FINDABLE from the box it depicts — a model nothing points at is a drawing,
-- not a map.
--
-- On delete set null both ways matters: archiving or deleting a Studio
-- project must never take a container's record with it, and vice versa.
alter table storage_containers
  add column if not exists studio_project_id uuid
    references studio_projects (id) on delete set null;

-- Supervisor+, matching Studio authoring's own gate (a shell IS a Studio
-- project). Linking is separate from save_storage_container on purpose:
-- the foreman-level container edit form has no business accidentally
-- clearing a model link by round-tripping a row.
create or replace function set_container_model(
  p_container uuid,
  p_studio uuid
)
returns storage_containers
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text;
  v_row storage_containers;
begin
  select role into v_role from profiles where id = auth.uid();
  if v_role is null or v_role not in ('supervisor', 'owner') then
    raise exception 'only a supervisor or above can link a container to a model';
  end if;
  if p_studio is not null
     and not exists (select 1 from studio_projects where id = p_studio) then
    raise exception 'that Studio project does not exist';
  end if;

  update storage_containers
  set studio_project_id = p_studio
  where id = p_container
  returning * into v_row;
  if not found then
    raise exception 'container not found';
  end if;
  return v_row;
end;
$$;
