-- Foremen do the same work as installers (Matt, 2026-11-21).
--
-- The Plan only let an installer be named as lead or crew, and only an
-- installer could take lead from the Workday. A foreman works units the same
-- way, so both rules now accept either role. Supervisors and owners are still
-- not offered: they plan the work, they are not scheduled onto it.
--
-- Both functions are restated in full with that one rule changed in each:
-- save_installer_plan from 20261130000000, take_plan_unit_lead from
-- 20261130110000. Their grants are unchanged (create or replace keeps them).

create or replace function public.save_installer_plan(p_project_id uuid, p_revision integer, p_blocks jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  block jsonb;
  opening text;
  person text;
  roles jsonb;
  job_is_test boolean;
  prior public.installer_job_plans;
  previous_block jsonb;
begin
  if not coalesce(public._installer_plan_access(p_project_id, true), false) then
    raise exception 'You cannot manage this job plan.' using errcode = '42501';
  end if;
  if p_blocks is null or jsonb_typeof(p_blocks) <> 'array' or pg_column_size(p_blocks) > 524288 then
    raise exception 'The plan is missing or too large.' using errcode = '22023';
  end if;
  if jsonb_array_length(p_blocks) <> (select count(distinct value->>'id') from jsonb_array_elements(p_blocks)) then
    raise exception 'Activity IDs must be unique.' using errcode = '22023';
  end if;
  select is_test into job_is_test from public.projects where id = p_project_id;
  insert into public.installer_job_plans(project_id) values (p_project_id) on conflict do nothing;
  select * into prior from public.installer_job_plans where project_id = p_project_id for update;
  if prior.revision is distinct from p_revision then
    raise exception 'Someone changed this plan. Try saving again.' using errcode = '40001';
  end if;

  for block in select value from jsonb_array_elements(p_blocks) loop
    select value into previous_block from jsonb_array_elements(prior.published)
      where value->>'id' = block->>'id';
    if block = previous_block then continue; end if;
    if jsonb_typeof(block) is distinct from 'object'
      or nullif(btrim(block->>'id'), '') is null
      or coalesce(block->>'kind', '') not in ('unit', 'general')
      or nullif(btrim(block->>'activity'), '') is null
      or coalesce(block->>'start', '') !~ '^\d{4}-\d{2}-\d{2}$'
      or coalesce(block->>'end', '') !~ '^\d{4}-\d{2}-\d{2}$'
      or (block->>'start')::date > (block->>'end')::date
      or extract(isodow from (block->>'start')::date) = 7
      or extract(isodow from (block->>'end')::date) = 7
      or (block ? 'dailyEndMinute' and coalesce((block->>'dailyEndMinute')::integer, -1) not between 421 and 1140)
      or coalesce((block->>'startMinute')::integer, -1) not between 420 and 1139
      or coalesce((block->>'endMinute')::integer, -1) not between 421 and 1140
      or (block->>'start' = block->>'end' and (block->>'startMinute')::integer >= (block->>'endMinute')::integer)
      or (block->>'kind' = 'unit' and block->'unitCrewOnly' is distinct from 'true'::jsonb)
      or jsonb_typeof(block->'openingIds') is distinct from 'array'
      or jsonb_typeof(block->'installerIds') is distinct from 'array'
      or (block ? 'openingCrew' and jsonb_typeof(block->'openingCrew') <> 'object')
      or (block->>'kind' = 'general' and (
        block->'openingIds' <> '[]'::jsonb or coalesce(block->'openingCrew', '{}'::jsonb) <> '{}'::jsonb
      ))
    then
      raise exception 'An activity has an invalid schedule or assignment.' using errcode = '22023';
    end if;
    for opening in select value from jsonb_array_elements_text(block->'openingIds') loop
      if not exists (select 1 from public.project_openings o
        where o.id = opening::uuid and o.project_id = p_project_id
        and (o.removed_at is null or previous_block->'openingIds' ? opening)) then
        raise exception 'An opening belongs to a different job or is unavailable.' using errcode = '22023';
      end if;
    end loop;
    for person in select value from jsonb_array_elements_text(block->'installerIds') loop
      if not exists (select 1 from public.profiles p where p.id = person::uuid
        and p.role in ('installer', 'foreman') and p.retired_at is null and p.access_revoked_at is null
        and not coalesce(p.is_partner, false) and p.is_test = job_is_test
        and (p.active or job_is_test))
        and not coalesce(previous_block->'installerIds' ? person, false) then
        raise exception 'Choose an available installer or foreman for this job.' using errcode = '22023';
      end if;
    end loop;
    for opening, roles in select key, value from jsonb_each(coalesce(block->'openingCrew', '{}')) loop
      if not (block->'openingIds' ? opening)
        or jsonb_typeof(roles) is distinct from 'object'
        or jsonb_typeof(roles->'crewIds') is distinct from 'array'
        or (roles ? 'leadId' and not (block->'installerIds' ? coalesce(roles->>'leadId', '')))
        or not ((block->'installerIds') @> (roles->'crewIds')) then
        raise exception 'Unit roles must match the activity crew and openings.' using errcode = '22023';
      end if;
    end loop;
  end loop;

  update public.installer_job_plans
    set published = p_blocks, revision = revision + 1, updated_at = now(), updated_by = auth.uid()
    where project_id = p_project_id;
  return public.get_installer_plan(p_project_id);
end;
$$;

create or replace function public.take_plan_unit_lead(p_id uuid, p_data jsonb)
returns uuid language plpgsql security definer set search_path = ''
as $$
declare
  job uuid := (p_data->>'project_id')::uuid;
  opening uuid := (p_data->>'opening_id')::uuid;
  stage text := p_data->>'activity';
  actor uuid := auth.uid();
  prior public.plan_unit_lead_changes%rowtype;
  schedule jsonb;
  target jsonb;
  slot integer;
  roles jsonb;
  previous text;
  crew jsonb;
begin
  -- The Plan names installers and foremen as lead or crew (save_installer_plan).
  if actor is null or not coalesce(public._installer_plan_access(job, false), false)
      or not exists (select 1 from public.profiles p where p.id = actor and p.role in ('installer', 'foreman')
        and p.retired_at is null and p.access_revoked_at is null) then
    raise exception 'Only an installer or foreman on this job can take lead.' using errcode = '42501';
  end if;
  if p_id is null or opening is null or nullif(btrim(stage), '') is null then
    raise exception 'Choose a scheduled unit activity.' using errcode = '22023';
  end if;
  -- A retry from the phone's queue is the same change, not a second one.
  perform pg_advisory_xact_lock(hashtextextended(p_id::text, 7283));
  select * into prior from public.plan_unit_lead_changes where id = p_id;
  if found then
    if (prior.lead_id, prior.project_id, prior.opening_id, prior.activity)
        is distinct from (actor, job, opening, stage) then
      raise exception 'This retry belongs to a different activity.' using errcode = '22023';
    end if;
    return p_id;
  end if;

  select published into schedule from public.installer_job_plans where project_id = job for update;
  -- The latest block for this activity that holds the unit: the one Workday
  -- and the Plan read the unit's lead from (lib/installerWorkflow/unitState.ts).
  select items.block, items.ord::integer into target, slot
    from jsonb_array_elements(coalesce(schedule, '[]'::jsonb)) with ordinality as items(block, ord)
    where items.block->>'kind' = 'unit' and items.block->>'activity' = stage
      and items.block->'openingIds' ? opening::text
    order by items.block->>'end' desc, items.block->>'id' desc limit 1;
  if target is null or not exists (select 1 from public.project_openings
      where id = opening and project_id = job and removed_at is null) then
    raise exception 'This unit activity is no longer scheduled.' using errcode = '22023';
  end if;

  roles := coalesce(target->'openingCrew'->(opening::text), '{}'::jsonb);
  previous := roles->>'leadId';
  if previous is distinct from actor::text then
    select coalesce(jsonb_agg(distinct member.id), '[]'::jsonb) into crew
      from (
        select jsonb_array_elements_text(coalesce(roles->'crewIds', '[]'::jsonb)) as id
        union all select previous where previous is not null
      ) member
      where member.id <> actor::text;
    target := jsonb_set(target, '{openingCrew}', coalesce(target->'openingCrew', '{}'::jsonb)
      || jsonb_build_object(opening::text, roles || jsonb_build_object('leadId', actor::text, 'crewIds', crew)));
    if not (target->'installerIds' ? actor::text) then
      target := jsonb_set(target, '{installerIds}', (target->'installerIds') || to_jsonb(actor::text));
    end if;
    -- The revision moves, so a foreman with this Plan open is told it changed
    -- when they save, instead of quietly putting the old lead back.
    update public.installer_job_plans
      set published = jsonb_set(published, array[(slot - 1)::text], target),
          revision = revision + 1, updated_at = now(), updated_by = actor
      where project_id = job;
  end if;

  insert into public.plan_unit_lead_changes (id, project_id, opening_id, activity, block_id, lead_id, previous_lead_id)
  values (p_id, job, opening, stage, target->>'id', actor, nullif(previous, '')::uuid);
  return p_id;
end;
$$;
