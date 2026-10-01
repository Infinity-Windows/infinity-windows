-- Job-scoped QC reads and optimistic decisions. Existing phones retain the
-- four-argument command and direct-write compatibility, without new authority.
-- A version is a state token, not a decision or a timestamp. Adding the column
-- backfills existing rows without UPDATE triggers or historical review events.
alter table public.qc_checks
  add column review_version uuid not null default gen_random_uuid();
alter table public.qc_decision_events add column review_expected_version text;
alter table public.qc_decision_events add column review_project_id uuid;
alter table public.qc_decision_events add constraint qc_review_expected_version_check
  check ((review_expected_version is null) = (review_project_id is null)
    and (review_expected_version is null or review_expected_version = 'none'
      or review_expected_version ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'));

create function public.qc_stamp_review_version() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  -- This runs AFTER qc_stamp_legacy_reviewer (alphabetical trigger ordering),
  -- so a legacy no-op stays a no-op and forged reviewer/time are already fixed.
  if tg_op = 'INSERT' then
    new.review_version := gen_random_uuid();
  elsif coalesce(current_setting('app.qc_rpc', true), '') = '1'
      or row(new.status, new.note, new.checked_by, new.checked_at)
      is distinct from row(old.status, old.note, old.checked_by, old.checked_at) then
    new.review_version := gen_random_uuid();
  else
    new.review_version := old.review_version;
  end if;
  return new;
end $$;
revoke all on function public.qc_stamp_review_version() from public, anon, authenticated;
create trigger qc_stamp_review_version before insert or update on public.qc_checks
  for each row execute function public.qc_stamp_review_version();

-- Private shared implementation keeps history, reviewer stamping, idempotency,
-- and point resolution in one place. NULL expected version is the old contract.
create function public._record_qc_review_decision(
  p_decision_id uuid, p_opening_id uuid, p_status text, p_note text,
  p_expected_review_version text, p_project_id uuid
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_actor uuid := auth.uid();
  v_existing public.qc_decision_events;
  v_inserted uuid;
  v_written uuid;
  v_at timestamptz;
  v_note text := nullif(btrim(p_note), '');
  v_guarded boolean := p_expected_review_version is not null;
  v_previous_rpc text := current_setting('app.qc_rpc', true);
begin
  if p_decision_id is null or p_opening_id is null then
    raise exception 'A QC decision and opening are required.' using errcode = '22023';
  end if;
  if p_status is null or p_status not in ('passed', 'callback') then
    raise exception 'Choose Pass or Callback.' using errcode = '22023';
  end if;
  if length(coalesce(v_note, '')) > 4000 then
    raise exception 'Keep the QC note under 4,000 characters.' using errcode = '22023';
  end if;
  if v_actor is null or not public.qc_actor_can_review() then
    raise exception 'Only an active foreman, supervisor or owner can review QC.' using errcode = '42501';
  end if;
  if v_guarded then
    if p_project_id is null or (p_expected_review_version <> 'none'
      and p_expected_review_version !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
      raise exception 'A job and valid QC review version are required.' using errcode = '22023';
    end if;
    if not public._ai_job_visible(p_project_id, v_actor)
      or not exists (select 1 from public.projects p where p.id = p_project_id
        and 'data' = any(p.allowed_modes)) then
      raise exception 'This job is unavailable for QC.' using errcode = '42501';
    end if;
    if not exists (select 1 from public.project_openings o
      where o.id = p_opening_id and o.project_id = p_project_id) then
      raise exception 'This unit is unavailable on the selected job.' using errcode = '22023';
    end if;
  end if;

  -- Replay is checked before freshness. An acknowledged request remains saved
  -- even if another reviewer has since made a different decision.
  select * into v_existing from public.qc_decision_events where id = p_decision_id;
  if found then
    if v_existing.project_opening_id is distinct from p_opening_id
      or v_existing.status is distinct from p_status
      or v_existing.note is distinct from v_note
      or v_existing.reviewer_id is distinct from v_actor
      or v_existing.source <> 'review'
      or (v_guarded and (v_existing.review_expected_version is distinct from p_expected_review_version
        or v_existing.review_project_id is distinct from p_project_id)) then
      raise exception 'This QC request ID was already used for another decision.' using errcode = '23505';
    end if;
    return v_existing.id;
  end if;

  perform 1 from public.project_openings o
    where o.id = p_opening_id and o.status = 'installed' and o.removed_at is null
      and (not v_guarded or o.project_id = p_project_id)
    -- Legacy history inserts acquire an implicit FK KEY SHARE on this opening.
    -- NO KEY UPDATE still serializes status/QC commands without blocking that
    -- FK check while this command waits for a legacy writer's QC row lock.
    for no key update;
  if not found then
    raise exception 'This installed unit is unavailable for QC.' using errcode = '22023';
  end if;
  v_at := clock_timestamp();
  insert into public.qc_decision_events
    (id, project_opening_id, status, note, reviewer_id, decided_at, source, review_expected_version, review_project_id)
    values (p_decision_id, p_opening_id, p_status, v_note, v_actor, v_at, 'review', p_expected_review_version, p_project_id)
    on conflict (id) do nothing returning id into v_inserted;
  if v_inserted is null then
    select * into v_existing from public.qc_decision_events where id = p_decision_id;
    if v_existing.project_opening_id is distinct from p_opening_id
      or v_existing.status is distinct from p_status
      or v_existing.note is distinct from v_note
      or v_existing.reviewer_id is distinct from v_actor
      or v_existing.source <> 'review'
      or (v_guarded and (v_existing.review_expected_version is distinct from p_expected_review_version
        or v_existing.review_project_id is distinct from p_project_id)) then
      raise exception 'This QC request ID was already used for another decision.' using errcode = '23505';
    end if;
    return v_existing.id;
  end if;

  perform set_config('app.qc_rpc', '1', true);
  if not v_guarded then
    insert into public.qc_checks(project_opening_id, status, note, checked_by, checked_at)
      values (p_opening_id, p_status, v_note, v_actor, v_at)
      on conflict (project_opening_id) do update set status = excluded.status,
        note = excluded.note, checked_by = excluded.checked_by, checked_at = excluded.checked_at;
  elsif p_expected_review_version = 'none' then
    -- Unlike a preflight SELECT, the unique constraint arbitrates a concurrent
    -- legacy INSERT too. A stale first review can never replace its winner.
    insert into public.qc_checks(project_opening_id, status, note, checked_by, checked_at)
      values (p_opening_id, p_status, v_note, v_actor, v_at)
      on conflict (project_opening_id) do nothing returning id into v_written;
  else
    -- PostgreSQL rechecks this predicate on the locked current row after a
    -- concurrent UPDATE. Do not add an opening lock to legacy row triggers:
    -- those acquire the QC row first and would invert the RPC's lock order.
    update public.qc_checks set status = p_status, note = v_note,
      checked_by = v_actor, checked_at = v_at
      where project_opening_id = p_opening_id
        and review_version = p_expected_review_version::uuid
      returning id into v_written;
  end if;
  if v_guarded and v_written is null then
    raise exception 'QC changed since you opened this unit. Refresh and review the current decision.' using errcode = '40001';
  end if;
  perform set_config('app.qc_rpc', coalesce(v_previous_rpc, ''), true);
  perform public.resolve_install_points(p_opening_id::text,
    case when p_status = 'passed' then 'confirmed' else 'void' end);
  return p_decision_id;
end $$;
revoke all on function public._record_qc_review_decision(uuid, uuid, text, text, text, uuid)
  from public, anon, authenticated;

create or replace function public.record_qc_decision(
  p_decision_id uuid, p_opening_id uuid, p_status text, p_note text default null
) returns uuid language sql security definer set search_path = public, pg_temp as $$
  select public._record_qc_review_decision(p_decision_id, p_opening_id, p_status, p_note, null, null)
$$;
revoke all on function public.record_qc_decision(uuid, uuid, text, text) from public, anon;
grant execute on function public.record_qc_decision(uuid, uuid, text, text) to authenticated;

create function public.record_qc_review_decision(
  p_decision_id uuid, p_project_id uuid, p_opening_id uuid, p_status text,
  p_expected_review_version text, p_note text default null
) returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_expected_review_version is null then
    raise exception 'A QC review version is required.' using errcode = '22023';
  end if;
  return public._record_qc_review_decision(p_decision_id, p_opening_id, p_status,
    p_note, p_expected_review_version, p_project_id);
end $$;
revoke all on function public.record_qc_review_decision(uuid, uuid, uuid, text, text, text) from public, anon;
grant execute on function public.record_qc_review_decision(uuid, uuid, uuid, text, text, text) to authenticated;

create function public.qc_review_jobs(
  p_search text default '', p_limit integer default 50, p_after jsonb default null,
  p_selected_project_id uuid default null
) returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_search text := lower(btrim(coalesce(p_search, '')));
  v_name text;
  v_id uuid;
  v_result jsonb;
begin
  if auth.uid() is null or not public.qc_actor_can_review() then
    raise exception 'Only an active foreman, supervisor or owner can review QC.' using errcode = '42501';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 100 or length(v_search) > 200 then
    raise exception 'Use a QC page size from 1 to 100 and a search under 201 characters.' using errcode = '22023';
  end if;
  if p_after is not null then
    if jsonb_typeof(p_after) <> 'object' or jsonb_typeof(p_after->'name') is distinct from 'string'
      or coalesce(p_after->>'id', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'Invalid QC job cursor.' using errcode = '22023';
    end if;
    v_name := p_after->>'name'; v_id := (p_after->>'id')::uuid;
  end if;
  with jobs as materialized (
    select p.id, p.job_code, p.name, lower(coalesce(p.name, '')) as sort_name,
      count(*) filter (where q.status is null or q.status = 'pending') as new_count,
      count(*) filter (where q.status = 'callback') as callback_count,
      count(*) filter (where q.status is distinct from 'passed') as queue_count
    from public.projects p join public.project_openings o on o.project_id = p.id
      and o.status = 'installed' and o.removed_at is null
    left join public.qc_checks q on q.project_opening_id = o.id
    where public._ai_job_visible(p.id, auth.uid()) and 'data' = any(p.allowed_modes)
    group by p.id, p.job_code, p.name
  ), matched as materialized (
    select * from jobs where v_search = '' or strpos(lower(coalesce(job_code, '')), v_search) > 0
      or strpos(lower(coalesce(name, '')), v_search) > 0
  ), page as materialized (
    select * from matched where p_after is null or (sort_name, id) > (v_name, v_id)
      order by sort_name, id limit p_limit
  ), last_row as (select * from page order by sort_name desc, id desc limit 1)
  select jsonb_build_object(
    'rows', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'jobCode', job_code,
      'name', name, 'newCount', new_count, 'callbackCount', callback_count,
      'queueCount', queue_count) order by sort_name, id) from page), '[]'::jsonb),
    'totalCount', (select count(*) from matched),
    'hasMore', exists(select 1 from matched j, last_row l where (j.sort_name, j.id) > (l.sort_name, l.id)),
    'nextCursor', (select jsonb_build_object('name', sort_name, 'id', id) from last_row),
    'selected', (select jsonb_build_object('id', id, 'jobCode', job_code,
      'name', name, 'newCount', new_count, 'callbackCount', callback_count,
      'queueCount', queue_count) from jobs where id = p_selected_project_id)
  ) into v_result;
  return v_result;
end $$;
revoke all on function public.qc_review_jobs(text, integer, jsonb, uuid) from public, anon;
grant execute on function public.qc_review_jobs(text, integer, jsonb, uuid) to authenticated;

create function public.qc_review_page(
  p_project_id uuid, p_filter text default 'all', p_search text default '',
  p_limit integer default 50, p_after jsonb default null, p_before jsonb default null,
  p_selected_opening_id uuid default null
) returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_search text := lower(btrim(coalesce(p_search, '')));
  v_cursor jsonb := coalesce(p_after, p_before);
  v_ended timestamptz;
  v_id uuid;
  v_result jsonb;
begin
  if auth.uid() is null or not public.qc_actor_can_review() then
    raise exception 'Only an active foreman, supervisor or owner can review QC.' using errcode = '42501';
  end if;
  if p_project_id is null or not public._ai_job_visible(p_project_id, auth.uid())
    or not exists(select 1 from public.projects p where p.id = p_project_id and 'data' = any(p.allowed_modes)) then
    raise exception 'This job is unavailable for QC.' using errcode = '42501';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 100 or length(v_search) > 200
    or p_filter is null or p_filter not in ('all', 'new', 'callbacks')
    or (p_after is not null and p_before is not null) then
    raise exception 'Invalid QC filter, page size, search, or cursor direction.' using errcode = '22023';
  end if;
  if v_cursor is not null then
    if jsonb_typeof(v_cursor) <> 'object' or not (v_cursor ? 'endedAt')
      or jsonb_typeof(v_cursor->'endedAt') not in ('string', 'null')
      or coalesce(v_cursor->>'id', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'Invalid QC unit cursor.' using errcode = '22023';
    end if;
    begin
      v_ended := coalesce((v_cursor->>'endedAt')::timestamptz, 'infinity'::timestamptz);
      v_id := (v_cursor->>'id')::uuid;
    exception when invalid_datetime_format or datetime_field_overflow then
      raise exception 'Invalid QC unit cursor.' using errcode = '22023';
    end;
  end if;
  with eligible as materialized (
    select o.id, o.work_ended_at, coalesce(o.work_ended_at, 'infinity'::timestamptz) as sort_ended,
      ((v_search = '' or strpos(lower(coalesce(o.opening_code, '')), v_search) > 0
        or strpos(lower(coalesce(o.label, '')), v_search) > 0)
       and case p_filter when 'new' then q.status is null or q.status = 'pending'
         when 'callbacks' then q.status = 'callback' else q.status is distinct from 'passed' end) as matches,
      jsonb_build_object('id', o.id, 'projectId', o.project_id, 'openingCode', o.opening_code,
        'label', o.label, 'assignedWindowId', o.assigned_window_id, 'typeCode', t.type_code,
        'workEndedAt', o.work_ended_at, 'qcStatus', q.status, 'qcNote', q.note,
        'reviewerId', q.checked_by, 'reviewedAt', q.checked_at,
        'reviewVersion', coalesce(q.review_version::text, 'none')) as payload
    from public.project_openings o
    left join public.qc_checks q on q.project_opening_id = o.id
    left join public.window_types t on t.id = o.window_type_id
    where o.project_id = p_project_id and o.status = 'installed' and o.removed_at is null
  ), filtered as materialized (select * from eligible where matches), page as materialized (
    select * from filtered where v_cursor is null
      or (p_after is not null and (sort_ended, id) > (v_ended, v_id))
      or (p_before is not null and (sort_ended, id) < (v_ended, v_id))
    order by case when p_before is not null then sort_ended end desc,
      case when p_before is not null then id end desc, sort_ended, id limit p_limit
  ), first_row as (select * from page order by sort_ended, id limit 1),
  last_row as (select * from page order by sort_ended desc, id desc limit 1)
  select jsonb_build_object(
    'rows', coalesce((select jsonb_agg(payload || jsonb_build_object('matchesFilter', true)
      order by sort_ended, id) from page), '[]'::jsonb),
    'totalCount', (select count(*) from filtered),
    'hasNext', exists(select 1 from filtered f where (f.sort_ended, f.id) >
      (coalesce((select sort_ended from last_row), v_ended), coalesce((select id from last_row), v_id))),
    'hasPrevious', exists(select 1 from filtered f where (f.sort_ended, f.id) <
      (coalesce((select sort_ended from first_row), v_ended), coalesce((select id from first_row), v_id))),
    'nextCursor', coalesce((select jsonb_build_object('endedAt', work_ended_at, 'id', id) from last_row), p_before),
    'previousCursor', coalesce((select jsonb_build_object('endedAt', work_ended_at, 'id', id) from first_row), p_after),
    'selected', (select payload || jsonb_build_object('matchesFilter', coalesce(matches, false))
      from eligible where id = p_selected_opening_id)
  ) into v_result;
  return v_result;
end $$;
revoke all on function public.qc_review_page(uuid, text, text, integer, jsonb, jsonb, uuid) from public, anon;
grant execute on function public.qc_review_page(uuid, text, text, integer, jsonb, jsonb, uuid) to authenticated;

comment on column public.qc_checks.review_version is
  'Opaque server-owned QC projection version; direct clients cannot choose it. Changes on effective reviews, including legacy writes.';
comment on column public.qc_decision_events.review_expected_version is
  'Immutable guarded-request input: none means no prior QC row. NULL marks a legacy unguarded decision.';
comment on column public.qc_decision_events.review_project_id is
  'Immutable guarded-request job identity, bound with the expected version. Historical input, not a current project pointer.';
comment on function public.qc_review_page(uuid, text, text, integer, jsonb, jsonb, uuid) is
  'Active foreman+ scoped QC queue. Literal full-job search, exact count, bidirectional keyset paging. All means new plus callbacks; selected may have left the queue.';

select public.attach_sandbox_guards();
