-- An installer takes lead on a planned unit activity from Workday.
--
-- The lead lives in the Plan (a block's openingCrew), where the foreman sets
-- it. Only a foreman or above can save the Plan, so Workday's "Take lead" was
-- kept on the phone and nobody else saw it. This is the one change to the Plan
-- an installer may make: themselves as lead, on one unit, for one activity.
-- Taking lead is allowed over any assignment (Matt, 2026-11-20). The person
-- who was lead stays on the unit as crew, so the unit does not drop out of
-- their Workday. Every change is kept, so a unit's leads have a history.
create table public.plan_unit_lead_changes (
  id uuid primary key,
  project_id uuid not null references public.projects(id) on delete cascade,
  opening_id uuid not null references public.project_openings(id) on delete cascade,
  activity text not null,
  block_id text not null,
  lead_id uuid not null,
  previous_lead_id uuid,
  changed_at timestamptz not null default clock_timestamp()
);
create index plan_unit_lead_changes_lookup
  on public.plan_unit_lead_changes (project_id, opening_id, activity, changed_at desc);
alter table public.plan_unit_lead_changes enable row level security;
revoke all on public.plan_unit_lead_changes from public, anon, authenticated;

create function public.take_plan_unit_lead(p_id uuid, p_data jsonb)
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
  -- The Plan only ever names installers as lead or crew (save_installer_plan).
  if actor is null or not coalesce(public._installer_plan_access(job, false), false)
      or not exists (select 1 from public.profiles p where p.id = actor and p.role = 'installer'
        and p.retired_at is null and p.access_revoked_at is null) then
    raise exception 'Only an installer on this job can take lead.' using errcode = '42501';
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

revoke all on function public.take_plan_unit_lead(uuid, jsonb) from public, anon;
grant execute on function public.take_plan_unit_lead(uuid, jsonb) to authenticated;
