-- Carried plan work keeps the hours it was planned for.
--
-- Unfinished unit work from an earlier day is carried onto the current work
-- day. Until now the carry also rewrote its hours to 7:00-12:00, so an
-- installer's Upcoming work showed every carried card as "AM" whatever the
-- foreman planned (Matt, 2026-11-20: "end time shouldn't adjust with
-- carryover"). Only the day moves now. The hours are read the way the app
-- reads them (jobPlan.ts planBoundary): the saved minute, else the legacy
-- AM/PM period. A card that ran overnight can end before it starts once it is
-- one day long; that one runs to its daily cutoff, else the end of the plan
-- day (19:00). The app's currentPlanBlocks makes the same choice.
--
-- Only the carried hours change; access, the window check and which units
-- carry are as 20261130080000 left them.

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
          'start', work_day, 'end', work_day,
          'startMinute', hours.start_minute,
          'endMinute', case when hours.end_minute > hours.start_minute then hours.end_minute
            else coalesce((old.block->>'dailyEndMinute')::int, 1140) end,
          'openingIds', remaining.ids
        ) as block
        from roster old
        cross join lateral (
          select
            coalesce((old.block->>'startMinute')::int,
              case when old.block->>'startPeriod' = 'PM' then 720 else 420 end) as start_minute,
            coalesce((old.block->>'endMinute')::int,
              case when old.block->>'endPeriod' = 'AM' then 720 else 1140 end) as end_minute
        ) hours
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
