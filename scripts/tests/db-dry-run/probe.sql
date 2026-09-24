-- The probe for the harness test: every helper, used the way a real probe
-- uses it, against migration.sql's RPC — then the two ways a run on the real
-- database used to go wrong without saying so: the sandbox job stopped being
-- one, and a QA login lost its role.
do $$
declare
  v_installer uuid;
  v_foreman uuid;
  v_real uuid;
  v_job uuid;
  v_role text;
  v_note public.demo_notes;
  v_n int;
begin
  -- Look people and the job up first, as the system.
  perform pg_temp.dry_run_as_system();
  v_installer := pg_temp.dry_run_pick('installer');
  v_foreman := pg_temp.dry_run_pick('foreman');
  v_real := pg_temp.dry_run_pick_real('installer');
  v_job := pg_temp.dry_run_sandbox_job();
  perform pg_temp.dry_run_check('pick: the QA installer comes first',
    v_installer = '00000000-0000-4000-8000-000000000001', v_installer::text);
  perform pg_temp.dry_run_check('pick: the QA foreman comes first, ahead of the real one',
    v_foreman = '00000000-0000-4000-8000-000000000002', v_foreman::text);
  perform pg_temp.dry_run_check('pick_real: never the QA login, never the retired or partner one',
    v_real = '00000000-0000-4000-8000-000000000003', v_real::text);
  perform pg_temp.dry_run_check('sandbox_job: PECAN14 first',
    v_job = '00000000-0000-4000-8000-000000000092', v_job::text);
  perform pg_temp.dry_run_check('job: BLACK22 by code',
    pg_temp.dry_run_job('BLACK22') = '00000000-0000-4000-8000-000000000090', null);

  -- Act as the installer: the request looks like the app's.
  v_role := pg_temp.dry_run_act_as(v_installer);
  perform pg_temp.dry_run_check('act_as: runs as the authenticated role with their id',
    current_user = 'authenticated' and auth.uid() = v_installer and v_role = 'installer',
    current_user::text || ' / ' || coalesce(auth.uid()::text, 'null'));
  perform pg_temp.dry_run_check('act_as: a testing job is hidden from an installer, as in production',
    not exists (select 1 from public.projects where id = v_job), 'projects row not visible');

  -- Call the new RPC.
  v_note := public.demo_leave_note(v_job, 'dry run');
  perform pg_temp.dry_run_check('rpc: the installer''s note is saved under their id',
    v_note.author = v_installer and v_note.body = 'dry run', 'note ' || v_note.id);

  -- A call that must be refused, by the constraint only production has.
  perform pg_temp.dry_run_expect_error('rpc: a body over twenty characters is refused',
    format('select public.demo_leave_note(%L::uuid, %L)', v_job, 'this body is longer than twenty characters'),
    'demo_notes_body_short_ck');

  -- The table is server-only.
  perform pg_temp.dry_run_expect_error('rls: the installer cannot read the table directly',
    'select count(*) from public.demo_notes', 'permission denied');

  -- A second person, then back to the system to read the truth.
  perform pg_temp.dry_run_act_as(v_foreman);
  v_note := public.demo_leave_note(v_job, 'foreman here');
  perform pg_temp.dry_run_as_system();
  select count(*) into v_n from public.demo_notes where project_id = v_job;
  perform pg_temp.dry_run_check('system: both notes are on the job', v_n = 2, v_n || ' row(s)');
  perform pg_temp.dry_run_check('system: back to no caller', auth.uid() is null and current_user <> 'authenticated', current_user::text);
end $$;

-- The sandbox job when the first choices are gone, and the stop when none is
-- left. Changed as the system, inside the batch, so rolled back with it.
do $$
begin
  perform pg_temp.dry_run_as_system();
  delete from public.sandbox_projects where project_id = '00000000-0000-4000-8000-000000000092';
  perform pg_temp.dry_run_check('sandbox_job: BLACK22 once PECAN14 is off the sandbox list',
    pg_temp.dry_run_sandbox_job() = '00000000-0000-4000-8000-000000000090', null);
  -- As on 2026-09-24: BLACK22 unflagged.
  update public.projects set is_test = false where id = '00000000-0000-4000-8000-000000000090';
  perform pg_temp.dry_run_check('sandbox_job: then by code, past the trashed, unlisted, unflagged',
    pg_temp.dry_run_sandbox_job() = '00000000-0000-4000-8000-000000000093', null);
  update public.projects set deleted_at = now() where id = '00000000-0000-4000-8000-000000000093';
  perform pg_temp.dry_run_expect_error('sandbox_job: none left stops the run in plain words',
    'select pg_temp.dry_run_sandbox_job()', 'no job is both flagged as testing and on the sandbox list');
end $$;

-- A QA login that lost its role, as on 2026-09-23/24 when qa.installer had
-- been set to foreman: the picker stops, and never hands back the real
-- installer (who is refused on a testing job, which reads like the change is
-- broken). Rolled back with the batch.
do $$
begin
  perform pg_temp.dry_run_as_system();
  update public.profiles set role = 'foreman' where id = '00000000-0000-4000-8000-000000000001';
  perform pg_temp.dry_run_expect_error('pick: no QA installer stops the run, never a real installer',
    'select pg_temp.dry_run_pick(''installer'')', 'no QA login has the installer role');
  perform pg_temp.dry_run_check('pick_real: the real installer, for a probe that means one',
    pg_temp.dry_run_pick_real('installer') = '00000000-0000-4000-8000-000000000003', null);
  update public.profiles set role = 'installer'
   where id in ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002');
  perform pg_temp.dry_run_expect_error('pick: no QA foreman stops the run, never a real foreman',
    'select pg_temp.dry_run_pick(''foreman'')', 'no QA login has the foreman role');
  perform pg_temp.dry_run_check('pick: a role with no QA login still gets a real person',
    pg_temp.dry_run_pick('supervisor') = '00000000-0000-4000-8000-000000000004', null);
  perform pg_temp.dry_run_expect_error('pick: a role nobody holds stops the run',
    'select pg_temp.dry_run_pick(''owner'')', 'nobody with the role owner');
end $$;
