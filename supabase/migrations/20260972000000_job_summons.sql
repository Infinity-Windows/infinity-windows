-- Call for hands on the whole job, not just one window (owner ask,
-- standard-tracking-jobs slice 4, 2026-09-03).
--
-- A summon has always hung off ONE opening: it rang the crew to a heavy
-- window, and answering clocked the helper onto that window. That is exactly
-- right on a data job with a plan full of openings. A tracking job has none —
-- it is a clock-time-and-log-the-day job — so there is no window to hang a
-- call for hands on, and yet "come help me carry this" is the same need. So a
-- summon learns to attach to a JOB instead: no opening, a plain-words "where I
-- am on the job" note in its place, and it rings the people actually clocked
-- into that job rather than a specific window's neighbours.
--
-- Three shapes of change, and nothing here creates a table (summons already
-- exists and is already fenced by the sandbox guard, 20260967000000):
--
--   1. summons.opening_id DROPs NOT NULL, and summons gains where_note. A
--      job-level summon has opening_id = null and carries where_note; a
--      window summon is byte-identical to before (opening_id set, where_note
--      null).
--   2. A NEW function create_job_summon takes p_project_id directly. It is a
--      SIBLING, deliberately NOT an overload of create_summon: the two would
--      both lead (uuid, int, int default, text default), so a 4-arg call would
--      be ambiguous between them — precisely the trap the bind_package and
--      summon-ETA migrations dropped old overloads to avoid. A distinct name
--      is unambiguous forever.
--   3. create_summon (the opening path) is rebuilt IN FULL from its current
--      body (20260963000000) with the SAME signature, unchanged — the whole
--      body, never a diff (the movements_event_ck lesson). answer_summon,
--      close_summon, expire_summons, complete_summon_help and the
--      unit_sessions_follow_summon_helpers trigger are NOT rebuilt because
--      they already tolerate a null opening: none of them reads opening_id
--      except the trigger, which already guards every branch with
--      `v_opening is not null` (a null-opening answer creates no unit_session,
--      the way a call for hands to no particular window should) and matches
--      `opening_id = v_opening` — never true for null — everywhere else. See
--      the trigger body in 20260963000000; this migration leaves it alone on
--      purpose.

-- ---------------------------------------------------------------------------
-- 1. The column changes
-- ---------------------------------------------------------------------------

-- A job-level call for hands has no window. opening_id NOT NULL was written
-- when every summon hung off one; now it is null for the job path and set for
-- the window path.
alter table summons alter column opening_id drop not null;

-- "Where I am on the job" — the note that stands in for the window a job-level
-- call for hands does not have ("north side, second floor", "back of the
-- lot"). Distinct from `note` (the why): note says what the help is for,
-- where_note says where to walk to. A window summon leaves it null — the
-- opening already says where.
alter table summons add column if not exists where_note text;

-- ---------------------------------------------------------------------------
-- 2. The job-level path
-- ---------------------------------------------------------------------------
-- The window path's twin, minus the opening. Same guards (1-8 helpers, lead
-- time 5 min-8 h, note and where_note under 500 chars), same "one live call at
-- a time" rule scoped to the JOB (opening_id is null) with the same one-day
-- window so a swept-but-not-yet-closed stale call never blocks a fresh one.
-- Anyone may call (no clock-in gate, matching create_summon since the note
-- migration); answering still needs an open shift, unchanged, in answer_summon.
create or replace function create_job_summon(
  p_project_id uuid,
  p_needed int,
  p_lead_minutes int default null,
  p_note text default null,
  p_where_note text default null
)
returns summons
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_row summons;
begin
  if p_needed is null or p_needed < 1 or p_needed > 8 then
    raise exception 'ask for between 1 and 8 helpers';
  end if;
  if p_lead_minutes is not null and (p_lead_minutes < 5 or p_lead_minutes > 480) then
    raise exception 'lead time must be between 5 minutes and 8 hours';
  end if;
  if p_note is not null and length(p_note) > 500 then
    raise exception 'keep the note under 500 characters';
  end if;
  if p_where_note is not null and length(p_where_note) > 500 then
    raise exception 'keep the location note under 500 characters';
  end if;
  if not exists (select 1 from projects where id = p_project_id) then
    raise exception 'job not found';
  end if;
  -- One live JOB-level call at a time (opening_id is null). A window summon on
  -- the same job is a different row with an opening and does not count here.
  if exists (
    select 1 from summons
    where project_id = p_project_id
      and opening_id is null
      and status in ('open', 'covered')
      and created_at >= now() - interval '1 day'
  ) then
    raise exception 'a call for hands is already live on this job';
  end if;
  insert into summons (project_id, opening_id, requested_by, needed, needed_at, note, where_note)
  values (
    p_project_id, null, v_uid, p_needed,
    case when p_lead_minutes is null then null
         else now() + make_interval(mins => p_lead_minutes) end,
    nullif(trim(p_note), ''),
    nullif(trim(p_where_note), '')
  )
  returning * into v_row;
  return v_row;
end;
$$;

revoke all on function create_job_summon(uuid, int, int, text, text) from public, anon;
grant execute on function create_job_summon(uuid, int, int, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. The window path, rebuilt in full (unchanged body, same signature)
-- ---------------------------------------------------------------------------
-- Verbatim from 20260963000000_summon_expiry.sql. Rebuilt here so this file
-- carries the current window-path body next to the job path it grew — the
-- whole body, never a diff. It still requires no opening change and sets no
-- where_note; the opening is the "where".
create or replace function create_summon(
  p_opening_id uuid,
  p_needed int,
  p_lead_minutes int default null,
  p_note text default null
)
returns summons
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_project uuid;
  v_row summons;
begin
  if p_needed is null or p_needed < 1 or p_needed > 8 then
    raise exception 'ask for between 1 and 8 helpers';
  end if;
  if p_lead_minutes is not null and (p_lead_minutes < 5 or p_lead_minutes > 480) then
    raise exception 'lead time must be between 5 minutes and 8 hours';
  end if;
  if p_note is not null and length(p_note) > 500 then
    raise exception 'keep the note under 500 characters';
  end if;
  select project_id into v_project from project_openings where id = p_opening_id;
  if v_project is null then
    raise exception 'opening not found';
  end if;
  if exists (
    select 1 from summons
    where opening_id = p_opening_id
      and status in ('open', 'covered')
      and created_at >= now() - interval '1 day'
  ) then
    raise exception 'a summon is already live on this window';
  end if;
  insert into summons (project_id, opening_id, requested_by, needed, needed_at, note)
  values (
    v_project, p_opening_id, v_uid, p_needed,
    case when p_lead_minutes is null then null
         else now() + make_interval(mins => p_lead_minutes) end,
    nullif(trim(p_note), '')
  )
  returning * into v_row;
  return v_row;
end;
$$;
