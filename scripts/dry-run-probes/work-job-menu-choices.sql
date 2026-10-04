-- Private synthetic catalog/grant fixtures, existing QA foreman only.
-- No real employee, operational, profile, payroll or source record writes.
-- The enclosing dry-run transaction forcibly rolls every fixture back.
do $$
declare
  v_qa uuid; v_installer uuid; v_job uuid; v_actor uuid := gen_random_uuid();
  v_menu uuid := gen_random_uuid(); v_now uuid := gen_random_uuid(); v_future uuid := gen_random_uuid();
  v_code text := 'qa_chooser_' || replace(gen_random_uuid()::text,'-','_');
  v_response jsonb;
begin
  perform pg_temp.dry_run_as_system();
  perform pg_temp.dry_run_check('chooser is stable security definer with pinned search path',
    (select provolatile='s' and prosecdef and 'search_path=public, pg_temp'=any(proconfig)
      from pg_proc where oid='public.work_job_menu_choices(uuid)'::regprocedure),'checked');
  perform pg_temp.dry_run_check('chooser executable by authenticated only',
    has_function_privilege('authenticated','public.work_job_menu_choices(uuid)','EXECUTE')
    and not has_function_privilege('anon','public.work_job_menu_choices(uuid)','EXECUTE')
    and not has_function_privilege('public','public.work_job_menu_choices(uuid)','EXECUTE'),'checked');
  perform pg_temp.dry_run_check('configuration UI note is bilingual for foreman and higher',
    (select audience=array[1,2,3] and href='/projects' and length(title_en)>0 and length(title_es)>0
      and length(body_en)>0 and length(body_es)>0 from public.app_release_notes
      where id='2026-10-03-work-configuration-controls'),'checked');
  v_qa := pg_temp.dry_run_pick('foreman');
  v_installer := pg_temp.dry_run_pick('installer');
  select p.id into v_job from public.projects p join public.sandbox_projects s on s.project_id=p.id
    where p.deleted_at is null and public._ai_job_visible(p.id,v_qa) order by p.id limit 1;
  if v_job is null then raise exception 'No live sandbox job for chooser QA'; end if;
  perform pg_temp.dry_run_check('fixture actor is QA foreman',public.is_test_profile(v_qa),'checked');
  perform pg_temp.dry_run_check('fixture installer is QA',public.is_test_profile(v_installer),'checked');
  insert into public.work_capture_menus(id,code,created_by) values(v_menu,v_code,v_actor);
  insert into public.work_capture_menu_versions(id,menu_id,version,label_en,label_es,items,published_by,published_at,effective_from)
    values(v_now,v_menu,1,'Rollback chooser fixture','Prueba temporal','[]',v_actor,clock_timestamp()-interval '1 second',clock_timestamp()-interval '1 second'),
      (v_future,v_menu,2,'Future rollback fixture','Prueba futura','[]',v_actor,clock_timestamp(),clock_timestamp()+interval '1 day');
  insert into public.work_job_management_grants(project_id,profile_id,capability,granted_by)
    select v_job,v_qa,'menu_select',v_actor where not exists (
      select 1 from public.work_job_management_grants where project_id=v_job and profile_id=v_qa
        and capability='menu_select' and revoked_at is null);
  perform pg_temp.dry_run_act_as(v_qa);
  v_response := public.work_job_menu_choices(v_job);
  perform pg_temp.dry_run_check('chooser exact job and protocol binding',
    v_response->>'projectId'=v_job::text and v_response->>'protocolVersion'='1','checked');
  perform pg_temp.dry_run_check('chooser includes current effective fixture',
    exists(select 1 from jsonb_array_elements(v_response->'choices') c where c->>'menuVersionId'=v_now::text),'checked');
  perform pg_temp.dry_run_check('chooser excludes future fixture',
    not exists(select 1 from jsonb_array_elements(v_response->'choices') c where c->>'menuVersionId'=v_future::text),'checked');
  perform pg_temp.dry_run_check('chooser carries only minimal keys',
    v_response - array['protocolVersion','projectId','asOf','currentRevision','currentSelection','choices']='{}'::jsonb
    and not exists(select 1 from jsonb_array_elements(v_response->'choices') c
      where c-array['menuVersionId','version','labelEn','labelEs','publishedAt','effectiveFrom']<>'{}'::jsonb),'checked');
  perform pg_temp.dry_run_expect_error('QA foreman global chooser denied',
    'select public.work_job_menu_choices(null)','Job menu choices are unavailable');
  perform pg_temp.dry_run_expect_error('unknown job and authority share generic refusal',
    format('select public.work_job_menu_choices(%L)',gen_random_uuid()),'Job menu choices are unavailable');
  perform pg_temp.dry_run_expect_error('QA company catalog still denied',
    'select public.work_configuration_snapshot(null)','That job is unavailable');
  perform pg_temp.dry_run_act_as(v_installer);
  perform pg_temp.dry_run_expect_error('QA installer receives no chooser metadata',
    format('select public.work_job_menu_choices(%L)',v_job),'Job menu choices are unavailable');
end;
$$;
