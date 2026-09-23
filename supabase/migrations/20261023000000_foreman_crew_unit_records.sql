-- Retrospective work attribution and planned crew assignments. No payroll or QC writes.
begin;
alter table public.custom_work_units add column untimed_work_present boolean not null default false;
create table public.crew_work_records (
  id uuid primary key,
  project_id uuid not null references public.projects(id) on delete cascade,
  unit_id uuid not null references public.custom_work_units(id) on delete cascade,
  filed_by uuid references public.profiles(id) on delete set null,
  work_date date not null,
  stage text not null check(length(btrim(stage)) between 1 and 100),
  outcome text not null check(outcome in ('assigned','partial','finished')),
  whole_complete boolean not null default false,
  description text not null default '' check(length(description)<=4000),
  created_at timestamptz not null default now()
);
create index crew_work_records_job on public.crew_work_records(project_id,work_date);
create table public.crew_work_record_people (
  record_id uuid not null references public.crew_work_records(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  primary key(record_id,profile_id)
);
alter table public.crew_work_records enable row level security;
alter table public.crew_work_record_people enable row level security;
revoke all on public.crew_work_records, public.crew_work_record_people from public,anon,authenticated;
grant select on public.crew_work_records, public.crew_work_record_people to authenticated;
create policy crew_records_read on public.crew_work_records for select to authenticated using (
  public.custom_work_internal() and exists(select 1 from public.projects p where p.id=project_id and p.deleted_at is null)
);
create policy crew_record_people_read on public.crew_work_record_people for select to authenticated using (
  exists(select 1 from public.crew_work_records r where r.id=record_id)
);

create function public.record_crew_work(p_id uuid,p_data jsonb) returns uuid
language plpgsql security definer set search_path=public,pg_temp as $$
declare
  uid uuid:=auth.uid(); receipt public.custom_work_commands;
  unit_data jsonb; unit_id uuid; job_id uuid; people uuid[]; work_day date;
  result_id uuid; existing public.custom_work_units; person uuid;
  record_payload jsonb:=jsonb_build_object('action','crew_record','data',p_data);
begin
  if not public.custom_work_internal() or not public._is_lead(uid) then
    raise exception 'Only an active foreman, supervisor or owner can record work for the crew.' using errcode='42501';
  end if;
  if p_id is null or p_data is null or jsonb_typeof(p_data)<>'object' then raise exception 'Invalid crew record.'; end if;
  -- Same receipt lock as custom_work_command; safe after a lost response or two tabs.
  perform pg_advisory_xact_lock(hashtextextended(p_id::text,7282));
  select * into receipt from public.custom_work_commands where id=p_id;
  if found then
    if receipt.profile_id<>uid or receipt.payload<>record_payload then raise exception 'This retry belongs to a different request.'; end if;
    return receipt.result_id;
  end if;
  perform pg_advisory_xact_lock(hashtextextended(uid::text,7281));
  unit_data:=p_data->'unit';
  if jsonb_typeof(unit_data) is distinct from 'object' then raise exception 'Choose or build a unit.'; end if;
  unit_id:=(unit_data->>'id')::uuid;
  job_id:=(unit_data->>'project_id')::uuid;
  if unit_id is null or job_id is null then raise exception 'Choose a job and a unit.'; end if;
  -- Prevent two new records creating duplicate labels concurrently on the same job.
  perform pg_advisory_xact_lock(hashtextextended(job_id::text,7285));
  select * into existing from public.custom_work_units where id=unit_id for update;
  if existing.id is not null and (existing.project_id is distinct from job_id or existing.opening_id is distinct from nullif(unit_data->>'opening_id','')::uuid) then
    raise exception 'Use Unit details to move or link an existing unit before recording crew work.';
  end if;
  if length(btrim(coalesce(unit_data->>'label','')))=0 then raise exception 'Enter a unit number or name.'; end if;
  if existing.id is null and exists(select 1 from public.custom_work_units where project_id=job_id and lower(btrim(label))=lower(btrim(unit_data->>'label'))) then
    raise exception 'A unit with this name already exists. Select it, or include the building/floor for a different unit.';
  end if;
  if existing.id is null and nullif(unit_data->>'opening_id','') is null and exists(select 1 from public.project_openings where project_id=job_id and removed_at is null and lower(btrim(opening_code))=lower(btrim(unit_data->>'label'))) then
    raise exception 'This unit is already on the map. Select the map unit instead of creating a duplicate.';
  end if;
  if jsonb_typeof(p_data->'people') is distinct from 'array' or jsonb_array_length(p_data->'people') not between 1 and 100 then raise exception 'Select the people who did or will do this work.'; end if;
  select array_agg(distinct value::uuid) into people from jsonb_array_elements_text(p_data->'people');
  foreach person in array people loop
    if person is null or not exists(select 1 from public.profiles where id=person and active and not coalesce(is_partner,false) and role in ('installer','foreman','supervisor','owner')) then
      raise exception 'Choose active Forge crew members.';
    end if;
  end loop;
  work_day:=(p_data->>'work_date')::date;
  if work_day is null or work_day<date '2000-01-01' or work_day>date '2100-12-31' then raise exception 'Choose a valid work date.'; end if;
  if p_data->>'outcome' is null or p_data->>'outcome' not in ('assigned','partial','finished') then raise exception 'Choose assigned, partial or stage complete.'; end if;
  if p_data->>'outcome'<>'assigned' and work_day>(now() at time zone 'America/Denver')::date then raise exception 'Completed work cannot have a future date.'; end if;
  if p_data->>'stage' is null or p_data->>'stage' not in ('RO checked','Installing','Preparation','Flashing','Setting frame','Glazing','Hardware','Detail work','Rework') then raise exception 'Choose the work stage.'; end if;
  if length(coalesce(p_data->>'description',''))>4000 then raise exception 'Keep the description under 4000 characters.'; end if;
  if coalesce((p_data->>'whole_complete')::boolean,false) then
    if p_data->>'stage'<>'Installing' or p_data->>'outcome'<>'finished' then raise exception 'Whole installation completion requires the Installing stage to be finished.'; end if;
    unit_data:=jsonb_set(unit_data,'{facts}',coalesce(unit_data->'facts','{}') || '{"installation_complete":"Yes"}'::jsonb);
  end if;
  -- Existing unit command supplies role, job, map link, facts and revision checks.
  -- The unit and report commit together, or neither does. No finish_unit or session commands.
  result_id:=public.custom_work_command(p_id,'unit',unit_data);
  if p_data->>'outcome'<>'assigned' then
    update public.custom_work_units set untimed_work_present=true where id=result_id;
  end if;
  insert into public.crew_work_records(id,project_id,unit_id,filed_by,work_date,stage,outcome,whole_complete,description)
  values(p_id,job_id,result_id,uid,work_day,p_data->>'stage',p_data->>'outcome',coalesce((p_data->>'whole_complete')::boolean,false),coalesce(p_data->>'description',''));
  insert into public.crew_work_record_people(record_id,profile_id) select p_id,unnest(people);
  update public.custom_work_commands set payload=record_payload where id=p_id;
  insert into public.custom_work_history(project_id,actor_id,entity_id,action,after_value,reason)
  values(job_id,uid,result_id,'crew_record',jsonb_build_object('record_id',p_id,'people',people,'work_date',work_day,'stage',p_data->>'stage','outcome',p_data->>'outcome','description',coalesce(p_data->>'description','')),'Foreman crew record; no payroll changes');
  return result_id;
end; $$;
revoke all on function public.record_crew_work(uuid,jsonb) from public,anon;
grant execute on function public.record_crew_work(uuid,jsonb) to authenticated;

create or replace function public.person_record_counts(p_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'crew_work_records.filed_by', (select count(*) from crew_work_records where filed_by = p_id),
    'crew_work_record_people.profile_id', (select count(*) from crew_work_record_people where profile_id = p_id),
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
revoke all on function public.person_record_counts(uuid) from public,anon,authenticated;
grant execute on function public.person_record_counts(uuid) to service_role;

select public.attach_sandbox_guards();

insert into public.app_release_notes(id,published_on,audience,kind,title_en,title_es,body_en,body_es,href)
values ('2026-09-22-crew-unit-records','2026-09-22',array[1,2,3],'improvement',
'Build and file units for your crew','Crear y registrar unidades para tu equipo',
'In Current Work or a job’s Custom Data, choose Record crew work. Build or select a unit, select everyone who worked on it, and record the work date and stage—even without a unit timer. You can also assign upcoming work. Payroll hours and QC approval stay separate.',
'En Trabajo actual o Datos personalizados del trabajo, selecciona Registrar trabajo del equipo. Crea o selecciona una unidad, elige quiénes trabajaron y registra la fecha y etapa, incluso sin temporizador. También puedes asignar trabajo futuro. Las horas de nómina y la aprobación de calidad se mantienen separadas.', '/current-work');
commit;
