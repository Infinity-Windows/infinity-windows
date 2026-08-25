-- The Boneyard's assign exit meets pending-job material (audit after the
-- expected-deliveries change): a package waiting under a TYPED job name is
-- project-less, so the ticket-18 assign flow opens on it too — but the old
-- body left pending_job_name/pending_issue_id behind, so the package kept
-- claiming to wait for a job it already had, and the supervisor's
-- missing_job issue never resolved. Rebuilt from the CURRENT definition
-- (20260909) with exactly that cleanup added; same signature, no drop
-- needed. file_pending_packages remains the bulk path — both now leave the
-- same clean state behind.

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
  v_issue uuid;
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

  v_issue := v_row.pending_issue_id;

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
  set project_id = p_project,
      pending_job_name = null,
      pending_issue_id = null
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

  -- The missing_job issue resolves when its last waiting package files —
  -- byte-for-byte the rule file_pending_packages follows.
  if v_issue is not null and not exists (
    select 1 from packages
    where pending_issue_id = v_issue and project_id is null
  ) then
    update issues
       set status = 'resolved', resolved_by = auth.uid(), resolved_at = now()
     where id = v_issue and status = 'open';
  end if;

  return v_row;
end;
$$;
