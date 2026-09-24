-- A PROBE for the rolled-back database practice run (docs/db-dry-run.md).
--
-- Copy this to scripts/dry-run-probes/pr-<number>-<what>.sql and make it call
-- every RPC the pull request adds or changes, as the people who will call it,
-- on the sandbox job. scripts/db-dry-run.sh runs it INSIDE one transaction,
-- after the pull request's migrations, and then rolls the whole thing back —
-- so write freely: nothing here survives. What survives is the list of
-- checks, which comes back as the run's result and fails the run on any
-- ok=false.
--
-- THE RULES
--   * Never open, commit or roll back a transaction. The batch owns it, and
--     the builder refuses a probe that carries any transaction control.
--   * Write on the sandbox job from dry_run_sandbox_job(), never a job pinned
--     by its code: whichever live job is flagged as testing AND on the sandbox
--     list (PECAN14 first), the one kind of job the QA logins may write
--     (docs/test-account.md). Everything is rolled back anyway; the sandbox is
--     the belt to those braces. BLACK22 was the sandbox until 2026-09-24, and
--     probes pinned to it died on the fence instead of testing the change.
--   * Act as people, not as the system, for every RPC call: the point is to
--     hit the grants, the policies and auth.uid() the app will hit. Use the
--     system only to set up and to read the truth afterwards.
--   * Pick people and jobs BEFORE acting as someone (the pickers reset to the
--     system, and a testing job is hidden from installers by design).
--   * An installer or a foreman is the QA login or nobody: dry_run_pick stops
--     the run, naming the login to fix, when that login has lost its role. A
--     probe that means a real person asks dry_run_pick_real.
--   * If the probe itself cannot start (nothing on the sandbox job to try the
--     change on), stop with raise exception 'dry run: ...' saying what to fix.
--     The report then says the run could not set itself up, not that the
--     change is broken.
--   * Details are for ids and counts. The run's log is readable by everyone
--     with access to the repository, so never a person's name or email.
--   * Every check has a name a human can read in a table, and says what was
--     expected when it fails ("expected 1 row, got 2").
--
-- THE HARNESS (all in pg_temp; scripts/db_dry_run.py defines them)
--   dry_run_pick(role)          uuid   the QA login of that role; installer and foreman stop the run
--                                      if theirs lost the role; other roles have none: a real person
--   dry_run_pick_real(role)     uuid   a real person of that role, never a QA login
--   dry_run_sandbox_job()       uuid   the job to write on: live, flagged testing, on the sandbox list
--   dry_run_job(code)           uuid   a job by its code, to read it or prove a fence holds on it
--   dry_run_act_as(profile)     text   from here on, that person's JWT and the authenticated role
--   dry_run_as_system()         void   from here on, the system: no caller, no row security
--   dry_run_check(name, ok, detail)         record a check
--   dry_run_expect_error(name, sql, text)   run sql that MUST be refused; passes when it raises
--                                           (mentioning text, if given), and its writes are undone
--
-- One `do` block per scenario keeps variables together; end each as the
-- system so the next starts clean. A `do` block that raises unexpectedly
-- ends the whole run as "the change is broken", which is the right answer.
do $$
declare
  v_installer uuid;
  v_job uuid;
  v_role text;
  v_n int;
begin
  -- 1. Setup, as the system. Look everyone and everything up first.
  perform pg_temp.dry_run_as_system();
  v_installer := pg_temp.dry_run_pick('installer');
  v_job := pg_temp.dry_run_sandbox_job();
  -- Arrange what the RPC needs, e.g. today's toolbox talk for a clock-in:
  --   insert into public.toolbox_completions (profile_id, signed_at) values (v_installer, now());

  -- 2. Act as the installer and call the new RPC the way the app does.
  v_role := pg_temp.dry_run_act_as(v_installer);
  perform pg_temp.dry_run_check('acting as an installer with their own id',
    current_user = 'authenticated' and auth.uid() = v_installer and v_role = 'installer',
    current_user::text);
  --   v_row := public.the_new_rpc(p_project_id => v_job, ...);
  --   perform pg_temp.dry_run_check('the_new_rpc: makes one row', v_row.id is not null, 'row ' || v_row.id);

  -- 3. A call that must be refused: the check passes when the database says no.
  --   perform pg_temp.dry_run_expect_error('the_new_rpc: a second close is refused',
  --     format('select public.the_new_rpc(%L::uuid)', v_row.id), 'already');

  -- 4. Read the truth as the system, and end there.
  perform pg_temp.dry_run_as_system();
  select count(*) into v_n from public.projects where id = v_job;
  perform pg_temp.dry_run_check('the sandbox job exists', v_n = 1, v_n || ' row(s)');
end $$;
