-- Original crew evidence stays in Forge; Hexcore reviews linked cases rather
-- than creating a second personal-data archive. Profile retention cascades here.
create table public.hex_portal_cases (
 id uuid primary key,
 asker_id uuid not null references public.profiles(id) on delete cascade,
 project_id uuid not null references public.projects(id) on delete cascade,
 unit_label text not null default '' check(length(unit_label)<=160),
 question text not null check(length(btrim(question)) between 1 and 8000),
 answer text not null check(length(answer)<=20000),
 sources jsonb not null default '[]' check(jsonb_typeof(sources)='array' and jsonb_array_length(sources)<=12),
 created_at timestamptz not null default now()
);
create index hex_portal_cases_project_date on public.hex_portal_cases(project_id,created_at,id);
create table public.hex_portal_outcomes (
 id uuid primary key,
 case_id uuid not null references public.hex_portal_cases(id) on delete cascade,
 actor_id uuid not null references public.profiles(id) on delete cascade,
 outcome text not null check(outcome in ('resolved','needs-help')),
 explanation text not null default '' check(length(explanation)<=4000),
 created_at timestamptz not null default now()
);
create index hex_portal_outcomes_case_date on public.hex_portal_outcomes(case_id,created_at,id);
-- No person, question or job is duplicated in the aggregate invalidation flag.
-- Only a new reviewed revision can supersede an unresolved report.
create table public.hex_portal_guidance_flags (
 guidance_id uuid not null,
 revision integer not null check(revision>0),
 flagged_at timestamptz not null default now(),
 primary key(guidance_id,revision)
);
-- Server-issued proof that this person was shown this exact shared revision.
create table public.hex_portal_guidance_receipts (
 actor_id uuid not null references public.profiles(id) on delete cascade,
 project_id uuid not null references public.projects(id) on delete cascade,
 guidance_id uuid not null,
 revision integer not null check(revision>0),
 primary key(actor_id,project_id,guidance_id,revision)
);
alter table public.hex_portal_guidance_receipts enable row level security;
revoke all on public.hex_portal_guidance_receipts from public,anon,authenticated;
grant all on public.hex_portal_guidance_receipts to service_role;
create function public.hex_portal_crew() returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
 select exists(select 1 from profiles where id=auth.uid()
 and role in ('installer','foreman','lead','supervisor','admin','owner','big_boss')
 and not is_partner and retired_at is null and access_revoked_at is null)
$$;
revoke all on function public.hex_portal_crew() from public,anon;
grant execute on function public.hex_portal_crew() to authenticated;
alter table public.hex_portal_cases enable row level security;
alter table public.hex_portal_outcomes enable row level security;
alter table public.hex_portal_guidance_flags enable row level security;
revoke all on public.hex_portal_cases,public.hex_portal_outcomes,public.hex_portal_guidance_flags from public,anon,authenticated;
grant select on public.hex_portal_cases,public.hex_portal_outcomes,public.hex_portal_guidance_flags to authenticated;
grant all on public.hex_portal_cases,public.hex_portal_outcomes,public.hex_portal_guidance_flags to service_role;
create policy hex_portal_case_read on public.hex_portal_cases for select to authenticated using(public.hex_portal_crew() and (asker_id=auth.uid() or public.my_role_rank()>=2));
create policy hex_portal_outcome_read on public.hex_portal_outcomes for select to authenticated using(exists(select 1 from public.hex_portal_cases c where c.id=case_id));
create policy hex_portal_flag_read on public.hex_portal_guidance_flags for select to authenticated using(public.hex_portal_crew());

create function public.hex_portal_save_case(p_id uuid,p_project_id uuid,p_unit_label text,p_question text,p_answer text,p_sources jsonb) returns uuid
language plpgsql security definer set search_path=public,pg_temp as $$
declare old public.hex_portal_cases; s jsonb;
begin
 if not public.hex_portal_crew() then raise exception 'Current crew access required' using errcode='42501'; end if;
 if not exists(select 1 from projects where id=p_project_id and deleted_at is null and (not is_test or _is_supervisor(auth.uid()))) then raise exception 'Choose an existing job'; end if;
 if p_sources is null or jsonb_typeof(p_sources)<>'array' or jsonb_array_length(p_sources)>12 or octet_length(p_sources::text)>8000 then raise exception 'Invalid sources'; end if;
 -- Typed source references, never executable URLs or arbitrary model instructions.
 for s in select value from jsonb_array_elements(p_sources) loop
  if jsonb_typeof(s)<>'object' or length(coalesce(s->>'title',''))>300 or length(coalesce(s->>'id',''))>160 then raise exception 'Invalid source'; end if;
  if s->>'kind'='hex-portal' and (coalesce(s->>'id','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' or coalesce(s->>'revision','') !~ '^[1-9][0-9]{0,8}$') then raise exception 'Invalid guidance revision'; end if;
  if s->>'kind'='hex-portal' and not exists(select 1 from hex_portal_guidance_receipts r where r.actor_id=auth.uid() and r.project_id=p_project_id and r.guidance_id=(s->>'id')::uuid and r.revision=(s->>'revision')::integer) then raise exception 'Guidance was not shown to this person on this job' using errcode='42501'; end if;
 end loop;
 insert into hex_portal_cases(id,asker_id,project_id,unit_label,question,answer,sources)
 values(p_id,auth.uid(),p_project_id,coalesce(p_unit_label,''),btrim(p_question),p_answer,p_sources) on conflict(id) do nothing;
 select * into old from hex_portal_cases where id=p_id;
 if old.asker_id<>auth.uid() or old.project_id<>p_project_id or old.unit_label<>coalesce(p_unit_label,'') or old.question<>btrim(p_question) or old.answer<>p_answer or old.sources<>p_sources then raise exception 'This save ID belongs to different evidence' using errcode='23505'; end if;
 return p_id;
end $$;
revoke all on function public.hex_portal_save_case(uuid,uuid,text,text,text,jsonb) from public,anon;
grant execute on function public.hex_portal_save_case(uuid,uuid,text,text,text,jsonb) to authenticated;

create function public.hex_portal_save_outcome(p_id uuid,p_case_id uuid,p_outcome text,p_explanation text) returns uuid
language plpgsql security definer set search_path=public,pg_temp as $$
declare c public.hex_portal_cases; prior public.hex_portal_outcomes; s jsonb;
begin
 if not public.hex_portal_crew() then raise exception 'Current crew access required' using errcode='42501'; end if;
 select * into c from hex_portal_cases where id=p_case_id and asker_id=auth.uid();
 if not found then raise exception 'Only the original asker can report this outcome' using errcode='42501'; end if;
 insert into hex_portal_outcomes(id,case_id,actor_id,outcome,explanation) values(p_id,c.id,auth.uid(),p_outcome,coalesce(p_explanation,'')) on conflict(id) do nothing;
 select * into prior from hex_portal_outcomes where id=p_id;
 if prior.case_id<>c.id or prior.actor_id<>auth.uid() or prior.outcome<>p_outcome or prior.explanation<>coalesce(p_explanation,'') then raise exception 'This outcome ID was already used' using errcode='23505'; end if;
 if p_outcome='needs-help' then
  for s in select value from jsonb_array_elements(c.sources) where value->>'kind'='hex-portal' loop
   insert into hex_portal_guidance_flags(guidance_id,revision) values((s->>'id')::uuid,(s->>'revision')::integer) on conflict do nothing;
  end loop;
 end if;
 return p_id;
end $$;
revoke all on function public.hex_portal_save_outcome(uuid,uuid,text,text) from public,anon;
grant execute on function public.hex_portal_save_outcome(uuid,uuid,text,text) to authenticated;

-- Small, current identity proof for the private Hexcore endpoint. The caller's
-- JWT, rather than a browser role field or the shared transport token, decides.
create function public.hex_portal_identity(p_project_id uuid) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare p record;
begin
 if not public.hex_portal_crew() then raise exception 'Current crew access required' using errcode='42501'; end if;
 select id,job_code,name into p from projects where id=p_project_id and deleted_at is null and (not is_test or _is_supervisor(auth.uid()));
 if not found then raise exception 'Job not available' using errcode='42501'; end if;
 return jsonb_build_object('userId',auth.uid(),'rank',public.my_role_rank(),'projectId',p.id,'jobCode',p.job_code,'jobName',p.name);
end $$;
revoke all on function public.hex_portal_identity(uuid) from public,anon;
grant execute on function public.hex_portal_identity(uuid) to authenticated;

create or replace function public.person_record_counts(p_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
 'hex_portal_cases.asker_id',(select count(*) from public.hex_portal_cases where asker_id=p_id),
 'hex_portal_outcomes.actor_id',(select count(*) from public.hex_portal_outcomes where actor_id=p_id),
 'hex_portal_guidance_receipts.actor_id',(select count(*) from public.hex_portal_guidance_receipts where actor_id=p_id),'time_off_requests.profile_id',(select count(*) from time_off_requests where profile_id=p_id),'crew_reminders.profile_id',(select count(*) from crew_reminders where profile_id=p_id)) || jsonb_build_object('service_visits.created_by',(select count(*) from service_visits where created_by=p_id),'service_visit_units.created_by',(select count(*) from service_visit_units where created_by=p_id),'service_time_sessions.profile_id',(select count(*) from service_time_sessions where profile_id=p_id),'service_media.created_by',(select count(*) from service_media where created_by=p_id),'service_audit.actor_id',(select count(*) from service_audit where actor_id=p_id),'service_commands.profile_id',(select count(*) from service_commands where profile_id=p_id)) || jsonb_build_object(
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


insert into public.app_release_notes(id,published_on,audience,kind,title_en,title_es,body_en,body_es,href) values
('2026-09-22-hex-portal','2026-09-22',array[0,1,2,3],'improvement',
 'Save job lessons with Hex-Portal','Guarda lecciones del trabajo con Hex-Portal',
 'In Ask, choose a job, ask a work question and save the answer for review. Record what worked or what still needs help. Jobs linked by the owner can also receive reviewed Hexcore lessons. Other answers are clearly labeled as needing review.',
 'En Ask, elige un trabajo, haz una pregunta y guarda la respuesta para revisión. Anota lo que funcionó o lo que falta resolver. Los trabajos vinculados por el dueño también pueden recibir lecciones revisadas de Hexcore. Las demás respuestas indican que necesitan revisión.','/ask') on conflict(id) do nothing;
