-- SESSIONS — the stored atom of per-unit time (spec .scratch/sessions/,
-- CONTEXT.md, ADR-0001/0003). One installer, one unit, a start, a stop;
-- everything else is derived. Timestamps only — no minutes column, ever.
--
-- Design notes that matter to future readers:
-- * "One open session per person" is a DATABASE INVARIANT (partial unique
--   index), not an app behavior.
-- * Shift-driven transitions (break, clock-out, dangling-shift cleanup)
--   ride TRIGGERS on time_shifts rather than edits to the shift RPCs —
--   the task_sessions post-mortem showed create-or-replace silently
--   drops bolted-on writes; a trigger survives every future rewrite.
-- * finish_unit COMPOSES over submit_install_event instead of copying
--   its body, for the same reason.
-- * task_sessions writes are NOT removed here: the old functions keep
--   working until ticket 02 moves the UI onto these RPCs, then the old
--   submit path (and task_sessions with it) is folded away.

create table if not exists unit_sessions (
  id uuid primary key default gen_random_uuid(),
  opening_id uuid not null references project_openings(id) on delete cascade,
  profile_id uuid not null references profiles(id),
  role text not null default 'install' check (role in ('install', 'helper')),
  -- Derived AT INSERT from an unresolved redo on the unit — never by hand.
  is_rework boolean not null default false,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  end_reason text check (end_reason in
    ('finish', 'block', 'break', 'clock_out', 'handoff', 'complete', 'auto_closed')),
  block_reason text,
  block_issue_id uuid references issues(id) on delete set null,
  created_at timestamptz not null default now()
);
-- The session follows the human: one open session per person, ever.
create unique index if not exists unit_sessions_one_open
  on unit_sessions (profile_id) where ended_at is null;
create index if not exists unit_sessions_opening_idx on unit_sessions (opening_id);

create table if not exists unit_redos (
  id uuid primary key default gen_random_uuid(),
  opening_id uuid not null references project_openings(id) on delete cascade,
  pressed_by uuid not null references profiles(id),
  reason text not null,
  pressed_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index if not exists unit_redos_opening_idx on unit_redos (opening_id, resolved_at);

alter table unit_sessions enable row level security;
alter table unit_redos enable row level security;
drop policy if exists "unit_sessions_read" on unit_sessions;
create policy "unit_sessions_read" on unit_sessions
  for select to authenticated using (true);
drop policy if exists "unit_redos_read" on unit_redos;
create policy "unit_redos_read" on unit_redos
  for select to authenticated using (true);
-- No client write policies: RPCs and triggers are the only writers.

-- ---------------------------------------------------------------- helpers

/** Close the caller's open session. Safe when none exists. */
create or replace function _end_open_session(
  p_profile uuid,
  p_reason text,
  p_block_reason text default null,
  p_block_issue uuid default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update unit_sessions
  set ended_at = now(),
      end_reason = p_reason,
      block_reason = p_block_reason,
      block_issue_id = p_block_issue
  where profile_id = p_profile and ended_at is null;
end;
$$;

/** A dead phone must never become a 14-hour window: sessions older than
 * 16 h close flagged instead of handing off. */
create or replace function _close_stale_sessions(p_profile uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update unit_sessions
  set ended_at = now(), end_reason = 'auto_closed'
  where profile_id = p_profile and ended_at is null
    and started_at < now() - interval '16 hours';
end;
$$;

create or replace function _has_open_redo(p_opening uuid)
returns boolean
language sql
stable
as $$
  select exists (
    select 1 from unit_redos where opening_id = p_opening and resolved_at is null
  );
$$;

-- ------------------------------------------------------------------- RPCs

/** Start (or hand off to) a unit. The same gates the old start had: open
 * shift, today's toolbox, flashing not outstanding for install work. */
create or replace function start_unit_session(
  p_opening_id uuid,
  p_role text default 'install'
)
returns unit_sessions
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_row unit_sessions;
begin
  if p_role not in ('install', 'helper') then
    raise exception 'role must be install or helper';
  end if;
  if not exists (
    select 1 from time_shifts
    where profile_id = v_uid and status = 'open' and clock_out_at is null
  ) or not exists (
    select 1 from toolbox_completions
    where profile_id = v_uid and signed_at::date = current_date
  ) then
    raise exception 'clock in and complete today''s toolbox talk before starting a task';
  end if;
  if p_role = 'install' and _flashing_outstanding(p_opening_id) then
    raise exception 'this opening needs flashing before the install starts';
  end if;

  perform _close_stale_sessions(v_uid);
  perform _end_open_session(v_uid, 'handoff');

  insert into unit_sessions (opening_id, profile_id, role, is_rework)
  values (p_opening_id, v_uid, p_role, _has_open_redo(p_opening_id))
  returning * into v_row;

  -- Keep the map/Heartbeat read-model true: first touch stamps the unit.
  update project_openings
  set work_started_at = coalesce(work_started_at, now())
  where id = p_opening_id;

  return v_row;
end;
$$;

/** The chain's 5-minute grace: move the caller's OPEN session (start and
 * all) onto the unit they are actually walking to. */
create or replace function reattribute_session(p_opening_id uuid)
returns unit_sessions
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_row unit_sessions;
begin
  update unit_sessions
  set opening_id = p_opening_id,
      is_rework = _has_open_redo(p_opening_id)
  where profile_id = v_uid and ended_at is null
    and started_at > now() - interval '5 minutes'
  returning * into v_row;
  if v_row.id is null then
    raise exception 'nothing to move — no open session younger than 5 minutes';
  end if;
  update project_openings
  set work_started_at = coalesce(work_started_at, now())
  where id = p_opening_id;
  return v_row;
end;
$$;

/**
 * Finish = the whole submit flow (photo/grade gates unchanged — it CALLS
 * submit_install_event) + the session close + the CHAIN: the next unit's
 * session starts in the same transaction, so walk time lands on the
 * incoming unit with zero client round-trips. Minutes passed to the event
 * are SESSION-DERIVED (this round's sessions, 480-cap each) — the
 * hand-typed override is gone.
 */
create or replace function finish_unit(
  p_opening_id uuid,
  p_next_opening_id uuid default null,
  p_installer text default null,
  p_quality_grade int default null,
  p_difficulty text default null,
  p_went_well text default null,
  p_went_poorly text default null,
  p_obstacles text default null,
  p_tools_helped text default null,
  p_time_vs_estimate text default null,
  p_safety_notes text default null,
  p_do_again text default null,
  p_transcript_raw text default null,
  p_installer_id uuid default null,
  p_estimate_minutes int default null
)
returns install_events
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_minutes int;
  v_started timestamptz;
  v_event install_events;
  v_tiers int;
begin
  -- Close the caller's open session on this unit first so it counts.
  update unit_sessions
  set ended_at = now(), end_reason = 'finish'
  where profile_id = v_uid and ended_at is null and opening_id = p_opening_id;

  -- Session-derived figures for THIS round: sessions since the last
  -- non-voided event (all of them for a first install).
  select coalesce(sum(least(480,
           greatest(0, floor(extract(epoch from (ended_at - started_at)) / 60)))), 0)::int,
         min(started_at)
  into v_minutes, v_started
  from unit_sessions
  where opening_id = p_opening_id and ended_at is not null
    and started_at > coalesce(
      (select max(created_at) from install_events
       where opening_id = p_opening_id and voided_at is null),
      '-infinity'::timestamptz);

  v_event := submit_install_event(
    p_opening_id, p_installer, nullif(v_minutes, 0), p_quality_grade,
    p_difficulty, p_went_well, p_went_poorly, p_obstacles, p_tools_helped,
    p_time_vs_estimate, p_safety_notes, p_do_again, p_transcript_raw,
    v_started, p_installer_id, p_estimate_minutes);

  -- Finishing resolves the unit's open redo, if any.
  update unit_redos
  set resolved_at = now()
  where opening_id = p_opening_id and resolved_at is null;

  -- The CHAIN — suppressed on multi-tier units (signature tiers > 1) and
  -- never allowed to sink the submit: a refused start (flashing owed on
  -- the next unit) leaves the finish standing.
  select coalesce(jsonb_array_length(signature -> 'tiers'), 1)
  into v_tiers from project_openings where id = p_opening_id;
  if p_next_opening_id is not null and coalesce(v_tiers, 1) <= 1 then
    begin
      perform start_unit_session(p_next_opening_id, 'install');
    exception when others then
      null; -- next starts by hand
    end;
  end if;

  return v_event;
end;
$$;

/** Block: the first-class exit for "stuck through no fault of mine".
 * Reason required; the blocker issue is linked or created (ONE
 * accountability record); the hand-off then chains exactly like finish. */
create or replace function block_unit(
  p_opening_id uuid,
  p_reason text,
  p_issue_id uuid default null,
  p_next_opening_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_issue uuid := p_issue_id;
  v_project uuid;
begin
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'a reason is required to block a unit';
  end if;
  select project_id into v_project from project_openings where id = p_opening_id;
  if v_project is null then
    raise exception 'opening not found';
  end if;
  if v_issue is null then
    insert into issues (project_id, opening_id, kind, note, created_by)
    values (v_project, p_opening_id, 'blocker', p_reason, v_uid)
    returning id into v_issue;
  end if;

  update unit_sessions
  set ended_at = now(), end_reason = 'block',
      block_reason = p_reason, block_issue_id = v_issue
  where profile_id = v_uid and ended_at is null and opening_id = p_opening_id;

  if p_next_opening_id is not null then
    begin
      perform start_unit_session(p_next_opening_id, 'install');
    exception when others then
      null;
    end;
  end if;
end;
$$;

/** The Redo button: any installer, reason required, foreman notified by
 * the client. The ORIGINAL install record stands (unlike undo_install,
 * which voids a wrong record) — the unit just goes back in play. */
create or replace function press_redo(p_opening_id uuid, p_reason text)
returns unit_redos
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_row unit_redos;
begin
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'a reason is required to redo a unit';
  end if;
  if exists (
    select 1 from unit_redos where opening_id = p_opening_id and resolved_at is null
  ) then
    raise exception 'a redo is already open on this unit';
  end if;

  insert into unit_redos (opening_id, pressed_by, reason)
  values (p_opening_id, v_uid, p_reason)
  returning * into v_row;

  -- Back in play, visibly. The install_events row is NOT touched.
  update project_openings
  set status = case when assigned_to is not null then 'assigned' else 'planned' end,
      confirmed = false,
      work_ended_at = null
  where id = p_opening_id;

  return v_row;
end;
$$;

grant execute on function start_unit_session(uuid, text) to authenticated;
grant execute on function reattribute_session(uuid) to authenticated;
grant execute on function finish_unit(uuid, uuid, text, int, text, text, text, text, text, text, text, text, text, uuid, int) to authenticated;
grant execute on function block_unit(uuid, text, uuid, uuid) to authenticated;
grant execute on function press_redo(uuid, text) to authenticated;

-- ------------------------------------------------- shift-driven triggers

/** Break start / break end / clock-out all live as column transitions on
 * time_shifts — so sessions follow the SHIFT ROW, not the RPC bodies. */
create or replace function unit_sessions_follow_shift()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_held uuid;
begin
  -- Clock-out (including every dangling-shift guard that stamps it).
  if new.clock_out_at is not null and old.clock_out_at is null then
    perform _end_open_session(new.profile_id, 'clock_out');
    return new;
  end if;
  -- Break starts: the session ends; the unit waits.
  if new.break_started_at is not null and old.break_started_at is null then
    perform _end_open_session(new.profile_id, 'break');
    return new;
  end if;
  -- Break ends: straight back on the held unit (owner call — a minute or
  -- two of walk-back inflation accepted for zero friction).
  if new.break_started_at is null and old.break_started_at is not null
     and new.clock_out_at is null then
    select s.opening_id into v_held
    from unit_sessions s
    join project_openings o on o.id = s.opening_id
    where s.profile_id = new.profile_id and s.end_reason = 'break'
      and o.status <> 'installed'
    order by s.ended_at desc
    limit 1;
    if v_held is not null then
      insert into unit_sessions (opening_id, profile_id, role, is_rework)
      values (v_held, new.profile_id, 'install', _has_open_redo(v_held));
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists unit_sessions_follow_shift on time_shifts;
create trigger unit_sessions_follow_shift
  after update on time_shifts
  for each row execute function unit_sessions_follow_shift();

/** New shift: sweep the person's stale sessions from yesterday's dead
 * phone before today's work starts. */
create or replace function unit_sessions_on_clock_in()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform _close_stale_sessions(new.profile_id);
  return new;
end;
$$;

drop trigger if exists unit_sessions_on_clock_in on time_shifts;
create trigger unit_sessions_on_clock_in
  after insert on time_shifts
  for each row execute function unit_sessions_on_clock_in();

-- ---------------------------------------------- summon-driven triggers

/** A helper's stint IS a session (CONTEXT.md): answering starts one from
 * the tap; completing (or the summon closing) ends it. */
create or replace function unit_sessions_follow_summon_helpers()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_opening uuid;
begin
  if tg_op = 'INSERT' then
    select opening_id into v_opening from summons where id = new.summon_id;
    if v_opening is not null then
      perform _close_stale_sessions(new.profile_id);
      perform _end_open_session(new.profile_id, 'handoff');
      insert into unit_sessions (opening_id, profile_id, role, is_rework)
      values (v_opening, new.profile_id, 'helper', _has_open_redo(v_opening));
    end if;
    return new;
  end if;
  if tg_op = 'UPDATE' and new.completed_at is not null and old.completed_at is null then
    update unit_sessions
    set ended_at = now(), end_reason = 'complete'
    where profile_id = new.profile_id and ended_at is null and role = 'helper';
  end if;
  return new;
end;
$$;

drop trigger if exists unit_sessions_follow_summon_helpers on summon_helpers;
create trigger unit_sessions_follow_summon_helpers
  after insert or update on summon_helpers
  for each row execute function unit_sessions_follow_summon_helpers();

-- Realtime: Dispatch's blocked strip and the crew's live cards.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'unit_sessions'
  ) then
    alter publication supabase_realtime add table unit_sessions;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'unit_redos'
  ) then
    alter publication supabase_realtime add table unit_redos;
  end if;
end;
$$;
