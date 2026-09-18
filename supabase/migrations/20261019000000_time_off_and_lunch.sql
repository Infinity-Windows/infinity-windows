-- Days away are schedule records, never payroll punches or paid leave.
create table public.time_off_requests (
  id uuid primary key,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null check(kind in ('sick','vacation','other')),
  start_date date not null,
  end_date date not null check(end_date >= start_date and end_date - start_date <= 365),
  status text not null check(status in ('approved','pending','declined','canceled')),
  created_at timestamptz not null default now(),
  reviewed_by uuid references public.profiles(id) on delete set null,
  reviewed_at timestamptz
);
create index time_off_person_dates on public.time_off_requests(profile_id,start_date,end_date);

create function public.time_off_internal() returns boolean language sql stable security definer set search_path=public,pg_temp as $$
  select exists(select 1 from profiles where id=auth.uid() and not is_partner and active and retired_at is null and access_revoked_at is null)
$$;
create function public.time_off_manager() returns boolean language sql stable security definer set search_path=public,pg_temp as $$
  select public.time_off_internal() and exists(select 1 from profiles where id=auth.uid() and role in ('supervisor','owner','admin','big_boss'))
$$;
revoke all on function public.time_off_internal() from public,anon;
revoke all on function public.time_off_manager() from public,anon;
grant execute on function public.time_off_internal() to authenticated;
grant execute on function public.time_off_manager() to authenticated;
alter table public.time_off_requests enable row level security;
revoke all on public.time_off_requests from public,anon,authenticated;
grant select on public.time_off_requests to authenticated;
create policy time_off_read on public.time_off_requests for select to authenticated using(
 not public.is_partner_user() and public.time_off_internal() and (profile_id=auth.uid() or public.my_role_rank()>=2));

-- A durable notification inbox plus retryable web-push delivery. The body is
-- deliberately free of medical details. No caller supplies recipient or copy.
create table public.crew_reminders (
 id uuid primary key default gen_random_uuid(),
 profile_id uuid not null references public.profiles(id) on delete cascade,
 request_id uuid references public.time_off_requests(id) on delete cascade,
 request_status text,
 shift_id uuid references public.time_shifts(id) on delete cascade,
 break_started_at timestamptz,
 dedupe_key text not null unique,
 title text not null, body text not null, url text not null,
 created_at timestamptz not null default now(),
 expires_at timestamptz not null,
 sent_at timestamptz, lease uuid, lease_until timestamptz,
 attempts integer not null default 0
);
alter table public.crew_reminders enable row level security;
revoke all on public.crew_reminders from public,anon,authenticated;
grant select on public.crew_reminders to authenticated;
create policy reminder_read on public.crew_reminders for select to authenticated using(not public.is_partner_user() and public.time_off_internal() and profile_id=auth.uid());

create function public.time_off_notify(p_request uuid) returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare r time_off_requests; recipient uuid; recipients uuid[]; person text; title_text text;
begin
 select * into r from time_off_requests where id=p_request;
 select display_name into person from profiles where id=r.profile_id;
 -- Use supervisors assigned to the affected jobs where available; otherwise
 -- every active supervisor, with owners as fallback when no supervisor exists.
 select array_agg(distinct p.id) into recipients from schedule_assignments a
 join schedule_assignment_members m on m.assignment_id=a.id and m.profile_id=r.profile_id
 join service_job_supervisors s on s.project_id=a.project_id
 join profiles p on p.id=s.profile_id
 where a.status in ('published','in_progress') and a.start_date<=r.end_date and a.end_date>=r.start_date
 and not p.is_partner and p.active and p.retired_at is null and p.access_revoked_at is null and p.role in ('supervisor','owner','admin','big_boss');
 if coalesce(cardinality(recipients),0)=0 then
  select array_agg(id) into recipients from profiles where not is_partner and active and retired_at is null and access_revoked_at is null and role='supervisor';
 end if;
 if coalesce(cardinality(recipients),0)=0 then
  select array_agg(id) into recipients from profiles where not is_partner and active and retired_at is null and access_revoked_at is null and role in ('owner','admin','big_boss');
 end if;
 title_text:=case when r.kind='sick' and r.status='approved' then 'Sick day reported' when r.status='pending' then 'Time off needs approval' else 'Time off '||r.status end;
 foreach recipient in array coalesce(recipients,'{}'::uuid[]) loop
  insert into crew_reminders(profile_id,request_id,request_status,dedupe_key,title,body,url,expires_at)
  values(recipient,r.id,r.status,'time-off:'||r.id||':'||r.status||':'||recipient,title_text,
   coalesce(person,'Crew member')||' · '||r.start_date||' – '||r.end_date,'/scheduling',now()+interval '7 days') on conflict(dedupe_key) do nothing;
 end loop;
 if r.status<>'pending' then
  insert into crew_reminders(profile_id,request_id,request_status,dedupe_key,title,body,url,expires_at)
  values(r.profile_id,r.id,r.status,'time-off-self:'||r.id||':'||r.status,title_text,r.start_date||' – '||r.end_date,'/my-schedule',now()+interval '7 days') on conflict(dedupe_key) do nothing;
 end if;
end $$;
revoke all on function public.time_off_notify(uuid) from public,anon,authenticated;

create function public.request_time_off(p_id uuid,p_kind text,p_start date,p_end date) returns uuid
language plpgsql security definer set search_path=public,pg_temp as $$
declare old time_off_requests;
begin
 if not public.time_off_internal() then raise exception 'An active crew login is required.' using errcode='42501'; end if;
 if p_id is null or p_kind is null or p_kind not in ('sick','vacation','other') or p_start is null or p_end is null or p_end<p_start or p_end-p_start>365 then raise exception 'Choose a valid date range of up to one year.'; end if;
 perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text,919));
 select * into old from time_off_requests where id=p_id;
 if found then
  if old.profile_id<>auth.uid() or old.kind<>p_kind or old.start_date<>p_start or old.end_date<>p_end then raise exception 'That request belongs to another entry.'; end if;
  return old.id;
 end if;
 if exists(select 1 from time_off_requests where profile_id=auth.uid() and status in ('pending','approved') and start_date<=p_end and end_date>=p_start) then raise exception 'Those dates overlap an existing time-off entry. Cancel that entry first if it needs changing.'; end if;
 insert into time_off_requests(id,profile_id,kind,start_date,end_date,status)
 values(p_id,auth.uid(),p_kind,p_start,p_end,case when p_kind='sick' then 'approved' else 'pending' end);
 perform public.time_off_notify(p_id);
 return p_id;
end $$;
revoke all on function public.request_time_off(uuid,text,date,date) from public,anon;
grant execute on function public.request_time_off(uuid,text,date,date) to authenticated;

create function public.review_time_off(p_id uuid,p_status text) returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare r time_off_requests;
begin
 if not public.time_off_internal() then raise exception 'An active crew login is required.' using errcode='42501'; end if;
 select * into r from time_off_requests where id=p_id for update;
 if not found then raise exception 'Time-off entry not found.'; end if;
 if p_status is null or p_status not in ('approved','declined','canceled') then raise exception 'Choose a valid decision.'; end if;
 if not public.time_off_manager() and not (p_status='canceled' and r.profile_id=auth.uid()) then raise exception 'Only a supervisor can approve time off.' using errcode='42501'; end if;
 if r.status=p_status then return; end if;
 if p_status in ('approved','declined') and r.status<>'pending' then raise exception 'This request has already been reviewed.'; end if;
 if p_status='canceled' and r.status not in ('pending','approved') then raise exception 'This entry is already closed.'; end if;
 update time_off_requests set status=p_status,reviewed_by=auth.uid(),reviewed_at=now() where id=p_id;
 perform public.time_off_notify(p_id);
end $$;
revoke all on function public.review_time_off(uuid,text) from public,anon;
grant execute on function public.review_time_off(uuid,text) to authenticated;

-- Schedule overlays exclude ONLY the absent days. Keep the published source
-- block intact so canceling leave restores the original assignment and history.
-- Lunch reminders do not stop the break or add paid time.
create function public.claim_crew_reminders(p_lease uuid) returns setof public.crew_reminders
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if p_lease is null then raise exception 'A delivery lease is required.'; end if;
 insert into crew_reminders(profile_id,shift_id,break_started_at,dedupe_key,title,body,url,expires_at)
 select s.profile_id,s.id,s.break_started_at,'lunch:'||s.id||':'||floor(extract(epoch from s.break_started_at)*1000)::bigint,
  'Your 30-minute lunch is up','Ready to return? Open Forge and end your break.','/clock',s.break_started_at+interval '2 hours'
 from time_shifts s join profiles p on p.id=s.profile_id
 where s.status='open' and s.clock_out_at is null and s.break_type='lunch'
 and s.break_started_at<=now()-interval '30 minutes' and s.break_started_at>now()-interval '2 hours'
 and p.active and not p.is_partner and p.retired_at is null and p.access_revoked_at is null
 on conflict(dedupe_key) do nothing;
 return query update crew_reminders n set lease=p_lease,lease_until=now()+interval '2 minutes',attempts=n.attempts+1
 where n.id in(select q.id from crew_reminders q join profiles p on p.id=q.profile_id
  where q.sent_at is null and q.expires_at>now() and (q.lease_until is null or q.lease_until<now()) and q.attempts<30
  and p.active and not p.is_partner and p.retired_at is null and p.access_revoked_at is null
  and (q.request_id is null or exists(select 1 from time_off_requests r where r.id=q.request_id and r.status=q.request_status))
  and (q.shift_id is null or exists(select 1 from time_shifts s where s.id=q.shift_id and s.status='open' and s.clock_out_at is null and s.break_type='lunch' and s.break_started_at=q.break_started_at))
  order by q.created_at limit 50 for update of q skip locked)
 returning n.*;
end $$;
create function public.finish_crew_reminder(p_id uuid,p_lease uuid,p_sent boolean) returns void language sql security definer set search_path=public,pg_temp as $$
 update crew_reminders set sent_at=case when p_sent then now() else sent_at end,lease=null,lease_until=now()+interval '2 minutes'
 where id=p_id and lease=p_lease;
$$;
revoke all on function public.claim_crew_reminders(uuid) from public,anon,authenticated;
revoke all on function public.finish_crew_reminder(uuid,uuid,boolean) from public,anon,authenticated;
grant execute on function public.claim_crew_reminders(uuid) to service_role;
grant execute on function public.finish_crew_reminder(uuid,uuid,boolean) to service_role;

-- One-minute sweep works while the phone is locked. Local foreground reminders
-- still cover a lunch whose punch has not reached the server in a dead zone.
do $$ begin
 perform cron.schedule('crew-reminder-sweep','* * * * *',$c$select net.http_post(
 url := 'https://czprjcskmzzagdztqonm.supabase.co/functions/v1/crew-reminder-sweep',body := '{}'::jsonb,
 headers := '{"Content-Type":"application/json"}'::jsonb);$c$);
exception when invalid_schema_name or undefined_function then
 raise notice 'Cron unavailable in this test database; production requires pg_cron and pg_net.';
end $$;

create or replace function public.person_record_counts(p_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object('time_off_requests.profile_id',(select count(*) from time_off_requests where profile_id=p_id),'crew_reminders.profile_id',(select count(*) from crew_reminders where profile_id=p_id)) || jsonb_build_object('service_visits.created_by',(select count(*) from service_visits where created_by=p_id),'service_visit_units.created_by',(select count(*) from service_visit_units where created_by=p_id),'service_time_sessions.profile_id',(select count(*) from service_time_sessions where profile_id=p_id),'service_media.created_by',(select count(*) from service_media where created_by=p_id),'service_audit.actor_id',(select count(*) from service_audit where actor_id=p_id),'service_commands.profile_id',(select count(*) from service_commands where profile_id=p_id)) || jsonb_build_object(
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
