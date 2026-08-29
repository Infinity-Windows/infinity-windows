-- Wave D, D5 (AUDIT HOLE 7): the 30-day blind spot on child-table reads.
--
-- The trash RLS predicate on `projects` (20260959000000) hides a trashed
-- job's OWN row from everyone but the owner. It does nothing for a read that
-- queries a CHILD table directly by project_id (an installer's cross-job
-- opening list, the live-summons feed, the crew schedule board) — those
-- rows are untouched by trash for the whole 30-day window, because trash
-- never rewrites project_id anywhere (only purge_project does, and only at
-- the end of the window).
--
-- A naive fix — embed `projects!inner(...)` on these reads so PostgREST
-- inner-joins against the RLS-filtered `projects` table — was tried first
-- and rejected: `projects_select_visible`'s is_test branch means an inner
-- join would ALSO cut a non-supervisor installer off from their own
-- assigned openings on a TEST project (BLACK22), which is a real, working,
-- unrelated feature this migration must not touch. Wave D wants exactly one
-- predicate (deleted_at), not every predicate `projects` happens to carry.
--
-- So: a small SECURITY DEFINER helper, the same shape as is_partner_user()
-- and my_role_rank() — it bypasses RLS on purpose, checks ONLY deleted_at,
-- and answers correctly for every caller regardless of rank or is_test.
-- Called once per list (batched over every distinct project_id already in
-- the result set), never per-row — the N+1 the spec explicitly says to
-- avoid.

create or replace function public.live_project_ids(p_ids uuid[])
returns uuid[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(array_agg(id), '{}')
  from projects
  where id = any (p_ids) and deleted_at is null;
$$;

comment on function public.live_project_ids(uuid[]) is
  'Wave D: given a candidate list of project ids, returns just the ones NOT currently trashed. SECURITY DEFINER so it answers correctly for every caller regardless of the is_test/partner-grant branches on projects_select_visible — this checks deleted_at ONLY. The batched, N+1-free way a cross-job app read (an installer''s all-jobs opening list, the live summons feed, the crew schedule board) filters out a trashed job''s rows without an inner-join side effect on test-project visibility.';

revoke all on function public.live_project_ids(uuid[]) from public, anon;
grant execute on function public.live_project_ids(uuid[]) to authenticated;
