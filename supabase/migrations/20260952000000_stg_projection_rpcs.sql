-- Wave S, S3: the projection RPCs — the ONLY door a partner reads through.
--
-- THE WALL (S1) locked every crew table off from a partner directly. This
-- migration is the other half: three SECURITY DEFINER functions that build
-- a builder's-eye view of their granted jobs, field by field, explicit,
-- never `select *` — citing Horizon's toPartnerDayReport subtractive-
-- projection rule, the same discipline: name every field going out, so
-- adding a column to a crew table can never silently widen what a partner
-- sees. All three raise 'not a builder login' unless is_partner_user();
-- stg_day additionally checks the specific job was actually granted, since
-- it (unlike the other two) takes a project id as an argument rather than
-- being pre-scoped by a join against partner_job_grants.
--
-- "Day" is local date everywhere (owner's recorded call). This app's other
-- local-day math lives client-side (lib/dailyLogDay.ts's localDateISO,
-- punchDay) because until now nothing needed a SERVER-side local day. These
-- functions are the first that do — a partner has no client-side draft to
-- lean on, the whole payload is server-computed — so they fix a timezone
-- explicitly: 'America/Denver', the same one 20260813000000_toolbox_gate_
-- timezone.sql and ai_spend_limits' default already use for day-bucketing
-- in SQL. Not configurable per caller; one crew, one clock.
--
-- Q15's 70% coverage gate implements lib/dailyLogCoverage.ts's own rule in
-- SQL: ratio = logged worked-days / all worked-days, and 1 (fully covered)
-- when a job has no worked days at all — nothing to log is not the same as
-- nothing logged. worked-days = distinct local dates with a non-voided
-- time_shift or a unit_session on the job (same definition stg_calendar's
-- 'worked' rows use, so the calendar's dots and the day-panel's gate never
-- disagree about what counts as a worked day).

-- ---------------------------------------------------------------------------
-- stg_job_list(): every granted job, named field by field.
-- ---------------------------------------------------------------------------
create or replace function public.stg_job_list()
returns table (
  id uuid,
  name text,
  job_code text,
  status text,
  progress_percent int,
  window_start date,
  window_end date
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_partner_user() then
    raise exception 'not a builder login';
  end if;

  return query
  select
    p.id,
    p.name,
    p.job_code,
    p.status,
    -- Status floor: a completed job reads 100 regardless of any opening
    -- bookkeeping gap; otherwise installed openings over all live openings.
    -- greatest(), not a plain override, so a data gap on a completed job
    -- (fewer opens marked installed than reality) can never show OVER 100
    -- either way — the ratio can't exceed 100 by construction, greatest()
    -- just makes that guarantee explicit rather than incidental.
    greatest(
      case when p.status = 'completed' then 100 else 0 end,
      coalesce(
        (
          select round(
            100.0 * count(*) filter (where o.status = 'installed')
            / nullif(count(*), 0)
          )::int
          from project_openings o
          where o.project_id = p.id and o.removed_at is null
        ),
        0
      )
    ) as progress_percent,
    (
      select min(sa.start_date) from schedule_assignments sa
      where sa.kind = 'install' and sa.project_id = p.id
    ) as window_start,
    (
      select max(sa.end_date) from schedule_assignments sa
      where sa.kind = 'install' and sa.project_id = p.id
    ) as window_end
  from projects p
  join partner_job_grants g on g.project_id = p.id
  where g.partner_profile_id = auth.uid()
  order by p.name;
end;
$$;

comment on function public.stg_job_list() is
  'Partner-only: every job granted to the calling builder login, field by field (never select *). Progress is a status floor (completed -> 100) vs. the openings ratio, whichever is greater.';

revoke all on function public.stg_job_list() from public, anon;
grant execute on function public.stg_job_list() to authenticated;


-- ---------------------------------------------------------------------------
-- stg_calendar(p_from, p_to): install windows, deliveries, worked days.
-- ---------------------------------------------------------------------------
create or replace function public.stg_calendar(p_from date, p_to date)
returns table (
  project_id uuid,
  kind text,
  on_date date,
  from_date date,
  to_date date,
  label text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_partner_user() then
    raise exception 'not a builder login';
  end if;

  return query
  -- Install crew spans: a date RANGE, so on_date is null and from/to carry
  -- it. Two overlapping install assignments on one job (two crews) are two
  -- rows on purpose — that is real, distinct schedule information.
  select
    sa.project_id,
    'window'::text as kind,
    null::date as on_date,
    sa.start_date as from_date,
    sa.end_date as to_date,
    coalesce(nullif(btrim(sa.note), ''), 'Install window') as label
  from schedule_assignments sa
  join partner_job_grants g
    on g.project_id = sa.project_id and g.partner_profile_id = auth.uid()
  where sa.kind = 'install'
    and sa.start_date <= p_to and sa.end_date >= p_from

  union all

  -- Deliveries: schedule_assignments (kind='delivery') carries the actual
  -- scheduled date (update_delivery keeps start_date/end_date in step with
  -- package_deliveries.expected_at); which JOB it belongs to is not on the
  -- assignment or the delivery itself (a truck can serve more than one
  -- job) — it's read off the packages riding in it. EXISTS, not a join
  -- through packages, so a delivery carrying several packages for the same
  -- granted job still yields exactly one row.
  select
    g.project_id,
    'delivery'::text,
    sa.start_date,
    null::date,
    null::date,
    coalesce(nullif(btrim(pd.label), ''), 'Delivery')
  from schedule_assignments sa
  join package_deliveries pd on pd.id = sa.delivery_id
  join partner_job_grants g on g.partner_profile_id = auth.uid()
  where sa.kind = 'delivery'
    and sa.start_date between p_from and p_to
    and exists (
      select 1 from packages pk
      where pk.delivery_id = pd.id and pk.project_id = g.project_id
    )

  -- Plain UNION from here on (not UNION ALL): the two 'worked' branches
  -- below can genuinely produce the identical tuple (same job, same local
  -- day) when a shift AND a session both land on it, and this is the one
  -- point in the query where that would otherwise show as two markers for
  -- one day. UNION ALL above is safe because 'window'/'delivery' rows can
  -- never collide with anything else (their `kind` differs).
  union

  -- Worked days: distinct local dates with a non-voided time_shift OR a
  -- unit_session on the job — the exact definition stg_day's coverage gate
  -- also uses, so the calendar's dot and the day panel's 70% math read the
  -- same worked-day set. Per-person data never leaves this row; it's one
  -- marker per (job, day), nothing about who or how long.
  select distinct
    g.project_id,
    'worked'::text,
    (ts.clock_in_at at time zone 'America/Denver')::date,
    null::date,
    null::date,
    null::text
  from time_shifts ts
  join partner_job_grants g
    on g.project_id = ts.project_id and g.partner_profile_id = auth.uid()
  where ts.status <> 'voided'
    and (ts.clock_in_at at time zone 'America/Denver')::date between p_from and p_to

  union

  select distinct
    g.project_id,
    'worked'::text,
    (us.started_at at time zone 'America/Denver')::date,
    null::date,
    null::date,
    null::text
  from unit_sessions us
  join project_openings po on po.id = us.opening_id
  join partner_job_grants g
    on g.project_id = po.project_id and g.partner_profile_id = auth.uid()
  where (us.started_at at time zone 'America/Denver')::date between p_from and p_to;
end;
$$;

comment on function public.stg_calendar(date, date) is
  'Partner-only: install-window spans, deliveries, and worked-day markers for every granted job in [p_from, p_to]. Deliveries are matched to a job through the packages riding in them, since a delivery/schedule row names no job of its own.';

revoke all on function public.stg_calendar(date, date) from public, anon;
grant execute on function public.stg_calendar(date, date) to authenticated;


-- ---------------------------------------------------------------------------
-- stg_day(p_project, p_date): the tap-a-day panel.
-- ---------------------------------------------------------------------------
create or replace function public.stg_day(p_project uuid, p_date date)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_crew_names text[];
  v_total_hours numeric;
  v_units_finished int;
  v_worked_n int;
  v_logged_n int;
  v_ratio numeric;
  v_log_row daily_logs;
  v_log jsonb := null;
begin
  if not public.is_partner_user() then
    raise exception 'not a builder login';
  end if;
  if not exists (
    select 1 from partner_job_grants
    where partner_profile_id = auth.uid() and project_id = p_project
  ) then
    raise exception 'that job is not granted to this login';
  end if;

  -- Names: anyone with a shift OR a session on the job that local day.
  -- profiles.display_name is NOT NULL, so an empty array here IS "nobody
  -- worked" — no separate existence check is needed for `worked` below.
  select coalesce(array_agg(distinct dn), '{}')
    into v_crew_names
  from (
    select pr.display_name as dn
    from time_shifts ts
    join profiles pr on pr.id = ts.profile_id
    where ts.project_id = p_project and ts.status <> 'voided'
      and (ts.clock_in_at at time zone 'America/Denver')::date = p_date
    union
    select pr.display_name
    from unit_sessions us
    join project_openings po on po.id = us.opening_id
    join profiles pr on pr.id = us.profile_id
    where po.project_id = p_project
      and (us.started_at at time zone 'America/Denver')::date = p_date
  ) names;

  -- Hours: closed, non-voided shifts only — an open shift's duration is not
  -- a settled fact yet (Per-person hours never leave this function; only
  -- the crew total does).
  select coalesce(sum(
    extract(epoch from (ts.clock_out_at - ts.clock_in_at)) / 3600.0
    - ts.break_seconds / 3600.0
  ), 0)
    into v_total_hours
  from time_shifts ts
  where ts.project_id = p_project and ts.status <> 'voided'
    and ts.clock_out_at is not null
    and (ts.clock_in_at at time zone 'America/Denver')::date = p_date;

  select count(*) into v_units_finished
  from install_events ie
  join project_openings po on po.id = ie.project_opening_id
  where po.project_id = p_project
    and ie.voided_at is null
    and (ie.created_at at time zone 'America/Denver')::date = p_date;

  -- Q15's coverage gate: logged worked-days / all worked-days, 1 if none.
  with worked_days as (
    select distinct (ts.clock_in_at at time zone 'America/Denver')::date as d
    from time_shifts ts
    where ts.project_id = p_project and ts.status <> 'voided'
    union
    select distinct (us.started_at at time zone 'America/Denver')::date as d
    from unit_sessions us
    join project_openings po on po.id = us.opening_id
    where po.project_id = p_project
  )
  select
    count(*),
    count(*) filter (
      where d in (select log_date from daily_logs where project_id = p_project)
    )
    into v_worked_n, v_logged_n
  from worked_days;

  v_ratio := case when v_worked_n = 0 then 1.0 else v_logged_n::numeric / v_worked_n end;

  if v_ratio >= 0.70 then
    select * into v_log_row from daily_logs
    where project_id = p_project and log_date = p_date and customer_visible;
    if found then
      -- Explicit fields only — never reflection (a foreman's private
      -- what-went-well/poorly notes), never filed_by (who on the crew
      -- wrote it is not this login's business).
      v_log := jsonb_build_object(
        'headline', v_log_row.headline,
        'notes', v_log_row.notes,
        'day_flow', v_log_row.day_flow
      );
    end if;
  end if;

  return jsonb_build_object(
    'worked', coalesce(array_length(v_crew_names, 1), 0) > 0,
    'crew_names', v_crew_names,
    'total_hours', round(v_total_hours, 1),
    'units_finished', v_units_finished,
    'log', v_log
  );
end;
$$;

comment on function public.stg_day(uuid, date) is
  'Partner-only, and only for a job actually granted to the caller: one day''s system facts (never gated) plus the daily log, non-null only when customer_visible AND the job''s log coverage is at least 70% (Q15). log carries only {headline, notes, day_flow} — never reflection, never filed_by.';

revoke all on function public.stg_day(uuid, date) from public, anon;
grant execute on function public.stg_day(uuid, date) to authenticated;
