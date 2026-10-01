-- Role-aware practice run on the actual schema. The outer db-dry-run batch
-- owns the transaction and forcibly rolls it back; no data survives this probe.
do $$
declare
  v_foreman uuid;
  v_installer uuid;
  v_job uuid;
  v_unit uuid := gen_random_uuid();
  v_other uuid := gen_random_uuid();
  v_legacy uuid := gen_random_uuid();
  v_request uuid := gen_random_uuid();
  v_callback uuid := gen_random_uuid();
  v_stale uuid := gen_random_uuid();
  v_prefix text := 'DRY-QCF-' || left(gen_random_uuid()::text, 8) || '%_';
  v_page jsonb;
  v_jobs jsonb;
  v_first jsonb;
  v_version text;
  v_later text;
  v_count integer;
  v_status text;
  v_role text;
begin
  perform pg_temp.dry_run_as_system();
  v_foreman := pg_temp.dry_run_pick('foreman');
  v_installer := pg_temp.dry_run_pick('installer');
  v_job := pg_temp.dry_run_sandbox_job();
  if not exists(select 1 from public.projects where id = v_job and 'data' = any(allowed_modes)) then
    raise exception 'dry run: QC needs a sandbox job with data mode enabled.';
  end if;
  insert into public.project_openings(id, project_id, opening_code, status)
    values (v_unit, v_job, v_prefix || '-ONE', 'installed'),
           (v_other, v_job, v_prefix || '-TWO', 'installed'),
           (v_legacy, v_job, v_prefix || '-OLD', 'installed');

  v_role := pg_temp.dry_run_act_as(v_installer);
  perform pg_temp.dry_run_check('QC review: installer role selected',
    v_role = 'installer' and current_user = 'authenticated' and auth.uid() = v_installer, v_role);
  perform pg_temp.dry_run_expect_error('QC review: installer cannot list jobs',
    'select public.qc_review_jobs()', 'foreman');
  perform pg_temp.dry_run_expect_error('QC review: installer cannot read queue',
    format('select public.qc_review_page(%L::uuid)', v_job), 'foreman');
  perform pg_temp.dry_run_expect_error('QC review: installer cannot save',
    format('select public.record_qc_review_decision(%L::uuid,%L::uuid,%L::uuid,%L,%L)',
      gen_random_uuid(), v_job, v_unit, 'passed', 'none'), 'foreman');

  v_role := pg_temp.dry_run_act_as(v_foreman);
  perform pg_temp.dry_run_check('QC review: foreman role selected',
    v_role = 'foreman' and current_user = 'authenticated' and auth.uid() = v_foreman, v_role);
  v_jobs := public.qc_review_jobs('', 50, null, v_job);
  perform pg_temp.dry_run_check('QC review: sandbox job visible to QA foreman',
    v_jobs#>>'{selected,id}' = v_job::text,
    'job ' || v_job);
  v_jobs := public.qc_review_jobs(v_prefix || 'no-job-match', 1, null, v_job);
  perform pg_temp.dry_run_check('QC review: canonical selected job survives list search',
    v_jobs#>>'{selected,id}' = v_job::text and jsonb_array_length(v_jobs->'rows') = 0
      and (v_jobs->>'totalCount')::integer = 0, 'job ' || v_job);
  v_page := public.qc_review_page(v_job, 'all', v_prefix, 1, null, null, v_unit);
  perform pg_temp.dry_run_check('QC review: literal full-job search has exact count',
    (v_page->>'totalCount')::integer = 3 and jsonb_array_length(v_page->'rows') = 1
      and (v_page->>'hasNext')::boolean and not (v_page->>'hasPrevious')::boolean,
    v_page->>'totalCount');
  perform pg_temp.dry_run_check('QC review: selected fresh unit has absent-row version',
    v_page#>>'{selected,id}' = v_unit::text and v_page#>>'{selected,reviewVersion}' = 'none',
    v_page#>>'{selected,reviewVersion}');
  v_first := v_page;
  v_page := public.qc_review_page(v_job, 'all', v_prefix, 1, v_first->'nextCursor');
  perform pg_temp.dry_run_check('QC review: next page is distinct with truthful count',
    v_page#>>'{rows,0,id}' <> v_first#>>'{rows,0,id}'
      and (v_page->>'totalCount')::integer = 3 and (v_page->>'hasPrevious')::boolean,
    v_page#>>'{rows,0,id}');
  v_page := public.qc_review_page(v_job, 'all', v_prefix, 1, null, v_page->'previousCursor');
  perform pg_temp.dry_run_check('QC review: previous page restores first row',
    v_page#>>'{rows,0,id}' = v_first#>>'{rows,0,id}', v_page#>>'{rows,0,id}');

  perform public.record_qc_review_decision(v_request, v_job, v_unit, 'passed', 'none', '  probe pass  ');
  v_page := public.qc_review_page(v_job, 'all', v_prefix, 50, null, null, v_unit);
  v_version := v_page#>>'{selected,reviewVersion}';
  perform pg_temp.dry_run_check('QC review: saved unit remains selected outside queue',
    v_page#>>'{selected,qcStatus}' = 'passed' and not (v_page#>>'{selected,matchesFilter}')::boolean
      and v_version is not null and v_version <> 'none' and (v_page->>'totalCount')::integer = 2,
    v_version);
  perform public.record_qc_review_decision(v_request, v_job, v_unit, 'passed', 'none', 'probe pass');
  perform pg_temp.dry_run_expect_error('QC review: request cannot change its note',
    format('select public.record_qc_review_decision(%L::uuid,%L::uuid,%L::uuid,%L,%L,%L)',
      v_request, v_job, v_unit, 'passed', 'none', 'different'), 'already used');
  perform pg_temp.dry_run_expect_error('QC review: request cannot change expected version',
    format('select public.record_qc_review_decision(%L::uuid,%L::uuid,%L::uuid,%L,%L,%L)',
      v_request, v_job, v_unit, 'passed', v_version, 'probe pass'), 'already used');
  perform pg_temp.dry_run_expect_error('QC review: stale first review is rejected',
    format('select public.record_qc_review_decision(%L::uuid,%L::uuid,%L::uuid,%L,%L,%L)',
      v_stale, v_job, v_unit, 'callback', 'none', 'stale'), 'QC changed');
  perform public.record_qc_review_decision(v_callback, v_job, v_unit, 'callback', v_version, 'probe callback');
  perform public.record_qc_review_decision(v_request, v_job, v_unit, 'passed', 'none', 'probe pass');
  v_page := public.qc_review_page(v_job, 'callbacks', v_prefix, 50, null, null, v_unit);
  v_later := v_page#>>'{selected,reviewVersion}';
  perform pg_temp.dry_run_check('QC review: replay confirms history without replacing later callback',
    v_page#>>'{selected,qcStatus}' = 'callback' and v_later <> v_version
      and (v_page->>'totalCount')::integer = 1, v_later);

  update public.qc_checks set review_version = gen_random_uuid() where project_opening_id = v_unit;
  v_page := public.qc_review_page(v_job, 'callbacks', v_prefix, 50, null, null, v_unit);
  perform pg_temp.dry_run_check('QC review: forged version-only update is ignored',
    v_page#>>'{selected,reviewVersion}' = v_later, v_page#>>'{selected,reviewVersion}');
  perform public.record_qc_decision(gen_random_uuid(), v_legacy, 'callback', 'old phone');
  v_page := public.qc_review_page(v_job, 'callbacks', v_prefix, 50, null, null, v_legacy);
  v_version := v_page#>>'{selected,reviewVersion}';
  update public.qc_checks set status = 'passed', note = 'direct phone' where project_opening_id = v_legacy;
  perform pg_temp.dry_run_expect_error('QC review: legacy direct write invalidates new-client version',
    format('select public.record_qc_review_decision(%L::uuid,%L::uuid,%L::uuid,%L,%L,%L)',
      gen_random_uuid(), v_job, v_legacy, 'callback', v_version, 'stale'), 'QC changed');

  perform pg_temp.dry_run_as_system();
  select count(*) into v_count from public.qc_decision_events where id in (v_request, v_callback);
  perform pg_temp.dry_run_check('QC review: two decisions and exact retries make two immutable events',
    v_count = 2, v_count || ' events');
  select count(*) into v_count from public.qc_decision_events where id = v_stale;
  perform pg_temp.dry_run_check('QC review: stale event rolled back atomically', v_count = 0, v_count || ' events');
  select status into v_status from public.qc_checks where project_opening_id = v_unit;
  perform pg_temp.dry_run_check('QC review: later callback remains current', v_status = 'callback', v_status);
end $$;
