-- Candidate-bound real-schema/RPC practice run, always forced rollback by
-- db-dry-run.yml. Only asserted QA profiles and sandbox source fixtures are
-- temporarily changed. No real employee payroll or access is altered.
do $$
declare
  v_job uuid; v_qa uuid; v_foreman uuid; v_owner uuid;
  v_shift uuid := gen_random_uuid(); v_unit uuid := gen_random_uuid();
  v_detached uuid := gen_random_uuid(); v_visible_claim uuid := gen_random_uuid();
  v_hidden_claim uuid := gen_random_uuid(); v_assigned uuid := gen_random_uuid();
  v_role text; v_original_role text; v_partner boolean; v_snap jsonb;
  v_before bigint; v_after bigint; v_ids text[];
  v_from timestamptz := '2001-01-02 00:00:00 America/Denver';
  v_until timestamptz := '2001-01-03 00:00:00 America/Denver';
begin
  perform pg_temp.dry_run_as_system();
  v_job := pg_temp.dry_run_sandbox_job();
  v_qa := pg_temp.dry_run_pick('installer');
  v_foreman := pg_temp.dry_run_pick('foreman');
  v_owner := pg_temp.dry_run_pick_real('owner');
  if not public.is_test_profile(v_qa) or not public.is_test_profile(v_foreman) then
    raise exception 'dry run: dedicated QA installer and foreman required';
  end if;
  select role, is_partner into v_original_role,v_partner from public.profiles where id=v_qa;

  perform pg_temp.dry_run_act_as(v_qa);
  perform pg_temp.dry_run_expect_error('QA installer denied',
    format('select work_data_snapshot(%L,%L,%L)',v_job,v_from,v_until),'supervisor or owner');
  perform pg_temp.dry_run_act_as(v_foreman);
  perform pg_temp.dry_run_expect_error('QA foreman denied',
    format('select work_data_snapshot(%L,%L,%L)',v_job,v_from,v_until),'supervisor or owner');
  perform pg_temp.dry_run_as_system();

  -- Populated fixtures belong only to the dedicated QA worker/sandbox. They
  -- exist within this rollback batch; never an operational clock punch.
  insert into public.time_shifts(id,profile_id,project_id,clock_in_at,clock_out_at,status,break_seconds)
  values(v_shift,v_qa,v_job,v_from+interval '8 hours',v_from+interval '9 hours','submitted',0);
  insert into public.custom_work_units(id,project_id,created_by,label,facts)
  values(v_unit,v_job,v_qa,'Dry-run visible unit','{}'),
    (v_detached,v_job,v_qa,'Dry-run moved unit','{}');
  insert into public.custom_work_sessions(id,profile_id,shift_id,project_id,unit_id,kind,stage,started_at,ended_at)
  values(v_visible_claim,v_qa,v_shift,v_job,v_unit,'unit','Frame',v_from+interval '8 hours',v_from+interval '8 hours 30 minutes'),
    (v_hidden_claim,v_qa,v_shift,v_job,v_detached,'unit','Moved source',v_from+interval '8 hours 30 minutes',v_from+interval '9 hours');
  -- A source unit detached after the original activity no longer establishes
  -- an authorized current source project. Its identity must not be emitted.
  update public.custom_work_units set project_id=null where id=v_detached;
  insert into public.crew_work_records(id,project_id,unit_id,filed_by,work_date,stage,outcome)
  values(v_assigned,v_job,v_unit,v_qa,(v_from at time zone 'America/Denver')::date,'Frame','assigned');
  insert into public.crew_work_record_people(record_id,profile_id) values(v_assigned,v_qa);

  -- Supervisor/partner variants alter only this asserted QA account.
  update public.profiles set role='supervisor',is_partner=true where id=v_qa;
  perform pg_temp.dry_run_act_as(v_qa);
  perform pg_temp.dry_run_expect_error('QA supervisor flagged partner denied',
    format('select work_data_snapshot(%L,%L,%L)',v_job,v_from,v_until),'supervisor or owner');
  perform pg_temp.dry_run_as_system();
  update public.profiles set is_partner=false where id=v_qa;
  select count(*) into v_before from public.time_shifts where project_id=v_job;
  v_role := pg_temp.dry_run_act_as(v_qa);
  perform pg_temp.dry_run_check('QA supervisor fixture uses authenticated identity',
    v_role='supervisor' and current_user='authenticated' and auth.uid()=v_qa,current_user::text);
  v_snap := public.work_data_snapshot(v_job,v_from,v_until);
  perform pg_temp.dry_run_check('snapshot has exact requested project and version',
    v_snap->'project'->>'id'=v_job::text and v_snap->>'schemaVersion'='1','checked');
  perform pg_temp.dry_run_check('populated source is included',
    exists(select 1 from jsonb_array_elements(v_snap->'claims') x where x->>'sourceId'='custom_work_sessions:'||v_visible_claim::text),'checked');
  perform pg_temp.dry_run_check('hidden moved source and unit absent from entire payload',
    position(v_hidden_claim::text in v_snap::text)=0 and position(v_detached::text in v_snap::text)=0,'checked');
  perform pg_temp.dry_run_check('assignment is not performed work evidence',
    position(v_assigned::text in (v_snap->'untimed')::text)=0,'checked');
  perform pg_temp.dry_run_check('normal unfinished unit emits a strict false boolean',
    exists(select 1 from jsonb_array_elements(v_snap->'units') x where x->>'id'='custom:'||v_unit::text and x->'complete'='false'::jsonb),'checked');
  perform pg_temp.dry_run_check('null outcome becomes false rework',
    exists(select 1 from jsonb_array_elements(v_snap->'claims') x where x->>'sourceId'='custom_work_sessions:'||v_visible_claim::text and x->'rework'='false'::jsonb),'checked');
  select array_agg(x->>'sourceId') into v_ids from jsonb_array_elements(v_snap->'claims') x;
  perform pg_temp.dry_run_check('claim provenance is unique',
    coalesce(cardinality(v_ids),0)=coalesce(cardinality(array(select distinct unnest(v_ids))),0),'checked');
  perform pg_temp.dry_run_expect_error('reversed window refused',
    format('select work_data_snapshot(%L,%L,%L)',v_job,v_until,v_from),'window');
  perform pg_temp.dry_run_expect_error('over 93 days refused',
    format('select work_data_snapshot(%L,%L,%L)',v_job,v_from,v_until+interval '120 days'),'window');
  perform pg_temp.dry_run_expect_error('unknown job refused',
    format('select work_data_snapshot(%L,%L,%L)',gen_random_uuid(),v_from,v_until),'unavailable');
  perform pg_temp.dry_run_as_system();
  select count(*) into v_after from public.time_shifts where project_id=v_job;
  perform pg_temp.dry_run_check('snapshot leaves payroll row count unchanged',v_before=v_after,'before/after checked');
  update public.profiles set role=v_original_role,is_partner=v_partner where id=v_qa;
  perform pg_temp.dry_run_act_as(v_owner);
  v_snap := public.work_data_snapshot(v_job,v_from,v_until);
  perform pg_temp.dry_run_check('real owner reads the populated sandbox projection',v_snap is not null,'checked');
  perform pg_temp.dry_run_as_system();
end $$;
