-- Sandbox-only practice run. The harness discards this entire batch, including
-- notice revisions, connected publication/outbox rows and temporary QA roles.
-- No delivery function is invoked and no real crew member is impersonated.
do $$
declare
  v_job uuid;
  v_lead uuid;
  v_installer uuid;
  v_original_role text;
  v_lead_active boolean;
  v_installer_active boolean;
  v_assignment uuid := gen_random_uuid();
  v_connected uuid := gen_random_uuid();
  v_trip uuid := gen_random_uuid();
  v_plan uuid := gen_random_uuid();
  v_request uuid := gen_random_uuid();
  v_revision integer;
  v_plan_revision bigint;
  v_token text;
  v_draft jsonb;
  v_snapshot jsonb;
  v_count integer;
begin
  perform pg_temp.dry_run_as_system();
  v_job := pg_temp.dry_run_sandbox_job();
  v_lead := pg_temp.dry_run_pick('foreman');
  v_installer := pg_temp.dry_run_pick('installer');
  select role,active into v_original_role,v_lead_active from public.profiles where id=v_lead;
  select active into v_installer_active from public.profiles where id=v_installer;
  -- Scheduling writes are supervisor-only. Promote only the QA foreman inside
  -- this discarded transaction; restore it below as an additional safeguard.
  update public.profiles set role='supervisor',active=true where id=v_lead;
  update public.profiles set active=true where id=v_installer;
  perform pg_temp.dry_run_act_as(v_lead);

  insert into public.schedule_assignments(id,project_id,start_date,end_date,start_time,end_time,status,notice_revision,created_by)
  values(v_assignment,v_job,current_date+9,current_date+9,'07:00','12:00','draft',999,v_lead);
  insert into public.schedule_assignment_members(assignment_id,profile_id,role)
  values(v_assignment,v_installer,'installer');
  select notice_revision into v_revision from public.schedule_assignments where id=v_assignment;
  perform pg_temp.dry_run_check('draft insert ignores supplied notice revision',v_revision=0,v_revision::text);
  update public.schedule_assignments set start_time='08:00',notice_revision=123 where id=v_assignment;
  select notice_revision into v_revision from public.schedule_assignments where id=v_assignment;
  perform pg_temp.dry_run_check('draft timing edits stay quiet',v_revision=0,v_revision::text);
  update public.schedule_assignments set status='published',published_at=now() where id=v_assignment;
  select notice_revision into v_revision from public.schedule_assignments where id=v_assignment;
  perform pg_temp.dry_run_check('first publish creates one notice occurrence',v_revision=1,v_revision::text);
  update public.schedule_assignments set color='#abcdef',note='Sandbox cosmetic edit',updated_at=now(),notice_revision=888 where id=v_assignment;
  select notice_revision into v_revision from public.schedule_assignments where id=v_assignment;
  perform pg_temp.dry_run_check('cosmetic edit and forged revision cannot create a notice',v_revision=1,v_revision::text);
  update public.schedule_assignments set start_time='09:00',notice_revision=0 where id=v_assignment;
  select notice_revision into v_revision from public.schedule_assignments where id=v_assignment;
  perform pg_temp.dry_run_check('changed hours create a notice despite forged old revision',v_revision=2,v_revision::text);
  update public.schedule_assignments set start_time='08:00' where id=v_assignment;
  select notice_revision into v_revision from public.schedule_assignments where id=v_assignment;
  perform pg_temp.dry_run_check('changing back creates a distinct new notice',v_revision=3,v_revision::text);
  update public.schedule_assignments set start_time='08:00:00',notice_revision=null where id=v_assignment;
  select notice_revision into v_revision from public.schedule_assignments where id=v_assignment;
  perform pg_temp.dry_run_check('equivalent typed times and supplied null revision stay quiet',v_revision=3,v_revision::text);
  update public.schedule_assignments set end_time=null where id=v_assignment;
  select notice_revision into v_revision from public.schedule_assignments where id=v_assignment;
  perform pg_temp.dry_run_check('clearing an end time creates a notice',v_revision=4,v_revision::text);

  perform pg_temp.dry_run_as_system();
  perform pg_temp.dry_run_act_as(v_installer);
  update public.schedule_assignments set start_time='10:00',notice_revision=111 where id=v_assignment;
  perform pg_temp.dry_run_as_system();
  select notice_revision into v_revision from public.schedule_assignments where id=v_assignment;
  perform pg_temp.dry_run_check('installer cannot change assignment hours or notice identity',
    v_revision=4 and (select start_time='08:00' from public.schedule_assignments where id=v_assignment),v_revision::text);

  perform pg_temp.dry_run_act_as(v_lead);
  insert into public.schedule_assignments(id,project_id,start_date,end_date,start_time,end_time,status,created_by)
  values(v_connected,v_job,current_date+11,current_date+11,'07:00','12:00','draft',v_lead);
  insert into public.schedule_assignment_members(assignment_id,profile_id,role)
  values(v_connected,v_installer,'installer');
  insert into public.trips(id,project_id,name,start_date,end_date,status,created_by)
  values(v_trip,v_job,'Sandbox schedule notice trip',current_date+11,current_date+11,'draft',v_lead);
  insert into public.trip_crew(trip_id,profile_id,role) values(v_trip,v_installer,'crew');
  perform public.workflow_create_plan(v_plan,'Sandbox schedule notice plan',array[v_connected],array[v_trip]);
  -- Snapshot is an internal helper, not an authenticated RPC. Its execution is
  -- also exercised through the actual create/save/publish RPCs below.
  perform pg_temp.dry_run_as_system();
  v_snapshot := public.workflow_snapshot(v_plan);
  perform pg_temp.dry_run_check('connected snapshot omits server-only notice revision',
    not ((v_snapshot->'assignments'->0) ? 'notice_revision'),null);
  perform pg_temp.dry_run_act_as(v_lead);
  select revision into v_plan_revision from public.workflow_plans where id=v_plan;
  v_token := public.workflow_review_plan(v_plan)->>'review_token';
  perform public.workflow_publish_plan(v_plan,v_plan_revision,v_request,v_token,true);
  select notice_revision into v_revision from public.schedule_assignments where id=v_connected;
  perform pg_temp.dry_run_check('connected initial publish creates one occurrence',v_revision=1,v_revision::text);
  perform public.workflow_publish_plan(v_plan,v_plan_revision,v_request,v_token,true);
  select notice_revision into v_revision from public.schedule_assignments where id=v_connected;
  perform pg_temp.dry_run_check('same connected publish request does not duplicate occurrence',v_revision=1,v_revision::text);
  select revision,draft into v_plan_revision,v_draft from public.workflow_plans where id=v_plan;
  v_draft := jsonb_set(v_draft,'{assignments,0,start_time}','"09:00:30"'::jsonb);
  perform public.workflow_save_draft(v_plan,v_plan_revision,v_draft);
  select notice_revision into v_revision from public.schedule_assignments where id=v_connected;
  perform pg_temp.dry_run_check('connected draft timing edit does not announce unpublished hours',v_revision=1,v_revision::text);
  select revision into v_plan_revision from public.workflow_plans where id=v_plan;
  perform public.workflow_publish_plan(v_plan,v_plan_revision,gen_random_uuid(),public.workflow_review_plan(v_plan)->>'review_token',true);
  select notice_revision into v_revision from public.schedule_assignments where id=v_connected;
  perform pg_temp.dry_run_check('connected timing publication creates the next occurrence',v_revision=2,v_revision::text);
  select revision,draft into v_plan_revision,v_draft from public.workflow_plans where id=v_plan;
  v_draft := jsonb_set(v_draft,'{assignments,0,note}','"Sandbox instructions only"'::jsonb);
  perform public.workflow_save_draft(v_plan,v_plan_revision,v_draft);
  select revision into v_plan_revision from public.workflow_plans where id=v_plan;
  perform public.workflow_publish_plan(v_plan,v_plan_revision,gen_random_uuid(),public.workflow_review_plan(v_plan)->>'review_token',true);
  select notice_revision into v_revision from public.schedule_assignments where id=v_connected;
  perform pg_temp.dry_run_check('connected instruction-only publication stays quiet',v_revision=2,v_revision::text);

  perform pg_temp.dry_run_as_system();
  select count(*) into v_count from public.app_release_notes
    where id='2026-09-30-schedule-change-notices' and audience=array[0,1,2,3]
      and href='/notifications' and length(title_en)>0 and length(title_es)>0
      and length(body_en)>0 and length(body_es)>0;
  perform pg_temp.dry_run_check('schedule notice announcement has bilingual copy and all internal audiences',v_count=1,v_count::text);
  update public.profiles set role=v_original_role,active=v_lead_active where id=v_lead;
  update public.profiles set active=v_installer_active where id=v_installer;
end $$;
