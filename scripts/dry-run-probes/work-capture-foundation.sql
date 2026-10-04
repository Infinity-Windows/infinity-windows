-- Exact candidate private-foundation catalog/practice checks. The caller
-- workflow always forces rollback. No payroll/source/profile rows are changed.
do $$
declare
  v_table text; v_role text; v_qa uuid;
  v_definition uuid := gen_random_uuid(); v_version uuid := gen_random_uuid();
  v_menu uuid := gen_random_uuid(); v_menu_version uuid := gen_random_uuid();
  v_command uuid := gen_random_uuid(); v_device uuid := gen_random_uuid();
  v_generation uuid := gen_random_uuid(); v_fake_subject uuid := gen_random_uuid();
  v_rls boolean; v_allowed boolean; v_count bigint;
  v_code text := 'qa_'||replace(gen_random_uuid()::text,'-','_');
begin
  perform pg_temp.dry_run_as_system();
  foreach v_table in array array[
    'work_activity_definitions','work_activity_definition_versions','work_capture_menus',
    'work_capture_menu_versions','work_job_menu_selections','work_job_management_grants',
    'personal_activity_state','personal_activity_commands','personal_activity_transitions',
    'work_session_capture_metadata'
  ] loop
    select relrowsecurity into v_rls from pg_class where oid=('public.'||v_table)::regclass;
    perform pg_temp.dry_run_check(v_table||' actual RLS is enabled',v_rls,'checked');
    execute format('select count(*) from public.%I',v_table) into v_count;
    perform pg_temp.dry_run_check(v_table||' foundation did not seed records',v_count=0,'checked');
    foreach v_role in array array['authenticated','anon'] loop
      v_allowed := has_table_privilege(v_role,'public.'||v_table,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER');
      perform pg_temp.dry_run_check(v_role||' has no raw privileges on '||v_table,not v_allowed,'checked');
    end loop;
  end loop;
  foreach v_table in array array['work_job_menu_selections','work_job_management_grants','work_session_capture_metadata'] loop
    perform pg_temp.dry_run_check(v_table||' actual sandbox fence is armed',
      exists(select 1 from pg_trigger where tgrelid=('public.'||v_table)::regclass
        and tgname='guard_test_account_sandbox_only' and tgtype=31 and tgenabled in ('O','A')
        and tgfoid='public.guard_test_account_sandbox_only()'::regprocedure),'checked');
    perform pg_temp.dry_run_check(v_table||' original job evidence has no operational cascade',
      not exists(select 1 from pg_constraint where conrelid=('public.'||v_table)::regclass
        and confrelid='public.projects'::regclass),'checked');
  end loop;
  foreach v_role in array array['authenticated','anon'] loop
    perform pg_temp.dry_run_check(v_role||' cannot call immutable helper',
      not has_function_privilege(v_role,'public.work_capture_immutable_record()','EXECUTE'),'checked');
    perform pg_temp.dry_run_check(v_role||' cannot call menu validator',
      not has_function_privilege(v_role,'public.work_capture_validate_menu()','EXECUTE'),'checked');
  end loop;
  perform pg_temp.dry_run_check('no new personal capture mutation RPC exists',
    to_regprocedure('public.personal_activity_command(uuid,integer,jsonb)') is null,'checked');
  perform pg_temp.dry_run_check('no capture observer on existing timing sources',
    not exists(select 1 from pg_trigger t join pg_proc p on p.oid=t.tgfoid
      where not t.tgisinternal and p.proname like 'work_capture_%'
        and t.tgrelid in ('public.time_shifts'::regclass,'public.task_sessions'::regclass,
          'public.unit_sessions'::regclass,'public.custom_work_sessions'::regclass,
          'public.service_time_sessions'::regclass,'public.opening_phases'::regclass)),'checked');

  -- These private-only synthetic rows are never active work/payroll records.
  -- Original UUID evidence has no operational FK, and all disappears in rollback.
  insert into public.work_activity_definitions(id,code,created_by)
    values(v_definition,v_code,v_fake_subject);
  insert into public.work_activity_definition_versions(id,definition_id,version,scope,label_en,label_es,published_by)
    values(v_version,v_definition,1,'general','Rollback fixture','Prueba temporal',v_fake_subject);
  insert into public.work_capture_menus(id,code,created_by) values(v_menu,v_code,v_fake_subject);
  insert into public.work_capture_menu_versions(id,menu_id,version,label_en,label_es,items,published_by)
    values(v_menu_version,v_menu,1,'Rollback menu','Menu temporal',
      jsonb_build_array(jsonb_build_object('definitionId',v_definition,'versionId',v_version,'position',0,'enabled',true)),v_fake_subject);
  perform pg_temp.dry_run_check('real menu membership accepted once',
    (select jsonb_array_length(items)=1 from public.work_capture_menu_versions where id=v_menu_version),'checked');
  perform pg_temp.dry_run_expect_error('published whole menu cannot be rewritten',
    format('update public.work_capture_menu_versions set items=''[]'' where id=%L',v_menu_version),'immutable');
  insert into public.personal_activity_commands(command_id,actor_id,subject_profile_id,protocol_version,normalized_payload,payload_hash,device_id,client_generation,client_sequence,expected_revision,status,before_revision,after_revision,result)
    values(v_command,v_fake_subject,v_fake_subject,1,'{}',repeat('0',64),v_device,v_generation,0,0,'noop',0,0,'{}');
  perform pg_temp.dry_run_check('first client sequence0 accepted on real schema',
    (select client_sequence=0 from public.personal_activity_commands where command_id=v_command),'checked');
  perform pg_temp.dry_run_expect_error('committed receipt cannot be removed',
    format('delete from public.personal_activity_commands where command_id=%L',v_command),'immutable');
  v_qa := pg_temp.dry_run_pick('installer');
  perform pg_temp.dry_run_act_as(v_qa);
  perform pg_temp.dry_run_check('raw attempt uses actual authenticated role',current_user='authenticated' and auth.uid()=v_qa,'checked');
  perform pg_temp.dry_run_expect_error('real authenticated caller cannot read private receipts',
    'select * from public.personal_activity_commands','permission denied');
  perform pg_temp.dry_run_expect_error('real authenticated caller cannot write coordinator state',
    format('insert into public.personal_activity_state(profile_id) values(%L)',v_qa),'permission denied');
  perform pg_temp.dry_run_as_system();
end;
$$;
