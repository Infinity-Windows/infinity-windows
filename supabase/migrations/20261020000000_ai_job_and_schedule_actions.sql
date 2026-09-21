-- Access is independent of the on-site availability flag.
create function public.ai_require_actor(p_rank integer) returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin
 perform 1 from profiles where id=auth.uid() for share;
 if auth.uid() is null or public.is_partner_user() or coalesce(public.my_role_rank(),-1)<p_rank or not exists(select 1 from profiles where id=auth.uid() and retired_at is null and access_revoked_at is null) then
  raise exception 'This action requires a permitted internal crew login.' using errcode='42501';
 end if;
end $$;
revoke all on function public.ai_require_actor(integer) from public,anon,authenticated;

-- Durable action receipts prevent duplicate writes after a lost response.
create table public.ai_action_receipts (
 id uuid primary key,
 profile_id uuid not null references public.profiles(id) on delete cascade,
 kind text not null check(kind in ('create_job','draft_schedule')),
 fingerprint text not null,
 result jsonb not null,
 created_at timestamptz not null default now()
);
alter table public.ai_action_receipts enable row level security;
revoke all on public.ai_action_receipts from public,anon,authenticated;
grant select on public.ai_action_receipts to authenticated;
create policy ai_receipts_read on public.ai_action_receipts for select to authenticated
using(not public.is_partner_user() and exists(select 1 from profiles where id=auth.uid() and retired_at is null and access_revoked_at is null) and profile_id=auth.uid());

create function public.ai_create_job(p_request uuid,p_details jsonb) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare prior ai_action_receipts; code text; title text; job uuid; result jsonb; k text; n numeric;
begin
 perform public.ai_require_actor(1);
 if public.is_test_profile(auth.uid()) then raise exception 'Automation accounts cannot create operational jobs.' using errcode='42501'; end if;
 if p_request is null or jsonb_typeof(p_details) is distinct from 'object' or pg_column_size(p_details)>16000 then raise exception 'Provide valid job details.'; end if;
 perform pg_advisory_xact_lock(639025,1);
 select * into prior from ai_action_receipts where id=p_request;
 if found then
  if prior.profile_id<>auth.uid() or prior.kind<>'create_job' or prior.fingerprint<>md5(p_details::text) then raise exception 'This request belongs to another action.'; end if;
  return prior.result;
 end if;
 if p_details-array['name','jobCode','address','customerName','contactPhone','contactEmail','notes','startDate','endDate','projectedHours','goalHours','squareFeet']<>'{}'::jsonb then raise exception 'Unsupported job fields.'; end if;
 if jsonb_typeof(p_details->'name') is distinct from 'string' or jsonb_typeof(p_details->'jobCode') is distinct from 'string' then raise exception 'Job name and code must be text.'; end if;
 title:=btrim(p_details->>'name'); code:=upper(btrim(p_details->>'jobCode'));
 if title is null or length(title) not between 1 and 200 or code is null or length(code) not between 1 and 60 or code!~'^[A-Z0-9-]+$' or code!~'[A-Z0-9]' then raise exception 'Job name and code are required.'; end if;
 if exists(select 1 from projects where upper(job_code)=code or (deleted_at is null and lower(btrim(name))=lower(title))) then raise exception 'A job with this name or code already exists. Open it instead.'; end if;
 foreach k in array array['address','customerName','contactPhone','contactEmail','notes','startDate','endDate'] loop
  if p_details->k<>'null'::jsonb and jsonb_typeof(p_details->k)<>'string' then raise exception 'Text fields must contain text.'; end if;
  if length(p_details->>k)>(case when k='notes' then 5000 when k='address' then 500 else 254 end) then raise exception 'A job detail is too long.'; end if;
 end loop;
 if p_details->>'startDate' is not null and (p_details->>'startDate')::date::text<>p_details->>'startDate' or p_details->>'endDate' is not null and (p_details->>'endDate')::date::text<>p_details->>'endDate' then raise exception 'Use YYYY-MM-DD dates.'; end if;
 if (p_details->>'startDate')::date>(p_details->>'endDate')::date then raise exception 'End date must follow start date.'; end if;
 foreach k in array array['projectedHours','goalHours','squareFeet'] loop
  if p_details->>k is not null then
   if public.my_role_rank()<2 then raise exception 'Labor targets require a supervisor or owner.' using errcode='42501'; end if;
   if jsonb_typeof(p_details->k)<>'number' then raise exception 'Labor targets must be numbers.'; end if;
   n:=(p_details->>k)::numeric; if n<0 or n>100000000 then raise exception 'Check the labor target.'; end if;
  end if;
 end loop;
 -- The normal projects INSERT trigger creates both warehouse staging bays.
 insert into projects(job_code,name,address,customer_name,contact_phone,contact_email,notes,start_date,end_date,ready_state)
 values(code,title,p_details->>'address',p_details->>'customerName',p_details->>'contactPhone',p_details->>'contactEmail',p_details->>'notes',(p_details->>'startDate')::date,(p_details->>'endDate')::date,'not_ready') returning id into job;
 if coalesce(p_details->>'projectedHours',p_details->>'goalHours',p_details->>'squareFeet') is not null then
  perform public.set_project_labor_targets(job,(p_details->>'projectedHours')::numeric,(p_details->>'goalHours')::numeric,(p_details->>'squareFeet')::numeric,0,'Created from reviewed AI job details');
 end if;
 result:=jsonb_build_object('projectId',job,'name',title,'jobCode',code,'readyState','not_ready');
 insert into ai_action_receipts values(p_request,auth.uid(),'create_job',md5(p_details::text),result,now());
 return result;
end $$;
revoke all on function public.ai_create_job(uuid,jsonb) from public,anon;
grant execute on function public.ai_create_job(uuid,jsonb) to authenticated;

-- Share the native schedule write lock with absence changes. Publication then
-- sees either the old or new approved absence, never an interleaved half-write.
create trigger ai_time_off_schedule_lock before insert or update or delete on public.time_off_requests
for each statement execute function public.workflow_lock_writes();

create function public.ai_draft_schedule(p_request uuid,p_entries jsonb) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare prior ai_action_receipts; e record; a uuid; ids uuid[]:='{}'; result jsonb;
begin
 perform public.workflow_require_manager();
 perform public.ai_require_actor(2);
 if p_request is null or jsonb_typeof(p_entries) is distinct from 'array' or jsonb_array_length(p_entries) not between 1 and 200 then raise exception 'Choose 1 to 200 person-days.'; end if;
 perform pg_advisory_xact_lock(639024,1);
 select * into prior from ai_action_receipts where id=p_request;
 if found then
  if prior.profile_id<>auth.uid() or prior.kind<>'draft_schedule' or prior.fingerprint<>md5(p_entries::text) then raise exception 'This request belongs to another action.'; end if;
  return prior.result;
 end if;
 if exists(select 1 from jsonb_to_recordset(p_entries) as x(project_id uuid,profile_id uuid,date date) where project_id is null or profile_id is null or date is null) then raise exception 'Each assignment needs a person, job and date.'; end if;
 if (select count(*) from (select distinct x.project_id,x.profile_id,x.date from jsonb_to_recordset(p_entries) as x(project_id uuid,profile_id uuid,date date)) s)<>jsonb_array_length(p_entries) then raise exception 'A person-day appears twice.'; end if;
 for e in select * from jsonb_to_recordset(p_entries) as x(project_id uuid,profile_id uuid,date date) loop
  if not exists(select 1 from projects where id=e.project_id and deleted_at is null and status='active') then raise exception 'Choose an active job.'; end if;
  if not exists(select 1 from profiles where id=e.profile_id and not is_partner and retired_at is null and access_revoked_at is null) then raise exception 'A selected crew member is unavailable.'; end if;
  if exists(select 1 from time_off_requests where profile_id=e.profile_id and status='approved' and start_date<=e.date and end_date>=e.date) then raise exception 'A selected person has approved time off.'; end if;
  if exists(select 1 from schedule_assignments s join schedule_assignment_members m on m.assignment_id=s.id where m.profile_id=e.profile_id and s.status<>'canceled' and s.start_date<=e.date and s.end_date>=e.date) then raise exception 'A selected person is already scheduled. Review their existing assignment.'; end if;
  if exists(select 1 from jsonb_to_recordset(p_entries) as x(project_id uuid,profile_id uuid,date date) where x.profile_id=e.profile_id and x.date=e.date and x.project_id<>e.project_id) then raise exception 'A person cannot be assigned to two jobs on the same day.'; end if;
 end loop;
 for e in select x.project_id,x.date from jsonb_to_recordset(p_entries) as x(project_id uuid,profile_id uuid,date date) group by x.project_id,x.date loop
  insert into schedule_assignments(project_id,start_date,end_date,status,created_by,created_via) values(e.project_id,e.date,e.date,'draft',auth.uid(),'ai') returning id into a;
  insert into schedule_assignment_members(assignment_id,profile_id,role)
  select a,p.id,case when p.role in ('foreman','lead','supervisor','owner','admin','big_boss') then 'foreman' else 'installer' end
  from jsonb_to_recordset(p_entries) as x(project_id uuid,profile_id uuid,date date) join profiles p on p.id=x.profile_id where x.project_id=e.project_id and x.date=e.date;
  insert into schedule_events(assignment_id,actor,kind,payload) values(a,auth.uid(),'created',jsonb_build_object('ai',true,'request',p_request));
  ids:=array_append(ids,a);
 end loop;
 result:=jsonb_build_object('assignmentIds',ids,'assignmentCount',cardinality(ids),'published',false);
 insert into ai_action_receipts values(p_request,auth.uid(),'draft_schedule',md5(p_entries::text),result,now());
 return result;
end $$;
revoke all on function public.ai_draft_schedule(uuid,jsonb) from public,anon;
grant execute on function public.ai_draft_schedule(uuid,jsonb) to authenticated;

-- One validation path for chat review and native-board AI publication.
create function public.ai_schedule_issues(p_ids uuid[]) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare issues jsonb:='[]'; row record; member record;
begin
 perform 1 from projects where id in(select project_id from schedule_assignments where id=any(p_ids)) order by id for share;
 perform 1 from profiles where id in(select profile_id from schedule_assignment_members where assignment_id=any(p_ids)) order by id for share;
 for row in select a.*,p.ready_state,p.deleted_at,p.status job_status from schedule_assignments a join projects p on p.id=a.project_id where a.id=any(p_ids) loop
  if row.deleted_at is not null or row.job_status<>'active' then issues:=issues||jsonb_build_array('A job is no longer active.'); end if;
  if row.ready_state is distinct from 'ready' then issues:=issues||jsonb_build_array('A job is not marked ready. Review its readiness first.'); end if;
  if not exists(select 1 from schedule_assignment_members where assignment_id=row.id) then issues:=issues||jsonb_build_array('An assignment has no crew.'); end if;
  if not exists(select 1 from schedule_assignment_members m join profiles p on p.id=m.profile_id where m.assignment_id=row.id and p.role in ('foreman','lead','supervisor','owner','admin','big_boss')) then issues:=issues||jsonb_build_array('An assignment needs a foreman or lead.'); end if;
  for member in select p.* from profiles p join schedule_assignment_members m on m.profile_id=p.id where m.assignment_id=row.id loop
   if member.is_partner or member.retired_at is not null or member.access_revoked_at is not null then issues:=issues||jsonb_build_array(member.display_name||' is not available for scheduling.'); end if;
   if exists(select 1 from time_off_requests t where t.profile_id=member.id and t.status in ('approved','pending') and t.start_date<=row.end_date and t.end_date>=row.start_date) then issues:=issues||jsonb_build_array(member.display_name||' has approved or pending time off. Resolve it before publishing.'); end if;
   if exists(select 1 from schedule_assignments other join schedule_assignment_members m on m.assignment_id=other.id where other.id<>row.id and other.status<>'canceled' and m.profile_id=member.id and other.start_date<=row.end_date and other.end_date>=row.start_date) then issues:=issues||jsonb_build_array(member.display_name||' has another booking during this assignment.'); end if;
  end loop;
 end loop;
 return issues;
end $$;
revoke all on function public.ai_schedule_issues(uuid[]) from public,anon,authenticated;

-- Native Scheduling can publish these drafts too; it cannot bypass availability.
create function public.ai_guard_schedule_publication() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if new.created_via='ai' and new.status='published' and (tg_op='INSERT' or old.status is distinct from 'published') then
  perform public.ai_require_actor(2);
  if jsonb_array_length(public.ai_schedule_issues(array[new.id]))>0 then
   raise exception 'Resolve crew availability and job readiness before publishing this AI draft.';
  end if;
 end if;
 return new;
end $$;
revoke all on function public.ai_guard_schedule_publication() from public,anon,authenticated;
create trigger ai_schedule_publication_guard after insert or update of status on public.schedule_assignments
for each row execute function public.ai_guard_schedule_publication();

create function public.ai_review_schedule(p_request uuid) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare r ai_action_receipts; ids uuid[]; assignments jsonb; issues jsonb:='[]'; row record; member record;
begin
 perform public.workflow_require_manager();
 perform public.ai_require_actor(2);
 select * into r from ai_action_receipts where id=p_request and profile_id=auth.uid() and kind='draft_schedule';
 if not found then raise exception 'This draft is unavailable to this account.'; end if;
 select array_agg(value::uuid) into ids from jsonb_array_elements_text(r.result->'assignmentIds');
 if (select count(*) from schedule_assignments where id=any(ids))<>cardinality(ids) then raise exception 'These assignments changed or were removed. Review Scheduling.'; end if;
 select jsonb_agg(jsonb_build_object('id',a.id,'projectId',a.project_id,'job',p.job_code||' · '||p.name,'startDate',a.start_date,'endDate',a.end_date,'startTime',a.start_time,'endTime',a.end_time,'note',a.note,'status',a.status,'updatedAt',a.updated_at,'readyState',p.ready_state,
 'crew',coalesce((select jsonb_agg(jsonb_build_object('id',m.profile_id,'name',pr.display_name,'role',pr.role,'active',pr.active) order by m.profile_id) from schedule_assignment_members m join profiles pr on pr.id=m.profile_id where m.assignment_id=a.id),'[]'::jsonb)) order by a.id)
 into assignments from schedule_assignments a join projects p on p.id=a.project_id where a.id=any(ids);
 for row in select a.*,p.ready_state,p.deleted_at,p.status job_status from schedule_assignments a join projects p on p.id=a.project_id where a.id=any(ids) loop
  if row.status<>'draft' and not coalesce((r.result->>'published')::boolean,false) then issues:=issues||jsonb_build_array('An assignment is no longer a draft.'); end if;
  if row.created_via is distinct from 'ai' or row.created_by is distinct from auth.uid() then issues:=issues||jsonb_build_array('An assignment no longer belongs to this AI draft.'); end if;
  if exists(select 1 from workflow_plan_assignments where assignment_id=row.id) then issues:=issues||jsonb_build_array('This assignment is now part of a connected plan. Publish it there.'); end if;
 end loop;
 issues:=issues||public.ai_schedule_issues(ids);
 return jsonb_build_object('requestId',p_request,'assignments',coalesce(assignments,'[]'),'issues',issues,'reviewToken',md5(coalesce(assignments::text,'')||issues::text),'published',coalesce((r.result->>'published')::boolean,false));
end $$;
revoke all on function public.ai_review_schedule(uuid) from public,anon;
grant execute on function public.ai_review_schedule(uuid) to authenticated;

create function public.ai_publish_schedule(p_request uuid,p_review_token text) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare review jsonb; r ai_action_receipts; ids uuid[]; person uuid; a uuid;
begin
 perform public.workflow_require_manager();
 perform public.ai_require_actor(2);
 perform pg_advisory_xact_lock(639024,1);
 select * into r from ai_action_receipts where id=p_request and profile_id=auth.uid() and kind='draft_schedule' for update;
 if not found then raise exception 'This draft is unavailable to this account.'; end if;
 if coalesce((r.result->>'published')::boolean,false) then return r.result; end if;
 perform 1 from projects where id in(select a.project_id from schedule_assignments a where a.id in(select value::uuid from jsonb_array_elements_text(r.result->'assignmentIds'))) order by id for share;
 perform 1 from profiles where id in(select m.profile_id from schedule_assignment_members m where m.assignment_id in(select value::uuid from jsonb_array_elements_text(r.result->'assignmentIds'))) order by id for share;
 review:=public.ai_review_schedule(p_request);
 if p_review_token is null or review->>'reviewToken'<>p_review_token then raise exception 'The schedule changed. Refresh and review before publishing.' using errcode='40001'; end if;
 if jsonb_array_length(review->'issues')>0 then raise exception 'Resolve the review issues before publishing.'; end if;
 select array_agg(value::uuid) into ids from jsonb_array_elements_text(r.result->'assignmentIds');
 update schedule_assignments set status='published',published_at=now(),updated_at=now() where id=any(ids) and status='draft';
 foreach a in array ids loop insert into schedule_events(assignment_id,actor,kind,payload) values(a,auth.uid(),'published',jsonb_build_object('ai',true,'request',p_request)); end loop;
 -- Existing reminder delivery retries this durable queue. No travel is published.
 for person in select distinct profile_id from schedule_assignment_members where assignment_id=any(ids) loop
  insert into crew_reminders(profile_id,dedupe_key,title,body,url,expires_at)
  values(person,'ai-schedule:'||p_request::text||':'||person::text,'Your work schedule was updated','Open My Schedule to review your job and dates.','/my-schedule',now()+interval '7 days') on conflict(dedupe_key) do nothing;
 end loop;
 update ai_action_receipts set result=result||jsonb_build_object('published',true,'publishedAt',now(),'notifications','queued') where id=p_request returning result into review;
 return review;
end $$;
revoke all on function public.ai_publish_schedule(uuid,text) from public,anon;
grant execute on function public.ai_publish_schedule(uuid,text) to authenticated;

-- Include receipts in the existing retirement preview; deletion follows its account FK.
create or replace function public.person_record_counts(p_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object('ai_action_receipts.profile_id',(select count(*) from ai_action_receipts where profile_id=p_id)) || jsonb_build_object('time_off_requests.profile_id',(select count(*) from time_off_requests where profile_id=p_id),'crew_reminders.profile_id',(select count(*) from crew_reminders where profile_id=p_id)) || jsonb_build_object('service_visits.created_by',(select count(*) from service_visits where created_by=p_id),'service_visit_units.created_by',(select count(*) from service_visit_units where created_by=p_id),'service_time_sessions.profile_id',(select count(*) from service_time_sessions where profile_id=p_id),'service_media.created_by',(select count(*) from service_media where created_by=p_id),'service_audit.actor_id',(select count(*) from service_audit where actor_id=p_id),'service_commands.profile_id',(select count(*) from service_commands where profile_id=p_id)) || jsonb_build_object(
    'custom_work_units.created_by', (select count(*) from custom_work_units where created_by = p_id),
    'custom_work_sessions.profile_id', (select count(*) from custom_work_sessions where profile_id = p_id),
    'custom_work_history.actor_id', (select count(*) from custom_work_history where actor_id = p_id),
    'custom_work_commands.profile_id', (select count(*) from custom_work_commands where profile_id = p_id),

    'workflow_plans.created_by', (select count(*) from workflow_plans where created_by = p_id),
    'workflow_plan_revisions.actor', (select count(*) from workflow_plan_revisions where actor = p_id),
    'workflow_notice_outbox.profile_id', (select count(*) from workflow_notice_outbox where profile_id = p_id),
    -- Time and money.
    'time_shifts.profile_id',
      (select count(*) from time_shifts where profile_id = p_id),
    'unit_sessions.profile_id',
      (select count(*) from unit_sessions where profile_id = p_id),
    'install_events.installer_id',
      (select count(*) from install_events where installer_id = p_id),
    'install_events.credited_to',
      (select count(*) from install_events where credited_to = p_id),
    'receipts.uploaded_by',
      (select count(*) from receipts where uploaded_by = p_id),
    'pay_rates.profile_id',
      (select count(*) from pay_rates where profile_id = p_id),
    'overtime_rules.profile_id',
      (select count(*) from overtime_rules where profile_id = p_id),
    'timecard_periods.profile_id',
      (select count(*) from timecard_periods where profile_id = p_id),
    'time_shift_edits.edited_by',
      (select count(*) from time_shift_edits where edited_by = p_id),
    -- Safety and training.
    'certifications.profile_id',
      (select count(*) from certifications where profile_id = p_id),
    'toolbox_completions.profile_id',
      (select count(*) from toolbox_completions where profile_id = p_id),
    'safety_acks.profile_id',
      (select count(*) from safety_acks where profile_id = p_id),
    'capability_badges.installer_id',
      (select count(*) from capability_badges where installer_id = p_id),
    'installer_clearance.installer_id',
      (select count(*) from installer_clearance where installer_id = p_id),
    'learn_progress.profile_id',
      (select count(*) from learn_progress where profile_id = p_id),
    'learning_video_quiz_attempts.profile_id',
      (select count(*) from learning_video_quiz_attempts where profile_id = p_id),
    'education_credits.profile_id',
      (select count(*) from education_credits where profile_id = p_id),
    -- The job site.
    'daily_logs.filed_by',
      (select count(*) from daily_logs where filed_by = p_id),
    'opening_phases.started_by',
      (select count(*) from opening_phases where started_by = p_id),
    'opening_phases.submitted_by',
      (select count(*) from opening_phases where submitted_by = p_id),
    'flash_run_assignments.assigned_by',
      (select count(*) from flash_run_assignments where assigned_by = p_id),
    'flash_run_assignments.profile_id',
      (select count(*) from flash_run_assignments where profile_id = p_id),
    'summons.requested_by',
      (select count(*) from summons where requested_by = p_id),
    'summon_helpers.profile_id',
      (select count(*) from summon_helpers where profile_id = p_id),
    'summon_declines.profile_id',
      (select count(*) from summon_declines where profile_id = p_id),
    'unit_redos.pressed_by',
      (select count(*) from unit_redos where pressed_by = p_id),
    'schedule_assignment_members.profile_id',
      (select count(*) from schedule_assignment_members where profile_id = p_id),
    'trip_crew.profile_id',
      (select count(*) from trip_crew where profile_id = p_id),
    'vehicle_drivers.profile_id',
      (select count(*) from vehicle_drivers where profile_id = p_id),
    -- What they said and what they were given credit for.
    'points_ledger.profile_id',
      (select count(*) from points_ledger where profile_id = p_id),
    'task_sessions.profile_id',
      (select count(*) from task_sessions where profile_id = p_id),
    'project_messages.author_id',
      (select count(*) from project_messages where author_id = p_id),
    'ask_question_log.asker_id',
      (select count(*) from ask_question_log where asker_id = p_id)
  );
$$;
revoke all on function public.person_record_counts(uuid) from public,anon,authenticated;
grant execute on function public.person_record_counts(uuid) to service_role;
