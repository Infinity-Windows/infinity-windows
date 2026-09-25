-- Let a test login see the practice job it is allowed to work on — and no
-- other testing job.
--
-- WHY. The QA test logins (profiles.is_test: qa.installer and qa.foreman,
-- docs/test-account.md) may only WRITE on a job on the sandbox list — the
-- fence in 20260730220000. But the projects read rule (projects_select_visible,
-- 20260933000000, last rebuilt in 20260974000000) hides every testing project
-- (projects.is_test) from everyone below supervisor, and the test logins are an
-- installer and a foreman. So the one kind of job they may work on was the one
-- kind they could not see: PECAN14, the practice job, is both a testing project
-- and on the sandbox list, and neither login could pick it at clock-in or open
-- its units. On 2026-09-24 the owner ran the phone drill on his own account
-- with "View as Installer" instead.
--
-- WHAT. One more alternative in the read rule: a test login that is a current
-- crew login sees a job that is BOTH a testing project AND on the sandbox list.
-- "Current crew login" is custom_work_internal(), the check the drill's own
-- rows (custom units, sessions, history, crew records) already make of the
-- reader: not a partner, not retired, access not revoked, a crew role. The test
-- flag alone is not enough — is_test_profile() reads nothing but is_test, and a
-- partner, a retired login or one whose access was revoked, with a token still
-- in hand, must not be carried onto a practice job by it (Codex review of #657).
-- is_test_profile() itself stays as it is: the analytics exclusions call it.
-- Nothing else moves:
--   * Everyone who is not a test login reads exactly the jobs they read before.
--     The new alternative needs is_test_profile(auth.uid()), which is false for
--     every real person: profiles.is_test is revoked from anon and
--     authenticated, so only the service-role key can set it (20260730120000).
--   * A test login still never sees any OTHER testing project: one that is not
--     on the sandbox list stays hidden from it, as from every installer and
--     foreman. Real jobs it could already see, as every installer can.
--   * The trash gate still wraps the whole rule, so a practice job in the trash
--     is hidden from a test login like any trashed job.
--   * The partner branch is byte-identical (scripts/test_partner_wall.py pins
--     it), and so is every other branch: rebuilt in full, never a diff.
-- No new function: is_test_profile(), custom_work_internal() and
-- is_sandbox_project() already exist, pin their search_path, and are
-- executable by authenticated and not by anon.
--
-- The branch's own `is_test` is implied: a job whose flag is false already
-- passed `is_test = false`, and the column is NOT NULL. It is written out so
-- the rule says what the owner asked for in his words, and so that a flag that
-- could ever be unknown would count as no practice job at all.
--
-- THE CHILD TABLES follow on their own. The rows the drill reads under a job —
-- custom units, their sessions and history, crew work records, Forge AI field
-- jobs, job documents — check the job through `exists (select 1 from
-- public.projects ...)`, which runs under the caller's own row security, so
-- they open with the job. No other read policy looks at projects.is_test
-- (every policy in supabase/migrations/ replayed with scripts/
-- partner_wall_lib.py, 2026-09-25). Openings, shifts, toolbox talks, the job's
-- pipeline row and photos never depended on it.
--
-- WRITES DO NOT WIDEN. Every write a test login makes is still refused off the
-- sandbox list by the guard triggers and the storage policies. This changes
-- only what it may READ, and only on jobs it could already write.

drop policy if exists "projects_select_visible" on projects;
create policy "projects_select_visible" on projects
  for select to authenticated using (
    (deleted_at is null or _is_supervisor(auth.uid()))
    and (
      is_test = false or _is_supervisor(auth.uid())
      or (
        public.is_partner_user()
        and exists (
          select 1 from partner_job_grants g
          where g.project_id = projects.id and g.partner_profile_id = auth.uid()
        )
      )
      or (
        is_test
        and public.is_test_profile(auth.uid())
        and public.custom_work_internal()
        and public.is_sandbox_project(projects.id)
      )
    )
  );

comment on column projects.is_test is
  'Fake data for practice or QA — never a real job. Rows are invisible below supervisor (RLS, projects_select_visible), except to a test login (profiles.is_test) that is a current crew login (custom_work_internal()) when the job is also on sandbox_projects (20261030030000), and their packages are excluded from every warehouse inventory figure client-side (app/src/lib/warehouse/testPartition.ts) since the child tables are not RLS-gated on this flag. Written only by set_project_test(); insert/update on this column are revoked from anon and authenticated, exactly like profiles.is_test (20260730120000).';
