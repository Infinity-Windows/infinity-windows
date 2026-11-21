-- Derive the current queue from the published Plan and recorded unit completion.
create or replace function public.get_my_installer_plan_window(p_start date, p_end date)
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
      with roster as materialized (
        select block, position
        from jsonb_array_elements(case when public._installer_plan_access(job.id, false)
          then public.get_published_installer_plan(job.id) else '[]'::jsonb end)
          with ordinality as items(block, position)
        where block->>'start' <= p_end::text
      ), carried as (
        select old.position, old.block || jsonb_build_object(
          'carriedFrom', old.block->>'end', 'start', p_start, 'end', p_start,
          'openingIds', remaining.ids
        ) as block
        from roster old
        cross join lateral (
          select jsonb_agg(o.id order by ids.priority) as ids
          from jsonb_array_elements_text(old.block->'openingIds') with ordinality ids(id, priority)
          join public.project_openings o on o.id::text = ids.id and o.project_id = job.id and o.removed_at is null
          where not exists (
            select 1 from roster current_block
            where current_block.block->>'kind' = 'unit'
              and current_block.block->>'activity' = old.block->>'activity'
              and current_block.block->>'start' <= p_start::text
              and (current_block.block->>'end' >= p_start::text
                or (current_block.block->>'end', -current_block.position) >
                   (old.block->>'end', -old.position))
              and current_block.block->'openingIds' ? ids.id
          )
          and (
            select s.outcome
            from public.custom_work_units u
            join public.custom_work_sessions s on s.unit_id = u.id and s.project_id = job.id
            where u.project_id = job.id and u.opening_id = o.id
              and s.stage = old.block->>'activity' and s.outcome in ('finished', 'rework')
              and s.ended_at is not null
            order by s.ended_at desc, s.id desc limit 1
          ) is distinct from 'finished'
        ) remaining
        where old.block->>'kind' = 'unit' and old.block->>'end' < p_start::text
          and remaining.ids is not null
      ), assigned as materialized (
        select block, position from roster where block->>'end' >= p_start::text
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
