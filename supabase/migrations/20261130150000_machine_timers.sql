-- Machine timers: each time the machine is switched on and off is kept.
--
-- Until now an activity held one machinery total (workday_machinery_ms) and,
-- while the machine ran, the moment it was last switched on. The on and off
-- times themselves were thrown away, so a foreman reviewing the day could see
-- "0:04:00 of machinery" and nothing else, and could not fix a timer left
-- running. Matt, 2026-11-20: "On machinery affected activities, I do need the
-- machine timer(s) and access to edit the in and out on that", and "we'll
-- want the machine timers to be independent, so we can show multiple. but
-- group under the activity it was pressed during."
--
-- So each activity now carries its machine timers as a list, in the order they
-- were started:
--
--   workday_machinery_spans = [{"on": "<time>", "off": "<time>" | null}, ...]
--
-- Nothing about how Workday saves changes. save_workday_activity
-- (20261130120000) still switches the machine by setting or clearing
-- workday_machinery_started_at; the trigger below turns that into a timer
-- opening or closing. workday_machinery_ms stays the total every existing
-- reader uses.
--
-- Activities recorded before this migration have a total and no timers. They
-- are left that way: the times were never stored and inventing them would be
-- writing down something nobody recorded.

alter table public.custom_work_sessions
  add column if not exists workday_machinery_spans jsonb not null default '[]'::jsonb;

comment on column public.custom_work_sessions.workday_machinery_spans is
  'Machine timers on this activity, oldest first: [{"on": timestamptz, "off": timestamptz|null}]. '
  'Opened and closed by _workday_close_session as the machine is switched; '
  'replaced by correct_workday_machinery. Empty on activities recorded before 20261130150000.';

-- The same trigger as 20261130030000, which closes a running machine when the
-- activity ends, now also keeps the list of timers in step.
create or replace function public._workday_close_session() returns trigger
language plpgsql set search_path = public, pg_temp as $$
declare
  turned_off timestamptz;
  open_index int;
begin
  -- Switched on: a new timer opens at that moment.
  if new.workday_machinery_started_at is not null and old.workday_machinery_started_at is null then
    new.workday_machinery_spans := coalesce(new.workday_machinery_spans, '[]'::jsonb)
      || jsonb_build_array(jsonb_build_object('on', new.workday_machinery_started_at, 'off', null));
  end if;

  if new.workday_machinery_started_at is not null and new.ended_at is not null then
    -- The activity ended with the machine running: the machine stops with it.
    new.workday_machinery_ms := new.workday_machinery_ms +
      greatest(0, floor(extract(epoch from new.ended_at - new.workday_machinery_started_at) * 1000)::bigint);
    turned_off := new.ended_at;
    new.workday_machinery_started_at := null;
  elsif old.workday_machinery_started_at is not null and new.workday_machinery_started_at is null then
    -- Switched off by a tap. save_workday_activity stamps the tap in
    -- workday_machinery_changed_at in the same update.
    turned_off := coalesce(new.workday_machinery_changed_at, clock_timestamp());
  end if;

  if turned_off is not null then
    select max(item.position - 1) into open_index
    from jsonb_array_elements(coalesce(new.workday_machinery_spans, '[]'::jsonb)) with ordinality as item(span, position)
    where item.span->>'off' is null;
    if open_index is not null then
      -- Never earlier than it was switched on: a phone a little behind the
      -- server could otherwise close a timer before it opened.
      new.workday_machinery_spans := jsonb_set(new.workday_machinery_spans, array[open_index::text, 'off'],
        to_jsonb(greatest(turned_off, (new.workday_machinery_spans->open_index->>'on')::timestamptz)));
    end if;
  end if;

  if new.ended_at is not null and new.workday_done_at is not null
    and new.outcome is distinct from 'rework' then
    new.outcome := 'finished';
  end if;
  return new;
end;
$$;

-- A foreman corrects the machine timers on a finished activity: change an in
-- or an out, add a timer nobody started, remove one started by mistake. The
-- whole list is replaced, and the total follows from it.
--
-- Kept apart from custom_work_command's 'session' correction on purpose: that
-- function is several hundred lines guarding payroll-adjacent time, and this
-- change touches none of it. It writes the same audit row ('session', before
-- and after) so the correction shows in the activity's correction history, and
-- the same command receipt so a replayed save is answered, not repeated. It
-- does not bump the activity's revision: the two corrections are saved side by
-- side from one form, and a bump here would refuse the other.
create function public.correct_workday_machinery(p_id uuid, p_data jsonb)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare
  uid uuid := auth.uid();
  s public.custom_work_sessions;
  receipt public.custom_work_commands;
  before_value jsonb;
  item record;
  timers jsonb := '[]'::jsonb;
  total_ms bigint := 0;
  previous_off timestamptz;
  time_on timestamptz;
  time_off timestamptz;
begin
  if not coalesce(public.custom_work_internal(), false) or uid is null then
    raise exception 'Sign in to correct work.' using errcode = '42501';
  end if;
  select * into receipt from public.custom_work_commands where id = p_id;
  if found then
    if receipt.profile_id <> uid then
      raise exception 'That correction belongs to someone else.' using errcode = '42501';
    end if;
    return receipt.result_id;
  end if;

  select * into s from public.custom_work_sessions where id = (p_data->>'id')::uuid for update;
  -- Captured times are a foreman's to correct, as in the 'session' correction.
  if s.id is null or not public._is_lead(uid) then
    raise exception 'Only foremen and above can correct machine timers.' using errcode = '42501';
  end if;
  if s.project_id is not null and not exists (select 1 from public.projects where id = s.project_id and deleted_at is null) then
    raise exception 'That job is unavailable.';
  end if;
  if s.ended_at is null then
    raise exception 'Stop the activity before correcting its machine timers.';
  end if;
  if length(btrim(coalesce(p_data->>'reason', ''))) < 3 then
    raise exception 'Add a correction reason.';
  end if;
  if jsonb_typeof(p_data->'spans') is distinct from 'array' or jsonb_array_length(p_data->'spans') > 50 then
    raise exception 'Send the machine timers as a list.' using errcode = '22023';
  end if;

  for item in
    select span from jsonb_array_elements(p_data->'spans') as entry(span)
    order by (span->>'on')::timestamptz
  loop
    time_on := (item.span->>'on')::timestamptz;
    time_off := (item.span->>'off')::timestamptz;
    if time_on is null or time_off is null or time_off <= time_on then
      raise exception 'Each machine timer needs a start and a later end.' using errcode = '22023';
    end if;
    if time_on < s.started_at or time_off > s.ended_at then
      raise exception 'A machine timer must fall inside its activity.' using errcode = '22023';
    end if;
    -- One person runs one machine: two timers on the same activity cannot
    -- cover the same minutes, or the total could exceed the activity itself.
    if previous_off is not null and time_on < previous_off then
      raise exception 'Machine timers on one activity cannot overlap.' using errcode = '22023';
    end if;
    previous_off := time_off;
    timers := timers || jsonb_build_array(jsonb_build_object('on', time_on, 'off', time_off));
    total_ms := total_ms + floor(extract(epoch from time_off - time_on) * 1000)::bigint;
  end loop;

  before_value := to_jsonb(s);
  -- workday_machinery_changed_at moves to now so a machinery tap still waiting
  -- on a phone, made before this correction, cannot undo it
  -- (save_workday_activity ignores taps older than this).
  update public.custom_work_sessions
  set workday_machinery_spans = timers,
      workday_machinery_ms = total_ms,
      workday_machinery_changed_at = greatest(coalesce(workday_machinery_changed_at, clock_timestamp()), clock_timestamp())
  where id = s.id;

  insert into public.custom_work_history (project_id, actor_id, entity_id, action, before_value, after_value, reason)
  values (s.project_id, uid, s.id, 'session', before_value,
    (select to_jsonb(x) from public.custom_work_sessions x where x.id = s.id), btrim(p_data->>'reason'));
  insert into public.custom_work_commands (id, profile_id, payload, result_id)
  values (p_id, uid, jsonb_build_object('action', 'machinery_correction', 'data', p_data), s.id);
  return s.id;
end;
$$;
revoke all on function public.correct_workday_machinery(uuid, jsonb) from public, anon;
grant execute on function public.correct_workday_machinery(uuid, jsonb) to authenticated;
