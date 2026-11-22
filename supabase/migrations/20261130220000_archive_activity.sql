-- A foreman can archive an activity (Matt, 2026-11-21).
--
-- Recent activities had no way to take a wrong activity out: a test, a
-- duplicate, one added for the wrong person. Archiving keeps the row and its
-- history and marks it, so the app stops listing and counting it, and it can
-- be put back. It never touches the shift: paid time is the timecard's.
--
-- Only an activity that has ended can be archived; a running one is stopped
-- first, the same rule its time correction follows.

-- Who archived it, and why, is in custom_work_history like every other
-- change to an activity; the row itself only needs to say that it is archived.
alter table public.custom_work_sessions
  add column if not exists archived_at timestamptz;

create function public.archive_crew_activity(p_id uuid, p_data jsonb)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare
  actor uuid := auth.uid();
  entry public.custom_work_sessions;
  restore boolean := coalesce((p_data->>'restore')::boolean, false);
  before jsonb;
begin
  if actor is null or not coalesce(public.custom_work_internal(), false) or not coalesce(public._is_lead(actor), false) then
    raise exception 'Only foremen and above can archive an activity.' using errcode = '42501';
  end if;
  select * into entry from public.custom_work_sessions where id = (p_data->>'id')::uuid for update;
  if not found then
    raise exception 'That activity is unavailable.';
  end if;
  -- The same request sent twice (a retry after a lost reply) changes it once.
  if (entry.archived_at is null) = restore then
    return entry.id;
  end if;
  if entry.ended_at is null then
    raise exception 'Stop the activity before archiving it.';
  end if;
  if entry.revision <> coalesce((p_data->>'revision')::integer, -1) then
    raise exception 'This record changed. Refresh before saving.';
  end if;
  if length(btrim(coalesce(p_data->>'reason', ''))) < 3 then
    raise exception 'Say why, in a few words.';
  end if;
  -- Putting one back must not land it on work recorded since.
  if restore and exists (select 1 from public.custom_work_sessions x where x.profile_id = entry.profile_id
      and x.id <> entry.id and x.archived_at is null
      and x.started_at < entry.ended_at and coalesce(x.ended_at, 'infinity') > entry.started_at) then
    raise exception 'Other work is now recorded over that time, so it cannot be restored.';
  end if;
  before := to_jsonb(entry);
  update public.custom_work_sessions set
      archived_at = case when restore then null else now() end,
      revision = revision + 1
    where id = entry.id;
  insert into public.custom_work_history(project_id, actor_id, entity_id, action, before_value, after_value, reason)
    select entry.project_id, actor, x.id, case when restore then 'restored' else 'archived' end, before, to_jsonb(x),
      left(btrim(p_data->>'reason'), 1000)
    from public.custom_work_sessions x where x.id = entry.id;
  return entry.id;
end;
$$;
revoke all on function public.archive_crew_activity(uuid, jsonb) from public, anon;
grant execute on function public.archive_crew_activity(uuid, jsonb) to authenticated;

-- save_crew_activity (20261130210000), restated with one rule changed: an
-- archived activity does not block new work over the same time. Its grants
-- are unchanged (create or replace keeps them).
create or replace function public.save_crew_activity(p_id uuid, p_data jsonb)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare
  actor uuid := auth.uid();
  existing public.custom_work_sessions;
  shift public.time_shifts;
  person uuid;
  job uuid;
  begins timestamptz;
  ends timestamptz;
  activity text := btrim(coalesce(p_data->>'activity', ''));
  note text := left(btrim(coalesce(p_data->>'note', '')), 4000);
  units jsonb := coalesce(p_data->'units', '[]'::jsonb);
  unit_count integer;
  the_unit uuid;
  finished boolean;
  part integer;
  part_id uuid;
  part_start timestamptz;
  part_end timestamptz;
  before jsonb;
begin
  if actor is null or not coalesce(public.custom_work_internal(), false) or not coalesce(public._is_lead(actor), false) then
    raise exception 'Only foremen and above can add an activity for someone.' using errcode = '42501';
  end if;
  if jsonb_typeof(units) <> 'array' then
    raise exception 'Choose the units again.';
  end if;
  unit_count := jsonb_array_length(units);
  if length(activity) not between 1 and 100 then
    raise exception 'Choose an activity.';
  end if;
  if unit_count > 40 then
    raise exception 'Add at most 40 units at a time.';
  end if;
  if (select count(distinct item->>'unit_id') from jsonb_array_elements(units) item) <> unit_count then
    raise exception 'Each unit can be chosen once.';
  end if;

  if p_data ? 'replace_id' then
    select * into existing from public.custom_work_sessions
      where id = (p_data->>'replace_id')::uuid for update;
    if not found then
      raise exception 'That activity is unavailable.';
    end if;
    if existing.ended_at is null then
      raise exception 'Stop the activity before setting its units.';
    end if;
    if existing.revision <> coalesce((p_data->>'revision')::integer, -1) then
      raise exception 'This record changed. Refresh before saving.';
    end if;
    if existing.project_id is null then
      raise exception 'Company work has no units. Correct its job first.';
    end if;
    if unit_count = 0 then
      raise exception 'Choose at least one unit.';
    end if;
    -- A machine timer belongs to the moment it ran; sharing the activity
    -- between units would leave it on whichever slice kept the row.
    if unit_count > 1 and existing.workday_machinery_ms > 0 then
      raise exception 'This activity has machine time. Give it one unit, or remove its machine timers first.';
    end if;
    person := existing.profile_id;
    job := existing.project_id;
    begins := existing.started_at;
    ends := existing.ended_at;
    select * into shift from public.time_shifts where id = existing.shift_id;
  else
    -- The same request sent twice (a retry after a lost reply) adds once.
    if exists (select 1 from public.custom_work_sessions where id = p_id) then
      return p_id;
    end if;
    person := (p_data->>'profile_id')::uuid;
    job := (p_data->>'project_id')::uuid;
    begins := (p_data->>'started_at')::timestamptz;
    ends := (p_data->>'ended_at')::timestamptz;
    if person is null or not exists (select 1 from public.profiles where id = person) then
      raise exception 'Choose who did the work.';
    end if;
    if job is null or not exists (select 1 from public.projects where id = job and deleted_at is null) then
      raise exception 'That job is unavailable.';
    end if;
    if begins is null or ends is null or ends <= begins then
      raise exception 'The out time must be after the in time.';
    end if;
    if ends > now() + interval '2 minutes' then
      raise exception 'The out time cannot be in the future.';
    end if;
    if ends - begins > interval '16 hours' then
      raise exception 'An activity cannot be longer than 16 hours.';
    end if;
    select * into shift from public.time_shifts
      where profile_id = person and project_id = job and status in ('open', 'submitted', 'approved')
        and clock_in_at <= begins and coalesce(clock_out_at, now() + interval '2 minutes') >= ends
      order by clock_in_at desc limit 1 for update;
    if not found then
      raise exception 'These times are outside the hours this person was clocked in on this job. Correct the timecard first.';
    end if;
    -- An archived activity no longer holds its time.
    if exists (select 1 from public.custom_work_sessions x where x.profile_id = person and x.archived_at is null
          and x.started_at < ends and coalesce(x.ended_at, 'infinity') > begins)
      or exists (select 1 from public.unit_sessions x where x.profile_id = person
          and x.started_at < ends and coalesce(x.ended_at, 'infinity') > begins)
      or exists (select 1 from public.task_sessions x where x.profile_id = person
          and x.started_at < ends and coalesce(x.ended_at, 'infinity') > begins) then
      raise exception 'That time overlaps other work recorded for this person.';
    end if;
  end if;

  -- Work on no unit: one activity, stored the way the Workday stores Setup,
  -- Hauling and the rest ("Idle time" is the kept identifier; the activity's
  -- name is its description).
  if unit_count = 0 then
    insert into public.custom_work_sessions(id, profile_id, shift_id, project_id, unit_id, kind, stage,
        description, started_at, ended_at, end_reason, shift_status)
      values (p_id, person, shift.id, job, null, 'idle', 'Idle time',
        activity || case when note <> '' then ' — ' || note else '' end, begins, ends, 'added', shift.status);
    insert into public.custom_work_history(project_id, actor_id, entity_id, action, after_value, reason)
      select job, actor, x.id, 'added', to_jsonb(x), 'Added by a foreman' from public.custom_work_sessions x where x.id = p_id;
    return p_id;
  end if;

  for part in 0 .. unit_count - 1 loop
    the_unit := (units->part->>'unit_id')::uuid;
    finished := coalesce((units->part->>'finished')::boolean, false);
    if not exists (select 1 from public.custom_work_units u where u.id = the_unit and u.project_id = job) then
      raise exception 'One of those units is not on this job.';
    end if;
    part_start := begins + (ends - begins) * part / unit_count;
    part_end := case when part = unit_count - 1 then ends else begins + (ends - begins) * (part + 1) / unit_count end;
    if part = 0 and existing.id is not null then
      before := to_jsonb(existing);
      update public.custom_work_sessions set unit_id = the_unit, kind = 'unit', stage = activity,
          -- A job activity keeps its name in the description; unit work keeps only the note.
          description = case when existing.kind = 'idle' then coalesce(nullif(split_part(existing.description, ' — ', 2), ''), '') else existing.description end,
          ended_at = part_end, outcome = case when finished then 'finished' else 'partial' end, revision = revision + 1
        where id = existing.id;
      insert into public.custom_work_history(project_id, actor_id, entity_id, action, before_value, after_value, reason)
        select job, actor, x.id, 'session', before, to_jsonb(x), 'Units set by a foreman' from public.custom_work_sessions x where x.id = existing.id;
    else
      part_id := case when part = 0 then p_id else gen_random_uuid() end;
      insert into public.custom_work_sessions(id, profile_id, shift_id, project_id, unit_id, kind, stage,
          description, outcome, started_at, ended_at, end_reason, shift_status)
        values (part_id, person, shift.id, job, the_unit, 'unit', activity,
          note, case when finished then 'finished' else 'partial' end, part_start, part_end, 'added', shift.status);
      insert into public.custom_work_history(project_id, actor_id, entity_id, action, after_value, reason)
        select job, actor, x.id, 'added', to_jsonb(x), 'Added by a foreman' from public.custom_work_sessions x where x.id = part_id;
    end if;
  end loop;
  return coalesce(existing.id, p_id);
end;
$$;
