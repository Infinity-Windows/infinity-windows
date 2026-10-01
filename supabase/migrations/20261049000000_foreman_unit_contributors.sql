-- Foreman after-the-fact unit contributors: attribute saved units or mapped
-- openings to several crew members at once, with an auditable void/correct
-- path. No clock punches, timers, payroll minutes, points, QC approval,
-- flashing-phase submission or installation completion.
--
-- Reuses the existing ledger from 20261023000000/20261024000000
-- (crew_work_records, crew_work_record_people) rather than a second one.
-- record_stage_contributors is narrower than record_crew_work: it resolves
-- an EXISTING saved unit id or an EXISTING map-opening id server-side, and
-- never accepts unit facts, a project reassignment, a filer, whole_complete
-- or timer data. Building/editing a full custom unit stays on
-- record_crew_work (CrewWork.tsx, classic Current Work / Custom Data).
begin;

-- ---------------------------------------------------------------------------
-- 1. Void columns on the participant link, and a lookup index for the tuple
--    every contributor action keys on: unit + canonical stage + work date.
-- ---------------------------------------------------------------------------
alter table public.crew_work_record_people
  add column voided_at timestamptz,
  add column voided_by uuid references public.profiles(id) on delete set null,
  add column void_reason text;
-- voided_by is NOT tied to voided_at/void_reason in lockstep: it references
-- profiles on delete set null, so a corrected row outlives the deleted actor
-- with its timestamp and reason intact — only the second constraint below
-- stops an unvoided row from retaining an actor.
alter table public.crew_work_record_people
  add constraint crew_work_record_people_void_together
  check ((voided_at is null) = (void_reason is null));
alter table public.crew_work_record_people
  add constraint crew_work_record_people_void_actor_requires_void
  check (voided_at is not null or voided_by is null);
alter table public.crew_work_record_people
  add constraint crew_work_record_people_void_reason_bounded
  check (void_reason is null or length(btrim(void_reason)) between 1 and 500);

create index crew_work_records_unit_stage_date on public.crew_work_records(unit_id,stage,work_date);

-- The UI also reads original reports and history directly. A definer summary
-- cannot protect those independent SELECT paths. Keep their original project
-- boundary, including after a unit moves, and apply the same test partition.
-- _ai_job_visible is deliberately private; this caller-bound wrapper is the
-- only permission granted to authenticated readers for evaluating these RLS
-- policies. It cannot inspect another person's visibility.
create function public.crew_work_project_visible(p_project uuid) returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
  select public.custom_work_internal()
    and public._ai_job_visible(p_project,auth.uid())
$$;
revoke all on function public.crew_work_project_visible(uuid) from public,anon;
grant execute on function public.crew_work_project_visible(uuid) to authenticated;

drop policy crew_records_read on public.crew_work_records;
create policy crew_records_read on public.crew_work_records for select to authenticated using (
  not public.is_partner_user() and public.crew_work_project_visible(project_id)
);
-- crew_record_people_read already tests its parent through crew_work_records
-- RLS, so standalone participant reads inherit the strengthened boundary.

drop policy custom_history_read on public.custom_work_history;
create policy custom_history_read on public.custom_work_history for select to authenticated using (
  not public.is_partner_user() and public.custom_work_internal() and (
    public.crew_work_project_visible(project_id)
    or (project_id is null
      and (actor_id=auth.uid() or public._is_lead(auth.uid()))
      and public.is_test_profile(actor_id)=public.is_test_profile(auth.uid()))
  )
);

-- ---------------------------------------------------------------------------
-- 2. The effective-contributor digest: a stable fingerprint of exactly which
--    SOURCE EVIDENCE (report id + person, not merely the distinct person) is
--    a nonvoid contributor on one unit/stage/date tuple from a partial or
--    finished report (an assignment is not work done). Hashing the record id
--    alongside the person — not the distinct person alone — means a void
--    paired with a fresh report for the same person still changes the
--    digest, even though the resulting distinct-person set looks identical:
--    a stale correction loaded before that swap is still refused. Both the
--    read the client corrects against and correct_stage_contributors' own
--    staleness check call this, so they can never disagree.
-- ---------------------------------------------------------------------------
create function public._stage_contributor_digest(p_unit uuid,p_stage text,p_work_date date) returns text
language sql stable security definer set search_path=public,pg_temp as $$
  select md5(coalesce(string_agg(x.evidence,',' order by x.evidence),''))
  from (
    select distinct p.record_id::text||':'||p.profile_id::text as evidence
    from public.crew_work_record_people p join public.crew_work_records r on r.id=p.record_id
    where r.unit_id=p_unit and r.stage=p_stage and r.work_date=p_work_date
      and p.voided_at is null and r.outcome in ('partial','finished')
  ) x
$$;
revoke all on function public._stage_contributor_digest(uuid,text,date) from public,anon,authenticated;

-- Moving a unit does not move its historical reports. A tuple's digest and
-- correction cover ALL effective source links, so authority over the current
-- job alone cannot authorize reading or correcting that historical evidence.
-- Refuse the entire tuple when any source is unavailable, rather than silently
-- correcting only the visible fraction or leaking hidden sources in its digest.
create function public._stage_contributor_sources_visible(p_unit uuid,p_stage text,p_work_date date) returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
  select not exists (
    select 1
    from public.crew_work_record_people p join public.crew_work_records r on r.id=p.record_id
    where r.unit_id=p_unit and r.stage=p_stage and r.work_date=p_work_date
      and p.voided_at is null and r.outcome in ('partial','finished')
      and not coalesce(public._ai_job_visible(r.project_id,auth.uid()),false)
  )
$$;
revoke all on function public._stage_contributor_sources_visible(uuid,text,date) from public,anon,authenticated;

-- Read-only summary a foreman/installer loads before recording or correcting:
-- one row per distinct effective contributor, with the digest their tuple
-- would need to match to correct it. custom_work_internal() gates reading
-- (installers may see this, not write it). A unit can move to a different
-- job after a report was filed against it (custom_work_command's 'unit'/
-- 'link' action) — the report's OWN project_id (what it was filed under)
-- stays what it was, so both the unit's CURRENT project and the report's
-- ORIGINAL project must independently pass the same deleted/test-partition
-- visibility rule every other read here uses. If even one effective source is
-- unavailable, omit the whole tuple: its digest must not describe unseen rows.
create function public.stage_contributor_summary(p_unit uuid) returns table(stage text,work_date date,profile_id uuid,digest text)
language sql stable security definer set search_path=public,pg_temp as $$
  select distinct r.stage,r.work_date,p.profile_id,public._stage_contributor_digest(r.unit_id,r.stage,r.work_date)
  from public.crew_work_record_people p
    join public.crew_work_records r on r.id=p.record_id
    join public.custom_work_units u on u.id=r.unit_id
  where r.unit_id=p_unit and p.voided_at is null and r.outcome in ('partial','finished')
    and public.custom_work_internal() and not public.is_partner_user()
    and exists(select 1 from public.projects pu where pu.id=u.project_id and pu.deleted_at is null)
    and public._ai_job_visible(u.project_id,auth.uid())
    and exists(select 1 from public.projects pr where pr.id=r.project_id and pr.deleted_at is null)
    and public._ai_job_visible(r.project_id,auth.uid())
    and public._stage_contributor_sources_visible(r.unit_id,r.stage,r.work_date)
$$;
revoke all on function public.stage_contributor_summary(uuid) from public,anon;
grant execute on function public.stage_contributor_summary(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. record_stage_contributors: the compact Work-screen action. One stable
--    saved unit or one mapped opening, a canonical stage/date, people, and
--    an optional note. Dedupes against every effective matching report, not
--    just this request's own receipt, so overlapping submissions only ever
--    add who is actually new.
-- ---------------------------------------------------------------------------
create function public.record_stage_contributors(p_id uuid,p_data jsonb) returns uuid
language plpgsql security definer set search_path=public,pg_temp as $$
declare
  uid uuid:=auth.uid(); receipt public.custom_work_commands;
  v_unit_id uuid; v_opening_id uuid; opening public.project_openings; unit_row public.custom_work_units;
  job_id uuid; v_stage text; work_day date; outcome text; description text;
  people uuid[]; person uuid; existing_people uuid[]; new_people uuid[];
  plan jsonb; norm_payload jsonb;
begin
  if not public.custom_work_internal() or not public._is_lead(uid) then
    raise exception 'Only an active foreman, supervisor or owner can record crew contributors.' using errcode='42501';
  end if;
  if p_id is null or p_data is null or jsonb_typeof(p_data)<>'object' then raise exception 'Invalid contributor record.'; end if;

  v_unit_id:=nullif(p_data->>'unit_id','')::uuid;
  v_opening_id:=nullif(p_data->>'opening_id','')::uuid;
  if (v_unit_id is not null)=(v_opening_id is not null) then raise exception 'Choose exactly one saved unit or mapped opening.'; end if;

  v_stage:=p_data->>'stage';
  if v_stage is null or v_stage not in ('RO checked','Installing','Preparation','Flashing','Setting frame','Glazing','Hardware','Detail work','Rework') then
    raise exception 'Choose the work stage.';
  end if;
  work_day:=(p_data->>'work_date')::date;
  if work_day is null or work_day<date '2000-01-01' or work_day>(now() at time zone 'America/Denver')::date then
    raise exception 'Choose a valid work date, not in the future.';
  end if;
  outcome:=p_data->>'outcome';
  if outcome is null or outcome not in ('partial','finished') then raise exception 'Choose partial or stage complete.'; end if;
  description:=coalesce(p_data->>'description','');
  if length(description)>4000 then raise exception 'Keep the description under 4000 characters.'; end if;
  if jsonb_typeof(p_data->'people') is distinct from 'array' or jsonb_array_length(p_data->'people') not between 1 and 100 then
    raise exception 'Select the people who worked.';
  end if;
  select array_agg(distinct value::uuid order by value::uuid) into people from jsonb_array_elements_text(p_data->'people');

  -- Normalized fingerprint: sorted/deduped people, so a resend of this exact
  -- request id with the same people in a different order still matches.
  norm_payload:=jsonb_build_object('action','stage_contributors','data',p_data||jsonb_build_object('people',to_jsonb(people)));

  -- Same namespace as custom_work_command/record_crew_work's own receipt
  -- lock (7282): every route keyed by a custom_work_commands id must
  -- serialize against every other, or two different actions sharing one
  -- request id could both pass the "not found yet" check at once.
  perform pg_advisory_xact_lock(hashtextextended(p_id::text,7282));
  select * into receipt from public.custom_work_commands where id=p_id;
  if found then
    if receipt.profile_id<>uid or receipt.payload<>norm_payload then raise exception 'This retry belongs to a different request.'; end if;
    return receipt.result_id;
  end if;
  perform pg_advisory_xact_lock(hashtextextended(uid::text,7281));

  -- Resolve the job server-side from the reference; the caller never names it.
  if v_unit_id is not null then
    select project_id into job_id from public.custom_work_units where id=v_unit_id;
    if job_id is null then raise exception 'Choose a saved unit on a job.'; end if;
  else
    select * into opening from public.project_openings where id=v_opening_id and removed_at is null;
    if opening.id is null then raise exception 'This opening is not available.'; end if;
    job_id:=opening.project_id;
  end if;
  if not exists(select 1 from public.projects where id=job_id and deleted_at is null) or not public._ai_job_visible(job_id,uid) then
    raise exception 'This job is unavailable.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(job_id::text,7285));
  perform pg_advisory_xact_lock(hashtextextended(coalesce(v_unit_id,v_opening_id)::text,7296));

  if v_unit_id is not null then
    select * into unit_row from public.custom_work_units where id=v_unit_id for update;
    if unit_row.id is null then raise exception 'Choose a saved unit on a job.'; end if;
  else
    select * into unit_row from public.custom_work_units where opening_id=opening.id for update;
    if unit_row.id is null then
      plan:=public._ai_plan_facts(opening.id);
      insert into public.custom_work_units(id,project_id,opening_id,created_by,label,type_label,facts)
      values(gen_random_uuid(),job_id,opening.id,uid,opening.opening_code,coalesce(plan->>'type_label','Unknown'),public._ai_plan_seed(plan))
      on conflict (opening_id) where opening_id is not null do nothing;
      select * into unit_row from public.custom_work_units where opening_id=opening.id for update;
      if unit_row.id is null then raise exception 'Could not create a unit for this opening.'; end if;
    end if;
  end if;

  -- Revalidate identity under the lock (Astra review): the job/opening
  -- checked above was read before this transaction held the unit row. A
  -- concurrent move or removal between that read and this lock is refused,
  -- never silently trusted from a moment earlier. Applies to both the
  -- existing-unit and the just-resolved-opening path, and to an existing
  -- unit's linked opening being removed concurrently.
  if unit_row.project_id is distinct from job_id then
    raise exception 'This unit moved to a different job. Refresh and try again.';
  end if;
  if unit_row.opening_id is not null and not exists(
    select 1 from public.project_openings where id=unit_row.opening_id and removed_at is null and project_id=job_id
  ) then
    raise exception 'This opening is not available.';
  end if;

  foreach person in array people loop
    if person is null or not exists(
      select 1 from public.profiles where id=person and retired_at is null and access_revoked_at is null
        and not coalesce(is_partner,false) and role in ('installer','foreman','supervisor','owner')
        and is_test=public.is_test_profile(uid)
    ) or not public._ai_job_visible(job_id,person) then
      raise exception 'Choose Forge crew members with current access to this job.';
    end if;
  end loop;

  -- The unit and project locks are held before checking historical sources;
  -- a saved digest or an accessible current job grants no access to old jobs.
  if not public._stage_contributor_sources_visible(unit_row.id,v_stage,work_day) then
    raise exception 'Some earlier records for this work are unavailable. Ask a supervisor to review them.' using errcode='42501';
  end if;

  -- Semantic dedupe against every EFFECTIVE report for this exact tuple, not
  -- merely this request: same/fresh id, reordered or overlapping submissions
  -- all land on the same "who is actually new" answer.
  select coalesce(array_agg(distinct p.profile_id),'{}') into existing_people
  from public.crew_work_record_people p join public.crew_work_records r on r.id=p.record_id
  where r.unit_id=unit_row.id and r.stage=v_stage and r.work_date=work_day and p.voided_at is null and r.outcome in ('partial','finished');
  select coalesce(array_agg(x),'{}') into new_people from unnest(people) x where not (x=any(existing_people));

  if array_length(new_people,1) is not null then
    update public.custom_work_units set untimed_work_present=true where id=unit_row.id;
    insert into public.crew_work_records(id,project_id,unit_id,filed_by,work_date,stage,outcome,whole_complete,description)
    values(p_id,job_id,unit_row.id,uid,work_day,v_stage,outcome,false,description);
    insert into public.crew_work_record_people(record_id,profile_id) select p_id,unnest(new_people);
    insert into public.custom_work_history(project_id,actor_id,entity_id,action,after_value,reason)
    values(job_id,uid,unit_row.id,'stage_contributors',
      jsonb_build_object('record_id',p_id,'people',new_people,'requested',people,'work_date',work_day,'stage',v_stage,'outcome',outcome),
      'Foreman contributor record; no payroll changes');
  end if;

  insert into public.custom_work_commands(id,profile_id,payload,result_id) values(p_id,uid,norm_payload,unit_row.id);
  return unit_row.id;
end; $$;
revoke all on function public.record_stage_contributors(uuid,jsonb) from public,anon;
grant execute on function public.record_stage_contributors(uuid,jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. correct_stage_contributors: void an effective tuple's source links and,
--    in the same transaction, append replacement report evidence. Never a
--    silent destructive edit — a bounded reason is required, and a stale
--    digest (the tuple moved since the screen loaded) is refused.
-- ---------------------------------------------------------------------------
create function public.correct_stage_contributors(p_id uuid,p_data jsonb) returns uuid
language plpgsql security definer set search_path=public,pg_temp as $$
declare
  uid uuid:=auth.uid(); receipt public.custom_work_commands; unit_row public.custom_work_units;
  job_id uuid; v_stage text; work_day date; reason text; expected text; current_digest text;
  remove_ids uuid[]; add_ids uuid[]; person uuid; voided_ids uuid[]:='{}'; added_ids uuid[]:='{}';
  outcome text; description text; existing_people uuid[]; norm_payload jsonb;
begin
  if not public.custom_work_internal() or not public._is_lead(uid) then
    raise exception 'Only an active foreman, supervisor or owner can correct crew contributors.' using errcode='42501';
  end if;
  if p_id is null or p_data is null or jsonb_typeof(p_data)<>'object' then raise exception 'Invalid correction.'; end if;

  reason:=btrim(coalesce(p_data->>'reason',''));
  if length(reason) not between 1 and 500 then raise exception 'Enter a short reason for this correction.'; end if;
  v_stage:=p_data->>'stage';
  if v_stage is null or v_stage not in ('RO checked','Installing','Preparation','Flashing','Setting frame','Glazing','Hardware','Detail work','Rework') then
    raise exception 'Choose the work stage.';
  end if;
  work_day:=(p_data->>'work_date')::date;
  if work_day is null then raise exception 'Choose the work date being corrected.'; end if;
  expected:=p_data->>'expected_digest';
  if expected is null then raise exception 'This correction needs the summary you reviewed.'; end if;
  if jsonb_typeof(p_data->'remove')<>'array' then remove_ids:='{}'; else
    select coalesce(array_agg(distinct value::uuid order by value::uuid),'{}') into remove_ids from jsonb_array_elements_text(p_data->'remove');
  end if;
  if jsonb_typeof(p_data->'add')<>'array' then add_ids:='{}'; else
    select coalesce(array_agg(distinct value::uuid order by value::uuid),'{}') into add_ids from jsonb_array_elements_text(p_data->'add');
  end if;
  if coalesce(array_length(remove_ids,1),0)>100 or coalesce(array_length(add_ids,1),0)>100 then
    raise exception 'Correct up to 100 people at a time.';
  end if;
  if coalesce(array_length(remove_ids,1),0)=0 and coalesce(array_length(add_ids,1),0)=0 then
    raise exception 'Choose who to remove or add.';
  end if;
  outcome:=p_data->>'outcome';
  description:=coalesce(p_data->>'description','');
  if length(description)>4000 then raise exception 'Keep the description under 4000 characters.'; end if;
  if array_length(add_ids,1) is not null then
    if outcome is null or outcome not in ('partial','finished') then
      raise exception 'Choose partial or stage complete for the people being added.';
    end if;
    -- Same finite range as record_stage_contributors; a removal-only
    -- correction skips this so it can still clean up old invalid evidence.
    if work_day<date '2000-01-01' or work_day>(now() at time zone 'America/Denver')::date then
      raise exception 'Choose a valid work date, not in the future.';
    end if;
  end if;

  -- Normalized fingerprint: the (already sorted/deduped) remove/add arrays,
  -- so a resend of this exact request id matches regardless of input order.
  norm_payload:=jsonb_build_object('action','correct_stage_contributors','data',
    p_data||jsonb_build_object('remove',to_jsonb(remove_ids),'add',to_jsonb(add_ids)));
  -- Same shared receipt namespace as every other custom_work_commands route
  -- (crew_record/stage_contributors/custom_work_command): every route keyed
  -- by a request id must serialize against every other.
  perform pg_advisory_xact_lock(hashtextextended(p_id::text,7282));
  select * into receipt from public.custom_work_commands where id=p_id;
  if found then
    if receipt.profile_id<>uid or receipt.payload<>norm_payload then raise exception 'This retry belongs to a different request.'; end if;
    return receipt.result_id;
  end if;
  perform pg_advisory_xact_lock(hashtextextended(uid::text,7281));

  select u.* into unit_row from public.custom_work_units u where u.id=(p_data->>'unit_id')::uuid;
  if unit_row.id is null or unit_row.project_id is null then raise exception 'Choose a saved unit on a job.'; end if;
  job_id:=unit_row.project_id;
  if not exists(select 1 from public.projects where id=job_id and deleted_at is null) or not public._ai_job_visible(job_id,uid) then
    raise exception 'This job is unavailable.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(job_id::text,7285));
  perform pg_advisory_xact_lock(hashtextextended(unit_row.id::text,7296));
  select * into unit_row from public.custom_work_units where id=unit_row.id for update;

  -- Revalidate identity under the lock (Astra review): job_id above was read
  -- before this transaction held the unit row. Re-derive authority from what
  -- is actually locked, and refuse rather than trust a moment-old read.
  if unit_row.project_id is distinct from job_id then
    raise exception 'This unit moved to a different job. Refresh and try again.';
  end if;
  if unit_row.opening_id is not null and not exists(
    select 1 from public.project_openings where id=unit_row.opening_id and removed_at is null and project_id=job_id
  ) then
    raise exception 'This opening is not available.';
  end if;

  if not public._stage_contributor_sources_visible(unit_row.id,v_stage,work_day) then
    raise exception 'Some earlier records for this work are unavailable. Ask a supervisor to review them.' using errcode='42501';
  end if;

  -- Recomputed under the mutation locks: a tuple that moved between
  -- loading the summary and submitting the correction is refused, not guessed.
  current_digest:=public._stage_contributor_digest(unit_row.id,v_stage,work_day);
  if current_digest is distinct from expected then
    raise exception 'This contributor summary changed since you loaded it. Review it again before correcting.' using errcode='40001';
  end if;

  if array_length(remove_ids,1) is not null then
    foreach person in array remove_ids loop
      with voided as (
        update public.crew_work_record_people p set voided_at=now(),voided_by=uid,void_reason=reason
        from public.crew_work_records r
        where r.id=p.record_id and r.unit_id=unit_row.id and r.stage=v_stage and r.work_date=work_day
          and r.outcome in ('partial','finished') and p.profile_id=person and p.voided_at is null
        returning p.record_id
      )
      select voided_ids||coalesce(array_agg(record_id),'{}') into voided_ids from voided;
    end loop;
  end if;

  if array_length(add_ids,1) is not null then
    select coalesce(array_agg(distinct p.profile_id),'{}') into existing_people
    from public.crew_work_record_people p join public.crew_work_records r on r.id=p.record_id
    where r.unit_id=unit_row.id and r.stage=v_stage and r.work_date=work_day and p.voided_at is null and r.outcome in ('partial','finished');
    foreach person in array add_ids loop
      if person=any(existing_people) then continue; end if;
      if not exists(
        select 1 from public.profiles where id=person and retired_at is null and access_revoked_at is null
          and not coalesce(is_partner,false) and role in ('installer','foreman','supervisor','owner')
          and is_test=public.is_test_profile(uid)
      ) or not public._ai_job_visible(job_id,person) then
        raise exception 'Choose Forge crew members with current access to this job.';
      end if;
      added_ids:=added_ids||person;
    end loop;
    if array_length(added_ids,1) is not null then
      update public.custom_work_units set untimed_work_present=true where id=unit_row.id;
      insert into public.crew_work_records(id,project_id,unit_id,filed_by,work_date,stage,outcome,whole_complete,description)
      values(p_id,job_id,unit_row.id,uid,work_day,v_stage,outcome,false,description);
      insert into public.crew_work_record_people(record_id,profile_id) select p_id,unnest(added_ids);
    end if;
  end if;

  -- request_id is recorded even remove-only, so every correction — whether
  -- or not it also added a replacement report — traces to the exact request.
  insert into public.custom_work_history(project_id,actor_id,entity_id,action,before_value,after_value,reason)
  values(job_id,uid,unit_row.id,'stage_contributor_correction',
    jsonb_build_object('request_id',p_id,'stage',v_stage,'work_date',work_day,'voided_source_records',voided_ids,'digest_before',current_digest),
    jsonb_build_object('request_id',p_id,'removed',remove_ids,'added',added_ids,'new_record_id',case when array_length(added_ids,1) is not null then p_id end,
      'digest_after',public._stage_contributor_digest(unit_row.id,v_stage,work_day)),
    reason);

  insert into public.custom_work_commands(id,profile_id,payload,result_id) values(p_id,uid,norm_payload,unit_row.id);
  return unit_row.id;
end; $$;
revoke all on function public.correct_stage_contributors(uuid,jsonb) from public,anon;
grant execute on function public.correct_stage_contributors(uuid,jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Harden record_crew_work: restated verbatim from 20261024000000 with two
--    additions so the manual/full-edit route cannot see or attribute across a
--    sandbox/test boundary that crew_work_record_people (no direct project_id
--    column, so attach_sandbox_guards() cannot trace and trigger-guard it)
--    does not otherwise enforce. Intentional assignment/full-edit/completion
--    behavior is unchanged.
-- ---------------------------------------------------------------------------
create or replace function public.record_crew_work(p_id uuid,p_data jsonb) returns uuid
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
  if not exists(select 1 from public.projects where id=job_id and deleted_at is null) or not public._ai_job_visible(job_id,uid) then
    raise exception 'This job is unavailable.';
  end if;
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
    if person is null or not exists(
      select 1 from public.profiles where id=person and retired_at is null and access_revoked_at is null and not coalesce(is_partner,false) and role in ('installer','foreman','supervisor','owner')
        and is_test=public.is_test_profile(uid)
    ) or not public._ai_job_visible(job_id,person) then
      raise exception 'Choose Forge crew members with current access to this job.';
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

insert into public.app_release_notes(id,published_on,audience,kind,title_en,title_es,body_en,body_es,href)
values ('2026-09-30-unit-contributors','2026-09-30',array[1,2,3],'improvement',
'Add contributors to a unit from Work','Agregar colaboradores a una unidad desde Trabajo',
'On Work, add a quick contributor note for a saved unit or map opening: who worked an RO check, flashing or another stage, even off the clock. This never starts a timer, approves QC or marks an install complete, and a correction keeps the original note visible.',
'En Trabajo, agrega una nota rápida de colaboradores para una unidad guardada o una apertura del mapa: quién hizo una revisión de RO, el sellado u otra etapa, incluso fuera de turno. Esto nunca inicia un temporizador, aprueba control de calidad ni marca una instalación como completa, y una corrección mantiene visible la nota original.',
'/work');
commit;
