-- An install start stamp can no longer sit on a window for ever.
--
-- The bug this closes was live on production. Three windows carried a
-- `project_openings.work_started_at` that nobody ever finished, and the
-- Heartbeat "Live crew" list read those stamps straight into a live counter:
--
--   OAKRIDGE  C101  started 2026-07-17 06:05:21Z  ~327h  "Taylor"
--   OAKRIDGE  C103  started 2026-07-17 06:06:56Z  ~327h  "Unassigned"
--   PECAN14   1-1   started 2026-07-18 04:22:43Z  ~305h  "Unassigned"
--
-- The two OAKRIDGE stamps are 95 seconds apart, which is somebody tapping
-- through the app rather than two installs beginning at six in the morning.
-- Every one of them was a leftover: all three openings were still `planned`,
-- `work_ended_at` was null, and `install_events`, `task_sessions`, `qc_checks`,
-- `issues` and `points_ledger` held no row for them — nor, at the time, any row
-- at all.
--
-- The display was the visible half. The quieter half is that "in progress" is
-- not just a label: My Work pins an in-progress window to the top as Continue
-- and drops it out of the queue, and Home shows it in place of your next
-- window. One forgotten tap therefore stood between somebody and their work.
--
-- The rule adopted here is the one the install timer settled on in PR #198 and
-- the shift guard reused in PR #218: past the point where an auto-timed figure
-- is believable, stop counting rather than state a number nobody can stand
-- behind. A stamp older than the cap is not a running install.
--
-- Nothing is deleted, no opening's status, assignment, pin or measurement is
-- touched, and a stamp with any install work behind it is left exactly as it
-- is. Idempotent.

-- 1) The cap, in one place, so SQL and the client cannot drift ---------------
-- Mirrors AUTO_TIMER_CAP_MINUTES in app/src/lib/install/installTimer.ts.
-- Eight hours is past any single window: a real install does not outlast the
-- shift it started in, so beyond it the stamp is measuring a forgotten tap.
-- installTimer.test.ts holds this function's text against the constant, so the
-- two cannot drift apart silently.

create or replace function install_timer_cap_minutes()
returns int language sql immutable set search_path = public, pg_temp as $$
  select 480
$$;

-- Find the runaways quickly from the office screen.
create index if not exists project_openings_unfinished_work_idx
  on project_openings (work_started_at)
  where work_started_at is not null and work_ended_at is null;

-- 2) Retire the stamps that already exist -----------------------------------
-- Condition-based rather than by id, so it states the rule instead of naming
-- three rows, and so re-running it is a no-op. The guards are what make it
-- safe: a window that was actually installed, that has a finish time, or that
-- has any install event, task session or QC check against it keeps its stamp,
-- because there the elapsed time is evidence of something.
--
-- Openings hidden by PR #214 are left alone too. Removal deliberately stopped
-- destroying what was recorded against a window, and a hidden row is filtered
-- out of every screen by row-level security anyway, so there is nothing to fix
-- and something small to lose.

update project_openings o
   set work_started_at = null
 where o.work_started_at is not null
   and o.work_ended_at is null
   and o.removed_at is null
   and o.status <> 'installed'
   and now() - o.work_started_at > make_interval(mins => install_timer_cap_minutes())
   and not exists (select 1 from install_events e where e.project_opening_id = o.id)
   and not exists (select 1 from task_sessions s where s.opening_id = o.id)
   and not exists (select 1 from qc_checks q where q.project_opening_id = o.id);
