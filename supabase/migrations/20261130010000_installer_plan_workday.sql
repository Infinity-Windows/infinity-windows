-- Workday reads the caller's slice of the shared Plan, preserving unit priority.
create function public.get_published_installer_plan(p_project_id uuid, p_installer_id uuid default null)
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

create function public.get_my_installer_plan_window(p_start date, p_end date)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
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
      with assigned as materialized (
        select block, position
        from jsonb_array_elements(case when public._installer_plan_access(job.id, false)
          then public.get_published_installer_plan(job.id) else '[]'::jsonb end)
          with ordinality as items(block, position)
        where block->>'start' <= p_end::text and block->>'end' >= p_start::text
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
revoke all on function public.get_my_installer_plan_window(date, date) from public, anon;
grant execute on function public.get_my_installer_plan_window(date, date) to authenticated;
