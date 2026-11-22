-- One revisioned shared schedule per Forge project.
create table public.installer_job_plans (
  project_id uuid primary key references public.projects(id) on delete cascade,
  revision integer not null default 0,
  published jsonb not null default '[]',
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id)
);

alter table public.installer_job_plans enable row level security;
revoke all on public.installer_job_plans from public, anon, authenticated;

create function public._installer_plan_access(p_project_id uuid, p_manage boolean)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select public.custom_work_internal()
    and exists (
      select 1 from public.profiles actor
      join public.projects job on job.id = p_project_id
      where actor.id = auth.uid()
        and (not p_manage or actor.role in ('foreman', 'supervisor', 'owner'))
        and job.deleted_at is null
        and (not job.is_test or public._is_supervisor(actor.id)
          or (public.is_test_profile(actor.id) and public.is_sandbox_project(job.id)))
        and (not public.is_test_profile(actor.id)
          or (job.is_test and public.is_sandbox_project(job.id)))
    );
$$;
revoke all on function public._installer_plan_access(uuid, boolean) from public, anon, authenticated;

create function public.get_installer_plan(p_project_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare plan public.installer_job_plans;
begin
  if not coalesce(public._installer_plan_access(p_project_id, true), false) then
    raise exception 'You cannot manage this job plan.' using errcode = '42501';
  end if;
  select * into plan from public.installer_job_plans where project_id = p_project_id;
  return jsonb_build_object('revision', coalesce(plan.revision, 0),
    'blocks', coalesce(plan.published, '[]'::jsonb));
end;
$$;

create function public.save_installer_plan(p_project_id uuid, p_revision integer, p_blocks jsonb)
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
        and p.role = 'installer' and p.retired_at is null and p.access_revoked_at is null
        and not coalesce(p.is_partner, false) and p.is_test = job_is_test
        and (p.active or job_is_test))
        and not coalesce(previous_block->'installerIds' ? person, false) then
        raise exception 'Choose an available installer for this job.' using errcode = '22023';
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

revoke all on function public.get_installer_plan(uuid),
  public.save_installer_plan(uuid, integer, jsonb) from public, anon;
grant execute on function public.get_installer_plan(uuid),
  public.save_installer_plan(uuid, integer, jsonb) to authenticated;

-- A QA test login may only write on a sandbox job; arm that fence for the
-- table this file adds (scripts/test_sandbox_guard.py requires it here, in the
-- declaring migration). Idempotent, so 20261130180000 can run it again for
-- databases that applied this file before the line was added.
select public.attach_sandbox_guards();
