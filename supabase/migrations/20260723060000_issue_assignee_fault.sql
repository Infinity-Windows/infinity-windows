-- Richer issue detail: who is on the hook to fix it, and whose fault it was.
--
-- The unified `issues` table (20260718005000_issues.sql) already links each
-- problem to its project + opening + unit and tracks who opened / resolved it.
-- This adds two people-attribution columns so the cross-project Issues board can
-- show, per problem:
--   * assigned_to — who is responsible for fixing it (the assignee).
--   * fault_by    — whose fault it was, if determined (fault attribution).
-- Both are nullable (a problem can be unassigned / fault undetermined) and both
-- clear to null if that profile is removed, matching created_by / resolved_by.

alter table issues add column if not exists assigned_to uuid
  references profiles(id) on delete set null;
alter table issues add column if not exists fault_by uuid
  references profiles(id) on delete set null;

create index if not exists issues_assigned_idx on issues (assigned_to);
create index if not exists issues_fault_idx on issues (fault_by);

-- --- RPCs -------------------------------------------------------------------
-- Both are foreman+ management actions, matching the guard on list_issues():
-- a plain installer, or a missing/unknown profile, is rejected. security definer
-- so the guard runs regardless of the caller's RLS. Passing null clears the
-- field (unassign / fault undetermined).

create or replace function assign_issue(p_id uuid, p_assignee uuid default null)
returns issues
language plpgsql
security definer
as $$
declare
  v_role text;
  v_issue issues;
begin
  select role into v_role from profiles where id = auth.uid();
  if v_role is null or v_role = 'installer' then
    raise exception 'only a foreman-level user or above can assign an issue';
  end if;

  update issues
  set assigned_to = p_assignee
  where id = p_id
  returning * into v_issue;
  if v_issue is null then
    raise exception 'unknown issue %', p_id;
  end if;
  return v_issue;
end;
$$;

create or replace function set_issue_fault(p_id uuid, p_fault_by uuid default null)
returns issues
language plpgsql
security definer
as $$
declare
  v_role text;
  v_issue issues;
begin
  select role into v_role from profiles where id = auth.uid();
  if v_role is null or v_role = 'installer' then
    raise exception 'only a foreman-level user or above can attribute fault';
  end if;

  update issues
  set fault_by = p_fault_by
  where id = p_id
  returning * into v_issue;
  if v_issue is null then
    raise exception 'unknown issue %', p_id;
  end if;
  return v_issue;
end;
$$;
