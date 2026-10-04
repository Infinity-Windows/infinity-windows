-- Actual canonical unit + nested crew calls, synthetic sandbox units only.
-- Actors are existing QA logins. The harness forcibly rolls every source,
-- history, receipt and private fact fixture back. No real employee write.
do $$
declare
  v_foreman uuid; v_installer uuid; v_job uuid;
  v_unit uuid:=gen_random_uuid(); v_req uuid:=gen_random_uuid(); v_req2 uuid:=gen_random_uuid();
  v_failed_unit uuid:=gen_random_uuid(); v_failed_req uuid:=gen_random_uuid();
  v_legacy uuid:=gen_random_uuid(); v_legacy_req uuid:=gen_random_uuid();
  v_payload jsonb; v_data jsonb; v_read jsonb; v_count int; v_refused boolean:=false;
  v_shifts jsonb; v_custom_sessions jsonb; v_mapped_sessions jsonb; v_task_sessions jsonb;
  v_after jsonb; v_whole jsonb;
begin
  perform pg_temp.dry_run_as_system();
  perform pg_temp.dry_run_check('unit size history note bilingual for all internal roles',
    (select audience=array[0,1,2,3] and href='/work' and length(title_en)>0 and length(title_es)>0
      and length(body_en)>0 and length(body_es)>0 from public.app_release_notes where id='2026-10-03-unit-size-history'),'checked');
  v_foreman:=pg_temp.dry_run_pick('foreman');
  v_installer:=pg_temp.dry_run_pick('installer');
  v_job:=pg_temp.dry_run_sandbox_job();
  perform pg_temp.dry_run_check('unit probe actors are QA only',
    public.is_test_profile(v_foreman) and public.is_test_profile(v_installer),'checked');
  perform pg_temp.dry_run_check('private unit tables retain evidence with revoked client grants',
    (select bool_and(relrowsecurity) from pg_class where oid in
      ('public.work_unit_fact_revisions'::regclass,'public.work_unit_fact_current'::regclass,'public.work_unit_fact_context_epochs'::regclass))
    and not has_table_privilege('authenticated','public.work_unit_fact_revisions','SELECT')
    and not has_table_privilege('authenticated','public.work_unit_fact_current','UPDATE'),'checked');
  perform pg_temp.dry_run_check('fact history has no operational unit or command foreign key',
    not exists(select 1 from pg_constraint where conrelid='public.work_unit_fact_revisions'::regclass and contype='f'
      and confrelid in ('public.custom_work_units'::regclass,'public.custom_work_commands'::regclass)),'checked');
  select coalesce(jsonb_agg(to_jsonb(t) order by t.id),'[]') into v_shifts from public.time_shifts t where profile_id in(v_foreman,v_installer);
  select coalesce(jsonb_agg(to_jsonb(t) order by t.id),'[]') into v_custom_sessions from public.custom_work_sessions t where profile_id in(v_foreman,v_installer);
  select coalesce(jsonb_agg(to_jsonb(t) order by t.id),'[]') into v_mapped_sessions from public.unit_sessions t where profile_id in(v_foreman,v_installer);
  select coalesce(jsonb_agg(to_jsonb(t) order by t.id),'[]') into v_task_sessions from public.task_sessions t where profile_id in(v_foreman,v_installer);
  perform pg_temp.dry_run_act_as(v_foreman);
  v_data:=jsonb_build_object('id',v_unit,'revision',0,'project_id',v_job,'opening_id',null,
    'label','DRY-FACT-'||left(v_unit::text,8),'type_label','Rollback fixture','facts',jsonb_build_object('note','Unrelated original detail'),
    'dimension_observation',jsonb_build_object('width',1,'height',2,'unit','ft','source','measured','sourceReference','Synthetic rollback observation'),
    'expected_fact_revision',0);
  v_payload:=jsonb_build_object('unit',v_data,'people',jsonb_build_array(v_foreman,v_installer),
    'work_date',(now() at time zone 'America/Denver')::date::text,'stage','Installing','outcome','assigned','whole_complete',false,'description','Rollback-only fixture');
  perform public.record_crew_work(v_req,v_payload);
  v_read:=public.work_unit_fact_current_read(v_unit);
  perform pg_temp.dry_run_check('nested crew unit records original feet and normalized inches',
    v_read->>'revision'='1' and v_read->>'widthIn'='12' and v_read->>'heightIn'='24'
    and v_read->'observation'->>'unit'='ft' and v_read->'observation'->>'width'='1'
    and v_read->'observation'->>'estimated'='false','checked');
  perform public.record_crew_work(v_req,v_payload);
  perform pg_temp.dry_run_as_system();
  perform pg_temp.dry_run_check('crew root receipt and fact command share original UUID',
    (select payload->>'action'='crew_record' and result_id=v_unit from public.custom_work_commands where id=v_req)
    and (select count(*)=1 from public.work_unit_fact_revisions where unit_id=v_unit and command_id=v_req)
    and (select count(*)=1 from public.crew_work_records where id=v_req),'checked');
  select facts into v_whole from public.custom_work_units where id=v_unit;
  v_data:=v_data||jsonb_build_object('revision',1,'facts',v_whole,'expected_fact_revision',1);
  v_payload:=v_payload||jsonb_build_object('unit',v_data,'outcome','finished','whole_complete',true);
  perform pg_temp.dry_run_act_as(v_foreman);
  perform public.record_crew_work(v_req2,v_payload);
  perform pg_temp.dry_run_as_system();
  perform pg_temp.dry_run_check('whole-complete nested applied facts retain original detail',
    (select facts->>'installation_complete'='Yes' and facts->>'note'='Unrelated original detail' from public.custom_work_units where id=v_unit)
    and (select after_value->'facts'->>'installation_complete'='Yes' from public.custom_work_history where entity_id=v_unit and action='unit' order by id desc limit 1)
    and (select payload->>'action'='crew_record' from public.custom_work_commands where id=v_req2),'checked');

  -- Seed only a disposable crew ledger PK collision. The nested unit/fact
  -- write executes first; the later crew INSERT must abort that whole call.
  insert into public.crew_work_records(id,project_id,unit_id,filed_by,work_date,stage,outcome,whole_complete,description)
    values(v_failed_req,v_job,v_unit,v_foreman,(now() at time zone 'America/Denver')::date,'Installing','assigned',false,'Intentional rollback collision');
  v_data:=jsonb_build_object('id',v_failed_unit,'revision',0,'project_id',v_job,'opening_id',null,
    'label','DRY-FACT-FAIL-'||left(v_failed_unit::text,8),'facts','{}'::jsonb,
    'dimension_observation',jsonb_build_object('width',12,'height',24,'unit','in','source','plans'),'expected_fact_revision',0);
  v_payload:=v_payload||jsonb_build_object('unit',v_data,'outcome','assigned','whole_complete',false);
  perform pg_temp.dry_run_act_as(v_foreman);
  begin
    perform public.record_crew_work(v_failed_req,v_payload);
  exception when unique_violation then v_refused:=true;
  end;
  perform pg_temp.dry_run_check('late crew insert collision really refused',v_refused,'checked');
  perform pg_temp.dry_run_as_system();
  perform pg_temp.dry_run_check('late crew refusal rolls back canonical unit history receipt and facts',
    not exists(select 1 from public.custom_work_units where id=v_failed_unit)
    and not exists(select 1 from public.custom_work_commands where id=v_failed_req)
    and not exists(select 1 from public.custom_work_history where entity_id=v_failed_unit)
    and not exists(select 1 from public.work_unit_fact_revisions where unit_id=v_failed_unit)
    and not exists(select 1 from public.work_unit_fact_current where unit_id=v_failed_unit),'checked');

  perform pg_temp.dry_run_act_as(v_installer);
  perform public.custom_work_command(v_legacy_req,'unit',jsonb_build_object('id',v_legacy,'revision',0,'project_id',v_job,
    'label','DRY-LEGACY-'||left(v_legacy::text,8),'facts',jsonb_build_object('width_in',30,'height_in',40,
      'measurement_source',repeat('x',4000),'area_source','Measured on site - old client','note','Legacy detail retained')));
  v_read:=public.work_unit_fact_current_read(v_legacy);
  perform pg_temp.dry_run_check('legal legacy free-text dimension sources remain accepted',
    v_read->>'revision'='1' and v_read->>'widthIn'='30' and v_read->'observation'='null'::jsonb,'checked');
  perform pg_temp.dry_run_expect_error('anonymous caller receives no unit fact projection',
    format('set local role anon; select public.work_unit_fact_current_read(%L)',v_unit),'permission denied');
  perform pg_temp.dry_run_as_system();
  select coalesce(jsonb_agg(to_jsonb(t) order by t.id),'[]') into v_after from public.time_shifts t where profile_id in(v_foreman,v_installer);
  perform pg_temp.dry_run_check('unit and crew observation saves preserve payroll shift rows',v_after=v_shifts,'checked');
  select coalesce(jsonb_agg(to_jsonb(t) order by t.id),'[]') into v_after from public.custom_work_sessions t where profile_id in(v_foreman,v_installer);
  perform pg_temp.dry_run_check('unrelated existing custom sessions unchanged',v_after=v_custom_sessions,'checked');
  select coalesce(jsonb_agg(to_jsonb(t) order by t.id),'[]') into v_after from public.unit_sessions t where profile_id in(v_foreman,v_installer);
  perform pg_temp.dry_run_check('mapped sessions unchanged',v_after=v_mapped_sessions,'checked');
  select coalesce(jsonb_agg(to_jsonb(t) order by t.id),'[]') into v_after from public.task_sessions t where profile_id in(v_foreman,v_installer);
  perform pg_temp.dry_run_check('task sessions unchanged',v_after=v_task_sessions,'checked');
end;
$$;
