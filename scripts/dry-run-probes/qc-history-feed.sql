-- Rolled-back proof for the foreman QC history feed and its release note.
-- The harness owns the transaction; only its sandbox job is written here.
do $$
declare
  v_foreman uuid;
  v_installer uuid;
  v_job uuid;
  v_opening uuid := gen_random_uuid();
  v_decision uuid := gen_random_uuid();
  v_count int;
begin
  perform pg_temp.dry_run_as_system();
  v_foreman := pg_temp.dry_run_pick('foreman');
  v_installer := pg_temp.dry_run_pick('installer');
  v_job := pg_temp.dry_run_sandbox_job();
  insert into public.project_openings(id, project_id, opening_code, status)
    values (v_opening, v_job, 'DRY-HISTORY-' || left(v_opening::text, 8), 'installed');

  perform pg_temp.dry_run_act_as(v_foreman);
  perform public.record_qc_decision(v_decision, v_opening, 'passed', 'probe');
  select count(*) into v_count from public.qc_decision_events
    where id = v_decision and reviewer_id = v_foreman and status = 'passed';
  perform pg_temp.dry_run_check('QC history: foreman reads their recorded review',
    v_count = 1, format('expected 1, got %s', v_count));
  select count(*) into v_count from public.project_openings o
    join public.projects p on p.id = o.project_id
    where o.id = v_opening and p.id = v_job;
  perform pg_temp.dry_run_check('QC history: foreman reads unit and job details',
    v_count = 1, format('expected 1, got %s', v_count));
  select count(*) into v_count from public.profiles where id = v_foreman;
  perform pg_temp.dry_run_check('QC history: foreman reads reviewer name',
    v_count = 1, format('expected 1, got %s', v_count));

  perform pg_temp.dry_run_as_system();
  perform pg_temp.dry_run_act_as(v_installer);
  select count(*) into v_count from public.qc_decision_events where id = v_decision;
  perform pg_temp.dry_run_check('QC history: installer cannot read decisions',
    v_count = 0, format('expected 0, got %s', v_count));

  perform pg_temp.dry_run_as_system();
  select count(*) into v_count from pg_indexes
    where schemaname = 'public' and tablename = 'qc_decision_events'
      and indexname = 'qc_decision_events_recent_idx';
  perform pg_temp.dry_run_check('QC history: newest-first index exists',
    v_count = 1, format('expected 1, got %s', v_count));
  select count(*) into v_count from public.app_release_notes
    where id = '2026-09-30-qc-review-history'
      and audience = array[1,2,3] and kind = 'improvement'
      and withdrawn_at is null;
  perform pg_temp.dry_run_check('QC history: foreman-and-above release note exists',
    v_count = 1, format('expected 1, got %s', v_count));
end $$;
