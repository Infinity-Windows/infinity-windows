-- Jobs get an end of life (owner ask, 2026-08-26): "delete jobs or complete
-- them and store their information — completing takes them off my screen.
-- We can create a job history list."
--
-- The schema was ready since day one — status in
-- ('active','completed','cancelled'), and every picker already reads only
-- active — but no door existed to move a job out of 'active', and the
-- permissive projects_update policy meant any signed-in phone could have.
-- This migration builds the doors and locks the wall:
--
--   * set_project_status — supervisor+ moves a job between active /
--     completed / cancelled. Reversible by design: reopening is the same
--     call. Stamps status_changed_at so the history list can say WHEN.
--   * delete_project — owner only, and ONLY for an empty shell: a job
--     carrying packages, openings, or clocked shifts refuses with a
--     sentence pointing at complete/cancel. Deleting information is what
--     completing exists to avoid.
--   * the status column itself goes RPC-only (the is_test column-revoke
--     precedent, 20260933) so no direct client write can flip a job's life
--     stage around the gates.

alter table projects
  add column if not exists status_changed_at timestamptz;

revoke insert (status), update (status) on table projects from authenticated;

create or replace function set_project_status(p_project uuid, p_status text)
returns projects
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row projects;
begin
  if not _is_supervisor(auth.uid()) then
    raise exception 'Only a supervisor or owner can finish, cancel, or reopen a job.'
      using errcode = '42501';
  end if;
  if p_status not in ('active', 'completed', 'cancelled') then
    raise exception 'A job is active, completed, or cancelled — nothing else.';
  end if;

  update projects
     set status = p_status,
         status_changed_at = now()
   where id = p_project
  returning * into v_row;
  if v_row.id is null then
    raise exception 'That job does not exist.';
  end if;
  return v_row;
end;
$$;

grant execute on function set_project_status(uuid, text) to authenticated;

create or replace function delete_project(p_project uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_n int;
begin
  if public.my_role_rank() < 3 then
    raise exception 'Only an owner can delete a job.' using errcode = '42501';
  end if;
  if not exists (select 1 from projects where id = p_project) then
    raise exception 'That job does not exist.';
  end if;

  select count(*) into v_n from packages where project_id = p_project;
  if v_n > 0 then
    raise exception 'This job has % tracked package%. Complete or cancel it instead — deleting would erase where material went.',
      v_n, case when v_n = 1 then '' else 's' end;
  end if;
  select count(*) into v_n from openings where project_id = p_project;
  if v_n > 0 then
    raise exception 'This job has % opening% on its plans. Complete or cancel it instead.',
      v_n, case when v_n = 1 then '' else 's' end;
  end if;
  if to_regclass('public.shifts') is not null then
    execute 'select count(*) from shifts where project_id = $1' into v_n using p_project;
    if v_n > 0 then
      raise exception 'This job has % clocked shift%. Complete or cancel it instead — hours are payroll.',
        v_n, case when v_n = 1 then '' else 's' end;
    end if;
  end if;

  delete from project_marks where project_id = p_project;
  delete from sandbox_projects where project_id = p_project;
  delete from projects where id = p_project;
end;
$$;

grant execute on function delete_project(uuid) to authenticated;
