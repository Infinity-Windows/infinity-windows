-- Ticket 18: Assign to job — the Boneyard's one exit.
--
-- Boneyard stock exists to be used, and the exit is as deliberate as the
-- entrance: a foreman picks the job and the window number, because putting
-- material on a job changes what that job EXPECTS. That is a decision, not a
-- putaway — installers still find and move boneyard stock like anything else,
-- and checking it out to a job site does not assign it (checkout moves
-- material; assign changes the plan; two different acts).
--
-- The sticker's QR is the package's identity, so the physical label keeps
-- scanning after assignment; a fresh printed label is offered by the app,
-- never required. One movement line says what happened in words.
--
-- 'assigned' has been in movements_event_ck since the unit era — no
-- constraint is touched.
create or replace function assign_package_to_job(
  p_package uuid,
  p_project uuid,
  p_mark text
)
returns packages
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row packages;
  v_mark uuid;
  v_mark_code text;
  v_job text;
begin
  if not public.is_foreman_plus(auth.uid()) then
    raise exception 'only a foreman-level user or above can assign stock to a job';
  end if;
  if p_project is null then
    raise exception 'pick the job this package is going on';
  end if;

  select p.* into v_row from packages p where p.id = p_package;
  if not found then
    raise exception 'package not found';
  end if;
  if v_row.status = 'blank' then
    raise exception 'that sticker is not on a package yet — tag it first';
  end if;
  if v_row.project_id is not null then
    raise exception 'this package already belongs to a job — only Boneyard stock can be assigned';
  end if;

  v_mark_code := upper(trim(coalesce(p_mark, '')));
  if v_mark_code = '' then
    raise exception 'pick the window this package becomes part of';
  end if;
  select id into v_mark
  from project_marks
  where project_id = p_project and mark_code = v_mark_code;
  if v_mark is null then
    raise exception 'mark % is not on this job''s schedule', v_mark_code;
  end if;

  update packages
  set project_id = p_project
  where id = p_package
  returning * into v_row;

  insert into package_marks (package_id, mark_id)
  values (p_package, v_mark)
  on conflict do nothing;

  select job_code into v_job from projects where id = p_project;
  insert into movements (package_id, event, project_id, actor, reason)
  values (
    p_package, 'assigned', p_project, auth.uid()::text,
    'assigned from the Boneyard to ' || coalesce(v_job, 'a job') ||
      ' as window ' || v_mark_code
  );

  return v_row;
end;
$$;
