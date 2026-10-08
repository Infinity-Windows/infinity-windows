-- Every mutation is confined to the QA sandbox and the harness forces rollback.
do $$
declare
  v_job uuid; v_foreman uuid; v_installer uuid; v_row public.project_pipeline;
  v_items jsonb; v_after jsonb; v_count int; v_before jsonb; v_original_role text; v_role text;
begin
  perform pg_temp.dry_run_as_system();
  v_job := pg_temp.dry_run_sandbox_job();
  v_foreman := pg_temp.dry_run_pick('foreman');
  v_installer := pg_temp.dry_run_pick('installer');
  select role into v_original_role from profiles where id=v_foreman and is_test is true;
  if v_original_role is null then raise exception 'dry run: refuses non-QA role change'; end if;
  -- A genuinely incomplete checklist, without assigning/signing anything.
  update project_build_facts set gc_contact_name=null where project_id=v_job;
  insert into project_pipeline(project_id, ready_state, materials_eta, materials_arrived_at)
    values(v_job,'not_ready',date '2026-10-08',timestamptz '2026-10-08T12:00:00Z')
    on conflict(project_id) do update set ready_state='not_ready',materials_eta=excluded.materials_eta,materials_arrived_at=excluded.materials_arrived_at;
  select jsonb_agg(to_jsonb(g) order by item_key) into v_items from public.green_light_items(v_job) g;
  select count(*) into v_count from public.green_light_items(v_job) where not answered;
  perform pg_temp.dry_run_check('sandbox has unfinished setup reminders',v_count>0);
  foreach v_role in array array['foreman','supervisor','owner'] loop
    perform pg_temp.dry_run_as_system();
    update profiles set role=v_role where id=v_foreman and is_test is true;
    perform pg_temp.dry_run_act_as(v_foreman);
    v_row := public.set_project_readiness(v_job,'ready');
    perform pg_temp.dry_run_check(v_role||' marks site ready despite unfinished setup',v_row.ready_state='ready' and v_row.updated_by=v_foreman);
    perform pg_temp.dry_run_check(v_role||' preserves materials ETA and arrival',v_row.materials_eta=date '2026-10-08' and v_row.materials_arrived_at=timestamptz '2026-10-08T12:00:00Z');
    v_row := public.set_project_readiness(v_job,'ready');
    perform pg_temp.dry_run_check(v_role||' repeats ready without duplicate',v_row.ready_state='ready');
    v_row := public.set_project_readiness(v_job,'not_ready');
    perform pg_temp.dry_run_check(v_role||' can mark not ready',v_row.ready_state='not_ready');
  end loop;
  perform pg_temp.dry_run_expect_error('unknown readiness remains refused',format('select public.set_project_readiness(%L::uuid,%L)',v_job,'maybe'),'either ready or not ready');
  perform pg_temp.dry_run_expect_error('null readiness remains refused',format('select public.set_project_readiness(%L::uuid,null)',v_job),'either ready or not ready');
  perform pg_temp.dry_run_expect_error('missing job remains refused',format('select public.set_project_readiness(%L::uuid,%L)','00000000-0000-0000-0000-000000000000','ready'),'does not exist');
  perform pg_temp.dry_run_as_system();
  select jsonb_agg(to_jsonb(g) order by item_key) into v_after from public.green_light_items(v_job) g;
  perform pg_temp.dry_run_check('readiness does not complete or erase setup items',v_items=v_after);
  select count(*) into v_count from project_pipeline where project_id=v_job;
  perform pg_temp.dry_run_check('repeated taps retain one pipeline row',v_count=1);
  delete from project_pipeline where project_id=v_job;
  perform pg_temp.dry_run_act_as(v_foreman);
  v_row := public.set_project_readiness(v_job,'ready');
  perform pg_temp.dry_run_check('job with no pipeline row can be marked ready',v_row.project_id=v_job and v_row.ready_state='ready');
  perform pg_temp.dry_run_act_as(v_installer);
  perform pg_temp.dry_run_expect_error('installer cannot change site readiness',format('select public.set_project_readiness(%L::uuid,%L)',v_job,'not_ready'),'Only a foreman');
  perform pg_temp.dry_run_expect_error('direct client pipeline writes stay forbidden',format('update public.project_pipeline set ready_state=%L where project_id=%L::uuid','not_ready',v_job),'permission denied');
  perform pg_temp.dry_run_as_system();
  update profiles set role=v_original_role where id=v_foreman and is_test is true;
  perform pg_temp.dry_run_check('QA role restored',(select role=v_original_role from profiles where id=v_foreman));
  perform pg_temp.dry_run_check('anon has no readiness execute',not has_function_privilege('anon','public.set_project_readiness(uuid,text)','execute'));
  perform pg_temp.dry_run_check('authenticated retains readiness execute',has_function_privilege('authenticated','public.set_project_readiness(uuid,text)','execute'));
  select to_jsonb(n) into v_before from app_release_notes n where id='2026-10-08-site-readiness';
  perform pg_temp.dry_run_check('site readiness note has correct audience and day',v_before->'audience'='[1,2,3]'::jsonb and v_before->>'published_on'='2026-10-08' and v_before->>'kind'='fix' and v_before->>'href'='/projects');
  insert into app_release_notes(id,published_on,audience,kind,title_en,title_es,body_en,body_es)
    values('2026-10-08-site-readiness',date '2026-10-08',array[0],'fix','changed','changed','changed','changed') on conflict(id) do nothing;
  select to_jsonb(n) into v_after from app_release_notes n where id='2026-10-08-site-readiness';
  perform pg_temp.dry_run_check('note rerun preserves original',v_before=v_after);
end $$;
