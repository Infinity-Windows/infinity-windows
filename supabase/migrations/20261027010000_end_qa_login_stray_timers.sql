-- End the timers a QA login left running on a job that stopped being a
-- practice job.
--
-- WHY. The QA logins (profiles.is_test, docs/test-account.md) may only write on
-- a job on the sandbox list — the fence in 20260730220000. qa.foreman still had
-- a task timer running on BLACK22 from 2026-09-02, when BLACK22 was the sandbox
-- job; BLACK22 has since stopped being a testing job. The login could never end
-- it: every start hands open timers off (custom_work_command's start ends every
-- open task and unit timer first), the fence refuses a test login touching a
-- row on a non-sandbox job, and no function lets a supervisor end another
-- person's timer. So Prep time and unit starts failed for that login — found by
-- the PR #642 database practice run, 2026-09-24.
--
-- WHAT. Every task, unit or custom-work timer a QA login has open on a job that
-- is not on the sandbox list is ended at its own start: zero length, so no
-- labour is invented on a job the crew can see. A timer with no job is left
-- alone. Real people's rows are never touched — every statement is fenced on
-- is_test. The fence itself does not stand in the way: it acts on the signed-in
-- caller, and a migration has none. A no-op once applied, and on any day no QA
-- login has strayed.

update public.task_sessions t
   set ended_at = t.started_at
  from public.profiles p
 where p.id = t.profile_id
   and coalesce(p.is_test, false)
   and t.ended_at is null
   and coalesce(t.project_id, (select o.project_id from public.project_openings o where o.id = t.opening_id)) is not null
   and not public.is_sandbox_project(coalesce(t.project_id, (select o.project_id from public.project_openings o where o.id = t.opening_id)));

update public.unit_sessions s
   set ended_at = s.started_at, end_reason = 'auto_closed'
  from public.profiles p, public.project_openings o
 where p.id = s.profile_id
   and o.id = s.opening_id
   and coalesce(p.is_test, false)
   and s.ended_at is null
   and not public.is_sandbox_project(o.project_id);

update public.custom_work_sessions c
   set ended_at = c.started_at, end_reason = 'auto_closed'
  from public.profiles p
 where p.id = c.profile_id
   and coalesce(p.is_test, false)
   and c.ended_at is null
   and c.project_id is not null
   and not public.is_sandbox_project(c.project_id);
