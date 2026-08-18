-- The schedule gets a door (owner report, 2026-08-18).
--
-- Marks are born from spec review — plans go up, the extractor reads them,
-- the schedule fills. Right in general, and a wall with no door for a job
-- whose plans are not in the system yet: ZZTEST has zero marks, so EVERY tag
-- there was refused with "not on this job's schedule" and nothing said how
-- to fix it.
--
-- Foreman+, because adding a window changes what the job expects — the same
-- line assign-to-job draws. The spec can catch up later at spec review; a
-- mark without a spec is legal and always has been (the Not-Tagged card
-- counts them, ticket 20's empty state names them).
create or replace function add_project_mark(p_project uuid, p_mark text)
returns project_marks
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text;
  v_row project_marks;
begin
  if not public.is_foreman_plus(auth.uid()) then
    raise exception 'only a foreman-level user or above can add a window to the schedule';
  end if;
  if not exists (select 1 from projects where id = p_project) then
    raise exception 'job not found';
  end if;
  v_code := upper(trim(coalesce(p_mark, '')));
  if v_code = '' or length(v_code) > 12 then
    raise exception 'a window number is 1 to 12 characters';
  end if;

  insert into project_marks (project_id, mark_code)
  values (p_project, v_code)
  on conflict (project_id, mark_code) do nothing;

  select * into v_row
  from project_marks
  where project_id = p_project and mark_code = v_code;
  return v_row;
end;
$$;
