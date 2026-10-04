-- Actual-schema configuration catalog and QA read/denial checks.
-- Private synthetic configuration only; no operational, payroll, source or
-- profile writes, no real employee used as a test actor. Forced rollback owns
-- the complete batch, including the candidate migrations and these fixtures.
do $$
declare
  v_table text; v_role text; v_helper record; v_rpc record; v_count bigint;
  v_qa uuid; v_definition uuid := gen_random_uuid(); v_version uuid := gen_random_uuid();
  v_menu uuid := gen_random_uuid(); v_menu_version uuid := gen_random_uuid();
  v_command uuid := gen_random_uuid(); v_actor uuid := gen_random_uuid();
  v_code text := 'qa_cfg_'||replace(gen_random_uuid()::text,'-','_');
  v_result jsonb;
begin
  perform pg_temp.dry_run_as_system();
  foreach v_table in array array['work_configuration_commands','work_configuration_draft_revisions','work_configuration_draft_pointers'] loop
    perform pg_temp.dry_run_check(v_table||' RLS enabled',
      (select relrowsecurity from pg_class where oid=('public.'||v_table)::regclass),'checked');
    execute format('select count(*) from public.%I',v_table) into v_count;
    perform pg_temp.dry_run_check(v_table||' migration seeded no records',v_count=0,'checked');
    foreach v_role in array array['authenticated','anon'] loop
      perform pg_temp.dry_run_check(v_role||' has no raw privileges on '||v_table,
        not has_table_privilege(v_role,'public.'||v_table,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'),'checked');
    end loop;
  end loop;
  for v_helper in select p.oid::regprocedure as signature from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like '\_work\_config\_%' escape '\' loop
    perform pg_temp.dry_run_check(v_helper.signature::text||' is private',
      not has_function_privilege('authenticated',v_helper.signature::text,'EXECUTE')
      and not has_function_privilege('anon',v_helper.signature::text,'EXECUTE'),'checked');
  end loop;
  select count(*) into v_count from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in ('work_propose_activity_draft','work_propose_menu_draft',
      'work_publish_activity_version','work_publish_menu_version','work_retire_activity','work_retire_menu',
      'work_select_job_menu','work_grant_job_capability','work_revoke_job_capability',
      'work_configuration_snapshot','work_job_capability_grants');
  perform pg_temp.dry_run_check('exactly eleven expected public configuration API signatures',v_count=11,'checked');
  for v_rpc in select p.oid::regprocedure as signature,p.prosecdef,p.proconfig from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in (
      'work_propose_activity_draft','work_propose_menu_draft','work_publish_activity_version','work_publish_menu_version',
      'work_retire_activity','work_retire_menu','work_select_job_menu','work_grant_job_capability',
      'work_revoke_job_capability','work_configuration_snapshot','work_job_capability_grants') loop
    perform pg_temp.dry_run_check(v_rpc.signature::text||' authenticated-only execute',
      has_function_privilege('authenticated',v_rpc.signature::text,'EXECUTE')
      and not has_function_privilege('anon',v_rpc.signature::text,'EXECUTE'),'checked');
    perform pg_temp.dry_run_check(v_rpc.signature::text||' pinned definer boundary',
      v_rpc.prosecdef and 'search_path=public, pg_temp'=any(v_rpc.proconfig),'checked');
  end loop;
  perform pg_temp.dry_run_expect_error('SQL NULL typed fields refused',
    'select public._work_config_validate_typed_fields(NULL)','Invalid typed field list');
  perform pg_temp.dry_run_expect_error('unknown typed quantity unit refused',
    $q$select public._work_config_validate_typed_fields('[{"id":"qty","label_en":"Quantity","label_es":"Cantidad","type":"number","required":false,"unit":"unsupported"}]')$q$,
    'Unknown typed field unit');
  perform pg_temp.dry_run_expect_error('numeric bounds on text refused',
    $q$select public._work_config_validate_typed_fields('[{"id":"note","label_en":"Note","label_es":"Nota","type":"text","required":false,"min":0}]')$q$,
    'Only a number field');
  perform pg_temp.dry_run_expect_error('overflowing positive numeric bound refused',
    $q$select public._work_config_validate_typed_fields('[{"id":"qty","label_en":"Quantity","label_es":"Cantidad","type":"number","required":false,"max":1e309}]')$q$,
    'supported number range');
  perform pg_temp.dry_run_expect_error('overflowing negative numeric bound refused',
    $q$select public._work_config_validate_typed_fields('[{"id":"qty","label_en":"Quantity","label_es":"Cantidad","type":"number","required":false,"min":-1e309}]')$q$,
    'supported number range');
  perform pg_temp.dry_run_expect_error('negative count bound refused',
    $q$select public._work_config_validate_typed_fields('[{"id":"qty","label_en":"Quantity","label_es":"Cantidad","type":"number","required":false,"unit":"count","min":-1}]')$q$,
    'nonnegative safe integer');
  perform pg_temp.dry_run_expect_error('unsafe count bound refused',
    $q$select public._work_config_validate_typed_fields('[{"id":"qty","label_en":"Quantity","label_es":"Cantidad","type":"number","required":false,"unit":"count","max":9007199254740992}]')$q$,
    'nonnegative safe integer');
  insert into public.work_activity_definitions(id,code,created_by) values(v_definition,v_code,v_actor);
  insert into public.work_activity_definition_versions(id,definition_id,version,scope,label_en,label_es,published_by,published_at,effective_from)
    values(v_version,v_definition,1,'general','Rollback fixture','Prueba temporal',v_actor,clock_timestamp(),clock_timestamp()+interval '1 day');
  insert into public.work_capture_menus(id,code,created_by) values(v_menu,v_code,v_actor);
  insert into public.work_capture_menu_versions(id,menu_id,version,label_en,label_es,items,published_by)
    values(v_menu_version,v_menu,1,'Rollback fixture','Prueba temporal',
      jsonb_build_array(jsonb_build_object('definitionId',v_definition,'versionId',v_version,'position',0,'enabled',true)),v_actor);
  perform pg_temp.dry_run_check('separate finite future effective time retained',
    (select effective_from>published_at and isfinite(effective_from) from public.work_activity_definition_versions where id=v_version),'checked');
  perform pg_temp.dry_run_expect_error('effective time on published version cannot be rewritten',
    format('update public.work_activity_definition_versions set effective_from=published_at where id=%L',v_version),'immutable');
  insert into public.work_configuration_commands(command_id,actor_id,action,normalized_payload,payload_hash,status,result)
    values(v_command,v_actor,'publish_activity_version','{}',repeat('0',64),'applied','{}');
  perform pg_temp.dry_run_expect_error('configuration receipt cannot be removed',
    format('delete from public.work_configuration_commands where command_id=%L',v_command),'immutable');
  v_result := public._work_config_replay(v_command,v_actor,'publish_activity_version',repeat('0',64),'{}');
  perform pg_temp.dry_run_check('exact payload receipt replay remains identical',v_result='{}'::jsonb,'checked');
  perform pg_temp.dry_run_expect_error('normalized payload mismatch refused even with same supplied hash',
    format('select public._work_config_replay(%L,%L,''publish_activity_version'',%L,''{"different":true}'')',v_command,v_actor,repeat('0',64)),
    'different request');
  v_qa := pg_temp.dry_run_pick('installer');
  perform pg_temp.dry_run_act_as(v_qa);
  perform pg_temp.dry_run_check('actual caller is the QA authenticated profile',
    current_user='authenticated' and auth.uid()=v_qa and public.is_test_profile(v_qa),'checked');
  foreach v_table in array array['work_configuration_commands','work_configuration_draft_revisions','work_configuration_draft_pointers'] loop
    perform pg_temp.dry_run_expect_error('QA cannot directly read '||v_table,
      format('select * from public.%I',v_table),'permission denied');
  end loop;
  perform pg_temp.dry_run_expect_error('QA cannot publish company activity',
    format('select public.work_publish_activity_version(%L,%L,0,''general'',''QA'',''QA'',false,''[]'')',gen_random_uuid(),v_code),'Only an owner');
  perform pg_temp.dry_run_expect_error('QA cannot propose company draft',
    format('select public.work_propose_activity_draft(%L,%L,0,''general'',''QA'',''QA'',false,''[]'')',gen_random_uuid(),v_code),'Only an owner or supervisor');
  perform pg_temp.dry_run_expect_error('QA cannot read company catalog without visible sandbox job',
    'select public.work_configuration_snapshot(NULL)','unavailable');
  perform pg_temp.dry_run_as_system();
  perform pg_temp.dry_run_check('configuration probe never created personal timing state',
    not exists(select 1 from public.personal_activity_state),'checked');
end;
$$;
