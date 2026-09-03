-- Job modes: a job is a DATA job, a TRACKING job, or both (standard-tracking-jobs slice 2, 2026-09-03).
--
-- WHY (owner ask, 2026-09-02): not every job needs the full per-window data loop
-- — openings, marks, the flat map, Maps Interactive, Model Studio, framing
-- checks, flash runs, unit tracking. Some jobs are only ever "clock time and log
-- the day against this job". This slice lets a job DECLARE which modes it allows;
-- the clock-in picks one when a job allows both; and a tracking-only job hides
-- the data-heavy screens (see app/src/lib/jobModes.ts + ProjectDetail). A
-- DATA-only job — which is every job that exists today — behaves exactly as it
-- did before this migration.
--
-- Precedent followed here is projects.is_test (20260933000000_testing_projects):
-- a projects flag written ONLY by a SECURITY DEFINER RPC, with the direct column
-- write revoked from clients so the RPC is the one door. allowed_modes copies
-- that shape exactly.

-- ---------------------------------------------------------------------------
-- 1. allowed_modes on projects
-- ---------------------------------------------------------------------------
-- NOT NULL DEFAULT '{data}' means every EXISTING row is backfilled to data-only
-- by the ALTER itself — zero behaviour change for every job already in the table.
alter table projects
  add column if not exists allowed_modes text[] not null default '{data}'::text[];

comment on column projects.allowed_modes is
  'Which work modes this job allows: a non-empty subset of {data,tracking}. data = the full per-window loop (openings, map, Studio, flash, units); tracking = a lighter job that only clocks time and logs days. Written ONLY by set_project_modes() — direct writes to this column are revoked from anon/authenticated, exactly like is_test (20260933000000).';

alter table projects drop constraint if exists projects_allowed_modes_check;
alter table projects add constraint projects_allowed_modes_check
  check (
    cardinality(allowed_modes) >= 1
    and allowed_modes <@ array['data', 'tracking']::text[]
  );

-- The RPC is the only writer (same lock is_test uses): projects carries a
-- table-level UPDATE grant to authenticated, so without this revoke a plain
-- PATCH naming allowed_modes would flip it for anybody signed in. Column
-- privileges are enforced independently of RLS, so this holds even though the
-- row-level update policy is left open (20260933000000).
revoke insert (allowed_modes), update (allowed_modes) on table projects from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Set a job's modes (foreman+)
-- ---------------------------------------------------------------------------
create or replace function public.set_project_modes(p_project_id uuid, p_modes text[])
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_clean text[];
begin
  if not _is_lead(auth.uid()) then
    raise exception 'only a foreman or above can change a job''s modes';
  end if;

  -- Normalise the request to distinct, known modes only. Anything unrecognised
  -- is dropped rather than trusted; an empty result means the caller sent
  -- nothing usable, which is not a legal job.
  select array_agg(distinct m order by m) into v_clean
  from unnest(p_modes) as m
  where m in ('data', 'tracking');

  if v_clean is null or cardinality(v_clean) = 0 then
    raise exception 'a job must allow at least one of: data, tracking';
  end if;

  update projects set allowed_modes = v_clean where id = p_project_id;
  if not found then
    raise exception 'that job does not exist';
  end if;
end;
$$;

comment on function public.set_project_modes(uuid, text[]) is
  'Set which modes a job allows — a non-empty subset of {data,tracking}. Foreman+ (server-checked). The one legal writer of projects.allowed_modes.';

revoke all on function public.set_project_modes(uuid, text[]) from public;
grant execute on function public.set_project_modes(uuid, text[]) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. time_shifts.job_mode, and a clock_in that records it
-- ---------------------------------------------------------------------------
-- A shift on a both-mode job records WHICH mode the worker picked at clock-in.
-- Nullable on purpose: a single-mode punch, or one made before this migration,
-- simply carries no mode.
alter table time_shifts
  add column if not exists job_mode text;

alter table time_shifts drop constraint if exists time_shifts_job_mode_check;
alter table time_shifts add constraint time_shifts_job_mode_check
  check (job_mode is null or job_mode in ('data', 'tracking'));

comment on column time_shifts.job_mode is
  'The work mode picked at clock-in on a both-mode job (data|tracking), or null on a single-mode job. Written by the clock_in overload that carries p_mode (20260970000000).';

-- New foreground overload = the note overload (latest bodies in 20260813000000)
-- plus a trailing p_mode. Every existing clock_in overload is LEFT IN PLACE
-- (this is a create-or-replace of a NEW signature only), so older clients keep
-- punching exactly as before — the note-only path and the offline client_id
-- path are untouched. This overload is the only one carrying BOTH p_note and
-- p_mode, so PostgREST resolves this and nothing else when the app sends them.
create or replace function clock_in(
  p_project_id uuid,
  p_cost_code_id uuid,
  p_photo text,
  p_lat double precision,
  p_lng double precision,
  p_note text,
  p_mode text
)
returns time_shifts language plpgsql set search_path = public, pg_temp as $$
declare v_shift time_shifts;
begin
  if not exists (
    select 1 from toolbox_completions
    where profile_id = auth.uid() and (signed_at at time zone 'America/Denver')::date = (now() at time zone 'America/Denver')::date
  ) then
    raise exception 'complete today''s toolbox talk before clocking in';
  end if;

  perform _close_dangling_shift(auth.uid());

  insert into time_shifts
    (profile_id, project_id, cost_code_id, clock_in_photo, clock_in_lat, clock_in_lng,
     note, job_mode)
  values
    (auth.uid(), p_project_id, p_cost_code_id, p_photo, p_lat, p_lng,
     nullif(btrim(p_note), ''),
     case when p_mode in ('data', 'tracking') then p_mode else null end)
  returning * into v_shift;
  return v_shift;
end;
$$;
