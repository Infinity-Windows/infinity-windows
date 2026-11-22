-- Machinery time on any Workday activity, not only unit work.
--
-- save_workday_activity (20261130030000) took the machinery switch only when
-- the session had a unit, so on a general activity (Staging, Setup, Travel)
-- the tap was accepted and silently dropped. Matt, 2026-11-20: "the operating
-- machinery is supposed to always be there." The function is the same as
-- before except that the machinery branch no longer asks for a unit.
-- "Mark done" still belongs to unit work only.
create or replace function public.save_workday_activity(p_id uuid, p_data jsonb)
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

  if p_data ? 'machinery_running' and (entry.ended_at is null or tap <= entry.ended_at) and
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
