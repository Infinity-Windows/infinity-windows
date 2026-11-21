-- Completion uses the opening's full schedule, including work assigned to
-- other installers. Return only the dates, activities and openings it needs.
create function public.get_workday_unit_schedule(p_project_id uuid, p_opening_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not coalesce(public._installer_plan_access(p_project_id, false), false) then
    raise exception 'You cannot view this installer plan.' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', block->'id', 'kind', block->'kind', 'activity', block->'activity',
      'openingIds', jsonb_build_array(p_opening_id), 'start', block->'start', 'end', block->'end',
      'startMinute', block->'startMinute', 'endMinute', block->'endMinute',
      'startPeriod', block->'startPeriod', 'endPeriod', block->'endPeriod'
    ) order by position)
    from public.installer_job_plans plan
    cross join lateral jsonb_array_elements(plan.published) with ordinality as items(block, position)
    where plan.project_id = p_project_id and block->>'kind' = 'unit'
      and block->'openingIds' ? p_opening_id::text
  ), '[]'::jsonb);
end;
$$;
revoke all on function public.get_workday_unit_schedule(uuid, uuid) from public, anon;
grant execute on function public.get_workday_unit_schedule(uuid, uuid) to authenticated;
