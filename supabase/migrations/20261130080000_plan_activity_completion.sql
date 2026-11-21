-- Untimed activity completion from the job Plan. The opening id and activity
-- are the same pair used by Workday; no session or paid punch is fabricated.
create table public.plan_activity_done_marks (
  id uuid primary key,
  project_id uuid not null references public.projects(id) on delete cascade,
  opening_id uuid not null references public.project_openings(id) on delete cascade,
  activity text not null,
  marked_by uuid not null,
  done_at timestamptz not null default clock_timestamp()
);
create index plan_activity_done_lookup
  on public.plan_activity_done_marks (project_id, opening_id, activity, done_at desc);
alter table public.plan_activity_done_marks enable row level security;
revoke all on public.plan_activity_done_marks from public, anon, authenticated;

create function public.get_plan_activity_done(p_project_id uuid)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
begin
  if not coalesce(public._installer_plan_access(p_project_id, false), false) then
    raise exception 'You cannot view this job plan.' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(to_jsonb(latest))
    from (
      select distinct on (mark.opening_id, mark.activity) mark.opening_id, mark.activity, mark.done_at
      from public.plan_activity_done_marks mark
      where mark.project_id = p_project_id
      order by mark.opening_id, mark.activity, mark.done_at desc
    ) latest
  ), '[]'::jsonb);
end;
$$;

create function public.mark_plan_activity_done(p_id uuid, p_data jsonb)
returns uuid language plpgsql security definer set search_path = ''
as $$
declare
  job uuid := (p_data->>'project_id')::uuid;
  opening uuid := (p_data->>'opening_id')::uuid;
  stage text := p_data->>'activity';
  actor uuid := auth.uid();
  schedule jsonb;
  prior public.plan_activity_done_marks%rowtype;
begin
  if not coalesce(public._installer_plan_access(job, true), false) then
    raise exception 'You cannot manage this job plan.' using errcode = '42501';
  end if;
  if p_id is null or opening is null or nullif(btrim(stage), '') is null then
    raise exception 'Choose a scheduled unit activity.' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_id::text, 7282));
  select * into prior from public.plan_activity_done_marks where id = p_id;
  if found then
    if (prior.marked_by, prior.project_id, prior.opening_id, prior.activity)
        is distinct from (actor, job, opening, stage) then
      raise exception 'This retry belongs to a different activity.' using errcode = '22023';
    end if;
    return p_id;
  end if;
  select published into schedule from public.installer_job_plans where project_id = job for share;
  if not exists (select 1 from jsonb_array_elements(schedule) as blocks(block)
      where block->>'kind' = 'unit' and block->>'activity' = stage and block->'openingIds' ? opening::text)
      or not exists (select 1 from public.project_openings
        where id = opening and project_id = job and removed_at is null) then
    raise exception 'This unit activity is no longer scheduled.' using errcode = '22023';
  end if;
  insert into public.plan_activity_done_marks (id, project_id, opening_id, activity, marked_by)
  values (p_id, job, opening, stage, actor);
  return p_id;
end;
$$;

revoke all on function public.get_plan_activity_done(uuid), public.mark_plan_activity_done(uuid, jsonb) from public, anon;
grant execute on function public.get_plan_activity_done(uuid), public.mark_plan_activity_done(uuid, jsonb) to authenticated;

create function public._plan_activity_is_done(p_project uuid, p_opening uuid, p_stage text)
returns boolean language sql stable set search_path = ''
as $$
  select coalesce((
    select done from (
      select mark.done_at as happened, true as done
      from public.plan_activity_done_marks mark
      where mark.project_id = p_project and mark.opening_id = p_opening and mark.activity = p_stage
      union all
      select coalesce(s.ended_at, s.workday_done_at), s.outcome is distinct from 'rework'
      from public.custom_work_units u
      join public.custom_work_sessions s on s.unit_id = u.id and s.project_id = p_project
      where u.project_id = p_project and u.opening_id = p_opening and s.stage = p_stage
        and (s.workday_done_at is not null or (s.ended_at is not null and s.outcome in ('finished', 'rework')))
    ) events order by happened desc, done asc limit 1
  ), false);
$$;
revoke all on function public._plan_activity_is_done(uuid, uuid, text) from public, anon, authenticated;

-- Workday reads the caller's slice of the shared Plan, preserving unit priority.
create or replace function public.get_published_installer_plan(p_project_id uuid, p_installer_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  person text := coalesce(p_installer_id, auth.uid())::text;
begin
  if not coalesce(public._installer_plan_access(p_project_id, p_installer_id is not null and p_installer_id is distinct from auth.uid()), false) then
    raise exception 'You cannot view this installer plan.' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(
      (block - 'openingCrew') || jsonb_build_object(
        'installerIds', jsonb_build_array(person),
        'supersededOpeningIds', coalesce((
          select jsonb_agg(opening)
          from jsonb_array_elements_text(block->'openingIds') as ids(opening)
          where (block->>'unitCrewOnly' is distinct from 'true'
            or block->'openingCrew'->opening->>'leadId' = person
            or block->'openingCrew'->opening->'crewIds' ? person)
            and exists (
              select 1 from jsonb_array_elements(plan.published) as other(item)
              where item->>'id' <> block->>'id'
                and item->>'kind' = 'unit' and item->>'activity' = block->>'activity'
                and item->'openingIds' ? opening
                and (item->>'end', item->>'id') > (block->>'end', block->>'id')
            )
        ), '[]'::jsonb),
        'openingIds', case when block->>'unitCrewOnly' = 'true' then coalesce((
          select jsonb_agg(opening order by position)
          from jsonb_array_elements_text(block->'openingIds') with ordinality as ids(opening, position)
          where block->'openingCrew'->opening->>'leadId' = person
            or block->'openingCrew'->opening->'crewIds' ? person
        ), '[]'::jsonb) else block->'openingIds' end,
        'openingCrew', coalesce((
          select jsonb_object_agg(opening, roles)
          from jsonb_each(coalesce(block->'openingCrew', '{}')) as crew(opening, roles)
          where block->>'unitCrewOnly' is distinct from 'true'
            or roles->>'leadId' = person or roles->'crewIds' ? person
        ), '{}'::jsonb)
      ) order by position
    )
    from public.installer_job_plans plan
    cross join lateral jsonb_array_elements(plan.published) with ordinality as items(block, position)
    where plan.project_id = p_project_id and block->'installerIds' ? person
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.get_published_installer_plan(uuid, uuid) from public, anon;
grant execute on function public.get_published_installer_plan(uuid, uuid) to authenticated;

create or replace function public.get_my_installer_plan_window(p_start date, p_end date)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  work_day date := case when extract(isodow from p_start) = 7 then p_start + 1 else p_start end;
begin
  if not coalesce(public.custom_work_internal(), false) then
    raise exception 'You cannot view this installer plan.' using errcode = '42501';
  end if;
  if p_start is null or p_end is null or p_end < p_start or p_end - p_start > 13 then
    raise exception 'Choose a schedule window of up to 14 days.' using errcode = '22023';
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'projectId', job.id, 'jobCode', job.job_code, 'jobName', job.name,
      'blocks', entries.blocks, 'unitLabels', entries.labels
    ) order by job.job_code, job.id)
    from public.installer_job_plans plan
    join public.projects job on job.id = plan.project_id
    cross join lateral (
      with roster as materialized (
        select block, position
        from jsonb_array_elements(case when public._installer_plan_access(job.id, false)
          then public.get_published_installer_plan(job.id) else '[]'::jsonb end)
          with ordinality as items(block, position)
        where block->>'start' <= p_end::text
      ), carried as (
        select old.position, old.block || jsonb_build_object(
          'start', work_day, 'end', work_day, 'startMinute', 420, 'endMinute', 720,
          'openingIds', remaining.ids
        ) as block
        from roster old
        cross join lateral (
          select jsonb_agg(o.id order by ids.priority) as ids
          from jsonb_array_elements_text(old.block->'openingIds') with ordinality ids(id, priority)
          join public.project_openings o on o.id::text = ids.id and o.project_id = job.id and o.removed_at is null
          where not (coalesce(old.block->'supersededOpeningIds', '[]'::jsonb) ? ids.id)
            and not public._plan_activity_is_done(job.id, o.id, old.block->>'activity')
        ) remaining
        where old.block->>'kind' = 'unit' and old.block->>'end' < work_day::text
          and work_day <= p_end
          and remaining.ids is not null
      ), assigned as materialized (
        select block, position from roster where block->>'end' >= p_start::text
          and not exists (select 1 from carried where carried.position = roster.position)
        union all
        select block, position from carried
      )
      select jsonb_agg(block order by block->>'start', (block->>'startMinute')::int, position) as blocks,
        coalesce((
          select jsonb_object_agg(o.id, o.opening_code)
          from public.project_openings o
          where o.project_id = job.id and o.removed_at is null
            and exists (select 1 from assigned where block->'openingIds' ? o.id::text)
        ), '{}'::jsonb) as labels
      from assigned
    ) entries
    where entries.blocks is not null
  ), '[]'::jsonb);
end;
$$;
