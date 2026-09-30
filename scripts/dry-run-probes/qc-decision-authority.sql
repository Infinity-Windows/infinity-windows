-- Exercise the QC decision RPC against the actual schema on a sandbox job.
-- db-dry-run owns the transaction and rolls all of these writes back.
do $$
declare
  v_foreman uuid;
  v_installer uuid;
  v_job uuid;
  v_opening uuid := gen_random_uuid();
  v_other uuid := gen_random_uuid();
  v_request uuid := gen_random_uuid();
  v_actor_role text;
  v_count int;
  v_status text;
begin
  perform pg_temp.dry_run_as_system();
  v_foreman := pg_temp.dry_run_pick('foreman');
  v_installer := pg_temp.dry_run_pick('installer');
  v_job := pg_temp.dry_run_sandbox_job();
  insert into public.project_openings(id, project_id, opening_code, status)
    values (v_opening, v_job, 'DRY-QC-' || left(v_opening::text, 8), 'installed'),
           (v_other, v_job, 'DRY-QC-' || left(v_other::text, 8), 'installed');

  v_actor_role := pg_temp.dry_run_act_as(v_installer);
  perform pg_temp.dry_run_check('QC: installer role selected', v_actor_role = 'installer', v_actor_role);
  perform pg_temp.dry_run_expect_error('QC: installer cannot record a decision',
    format('select public.record_qc_decision(%L::uuid,%L::uuid,%L,%L)',
      gen_random_uuid(), v_opening, 'passed', 'probe'), 'foreman');

  v_actor_role := pg_temp.dry_run_act_as(v_foreman);
  perform pg_temp.dry_run_check('QC: foreman role selected', v_actor_role = 'foreman', v_actor_role);
  perform public.record_qc_decision(v_request, v_opening, 'passed', 'probe');
  perform public.record_qc_decision(v_request, v_opening, 'passed', 'probe');
  perform pg_temp.dry_run_as_system();
  select count(*) into v_count from public.qc_decision_events where id = v_request;
  perform pg_temp.dry_run_check('QC: repeating the same request creates one audit event',
    v_count = 1, v_count || ' event(s)');
  select status into v_status from public.qc_checks where project_opening_id = v_opening;
  perform pg_temp.dry_run_check('QC: current status is passed', v_status = 'passed', v_status);

  perform pg_temp.dry_run_act_as(v_foreman);
  perform pg_temp.dry_run_expect_error('QC: request ID cannot move to another unit',
    format('select public.record_qc_decision(%L::uuid,%L::uuid,%L,%L)',
      v_request, v_other, 'passed', 'probe'), 'already used');
  perform pg_temp.dry_run_as_system();
  select count(*) into v_count from public.qc_checks where project_opening_id = v_other;
  perform pg_temp.dry_run_check('QC: conflicting retry did not change another unit',
    v_count = 0, v_count || ' row(s)');
end $$;
