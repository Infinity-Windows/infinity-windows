-- Activity metadata is independent of the paid punch and can replay after it.
alter table public.custom_work_sessions
  add column workday_machinery_ms bigint not null default 0,
  add column workday_machinery_started_at timestamptz,
  add column workday_machinery_changed_at timestamptz,
  add column workday_done_at timestamptz,
  add column workday_note_changed_at timestamptz;

create function public._workday_close_session() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if new.workday_machinery_started_at is not null and new.ended_at is not null then
    new.workday_machinery_ms := new.workday_machinery_ms +
      greatest(0, floor(extract(epoch from new.ended_at - new.workday_machinery_started_at) * 1000)::bigint);
    new.workday_machinery_started_at := null;
  end if;
  if new.ended_at is not null and new.workday_done_at is not null
    and new.outcome is distinct from 'rework' then
    new.outcome := 'finished';
  end if;
  return new;
end;
$$;

create trigger workday_close_session before update of ended_at, workday_done_at, workday_machinery_started_at
on public.custom_work_sessions for each row execute function public._workday_close_session();

create function public.save_workday_activity(p_id uuid, p_data jsonb)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare
  actor uuid := auth.uid();
  entry public.custom_work_sessions;
  target uuid := (p_data->>'id')::uuid;
  tap timestamptz := (p_data->>'at')::timestamptz;
  elapsed bigint;
  running_since timestamptz;
begin
  if not coalesce(public.custom_work_internal(), false) or actor is null then
    raise exception 'Sign in to update your work.' using errcode = '42501';
  end if;
  select * into entry from public.custom_work_sessions where id = target and profile_id = actor for update;
  if not found or (entry.project_id is not null and not coalesce(public._installer_plan_access(entry.project_id, false), false)) then
    raise exception 'That work session is unavailable.' using errcode = '42501';
  end if;
  if tap is null or tap < entry.started_at or tap > now() + interval '2 minutes' then
    raise exception 'Check the device clock before updating work.';
  end if;

  if p_data ? 'machinery_running' and entry.unit_id is not null and (entry.ended_at is null or tap <= entry.ended_at) and
     (entry.workday_machinery_changed_at is null or tap > entry.workday_machinery_changed_at) then
    elapsed := greatest(0, least((p_data->>'machinery_ms')::bigint,
      floor(extract(epoch from least(tap, coalesce(entry.ended_at, tap)) - entry.started_at) * 1000)::bigint));
    running_since := case when (p_data->>'machinery_running')::boolean
      and (entry.ended_at is null or tap < entry.ended_at) then tap end;
    update public.custom_work_sessions set workday_machinery_ms = elapsed,
      workday_machinery_started_at = running_since, workday_machinery_changed_at = tap
      where id = target;
  elsif p_data->>'done' = 'true' and entry.unit_id is not null and entry.workday_done_at is null then
    update public.custom_work_sessions set workday_done_at = least(tap, coalesce(entry.ended_at, tap))
      where id = target;
  end if;
  if p_data ? 'note' and (entry.workday_note_changed_at is null or tap > entry.workday_note_changed_at) then
    update public.custom_work_sessions set
      description = case when entry.unit_id is not null then left(p_data->>'note', 8000)
        else split_part(entry.description, ' — ', 1) || ' — ' || left(p_data->>'note', 8000) end,
      workday_note_changed_at = tap
      where id = target;
  end if;
  return target;
end;
$$;
revoke all on function public.save_workday_activity(uuid, jsonb) from public, anon;
grant execute on function public.save_workday_activity(uuid, jsonb) to authenticated;

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
            select case when s.workday_done_at is not null and s.outcome is distinct from 'rework' then 'finished' else s.outcome end
            from public.custom_work_units u
            join public.custom_work_sessions s on s.unit_id = u.id and s.project_id = job.id
            where u.project_id = job.id and u.opening_id = o.id
              and s.stage = old.block->>'activity'
              and (s.workday_done_at is not null or (s.ended_at is not null and s.outcome in ('finished', 'rework')))
            order by coalesce(s.ended_at, s.workday_done_at) desc, s.id desc limit 1
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
