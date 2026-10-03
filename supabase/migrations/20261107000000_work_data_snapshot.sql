-- Work Data snapshot: a permission-first, read-only bridge from existing
-- evidence tables (time_shifts, custom_work_sessions, unit_sessions,
-- task_sessions, service_time_sessions, opening_phases, install_events,
-- crew_work_records) into one typed payload for the workday reconciliation
-- screen. Nothing here writes payroll, capture state, or QC. No activity
-- taxonomy is invented: every label/activityId/scope is a direct readback of
-- a stored field, never a guess.
--
-- Why a new RPC rather than the existing client reads: time_shifts and
-- custom_work_sessions/custom_work_history read policies are "any
-- non-partner crew login, any live/visible job" (20260950000000,
-- 20261011000000) — broad enough for the existing screens, which gate the
-- PER-PERSON breakdown in the UI layer only (DataHub's "Per person
-- (supervisors only)" toggle). A reconciliation read that assembles many
-- people's raw shift and claim rows into one payload must not rely on a UI
-- toggle for that gate — it enforces supervisor/owner itself, in SQL,
-- before any source table is touched.
begin;

create or replace function public.work_data_snapshot(
  p_project_id uuid,
  p_from timestamptz,
  p_until timestamptz
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_project jsonb;
  v_shifts jsonb;
  v_shift_count int;
  v_claims jsonb;
  v_claim_count int;
  v_untimed jsonb;
  v_untimed_count int;
  v_units jsonb;
  v_as_of timestamptz := statement_timestamp();
begin
  -- 1. Who is asking — before any source read, per the brief's correction
  -- that broad table-level RLS is not sufficient privacy for this payload.
  if v_uid is null or not public.custom_work_internal() or not public._is_supervisor(v_uid) then
    raise exception 'A signed-in supervisor or owner is required to read work data.' using errcode = '42501';
  end if;

  if p_project_id is null or p_from is null or p_until is null then
    raise exception 'A project and a complete from/until window are required.';
  end if;
  if not isfinite(p_from) or not isfinite(p_until) then
    raise exception 'The requested window is not a valid pair of timestamps.';
  end if;
  if p_until <= p_from or p_until - p_from > interval '93 days' then
    raise exception 'The window must be more than zero and at most 93 days.';
  end if;

  -- Gates the project itself: live, not deleted, and — the test-login fence
  -- restated for a real (non-test) supervisor/owner caller — visible under
  -- the same rule projects_select_visible already enforces for everyone
  -- else. A test-flagged job off the sandbox list, or a trashed job, is
  -- refused here exactly as it would be refused by the ordinary read.
  if not public._ai_job_visible(p_project_id, v_uid) then
    raise exception 'That job is unavailable.' using errcode = '42501';
  end if;

  select jsonb_build_object('id', p.id, 'jobCode', p.job_code, 'name', p.name)
    into v_project
  from public.projects p
  where p.id = p_project_id;
  -- _ai_job_visible already proved this row exists and is visible; this
  -- re-read only guards a delete racing between the check and here.
  if v_project is null then
    raise exception 'That job is unavailable.' using errcode = '42501';
  end if;

  -- ---------------------------------------------------------------------
  -- 2. Shifts — time_shifts whose clock_in falls in [from, until). Payroll
  -- stays time_shifts' own arithmetic (shiftHours); this is a read of it,
  -- never a second total. No profile override: the shift's own project_id
  -- is what is read, never a caller-supplied person list.
  -- ---------------------------------------------------------------------
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', s.id,
      'profileId', s.profile_id,
      'profileName', coalesce(nullif(btrim(pr.display_name), ''), 'Crew'),
      'projectId', s.project_id,
      'startedAt', s.clock_in_at,
      'endedAt', s.clock_out_at,
      'breakSeconds', s.break_seconds,
      'breakStartedAt', s.break_started_at,
      'status', s.status,
      'reviewReason', s.review_reason
    ) order by s.clock_in_at, s.id), '[]'::jsonb), count(*)
    into v_shifts, v_shift_count
  from public.time_shifts s
  join public.profiles pr on pr.id = s.profile_id
  where s.project_id = p_project_id
    and s.clock_in_at >= p_from and s.clock_in_at < p_until;

  if v_shift_count > 10000 then
    raise exception 'Too many shifts in this window (%). Narrow the date range.', v_shift_count;
  end if;

  -- ---------------------------------------------------------------------
  -- 3. Claims — every existing table that times a person against a unit or
  -- a named activity, matched to this job's own shifts above. Coexisting
  -- claims keep separate raw source IDs; the overlap engine in
  -- app/src/lib/workData/reconcile.ts counts an overlap once as conflict,
  -- never as added time. Historical stage/description text is passed
  -- through unchanged, never relabelled into a new taxonomy.
  -- ---------------------------------------------------------------------
  with w_shifts as (
    select id, profile_id, clock_in_at, clock_out_at from public.time_shifts
    where project_id = p_project_id and clock_in_at >= p_from and clock_in_at < p_until
  ),
  openings as (
    -- The authorized, nonremoved opening graph for this job: every claim
    -- below that keys off an opening joins through this, so a removed
    -- opening or one belonging to another job never leaks a raw ID or a
    -- total.
    select o.id, o.project_id from public.project_openings o
    where o.project_id = p_project_id and o.removed_at is null
  ),
  custom as (
    select
      'custom_work_sessions:' || cs.id::text as source_id,
      'custom_work_sessions'::text as source_table,
      cs.revision as revision,
      cs.profile_id as profile_id,
      cs.project_id as project_id,
      cs.shift_id as shift_id,
      case when cs.unit_id is null then null
           else coalesce('opening:' || cu.opening_id::text, 'custom:' || cs.unit_id::text) end as unit_id,
      case when cs.kind = 'idle'
             then 'idle:' || coalesce(nullif(btrim(cs.description), ''), cs.stage)
           else 'unit:' || cs.stage end as activity_id,
      case when cs.kind = 'idle'
             then coalesce(nullif(btrim(cs.description), ''), cs.stage)
           else cs.stage end as label,
      case when cs.kind = 'idle' then 'general' else 'specific' end as scope,
      cs.started_at as started_at,
      cs.ended_at as ended_at,
      false as pending,
      (coalesce(cs.review_required, false)
        or cs.project_id <> p_project_id or (cu.id is not null and cu.project_id <> cs.project_id)
        or (cs.shift_status is not null and cs.shift_status not in ('open', 'submitted', 'approved'))) as unresolved,
      coalesce(cs.outcome = 'rework', false) as rework
    from public.custom_work_sessions cs
    join w_shifts ws on ws.id = cs.shift_id and ws.profile_id = cs.profile_id
    left join public.custom_work_units cu on cu.id = cs.unit_id
    where public._ai_job_visible(cs.project_id, v_uid)
      and (cs.unit_id is null or (cu.id is not null
        and public._ai_job_visible(cu.project_id, v_uid)
        and (cu.opening_id is null or exists (select 1 from public.project_openings mapped
          where mapped.id = cu.opening_id and mapped.removed_at is null
            and public._ai_job_visible(mapped.project_id, v_uid)))))
  ),
  unit_sess as (
    select
      'unit_sessions:' || us.id::text as source_id,
      'unit_sessions'::text as source_table,
      null::int as revision,
      us.profile_id as profile_id,
      op.project_id as project_id,
      null::uuid as shift_id,
      'opening:' || us.opening_id::text as unit_id,
      'unit_session:' || us.role as activity_id,
      case when us.role = 'helper' then 'Helper' else 'Install' end as label,
      'specific'::text as scope,
      us.started_at as started_at,
      us.ended_at as ended_at,
      false as pending,
      coalesce(us.end_reason = 'auto_closed', false) as unresolved,
      coalesce(us.is_rework, false) as rework
    from public.unit_sessions us
    join openings op on op.id = us.opening_id
    where (us.started_at >= p_from and us.started_at < p_until)
      or exists (select 1 from w_shifts ws where ws.profile_id = us.profile_id
        and us.started_at < coalesce(ws.clock_out_at, v_as_of)
        and coalesce(us.ended_at, v_as_of) > ws.clock_in_at)
  ),
  task as (
    select
      'task_sessions:' || ts.id::text as source_id,
      'task_sessions'::text as source_table,
      null::int as revision,
      ts.profile_id as profile_id,
      ts.project_id as project_id,
      null::uuid as shift_id,
      case when ts.opening_id is null then null else 'opening:' || ts.opening_id::text end as unit_id,
      'on_task'::text as activity_id,
      'On task'::text as label,
      'specific'::text as scope,
      ts.started_at as started_at,
      ts.ended_at as ended_at,
      false as pending,
      false as unresolved,
      false as rework
    from public.task_sessions ts
    left join openings op on op.id = ts.opening_id
    where ts.project_id = p_project_id
      and ts.state = 'on_task'
      and (ts.opening_id is null or op.id is not null)
      and ((ts.started_at >= p_from and ts.started_at < p_until)
        or exists (select 1 from w_shifts ws where ws.profile_id = ts.profile_id
          and ts.started_at < coalesce(ws.clock_out_at, v_as_of)
          and coalesce(ts.ended_at, v_as_of) > ws.clock_in_at))
  ),
  service as (
    select
      'service_time_sessions:' || sts.id::text as source_id,
      'service_time_sessions'::text as source_table,
      null::int as revision,
      sts.profile_id as profile_id,
      sts.project_id as project_id,
      sts.shift_id as shift_id,
      case
        when sts.unit_id is null then null
        when svu.opening_id is not null and svo.id is not null then 'opening:' || svu.opening_id::text
        when svu.work_unit_id is not null then coalesce('opening:' || cu.opening_id::text, 'custom:' || svu.work_unit_id::text)
        else 'service:' || svu.id::text
      end as unit_id,
      case sts.kind
        when 'unit' then 'service:' || sts.stage
        when 'idle' then 'idle:' || coalesce(nullif(btrim(sts.description), ''), sts.stage)
        else 'travel:' || coalesce(nullif(btrim(sts.description), ''), sts.stage)
      end as activity_id,
      case sts.kind
        when 'unit' then sts.stage
        else coalesce(nullif(btrim(sts.description), ''), sts.stage)
      end as label,
      case sts.kind when 'unit' then 'specific' when 'idle' then 'general' else 'other' end as scope,
      sts.started_at as started_at,
      sts.ended_at as ended_at,
      false as pending,
      (coalesce(sts.review_required, false) or sts.project_id <> p_project_id
        or sv.project_id <> sts.project_id or (svu.id is not null and svu.project_id <> sts.project_id)
        or (cu.id is not null and cu.project_id <> sts.project_id)) as unresolved,
      (sts.kind = 'unit') as rework
    from public.service_time_sessions sts
    join w_shifts ws on ws.id = sts.shift_id and ws.profile_id = sts.profile_id
    join public.service_visits sv on sv.id = sts.visit_id
    left join public.service_visit_units svu on svu.id = sts.unit_id
    left join openings svo on svo.id = svu.opening_id
    left join public.custom_work_units cu on cu.id = svu.work_unit_id
    where public._ai_job_visible(sts.project_id, v_uid) and public.service_job_access(sts.project_id)
      and public._ai_job_visible(sv.project_id, v_uid) and public.service_job_access(sv.project_id)
      and (sts.unit_id is null or (svu.id is not null and svu.visit_id = sv.id
        and public._ai_job_visible(svu.project_id, v_uid) and public.service_job_access(svu.project_id)
        and (svu.opening_id is null or exists (select 1 from public.project_openings mapped
          where mapped.id = svu.opening_id and mapped.removed_at is null
            and public._ai_job_visible(mapped.project_id, v_uid)))
        and (svu.work_unit_id is null or (cu.id is not null
          and public._ai_job_visible(cu.project_id, v_uid)
          and (cu.opening_id is null or exists (select 1 from public.project_openings mapped
            where mapped.id = cu.opening_id and mapped.removed_at is null
              and public._ai_job_visible(mapped.project_id, v_uid)))))))
  ),
  all_claims as (
    select * from custom union all
    select * from unit_sess union all
    select * from task union all
    select * from service
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'sourceId', c.source_id, 'sourceTable', c.source_table, 'revision', c.revision,
      'profileId', c.profile_id, 'projectId', c.project_id, 'shiftId', c.shift_id,
      'unitId', c.unit_id, 'activityId', c.activity_id, 'label', c.label, 'scope', c.scope,
      'startedAt', c.started_at, 'endedAt', c.ended_at,
      'pending', c.pending, 'unresolved', c.unresolved, 'rework', c.rework
    ) order by c.started_at, c.source_id), '[]'::jsonb), count(*)
    into v_claims, v_claim_count
  from all_claims c;

  if v_claim_count > 10000 then
    raise exception 'Too much claim evidence in this window (%). Narrow the date range.', v_claim_count;
  end if;

  -- ---------------------------------------------------------------------
  -- 4. Untimed evidence — a reported duration (or none) with no provable
  -- start/end interval. opening_phases' minutes are an aggregate over a
  -- possibly-paused clock and are never turned into a guessed range;
  -- install_events' legacy minutes and crew_work_records' named
  -- attribution are claims about who worked, not measured intervals.
  -- ---------------------------------------------------------------------
  with openings as (
    select o.id, o.project_id from public.project_openings o
    where o.project_id = p_project_id and o.removed_at is null
  ),
  phases as (
    select
      'opening_phases:' || ph.id::text as source_id, 'opening_phases'::text as source_table,
      ph.started_by as profile_id, op.project_id as project_id,
      'opening:' || ph.opening_id::text as unit_id,
      'flashing'::text as activity_id, 'Flashing'::text as label,
      to_char(ph.started_at at time zone 'America/Denver', 'YYYY-MM-DD') as work_date,
      case when ph.minutes is not null then ph.minutes * 60 else null end as reported_seconds
    from public.opening_phases ph
    join openings op on op.id = ph.opening_id
    where ph.kind = 'flashing' and ph.started_at >= p_from and ph.started_at < p_until
  ),
  legacy as (
    select
      'install_events:' || ie.id::text as source_id, 'install_events'::text as source_table,
      ie.installer_id as profile_id, op.project_id as project_id,
      'opening:' || ie.project_opening_id::text as unit_id,
      'legacy_install'::text as activity_id, 'Install (legacy time entry)'::text as label,
      to_char(coalesce(ie.started_at, ie.created_at) at time zone 'America/Denver', 'YYYY-MM-DD') as work_date,
      case when ie.minutes is not null then ie.minutes * 60 else null end as reported_seconds
    from public.install_events ie
    join openings op on op.id = ie.project_opening_id
    where ie.installer_id is not null
      and coalesce(ie.started_at, ie.created_at) >= p_from and coalesce(ie.started_at, ie.created_at) < p_until
  ),
  crew as (
    select
      'crew_work_record_people:' || r.id::text || ':' || p.profile_id::text as source_id,
      'crew_work_record_people'::text as source_table,
      p.profile_id as profile_id, r.project_id as project_id,
      coalesce('opening:' || cu.opening_id::text, 'custom:' || r.unit_id::text) as unit_id,
      'crew_record:' || r.stage as activity_id, r.stage as label,
      to_char(r.work_date, 'YYYY-MM-DD') as work_date,
      null::int as reported_seconds
    from public.crew_work_records r
    join public.crew_work_record_people p on p.record_id = r.id and p.voided_at is null
    join public.custom_work_units cu on cu.id = r.unit_id
    where r.project_id = p_project_id and r.work_date >= (p_from at time zone 'America/Denver')::date and r.work_date <= ((p_until - interval '1 microsecond') at time zone 'America/Denver')::date
      and r.outcome in ('partial', 'finished')
      and public._ai_job_visible(cu.project_id, v_uid)
      and (cu.opening_id is null or exists (select 1 from public.project_openings mapped
        where mapped.id = cu.opening_id and mapped.removed_at is null
          and public._ai_job_visible(mapped.project_id, v_uid)))
  ),
  all_untimed as (
    select * from phases union all
    select * from legacy union all
    select * from crew
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'sourceId', u.source_id, 'sourceTable', u.source_table, 'profileId', u.profile_id,
      'projectId', u.project_id, 'unitId', u.unit_id, 'activityId', u.activity_id,
      'label', u.label, 'workDate', u.work_date, 'reportedSeconds', u.reported_seconds
    ) order by u.work_date, u.source_id), '[]'::jsonb), count(*)
    into v_untimed, v_untimed_count
  from all_untimed u;

  if v_untimed_count > 10000 then
    raise exception 'Too much untimed evidence in this window (%). Narrow the date range.', v_untimed_count;
  end if;

  -- ---------------------------------------------------------------------
  -- 5. Units — every canonical unit identity (opening: or custom:) named by
  -- a claim or an untimed row above, each with only what this first slice
  -- independently establishes. Category, subtype, verified dimension and
  -- final QC are left null/false rather than guessed from free text — see
  -- docs/work-data.md.
  -- ---------------------------------------------------------------------
  with ids as (
    select distinct (j->>'unitId') as unit_id from jsonb_array_elements(v_claims) j where j->>'unitId' is not null
    union
    select distinct (j->>'unitId') as unit_id from jsonb_array_elements(v_untimed) j where j->>'unitId' is not null
  ),
  opening_units as (
    select i.unit_id, o.opening_code as label, (o.status = 'installed') as complete,
      (exists (select 1 from jsonb_array_elements(v_untimed) j where j->>'unitId' = i.unit_id) or coalesce(cu.untimed_work_present, false)) as has_untimed, coalesce(cu.facts, '{}'::jsonb) as facts
    from ids i
    join public.project_openings o on 'opening:' || o.id::text = i.unit_id
    left join public.custom_work_units cu on cu.opening_id = o.id and cu.project_id = p_project_id
    where o.project_id = p_project_id and o.removed_at is null
  ),
  custom_units as (
    select i.unit_id, cu.label as label,
      coalesce(cu.facts->>'installation_complete' = 'Yes', false) as complete,
      (coalesce(cu.untimed_work_present, false) or exists (select 1 from jsonb_array_elements(v_untimed) j where j->>'unitId' = i.unit_id)) as has_untimed,
      cu.facts as facts
    from ids i
    join public.custom_work_units cu on 'custom:' || cu.id::text = i.unit_id
    where cu.project_id = p_project_id
      and (cu.opening_id is null or exists (select 1 from public.project_openings mapped
        where mapped.id = cu.opening_id and mapped.removed_at is null
          and public._ai_job_visible(mapped.project_id, v_uid)))
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', x.unit_id, 'label', x.label, 'category', null, 'subtype', null,
      'material', x.material, 'floor', x.floor,
      'widthIn', x.width_in, 'heightIn', x.height_in, 'dimensionSource', x.dimension_source,
      'dimensionsVerified', false, 'complete', x.complete, 'qcAccepted', false,
      'hasUntimedEvidence', x.has_untimed
    ) order by x.unit_id), '[]'::jsonb)
    into v_units
  from (
    select unit_id, label, complete, has_untimed,
      nullif(facts->>'material', '') as material, nullif(facts->>'story', '') as floor,
      case when (facts->>'width_in') ~ '^[0-9]+(\.[0-9]+)?$' then (facts->>'width_in')::numeric else null end as width_in,
      case when (facts->>'height_in') ~ '^[0-9]+(\.[0-9]+)?$' then (facts->>'height_in')::numeric else null end as height_in,
      nullif(facts->>'area_source', '') as dimension_source
    from opening_units
    union all
    select unit_id, label, complete, has_untimed,
      nullif(facts->>'material', '') as material,
      nullif(facts->>'story', '') as floor,
      case when (facts->>'width_in') ~ '^[0-9]+(\.[0-9]+)?$' then (facts->>'width_in')::numeric else null end as width_in,
      case when (facts->>'height_in') ~ '^[0-9]+(\.[0-9]+)?$' then (facts->>'height_in')::numeric else null end as height_in,
      nullif(facts->>'area_source', '') as dimension_source
    from custom_units
  ) x;

  if jsonb_array_length(v_units) > 10000 then
    raise exception 'Too many units. Narrow the date range.';
  end if;

  return jsonb_build_object(
    'schemaVersion', 1,
    'asOf', v_as_of,
    'project', v_project,
    'shifts', v_shifts,
    'claims', v_claims,
    'units', v_units,
    'untimed', v_untimed
  );
end;
$$;

revoke all on function public.work_data_snapshot(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.work_data_snapshot(uuid, timestamptz, timestamptz) to authenticated;

comment on function public.work_data_snapshot(uuid, timestamptz, timestamptz) is
  'Read-only workday reconciliation snapshot: shifts, claims, untimed evidence and unit facts for one job and window. Supervisor/owner only, enforced in-function ahead of every source read — see docs/work-data.md.';

commit;
