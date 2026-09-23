-- Forge AI field operations: find/create jobs and units, claim, start and stop
-- unit or idle work through the existing custom-work route, and file foreman
-- crew records.
--
-- The laws this file keeps (owner decisions D08-D28, .scratch/ai-field-operations):
--  * The model never confirms anything. A choice that changes a shared record,
--    ends a break, joins occupied work or creates a job beside a similar one is a
--    WAITING action with a preview; only ai_field_resolve, called from the
--    person's own screen, carries it out, and only for the exact preview they
--    saw (preview_hash) while the records it showed are still the same.
--  * Every request and action is owned by auth.uid(); every door re-checks the
--    caller (internal role, not partner, not retired, access not removed).
--  * The job clock stays the payroll clock. Nothing here clocks in, clocks out,
--    starts a break or switches jobs; those keep their safety questions in the
--    normal clock. Unit/idle timers start only on the person's own open,
--    unpaused shift on the right job.
--  * The clock snapshot is an epoch over every route that times a person (job
--    clock, custom, map, task and flashing timers), so a state that changed and
--    changed back still counts as changed. A change between SENDING and
--    ARRIVING refuses the request too, not just a change after arrival.
--  * A request older than five minutes is kept as evidence but never starts or
--    stops a timer, however late the phone reconnects.
begin;

-- ---------------------------------------------------------------------------
-- 0. Off today is not access removed
-- ---------------------------------------------------------------------------
-- profiles.active is the Crew page's On site / Off today switch (Crew.tsx), and
-- restore_access clears access_revoked_at without touching it. Login access is
-- retired_at / access_revoked_at (CrewAccess). custom_work_internal required
-- `active`, so a foreman marked Off today could not file yesterday's work and an
-- installer marked off could not see their own units. The helper now asks the
-- access question; partner, role, retired and revoked checks are unchanged.
create or replace function public.custom_work_internal() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select auth.uid() is not null and not public.is_partner_user() and exists (
    select 1 from profiles where id = auth.uid() and retired_at is null and access_revoked_at is null
      and role in ('installer','foreman','supervisor','owner'))
$$;
revoke all on function public.custom_work_internal() from public, anon;
grant execute on function public.custom_work_internal() to authenticated;

-- ---------------------------------------------------------------------------
-- 1. Evidence, receipts and the clock epoch
-- ---------------------------------------------------------------------------
-- One row per message: what was said, when it was sent (device time as
-- evidence; server-estimated time for rules), the original recording, and the
-- timing state the server saw when it arrived.
create table public.ai_field_requests (
  id uuid primary key,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  input_kind text not null check (input_kind in ('text','voice')),
  transcript text not null check (length(btrim(transcript)) between 1 and 8000),
  -- Send pressed, on the phone's clock: evidence and the D16 start time.
  sent_at timestamptz not null check (isfinite(sent_at)),
  received_at timestamptz not null default now(),
  -- One guided setup spans many messages; the draft answers travel with it.
  conversation_id uuid,
  audio_path text check (audio_path is null or length(audio_path) <= 300),
  clock_snapshot jsonb not null default '{}',
  captured jsonb,
  reply jsonb,
  finished_at timestamptz,
  check (input_kind = 'text' or audio_path is not null)
);
create index ai_field_requests_profile on public.ai_field_requests(profile_id, sent_at desc);
create index ai_field_requests_conversation on public.ai_field_requests(profile_id, conversation_id, received_at desc);

-- One receipt per distinct thing a request asked for. action_key is derived by
-- the server-side tool code from the target (never by the model), so replaying a
-- request cannot create a second job, unit, claim or timer.
create table public.ai_field_actions (
  id uuid primary key,
  request_id uuid not null references public.ai_field_requests(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  action text not null check (action in ('create_job','save_unit','start_unit','start_idle','stop_work','release_unit','crew_record')),
  action_key text not null check (length(action_key) between 1 and 300),
  data jsonb not null,
  status text not null default 'waiting' check (status in ('waiting','done','stale','cancelled')),
  result jsonb not null default '{}',
  choice text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  unique (request_id, action_key)
);
create index ai_field_actions_profile on public.ai_field_actions(profile_id, created_at desc);
create index ai_field_actions_job on public.ai_field_actions(project_id);

-- Bumped by any change to what a person is being paid for or timed on.
create table public.ai_clock_epochs (
  profile_id uuid primary key references public.profiles(id) on delete cascade,
  epoch bigint not null default 0,
  changed_at timestamptz not null default now()
);

-- A job the crew created in the field: usable at once, waiting for office setup.
create table public.ai_field_jobs (
  project_id uuid primary key references public.projects(id) on delete cascade,
  created_by uuid references public.profiles(id) on delete set null,
  action_id uuid not null,
  notice_message_id uuid,
  notified uuid[] not null default '{}',
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references public.profiles(id) on delete set null
);

-- The responsible person for an UNMAPPED custom unit (D22/D24). A unit linked to
-- the map has exactly one owner, project_openings.assigned_to, which dispatch and
-- the map already use; the trigger below keeps this column empty for those.
alter table public.custom_work_units add column assigned_to uuid references public.profiles(id) on delete set null;
alter table public.custom_work_units add column assigned_at timestamptz;

create function public._ai_one_unit_owner() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare o project_openings;
begin
  if new.opening_id is null or new.assigned_to is null then return new; end if;
  select * into o from project_openings where id = new.opening_id for update;
  if o.assigned_to is null then
    perform set_config('app.assignment_via', 'map', true);
    update project_openings set assigned_to = new.assigned_to, assigned_by = coalesce(auth.uid(), new.assigned_to), assigned_at = now() where id = o.id;
  elsif o.assigned_to <> new.assigned_to then
    raise exception 'This unit and its map unit are assigned to different people. Ask a foreman to reassign one of them first.';
  end if;
  new.assigned_to := null; new.assigned_at := null;
  return new;
end $$;
revoke all on function public._ai_one_unit_owner() from public, anon, authenticated;
create trigger custom_work_units_one_owner before insert or update of opening_id, assigned_to on public.custom_work_units
  for each row execute function public._ai_one_unit_owner();

alter table public.ai_field_requests enable row level security;
alter table public.ai_field_actions enable row level security;
alter table public.ai_clock_epochs enable row level security;
alter table public.ai_field_jobs enable row level security;
revoke all on public.ai_field_requests from public, anon, authenticated;
revoke all on public.ai_field_actions from public, anon, authenticated;
revoke all on public.ai_clock_epochs from public, anon, authenticated;
revoke all on public.ai_field_jobs from public, anon, authenticated;
grant select on public.ai_field_requests, public.ai_field_actions, public.ai_field_jobs to authenticated;

-- Evidence is the speaker's own; supervisors and owners can review it.
create policy ai_field_requests_read on public.ai_field_requests for select to authenticated using (
  not public.is_partner_user() and public.custom_work_internal() and (profile_id = auth.uid() or public._is_supervisor(auth.uid()))
);
create policy ai_field_actions_read on public.ai_field_actions for select to authenticated using (
  not public.is_partner_user() and public.custom_work_internal() and (profile_id = auth.uid() or public._is_supervisor(auth.uid()))
  and (project_id is null or exists (select 1 from public.projects p where p.id = project_id and p.deleted_at is null))
);
create policy ai_field_jobs_read on public.ai_field_jobs for select to authenticated using (
  not public.is_partner_user() and public.custom_work_internal() and (created_by = auth.uid() or public._is_lead(auth.uid()))
  and exists (select 1 from public.projects p where p.id = project_id and p.deleted_at is null)
);

-- tg_argv[0] names the column holding the person. Moving a row between people
-- changes both of them. A person being deleted (their rows cascading away) has
-- no clock left to protect, and recreating their epoch row would block the
-- deletion, so they are skipped.
create function public._ai_bump_clock_epoch() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare who uuid;
begin
  for who in select distinct x from unnest(array[
      case when tg_op <> 'DELETE' then (to_jsonb(new) ->> tg_argv[0])::uuid end,
      case when tg_op <> 'INSERT' then (to_jsonb(old) ->> tg_argv[0])::uuid end]) x
      where x is not null and exists (select 1 from public.profiles p where p.id = x) loop
    insert into public.ai_clock_epochs(profile_id, epoch, changed_at) values (who, 1, now())
    on conflict (profile_id) do update set epoch = ai_clock_epochs.epoch + 1, changed_at = now();
  end loop;
  return null;
end $$;
revoke all on function public._ai_bump_clock_epoch() from public, anon, authenticated;
-- Only what changes pay or timing; GPS pings and approvals of an unchanged punch
-- do not invalidate a request.
create trigger ai_clock_epoch_shift after insert or delete on public.time_shifts
  for each row execute function public._ai_bump_clock_epoch('profile_id');
create trigger ai_clock_epoch_shift_update after update on public.time_shifts for each row
  when (old.profile_id is distinct from new.profile_id or old.project_id is distinct from new.project_id or old.clock_in_at is distinct from new.clock_in_at
    or old.clock_out_at is distinct from new.clock_out_at or old.break_started_at is distinct from new.break_started_at
    or old.break_seconds is distinct from new.break_seconds or old.status is distinct from new.status)
  execute function public._ai_bump_clock_epoch('profile_id');
create trigger ai_clock_epoch_work after insert or delete on public.custom_work_sessions
  for each row execute function public._ai_bump_clock_epoch('profile_id');
create trigger ai_clock_epoch_work_update after update on public.custom_work_sessions for each row
  when (old.profile_id is distinct from new.profile_id or old.ended_at is distinct from new.ended_at or old.unit_id is distinct from new.unit_id
    or old.stage is distinct from new.stage or old.participation is distinct from new.participation)
  execute function public._ai_bump_clock_epoch('profile_id');
create trigger ai_clock_epoch_legacy after insert or delete on public.unit_sessions
  for each row execute function public._ai_bump_clock_epoch('profile_id');
create trigger ai_clock_epoch_legacy_update after update on public.unit_sessions for each row
  when (old.profile_id is distinct from new.profile_id or old.ended_at is distinct from new.ended_at or old.opening_id is distinct from new.opening_id)
  execute function public._ai_bump_clock_epoch('profile_id');
create trigger ai_clock_epoch_task after insert or delete on public.task_sessions
  for each row execute function public._ai_bump_clock_epoch('profile_id');
create trigger ai_clock_epoch_task_update after update on public.task_sessions for each row
  when (old.profile_id is distinct from new.profile_id or old.ended_at is distinct from new.ended_at or old.state is distinct from new.state)
  execute function public._ai_bump_clock_epoch('profile_id');
create trigger ai_clock_epoch_phase after insert or delete on public.opening_phases
  for each row execute function public._ai_bump_clock_epoch('started_by');
create trigger ai_clock_epoch_phase_update after update on public.opening_phases for each row
  when (old.started_by is distinct from new.started_by or old.status is distinct from new.status or old.paused_at is distinct from new.paused_at)
  execute function public._ai_bump_clock_epoch('started_by');

-- ---------------------------------------------------------------------------
-- 2. Unit facts gain components, direction and "I don't know"
-- ---------------------------------------------------------------------------
-- Same law as before (no field is a prerequisite to timing); the original keys
-- are restated so every caller keeps one validator.
create or replace function public.validate_custom_work_facts(f jsonb) returns void
language plpgsql set search_path = public, pg_temp as $$
declare k text; v jsonb; c jsonb;
begin
  if f is null or jsonb_typeof(f) <> 'object' or octet_length(f::text) > 20000 then raise exception 'Unit details are too large or invalid.'; end if;
  for k, v in select * from jsonb_each(f) loop
    if k not in ('width_in','height_in','weight_lb','story','location','material','electrical','complexity','access','equipment_needed','equipment','equipment_minutes','note','named_helpers','area_source','installation_complete',
                 'components','opening_direction','direction_viewpoint','measurement_source','unknown_fields') then
      raise exception 'Unknown unit detail.';
    end if;
    if k in ('width_in','height_in','weight_lb','equipment_minutes') then
      if jsonb_typeof(v) <> 'number' or (v::text)::numeric < 0 or (v::text)::numeric > 100000 or (k in ('width_in','height_in') and (v::text)::numeric = 0) then raise exception 'Enter a valid positive measurement or leave it unknown.'; end if;
    elsif k = 'components' then
      if jsonb_typeof(v) <> 'array' or jsonb_array_length(v) > 30 then raise exception 'List up to 30 kinds of component.'; end if;
      for c in select value from jsonb_array_elements(v) loop
        if jsonb_typeof(c) <> 'object' or jsonb_typeof(c->'label') is distinct from 'string' or length(btrim(c->>'label')) not between 1 and 100
          or jsonb_typeof(c->'quantity') is distinct from 'number' or (c->>'quantity')::numeric not between 1 and 1000
          or trunc((c->>'quantity')::numeric) <> (c->>'quantity')::numeric or (select count(*) from jsonb_object_keys(c)) <> 2 then
          raise exception 'Each component needs a name and a whole-number quantity.';
        end if;
      end loop;
    elsif k = 'unknown_fields' then
      if jsonb_typeof(v) <> 'array' or jsonb_array_length(v) > 20 or exists (
        select 1 from jsonb_array_elements(v) x where jsonb_typeof(x) <> 'string' or x #>> '{}' not in
          ('type_label','components','material','story','width_in','height_in','opening_direction','electrical','access','complexity','equipment_needed','location','area_source','weight_lb','equipment','equipment_minutes')) then
        raise exception 'Unknown answers must name unit details.';
      end if;
    elsif k = 'direction_viewpoint' then
      if jsonb_typeof(v) <> 'string' or v #>> '{}' not in ('outside looking in','inside looking out','outside looking in (default)') then raise exception 'Choose the viewing position for the direction.'; end if;
    elsif k = 'opening_direction' then
      if jsonb_typeof(v) <> 'string' or length(v #>> '{}') not between 1 and 200 then raise exception 'Describe the opening direction briefly.'; end if;
    elsif jsonb_typeof(v) <> 'string' or length(v #>> '{}') > 4000 then raise exception 'Enter a short text detail.';
    end if;
  end loop;
end $$;
revoke all on function public.validate_custom_work_facts(jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Who may use this, and what they can see
-- ---------------------------------------------------------------------------
create function public._ai_field_actor() returns uuid
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid();
begin
  if uid is null or not public.custom_work_internal() then
    raise exception 'Forge AI field actions need a Forge crew login with current access.' using errcode = '42501';
  end if;
  return uid;
end $$;
revoke all on function public._ai_field_actor() from public, anon, authenticated;

-- Test logins see and touch only the automation sandbox; real crew never see a
-- testing job unless they are supervisors (the projects_select_visible rule).
create function public._ai_job_visible(p_job uuid, p_uid uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from projects p where p.id = p_job and p.deleted_at is null and (
    case when public.is_test_profile(p_uid) then public.is_sandbox_project(p.id)
         else not coalesce(p.is_test, false) or public._is_supervisor(p_uid) end))
$$;
revoke all on function public._ai_job_visible(uuid, uuid) from public, anon, authenticated;

create function public._ai_norm(t text) returns text language sql immutable set search_path = public, pg_temp as $$
  select regexp_replace(lower(coalesce(t, '')), '[^a-z0-9]', '', 'g')
$$;
revoke all on function public._ai_norm(text) from public, anon, authenticated;

-- What the plans already say about a map unit. Only values that exist; the crew
-- is never asked for these again and nothing is guessed for the rest.
-- Frame size is seeded from the window type exactly as Current Work does. The
-- mark schedule's width/height are decoded from the manufacturer's call size
-- (size_code), which is not a measured outside-frame size, so they are shown
-- as plan_call_* for reference and never written into the unit's facts.
create function public._ai_plan_facts(p_opening uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'type_label', wt.name,
    'width_in', wt.width_in, 'height_in', wt.height_in,
    'area_source', case when wt.width_in is not null and wt.height_in is not null then 'From plans' end,
    'location', nullif(btrim(o.label), ''),
    'plan_style', ms.style, 'plan_operation', ms.operation, 'plan_call_width_in', ms.width_in, 'plan_call_height_in', ms.height_in))
  from project_openings o
  left join window_types wt on wt.id = o.window_type_id
  left join lateral (select s.style, s.operation, s.width_in, s.height_in from project_mark_specs s
    where s.project_id = o.project_id and upper(btrim(s.mark_code)) = upper(btrim(o.opening_code)) limit 1) ms on true
  where o.id = p_opening
$$;
revoke all on function public._ai_plan_facts(uuid) from public, anon, authenticated;

-- The part of the plan facts a new unit record starts from.
create function public._ai_plan_seed(p_plan jsonb) returns jsonb language sql immutable set search_path = public, pg_temp as $$
  select coalesce(jsonb_object_agg(key, value), '{}') from jsonb_each(coalesce(p_plan, '{}')) where key in ('width_in','height_in','area_source','location')
$$;
revoke all on function public._ai_plan_seed(jsonb) from public, anon, authenticated;

-- The timing state as this person's routes see it right now.
create function public._ai_clock_state(p_uid uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'epoch', coalesce((select epoch from ai_clock_epochs where profile_id = p_uid), 0),
    'changed_at', (select changed_at from ai_clock_epochs where profile_id = p_uid),
    'shift', (select jsonb_build_object('id', s.id, 'project_id', s.project_id, 'status', s.status, 'clock_in_at', s.clock_in_at,
                'break_started_at', s.break_started_at, 'break_seconds', coalesce(s.break_seconds, 0))
              from time_shifts s where s.profile_id = p_uid and s.status in ('open','needs_finish') and s.clock_out_at is null
              order by s.clock_in_at desc limit 1),
    'session', (select jsonb_build_object('id', w.id, 'unit_id', w.unit_id, 'stage', w.stage, 'participation', w.participation, 'started_at', w.started_at)
                from custom_work_sessions w where w.profile_id = p_uid and w.ended_at is null limit 1),
    -- Every other route that times a person; a start ends or pauses these.
    'work', jsonb_build_object(
      'map', (select coalesce(jsonb_agg(id order by id), '[]') from unit_sessions where profile_id = p_uid and ended_at is null),
      'task', (select coalesce(jsonb_agg(id order by id), '[]') from task_sessions where profile_id = p_uid and ended_at is null),
      'flashing', (select coalesce(jsonb_agg(id order by id), '[]') from opening_phases where started_by = p_uid and status = 'active' and paused_at is null)))
$$;
revoke all on function public._ai_clock_state(uuid) from public, anon, authenticated;

-- Read-only discovery: jobs, my clock, a job's units, who is responsible and who
-- is working now. Names only: no roster, pay or contact details.
create function public.ai_field_context(p_job uuid default null, p_search text default '') returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare uid uuid := public._ai_field_actor(); q text := left(btrim(coalesce(p_search, '')), 100); st jsonb; units jsonb; lead boolean := public._is_lead(uid);
begin
  if p_job is not null and not public._ai_job_visible(p_job, uid) then raise exception 'That job is unavailable.'; end if;
  st := public._ai_clock_state(uid);
  if p_job is not null then
    with custom as (
      select u.id, u.label, u.type_label, u.opening_id, o.opening_code, u.revision, u.facts,
        case when u.opening_id is not null then public._ai_plan_facts(u.opening_id) else '{}'::jsonb end as plan,
        case when u.opening_id is not null then o.assigned_to else u.assigned_to end as assignee,
        coalesce(u.facts->>'installation_complete' = 'Yes', false) or coalesce(o.status = 'installed', false) as finished
      from custom_work_units u left join project_openings o on o.id = u.opening_id
      where u.project_id = p_job
    ), map_only as (
      select null::uuid as id, o.opening_code as label, null::text as type_label, o.id as opening_id, o.opening_code, null::int as revision,
        '{}'::jsonb as facts, public._ai_plan_facts(o.id) as plan, o.assigned_to as assignee, coalesce(o.status = 'installed', false) as finished
      from project_openings o where o.project_id = p_job and o.removed_at is null
        and not exists (select 1 from custom_work_units u where u.opening_id = o.id)
    ), unit_rows as (
      select r.*, (
        select coalesce(jsonb_agg(jsonb_build_object('name', pr.display_name, 'participation', x.participation, 'stage', x.stage, 'started_at', x.started_at, 'is_me', x.profile_id = uid) order by x.started_at), '[]')
        from (select w.profile_id, w.participation, w.stage, w.started_at from custom_work_sessions w where w.ended_at is null and r.id is not null and w.unit_id = r.id
              union all
              select us.profile_id, coalesce(us.role, 'install'), 'Map timer', us.started_at from unit_sessions us where us.ended_at is null and r.opening_id is not null and us.opening_id = r.opening_id) x
        join profiles pr on pr.id = x.profile_id) as working
      from (select * from custom union all select * from map_only) r
    )
    select jsonb_build_object(
      'units', coalesce(jsonb_agg(jsonb_build_object(
        'unit_id', id, 'opening_id', opening_id, 'label', label, 'map_code', opening_code,
        'type', coalesce(nullif(type_label, 'Unknown'), plan->>'type_label', type_label), 'revision', revision,
        'facts', facts - 'note' - 'named_helpers', 'from_plans', plan,
        'assigned_to', (select display_name from profiles where id = assignee), 'assigned_to_me', assignee = uid,
        'working_now', working,
        'status', case when finished then 'finished' when jsonb_array_length(working) > 0 then 'working'
                       when assignee is not null then 'assigned' else 'available' end) order by rn) filter (where hit and rn <= 300), '[]'),
      -- Counts always describe the whole job; the list is bounded.
      'counts', jsonb_build_object('total', count(*), 'custom_records', count(*) filter (where id is not null), 'map_only', count(*) filter (where id is null),
        'available', count(*) filter (where not finished and assignee is null and jsonb_array_length(working) = 0),
        'assigned', count(*) filter (where not finished and assignee is not null), 'working', count(*) filter (where jsonb_array_length(working) > 0),
        'finished', count(*) filter (where finished), 'matching_search', count(*) filter (where hit)),
      'truncated', count(*) filter (where hit) > 300)
    -- On a large job, p_search narrows to unit labels / map codes containing it,
    -- the exact match first, so "unit 412" is found beyond the first 300.
    into units from (select *, row_number() over (order by hit desc, exact desc, lower(label)) as rn from (
      select u.*, q <> '' and (lower(btrim(u.label)) = lower(q) or lower(btrim(coalesce(u.opening_code, ''))) = lower(q)) as exact,
        q = '' or position(lower(q) in lower(u.label)) > 0 or position(lower(q) in lower(coalesce(u.opening_code, ''))) > 0 as hit
      from unit_rows u) s) z;
  end if;
  return jsonb_build_object(
    'as_of', now(), 'me', jsonb_build_object('id', uid, 'is_lead', lead),
    'clock', jsonb_build_object(
      'shift', case when st->'shift' = 'null' then null else (st->'shift') || jsonb_build_object('job', (select name from projects where id = (st->'shift'->>'project_id')::uuid)) end,
      'unit_timer', case when st->'session' = 'null' then null else (st->'session') || jsonb_build_object('unit', (select label from custom_work_units where id = (st->'session'->>'unit_id')::uuid)) end),
    'jobs', case when p_job is null then (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'job_code', p.job_code, 'location', p.address) order by p.name), '[]')
      from (select * from projects p where public._ai_job_visible(p.id, uid) and (q = '' or p.name ilike '%' || q || '%' or p.job_code ilike '%' || q || '%' or coalesce(p.address, '') ilike '%' || q || '%')
            order by (p.id = (st->'shift'->>'project_id')::uuid) desc nulls last, p.name limit 40) p) end,
    'job', case when p_job is not null then (select jsonb_build_object('id', id, 'name', name, 'job_code', job_code, 'location', address, 'field_created', exists (select 1 from ai_field_jobs j where j.project_id = p.id)) from projects p where id = p_job) end,
    'units', units->'units', 'unit_counts', units->'counts', 'units_truncated', units->'truncated',
    -- A retrospective record names who WORKED, so it lists everyone with login
    -- access, including people marked Off today (availability is not access).
    'crew', case when lead then (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', display_name, 'on_site_today', active) order by display_name), '[]') from (
      select id, display_name, active from profiles where not coalesce(is_partner, false) and retired_at is null and access_revoked_at is null
        and role in ('installer','foreman','supervisor','owner') and public.is_test_profile(id) = public.is_test_profile(uid) order by display_name limit 200) c) end);
end $$;
revoke all on function public.ai_field_context(uuid, text) from public, anon;
grant execute on function public.ai_field_context(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. A request arrives
-- ---------------------------------------------------------------------------
-- The phone sends two things about time, and neither is reconstructed here:
--  * p_sent_at, the moment Send was pressed on the phone's clock (the owner's
--    approved start time, D16), kept as evidence and bounded;
--  * p_expected_epoch, the clock version the phone had last read BEFORE Send
--    (ai_field_clock_version). If the server's version differs on arrival,
--    something changed that the person did not see when they spoke — however
--    long the network held the message — and no timer is changed.
-- Transit time is unknowable to the phone, so it is never subtracted from
-- anything. When the phone's clock and the server's disagree about ordering,
-- a start becomes an explicit "Start now" choice instead of a guessed time.
create function public.ai_field_clock_version() returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('epoch', coalesce((select epoch from ai_clock_epochs where profile_id = public._ai_field_actor()), 0), 'as_of', now())
$$;
revoke all on function public.ai_field_clock_version() from public, anon;
grant execute on function public.ai_field_clock_version() to authenticated;

create function public.ai_field_begin(p_id uuid, p_input_kind text, p_transcript text, p_sent_at timestamptz, p_expected_epoch bigint,
  p_audio_path text default null, p_client jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := public._ai_field_actor(); r ai_field_requests; st jsonb; sh jsonb; pending boolean;
begin
  if p_id is null or p_sent_at is null or p_input_kind is null or p_input_kind not in ('text','voice') then raise exception 'Invalid request.'; end if;
  if not isfinite(p_sent_at) or p_sent_at > now() + interval '2 minutes' then raise exception 'Check this phone''s date and time; the request time is in the future.'; end if;
  if p_sent_at < now() - interval '7 days' then raise exception 'This saved request is more than a week old. Ask a foreman to record it.'; end if;
  if p_audio_path is not null then
    -- The same lock the orphan cleanup claims under: attach and claim cannot
    -- interleave, so an attached recording's bytes are never deleted.
    perform pg_advisory_xact_lock(hashtextextended(p_audio_path, 7594));
    if p_audio_path !~ ('^' || uid::text || '/' || p_id::text || '/memo\.(webm|m4a|mp4|ogg|mp3|wav)$')
       or not exists (select 1 from storage.objects o where o.bucket_id = 'ai-field-memos' and o.name = p_audio_path) then
      raise exception 'The recording for this request was not saved. Record it again.';
    end if;
    if exists (select 1 from ai_field_memo_cleanup c where c.name = p_audio_path)
       and not exists (select 1 from ai_field_requests rq where rq.audio_path = p_audio_path) then
      raise exception 'This recording was never sent and is being removed. Record it again.';
    end if;
  end if;
  if p_input_kind = 'voice' and p_audio_path is null then raise exception 'Save the recording before sending a voice request.'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_id::text, 7590));
  select * into r from ai_field_requests where id = p_id;
  if found then
    if r.profile_id <> uid or r.transcript <> p_transcript or r.sent_at <> p_sent_at or r.audio_path is distinct from p_audio_path or r.input_kind <> p_input_kind
       or r.conversation_id is distinct from (p_client->>'conversation_id')::uuid then
      raise exception 'This retry does not match the original request. Send it as a new message.';
    end if;
  else
    st := public._ai_clock_state(uid);
    sh := st->'shift';
    pending := coalesce((p_client->>'clock_pending_sync')::boolean, false);
    insert into ai_field_requests(id, profile_id, input_kind, transcript, sent_at, conversation_id, audio_path, clock_snapshot)
    values (p_id, uid, p_input_kind, p_transcript, p_sent_at, (p_client->>'conversation_id')::uuid, p_audio_path,
      st || jsonb_build_object(
        'expected_epoch', p_expected_epoch,
        -- The phone's view was already out of date when the person spoke (or it
        -- did not say what it had seen): timing actions refuse.
        'changed_after_send', p_expected_epoch is null or p_expected_epoch <> (st->>'epoch')::bigint,
        -- D16: the send time only on the open, unpaused shift it was sent on, and
        -- only when the two clocks agree that Send came after that shift and after
        -- the last change the phone had seen. Otherwise the person taps Start now.
        'send_time_eligible', coalesce(sh <> 'null' and sh->>'status' = 'open' and sh->>'break_started_at' is null
          and p_sent_at <= now() and (sh->>'clock_in_at')::timestamptz <= p_sent_at and coalesce((st->>'changed_at')::timestamptz, '-infinity') <= p_sent_at, false),
        'client_pending_sync', pending))
    returning * into r;
  end if;
  return jsonb_build_object('id', r.id, 'sent_at', r.sent_at, 'received_at', r.received_at, 'reply', r.reply, 'captured', r.captured,
    'finished', r.finished_at is not null,
    'actions', (select coalesce(jsonb_agg(a.result || jsonb_build_object('action_id', a.id, 'action', a.action, 'status', a.status) order by a.created_at), '[]') from ai_field_actions a where a.request_id = r.id));
end $$;
revoke all on function public.ai_field_begin(uuid, text, text, timestamptz, bigint, text, jsonb) from public, anon;
grant execute on function public.ai_field_begin(uuid, text, text, timestamptz, bigint, text, jsonb) to authenticated;

create function public.ai_field_finish(p_id uuid, p_reply jsonb, p_captured jsonb default null) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := public._ai_field_actor();
begin
  if octet_length(coalesce(p_reply, '{}')::text) > 200000 or octet_length(coalesce(p_captured, '{}')::text) > 40000 then raise exception 'This reply is too large to save.'; end if;
  -- First answer wins: a retry returns the saved reply rather than a new one.
  update ai_field_requests set reply = p_reply, captured = coalesce(p_captured, captured), finished_at = now()
  where id = p_id and profile_id = uid and finished_at is null;
end $$;
revoke all on function public.ai_field_finish(uuid, jsonb, jsonb) from public, anon;
grant execute on function public.ai_field_finish(uuid, jsonb, jsonb) to authenticated;

-- The setup answers so far, saved as soon as they are heard, so a failed or
-- abandoned reply still keeps them for the next message.
create function public.ai_field_save_draft(p_id uuid, p_captured jsonb) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := public._ai_field_actor();
begin
  if p_captured is null or jsonb_typeof(p_captured) <> 'object' or octet_length(p_captured::text) > 40000 then raise exception 'These answers are too large to save.'; end if;
  update ai_field_requests set captured = p_captured where id = p_id and profile_id = uid and finished_at is null;
  if not found then raise exception 'This request belongs to another account or is finished.' using errcode = '42501'; end if;
end $$;
revoke all on function public.ai_field_save_draft(uuid, jsonb) from public, anon;
grant execute on function public.ai_field_save_draft(uuid, jsonb) to authenticated;

-- The latest saved answers in this person's conversation, excluding the message
-- being answered. Only their own requests: another account signing in on the
-- same phone starts empty even with the same conversation id.
create function public.ai_field_draft(p_conversation uuid, p_exclude uuid default null) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select captured from ai_field_requests
    where profile_id = public._ai_field_actor() and conversation_id = p_conversation and id is distinct from p_exclude and captured is not null
    order by received_at desc limit 1), '{}'::jsonb)
$$;
revoke all on function public.ai_field_draft(uuid, uuid) from public, anon;
grant execute on function public.ai_field_draft(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Carrying out one action (internal)
-- ---------------------------------------------------------------------------
-- A waiting result: the choices the person may make, sealed with a hash of
-- exactly what their screen shows.
create function public._ai_waiting(p_result jsonb) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select p_result || jsonb_build_object('status', 'needs_choice', 'expires_at', now() + interval '30 minutes',
    'preview_hash', md5((p_result || jsonb_build_object('status', 'needs_choice', 'expires_at', now() + interval '30 minutes'))::text))
$$;
revoke all on function public._ai_waiting(jsonb) from public, anon, authenticated;

create function public._ai_unit_json(u custom_work_units) returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('unit_id', u.id, 'label', u.label, 'type', u.type_label, 'facts', u.facts, 'revision', u.revision, 'opening_id', u.opening_id,
    'assigned_to', (select display_name from profiles where id = case when u.opening_id is not null then (select assigned_to from project_openings where id = u.opening_id) else u.assigned_to end))
$$;
revoke all on function public._ai_unit_json(custom_work_units) from public, anon, authenticated;

create function public._ai_stale(p_message text) returns jsonb language sql immutable set search_path = public, pg_temp as $$
  select jsonb_build_object('status', 'stale', 'message', p_message)
$$;
revoke all on function public._ai_stale(text) from public, anon, authenticated;

create function public._ai_field_apply(p_action uuid, p_choice text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  uid uuid := auth.uid(); a ai_field_actions; r ai_field_requests; d jsonb; jid uuid; res jsonb; st jsonb; snap jsonb;
  u custom_work_units; o project_openings; sh time_shifts; s custom_work_sessions; matches jsonb; people uuid[]; msg uuid;
  at_time timestamptz; can_edit boolean; proposed jsonb; additions jsonb := '{}'; conflicts jsonb := '{}'; plan jsonb;
  k text; v jsonb; newfacts jsonb; unknowns jsonb; stage text; part text; assignee uuid; others jsonb; from_confirm boolean := p_choice is not null;
  outid uuid; label_norm text; prev jsonb;
begin
  select * into a from ai_field_actions where id = p_action and profile_id = uid for update;
  if not found then raise exception 'This action is unavailable.' using errcode = '42501'; end if;
  if a.status <> 'waiting' then return a.result; end if;
  prev := a.result;
  select * into r from ai_field_requests where id = a.request_id;
  d := a.data; snap := r.clock_snapshot;
  jid := nullif(d->>'project_id', '')::uuid;
  if jid is not null and not public._ai_job_visible(jid, uid) then raise exception 'That job is unavailable.'; end if;
  if from_confirm and (prev->>'expires_at')::timestamptz < now() then
    res := public._ai_stale('This choice expired. Ask Forge AI again.');
  end if;
  perform pg_advisory_xact_lock(hashtextextended(uid::text, 7281));
  if jid is not null then perform pg_advisory_xact_lock(hashtextextended(jid::text, 7285)); end if;

  if res is not null then
    null;
  elsif a.action = 'create_job' then
    if public.is_test_profile(uid) then raise exception 'This is a test login. It can only use the automation sandbox job, not create a real one.' using errcode = '42501'; end if;
    if length(btrim(coalesce(d->>'name', ''))) not between 2 and 80 or length(btrim(coalesce(d->>'location', ''))) not between 3 and 300 then
      raise exception 'A new job needs its name and site address or location.';
    end if;
    -- One creator at a time, so two phones naming the same site see each other.
    perform pg_advisory_xact_lock(7592);
    select coalesce(jsonb_agg(x order by x->>'name', x->>'id'), '[]') into matches from (
      select jsonb_build_object('id', p.id, 'name', p.name, 'job_code', p.job_code, 'location', p.address) x from projects p
      where public._ai_job_visible(p.id, uid) and (
        (length(public._ai_norm(p.name)) >= 3 and length(public._ai_norm(d->>'name')) >= 3 and
          (public._ai_norm(p.name) like '%' || public._ai_norm(d->>'name') || '%' or public._ai_norm(d->>'name') like '%' || public._ai_norm(p.name) || '%'))
        or (length(public._ai_norm(p.address)) >= 6 and public._ai_norm(p.address) = public._ai_norm(d->>'location'))
        or exists (select 1 from regexp_split_to_table(lower(p.name), '[^a-z0-9]+') w1 join regexp_split_to_table(lower(d->>'name'), '[^a-z0-9]+') w2 on w1 = w2
                   where length(w1) >= 4 and w1 not in ('residence','house','home','project','remodel','street','road','avenue','drive','lane','windows','doors','window','door','building','court')))
      order by p.name, p.id limit 5) m;
    if p_choice like 'use_existing:%' then
      if not exists (select 1 from jsonb_array_elements(prev->'matches') m where m->>'id' = substr(p_choice, 14)) or not public._ai_job_visible(substr(p_choice, 14)::uuid, uid) then
        res := public._ai_stale('That job is no longer available. Ask again.');
      else
        jid := substr(p_choice, 14)::uuid;
        res := jsonb_build_object('status', 'done', 'outcome', 'used_existing', 'project_id', jid, 'name', (select name from projects where id = jid), 'created', false);
      end if;
    elsif jsonb_array_length(matches) > 0 and (p_choice is distinct from 'create_new' or matches <> prev->'matches') then
      -- First sight, or the similar jobs changed since the person chose: show the
      -- current list and ask again rather than create beside one they never saw.
      res := public._ai_waiting(jsonb_build_object('reason', 'similar_job', 'message', 'A similar job already exists. Do you still want to create this project?',
        'proposed', jsonb_build_object('name', btrim(d->>'name'), 'location', btrim(d->>'location')), 'matches', matches,
        'options', (select jsonb_agg(jsonb_build_object('id', 'use_existing:' || (m->>'id'), 'label', 'Use ' || (m->>'name'))) from jsonb_array_elements(matches) m)
          || jsonb_build_array(jsonb_build_object('id', 'create_new', 'label', 'Create a separate new job'), jsonb_build_object('id', 'cancel', 'label', 'Cancel'))));
    else
      jid := gen_random_uuid();
      insert into projects(id, job_code, name, address)
      values (jid, 'FIELD-' || upper(substr(md5(jid::text), 1, 6)), btrim(d->>'name'), btrim(d->>'location'));
      -- Born Not ready, like every job nobody in the office has set up yet.
      insert into project_pipeline(project_id, ready_state, updated_at, updated_by) values (jid, 'not_ready', now(), uid)
      on conflict (project_id) do update set ready_state = 'not_ready', updated_at = now(), updated_by = uid;
      -- D26: the job's supervisors, else every supervisor, else the owners. Login
      -- access decides, not whether they are on site today.
      select array_agg(p.id) into people from service_job_supervisors js join profiles p on p.id = js.profile_id
        where js.project_id = jid and not coalesce(p.is_partner, false) and p.retired_at is null and p.access_revoked_at is null and p.role in ('supervisor','owner');
      if coalesce(cardinality(people), 0) = 0 then
        select array_agg(id) into people from profiles where role = 'supervisor' and not coalesce(is_partner, false) and retired_at is null and access_revoked_at is null and not public.is_test_profile(id);
      end if;
      if coalesce(cardinality(people), 0) = 0 then
        select array_agg(id) into people from profiles where role = 'owner' and not coalesce(is_partner, false) and retired_at is null and access_revoked_at is null and not public.is_test_profile(id);
      end if;
      msg := gen_random_uuid();
      insert into project_messages(id, project_id, author_id, body, mentions) values (msg, jid, uid,
        'New field job created in Forge AI by ' || coalesce((select display_name from profiles where id = uid), 'a crew member') || ': ' || btrim(d->>'name')
        || E'\nLocation: ' || btrim(d->>'location')
        || E'\nNeeds office setup: customer, schedule, readiness and a supervisor. Crew can record work on it now.'
        || E'\nhttps://app.forgewd.com/projects/' || jid, coalesce(people, '{}'));
      insert into ai_field_jobs(project_id, created_by, action_id, notice_message_id, notified) values (jid, uid, a.id, msg, coalesce(people, '{}'));
      res := jsonb_build_object('status', 'done', 'outcome', 'created', 'project_id', jid, 'name', btrim(d->>'name'), 'location', btrim(d->>'location'),
        'job_code', 'FIELD-' || upper(substr(md5(jid::text), 1, 6)), 'created', true, 'ready_state', 'not_ready',
        'supervisor_notice', jsonb_build_object('message_id', msg, 'recipients', coalesce(cardinality(people), 0), 'channel', 'job chat mention'));
    end if;

  elsif a.action = 'save_unit' then
    if jid is null then raise exception 'Choose the job first.'; end if;
    proposed := coalesce(d->'facts', '{}');
    perform public.validate_custom_work_facts(proposed);
    if length(btrim(coalesce(d->>'label', ''))) not between 1 and 120 then raise exception 'Give the unit its number or name.'; end if;
    label_norm := lower(btrim(d->>'label'));
    -- Resolve identity first: a stated id, then a map unit, then a same-named
    -- record. "Start unit four" never makes a second unit four.
    if nullif(d->>'unit_id', '') is not null then
      select * into u from custom_work_units where id = (d->>'unit_id')::uuid for update;
      if u.id is null or u.project_id is distinct from jid then raise exception 'That unit is not on this job.'; end if;
      select * into o from project_openings where id = u.opening_id;
    elsif nullif(d->>'opening_id', '') is not null then
      select * into o from project_openings where id = (d->>'opening_id')::uuid and project_id = jid and removed_at is null;
      if o.id is null then raise exception 'That map unit is not on this job.'; end if;
      select * into u from custom_work_units where opening_id = o.id for update;
    else
      select * into u from custom_work_units where project_id = jid and lower(btrim(label)) = label_norm for update;
      select * into o from project_openings where project_id = jid and removed_at is null and lower(btrim(opening_code)) = label_norm limit 1;
      if u.id is null and o.id is not null then
        select * into u from custom_work_units where opening_id = o.id for update;
      elsif u.id is not null and o.id is not null and u.opening_id is distinct from o.id then
        raise exception 'Two different records use this unit name. Open the job''s unit list and choose the right one.';
      end if;
    end if;
    if u.id is null then
      -- New record. A map unit starts from what the plans say; a spoken value that
      -- disagrees with the plans is shown, never silently chosen.
      plan := case when o.id is not null then public._ai_plan_facts(o.id) else '{}'::jsonb end;
      for k, v in select * from jsonb_each(proposed) loop
        if plan ? k and k in ('width_in','height_in','location') and v is distinct from plan->k
           and (jsonb_typeof(v) <> 'string' or lower(btrim(v #>> '{}')) <> lower(btrim(plan->>k))) then
          conflicts := conflicts || jsonb_build_object(k, jsonb_build_object('plans', plan->k, 'said', v));
        end if;
      end loop;
      if plan ? 'type_label' and nullif(btrim(d->>'type_label'), '') is not null and lower(btrim(d->>'type_label')) <> lower(plan->>'type_label') then
        conflicts := conflicts || jsonb_build_object('type_label', jsonb_build_object('plans', plan->'type_label', 'said', btrim(d->>'type_label')));
      end if;
      if from_confirm and prev->'plan' is distinct from plan then
        res := public._ai_stale('The plans for this unit changed since you chose. Ask again.');
      elsif conflicts <> '{}' and p_choice is null then
        res := public._ai_waiting(jsonb_build_object('reason', 'plan_conflict', 'message', 'The plans say something different for unit ' || o.opening_code || '. Which should the field record use?',
          'plan', plan, 'differences', conflicts, 'map_code', o.opening_code,
          'options', jsonb_build_array(jsonb_build_object('id', 'use_plans', 'label', 'Use the plans'), jsonb_build_object('id', 'use_said', 'label', 'Use what I said (plans stay unchanged)'), jsonb_build_object('id', 'cancel', 'label', 'Cancel'))));
      else
        newfacts := public._ai_plan_seed(plan) || case when p_choice = 'use_plans' then proposed - (select coalesce(array_agg(key), '{}') from jsonb_object_keys(conflicts) key) else proposed end;
        outid := public.custom_work_command(md5(a.id::text || ':unit')::uuid, 'unit', jsonb_build_object('id', a.id, 'revision', 0, 'project_id', jid,
          'opening_id', o.id, 'label', coalesce(o.opening_code, btrim(d->>'label')),
          'type_label', coalesce(case when p_choice = 'use_plans' then plan->>'type_label' end, nullif(btrim(d->>'type_label'), ''), plan->>'type_label', 'Unknown'),
          'facts', newfacts, 'reason', 'Field capture through Forge AI'));
        select * into u from custom_work_units where id = outid;
        res := jsonb_build_object('status', 'done', 'outcome', case when o.id is not null then 'created_from_map' else 'created' end, 'unit', public._ai_unit_json(u), 'project_id', jid,
          'from_plans', nullif(plan, '{}'::jsonb));
      end if;
    else
      can_edit := u.created_by = uid or public._is_lead(uid);
      -- A confirmation answers the record as it was shown. If anyone changed the
      -- unit since, the person has not seen what they would be overwriting.
      if from_confirm and (prev->'unit'->>'revision')::int is distinct from u.revision then
        res := public._ai_stale('Unit ' || u.label || ' changed since you saw this. Nothing was changed; ask again to see the latest details.');
      elsif nullif(d->>'unit_id', '') is not null and lower(btrim(d->>'label')) <> lower(btrim(u.label)) and p_choice is null then
        res := public._ai_waiting(jsonb_build_object('reason', 'identity', 'message', 'You named unit ' || btrim(d->>'label') || ', but the selected record is unit ' || u.label || '. Which is it?',
          'unit', public._ai_unit_json(u), 'options', jsonb_build_array(jsonb_build_object('id', 'keep_original', 'label', 'It is unit ' || u.label), jsonb_build_object('id', 'cancel', 'label', 'Neither — cancel'))));
      else
        for k, v in select * from jsonb_each(proposed) loop
          if k = 'unknown_fields' then continue; end if;
          if not (u.facts ? k) then additions := additions || jsonb_build_object(k, v);
          elsif (jsonb_typeof(v) = 'string' and lower(btrim(v #>> '{}')) is distinct from lower(btrim(u.facts ->> k))) or (jsonb_typeof(v) <> 'string' and v is distinct from u.facts -> k) then
            conflicts := conflicts || jsonb_build_object(k, jsonb_build_object('stored', u.facts -> k, 'said', v));
          end if;
        end loop;
        if nullif(btrim(d->>'type_label'), '') is not null and lower(btrim(d->>'type_label')) <> lower(u.type_label) then
          if u.type_label = 'Unknown' then additions := additions || jsonb_build_object('type_label', btrim(d->>'type_label'));
          else conflicts := conflicts || jsonb_build_object('type_label', jsonb_build_object('stored', u.type_label, 'said', btrim(d->>'type_label'))); end if;
        end if;
        if conflicts <> '{}' and p_choice is null then
          -- D18: say what the record says and what was said; nothing is overwritten.
          res := public._ai_waiting(jsonb_build_object('reason', 'fact_conflict', 'message', 'Unit ' || u.label || ' already has different details. Keep what is saved, or correct the record?',
            'unit', public._ai_unit_json(u), 'differences', conflicts, 'additions', additions, 'can_edit', can_edit,
            'options', jsonb_build_array(jsonb_build_object('id', 'keep_original', 'label', 'Keep the saved details (I misspoke)'))
              || case when can_edit then jsonb_build_array(jsonb_build_object('id', 'correct_record', 'label', 'Correct the unit record')) else '[]'::jsonb end
              || jsonb_build_array(jsonb_build_object('id', 'send_for_review', 'label', 'Keep saved details and send my observation for review'), jsonb_build_object('id', 'cancel', 'label', 'Cancel'))));
        elsif p_choice = 'correct_record' and not can_edit then
          raise exception 'Only the unit''s author or a foreman can correct this record. Send it for review instead.';
        elsif p_choice = 'send_for_review' or (not can_edit and (additions <> '{}' or conflicts <> '{}')) then
          -- The saved record stays as it is; the observation waits in the unit's
          -- history for a foreman. Checked before "unchanged" so a review of
          -- differences alone is never dropped.
          insert into custom_work_history(project_id, actor_id, entity_id, action, before_value, after_value, reason)
          values (jid, uid, u.id, 'ai_observation', jsonb_build_object('type', u.type_label, 'facts', u.facts, 'revision', u.revision),
            jsonb_build_object('additions', additions, 'differences', conflicts, 'request_id', r.id),
            'Crew observation through Forge AI; not applied to the record');
          res := jsonb_build_object('status', 'done', 'outcome', 'sent_for_review', 'unit', public._ai_unit_json(u), 'project_id', jid,
            'observation', jsonb_build_object('additions', additions, 'differences', conflicts),
            'message', 'Saved as an observation for a foreman to review. The unit record is unchanged.');
        else
          newfacts := u.facts || (additions - 'type_label') || case when p_choice = 'correct_record' then (select coalesce(jsonb_object_agg(key, value->'said'), '{}') from jsonb_each(conflicts) where key <> 'type_label') else '{}' end;
          select coalesce(jsonb_agg(distinct x), '[]') into unknowns from (
            select jsonb_array_elements_text(coalesce(u.facts->'unknown_fields', '[]')) x union select jsonb_array_elements_text(coalesce(proposed->'unknown_fields', '[]'))) z
            where not (newfacts ? x) and not (x = 'type_label' and coalesce(additions->>'type_label', u.type_label) <> 'Unknown');
          newfacts := (newfacts - 'unknown_fields') || case when jsonb_array_length(unknowns) > 0 then jsonb_build_object('unknown_fields', unknowns) else '{}' end;
          -- Same facts and the same set of unanswered questions (order aside) is no change.
          if additions = '{}' and (p_choice is distinct from 'correct_record' or conflicts = '{}') and (newfacts - 'unknown_fields') = (u.facts - 'unknown_fields')
             and unknowns = (select coalesce(jsonb_agg(distinct x), '[]') from jsonb_array_elements_text(coalesce(u.facts->'unknown_fields', '[]')) x) then
            res := jsonb_build_object('status', 'done', 'outcome', 'unchanged', 'unit', public._ai_unit_json(u), 'project_id', jid,
              'kept_original', case when p_choice = 'keep_original' then conflicts end);
          else
            outid := public.custom_work_command(md5(a.id::text || ':unit')::uuid, 'unit', jsonb_build_object('id', u.id, 'revision', u.revision, 'project_id', u.project_id,
              'opening_id', u.opening_id, 'label', u.label,
              'type_label', case when p_choice = 'correct_record' and conflicts ? 'type_label' then conflicts->'type_label'->>'said' else coalesce(additions->>'type_label', u.type_label) end,
              'facts', newfacts, 'reason', case when p_choice = 'correct_record' then 'Crew correction through Forge AI' else 'Details added through Forge AI' end));
            select * into u from custom_work_units where id = outid;
            res := jsonb_build_object('status', 'done', 'outcome', case when p_choice = 'correct_record' then 'corrected' else 'details_added' end,
              'unit', public._ai_unit_json(u), 'project_id', jid, 'kept_original', case when p_choice = 'keep_original' then conflicts end);
          end if;
        end if;
      end if;
    end if;

  elsif a.action in ('start_unit','start_idle','stop_work') then
    st := public._ai_clock_state(uid);
    if not from_confirm then
      -- Never act on an old or delayed request, on a phone still sending a clock
      -- change, or on timing that moved at ANY point after the phone last read
      -- it before Send — in transit, on arrival or while the model worked, and
      -- even if it moved back.
      if r.sent_at < now() - interval '5 minutes' or r.received_at < now() - interval '5 minutes' then
        res := public._ai_stale('This request was sent more than five minutes ago, so no timer was changed. Ask again if you still want this.');
      elsif coalesce((snap->>'client_pending_sync')::boolean, false) then
        res := public._ai_stale('Your phone is still sending a job-clock change. Wait until it syncs, then ask again.');
      elsif coalesce((snap->>'changed_after_send')::boolean, true) or (st->>'epoch')::bigint <> (snap->>'epoch')::bigint then
        res := public._ai_stale('Your job clock or a timer changed after you sent this, so I did not change anything. Check the clock and ask again.');
      end if;
    elsif p_choice in ('end_break_and_start','join_helper') and (st->>'epoch')::bigint is distinct from (prev->>'epoch')::bigint then
      res := public._ai_stale('Your clock or timers changed since this question. Nothing was started; ask again.');
    elsif p_choice = 'start_now' and (st->'session' is distinct from prev->'work_session' or st->'work' is distinct from prev->'work') then
      -- Clocking in is the expected change; any other timer that started since is
      -- not ours to stop.
      res := public._ai_stale('Another timer started since this question. It was left running; ask again if you want to switch.');
    end if;
    if res is null then
      select * into sh from time_shifts where id = nullif(st->'shift'->>'id', '')::uuid for update;
      select * into s from custom_work_sessions where profile_id = uid and ended_at is null for update;
      if a.action = 'stop_work' then
        if s.id is null then res := jsonb_build_object('status', 'done', 'outcome', 'already_stopped');
        else
          if d->>'outcome' not in ('finished','partial','blocked','rework') then raise exception 'Was this stage finished, partial, blocked or rework?'; end if;
          outid := public.custom_work_command(md5(a.id::text || ':stop')::uuid, 'stop', jsonb_build_object('expected_session_id', s.id, 'at', now(),
            'outcome', d->>'outcome', 'finish_note', coalesce(nullif(btrim(d->>'note'), ''), s.description)));
          jid := s.project_id;
          res := jsonb_build_object('status', 'done', 'outcome', 'stopped', 'session_id', outid, 'stage', s.stage, 'stage_outcome', d->>'outcome',
            'unit', (select label from custom_work_units where id = s.unit_id), 'stopped_at', now(), 'job_clock_still_running', sh.id is not null,
            'helpers_still_working', (select count(*) from custom_work_sessions where unit_id = s.unit_id and ended_at is null and profile_id <> uid),
            'qc', 'not_approved');
        end if;
      else
        stage := coalesce(nullif(d->>'stage', ''), 'Installing');
        part := case when p_choice = 'join_helper' then 'helper' else coalesce(nullif(d->>'participation', ''), 'install') end;
        if a.action = 'start_idle' then
          if length(btrim(coalesce(d->>'description', ''))) not between 1 and 4000 then raise exception 'Describe the idle time.'; end if;
          jid := coalesce(jid, (sh.project_id));
        else
          if stage not in ('Installing','Preparation','Flashing','Setting frame','Glazing','Hardware','Detail work','Rework') or part not in ('install','helper') then raise exception 'Choose a work stage.'; end if;
          select * into u from custom_work_units where id = nullif(d->>'unit_id', '')::uuid for update;
          if u.id is null or u.project_id is distinct from jid then raise exception 'Choose a unit on this job first.'; end if;
          if lower(btrim(u.type_label)) = 'unknown' then raise exception 'Say what type of unit this is before starting its timer.'; end if;
          -- The map owner is the owner; lock it so dispatch cannot hand it out mid-claim.
          if u.opening_id is not null then select * into o from project_openings where id = u.opening_id for update; end if;
          if (u.facts->>'installation_complete' = 'Yes' or o.status = 'installed') and stage <> 'Rework' then
            raise exception 'Unit % is already finished. Rework starts only as the Rework stage.', u.label;
          end if;
          assignee := case when u.opening_id is not null then o.assigned_to else u.assigned_to end;
          select coalesce(jsonb_agg(pr.display_name order by pr.display_name), '[]') into others from (
            select w.profile_id from custom_work_sessions w where w.unit_id = u.id and w.ended_at is null and w.profile_id <> uid
            union select us.profile_id from unit_sessions us where u.opening_id is not null and us.opening_id = u.opening_id and us.ended_at is null and us.profile_id <> uid) x
            join profiles pr on pr.id = x.profile_id;
        end if;
        if a.action = 'start_unit' and s.id is not null and s.unit_id is not distinct from u.id and s.stage = stage and s.participation = part then
          -- Repeating a start never restarts the timer.
          res := jsonb_build_object('status', 'running', 'outcome', 'already_running', 'session_id', s.id, 'unit', public._ai_unit_json(u), 'started_at', s.started_at, 'stage', s.stage);
        elsif a.action = 'start_unit' and part = 'install' and ((assignee is not null and assignee <> uid) or (assignee is null and jsonb_array_length(others) > 0)) then
          -- D25: occupied work is never silently taken; the person may help instead.
          res := public._ai_waiting(jsonb_build_object('reason', 'claimed', 'message', 'Unit ' || u.label || ' is ' ||
              case when assignee is not null then 'assigned to ' || coalesce((select display_name from profiles where id = assignee), 'someone else') else 'being worked by ' || (select string_agg(x, ', ') from jsonb_array_elements_text(others) x) end
              || '. Join as a helper with your own time?', 'unit', public._ai_unit_json(u), 'working_now', others, 'epoch', (st->>'epoch')::bigint,
            'options', jsonb_build_array(jsonb_build_object('id', 'join_helper', 'label', 'Join as a helper'), jsonb_build_object('id', 'cancel', 'label', 'Cancel'))));
        elsif sh.id is null or sh.status <> 'open' then
          res := public._ai_waiting(jsonb_build_object('reason', 'needs_clock', 'message', 'You are not clocked in. Use the job clock to clock in' ||
              coalesce(' to ' || (select name from projects where id = jid), '') || ', then tap Start now.',
            'unit', case when u.id is not null then public._ai_unit_json(u) end, 'project_id', jid, 'stage', stage, 'work_session', st->'session', 'work', st->'work',
            'options', jsonb_build_array(jsonb_build_object('id', 'start_now', 'label', 'Start now (after clocking in)'), jsonb_build_object('id', 'cancel', 'label', 'Cancel'))));
        elsif jid is not null and sh.project_id is distinct from jid then
          res := public._ai_waiting(jsonb_build_object('reason', 'wrong_job', 'message', 'Use the job clock to switch from ' || coalesce((select name from projects where id = sh.project_id), 'your current job') || ' to ' || (select name from projects where id = jid) || ', then tap Start now. Your time so far stays on ' || coalesce((select name from projects where id = sh.project_id), 'that job') || '.',
            'unit', case when u.id is not null then public._ai_unit_json(u) end, 'project_id', jid, 'current_job', (select name from projects where id = sh.project_id), 'stage', stage,
            'work_session', st->'session', 'work', st->'work',
            'options', jsonb_build_array(jsonb_build_object('id', 'start_now', 'label', 'Start now (after switching jobs)'), jsonb_build_object('id', 'cancel', 'label', 'Cancel'))));
        elsif sh.break_started_at is not null and p_choice is distinct from 'end_break_and_start' then
          res := public._ai_waiting(jsonb_build_object('reason', 'on_break', 'message', 'End your break and start ' || coalesce('unit ' || u.label, 'idle time') || '?',
            'unit', case when u.id is not null then public._ai_unit_json(u) end, 'stage', stage, 'epoch', (st->>'epoch')::bigint,
            'options', jsonb_build_array(jsonb_build_object('id', 'end_break_and_start', 'label', 'End break and start ' || coalesce('unit ' || u.label, 'idle time')), jsonb_build_object('id', 'cancel', 'label', 'Stay on break'))));
        elsif not from_confirm and not coalesce((snap->>'send_time_eligible')::boolean, false) then
          -- Nothing changed, but the phone's clock puts Send before this shift or
          -- before the last change it had seen: the send time cannot be trusted,
          -- so the person decides to start now rather than we guess a time.
          res := public._ai_waiting(jsonb_build_object('reason', 'confirm_time', 'message', 'This phone''s clock does not match the server, so the time you sent this cannot be used. Start ' || coalesce('unit ' || u.label, 'idle time') || ' now?',
            'unit', case when u.id is not null then public._ai_unit_json(u) end, 'project_id', jid, 'stage', stage, 'work_session', st->'session', 'work', st->'work', 'device_sent_at', r.sent_at,
            'options', jsonb_build_array(jsonb_build_object('id', 'start_now', 'label', 'Start now'), jsonb_build_object('id', 'cancel', 'label', 'Cancel'))));
        else
          if p_choice = 'end_break_and_start' then
            perform public.end_break(sh.id);
            select * into sh from time_shifts where id = sh.id;
          end if;
          -- D16: the send time, only for an unchanged request sent on this open
          -- shift. A resume, a switch or a later tap starts now, never backdated.
          at_time := case when not from_confirm then r.sent_at else now() end;
          if s.id is not null and at_time < s.started_at then
            -- The running timer began after the words were said; the epoch should
            -- already have refused this, and it is never restamped to "now".
            raise exception 'Your current timer started after this request was sent. Ask again.';
          end if;
          outid := public.custom_work_command(md5(a.id::text || ':start')::uuid, 'start', jsonb_build_object('id', md5(a.id::text || ':session')::uuid,
            'unit_id', u.id, 'shift_id', sh.id, 'project_id', jid, 'expected_session_id', s.id, 'stage', stage, 'participation', part,
            'description', case when a.action = 'start_idle' then btrim(d->>'description') else '' end, 'at', at_time));
          if a.action = 'start_unit' and part = 'install' and assignee is null then
            if u.opening_id is not null then
              perform set_config('app.assignment_via', 'map', true);
              update project_openings set assigned_to = uid, assigned_by = uid, assigned_at = now() where id = u.opening_id and assigned_to is null;
            else
              update custom_work_units set assigned_to = uid, assigned_at = now(), revision = revision + 1, updated_at = now() where id = u.id and assigned_to is null;
            end if;
            insert into custom_work_history(project_id, actor_id, entity_id, action, before_value, after_value, reason)
            values (jid, uid, u.id, 'claim', jsonb_build_object('assigned_to', null), jsonb_build_object('assigned_to', uid, 'map_opening', u.opening_id), 'Claimed through Forge AI');
          end if;
          if u.id is not null then select * into u from custom_work_units where id = u.id; end if;
          res := jsonb_build_object('status', 'running', 'outcome', 'started', 'session_id', outid, 'unit', case when u.id is not null then public._ai_unit_json(u) end,
            'project_id', jid, 'stage', case when a.action = 'start_idle' then 'Idle time' else stage end, 'participation', part, 'started_at', at_time,
            'start_time_basis', case when not from_confirm then 'request_sent' else 'tapped_start' end, 'device_sent_at', r.sent_at,
            'previous_timer_ended', s.id is not null, 'break_ended', p_choice = 'end_break_and_start',
            'claimed', a.action = 'start_unit' and part = 'install' and assignee is null);
        end if;
      end if;
    end if;

  elsif a.action = 'release_unit' then
    select * into u from custom_work_units where id = nullif(d->>'unit_id', '')::uuid for update;
    if u.id is null or u.project_id is distinct from jid then raise exception 'Choose a unit on this job first.'; end if;
    if u.opening_id is not null then select * into o from project_openings where id = u.opening_id for update; assignee := o.assigned_to; else assignee := u.assigned_to; end if;
    if assignee is null then res := jsonb_build_object('status', 'done', 'outcome', 'not_assigned', 'unit', public._ai_unit_json(u));
    elsif assignee <> uid and not public._is_lead(uid) then raise exception 'Only the assigned installer or a foreman can release this unit.';
    elsif exists (select 1 from custom_work_sessions where unit_id = u.id and profile_id = uid and ended_at is null) then raise exception 'Stop your timer on this unit before releasing it.';
    else
      if u.opening_id is not null then
        update project_openings set assigned_to = null, assigned_by = null, assigned_at = null where id = u.opening_id;
      else
        update custom_work_units set assigned_to = null, assigned_at = null, revision = revision + 1, updated_at = now() where id = u.id;
      end if;
      insert into custom_work_history(project_id, actor_id, entity_id, action, before_value, after_value, reason)
      values (jid, uid, u.id, 'release', jsonb_build_object('assigned_to', assignee), jsonb_build_object('assigned_to', null), 'Released through Forge AI');
      select * into u from custom_work_units where id = u.id;
      res := jsonb_build_object('status', 'done', 'outcome', 'released', 'unit', public._ai_unit_json(u),
        'helpers_still_working', (select count(*) from custom_work_sessions where unit_id = u.id and ended_at is null));
    end if;

  elsif a.action = 'crew_record' then
    if not public._is_lead(uid) then raise exception 'Only an active foreman, supervisor or owner can record work for the crew.' using errcode = '42501'; end if;
    if jid is null then raise exception 'Choose the job first.'; end if;
    if nullif(d->>'unit_id', '') is not null then
      select * into u from custom_work_units where id = (d->>'unit_id')::uuid;
      if u.id is null or u.project_id is distinct from jid then raise exception 'That unit is not on this job.'; end if;
    else
      select * into u from custom_work_units where project_id = jid and lower(btrim(label)) = lower(btrim(d->>'label'));
      if u.id is null then
        select * into o from project_openings where project_id = jid and removed_at is null and lower(btrim(opening_code)) = lower(btrim(d->>'label')) limit 1;
        if o.id is not null then select * into u from custom_work_units where opening_id = o.id; end if;
      end if;
    end if;
    plan := case when u.id is null and o.id is not null then public._ai_plan_facts(o.id) else '{}'::jsonb end;
    -- Existing facts go through unchanged: a crew record never corrects a unit.
    outid := public.record_crew_work(md5(a.id::text || ':crew')::uuid, jsonb_build_object(
      'unit', case when u.id is not null then jsonb_build_object('id', u.id, 'revision', u.revision, 'project_id', u.project_id, 'opening_id', u.opening_id, 'label', u.label, 'type_label', u.type_label, 'facts', u.facts)
               else jsonb_build_object('id', a.id, 'revision', 0, 'project_id', jid, 'opening_id', o.id, 'label', coalesce(o.opening_code, btrim(d->>'label')),
                 'type_label', coalesce(plan->>'type_label', nullif(btrim(d->>'type_label'), ''), 'Unknown'), 'facts', public._ai_plan_seed(plan), 'reason', 'Crew record through Forge AI') end,
      'people', d->'people', 'work_date', d->>'work_date', 'stage', d->>'stage', 'outcome', d->>'outcome', 'description', coalesce(d->>'description', ''), 'whole_complete', false));
    res := jsonb_build_object('status', 'done', 'outcome', 'crew_recorded', 'record_id', md5(a.id::text || ':crew')::uuid, 'unit', (select public._ai_unit_json(x) from custom_work_units x where id = outid),
      'people', (select jsonb_agg(display_name order by display_name) from profiles where id::text in (select jsonb_array_elements_text(d->'people'))),
      'work_date', d->>'work_date', 'stage', d->>'stage', 'stage_outcome', d->>'outcome', 'payroll_changed', false);
  else
    raise exception 'Unsupported field action.';
  end if;

  res := res || jsonb_build_object('action_id', a.id, 'action', a.action, 'request_id', a.request_id);
  update ai_field_actions set project_id = coalesce(jid, project_id), result = res, choice = coalesce(p_choice, choice),
    status = case res->>'status' when 'needs_choice' then 'waiting' when 'stale' then 'stale' else 'done' end,
    resolved_at = case when res->>'status' = 'needs_choice' then null else now() end
  where id = a.id;
  return res;
end $$;
revoke all on function public._ai_field_apply(uuid, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6. The two doors: the assistant asks, the person decides
-- ---------------------------------------------------------------------------
create function public.ai_field_command(p_request uuid, p_key text, p_action text, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := public._ai_field_actor(); r ai_field_requests; aid uuid; a ai_field_actions;
begin
  select * into r from ai_field_requests where id = p_request;
  if r.id is null or r.profile_id <> uid then raise exception 'This request belongs to another account.' using errcode = '42501'; end if;
  if r.finished_at is not null then raise exception 'This request is finished. Send a new message.'; end if;
  if p_data is null or jsonb_typeof(p_data) <> 'object' or octet_length(p_data::text) > 40000 then raise exception 'Invalid action details.'; end if;
  if p_key is null or length(p_key) not between 1 and 300 then raise exception 'Invalid action key.'; end if;
  aid := md5(p_request::text || ':' || p_key)::uuid;
  perform pg_advisory_xact_lock(hashtextextended(aid::text, 7593));
  select * into a from ai_field_actions where id = aid;
  if found then
    -- Same action retried: the saved receipt. Different details under the same
    -- key: refuse, and show what was already done.
    if a.action <> p_action or a.data <> p_data then
      return a.result || jsonb_build_object('replay', 'changed', 'message', 'This request already did something different. Send a new message to change it.');
    end if;
    return a.result || jsonb_build_object('replay', 'same');
  end if;
  -- A stop or idle start names no job; file it under the running shift/timer so
  -- the receipt sits behind the same job boundary (and sandbox fence).
  insert into ai_field_actions(id, request_id, profile_id, project_id, action, action_key, data)
  values (aid, p_request, uid, coalesce(nullif(p_data->>'project_id', '')::uuid,
    case when p_action = 'stop_work' then (select project_id from custom_work_sessions where profile_id = uid and ended_at is null)
         when p_action = 'start_idle' then (select project_id from time_shifts where profile_id = uid and status = 'open' and clock_out_at is null order by clock_in_at desc limit 1) end),
    p_action, p_key, p_data);
  return public._ai_field_apply(aid, null);
end $$;
revoke all on function public.ai_field_command(uuid, text, text, jsonb) from public, anon;
grant execute on function public.ai_field_command(uuid, text, text, jsonb) to authenticated;

-- Called from the person's own screen when they tap a choice. Not offered to the
-- model as a tool; the hash ties the tap to the exact preview it answered.
create function public.ai_field_resolve(p_action uuid, p_choice text, p_preview_hash text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := public._ai_field_actor(); a ai_field_actions;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_action::text, 7593));
  select * into a from ai_field_actions where id = p_action;
  if a.id is null or a.profile_id <> uid then raise exception 'This choice belongs to another account.' using errcode = '42501'; end if;
  if a.status <> 'waiting' then return a.result; end if;
  if p_preview_hash is distinct from a.result->>'preview_hash' then raise exception 'This choice changed. Review the latest card before choosing.'; end if;
  if not exists (select 1 from jsonb_array_elements(a.result->'options') x where x->>'id' = p_choice) then raise exception 'Choose one of the options shown.'; end if;
  if p_choice = 'cancel' then
    update ai_field_actions set status = 'cancelled', choice = 'cancel', resolved_at = now(),
      result = result - 'options' - 'preview_hash' || jsonb_build_object('status', 'cancelled') where id = a.id;
    return (select result from ai_field_actions where id = a.id);
  end if;
  return public._ai_field_apply(a.id, p_choice);
end $$;
revoke all on function public.ai_field_resolve(uuid, text, text) from public, anon;
grant execute on function public.ai_field_resolve(uuid, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. Foreman crew records name who worked, not who is on site today
-- ---------------------------------------------------------------------------
-- Restated from 20261023000000 with one change: a person is eligible when their
-- login is current (not retired, access not removed), not when they are marked
-- On site. Someone who installed yesterday can be off today.
create or replace function public.record_crew_work(p_id uuid,p_data jsonb) returns uuid
language plpgsql security definer set search_path=public,pg_temp as $$
declare
  uid uuid:=auth.uid(); receipt public.custom_work_commands;
  unit_data jsonb; unit_id uuid; job_id uuid; people uuid[]; work_day date;
  result_id uuid; existing public.custom_work_units; person uuid;
  record_payload jsonb:=jsonb_build_object('action','crew_record','data',p_data);
begin
  if not public.custom_work_internal() or not public._is_lead(uid) then
    raise exception 'Only an active foreman, supervisor or owner can record work for the crew.' using errcode='42501';
  end if;
  if p_id is null or p_data is null or jsonb_typeof(p_data)<>'object' then raise exception 'Invalid crew record.'; end if;
  -- Same receipt lock as custom_work_command; safe after a lost response or two tabs.
  perform pg_advisory_xact_lock(hashtextextended(p_id::text,7282));
  select * into receipt from public.custom_work_commands where id=p_id;
  if found then
    if receipt.profile_id<>uid or receipt.payload<>record_payload then raise exception 'This retry belongs to a different request.'; end if;
    return receipt.result_id;
  end if;
  perform pg_advisory_xact_lock(hashtextextended(uid::text,7281));
  unit_data:=p_data->'unit';
  if jsonb_typeof(unit_data) is distinct from 'object' then raise exception 'Choose or build a unit.'; end if;
  unit_id:=(unit_data->>'id')::uuid;
  job_id:=(unit_data->>'project_id')::uuid;
  if unit_id is null or job_id is null then raise exception 'Choose a job and a unit.'; end if;
  -- Prevent two new records creating duplicate labels concurrently on the same job.
  perform pg_advisory_xact_lock(hashtextextended(job_id::text,7285));
  select * into existing from public.custom_work_units where id=unit_id for update;
  if existing.id is not null and (existing.project_id is distinct from job_id or existing.opening_id is distinct from nullif(unit_data->>'opening_id','')::uuid) then
    raise exception 'Use Unit details to move or link an existing unit before recording crew work.';
  end if;
  if length(btrim(coalesce(unit_data->>'label','')))=0 then raise exception 'Enter a unit number or name.'; end if;
  if existing.id is null and exists(select 1 from public.custom_work_units where project_id=job_id and lower(btrim(label))=lower(btrim(unit_data->>'label'))) then
    raise exception 'A unit with this name already exists. Select it, or include the building/floor for a different unit.';
  end if;
  if existing.id is null and nullif(unit_data->>'opening_id','') is null and exists(select 1 from public.project_openings where project_id=job_id and removed_at is null and lower(btrim(opening_code))=lower(btrim(unit_data->>'label'))) then
    raise exception 'This unit is already on the map. Select the map unit instead of creating a duplicate.';
  end if;
  if jsonb_typeof(p_data->'people') is distinct from 'array' or jsonb_array_length(p_data->'people') not between 1 and 100 then raise exception 'Select the people who did or will do this work.'; end if;
  select array_agg(distinct value::uuid) into people from jsonb_array_elements_text(p_data->'people');
  foreach person in array people loop
    if person is null or not exists(select 1 from public.profiles where id=person and retired_at is null and access_revoked_at is null and not coalesce(is_partner,false) and role in ('installer','foreman','supervisor','owner')) then
      raise exception 'Choose Forge crew members with current access.';
    end if;
  end loop;
  work_day:=(p_data->>'work_date')::date;
  if work_day is null or work_day<date '2000-01-01' or work_day>date '2100-12-31' then raise exception 'Choose a valid work date.'; end if;
  if p_data->>'outcome' is null or p_data->>'outcome' not in ('assigned','partial','finished') then raise exception 'Choose assigned, partial or stage complete.'; end if;
  if p_data->>'outcome'<>'assigned' and work_day>(now() at time zone 'America/Denver')::date then raise exception 'Completed work cannot have a future date.'; end if;
  if p_data->>'stage' is null or p_data->>'stage' not in ('RO checked','Installing','Preparation','Flashing','Setting frame','Glazing','Hardware','Detail work','Rework') then raise exception 'Choose the work stage.'; end if;
  if length(coalesce(p_data->>'description',''))>4000 then raise exception 'Keep the description under 4000 characters.'; end if;
  if coalesce((p_data->>'whole_complete')::boolean,false) then
    if p_data->>'stage'<>'Installing' or p_data->>'outcome'<>'finished' then raise exception 'Whole installation completion requires the Installing stage to be finished.'; end if;
    unit_data:=jsonb_set(unit_data,'{facts}',coalesce(unit_data->'facts','{}') || '{"installation_complete":"Yes"}'::jsonb);
  end if;
  -- Existing unit command supplies role, job, map link, facts and revision checks.
  -- The unit and report commit together, or neither does. No finish_unit or session commands.
  result_id:=public.custom_work_command(p_id,'unit',unit_data);
  if p_data->>'outcome'<>'assigned' then
    update public.custom_work_units set untimed_work_present=true where id=result_id;
  end if;
  insert into public.crew_work_records(id,project_id,unit_id,filed_by,work_date,stage,outcome,whole_complete,description)
  values(p_id,job_id,result_id,uid,work_day,p_data->>'stage',p_data->>'outcome',coalesce((p_data->>'whole_complete')::boolean,false),coalesce(p_data->>'description',''));
  insert into public.crew_work_record_people(record_id,profile_id) select p_id,unnest(people);
  update public.custom_work_commands set payload=record_payload where id=p_id;
  insert into public.custom_work_history(project_id,actor_id,entity_id,action,after_value,reason)
  values(job_id,uid,result_id,'crew_record',jsonb_build_object('record_id',p_id,'people',people,'work_date',work_day,'stage',p_data->>'stage','outcome',p_data->>'outcome','description',coalesce(p_data->>'description','')),'Foreman crew record; no payroll changes');
  return result_id;
end; $$;
revoke all on function public.record_crew_work(uuid,jsonb) from public,anon;
grant execute on function public.record_crew_work(uuid,jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 8. Original recordings
-- ---------------------------------------------------------------------------
-- <uid>/<request id>/memo.<ext>. Written once by the speaker; readable by them and
-- by supervisors/owners. No overwrite or delete: corrections are new requests.
-- Retention: kept with the request. A login with requests is retired rather than
-- deleted (person_record_counts), so no byte is orphaned; there is no automatic
-- byte-deletion path yet (docs/ai-field-operations.md, "Known gaps").
insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('ai-field-memos', 'ai-field-memos', false, 8388608, array['audio/webm','audio/mp4','audio/ogg','audio/mpeg','audio/wav','audio/x-wav'])
on conflict (id) do nothing;
create policy ai_field_memos_read on storage.objects for select to authenticated using (
  bucket_id = 'ai-field-memos' and not public.is_partner_user() and public.custom_work_internal()
  and (split_part(name, '/', 1) = auth.uid()::text or public._is_supervisor(auth.uid())));
create policy ai_field_memos_insert on storage.objects for insert to authenticated with check (
  bucket_id = 'ai-field-memos' and not public.is_partner_user() and public.custom_work_internal() and split_part(name, '/', 1) = auth.uid()::text);
create policy ai_field_memos_read_boundary on storage.objects as restrictive for select to authenticated using (
  bucket_id <> 'ai-field-memos' or (not public.is_partner_user() and public.custom_work_internal()
  and (split_part(name, '/', 1) = auth.uid()::text or public._is_supervisor(auth.uid()))));
create policy ai_field_memos_insert_boundary on storage.objects as restrictive for insert to authenticated with check (
  bucket_id <> 'ai-field-memos' or (not public.is_partner_user() and public.custom_work_internal() and split_part(name, '/', 1) = auth.uid()::text));
create policy ai_field_memos_immutable_update on storage.objects as restrictive for update to authenticated using (bucket_id <> 'ai-field-memos') with check (bucket_id <> 'ai-field-memos');
create policy ai_field_memos_immutable_delete on storage.objects as restrictive for delete to authenticated using (bucket_id <> 'ai-field-memos');

-- Recordings nobody's request points at: uploaded but never sent (transcription
-- failed and the phone copy was discarded), or whose request row went with a
-- deleted login. Removing them is claim → delete bytes → finish:
--  * The claim writes a marker per recording while holding the same per-path
--    lock ai_field_begin takes to attach a recording. Whichever commits first
--    wins: a request that attached it first is never claimed; a recording
--    claimed first can no longer be attached ("record it again").
--  * Bytes are deleted through the Storage API (deleting a storage.objects row
--    leaves the file), then finish clears the marker only if the object is
--    really gone. A failed deletion keeps its marker and is retried; a claim
--    whose worker died is re-claimable after an hour.
-- 90 days' grace: an unsent recording can be unfinished field evidence (no
-- signal for days, transcription failing, a phone kept in a truck), and the
-- phone's own copy retries on the same path. After a cleanup completes, the
-- marker is gone, so a phone that still holds the original can upload it again
-- to the same path and send it normally.
create table public.ai_field_memo_cleanup (
  name text primary key,
  lease uuid,
  claimed_at timestamptz not null default now(),
  attempts integer not null default 0,
  last_error text
);
alter table public.ai_field_memo_cleanup enable row level security;
revoke all on public.ai_field_memo_cleanup from public, anon, authenticated;

-- A phone may retry its original path once cleanup finishes, never while the
-- Storage API is still removing the old bytes. The same lock also serializes
-- insertion against a cleanup claim.
create function public.ai_field_guard_memo_upload() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.bucket_id = 'ai-field-memos' then
    perform pg_advisory_xact_lock(hashtextextended(new.name, 7594));
    if exists (select 1 from ai_field_memo_cleanup where name = new.name) then
      raise exception 'This recording is being removed. Retry after cleanup finishes.';
    end if;
  end if;
  return new;
end $$;
revoke all on function public.ai_field_guard_memo_upload() from public, anon, authenticated;
create trigger ai_field_memo_upload_guard before insert on storage.objects
for each row execute function public.ai_field_guard_memo_upload();


create function public.ai_field_claim_orphan_memos(p_lease uuid, p_limit int default 50) returns setof text
language plpgsql security definer set search_path = public, pg_temp as $$
declare n text;
begin
  if p_lease is null then raise exception 'A lease is required.'; end if;
  for n in
    select o.name from storage.objects o
    where o.bucket_id = 'ai-field-memos' and o.created_at < now() - interval '90 days'
      and not exists (select 1 from ai_field_requests r where r.audio_path = o.name)
      and not exists (select 1 from ai_field_memo_cleanup c where c.name = o.name and c.lease is not null and c.claimed_at > now() - interval '1 hour')
    order by o.created_at limit greatest(1, least(coalesce(p_limit, 50), 200))
  loop
    perform pg_advisory_xact_lock(hashtextextended(n, 7594));
    -- Re-check under the lock: a request may have attached it a moment ago.
    if exists (select 1 from ai_field_requests r where r.audio_path = n) then continue; end if;
    -- The cursor's lease check may predate waiting for another sweeper's lock.
    if exists (select 1 from ai_field_memo_cleanup c where c.name = n
      and c.lease is not null and c.claimed_at > now() - interval '1 hour') then continue; end if;
    if not exists (select 1 from storage.objects o where o.bucket_id = 'ai-field-memos'
      and o.name = n and o.created_at < now() - interval '90 days') then continue; end if;
    insert into ai_field_memo_cleanup(name, lease, claimed_at, attempts) values (n, p_lease, now(), 1)
    on conflict (name) do update set lease = p_lease, claimed_at = now(), attempts = ai_field_memo_cleanup.attempts + 1;
    return next n;
  end loop;
end $$;
revoke all on function public.ai_field_claim_orphan_memos(uuid, int) from public, anon, authenticated;
grant execute on function public.ai_field_claim_orphan_memos(uuid, int) to service_role;

create function public.ai_field_finish_memo_cleanup(p_lease uuid, p_failed jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare removed int; retried int;
begin
  -- Gone from storage: the marker has done its job.
  delete from ai_field_memo_cleanup c where c.lease = p_lease
    and not exists (select 1 from storage.objects o where o.bucket_id = 'ai-field-memos' and o.name = c.name);
  get diagnostics removed = row_count;
  -- Still there (deletion failed or was skipped): keep the marker, free the lease.
  update ai_field_memo_cleanup c set lease = null, last_error = left(coalesce(p_failed ->> c.name, 'not removed'), 500)
  where c.lease = p_lease;
  get diagnostics retried = row_count;
  return jsonb_build_object('removed', removed, 'retry', retried);
end $$;
revoke all on function public.ai_field_finish_memo_cleanup(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.ai_field_finish_memo_cleanup(uuid, jsonb) to service_role;

-- Who runs it: the nightly GitHub workflow ai-field-memo-sweep.yml, with the
-- repository's existing service-role secret (as vault-sync does). Only that key
-- can call these two functions; there is no open endpoint and no pg_cron job.

-- ---------------------------------------------------------------------------
-- 9. Registrations: person removal counts, sandbox fence
-- ---------------------------------------------------------------------------
create or replace function public.person_record_counts(p_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'ai_field_requests.profile_id', (select count(*) from ai_field_requests where profile_id = p_id),
    'ai_field_actions.profile_id', (select count(*) from ai_field_actions where profile_id = p_id),
    'crew_work_records.filed_by', (select count(*) from crew_work_records where filed_by = p_id),
    'crew_work_record_people.profile_id', (select count(*) from crew_work_record_people where profile_id = p_id),
 'hex_portal_cases.asker_id',(select count(*) from public.hex_portal_cases where asker_id=p_id),
 'hex_portal_outcomes.actor_id',(select count(*) from public.hex_portal_outcomes where actor_id=p_id),
 'hex_portal_guidance_receipts.actor_id',(select count(*) from public.hex_portal_guidance_receipts where actor_id=p_id),'time_off_requests.profile_id',(select count(*) from time_off_requests where profile_id=p_id),'crew_reminders.profile_id',(select count(*) from crew_reminders where profile_id=p_id)) || jsonb_build_object('service_visits.created_by',(select count(*) from service_visits where created_by=p_id),'service_visit_units.created_by',(select count(*) from service_visit_units where created_by=p_id),'service_time_sessions.profile_id',(select count(*) from service_time_sessions where profile_id=p_id),'service_media.created_by',(select count(*) from service_media where created_by=p_id),'service_audit.actor_id',(select count(*) from service_audit where actor_id=p_id),'service_commands.profile_id',(select count(*) from service_commands where profile_id=p_id)) || jsonb_build_object(
    'custom_work_units.created_by', (select count(*) from custom_work_units where created_by = p_id),
    'custom_work_sessions.profile_id', (select count(*) from custom_work_sessions where profile_id = p_id),
    'custom_work_history.actor_id', (select count(*) from custom_work_history where actor_id = p_id),
    'custom_work_commands.profile_id', (select count(*) from custom_work_commands where profile_id = p_id),

    'workflow_plans.created_by', (select count(*) from workflow_plans where created_by = p_id),
    'workflow_plan_revisions.actor', (select count(*) from workflow_plan_revisions where actor = p_id),
    'workflow_notice_outbox.profile_id', (select count(*) from workflow_notice_outbox where profile_id = p_id),
    -- Time and money.
    'time_shifts.profile_id',
      (select count(*) from time_shifts where profile_id = p_id),
    'unit_sessions.profile_id',
      (select count(*) from unit_sessions where profile_id = p_id),
    'install_events.installer_id',
      (select count(*) from install_events where installer_id = p_id),
    'install_events.credited_to',
      (select count(*) from install_events where credited_to = p_id),
    'receipts.uploaded_by',
      (select count(*) from receipts where uploaded_by = p_id),
    'pay_rates.profile_id',
      (select count(*) from pay_rates where profile_id = p_id),
    'overtime_rules.profile_id',
      (select count(*) from overtime_rules where profile_id = p_id),
    'timecard_periods.profile_id',
      (select count(*) from timecard_periods where profile_id = p_id),
    'time_shift_edits.edited_by',
      (select count(*) from time_shift_edits where edited_by = p_id),
    -- Safety and training.
    'certifications.profile_id',
      (select count(*) from certifications where profile_id = p_id),
    'toolbox_completions.profile_id',
      (select count(*) from toolbox_completions where profile_id = p_id),
    'safety_acks.profile_id',
      (select count(*) from safety_acks where profile_id = p_id),
    'capability_badges.installer_id',
      (select count(*) from capability_badges where installer_id = p_id),
    'installer_clearance.installer_id',
      (select count(*) from installer_clearance where installer_id = p_id),
    'learn_progress.profile_id',
      (select count(*) from learn_progress where profile_id = p_id),
    'learning_video_quiz_attempts.profile_id',
      (select count(*) from learning_video_quiz_attempts where profile_id = p_id),
    'education_credits.profile_id',
      (select count(*) from education_credits where profile_id = p_id),
    -- The job site.
    'daily_logs.filed_by',
      (select count(*) from daily_logs where filed_by = p_id),
    'opening_phases.started_by',
      (select count(*) from opening_phases where started_by = p_id),
    'opening_phases.submitted_by',
      (select count(*) from opening_phases where submitted_by = p_id),
    'flash_run_assignments.assigned_by',
      (select count(*) from flash_run_assignments where assigned_by = p_id),
    'flash_run_assignments.profile_id',
      (select count(*) from flash_run_assignments where profile_id = p_id),
    'summons.requested_by',
      (select count(*) from summons where requested_by = p_id),
    'summon_helpers.profile_id',
      (select count(*) from summon_helpers where profile_id = p_id),
    'summon_declines.profile_id',
      (select count(*) from summon_declines where profile_id = p_id),
    'unit_redos.pressed_by',
      (select count(*) from unit_redos where pressed_by = p_id),
    'schedule_assignment_members.profile_id',
      (select count(*) from schedule_assignment_members where profile_id = p_id),
    'trip_crew.profile_id',
      (select count(*) from trip_crew where profile_id = p_id),
    'vehicle_drivers.profile_id',
      (select count(*) from vehicle_drivers where profile_id = p_id),
    -- What they said and what they were given credit for.
    'points_ledger.profile_id',
      (select count(*) from points_ledger where profile_id = p_id),
    'task_sessions.profile_id',
      (select count(*) from task_sessions where profile_id = p_id),
    'project_messages.author_id',
      (select count(*) from project_messages where author_id = p_id),
    'ask_question_log.asker_id',
      (select count(*) from ask_question_log where asker_id = p_id)
  );
$$;
revoke all on function public.person_record_counts(uuid) from public,anon,authenticated;
grant execute on function public.person_record_counts(uuid) to service_role;

select public.attach_sandbox_guards();
commit;
