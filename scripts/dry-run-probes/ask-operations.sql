-- Rolled-back proof for Ask's reviewed, atomic mapped-unit removal.
do $$
declare
  v_job uuid;
  v_installer uuid;
  v_foreman uuid;
  v_first uuid := gen_random_uuid();
  v_second uuid := gen_random_uuid();
  v_protected uuid := gen_random_uuid();
  v_result jsonb;
  v_count int;
begin
  perform pg_temp.dry_run_as_system();
  v_job := pg_temp.dry_run_sandbox_job();
  v_installer := pg_temp.dry_run_pick('installer');
  v_foreman := pg_temp.dry_run_pick('foreman');
  insert into public.project_openings (id, project_id, opening_code, status)
    values (v_first, v_job, 'DRY-ASK-' || left(v_first::text, 8), 'planned'),
           (v_second, v_job, 'DRY-ASK-' || left(v_second::text, 8), 'planned'),
           (v_protected, v_job, 'DRY-ASK-' || left(v_protected::text, 8), 'installed');

  perform pg_temp.dry_run_act_as(v_installer);
  perform pg_temp.dry_run_expect_error('installer cannot remove mapped units',
    format('select public.ai_remove_openings(%L::uuid, array[%L::uuid])', v_job, v_first),
    'foreman');

  perform pg_temp.dry_run_as_system();
  perform pg_temp.dry_run_act_as(v_foreman);
  perform pg_temp.dry_run_expect_error('one protected unit refuses the entire batch',
    format('select public.ai_remove_openings(%L::uuid, array[%L::uuid,%L::uuid])', v_job, v_first, v_protected),
    'Nothing was removed');
  perform pg_temp.dry_run_as_system();
  select count(*) into v_count from public.project_openings
    where id in (v_first, v_protected) and removed_at is null;
  perform pg_temp.dry_run_check('failed batch kept both openings live', v_count = 2,
    format('expected 2 live openings, got %s', v_count));

  perform pg_temp.dry_run_act_as(v_foreman);
  v_result := public.ai_remove_openings(v_job, array[v_first,v_second]);
  perform pg_temp.dry_run_check('foreman receives receipt for both units',
    jsonb_array_length(v_result->'removed') = 2,
    format('expected 2 receipt rows, got %s', jsonb_array_length(v_result->'removed')));
  v_result := public.ai_remove_openings(v_job, array[v_first,v_second]);
  perform pg_temp.dry_run_check('retry returns both already-removed units',
    jsonb_array_length(v_result->'removed') = 2,
    format('expected 2 receipt rows, got %s', jsonb_array_length(v_result->'removed')));
  perform pg_temp.dry_run_as_system();
  select count(*) into v_count from public.project_openings
    where id in (v_first,v_second) and removed_at is not null and removed_by = v_foreman;
  perform pg_temp.dry_run_check('both removed units retain audit actor', v_count = 2,
    format('expected 2 audited openings, got %s', v_count));
end $$;
