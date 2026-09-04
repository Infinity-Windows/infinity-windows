-- Window Ops prototype — paste into the Supabase SQL editor.
-- Run once, top to bottom. Safe to re-run (create or replace / if not exists / guarded inserts).
-- Regenerated from supabase/migrations. Assumes the base inventory schema
-- (inventory_core, seed_demo, install_capture) is already installed.
-- Covers: unified lifecycle, AI brain, fit/condition gate, crew dispatch,
-- learning rollups + installer stats, estimates, memo confirm, training how-to,
-- field flags, roles/access, time clock, job costing, education, points (+status),
-- ops modules, QC flywheel, PIN + persisted breaks, and module seeds.


-- ============================================================================
-- 1) lifecycle unify  [20260715200000_lifecycle_unify.sql]
-- =============================================================================

-- Phase 1 lifecycle unify: smart assignment + demand rollup from openings.
-- Warehouse "needed vs have" becomes the planset openings source of truth.

-- Allow 'assigned' in the movements event log (unit linked to an opening).
alter table movements drop constraint if exists movements_event_check;
alter table movements add constraint movements_event_check
  check (event in (
    'received','putaway','moved','staged','loaded','installed','damaged',
    'count_verified','count_missing','override','assigned'
  ));

-- Link a physical inventory unit to an opening. Validates type match, sets
-- windows.project_id, and logs a movement with p_actor.
create or replace function assign_window_to_opening(
  p_opening_id uuid,
  p_window_id uuid,
  p_actor text default null
)
returns project_openings
language plpgsql
as $$
declare
  v_opening project_openings;
  v_window windows;
begin
  select * into v_opening from project_openings where id = p_opening_id;
  if v_opening is null then
    raise exception 'unknown opening %', p_opening_id;
  end if;
  if v_opening.status = 'installed' then
    raise exception 'opening % is already installed', v_opening.opening_code;
  end if;

  select * into v_window from windows where id = p_window_id;
  if v_window is null then
    raise exception 'unknown window %', p_window_id;
  end if;
  if v_window.status = 'installed' then
    raise exception '% is already installed', v_window.window_id;
  end if;
  if v_opening.window_type_id is not null
     and v_window.window_type_id <> v_opening.window_type_id then
    raise exception 'type mismatch: % is not the type planned for opening %',
      v_window.window_id, v_opening.opening_code;
  end if;

  update windows
  set project_id = v_opening.project_id
  where id = v_window.id
    and (project_id is distinct from v_opening.project_id);

  update project_openings
  set assigned_window_id = v_window.id,
      window_type_id = coalesce(window_type_id, v_window.window_type_id),
      status = 'assigned'
  where id = p_opening_id
  returning * into v_opening;

  insert into movements (window_id, event, project_id, actor, reason)
  values (
    v_window.id,
    'assigned',
    v_opening.project_id,
    p_actor,
    'assigned to opening ' || v_opening.opening_code
  );

  return v_opening;
end;
$$;

-- Roll confirmed openings (with a type) up into project_windows quantities.
-- Called by trigger whenever openings change confirmation/type for a project.
create or replace function sync_project_windows_from_openings(p_project_id uuid)
returns void
language plpgsql
as $$
begin
  -- Drop demand rows that no longer have any confirmed typed openings.
  delete from project_windows pw
  where pw.project_id = p_project_id
    and not exists (
      select 1
      from project_openings o
      where o.project_id = p_project_id
        and o.confirmed = true
        and o.window_type_id = pw.window_type_id
    );

  -- Upsert quantities from confirmed openings that have a type.
  insert into project_windows (project_id, window_type_id, quantity)
  select
    p_project_id,
    o.window_type_id,
    count(*)::int
  from project_openings o
  where o.project_id = p_project_id
    and o.confirmed = true
    and o.window_type_id is not null
  group by o.window_type_id
  on conflict (project_id, window_type_id)
  do update set quantity = excluded.quantity;
end;
$$;

create or replace function trg_sync_project_windows_from_openings()
returns trigger
language plpgsql
as $$
declare
  v_project_id uuid;
begin
  if tg_op = 'DELETE' then
    v_project_id := old.project_id;
  else
    v_project_id := new.project_id;
  end if;

  -- Also sync the previous project if an opening moved (shouldn't happen, but safe).
  if tg_op = 'UPDATE'
     and old.project_id is distinct from new.project_id then
    perform sync_project_windows_from_openings(old.project_id);
  end if;

  perform sync_project_windows_from_openings(v_project_id);
  return coalesce(new, old);
end;
$$;

drop trigger if exists project_openings_sync_demand on project_openings;
create trigger project_openings_sync_demand
  after insert or delete or update of confirmed, window_type_id, project_id
  on project_openings
  for each row
  execute function trg_sync_project_windows_from_openings();

-- Backfill: sync all projects that already have confirmed openings.
do $$
declare
  r record;
begin
  for r in
    select distinct project_id
    from project_openings
    where confirmed = true
  loop
    perform sync_project_windows_from_openings(r.project_id);
  end loop;
end;
$$;

-- ============================================================================
-- 2) ai brain  [20260715210000_ai_brain.sql]
-- =============================================================================

-- Phase 2 (prototype): AI brain columns on window_types + transcription bookkeeping.
-- OPENAI_API_KEY lives only as an Edge Function secret (never in git/client).
-- Transcription is invoked from the app after voice upload (no DB webhooks).

alter table window_types
  add column if not exists tips_json jsonb not null default '[]'::jsonb,
  add column if not exists watch_outs_json jsonb not null default '[]'::jsonb,
  add column if not exists outcome_difficulty int
    check (outcome_difficulty is null or outcome_difficulty between 1 and 5),
  add column if not exists tips_synthesized_at timestamptz,
  add column if not exists tips_install_count int not null default 0;

comment on column window_types.tips_json is
  'Synthesized top tips from install memos (human-editable; regenerate additively).';
comment on column window_types.watch_outs_json is
  'Synthesized watch-outs / pitfalls from install memos.';
comment on column window_types.outcome_difficulty is
  'Difficulty derived from grades/times (overrides gut-feel catalog rating in UI when set).';

alter table attachments
  add column if not exists transcribed_at timestamptz;

create index if not exists attachments_voice_pending_idx
  on attachments (created_at)
  where kind = 'voice_memo' and transcribed_at is null;

-- ============================================================================
-- 3) fit condition gate  [20260715230000_fit_condition_gate.sql]
-- =============================================================================

-- Pillar 1: "Never carry a window that won't go in."
-- Rough-opening measurement + condition/damage check on each opening, so the
-- app can flag a misfit or damaged unit BEFORE the installer carries it up.

alter table project_openings
  add column if not exists ro_width_in numeric check (ro_width_in is null or ro_width_in > 0),
  add column if not exists ro_height_in numeric check (ro_height_in is null or ro_height_in > 0),
  add column if not exists ro_measured_by text,
  add column if not exists ro_measured_at timestamptz,
  add column if not exists condition text not null default 'unknown'
    check (condition in ('unknown','ok','damaged')),
  add column if not exists condition_note text,
  add column if not exists condition_checked_by text,
  add column if not exists condition_checked_at timestamptz;

comment on column project_openings.ro_width_in is
  'Rough-opening width (in), smallest of 3 measured points.';
comment on column project_openings.ro_height_in is
  'Rough-opening height (in), smallest of 2 measured points.';
comment on column project_openings.condition is
  'Arrival condition of the assigned unit: unknown | ok | damaged. Damaged blocks install.';

-- Record a rough-opening measurement (smallest width/height already chosen client-side).
create or replace function set_opening_rough_opening(
  p_opening_id uuid,
  p_width_in numeric,
  p_height_in numeric,
  p_actor text default null
)
returns project_openings
language plpgsql
as $$
declare
  v_opening project_openings;
begin
  update project_openings
  set ro_width_in = p_width_in,
      ro_height_in = p_height_in,
      ro_measured_by = p_actor,
      ro_measured_at = now()
  where id = p_opening_id
  returning * into v_opening;

  if v_opening is null then
    raise exception 'unknown opening %', p_opening_id;
  end if;
  return v_opening;
end;
$$;

-- Record the arrival condition of the unit at an opening.
create or replace function set_opening_condition(
  p_opening_id uuid,
  p_condition text,
  p_note text default null,
  p_actor text default null
)
returns project_openings
language plpgsql
as $$
declare
  v_opening project_openings;
begin
  if p_condition not in ('unknown','ok','damaged') then
    raise exception 'invalid condition %', p_condition;
  end if;

  update project_openings
  set condition = p_condition,
      condition_note = p_note,
      condition_checked_by = p_actor,
      condition_checked_at = now()
  where id = p_opening_id
  returning * into v_opening;

  if v_opening is null then
    raise exception 'unknown opening %', p_opening_id;
  end if;

  -- Damaged units flag the physical record so the office/warehouse sees it too.
  if p_condition = 'damaged' and v_opening.assigned_window_id is not null then
    update windows set status = 'damaged' where id = v_opening.assigned_window_id;
    insert into movements (window_id, event, project_id, actor, reason)
    values (
      v_opening.assigned_window_id, 'damaged', v_opening.project_id, p_actor,
      coalesce('damaged at opening ' || v_opening.opening_code ||
        case when p_note is not null then ': ' || p_note else '' end,
        'damaged at opening')
    );
  end if;

  return v_opening;
end;
$$;

-- ============================================================================
-- 4) crew dispatch  [20260715240000_crew_dispatch.sql]
-- =============================================================================

-- Crew dispatch (1B real logins + 2B foreman push).
-- Per-installer identity + skill, and lead-assigned openings so each installer
-- gets an ordered "my work" list and six people never collide.

-- Crew profiles, keyed to auth.users. Trusted-crew RLS like the rest of the app.
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  skill_level int not null default 2 check (skill_level between 1 and 5),
  role text not null default 'installer' check (role in ('installer','lead')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table profiles enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'profiles' and policyname = 'authenticated full access') then
    create policy "authenticated full access" on profiles
      for all to authenticated using (true) with check (true);
  end if;
end;
$$;

-- Foreman-push assignment on openings. Person-workflow state is derived:
--   status='installed' => done; work_started_at set => in-progress;
--   assigned_to set => assigned; else unassigned.
alter table project_openings
  add column if not exists assigned_to uuid references profiles(id) on delete set null,
  add column if not exists assigned_by uuid references profiles(id) on delete set null,
  add column if not exists assigned_at timestamptz,
  add column if not exists sequence int,
  add column if not exists work_started_at timestamptz;

create index if not exists project_openings_assigned_idx
  on project_openings (assigned_to, sequence);

-- Assign (or reassign) an opening to an installer.
create or replace function assign_opening_to_installer(
  p_opening_id uuid,
  p_profile_id uuid,
  p_actor_id uuid default null,
  p_sequence int default null
)
returns project_openings
language plpgsql
as $$
declare
  v_opening project_openings;
begin
  update project_openings
  set assigned_to = p_profile_id,
      assigned_by = p_actor_id,
      assigned_at = now(),
      sequence = coalesce(p_sequence, sequence)
  where id = p_opening_id
  returning * into v_opening;

  if v_opening is null then
    raise exception 'unknown opening %', p_opening_id;
  end if;
  return v_opening;
end;
$$;

create or replace function unassign_opening(p_opening_id uuid)
returns project_openings
language plpgsql
as $$
declare
  v_opening project_openings;
begin
  update project_openings
  set assigned_to = null, assigned_by = null, assigned_at = null
  where id = p_opening_id
  returning * into v_opening;

  if v_opening is null then
    raise exception 'unknown opening %', p_opening_id;
  end if;
  return v_opening;
end;
$$;

-- Installer taps "Next" — marks the opening in-progress (soft lock / visibility).
create or replace function start_opening_work(p_opening_id uuid)
returns project_openings
language plpgsql
as $$
declare
  v_opening project_openings;
begin
  update project_openings
  set work_started_at = coalesce(work_started_at, now())
  where id = p_opening_id
  returning * into v_opening;

  if v_opening is null then
    raise exception 'unknown opening %', p_opening_id;
  end if;
  return v_opening;
end;
$$;

-- Bulk set the walk order for a person's list.
create or replace function set_openings_sequence(p_opening_ids uuid[])
returns void
language plpgsql
as $$
begin
  update project_openings o
  set sequence = arr.ord
  from (
    select id, (idx - 1) as ord
    from unnest(p_opening_ids) with ordinality as t(id, idx)
  ) arr
  where o.id = arr.id;
end;
$$;

-- Live multi-crew sync: openings must be in the realtime publication so the
-- lead board and every installer's "My Work" update across devices.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'project_openings'
  ) then
    alter publication supabase_realtime add table project_openings;
  end if;
end;
$$;

-- ============================================================================
-- 5) learning rollups  [20260716000000_learning_rollups.sql]
-- =============================================================================

-- Phase A1: persist per-type learning so it drives dispatch, estimates, and UI
-- instead of being recomputed at read-time and thrown away.

alter table window_types
  add column if not exists n_installs int not null default 0,
  add column if not exists median_minutes numeric,
  add column if not exists p90_minutes numeric,
  add column if not exists avg_grade numeric,
  add column if not exists fail_rate numeric,
  add column if not exists learned_difficulty numeric,
  add column if not exists last_install_at timestamptz;

comment on column window_types.learned_difficulty is
  'Data-driven difficulty 1-5 from real outcomes: median-time percentile across the catalog + fail rate + inverse avg grade. No LLM.';

-- Recompute one type's rollups from its install_events.
create or replace function recompute_window_type_rollups(p_type_id uuid)
returns void
language plpgsql
as $$
declare
  v_n int;
  v_median numeric;
  v_p90 numeric;
  v_avg_grade numeric;
  v_fail numeric;
  v_last timestamptz;
  v_time_score numeric;
  v_grade_score numeric;
  v_diff numeric;
  v_min_med numeric;
  v_max_med numeric;
begin
  select
    count(*) filter (where minutes is not null),
    percentile_cont(0.5) within group (order by minutes) filter (where minutes is not null),
    percentile_cont(0.9) within group (order by minutes) filter (where minutes is not null),
    avg(quality_grade) filter (where quality_grade is not null),
    (count(*) filter (where quality_grade is not null and quality_grade <= 2))::numeric
      / nullif(count(*) filter (where quality_grade is not null), 0),
    max(created_at)
  into v_n, v_median, v_p90, v_avg_grade, v_fail, v_last
  from install_events
  where window_type_id = p_type_id;

  -- Difficulty model (1-5): where this type's median time sits across the
  -- catalog, nudged by fail rate and low grades. Falls back to seeded rating.
  select min(median_minutes), max(median_minutes)
  into v_min_med, v_max_med
  from window_types
  where median_minutes is not null;

  if v_median is not null and v_max_med is not null and v_max_med > coalesce(v_min_med, 0) then
    v_time_score := (v_median - v_min_med) / (v_max_med - v_min_med); -- 0..1
  else
    v_time_score := 0.5;
  end if;
  v_grade_score := coalesce((5 - v_avg_grade) / 4.0, 0.3); -- worse grade => harder
  v_diff := 1 + 4 * least(1, greatest(0,
    0.5 * v_time_score + 0.3 * coalesce(v_fail, 0) + 0.2 * v_grade_score));

  update window_types
  set n_installs = coalesce(v_n, 0),
      median_minutes = v_median,
      p90_minutes = v_p90,
      avg_grade = round(v_avg_grade, 2),
      fail_rate = round(v_fail * 100, 1),
      learned_difficulty = case when v_n >= 2 then round(v_diff, 2) else learned_difficulty end,
      last_install_at = v_last
  where id = p_type_id;
end;
$$;

create or replace function trg_recompute_rollups()
returns trigger
language plpgsql
as $$
declare
  v_type uuid;
begin
  v_type := coalesce(new.window_type_id, old.window_type_id);
  if v_type is not null then
    perform recompute_window_type_rollups(v_type);
  end if;
  -- On UPDATE that moved the row to a different type, refresh the old one too.
  if tg_op = 'UPDATE' and new.window_type_id is distinct from old.window_type_id
     and old.window_type_id is not null then
    perform recompute_window_type_rollups(old.window_type_id);
  end if;
  return coalesce(new, old);
end;
$$;

drop trigger if exists install_events_rollups on install_events;
create trigger install_events_rollups
  after insert or update or delete on install_events
  for each row
  execute function trg_recompute_rollups();

-- Backfill every type that already has installs.
do $$
declare r record;
begin
  for r in select distinct window_type_id from install_events where window_type_id is not null
  loop
    perform recompute_window_type_rollups(r.window_type_id);
  end loop;
end;
$$;

-- ============================================================================
-- 6) installer identity  [20260716001000_installer_identity.sql]
-- =============================================================================

-- Phase A2: real installer identity on install events + a role-change guard.
-- Turns the free-text `installer` email into a real profiles FK so we can
-- learn per-installer performance, and captures the pre-install estimate and
-- structured photo findings.

alter table install_events
  add column if not exists installer_id uuid references profiles(id) on delete set null,
  add column if not exists estimate_minutes int check (estimate_minutes is null or estimate_minutes >= 0),
  add column if not exists photo_findings jsonb;

create index if not exists install_events_installer_idx
  on install_events (installer_id, window_type_id);

-- Recreate submit_install_event with installer_id + estimate captured.
drop function if exists submit_install_event(
  uuid, text, int, int, text, text, text, text, text, text, text, text, text, timestamptz
);

create or replace function submit_install_event(
  p_opening_id uuid,
  p_installer text default null,
  p_minutes int default null,
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
  p_started_at timestamptz default null,
  p_installer_id uuid default null,
  p_estimate_minutes int default null
)
returns install_events
language plpgsql
as $$
declare
  v_opening project_openings;
  v_event install_events;
begin
  select * into v_opening from project_openings where id = p_opening_id;
  if v_opening is null then
    raise exception 'unknown opening %', p_opening_id;
  end if;

  insert into install_events (
    project_opening_id, window_id, window_type_id, installer, installer_id,
    started_at, minutes, estimate_minutes, quality_grade, difficulty, went_well,
    went_poorly, obstacles, tools_helped, time_vs_estimate, safety_notes,
    do_again, transcript_raw
  ) values (
    v_opening.id, v_opening.assigned_window_id, v_opening.window_type_id,
    p_installer, coalesce(p_installer_id, auth.uid()), p_started_at, p_minutes,
    p_estimate_minutes, p_quality_grade, p_difficulty, p_went_well, p_went_poorly,
    p_obstacles, p_tools_helped, p_time_vs_estimate, p_safety_notes, p_do_again,
    p_transcript_raw
  )
  returning * into v_event;

  update project_openings
  set status = 'installed', confirmed = true
  where id = v_opening.id;

  if v_opening.assigned_window_id is not null then
    perform install_window(v_opening.assigned_window_id, p_installer);
  end if;

  return v_event;
end;
$$;

-- Backfill installer_id from the email already stored on past events.
update install_events e
set installer_id = p.id
from profiles p
join auth.users u on u.id = p.id
where e.installer_id is null and lower(e.installer) = lower(u.email);

-- Role-change guard: only an existing lead may change roles (stops self-promotion).
create or replace function set_profile_role(p_target uuid, p_role text)
returns profiles
language plpgsql
security definer
as $$
declare
  v_caller_role text;
  v_profile profiles;
begin
  if p_role not in ('installer','lead') then
    raise exception 'invalid role %', p_role;
  end if;
  select role into v_caller_role from profiles where id = auth.uid();
  if v_caller_role is distinct from 'lead' then
    raise exception 'only a lead can change roles';
  end if;
  update profiles set role = p_role, updated_at = now()
  where id = p_target
  returning * into v_profile;
  return v_profile;
end;
$$;

-- ============================================================================
-- 7) installer stats  [20260716002000_installer_stats.sql]
-- =============================================================================

-- Phase A3: per-installer performance so dispatch routes by proven results,
-- not just a hand-set skill tier.

-- Per installer x window type.
create or replace view installer_type_stats as
select
  e.installer_id,
  e.window_type_id,
  count(*) filter (where e.minutes is not null) as n,
  percentile_cont(0.5) within group (order by e.minutes)
    filter (where e.minutes is not null) as median_minutes,
  avg(e.quality_grade) filter (where e.quality_grade is not null) as avg_grade,
  (count(*) filter (where e.quality_grade is not null and e.quality_grade <= 2))::numeric
    / nullif(count(*) filter (where e.quality_grade is not null), 0) as fail_rate,
  max(e.created_at) as last_at
from install_events e
where e.installer_id is not null and e.window_type_id is not null
group by e.installer_id, e.window_type_id;

-- Per installer x category (broader signal for cold-start on a new type).
create or replace view installer_category_stats as
select
  e.installer_id,
  t.category,
  count(*) filter (where e.minutes is not null) as n,
  percentile_cont(0.5) within group (order by e.minutes)
    filter (where e.minutes is not null) as median_minutes,
  avg(e.quality_grade) filter (where e.quality_grade is not null) as avg_grade
from install_events e
join window_types t on t.id = e.window_type_id
where e.installer_id is not null and t.category is not null
group by e.installer_id, t.category;

-- Training clearance: which installers a lead has signed off to install a type.
-- A cleared apprentice can take a harder type than their raw skill tier allows,
-- so the training path visibly changes dispatch routing.
create table if not exists installer_clearance (
  installer_id uuid not null references profiles(id) on delete cascade,
  window_type_id uuid not null references window_types(id) on delete cascade,
  cleared_by uuid references profiles(id) on delete set null,
  cleared_at timestamptz not null default now(),
  primary key (installer_id, window_type_id)
);

alter table installer_clearance enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'installer_clearance' and policyname = 'authenticated full access') then
    create policy "authenticated full access" on installer_clearance
      for all to authenticated using (true) with check (true);
  end if;
end;
$$;

create or replace function set_clearance(
  p_installer_id uuid,
  p_window_type_id uuid,
  p_cleared boolean
)
returns void
language plpgsql
security definer
as $$
declare v_caller_role text;
begin
  select role into v_caller_role from profiles where id = auth.uid();
  if v_caller_role is distinct from 'lead' then
    raise exception 'only a lead can set clearance';
  end if;
  if p_cleared then
    insert into installer_clearance (installer_id, window_type_id, cleared_by)
    values (p_installer_id, p_window_type_id, auth.uid())
    on conflict (installer_id, window_type_id) do nothing;
  else
    delete from installer_clearance
    where installer_id = p_installer_id and window_type_id = p_window_type_id;
  end if;
end;
$$;

-- ============================================================================
-- 8) job estimate  [20260716003000_job_estimate.sql]
-- =============================================================================

-- Phase A4: capture a job's estimate at plan time so we can track bid accuracy
-- (estimate vs actual) as installs complete.

alter table projects
  add column if not exists estimated_minutes int,
  add column if not exists estimated_crew int,
  add column if not exists estimated_at timestamptz;

-- ============================================================================
-- 9) memo confirm  [20260716004000_memo_confirm.sql]
-- =============================================================================

-- Phase A6: human-in-the-loop confirmation of AI-filled memo fields.
-- Raises training-data quality (installers correct the AI split), and lets us
-- surface a "review AI memos" queue.

alter table install_events
  add column if not exists ai_confirmed boolean not null default false;

-- Mark which events still need a human glance: has a transcript (AI ran) but
-- not yet confirmed.
create index if not exists install_events_unconfirmed_idx
  on install_events (installer_id)
  where transcript_raw is not null and ai_confirmed = false;

-- ============================================================================
-- 10) training howto  [20260716005000_training_howto.sql]
-- =============================================================================

-- Phase B1: golden reference install + AI-generated how-to per type.

alter table window_types
  add column if not exists golden_install_event_id uuid references install_events(id) on delete set null,
  add column if not exists golden_locked boolean not null default false,
  add column if not exists howto_json jsonb,
  add column if not exists howto_generated_at timestamptz;

-- Auto-nominate the golden install for a type: best grade, then documented
-- (transcript + photos), most recent. Skips when a lead has locked one.
create or replace function pick_golden_install(p_type_id uuid)
returns void
language plpgsql
as $$
declare v_locked boolean; v_golden uuid;
begin
  select golden_locked into v_locked from window_types where id = p_type_id;
  if v_locked then return; end if;

  select e.id into v_golden
  from install_events e
  where e.window_type_id = p_type_id
  order by
    coalesce(e.quality_grade, 0) desc,
    (e.transcript_raw is not null) desc,
    (exists (select 1 from attachments a
             where a.install_event_id = e.id and a.kind = 'photo')) desc,
    e.created_at desc
  limit 1;

  update window_types set golden_install_event_id = v_golden where id = p_type_id;
end;
$$;

-- Fold golden selection into the rollup trigger so it stays fresh per install.
create or replace function trg_recompute_rollups()
returns trigger language plpgsql as $$
declare v_type uuid;
begin
  v_type := coalesce(new.window_type_id, old.window_type_id);
  if v_type is not null then
    perform recompute_window_type_rollups(v_type);
    perform pick_golden_install(v_type);
  end if;
  if tg_op = 'UPDATE' and new.window_type_id is distinct from old.window_type_id
     and old.window_type_id is not null then
    perform recompute_window_type_rollups(old.window_type_id);
    perform pick_golden_install(old.window_type_id);
  end if;
  return coalesce(new, old);
end;
$$;

-- Lead sets/locks a golden install manually.
create or replace function set_golden_install(p_type_id uuid, p_event_id uuid)
returns void
language plpgsql
security definer
as $$
declare v_role text;
begin
  select role into v_role from profiles where id = auth.uid();
  if v_role is distinct from 'lead' then
    raise exception 'only a lead can set the golden install';
  end if;
  update window_types
  set golden_install_event_id = p_event_id, golden_locked = true
  where id = p_type_id;
end;
$$;

-- Backfill golden picks for types that already have installs.
do $$ declare r record; begin
  for r in select distinct window_type_id from install_events where window_type_id is not null loop
    perform pick_golden_install(r.window_type_id);
  end loop;
end; $$;

-- ============================================================================
-- 11) field flags  [20260716010000_field_flags.sql]
-- =============================================================================

-- Installer-first: let the field escalate problems to the lead.
-- An opening can be flagged (with a reason) and a job can carry general notes.

alter table project_openings
  add column if not exists flag_note text,
  add column if not exists flagged_by uuid references profiles(id) on delete set null,
  add column if not exists flagged_at timestamptz;

create table if not exists job_notes (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  author_id uuid references profiles(id) on delete set null,
  author_name text,
  note text not null,
  created_at timestamptz not null default now()
);

alter table job_notes enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where tablename='job_notes' and policyname='authenticated full access') then
    create policy "authenticated full access" on job_notes
      for all to authenticated using (true) with check (true);
  end if;
end;
$$;

create index if not exists job_notes_project_idx on job_notes (project_id, created_at desc);

-- Flag (or clear) an opening for the lead. Null note clears the flag.
create or replace function flag_opening(p_opening_id uuid, p_note text)
returns project_openings
language plpgsql
as $$
declare v_opening project_openings;
begin
  update project_openings
  set flag_note = nullif(trim(coalesce(p_note, '')), ''),
      flagged_by = case when nullif(trim(coalesce(p_note, '')), '') is null then null else auth.uid() end,
      flagged_at = case when nullif(trim(coalesce(p_note, '')), '') is null then null else now() end
  where id = p_opening_id
  returning * into v_opening;
  if v_opening is null then
    raise exception 'unknown opening %', p_opening_id;
  end if;
  return v_opening;
end;
$$;

-- Post a general, opening-independent job note (site conditions, etc.).
create or replace function add_job_note(p_project_id uuid, p_note text)
returns job_notes
language plpgsql
as $$
declare v_note job_notes; v_name text;
begin
  select display_name into v_name from profiles where id = auth.uid();
  insert into job_notes (project_id, author_id, author_name, note)
  values (p_project_id, auth.uid(), v_name, p_note)
  returning * into v_note;
  return v_note;
end;
$$;

-- Openings already stream via realtime; add job_notes too for the lead board.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'job_notes'
  ) then
    alter publication supabase_realtime add table job_notes;
  end if;
end;
$$;

-- ============================================================================
-- 12) roles expand  [20260717000000_roles_expand.sql]
-- =============================================================================

-- Merge: expand the role model to match Infinity (installer / foreman / admin /
-- big_boss), keeping the existing 'lead' value working as a lead-level alias.

alter table profiles drop constraint if exists profiles_role_check;
alter table profiles add constraint profiles_role_check
  check (role in ('installer','lead','foreman','admin','big_boss'));

-- Access requests: new crew submit info; an admin approves before sign-in.
create table if not exists access_requests (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text,
  phone text,
  requested_role text not null default 'installer'
    check (requested_role in ('installer','foreman','admin')),
  note text,
  status text not null default 'pending'
    check (status in ('pending','approved','denied')),
  decided_by uuid references profiles(id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now()
);

alter table access_requests enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where tablename='access_requests' and policyname='authenticated full access') then
    create policy "authenticated full access" on access_requests for all to authenticated using (true) with check (true);
  end if;
  -- Anyone (even anon) can submit a request.
  if not exists (select 1 from pg_policies where tablename='access_requests' and policyname='anon can request') then
    create policy "anon can request" on access_requests for insert to anon with check (true);
  end if;
end;
$$;

-- Optional device PIN for quick unlock (convenience over a real session).
alter table profiles
  add column if not exists pin text;

-- Expand the role-change guard to the new roles; any lead-level user may set.
create or replace function set_profile_role(p_target uuid, p_role text)
returns profiles
language plpgsql
security definer
as $$
declare
  v_caller_role text;
  v_profile profiles;
begin
  if p_role not in ('installer','lead','foreman','admin','big_boss') then
    raise exception 'invalid role %', p_role;
  end if;
  select role into v_caller_role from profiles where id = auth.uid();
  if v_caller_role is null or v_caller_role = 'installer' then
    raise exception 'only a lead-level user can change roles';
  end if;
  update profiles set role = p_role, updated_at = now()
  where id = p_target
  returning * into v_profile;
  return v_profile;
end;
$$;

-- Set/clear a personal PIN (self only).
create or replace function set_my_pin(p_pin text)
returns void
language plpgsql
security definer
as $$
begin
  update profiles set pin = nullif(p_pin, ''), updated_at = now()
  where id = auth.uid();
end;
$$;

-- ============================================================================
-- 13) time clock  [20260717001000_time_clock.sql]
-- =============================================================================

-- Merge: time clock / payroll. Shifts with cost-code splits, breaks, photos,
-- and a signed sign-off. Foreman/admin approve.

create table if not exists cost_codes (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  label text not null,
  active boolean not null default true
);

insert into cost_codes (code, label) values
  ('100', 'Install — windows'),
  ('110', 'Install — doors'),
  ('200', 'Load / unload'),
  ('300', 'Rework / callback'),
  ('400', 'Shop / staging'),
  ('900', 'Travel')
on conflict do nothing;

create table if not exists time_shifts (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  cost_code_id uuid references cost_codes(id) on delete set null,
  clock_in_at timestamptz not null default now(),
  clock_out_at timestamptz,
  break_seconds int not null default 0,
  clock_in_photo text,
  clock_out_photo text,
  injured boolean,
  time_confirmed boolean,
  signed_at timestamptz,
  status text not null default 'open'
    check (status in ('open','submitted','approved')),
  approved_by uuid references profiles(id) on delete set null,
  approved_at timestamptz,
  edited_note text,
  created_at timestamptz not null default now()
);

create index if not exists time_shifts_profile_idx on time_shifts (profile_id, clock_in_at desc);
create index if not exists time_shifts_status_idx on time_shifts (status);

alter table cost_codes enable row level security;
alter table time_shifts enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where tablename='cost_codes' and policyname='authenticated full access') then
    create policy "authenticated full access" on cost_codes for all to authenticated using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename='time_shifts' and policyname='authenticated full access') then
    create policy "authenticated full access" on time_shifts for all to authenticated using (true) with check (true);
  end if;
end;
$$;

-- Clock in — the single source of truth for this RPC is defined later in the
-- toolbox talks section (with the hard toolbox-signed gate). It intentionally
-- lives there so a full-bundle apply ends with the gated definition and the
-- earlier ungated version can never win. See
-- [20260718003000_toolbox_talks.sql].

-- Clock out + sign-off.
create or replace function clock_out(
  p_shift_id uuid, p_photo text default null,
  p_injured boolean default false, p_time_confirmed boolean default true,
  p_break_seconds int default null
)
returns time_shifts language plpgsql as $$
declare v_shift time_shifts;
begin
  update time_shifts
  set clock_out_at = now(),
      clock_out_photo = coalesce(p_photo, clock_out_photo),
      injured = p_injured,
      time_confirmed = p_time_confirmed,
      break_seconds = coalesce(p_break_seconds, break_seconds),
      signed_at = now(),
      status = 'submitted'
  where id = p_shift_id and profile_id = auth.uid()
  returning * into v_shift;
  if v_shift is null then raise exception 'no open shift %', p_shift_id; end if;
  return v_shift;
end;
$$;

create or replace function approve_shift(p_shift_id uuid)
returns time_shifts language plpgsql security definer as $$
declare v_role text; v_shift time_shifts;
begin
  select role into v_role from profiles where id = auth.uid();
  if v_role is null or v_role = 'installer' then
    raise exception 'only a lead-level user can approve';
  end if;
  update time_shifts set status='approved', approved_by=auth.uid(), approved_at=now()
  where id = p_shift_id returning * into v_shift;
  return v_shift;
end;
$$;

-- ============================================================================
-- 14) job costing  [20260717002000_job_costing.sql]
-- =============================================================================

-- Merge: job costing / margin (Big Boss). Bid/revenue on projects, cost ledger,
-- change orders. Margin is computed from these + labor from time_shifts.

alter table projects
  add column if not exists bid_amount numeric,
  add column if not exists target_margin_pct numeric;

create table if not exists job_costs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  category text not null default 'other'
    check (category in ('labor','materials','equipment','subs','other')),
  label text,
  amount numeric not null,
  cost_date date not null default current_date,
  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists change_orders (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  label text not null,
  amount numeric not null,
  created_at timestamptz not null default now()
);

create index if not exists job_costs_project_idx on job_costs (project_id, cost_date desc);
create index if not exists change_orders_project_idx on change_orders (project_id);

alter table job_costs enable row level security;
alter table change_orders enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where tablename='job_costs' and policyname='authenticated full access') then
    create policy "authenticated full access" on job_costs for all to authenticated using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename='change_orders' and policyname='authenticated full access') then
    create policy "authenticated full access" on change_orders for all to authenticated using (true) with check (true);
  end if;
end;
$$;

-- ============================================================================
-- 15) education  [20260717003000_education.sql]
-- =============================================================================

-- Merge: education. Per-user spaced-repetition progress over the glossary,
-- plus callback root-cause terms that get pushed into daily decks.

create table if not exists learn_progress (
  profile_id uuid not null references profiles(id) on delete cascade,
  term_id text not null,
  box int not null default 0,          -- Leitner box 0..5
  due date not null default current_date,
  again_count int not null default 0,
  got_count int not null default 0,
  updated_at timestamptz not null default now(),
  primary key (profile_id, term_id)
);

-- Terms flagged by a callback root-cause; surface first in everyone's deck.
create table if not exists learn_priority_terms (
  term_id text primary key,
  reason text,
  created_at timestamptz not null default now()
);

alter table learn_progress enable row level security;
alter table learn_priority_terms enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where tablename='learn_progress' and policyname='authenticated full access') then
    create policy "authenticated full access" on learn_progress for all to authenticated using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename='learn_priority_terms' and policyname='authenticated full access') then
    create policy "authenticated full access" on learn_priority_terms for all to authenticated using (true) with check (true);
  end if;
end;
$$;

-- ============================================================================
-- 16) points  [20260717004000_points.sql]
-- =============================================================================

-- Merge: points / gamification ledger.
create table if not exists points_ledger (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles(id) on delete cascade,
  kind text not null,
  points int not null,
  ref text,
  created_at timestamptz not null default now()
);
create index if not exists points_ledger_profile_idx on points_ledger (profile_id, created_at desc);

alter table points_ledger enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where tablename='points_ledger' and policyname='authenticated full access') then
    create policy "authenticated full access" on points_ledger for all to authenticated using (true) with check (true);
  end if;
end;
$$;

-- ============================================================================
-- 17) ops modules  [20260717005000_ops_modules.sql]
-- =============================================================================

-- Merge: Safety, Tools, Supplies, and QC modules.

-- Safety: toolbox talks + acknowledgements + incident log.
create table if not exists safety_talks (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  body text not null,
  talk_date date not null default current_date,
  created_at timestamptz not null default now()
);
create table if not exists safety_acks (
  talk_id uuid not null references safety_talks(id) on delete cascade,
  profile_id uuid not null references profiles(id) on delete cascade,
  ack_at timestamptz not null default now(),
  primary key (talk_id, profile_id)
);
create table if not exists incidents (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid references profiles(id) on delete set null,
  project_id uuid references projects(id) on delete set null,
  description text not null,
  severity text not null default 'near_miss'
    check (severity in ('near_miss','first_aid','recordable','serious')),
  created_at timestamptz not null default now()
);

-- Tools: who has what + calibration due.
create table if not exists tools (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  holder_id uuid references profiles(id) on delete set null,
  calibration_due date,
  note text,
  created_at timestamptz not null default now()
);

-- Supplies: company catalog + per-job orders / pull lists.
create table if not exists supplies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  unit text default 'ea',
  created_at timestamptz not null default now()
);
create table if not exists supply_orders (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references projects(id) on delete cascade,
  supply_id uuid references supplies(id) on delete set null,
  name text,
  qty numeric not null default 1,
  status text not null default 'needed'
    check (status in ('needed','ordered','picked','used')),
  created_at timestamptz not null default now()
);

-- QC: per-opening quality sign-off.
create table if not exists qc_checks (
  id uuid primary key default gen_random_uuid(),
  project_opening_id uuid not null references project_openings(id) on delete cascade,
  status text not null default 'pending'
    check (status in ('pending','passed','callback')),
  note text,
  checked_by uuid references profiles(id) on delete set null,
  checked_at timestamptz,
  created_at timestamptz not null default now(),
  unique (project_opening_id)
);

do $$
declare t text;
begin
  foreach t in array array['safety_talks','safety_acks','incidents','tools','supplies','supply_orders','qc_checks']
  loop
    execute format('alter table %I enable row level security', t);
    if not exists (select 1 from pg_policies where tablename=t and policyname='authenticated full access') then
      execute format('create policy "authenticated full access" on %I for all to authenticated using (true) with check (true)', t);
    end if;
  end loop;
end;
$$;

-- Demo seed content.
insert into safety_talks (title, body) values
  ('Elevated work check', 'Before any work above 6 ft: inspect the ladder/lift, tie off, and clear the drop zone below. Nobody works overhead without a spotter.')
on conflict do nothing;

insert into supplies (name, unit) values
  ('Flashing tape 4"', 'roll'), ('Backer rod 1/2"', 'roll'), ('Low-exp foam', 'can'),
  ('Shims (cedar)', 'bundle'), ('Sealant (grey)', 'tube'), ('Setting blocks', 'bag')
on conflict do nothing;

-- ============================================================================
-- 18) points status  [20260717006000_points_status.sql]
-- =============================================================================

-- Quality: install points are pending until QC signs off; quiz points confirm immediately.
alter table points_ledger
  add column if not exists status text not null default 'confirmed'
    check (status in ('pending','confirmed','void'));

create index if not exists points_ledger_ref_idx on points_ledger (ref);

-- ============================================================================
-- 19) qc flywheel  [20260717007000_qc_flywheel.sql]
-- =============================================================================

-- Quality: QC callbacks feed the learning flywheel. A callback counts as a
-- "problem" alongside low grades in type rollups, learned difficulty, and
-- per-installer stats (which dispatch ranks on). Fixing rework now makes the
-- next assignment smarter.

-- Recompute type rollups with callbacks folded into the problem/fail rate.
create or replace function recompute_window_type_rollups(p_type_id uuid)
returns void
language plpgsql
as $$
declare
  v_n int; v_total int; v_median numeric; v_p90 numeric; v_avg_grade numeric;
  v_problem int; v_fail numeric; v_last timestamptz;
  v_time_score numeric; v_grade_score numeric; v_diff numeric;
  v_min_med numeric; v_max_med numeric;
begin
  select
    count(*) filter (where minutes is not null),
    count(*),
    percentile_cont(0.5) within group (order by minutes) filter (where minutes is not null),
    percentile_cont(0.9) within group (order by minutes) filter (where minutes is not null),
    avg(quality_grade) filter (where quality_grade is not null),
    max(created_at)
  into v_n, v_total, v_median, v_p90, v_avg_grade, v_last
  from install_events where window_type_id = p_type_id;

  -- Problem = low grade OR a QC callback on that opening.
  select count(distinct e.id)
  into v_problem
  from install_events e
  left join qc_checks q on q.project_opening_id = e.project_opening_id
  where e.window_type_id = p_type_id
    and (e.quality_grade <= 2 or q.status = 'callback');

  v_fail := case when coalesce(v_total,0) > 0 then v_problem::numeric / v_total else null end;

  select min(median_minutes), max(median_minutes) into v_min_med, v_max_med
  from window_types where median_minutes is not null;

  if v_median is not null and v_max_med is not null and v_max_med > coalesce(v_min_med, 0) then
    v_time_score := (v_median - v_min_med) / (v_max_med - v_min_med);
  else
    v_time_score := 0.5;
  end if;
  v_grade_score := coalesce((5 - v_avg_grade) / 4.0, 0.3);
  v_diff := 1 + 4 * least(1, greatest(0,
    0.5 * v_time_score + 0.3 * coalesce(v_fail, 0) + 0.2 * v_grade_score));

  update window_types
  set n_installs = coalesce(v_n, 0), median_minutes = v_median, p90_minutes = v_p90,
      avg_grade = round(v_avg_grade, 2),
      fail_rate = round(coalesce(v_fail, 0) * 100, 1),
      learned_difficulty = case when v_total >= 2 then round(v_diff, 2) else learned_difficulty end,
      last_install_at = v_last
  where id = p_type_id;
end;
$$;

-- When a QC check changes, recompute the affected type's rollups.
create or replace function trg_qc_recompute()
returns trigger language plpgsql as $$
declare v_type uuid;
begin
  select window_type_id into v_type from project_openings
  where id = coalesce(new.project_opening_id, old.project_opening_id);
  if v_type is not null then
    perform recompute_window_type_rollups(v_type);
  end if;
  return coalesce(new, old);
end;
$$;

drop trigger if exists qc_checks_recompute on qc_checks;
create trigger qc_checks_recompute
  after insert or update or delete on qc_checks
  for each row execute function trg_qc_recompute();

-- Per-installer stats now include callbacks in fail_rate (dispatch ranks on this).
create or replace view installer_type_stats as
select
  e.installer_id, e.window_type_id,
  count(*) filter (where e.minutes is not null) as n,
  percentile_cont(0.5) within group (order by e.minutes)
    filter (where e.minutes is not null) as median_minutes,
  avg(e.quality_grade) filter (where e.quality_grade is not null) as avg_grade,
  (count(distinct e.id) filter (where e.quality_grade <= 2 or q.status = 'callback'))::numeric
    / nullif(count(*), 0) as fail_rate,
  max(e.created_at) as last_at
from install_events e
left join qc_checks q on q.project_opening_id = e.project_opening_id
where e.installer_id is not null and e.window_type_id is not null
group by e.installer_id, e.window_type_id;

-- Backfill.
do $$ declare r record; begin
  for r in select distinct window_type_id from install_events where window_type_id is not null loop
    perform recompute_window_type_rollups(r.window_type_id);
  end loop;
end; $$;

-- ============================================================================
-- 20) pin and breaks  [20260717008000_pin_and_breaks.sql]
-- =============================================================================

-- Quality: PIN checked server-side (never read to the client), and break
-- state persisted server-side so a page refresh doesn't lose it.

-- Whether the current user has a PIN set (no value leaves the server).
create or replace function my_pin_status()
returns boolean
language plpgsql
security definer
as $$
declare v boolean;
begin
  select pin is not null into v from profiles where id = auth.uid();
  return coalesce(v, false);
end;
$$;

-- Verify a PIN attempt for the current user, server-side.
create or replace function check_my_pin(p_pin text)
returns boolean
language plpgsql
security definer
as $$
declare v text;
begin
  select pin into v from profiles where id = auth.uid();
  return v is not null and v = p_pin;
end;
$$;

-- Persisted break state on shifts.
alter table time_shifts
  add column if not exists break_started_at timestamptz;

create or replace function start_break(p_shift_id uuid)
returns time_shifts language plpgsql as $$
declare v time_shifts;
begin
  update time_shifts set break_started_at = coalesce(break_started_at, now())
  where id = p_shift_id and profile_id = auth.uid()
  returning * into v;
  if v is null then raise exception 'no open shift %', p_shift_id; end if;
  return v;
end;
$$;

create or replace function end_break(p_shift_id uuid)
returns time_shifts language plpgsql as $$
declare v time_shifts;
begin
  update time_shifts
  set break_seconds = break_seconds
        + greatest(0, extract(epoch from (now() - break_started_at))::int),
      break_started_at = null
  where id = p_shift_id and profile_id = auth.uid() and break_started_at is not null
  returning * into v;
  if v is null then
    select * into v from time_shifts where id = p_shift_id and profile_id = auth.uid();
  end if;
  return v;
end;
$$;

-- ============================================================================
-- 21) seed modules  [20260717009000_seed_modules.sql]
-- =============================================================================

-- Quality: seed the empty/thin modules so every screen shows real content in
-- the prototype (tools, a safety-talk rotation, and how-to guides beyond CAS3050).

-- Tools: common commercial install kit, a couple assigned to a lead.
insert into tools (name, calibration_due, note, holder_id)
select v.name, v.cal::date, v.note,
  case when v.assign then (select id from profiles order by role desc limit 1) else null end
from (values
  ('Hilti rotary laser',        '2026-10-01', 'Level reference for sills',           true),
  ('6ft box level',             null,          'Primary plumb/level check',           true),
  ('Torque screwdriver',        '2026-09-15', 'Pressure-plate torque 35-50 in-lb',   false),
  ('Vacuum lifting cups (pair)','2026-12-01', 'Rated 150 lb/cup on clean dry glass',  false),
  ('Moisture meter',            '2026-08-20', 'Substrate check before sealant',      false),
  ('Sealant gun (pneumatic)',   null,          'For long perimeter runs',             false),
  ('Digital caliper',           '2026-11-05', 'RO + shim gap verification',          false),
  ('Anemometer',                '2026-09-30', 'Wind check before lifts above 1 story', false)
) as v(name, cal, note, assign)
where not exists (select 1 from tools t where t.name = v.name);

-- Safety talks: a week-long rotation so a fresh one shows each day.
insert into safety_talks (title, body, talk_date)
select v.title, v.body, v.d::date
from (values
  ('Glass handling',       'Two people minimum over 150 lb. Carry lites on edge, never flat. Coated/tempered edges cut — gloves on, cups rated for the surface.', current_date + 1),
  ('Sealant & solvents',   'Read the SDS. Ventilate when tooling in enclosed spaces, skin protection for MEKP/primer, no open flame near solvents.', current_date + 2),
  ('Lift & rigging',       'Inspect straps and cups before every pick. Nobody under a suspended unit. Set A-frames braced and loaded evenly.', current_date + 3),
  ('Ladders & lifts',      'Three points of contact. Level the base. Scissor/boom lift: harness, gate closed, check the ground rating.', current_date + 4),
  ('Housekeeping',         'Clear the drop zone, cap exposed screws, sweep glass shards immediately. A clean deck is a safe deck.', current_date + 5),
  ('Heat & hydration',     'On hot elevations rotate shade breaks, water every 20 min. Dark glass against sun cracks — and burns hands.', current_date + 6)
) as v(title, body, d)
where not exists (select 1 from safety_talks s where s.title = v.title);

-- How-to guides beyond CAS3050: seed two more common types with structured steps.
update window_types set
  howto_json = '[
    {"title":"Verify the rough opening","detail":"Width at 3 points, height at 2, both diagonals. A double-hung binds fast if the sill is not level — fix the opening, never force the frame."},
    {"title":"Set the sill dead level","detail":"Shim at the setting points only, snug not tight. The sill is where a hung window lives or dies."},
    {"title":"Set and check reveal","detail":"Even reveal on all four sides before fastening. A tapered reveal tells you which corner is off."},
    {"title":"Fasten per schedule, re-check square","detail":"One over-driven screw racks the frame and drops the sashes. Check diagonals after each side."},
    {"title":"Flash jambs then head, foam light","detail":"Laps shed downhill. Low-expansion foam in passes so the jambs do not bow and jam the balances."}
  ]'::jsonb,
  howto_generated_at = now()
where type_code = 'DH2846';

update window_types set
  howto_json = '[
    {"title":"Confirm glass spec and safety bug","detail":"A large picture unit is heavy and often tempered/laminated. Check the etched bug and recalc crew/lift gear before it comes up."},
    {"title":"Dry-fit and stage on A-frames","detail":"Set on edge, never flat — a fixed lite this size will pop its IGU seal if racked during handling."},
    {"title":"Set on blocks, center the reveal","detail":"Setting blocks at the quarter points carry the weight. Center the unit so the perimeter joint is uniform for backer rod."},
    {"title":"Anchor without racking","detail":"Fixed units still rack. Fasten progressively and keep diagonals equal; a racked picture unit shows as a wavy reflection."},
    {"title":"Backer rod + tooled sealant","detail":"Rod to half the joint width, tool the same day. Big lites move a lot thermally — the joint must stretch, not shear."}
  ]'::jsonb,
  howto_generated_at = now()
where type_code = 'PIC6060';


-- =============================================================================
-- planset kind  [20260717140000_planset_kind.sql]
-- =============================================================================

-- Dual planset roles per job: building floor plans (map) vs specs/schedule
-- (mark → size/type/color). Existing uploads default to building so the map
-- keeps a background PDF; re-upload or tag as specs for schedule extract.

alter table project_plansets
  add column if not exists kind text not null default 'building'
    check (kind in ('building', 'specs'));

create index if not exists project_plansets_kind_idx
  on project_plansets(project_id, kind, created_at desc);

comment on column project_plansets.kind is
  'building = floor/elevation drawings for the map; specs = window/door schedule';


-- =============================================================================
-- role rename  [20260718000000_role_rename.sql]
-- =============================================================================

-- Collapse the role model to installer / foreman / supervisor / owner.
--   lead -> foreman, admin -> supervisor, big_boss -> owner.

update profiles set role = case role
  when 'lead' then 'foreman'
  when 'admin' then 'supervisor'
  when 'big_boss' then 'owner'
  else role
end
where role in ('lead', 'admin', 'big_boss');

alter table profiles drop constraint if exists profiles_role_check;
alter table profiles add constraint profiles_role_check
  check (role in ('installer', 'foreman', 'supervisor', 'owner'));

update access_requests set requested_role = 'supervisor'
  where requested_role = 'admin';
alter table access_requests drop constraint if exists access_requests_requested_role_check;
alter table access_requests add constraint access_requests_requested_role_check
  check (requested_role in ('installer', 'foreman', 'supervisor'));

create or replace function set_profile_role(p_target uuid, p_role text)
returns profiles
language plpgsql
security definer
as $$
declare
  v_caller_role text;
  v_profile profiles;
begin
  if p_role not in ('installer', 'foreman', 'supervisor', 'owner') then
    raise exception 'invalid role %', p_role;
  end if;
  select role into v_caller_role from profiles where id = auth.uid();
  if v_caller_role is null or v_caller_role = 'installer' then
    raise exception 'only a foreman-level user or above can change roles';
  end if;
  update profiles set role = p_role, updated_at = now()
  where id = p_target
  returning * into v_profile;
  return v_profile;
end;
$$;

create or replace function set_clearance(
  p_installer_id uuid,
  p_window_type_id uuid,
  p_cleared boolean
)
returns void
language plpgsql
security definer
as $$
declare v_caller_role text;
begin
  select role into v_caller_role from profiles where id = auth.uid();
  if v_caller_role is null or v_caller_role = 'installer' then
    raise exception 'only a foreman-level user or above can set clearance';
  end if;
  if p_cleared then
    insert into installer_clearance (installer_id, window_type_id, cleared_by)
    values (p_installer_id, p_window_type_id, auth.uid())
    on conflict (installer_id, window_type_id) do nothing;
  else
    delete from installer_clearance
    where installer_id = p_installer_id and window_type_id = p_window_type_id;
  end if;
end;
$$;

create or replace function set_golden_install(p_type_id uuid, p_event_id uuid)
returns void
language plpgsql
security definer
as $$
declare v_role text;
begin
  select role into v_role from profiles where id = auth.uid();
  if v_role is null or v_role = 'installer' then
    raise exception 'only a foreman-level user or above can set the golden install';
  end if;
  update window_types
  set golden_install_event_id = p_event_id, golden_locked = true
  where id = p_type_id;
end;
$$;

-- ============================================================================
-- window short code  [20260718001000_window_short_code.sql]
-- =============================================================================

-- Wave 1: hybrid identification. Every physical window keeps its QR + serial
-- license plate (W-<TYPE>-<SEQ>), and ALSO gets a short, hand-writable code so a
-- worker can scan the QR OR just write/type the code on the unit with a marker.
--
-- The code uses a no-ambiguous alphabet (no O/0/I/1) and is 6 chars long
-- (~1.07B combinations), unique per unit.

alter table windows add column if not exists short_code text;
create unique index if not exists windows_short_code_idx
  on windows(short_code) where short_code is not null;

-- Random 6-char code from a human-safe alphabet.
create or replace function gen_short_code(p_len int default 6)
returns text
language plpgsql
as $$
declare
  v_alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_out text := '';
  i int;
begin
  for i in 1..p_len loop
    v_out := v_out || substr(v_alphabet, 1 + floor(random() * length(v_alphabet))::int, 1);
  end loop;
  return v_out;
end;
$$;

-- Issue a code not already used by any unit.
create or replace function issue_window_short_code()
returns text
language plpgsql
as $$
declare v_code text;
begin
  loop
    v_code := gen_short_code(6);
    exit when not exists (select 1 from windows where short_code = v_code);
  end loop;
  return v_code;
end;
$$;

-- Backfill existing units.
do $$
declare r record;
begin
  for r in select id from windows where short_code is null loop
    update windows set short_code = issue_window_short_code() where id = r.id;
  end loop;
end;
$$;

-- Receive now also stamps a short code (retry on the rare unique collision).
create or replace function receive_window(
  p_type_id uuid,
  p_project_id uuid default null,
  p_actor text default null
)
returns windows
language plpgsql
as $$
declare
  v_window windows;
begin
  loop
    begin
      insert into windows (window_id, short_code, window_type_id, status, project_id)
      values (issue_window_id(p_type_id), issue_window_short_code(), p_type_id, 'inbound', p_project_id)
      returning * into v_window;
      exit;
    exception when unique_violation then
      -- extremely rare short_code collision; try again
    end;
  end loop;

  insert into movements (window_id, event, project_id, actor)
  values (v_window.id, 'received', p_project_id, p_actor);

  return v_window;
end;
$$;

-- Resolve a unit by its hand-writable short code OR its serial window_id.
create or replace function find_window_by_code(p_code text)
returns windows
language sql
stable
as $$
  select * from windows
  where upper(short_code) = upper(trim(p_code))
     or upper(window_id) = upper(trim(p_code))
  limit 1;
$$;


-- =============================================================================
-- install undo  [20260718002000_install_undo.sql]
-- =============================================================================

-- Install undo / reclaim: let a foreman-level user (or above) revert an install
-- while PRESERVING all install data. The install_event is voided, not deleted,
-- so history, memos, and learning inputs survive. The opening drops back to
-- assigned/planned, the unit returns to the truck, and points are voided.

-- Audit fields on the preserved install event.
alter table install_events
  add column if not exists voided_at timestamptz,
  add column if not exists void_reason text,
  add column if not exists voided_by uuid references profiles(id) on delete set null;

-- Allow logging the reverse movement (unit taken back off the wall).
alter table movements drop constraint if exists movements_event_check;
alter table movements add constraint movements_event_check
  check (event in (
    'received','putaway','moved','staged','loaded','installed','damaged',
    'count_verified','count_missing','override','assigned','uninstalled'
  ));

-- Undo the most recent install on an opening, preserving its history.
create or replace function undo_install(p_opening_id uuid, p_reason text default null)
returns void
language plpgsql
security definer
as $$
declare
  v_caller_role text;
  v_opening project_openings;
begin
  -- Guard: only elevated roles may undo. Only a plain installer is blocked, so
  -- this holds for both legacy (lead/foreman/admin/big_boss) and any new role
  -- names above installer.
  select role into v_caller_role from profiles where id = auth.uid();
  if v_caller_role is null or v_caller_role = 'installer' then
    raise exception 'only a foreman-level user or above can undo an install';
  end if;

  select * into v_opening from project_openings where id = p_opening_id;
  if v_opening is null then
    raise exception 'unknown opening %', p_opening_id;
  end if;

  -- Void (never delete) the most recent non-voided install event.
  update install_events
  set voided_at = now(),
      voided_by = auth.uid(),
      void_reason = p_reason
  where id = (
    select id from install_events
    where project_opening_id = p_opening_id
      and voided_at is null
    order by created_at desc
    limit 1
  );

  -- Revert the opening back to its pre-install state.
  update project_openings
  set status = case when assigned_window_id is not null then 'assigned' else 'planned' end,
      confirmed = false
  where id = p_opening_id;

  -- Return the physical unit to the truck and log the reverse movement.
  if v_opening.assigned_window_id is not null then
    update windows
    set status = 'loaded', installed_at = null
    where id = v_opening.assigned_window_id;

    insert into movements (window_id, event, project_id, actor, reason)
    values (
      v_opening.assigned_window_id,
      'uninstalled',
      v_opening.project_id,
      auth.uid()::text,
      coalesce(p_reason, 'install undone')
    );
  end if;

  -- Void any points earned for this install (ref stores the opening UUID as text).
  update points_ledger
  set status = 'void'
  where ref = p_opening_id::text
    and status in ('pending', 'confirmed');

  -- Refresh learned rollups for this type (best-effort; skip if absent).
  if v_opening.window_type_id is not null then
    begin
      perform recompute_window_type_rollups(v_opening.window_type_id);
    exception when undefined_function then
      null;
    end;
  end if;
end;
$$;


-- =============================================================================
-- toolbox talks  [20260718003000_toolbox_talks.sql]
-- =============================================================================

-- Daily educational toolbox talk that a worker must read + sign before their
-- first clock-in. Adds structured educational content to safety_talks, records
-- signed completions (typed name + drawn signature + dated PDF archive), and
-- hard-gates clock_in on today's signature.

alter table safety_talks add column if not exists sections_json jsonb;
alter table safety_talks add column if not exists visual_aids_json jsonb;

create table if not exists toolbox_completions (
  id uuid primary key default gen_random_uuid(),
  talk_id uuid references safety_talks(id) on delete set null,
  profile_id uuid references profiles(id) on delete cascade,
  signed_at timestamptz not null default now(),
  typed_name text,
  signature_path text,
  talk_snapshot text,
  pdf_path text,
  created_at timestamptz not null default now()
);

create index if not exists toolbox_completions_profile_idx
  on toolbox_completions (profile_id, signed_at desc);

alter table toolbox_completions enable row level security;
do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'toolbox_completions' and policyname = 'authenticated full access'
  ) then
    create policy "authenticated full access" on toolbox_completions
      for all to authenticated using (true) with check (true);
  end if;
end;
$$;

insert into storage.buckets (id, name, public)
values ('toolbox-records', 'toolbox-records', false)
on conflict (id) do nothing;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'objects' and policyname = 'authenticated toolbox records'
  ) then
    create policy "authenticated toolbox records"
      on storage.objects for all to authenticated
      using (bucket_id = 'toolbox-records')
      with check (bucket_id = 'toolbox-records');
  end if;
end;
$$;

create or replace function clock_in(
  p_project_id uuid, p_cost_code_id uuid, p_photo text default null
)
returns time_shifts language plpgsql as $$
declare v_shift time_shifts;
begin
  -- Hard gate: today's toolbox talk must be signed before clocking in.
  if not exists (
    select 1 from toolbox_completions
    where profile_id = auth.uid() and signed_at::date = current_date
  ) then
    raise exception 'complete today''s toolbox talk before clocking in';
  end if;

  update time_shifts set clock_out_at = now(), status = 'submitted'
  where profile_id = auth.uid() and status = 'open' and clock_out_at is null;

  insert into time_shifts (profile_id, project_id, cost_code_id, clock_in_photo)
  values (auth.uid(), p_project_id, p_cost_code_id, p_photo)
  returning * into v_shift;
  return v_shift;
end;
$$;

-- ============================================================================
-- integration fixes  [20260718004000_integration_fixes.sql]
-- =============================================================================

-- Undo must clear the phantom "in progress" state. Recreate undo_install
-- identically EXCEPT the opening-revert UPDATE now also clears work_started_at
-- so Home / MyWork / Dispatch stop showing a reclaimed opening as in progress.

create or replace function undo_install(p_opening_id uuid, p_reason text default null)
returns void
language plpgsql
security definer
as $$
declare
  v_caller_role text;
  v_opening project_openings;
begin
  -- Guard: only elevated roles may undo. Only a plain installer is blocked, so
  -- this holds for both legacy (lead/foreman/admin/big_boss) and any new role
  -- names above installer.
  select role into v_caller_role from profiles where id = auth.uid();
  if v_caller_role is null or v_caller_role = 'installer' then
    raise exception 'only a foreman-level user or above can undo an install';
  end if;

  select * into v_opening from project_openings where id = p_opening_id;
  if v_opening is null then
    raise exception 'unknown opening %', p_opening_id;
  end if;

  -- Void (never delete) the most recent non-voided install event.
  update install_events
  set voided_at = now(),
      voided_by = auth.uid(),
      void_reason = p_reason
  where id = (
    select id from install_events
    where project_opening_id = p_opening_id
      and voided_at is null
    order by created_at desc
    limit 1
  );

  -- Revert the opening back to its pre-install state. Also clear
  -- work_started_at so the phantom "in progress" clears on Home/MyWork/Dispatch.
  update project_openings
  set status = case when assigned_window_id is not null then 'assigned' else 'planned' end,
      confirmed = false,
      work_started_at = null
  where id = p_opening_id;

  -- Return the physical unit to the truck and log the reverse movement.
  if v_opening.assigned_window_id is not null then
    update windows
    set status = 'loaded', installed_at = null
    where id = v_opening.assigned_window_id;

    insert into movements (window_id, event, project_id, actor, reason)
    values (
      v_opening.assigned_window_id,
      'uninstalled',
      v_opening.project_id,
      auth.uid()::text,
      coalesce(p_reason, 'install undone')
    );
  end if;

  -- Void any points earned for this install (ref stores the opening UUID as text).
  update points_ledger
  set status = 'void'
  where ref = p_opening_id::text
    and status in ('pending', 'confirmed');

  -- Refresh learned rollups for this type (best-effort; skip if absent).
  if v_opening.window_type_id is not null then
    begin
      perform recompute_window_type_rollups(v_opening.window_type_id);
    exception when undefined_function then
      null;
    end;
  end if;
end;
$$;

-- issues model  [20260718005000_issues.sql]
-- Unified tiered issues model.
--
-- Three scattered "problem" surfaces (ProjectDetail Exceptions tab, Dispatch
-- Blockers, ProjectMap voided rings) plus the foreman "issues list" become ONE
-- table. Every problem write (flag, damage, undo/failed install, complication)
-- flows into `issues`; the Exceptions tab and Blockers become filtered views of
-- the same data. `urgency` renders as blank / `!` / `!!!` in the UI.

create table if not exists issues (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  opening_id uuid references project_openings(id) on delete set null,
  kind text not null check (kind in ('failed_install','flag','damage','blocker','complication')),
  urgency text not null default 'normal' check (urgency in ('normal','urgent','emergency')),
  status text not null default 'open' check (status in ('open','resolved')),
  note text,
  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  resolved_by uuid references profiles(id) on delete set null,
  resolved_at timestamptz
);

create index if not exists issues_status_urgency_idx on issues (status, urgency);
create index if not exists issues_project_idx on issues (project_id);
create index if not exists issues_opening_idx on issues (opening_id);

-- RLS: same trusted-crew pattern as the other install tables. The cross-project
-- list is additionally guarded foreman+ inside list_issues().
alter table issues enable row level security;
do $$
begin
  if not exists (
    select 1 from pg_policies where tablename = 'issues' and policyname = 'authenticated full access'
  ) then
    create policy "authenticated full access" on issues
      for all to authenticated using (true) with check (true);
  end if;
end;
$$;

-- Stream issues to the lead board / heartbeat like the other field tables.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'issues'
  ) then
    alter publication supabase_realtime add table issues;
  end if;
end;
$$;

-- --- RPCs -------------------------------------------------------------------

-- Open a new issue (created_by = the caller). Used by the OpeningSheet
-- "complication" / skip-damaged escalations and any future writer.
create or replace function create_issue(
  p_project uuid,
  p_opening uuid,
  p_kind text,
  p_urgency text default 'normal',
  p_note text default null
)
returns issues
language plpgsql
security definer
as $$
declare v_issue issues;
begin
  insert into issues (project_id, opening_id, kind, urgency, note, created_by)
  values (p_project, p_opening, p_kind, coalesce(p_urgency, 'normal'), p_note, auth.uid())
  returning * into v_issue;
  return v_issue;
end;
$$;

-- Resolve an issue (who + when). Idempotent-friendly: re-resolving is harmless.
create or replace function resolve_issue(p_id uuid)
returns issues
language plpgsql
security definer
as $$
declare v_issue issues;
begin
  update issues
  set status = 'resolved',
      resolved_by = auth.uid(),
      resolved_at = now()
  where id = p_id
  returning * into v_issue;
  if v_issue is null then
    raise exception 'unknown issue %', p_id;
  end if;
  return v_issue;
end;
$$;

-- Cross-project issue feed for foreman-level users and above. Returns every
-- issue (open + resolved); the UI filters by status/kind/project.
create or replace function list_issues()
returns setof issues
language plpgsql
security definer
as $$
declare v_role text;
begin
  select role into v_role from profiles where id = auth.uid();
  if v_role is null or v_role = 'installer' then
    raise exception 'issues are for foreman-level users and above';
  end if;
  return query select * from issues order by created_at desc;
end;
$$;

-- --- Wire existing writes into the issues table -----------------------------

-- Flag (or clear) an opening for the lead. Recreated from
-- 20260716010000_field_flags.sql, preserving all behavior, and now also opens a
-- 'flag' issue (deduped on an existing OPEN flag for the same opening). Clearing
-- the flag resolves any open flag issues for that opening.
create or replace function flag_opening(p_opening_id uuid, p_note text)
returns project_openings
language plpgsql
as $$
declare
  v_opening project_openings;
  v_clean text;
begin
  v_clean := nullif(trim(coalesce(p_note, '')), '');

  update project_openings
  set flag_note = v_clean,
      flagged_by = case when v_clean is null then null else auth.uid() end,
      flagged_at = case when v_clean is null then null else now() end
  where id = p_opening_id
  returning * into v_opening;
  if v_opening is null then
    raise exception 'unknown opening %', p_opening_id;
  end if;

  if v_clean is null then
    -- Flag cleared: resolve any open flag issues for this opening.
    update issues
    set status = 'resolved', resolved_by = auth.uid(), resolved_at = now()
    where opening_id = p_opening_id and kind = 'flag' and status = 'open';
  else
    -- Flag set: open a flag issue unless one is already open.
    if not exists (
      select 1 from issues
      where opening_id = p_opening_id and kind = 'flag' and status = 'open'
    ) then
      insert into issues (project_id, opening_id, kind, urgency, note, created_by)
      values (v_opening.project_id, p_opening_id, 'flag', 'normal', v_clean, auth.uid());
    end if;
  end if;

  return v_opening;
end;
$$;

-- Record the arrival condition of the unit at an opening. Recreated from
-- 20260715230000_fit_condition_gate.sql, preserving all behavior, and now a
-- 'damage' issue (urgent) is opened when the unit is marked damaged (deduped on
-- an existing OPEN damage issue). Marking OK/unknown resolves open damage issues.
create or replace function set_opening_condition(
  p_opening_id uuid,
  p_condition text,
  p_note text default null,
  p_actor text default null
)
returns project_openings
language plpgsql
as $$
declare
  v_opening project_openings;
begin
  if p_condition not in ('unknown','ok','damaged') then
    raise exception 'invalid condition %', p_condition;
  end if;

  update project_openings
  set condition = p_condition,
      condition_note = p_note,
      condition_checked_by = p_actor,
      condition_checked_at = now()
  where id = p_opening_id
  returning * into v_opening;

  if v_opening is null then
    raise exception 'unknown opening %', p_opening_id;
  end if;

  -- Damaged units flag the physical record so the office/warehouse sees it too.
  if p_condition = 'damaged' and v_opening.assigned_window_id is not null then
    update windows set status = 'damaged' where id = v_opening.assigned_window_id;
    insert into movements (window_id, event, project_id, actor, reason)
    values (
      v_opening.assigned_window_id, 'damaged', v_opening.project_id, p_actor,
      coalesce('damaged at opening ' || v_opening.opening_code ||
        case when p_note is not null then ': ' || p_note else '' end,
        'damaged at opening')
    );
  end if;

  -- Route the condition into the issues model.
  if p_condition = 'damaged' then
    if not exists (
      select 1 from issues
      where opening_id = p_opening_id and kind = 'damage' and status = 'open'
    ) then
      insert into issues (project_id, opening_id, kind, urgency, note, created_by)
      values (v_opening.project_id, p_opening_id, 'damage', 'urgent', p_note, auth.uid());
    end if;
  else
    -- No longer damaged: resolve any open damage issues for this opening.
    update issues
    set status = 'resolved', resolved_by = auth.uid(), resolved_at = now()
    where opening_id = p_opening_id and kind = 'damage' and status = 'open';
  end if;

  return v_opening;
end;
$$;

-- Undo/reclaim an install. Recreated from 20260718004000_integration_fixes.sql,
-- PRESERVING the work_started_at = null clear and all prior behavior, and now it
-- also opens a 'failed_install' issue (urgent, note = reason), deduped on an
-- existing OPEN failed_install issue for that opening.
create or replace function undo_install(p_opening_id uuid, p_reason text default null)
returns void
language plpgsql
security definer
as $$
declare
  v_caller_role text;
  v_opening project_openings;
begin
  -- Guard: only elevated roles may undo. Only a plain installer is blocked, so
  -- this holds for both legacy (lead/foreman/admin/big_boss) and any new role
  -- names above installer.
  select role into v_caller_role from profiles where id = auth.uid();
  if v_caller_role is null or v_caller_role = 'installer' then
    raise exception 'only a foreman-level user or above can undo an install';
  end if;

  select * into v_opening from project_openings where id = p_opening_id;
  if v_opening is null then
    raise exception 'unknown opening %', p_opening_id;
  end if;

  -- Void (never delete) the most recent non-voided install event.
  update install_events
  set voided_at = now(),
      voided_by = auth.uid(),
      void_reason = p_reason
  where id = (
    select id from install_events
    where project_opening_id = p_opening_id
      and voided_at is null
    order by created_at desc
    limit 1
  );

  -- Revert the opening back to its pre-install state. Also clear
  -- work_started_at so the phantom "in progress" clears on Home/MyWork/Dispatch.
  update project_openings
  set status = case when assigned_window_id is not null then 'assigned' else 'planned' end,
      confirmed = false,
      work_started_at = null
  where id = p_opening_id;

  -- Return the physical unit to the truck and log the reverse movement.
  if v_opening.assigned_window_id is not null then
    update windows
    set status = 'loaded', installed_at = null
    where id = v_opening.assigned_window_id;

    insert into movements (window_id, event, project_id, actor, reason)
    values (
      v_opening.assigned_window_id,
      'uninstalled',
      v_opening.project_id,
      auth.uid()::text,
      coalesce(p_reason, 'install undone')
    );
  end if;

  -- Void any points earned for this install (ref stores the opening UUID as text).
  update points_ledger
  set status = 'void'
  where ref = p_opening_id::text
    and status in ('pending', 'confirmed');

  -- Open a failed-install issue (deduped on an open one for this opening).
  if not exists (
    select 1 from issues
    where opening_id = p_opening_id and kind = 'failed_install' and status = 'open'
  ) then
    insert into issues (project_id, opening_id, kind, urgency, note, created_by)
    values (v_opening.project_id, p_opening_id, 'failed_install', 'urgent', p_reason, auth.uid());
  end if;

  -- Refresh learned rollups for this type (best-effort; skip if absent).
  if v_opening.window_type_id is not null then
    begin
      perform recompute_window_type_rollups(v_opening.window_type_id);
    exception when undefined_function then
      null;
    end;
  end if;
end;
$$;

-- --- Backfill existing problems into issues (idempotent) --------------------

-- Existing flags → open flag issues.
insert into issues (project_id, opening_id, kind, urgency, note, created_by, created_at)
select o.project_id, o.id, 'flag', 'normal', o.flag_note, o.flagged_by,
       coalesce(o.flagged_at, now())
from project_openings o
where o.flag_note is not null
  and not exists (
    select 1 from issues i
    where i.opening_id = o.id and i.kind = 'flag' and i.status = 'open'
  );

-- Existing damaged conditions → open damage issues (urgent).
insert into issues (project_id, opening_id, kind, urgency, note, created_by, created_at)
select o.project_id, o.id, 'damage', 'urgent', o.condition_note, null,
       coalesce(o.condition_checked_at, now())
from project_openings o
where o.condition = 'damaged'
  and not exists (
    select 1 from issues i
    where i.opening_id = o.id and i.kind = 'damage' and i.status = 'open'
  );

-- Existing voided (failed/undone) installs → open failed_install issues (urgent).
insert into issues (project_id, opening_id, kind, urgency, note, created_by, created_at)
select o.project_id, e.project_opening_id, 'failed_install', 'urgent',
       e.void_reason, e.voided_by, coalesce(e.voided_at, now())
from install_events e
join project_openings o on o.id = e.project_opening_id
where e.voided_at is not null
  and not exists (
    select 1 from issues i
    where i.opening_id = e.project_opening_id
      and i.kind = 'failed_install' and i.status = 'open'
  );

-- project green light  [20260718006000_project_greenlight.sql]
-- Project green light — supervisor-controlled "go" status for the Heartbeat.
--
-- The supervisor Heartbeat gives one glance at every active project: live crew,
-- anomaly flags, % complete, open-issue counts, and this green light. The green
-- light is a supervisor-controlled "this job is cleared to run" signal that the
-- board (and any downstream surface) can render at a glance.

alter table projects add column if not exists green_light boolean not null default false;
alter table projects add column if not exists green_light_note text;
alter table projects add column if not exists green_light_by uuid references profiles(id) on delete set null;
alter table projects add column if not exists green_light_at timestamptz;

-- Flip a project's green light. Supervisor+ only (supervisor/owner, plus legacy
-- admin/big_boss). A null/installer/foreman role is blocked in-RPC — matches the
-- roleRank semantics used everywhere else (only rank >= 2 may set).
create or replace function set_project_green_light(
  p_project uuid,
  p_on boolean,
  p_note text default null
)
returns projects
language plpgsql
security definer
as $$
declare
  v_role text;
  v_project projects;
begin
  select role into v_role from profiles where id = auth.uid();
  if v_role is null or v_role in ('installer', 'foreman', 'lead') then
    raise exception 'only a supervisor or above can set a project green light';
  end if;

  update projects
  set green_light = p_on,
      green_light_note = p_note,
      green_light_by = auth.uid(),
      green_light_at = now()
  where id = p_project
  returning * into v_project;

  if v_project is null then
    raise exception 'unknown project %', p_project;
  end if;

  return v_project;
end;
$$;

-- task sessions  [20260718007000_task_sessions.sql]
-- Installer spam-through task loop + unified on-task / off-task / break time.
--
-- Reconciles the two previously-decoupled clocks (shift-time from time_shifts,
-- task-time from project_openings.work_started_at) into one interval model:
--   task_sessions rows are 'on_task' (installing a specific opening),
--   'off_task' (between windows), or 'break' (on a shift break).
-- start_opening_work opens an on_task session (and now hard-requires the worker
-- be clocked in with today's toolbox signed); submit_install_event closes it and
-- opens off_task; the break RPCs open/close 'break'. work_ended_at stamps the
-- opening when the install is submitted so elapsed task time is exact.

-- 1. When did the physical install finish for this opening.
alter table project_openings
  add column if not exists work_ended_at timestamptz;

-- 2. On/off/break interval log per person.
create table if not exists task_sessions (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles(id) on delete cascade,
  opening_id uuid references project_openings(id) on delete set null,
  project_id uuid references projects(id) on delete set null,
  state text not null check (state in ('on_task','off_task','break')),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  created_at timestamptz not null default now()
);

-- Fast lookup of a person's currently-open session (ended_at is null).
create index if not exists task_sessions_profile_open_idx
  on task_sessions (profile_id, ended_at);

alter table task_sessions enable row level security;
do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'task_sessions' and policyname = 'authenticated full access'
  ) then
    create policy "authenticated full access" on task_sessions
      for all to authenticated using (true) with check (true);
  end if;
end;
$$;

-- Helper: close every open session for a profile (idempotent).
create or replace function close_open_task_sessions(p_profile uuid)
returns void
language plpgsql
as $$
begin
  update task_sessions
  set ended_at = now()
  where profile_id = p_profile and ended_at is null;
end;
$$;

-- 3. Recreate start_opening_work: guard on shift + toolbox, keep work_started_at,
--    and open a fresh on_task session (closing any dangling ones first).
create or replace function start_opening_work(p_opening_id uuid)
returns project_openings
language plpgsql
as $$
declare
  v_opening project_openings;
  v_uid uuid := auth.uid();
begin
  -- Gate: reconcile shift-time and task-time. You cannot be "on a task" unless
  -- you're clocked in and have signed today's toolbox talk.
  if not exists (
    select 1 from time_shifts
    where profile_id = v_uid and status = 'open' and clock_out_at is null
  ) then
    raise exception 'clock in and complete today''s toolbox talk before starting a task';
  end if;
  if not exists (
    select 1 from toolbox_completions
    where profile_id = v_uid and signed_at::date = current_date
  ) then
    raise exception 'clock in and complete today''s toolbox talk before starting a task';
  end if;

  update project_openings
  set work_started_at = coalesce(work_started_at, now())
  where id = p_opening_id
  returning * into v_opening;

  if v_opening is null then
    raise exception 'unknown opening %', p_opening_id;
  end if;

  -- Reconcile task-time: close whatever the person was doing and land on_task.
  perform close_open_task_sessions(v_uid);
  insert into task_sessions (profile_id, opening_id, project_id, state)
  values (v_uid, v_opening.id, v_opening.project_id, 'on_task');

  return v_opening;
end;
$$;

-- 4. Recreate submit_install_event PRESERVING the current signature + behavior
--    (from 20260716001000_installer_identity.sql) and ALSO: stamp work_ended_at,
--    close the open on_task session, and open an off_task session so the person
--    is "between windows" until they tap the next one.
create or replace function submit_install_event(
  p_opening_id uuid,
  p_installer text default null,
  p_minutes int default null,
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
  p_started_at timestamptz default null,
  p_installer_id uuid default null,
  p_estimate_minutes int default null
)
returns install_events
language plpgsql
as $$
declare
  v_opening project_openings;
  v_event install_events;
  v_profile uuid := coalesce(p_installer_id, auth.uid());
begin
  select * into v_opening from project_openings where id = p_opening_id;
  if v_opening is null then
    raise exception 'unknown opening %', p_opening_id;
  end if;

  insert into install_events (
    project_opening_id, window_id, window_type_id, installer, installer_id,
    started_at, minutes, estimate_minutes, quality_grade, difficulty, went_well,
    went_poorly, obstacles, tools_helped, time_vs_estimate, safety_notes,
    do_again, transcript_raw
  ) values (
    v_opening.id, v_opening.assigned_window_id, v_opening.window_type_id,
    p_installer, v_profile, p_started_at, p_minutes,
    p_estimate_minutes, p_quality_grade, p_difficulty, p_went_well, p_went_poorly,
    p_obstacles, p_tools_helped, p_time_vs_estimate, p_safety_notes, p_do_again,
    p_transcript_raw
  )
  returning * into v_event;

  update project_openings
  set status = 'installed', confirmed = true, work_ended_at = now()
  where id = v_opening.id;

  if v_opening.assigned_window_id is not null then
    perform install_window(v_opening.assigned_window_id, p_installer);
  end if;

  -- Task-time: this window is done — close on_task, land off_task (between
  -- windows) until they tap "Next one" (which opens the next on_task session).
  if v_profile is not null then
    perform close_open_task_sessions(v_profile);
    insert into task_sessions (profile_id, opening_id, project_id, state)
    values (v_profile, null, v_opening.project_id, 'off_task');
  end if;

  return v_event;
end;
$$;

-- 5. start_off_task(): explicit "between windows" transition (e.g. installer
--    backs out of a task without submitting). Closes open sessions, opens
--    off_task. project is optional context.
create or replace function start_off_task(p_project uuid default null)
returns task_sessions
language plpgsql
as $$
declare
  v_session task_sessions;
  v_uid uuid := auth.uid();
begin
  perform close_open_task_sessions(v_uid);
  insert into task_sessions (profile_id, opening_id, project_id, state)
  values (v_uid, null, p_project, 'off_task')
  returning * into v_session;
  return v_session;
end;
$$;

-- 6. Recreate the break RPCs (exact current behavior from
--    20260717008000_pin_and_breaks.sql) + mirror into task_sessions so the
--    on/off/break model stays consistent: start_break closes the open task
--    session and opens a 'break' session; end_break closes 'break' and lands
--    the person off_task (ready to tap their next window).
create or replace function start_break(p_shift_id uuid)
returns time_shifts language plpgsql as $$
declare
  v time_shifts;
begin
  update time_shifts set break_started_at = coalesce(break_started_at, now())
  where id = p_shift_id and profile_id = auth.uid()
  returning * into v;
  if v is null then raise exception 'no open shift %', p_shift_id; end if;

  perform close_open_task_sessions(auth.uid());
  insert into task_sessions (profile_id, opening_id, project_id, state)
  values (auth.uid(), null, v.project_id, 'break');

  return v;
end;
$$;

create or replace function end_break(p_shift_id uuid)
returns time_shifts language plpgsql as $$
declare
  v time_shifts;
begin
  update time_shifts
  set break_seconds = break_seconds
        + greatest(0, extract(epoch from (now() - break_started_at))::int),
      break_started_at = null
  where id = p_shift_id and profile_id = auth.uid() and break_started_at is not null
  returning * into v;
  if v is null then
    select * into v from time_shifts where id = p_shift_id and profile_id = auth.uid();
  end if;

  perform close_open_task_sessions(auth.uid());
  insert into task_sessions (profile_id, opening_id, project_id, state)
  values (auth.uid(), null, v.project_id, 'off_task');

  return v;
end;
$$;

-- Live sync: task_sessions in the realtime publication so a supervisor board can
-- watch on/off/break transitions across crews.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'task_sessions'
  ) then
    alter publication supabase_realtime add table task_sessions;
  end if;
end;
$$;

-- ============================================================================
-- Manual plan outlines (multi-polygon per page)
-- [20260718010000_manual_plan_outlines.sql + 20260718023000_multiple_plan_outlines.sql]
-- =============================================================================

create table if not exists project_plan_outlines (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  planset_id uuid not null references project_plansets(id) on delete cascade,
  page_number int not null check (page_number >= 1),
  points jsonb not null default '[]'::jsonb,
  page_aspect numeric not null check (page_aspect > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table project_plan_outlines
  drop constraint if exists project_plan_outlines_planset_id_page_number_key;

create index if not exists project_plan_outlines_project_idx
  on project_plan_outlines(project_id, planset_id);

create index if not exists project_plan_outlines_page_idx
  on project_plan_outlines(planset_id, page_number, created_at);

comment on table project_plan_outlines is
  'Hand-traced building outline polygons for a planset page; preferred over CAD auto-extract.';

alter table project_plan_outlines enable row level security;

do $$
begin
  create policy "authenticated full access" on project_plan_outlines
    for all to authenticated using (true) with check (true);
exception when duplicate_object then null;
end $$;


-- ============================================================================
-- Outline CAD features  [20260718030000_outline_features.sql]
-- =============================================================================

alter table project_plan_outlines
  add column if not exists features jsonb not null default '{}'::jsonb;


-- ============================================================================
-- pre-issued unit ids  [20260718040000_preissue_ids.sql]
-- =============================================================================

-- Extend the windows status set to include the new pre-arrival state.
alter table windows drop constraint if exists windows_status_check;
alter table windows add constraint windows_status_check
  check (status in (
    'pre_issued','inbound','in_warehouse','staged','loaded','installed','damaged'
  ));

-- Allow logging the pre-issue event in the append-only movement log.
alter table movements drop constraint if exists movements_event_check;
alter table movements add constraint movements_event_check
  check (event in (
    'received','putaway','moved','staged','loaded','installed','damaged',
    'count_verified','count_missing','override','assigned','uninstalled','preissued'
  ));

-- Pre-issue windows rows for a project from its planned quantities. Foreman+ only.
-- Idempotent: only creates (planned quantity - existing units of that type, in ANY
-- status) rows, so running twice never exceeds the plan; empty plan = safe no-op.
create or replace function preissue_project_units(p_project_id uuid)
returns setof windows
language plpgsql
security definer
as $$
declare
  v_caller_role text;
  v_need record;
  v_existing int;
  v_to_create int;
  i int;
  v_window windows;
begin
  select role into v_caller_role from profiles where id = auth.uid();
  if v_caller_role is null or v_caller_role = 'installer' then
    raise exception 'only a foreman-level user or above can pre-issue unit IDs';
  end if;

  for v_need in
    select window_type_id, quantity
    from project_windows
    where project_id = p_project_id
  loop
    select count(*) into v_existing
    from windows
    where project_id = p_project_id
      and window_type_id = v_need.window_type_id;

    v_to_create := v_need.quantity - v_existing;

    if v_to_create > 0 then
      for i in 1..v_to_create loop
        loop
          begin
            insert into windows (
              window_id, short_code, window_type_id, status, project_id, location_id
            )
            values (
              issue_window_id(v_need.window_type_id),
              issue_window_short_code(),
              v_need.window_type_id,
              'pre_issued',
              p_project_id,
              null
            )
            returning * into v_window;
            exit;
          exception when unique_violation then
            -- extremely rare short_code collision; try again
          end;
        end loop;

        insert into movements (window_id, event, project_id, actor)
        values (v_window.id, 'preissued', p_project_id, auth.uid()::text);

        return next v_window;
      end loop;
    end if;
  end loop;

  return;
end;
$$;


-- ============================================================================
-- receiving + delivery  [20260718050000_receiving_delivery.sql]
-- =============================================================================

-- Link an issue to a specific physical unit (nullable — opening-level issues
-- still use opening_id only).
alter table issues add column if not exists window_id uuid
  references windows(id) on delete set null;
create index if not exists issues_window_idx on issues (window_id);

-- Extend the issue kind set with 'missing' (undelivered unit).
alter table issues drop constraint if exists issues_kind_check;
alter table issues add constraint issues_kind_check
  check (kind in (
    'failed_install','flag','damage','blocker','complication','missing'
  ));

-- Receive a physical unit against the plan: match it to its pre_issued ID and
-- activate it (-> in_warehouse, or damaged). Foreman+ only. Logs a 'received'
-- movement and, when damaged, opens a deduped unit-level damage issue.
create or replace function activate_preissued_unit(
  p_code text,
  p_location_id uuid default null,
  p_damaged boolean default false,
  p_actor text default null
)
returns windows
language plpgsql
security definer
as $$
declare
  v_caller_role text;
  v_unit windows;
  v_new_status text;
begin
  select role into v_caller_role from profiles where id = auth.uid();
  if v_caller_role is null or v_caller_role = 'installer' then
    raise exception 'only a foreman-level user or above can receive against the plan';
  end if;

  select * into v_unit from find_window_by_code(p_code);
  if v_unit.id is null then
    raise exception 'unknown code % — no unit matches that code or serial', p_code;
  end if;
  if v_unit.status <> 'pre_issued' then
    raise exception
      'window % is not awaiting delivery (status %) — it may already be received',
      v_unit.window_id, v_unit.status;
  end if;

  v_new_status := case when p_damaged then 'damaged' else 'in_warehouse' end;

  update windows
  set status = v_new_status,
      location_id = coalesce(p_location_id, location_id),
      received_at = now()
  where id = v_unit.id
  returning * into v_unit;

  insert into movements (window_id, event, to_location_id, project_id, actor, reason)
  values (
    v_unit.id,
    'received',
    p_location_id,
    v_unit.project_id,
    coalesce(p_actor, auth.uid()::text),
    case when p_damaged then 'received damaged on arrival' else null end
  );

  if p_damaged then
    if not exists (
      select 1 from issues
      where window_id = v_unit.id and kind = 'damage' and status = 'open'
    ) then
      insert into issues (project_id, opening_id, window_id, kind, urgency, note, created_by)
      values (v_unit.project_id, null, v_unit.id, 'damage', 'urgent',
              'damaged on arrival', auth.uid());
    end if;
  end if;

  return v_unit;
end;
$$;

-- Foreman-triggered delivery reconcile: flag every still-'pre_issued' unit for a
-- project as a 'missing' issue (deduped per window). Returns the opened issues.
create or replace function reconcile_project_deliveries(p_project_id uuid)
returns setof issues
language plpgsql
security definer
as $$
declare
  v_caller_role text;
  v_unit windows;
  v_issue issues;
begin
  select role into v_caller_role from profiles where id = auth.uid();
  if v_caller_role is null or v_caller_role = 'installer' then
    raise exception 'only a foreman-level user or above can reconcile deliveries';
  end if;

  for v_unit in
    select * from windows
    where project_id = p_project_id and status = 'pre_issued'
  loop
    if not exists (
      select 1 from issues
      where window_id = v_unit.id and kind = 'missing' and status = 'open'
    ) then
      insert into issues (project_id, opening_id, window_id, kind, urgency, note, created_by)
      values (
        p_project_id, null, v_unit.id, 'missing', 'urgent',
        'delivery missing: ' || v_unit.window_id ||
          coalesce(' (' || v_unit.short_code || ')', ''),
        auth.uid()
      )
      returning * into v_issue;
      return next v_issue;
    end if;
  end loop;

  return;
end;
$$;


-- ============================================================================
-- load-out + unload  [20260718060000_loadout_unload.sql]
-- =============================================================================

-- Allow logging the jobsite unload event in the append-only movement log.
alter table movements drop constraint if exists movements_event_check;
alter table movements add constraint movements_event_check
  check (event in (
    'received','putaway','moved','staged','loaded','installed','damaged',
    'count_verified','count_missing','override','assigned','uninstalled',
    'preissued','unloaded'
  ));

-- Batch load-out: move a set of the project's units onto the truck (batch
-- version of load_window). For each id that belongs to the project AND is
-- 'in_warehouse' or 'staged', set 'loaded', clear its slot, log a 'loaded'
-- movement. Ineligible ids are skipped; only loaded units are returned.
create or replace function load_units(
  p_window_ids uuid[],
  p_project_id uuid,
  p_actor text default null
)
returns setof windows
language plpgsql
security definer
as $$
declare
  v_role text;
  v_id uuid;
  v_from uuid;
  v_window windows;
begin
  select role into v_role from profiles where id = auth.uid();
  if v_role is null or v_role = 'installer' then
    raise exception 'only a foreman-level user or above can load units for a run';
  end if;

  foreach v_id in array coalesce(p_window_ids, array[]::uuid[])
  loop
    select location_id into v_from
    from windows
    where id = v_id
      and project_id = p_project_id
      and status in ('in_warehouse', 'staged');
    if not found then
      continue;
    end if;

    update windows
    set status = 'loaded', location_id = null
    where id = v_id
    returning * into v_window;

    insert into movements (window_id, event, from_location_id, project_id, actor)
    values (v_id, 'loaded', v_from, p_project_id, coalesce(p_actor, auth.uid()::text));

    return next v_window;
  end loop;

  return;
end;
$$;

-- Jobsite unload + condition report. OK units -> 'staged' (on site, ready to
-- install); damaged units -> 'damaged' + a deduped 'damage' issue. Returns
-- { unloaded, damaged } counts. Foreman+ only.
create or replace function unload_units(
  p_ok_ids uuid[],
  p_damaged_ids uuid[],
  p_project_id uuid,
  p_location_note text default null,
  p_actor text default null
)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_role text;
  v_id uuid;
  v_actor text;
  v_note text;
  v_unloaded int := 0;
  v_damaged int := 0;
begin
  select role into v_role from profiles where id = auth.uid();
  if v_role is null or v_role = 'installer' then
    raise exception 'only a foreman-level user or above can unload a run';
  end if;

  v_actor := coalesce(p_actor, auth.uid()::text);
  v_note := nullif(trim(coalesce(p_location_note, '')), '');

  foreach v_id in array coalesce(p_ok_ids, array[]::uuid[])
  loop
    update windows
    set status = 'staged'
    where id = v_id and project_id = p_project_id and status = 'loaded';
    if found then
      insert into movements (window_id, event, project_id, actor, reason)
      values (
        v_id, 'unloaded', p_project_id, v_actor,
        'unloaded on site' ||
          case when v_note is not null then ' — ' || v_note else '' end
      );
      v_unloaded := v_unloaded + 1;
    end if;
  end loop;

  foreach v_id in array coalesce(p_damaged_ids, array[]::uuid[])
  loop
    update windows
    set status = 'damaged'
    where id = v_id and project_id = p_project_id and status = 'loaded';
    if found then
      insert into movements (window_id, event, project_id, actor, reason)
      values (v_id, 'unloaded', p_project_id, v_actor, 'damaged in transit/unload');

      if not exists (
        select 1 from issues
        where window_id = v_id and kind = 'damage' and status = 'open'
      ) then
        insert into issues (project_id, opening_id, window_id, kind, urgency, note, created_by)
        values (p_project_id, null, v_id, 'damage', 'urgent',
                'damaged in transit/unload', auth.uid());
      end if;
      v_damaged := v_damaged + 1;
    end if;
  end loop;

  return jsonb_build_object('unloaded', v_unloaded, 'damaged', v_damaged);
end;
$$;

-- Reorder rollup: per window type, damaged units + still-missing deliveries for
-- a project, so foreman+/office can reorder fast. Foreman+ only.
create or replace function list_reorder_needs(p_project_id uuid)
returns table (
  window_type_id uuid,
  type_name text,
  missing_count int,
  damaged_count int
)
language plpgsql
security definer
as $$
declare v_role text;
begin
  select role into v_role from profiles where id = auth.uid();
  if v_role is null or v_role = 'installer' then
    raise exception 'only a foreman-level user or above can view reorder needs';
  end if;

  return query
  with damaged as (
    select w.window_type_id as tid, count(*)::int as cnt
    from windows w
    where w.project_id = p_project_id and w.status = 'damaged'
    group by w.window_type_id
  ),
  missing as (
    select w.window_type_id as tid, count(*)::int as cnt
    from issues i
    join windows w on w.id = i.window_id
    where i.project_id = p_project_id
      and i.kind = 'missing'
      and i.status = 'open'
    group by w.window_type_id
  ),
  tids as (
    select tid from damaged
    union
    select tid from missing
  )
  select
    t.tid,
    wt.name,
    coalesce(m.cnt, 0),
    coalesce(d.cnt, 0)
  from tids t
  join window_types wt on wt.id = t.tid
  left join missing m on m.tid = t.tid
  left join damaged d on d.tid = t.tid
  order by wt.type_code;
end;
$$;

-- warranty / service cases  [20260718070000_service_cases.sql]

-- Phase 4: warranty / after-service traceability.
--
-- This closes the plan-set -> warranty loop. Every physical unit already carries
-- its full history (received -> loaded -> unloaded -> installed via movements +
-- install_events). A service_case is opened AFTER install, against a specific
-- installed unit, when something goes wrong in the 1-year warranty window:
--   * open_service_case: open a case from a unit's history — derives the unit's
--     project + window type and the latest install event + installer
--     automatically, so the failure is attributed back to the type/installer/
--     procedure without re-keying anything.
--   * schedule_service_case: book the revisit (status 'scheduled').
--   * resolve_service_case: close it out (status 'resolved' + note).
--   * list_service_cases: cross-project feed for the foreman/owner service view,
--     which groups callbacks by window type / installer / fail point so leads see
--     which products, procedures, and people drive warranty work.
--
-- All RPCs are guarded foreman+ (a plain installer, or a missing/unknown
-- profile, is rejected), matching the Phase 1/2/3 pattern.

create table if not exists service_cases (
  id uuid primary key default gen_random_uuid(),
  window_id uuid not null references windows(id) on delete cascade,
  install_event_id uuid references install_events(id) on delete set null,
  project_id uuid references projects(id) on delete set null,
  opening_id uuid references project_openings(id) on delete set null,
  window_type_id uuid references window_types(id) on delete set null,
  installer_id uuid references profiles(id) on delete set null,
  status text not null default 'open' check (status in ('open','scheduled','resolved')),
  reason text,
  fail_point text,
  description text,
  reported_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  scheduled_at timestamptz,
  resolved_by uuid references profiles(id) on delete set null,
  resolved_at timestamptz,
  resolution_note text
);

create index if not exists service_cases_status_idx on service_cases (status);
create index if not exists service_cases_window_idx on service_cases (window_id);
create index if not exists service_cases_type_idx on service_cases (window_type_id);

-- Revisit photos/voice/docs hang off the service case (in addition to the
-- window/install-event targets already supported).
alter table attachments add column if not exists service_case_id uuid
  references service_cases(id) on delete set null;
create index if not exists attachments_service_case_idx on attachments (service_case_id);

-- RLS: same trusted-crew pattern as the other install tables. The write/read
-- RPCs below are additionally guarded foreman+.
alter table service_cases enable row level security;
do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'service_cases' and policyname = 'authenticated full access'
  ) then
    create policy "authenticated full access" on service_cases
      for all to authenticated using (true) with check (true);
  end if;
end;
$$;

-- --- RPCs -------------------------------------------------------------------

-- Open a warranty / after-service case against a specific physical unit. Derives
-- the unit's project + window type and the latest (non-voided) install event +
-- installer automatically, so the callback is attributed back to the type /
-- installer / procedure. status 'open'; reported_by = the caller. Foreman+ only.
create or replace function open_service_case(
  p_window_id uuid,
  p_reason text,
  p_fail_point text default null,
  p_description text default null
)
returns service_cases
language plpgsql
security definer
as $$
declare
  v_role text;
  v_window windows;
  v_event install_events;
  v_case service_cases;
begin
  select role into v_role from profiles where id = auth.uid();
  if v_role is null or v_role = 'installer' then
    raise exception 'only a foreman-level user or above can open a service case';
  end if;

  select * into v_window from windows where id = p_window_id;
  if v_window is null then
    raise exception 'unknown window %', p_window_id;
  end if;

  -- Latest non-voided install event for this unit gives us the opening,
  -- installer, and the exact event the failure traces back to.
  select * into v_event
  from install_events
  where window_id = p_window_id and voided_at is null
  order by created_at desc
  limit 1;

  insert into service_cases (
    window_id, install_event_id, project_id, opening_id, window_type_id,
    installer_id, status, reason, fail_point, description, reported_by
  ) values (
    p_window_id,
    v_event.id,
    v_window.project_id,
    v_event.project_opening_id,
    v_window.window_type_id,
    v_event.installer_id,
    'open',
    p_reason,
    p_fail_point,
    p_description,
    auth.uid()
  )
  returning * into v_case;

  return v_case;
end;
$$;

-- Schedule the revisit for a case (status 'scheduled', scheduled_at = when).
-- Foreman+ only.
create or replace function schedule_service_case(p_id uuid, p_when timestamptz)
returns service_cases
language plpgsql
security definer
as $$
declare
  v_role text;
  v_case service_cases;
begin
  select role into v_role from profiles where id = auth.uid();
  if v_role is null or v_role = 'installer' then
    raise exception 'only a foreman-level user or above can schedule a service case';
  end if;

  update service_cases
  set status = 'scheduled', scheduled_at = p_when
  where id = p_id
  returning * into v_case;
  if v_case is null then
    raise exception 'unknown service case %', p_id;
  end if;
  return v_case;
end;
$$;

-- Resolve a case (status 'resolved', resolved_by = caller, resolved_at = now,
-- resolution_note = note). Foreman+ only.
create or replace function resolve_service_case(p_id uuid, p_note text default null)
returns service_cases
language plpgsql
security definer
as $$
declare
  v_role text;
  v_case service_cases;
begin
  select role into v_role from profiles where id = auth.uid();
  if v_role is null or v_role = 'installer' then
    raise exception 'only a foreman-level user or above can resolve a service case';
  end if;

  update service_cases
  set status = 'resolved',
      resolved_by = auth.uid(),
      resolved_at = now(),
      resolution_note = p_note
  where id = p_id
  returning * into v_case;
  if v_case is null then
    raise exception 'unknown service case %', p_id;
  end if;
  return v_case;
end;
$$;

-- Cross-project service-case feed for the foreman/owner service view. Returns
-- every case (open + scheduled + resolved); the UI filters + groups by window
-- type / installer / fail point for attribution. Foreman+ only.
create or replace function list_service_cases()
returns setof service_cases
language plpgsql
security definer
as $$
declare v_role text;
begin
  select role into v_role from profiles where id = auth.uid();
  if v_role is null or v_role = 'installer' then
    raise exception 'service cases are for foreman-level users and above';
  end if;
  return query select * from service_cases order by created_at desc;
end;
$$;

-- ===========================================================================
-- Chain correctness fixes (C1-C3, H2-H4). These recreate functions defined
-- earlier in this bundle, so on a full run the definitions below win.
-- ===========================================================================

-- C1: extend the windows status set with 'on_site' (unloaded on site, ready to
-- install — no longer warehouse-ready). Recreate the constraint with the full set.
alter table windows drop constraint if exists windows_status_check;
alter table windows add constraint windows_status_check
  check (status in (
    'pre_issued','inbound','in_warehouse','staged','loaded','installed','damaged','on_site'
  ));

-- C2: load a window onto the truck ONLY when it is warehouse-ready.
create or replace function load_window(p_window_id uuid, p_actor text default null)
returns windows
language plpgsql
as $$
declare
  v_window windows;
  v_from uuid;
  v_status text;
begin
  select location_id, status into v_from, v_status from windows where id = p_window_id;
  if v_status is null then
    raise exception 'unknown window %', p_window_id;
  end if;
  if v_status not in ('in_warehouse', 'staged') then
    raise exception 'unit is not warehouse-ready to load (status %)', v_status;
  end if;

  update windows
  set status = 'loaded', location_id = null
  where id = p_window_id
  returning * into v_window;

  insert into movements (window_id, event, from_location_id, project_id, actor)
  values (p_window_id, 'loaded', v_from, v_window.project_id, p_actor);

  return v_window;
end;
$$;

-- C1 + H4: jobsite unload. OK units land 'on_site'; damaged-issue dedup matches
-- the unit OR its currently-assigned opening.
create or replace function unload_units(
  p_ok_ids uuid[],
  p_damaged_ids uuid[],
  p_project_id uuid,
  p_location_note text default null,
  p_actor text default null
)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_role text;
  v_id uuid;
  v_actor text;
  v_note text;
  v_unloaded int := 0;
  v_damaged int := 0;
begin
  select role into v_role from profiles where id = auth.uid();
  if v_role is null or v_role = 'installer' then
    raise exception 'only a foreman-level user or above can unload a run';
  end if;

  v_actor := coalesce(p_actor, auth.uid()::text);
  v_note := nullif(trim(coalesce(p_location_note, '')), '');

  foreach v_id in array coalesce(p_ok_ids, array[]::uuid[])
  loop
    update windows
    set status = 'on_site'
    where id = v_id and project_id = p_project_id and status = 'loaded';
    if found then
      insert into movements (window_id, event, project_id, actor, reason)
      values (
        v_id, 'unloaded', p_project_id, v_actor,
        'unloaded on site' ||
          case when v_note is not null then ' — ' || v_note else '' end
      );
      v_unloaded := v_unloaded + 1;
    end if;
  end loop;

  foreach v_id in array coalesce(p_damaged_ids, array[]::uuid[])
  loop
    update windows
    set status = 'damaged'
    where id = v_id and project_id = p_project_id and status = 'loaded';
    if found then
      insert into movements (window_id, event, project_id, actor, reason)
      values (v_id, 'unloaded', p_project_id, v_actor, 'damaged in transit/unload');

      if not exists (
        select 1 from issues
        where kind = 'damage' and status = 'open'
          and (
            window_id = v_id
            or opening_id = (
              select id from project_openings
              where assigned_window_id = v_id
              limit 1
            )
          )
      ) then
        insert into issues (project_id, opening_id, window_id, kind, urgency, note, created_by)
        values (p_project_id, null, v_id, 'damage', 'urgent',
                'damaged in transit/unload', auth.uid());
      end if;
      v_damaged := v_damaged + 1;
    end if;
  end loop;

  return jsonb_build_object('unloaded', v_unloaded, 'damaged', v_damaged);
end;
$$;

-- C3 + H4: receive against the plan. OK path resolves the unit's open 'missing'
-- issue; damaged path dedups the damage issue on the unit OR its opening.
create or replace function activate_preissued_unit(
  p_code text,
  p_location_id uuid default null,
  p_damaged boolean default false,
  p_actor text default null
)
returns windows
language plpgsql
security definer
as $$
declare
  v_caller_role text;
  v_unit windows;
  v_new_status text;
begin
  select role into v_caller_role from profiles where id = auth.uid();
  if v_caller_role is null or v_caller_role = 'installer' then
    raise exception 'only a foreman-level user or above can receive against the plan';
  end if;

  select * into v_unit from find_window_by_code(p_code);
  if v_unit.id is null then
    raise exception 'unknown code % — no unit matches that code or serial', p_code;
  end if;
  if v_unit.status <> 'pre_issued' then
    raise exception
      'window % is not awaiting delivery (status %) — it may already be received',
      v_unit.window_id, v_unit.status;
  end if;

  v_new_status := case when p_damaged then 'damaged' else 'in_warehouse' end;

  update windows
  set status = v_new_status,
      location_id = coalesce(p_location_id, location_id),
      received_at = now()
  where id = v_unit.id
  returning * into v_unit;

  insert into movements (window_id, event, to_location_id, project_id, actor, reason)
  values (
    v_unit.id,
    'received',
    p_location_id,
    v_unit.project_id,
    coalesce(p_actor, auth.uid()::text),
    case when p_damaged then 'received damaged on arrival' else null end
  );

  if p_damaged then
    if not exists (
      select 1 from issues
      where kind = 'damage' and status = 'open'
        and (
          window_id = v_unit.id
          or opening_id = (
            select id from project_openings
            where assigned_window_id = v_unit.id
            limit 1
          )
        )
    ) then
      insert into issues (project_id, opening_id, window_id, kind, urgency, note, created_by)
      values (v_unit.project_id, null, v_unit.id, 'damage', 'urgent',
              'damaged on arrival', auth.uid());
    end if;
  else
    update issues
    set status = 'resolved', resolved_at = now(), resolved_by = auth.uid()
    where window_id = v_unit.id and kind = 'missing' and status = 'open';
  end if;

  return v_unit;
end;
$$;

-- H4: opening arrival condition. Damage-issue dedup matches the opening OR the
-- assigned unit's window_id.
create or replace function set_opening_condition(
  p_opening_id uuid,
  p_condition text,
  p_note text default null,
  p_actor text default null
)
returns project_openings
language plpgsql
as $$
declare
  v_opening project_openings;
begin
  if p_condition not in ('unknown','ok','damaged') then
    raise exception 'invalid condition %', p_condition;
  end if;

  update project_openings
  set condition = p_condition,
      condition_note = p_note,
      condition_checked_by = p_actor,
      condition_checked_at = now()
  where id = p_opening_id
  returning * into v_opening;

  if v_opening is null then
    raise exception 'unknown opening %', p_opening_id;
  end if;

  if p_condition = 'damaged' and v_opening.assigned_window_id is not null then
    update windows set status = 'damaged' where id = v_opening.assigned_window_id;
    insert into movements (window_id, event, project_id, actor, reason)
    values (
      v_opening.assigned_window_id, 'damaged', v_opening.project_id, p_actor,
      coalesce('damaged at opening ' || v_opening.opening_code ||
        case when p_note is not null then ': ' || p_note else '' end,
        'damaged at opening')
    );
  end if;

  if p_condition = 'damaged' then
    if not exists (
      select 1 from issues
      where kind = 'damage' and status = 'open'
        and (
          opening_id = p_opening_id
          or window_id = v_opening.assigned_window_id
        )
    ) then
      insert into issues (project_id, opening_id, kind, urgency, note, created_by)
      values (v_opening.project_id, p_opening_id, 'damage', 'urgent', p_note, auth.uid());
    end if;
  else
    update issues
    set status = 'resolved', resolved_by = auth.uid(), resolved_at = now()
    where opening_id = p_opening_id and kind = 'damage' and status = 'open';
  end if;

  return v_opening;
end;
$$;

-- H2: undo/reclaim an install — clears work_ended_at, closes the open task
-- session, and only logs 'uninstalled' when an install event was actually voided.
create or replace function undo_install(p_opening_id uuid, p_reason text default null)
returns void
language plpgsql
security definer
as $$
declare
  v_caller_role text;
  v_opening project_openings;
  v_voided_id uuid;
begin
  select role into v_caller_role from profiles where id = auth.uid();
  if v_caller_role is null or v_caller_role = 'installer' then
    raise exception 'only a foreman-level user or above can undo an install';
  end if;

  select * into v_opening from project_openings where id = p_opening_id;
  if v_opening is null then
    raise exception 'unknown opening %', p_opening_id;
  end if;

  update install_events
  set voided_at = now(),
      voided_by = auth.uid(),
      void_reason = p_reason
  where id = (
    select id from install_events
    where project_opening_id = p_opening_id
      and voided_at is null
    order by created_at desc
    limit 1
  )
  returning id into v_voided_id;

  update project_openings
  set status = case when assigned_window_id is not null then 'assigned' else 'planned' end,
      confirmed = false,
      work_started_at = null,
      work_ended_at = null
  where id = p_opening_id;

  update task_sessions
  set ended_at = now()
  where opening_id = p_opening_id and ended_at is null;

  if v_opening.assigned_window_id is not null then
    update windows
    set status = 'loaded', installed_at = null
    where id = v_opening.assigned_window_id;

    if v_voided_id is not null then
      insert into movements (window_id, event, project_id, actor, reason)
      values (
        v_opening.assigned_window_id,
        'uninstalled',
        v_opening.project_id,
        auth.uid()::text,
        coalesce(p_reason, 'install undone')
      );
    end if;
  end if;

  update points_ledger
  set status = 'void'
  where ref = p_opening_id::text
    and status in ('pending', 'confirmed');

  if not exists (
    select 1 from issues
    where opening_id = p_opening_id and kind = 'failed_install' and status = 'open'
  ) then
    insert into issues (project_id, opening_id, kind, urgency, note, created_by)
    values (v_opening.project_id, p_opening_id, 'failed_install', 'urgent', p_reason, auth.uid());
  end if;

  if v_opening.window_type_id is not null then
    begin
      perform recompute_window_type_rollups(v_opening.window_type_id);
    exception when undefined_function then
      null;
    end;
  end if;
end;
$$;

-- H3: open_service_case is idempotent — one open case per unit.
create or replace function open_service_case(
  p_window_id uuid,
  p_reason text,
  p_fail_point text default null,
  p_description text default null
)
returns service_cases
language plpgsql
security definer
as $$
declare
  v_role text;
  v_window windows;
  v_event install_events;
  v_case service_cases;
begin
  select role into v_role from profiles where id = auth.uid();
  if v_role is null or v_role = 'installer' then
    raise exception 'only a foreman-level user or above can open a service case';
  end if;

  select * into v_window from windows where id = p_window_id;
  if v_window is null then
    raise exception 'unknown window %', p_window_id;
  end if;

  select * into v_case
  from service_cases
  where window_id = p_window_id and status = 'open'
  order by created_at desc
  limit 1;
  if v_case.id is not null then
    return v_case;
  end if;

  select * into v_event
  from install_events
  where window_id = p_window_id and voided_at is null
  order by created_at desc
  limit 1;

  insert into service_cases (
    window_id, install_event_id, project_id, opening_id, window_type_id,
    installer_id, status, reason, fail_point, description, reported_by
  ) values (
    p_window_id,
    v_event.id,
    v_window.project_id,
    v_event.project_opening_id,
    v_window.window_type_id,
    v_event.installer_id,
    'open',
    p_reason,
    p_fail_point,
    p_description,
    auth.uid()
  )
  returning * into v_case;

  return v_case;
end;
$$;

-- ============================================================================
-- Horizon-style clock: typed breaks + soft GPS  [20260718040000_time_clock_horizon.sql]
-- ============================================================================

alter table time_shifts
  add column if not exists break_type text
    check (break_type in ('lunch', 'rest', 'other')),
  add column if not exists clock_in_lat double precision,
  add column if not exists clock_in_lng double precision,
  add column if not exists clock_out_lat double precision,
  add column if not exists clock_out_lng double precision;

drop function if exists clock_in(uuid, uuid, text);
drop function if exists clock_out(uuid, text, boolean, boolean, int);
drop function if exists start_break(uuid);

create or replace function clock_in(
  p_project_id uuid,
  p_cost_code_id uuid,
  p_photo text default null,
  p_lat double precision default null,
  p_lng double precision default null
)
returns time_shifts language plpgsql as $$
declare v_shift time_shifts;
begin
  if not exists (
    select 1 from toolbox_completions
    where profile_id = auth.uid() and signed_at::date = current_date
  ) then
    raise exception 'complete today''s toolbox talk before clocking in';
  end if;

  update time_shifts set clock_out_at = now(), status = 'submitted'
  where profile_id = auth.uid() and status = 'open' and clock_out_at is null;

  insert into time_shifts
    (profile_id, project_id, cost_code_id, clock_in_photo, clock_in_lat, clock_in_lng)
  values (auth.uid(), p_project_id, p_cost_code_id, p_photo, p_lat, p_lng)
  returning * into v_shift;
  return v_shift;
end;
$$;

create or replace function clock_out(
  p_shift_id uuid,
  p_photo text default null,
  p_injured boolean default false,
  p_time_confirmed boolean default true,
  p_break_seconds int default null,
  p_lat double precision default null,
  p_lng double precision default null
)
returns time_shifts language plpgsql as $$
declare v_shift time_shifts;
begin
  update time_shifts
  set clock_out_at = now(),
      clock_out_photo = coalesce(p_photo, clock_out_photo),
      injured = p_injured,
      time_confirmed = p_time_confirmed,
      break_seconds = coalesce(p_break_seconds, break_seconds),
      break_started_at = null,
      break_type = null,
      clock_out_lat = coalesce(p_lat, clock_out_lat),
      clock_out_lng = coalesce(p_lng, clock_out_lng),
      signed_at = now(),
      status = 'submitted'
  where id = p_shift_id and profile_id = auth.uid()
  returning * into v_shift;
  if v_shift is null then raise exception 'no open shift %', p_shift_id; end if;
  return v_shift;
end;
$$;

create or replace function start_break(
  p_shift_id uuid,
  p_break_type text default 'other'
)
returns time_shifts language plpgsql as $$
declare v time_shifts;
begin
  update time_shifts
  set break_started_at = coalesce(break_started_at, now()),
      break_type = coalesce(break_type, p_break_type)
  where id = p_shift_id and profile_id = auth.uid()
  returning * into v;
  if v is null then raise exception 'no open shift %', p_shift_id; end if;
  return v;
end;
$$;

create or replace function end_break(p_shift_id uuid)
returns time_shifts language plpgsql as $$
declare v time_shifts;
begin
  update time_shifts
  set break_seconds = break_seconds
        + greatest(0, extract(epoch from (now() - break_started_at))::int),
      break_started_at = null,
      break_type = null
  where id = p_shift_id and profile_id = auth.uid() and break_started_at is not null
  returning * into v;
  if v is null then
    select * into v from time_shifts where id = p_shift_id and profile_id = auth.uid();
  end if;
  return v;
end;
$$;


-- ===========================================================================
-- 20260718090000_security_hardening.sql (mirrored)
-- Phase A security hardening (SAFE subset): profiles.role self-promotion
-- lockdown + pin search_path on SECURITY DEFINER (and remaining) functions.
-- ===========================================================================

-- Phase A — Security hardening (SAFE subset).
--
-- This migration ships only the low-risk, high-value hardening that cannot lock
-- users out or break the running app:
--   1. Lock down profiles.role self-promotion (close the "authenticated = god
--      mode" hole where any signed-in user could UPDATE their own role to owner).
--   2. Pin a stable search_path on every SECURITY DEFINER function (prevents
--      search_path hijacking privilege escalation) — behavior-neutral.
--
-- The blanket RLS replacement (revoking direct table writes / per-table
-- role-scoped policies) is intentionally NOT here. It is high risk because many
-- client calls write tables directly and there is no local DB test harness, so
-- it is deferred to a reviewed follow-up.


-- ---------------------------------------------------------------------------
-- 1. profiles.role self-promotion lockdown
-- ---------------------------------------------------------------------------
-- A BEFORE UPDATE trigger blocks any change to profiles.role UNLESS the caller
-- is authorized. Authorized = the caller's OWN current role is elevated
-- (foreman / supervisor / owner, plus the legacy elevated names), which is
-- exactly the check set_profile_role() already enforces — so the sanctioned
-- role-change RPC keeps working while a plain installer can never promote
-- itself (or anyone) by writing the profiles table directly.
--
-- Two escape hatches keep existing behavior intact:
--   * auth.uid() IS NULL  -> service-role / migration context (RLS already
--     blocks anon writes), so seeds and edge functions using the service key
--     are never blocked.
--   * owner-bootstrap emails -> the two founder emails may self-promote to
--     owner on sign-in (mirrors OWNER_BOOTSTRAP_EMAILS in app/src/lib/install/
--     api.ts). Without this, first-run owner bootstrap would be blocked.
--
-- Reads, inserts, and every non-role profile edit (display_name, skill_level,
-- active, pin) are untouched — only a role mutation is gated.

create or replace function trg_guard_profile_role_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller_role text;
  v_caller_email text;
begin
  -- Service role / no JWT (migrations, seeds, edge functions on the service
  -- key). RLS already prevents anon writes, so this is safe to allow.
  if auth.uid() is null then
    return new;
  end if;

  -- Founder bootstrap emails may self-promote to owner (mirrors the app).
  v_caller_email := lower(coalesce(auth.jwt() ->> 'email', ''));
  if v_caller_email in (
    'ammon@horizonsolarusa.com',
    'isaacammonbarlow@gmail.com'
  ) then
    return new;
  end if;

  -- Otherwise the caller's own current role must be elevated (foreman-level or
  -- above). Installers — and any unknown/legacy-nonelevated role — are blocked.
  -- This matches set_profile_role()'s own guard so the RPC path still works.
  select role into v_caller_role from profiles where id = auth.uid();
  if v_caller_role is null
     or v_caller_role not in ('foreman', 'supervisor', 'owner', 'lead', 'admin', 'big_boss')
  then
    raise exception
      'not authorized to change a profile role (foreman-level or above only)'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists guard_profile_role_change on profiles;
create trigger guard_profile_role_change
  before update on profiles
  for each row
  when (old.role is distinct from new.role)
  execute function trg_guard_profile_role_change();


-- ---------------------------------------------------------------------------
-- 2. Harden SECURITY DEFINER functions: pin search_path = public
-- ---------------------------------------------------------------------------
-- A SECURITY DEFINER function without a fixed search_path can be tricked into
-- resolving unqualified object names against an attacker-controlled schema,
-- letting a signed-in user escalate to the definer's (owner) privileges. Every
-- function in this app lives in `public` and already references cross-schema
-- symbols with a qualifier (e.g. auth.uid()), so pinning search_path = public
-- is behavior-neutral.
--
-- This is done dynamically so it hardens exactly the SECURITY DEFINER functions
-- present when the migration runs (the repo has ~22 across all migrations; a
-- live DB behind on migrations simply has fewer, and each is covered as it is
-- created by its own earlier-timestamped migration before this one runs). The
-- second loop also pins search_path on the remaining (SECURITY INVOKER)
-- functions to clear the linter's function_search_path_mutable warnings; this
-- is likewise behavior-neutral.

do $$
declare
  fn record;
begin
  -- Critical: SECURITY DEFINER functions (privilege-escalation surface).
  for fn in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prokind = 'f'
      and p.prosecdef = true
  loop
    execute format('alter function %s set search_path = public', fn.sig);
  end loop;

  -- Defense-in-depth: the rest of our public functions (SECURITY INVOKER).
  for fn in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prokind = 'f'
      and p.prosecdef = false
      and (p.proconfig is null
           or not exists (
             select 1 from unnest(p.proconfig) c where c like 'search_path=%'
           ))
  loop
    execute format('alter function %s set search_path = public', fn.sig);
  end loop;
end $$;


-- ============================================================================
-- rough-opening quick check  [20260966000000_rough_opening_quick_check.sql]
-- =============================================================================

-- One tap says the rough opening is good, without typing a tape measure.
-- Weaker than a measurement on purpose: only read when no numbers are on file,
-- and cleared the moment real numbers are saved (the rebuild below).

alter table project_openings
  add column if not exists ro_quick_ok boolean not null default false;

comment on column project_openings.ro_quick_ok is
  'One-tap "quick check: all good" on the rough opening: somebody looked and '
  'said the unit goes in, without writing tape numbers down. Only read when '
  'ro_width_in / ro_height_in are null, and it can never be true alongside '
  'them: set_opening_rough_opening clears it whenever real numbers are saved, '
  'and quick_check_rough_opening refuses a row that already has any. Numbers '
  'always win.';

-- Same caller rules as set_opening_rough_opening beside it: SECURITY INVOKER,
-- so the `openings_update_live` policy decides who may write. The null guard
-- is what stops a phone holding a stale row from overwriting the name and the
-- minute of a tape measurement taken while it was offline.
create or replace function quick_check_rough_opening(
  p_opening_id uuid,
  p_actor text default null
)
returns project_openings
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_opening project_openings;
begin
  update project_openings
  set ro_quick_ok = true,
      ro_measured_by = p_actor,
      ro_measured_at = now()
  where id = p_opening_id
    and ro_width_in is null
    and ro_height_in is null
  returning * into v_opening;

  if v_opening is null then
    if exists (
      select 1
      from project_openings
      where id = p_opening_id
        and (ro_width_in is not null or ro_height_in is not null)
    ) then
      raise exception
        'Somebody measured this rough opening already. Reload the sheet to see the numbers.';
    end if;
    raise exception 'unknown opening %', p_opening_id;
  end if;
  return v_opening;
end;
$$;

grant execute on function quick_check_rough_opening(uuid, text) to authenticated;

-- Full current body plus one line: real numbers clear the quick check.
create or replace function set_opening_rough_opening(
  p_opening_id uuid,
  p_width_in numeric,
  p_height_in numeric,
  p_actor text default null,
  p_check jsonb default null
)
returns project_openings
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_opening project_openings;
begin
  update project_openings
  set ro_width_in = p_width_in,
      ro_height_in = p_height_in,
      ro_measured_by = p_actor,
      ro_measured_at = now(),
      ro_check = coalesce(p_check, ro_check),
      ro_quick_ok = false
  where id = p_opening_id
  returning * into v_opening;

  if v_opening is null then
    raise exception 'unknown opening %', p_opening_id;
  end if;
  return v_opening;
end;
$$;


-- ===========================================================================
-- 20260967000000_sandbox_guard_rearm.sql (mirrored)
-- The test-login sandbox guard re-arms itself: attach_sandbox_guards() puts
-- guard_test_account_sandbox_only back on every project-scoped table, and
-- sandbox_guard_census() names the ones it is still missing from.
-- ===========================================================================

-- The test-login cage re-arms itself, and the deploy proves it is shut.
--
-- WHAT WENT WRONG (owner report, 2026-09-02)
--
-- The QA foreman test login wrote to BLACK22 — a live job — twice: once
-- through the finish_unit RPC and once through a plain PATCH on
-- project_openings. 20260730220000_test_accounts_sandbox_only.sql exists to
-- make exactly that impossible, and its own header calls itself "a CONTROL,
-- not a convention". The control had quietly stopped covering most of the
-- database.
--
-- WHY THE GUARD WENT MISSING. Three causes, and none of them is "somebody
-- dropped the trigger" — nothing in supabase/migrations/ ever drops
-- guard_test_account_sandbox_only, and 20260730220000 has no down block or
-- reset path (the second loop near its end is test_account_write_scope(), a
-- read-only report).
--
--   1. THE ATTACH RAN ONCE. Section 5 of 20260730220000 is a `do $$ … $$`
--      block that walks the catalogue and attaches the trigger to every
--      project-scoped table. `supabase db push` applies a migration file
--      exactly once, so that walk saw the catalogue as it stood on
--      2026-07-30 and has never run again. FOURTEEN project-scoped tables
--      have been created since, and not one of them has ever carried the
--      guard: unit_sessions and unit_redos (20260820000000 — what finish_unit
--      writes, which is half of the owner's incident), opening_phases
--      (20260811000000), opening_notes (20260923000000), summons
--      (20260818000000), packages and package_events (20260814000000),
--      studio_projects (20260815000000), flash_run_assignments
--      (20260817000000), project_marks (20260822000000), takeoffs
--      (20260917000000), daily_logs (20260949000000), partner_job_grants
--      (20260950000000) and receipts (20260957000000).
--
--   2. A TABLE THAT IS DROPPED TAKES ITS TRIGGERS WITH IT. Two tables that
--      WERE guarded on day one were later dropped and recreated under the
--      same name — project_marks (20260822000000 drops the undeclared orphan
--      and declares a real one) and package_events (20260825000000). Postgres
--      drops the triggers along with the table, so those two lost a guard
--      they had once had, silently, on a migration whose subject was
--      something else entirely.
--
--   3. NOTHING EVER MEASURED IT. The coverage report that would have caught
--      this — test_account_write_scope(), section 9 of 20260730220000 — has
--      exactly one caller, scripts/provision-test-foreman.py, which runs on
--      demand and not on a deploy. And that script's own pre-flight check
--      asks whether the trigger count is greater than zero, which stays true
--      with one table guarded out of forty-three. So the fence could rot from
--      complete to two-thirds while every merge went green.
--
-- WHAT THIS MIGRATION DOES ABOUT IT
--
-- The one-shot `do` block becomes a function anyone deploying can call again:
-- attach_sandbox_guards(). It is idempotent, it fixes a guard attached to the
-- wrong column or switched off as well as a missing one, and 20260967000000
-- (this file) calls it, so every table listed above is covered the moment this
-- lands.
--
-- Re-arming is not a fix on its own — the one-shot block was "fixed" on the
-- day it ran too. So this also adds sandbox_guard_census(): the project-scoped
-- tables that LACK the guard right now, read off pg_trigger. Empty is the only
-- acceptable answer. scripts/verify-sandbox-guard.sh reads it after every
-- `supabase db push` and FAILS the deploy when it is not empty, the same way
-- scripts/verify-schema.sh fails a deploy whose migrations did not apply.
-- scripts/test_sandbox_guard.py closes the other end: a future migration that
-- makes a table project-scoped — creating it, recreating it, or adding the
-- column that ties it to a job — and does not call attach_sandbox_guards() in
-- that same file fails CI before it can ever reach the database. In that same
-- file, not merely before the next arming call: files are applied in whatever
-- order they are still pending, so a branch numbered below this one and merged
-- after it lands on a database this sweep has already run over.
--
-- SEPARATE FINDING, DELIBERATELY NOT CHANGED HERE. The guard refuses writes
-- outside public.sandbox_projects, and 20260933000000_testing_projects.sql
-- (2026-08-25) both put every is_test job into that table and seeded BLACK22
-- into it by name. So on the live database a test login writing BLACK22 may
-- well be a guard working exactly as written against a sandbox that grew to
-- include a job people still treat as real. That is a decision about which
-- jobs are practice data, not a bug in this fence, and quietly reversing it
-- would break the testing-projects feature. It is reported instead: the deploy
-- check prints every job a test login may write, by job code, on every merge —
-- and says in its FIRST line how many of them are real jobs rather than the
-- automation sandbox, because "fence: HOLDING" over a list nobody reads is how
-- this went unremarked from 2026-08-25 to 2026-09-02. The open question is
-- .scratch/test-login-fence/issues/01-a-real-job-is-inside-the-sandbox.md and
-- it is the owner's to answer. Until he does, this migration leaves a test
-- login able to write BLACK22: every table is guarded, and that job is inside
-- the fence.
--
-- WHAT CHANGES FOR A REAL PERSON: nothing. Every guard returns on its first
-- statement unless auth.uid() is a profiles.is_test account, of which there
-- are two, and neither belongs to a crew member.
--
-- WHAT CHANGES FOR THE QA LOGINS: they lose write access to the fourteen
-- tables above outside the sandbox — which is the point. One consequence is
-- worth naming: packages.project_id, receipts.project_id and
-- studio_projects.project_id are nullable, and a row whose project cannot be
-- determined is refused rather than waved through (the rule
-- is_sandbox_project() has followed since 20260730220000). So a QA login can
-- no longer write an unassigned Boneyard package. That is the safe direction
-- and it is intended.
--
-- Idempotent and safe to re-run.


-- ---------------------------------------------------------------------------
-- 1. One definition of "project-scoped table"
-- ---------------------------------------------------------------------------
-- The 2026-07-30 migration wrote this rule out twice — once in the attach
-- loop, once in test_account_write_scope() — and the two were free to drift.
-- They stay in step here by being one function that both the attacher and the
-- census read. Precedence is unchanged: every table has an `id`, so `id` is
-- the answer only for `projects` itself; otherwise a direct `project_id` wins,
-- then a link to an opening.
--
-- Ordinary tables only (relkind 'r'): a BEFORE … FOR EACH ROW trigger cannot
-- sit on a partitioned parent, and a view has nothing to guard.
--
-- Read from pg_catalog rather than information_schema. information_schema
-- shows a caller only the columns it holds a privilege on, which is a strange
-- thing for a security census to depend on; pg_attribute shows what is there.

create or replace function public.sandbox_scoped_tables()
returns table (table_name text, link_column text, link_kind text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select c.relname::text, link.col, link.kind
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  cross join lateral (
    select v.col, v.kind
    from (values
            ('id',                 'project', 0),
            ('project_id',         'project', 1),
            ('project_opening_id', 'opening', 2),
            ('opening_id',         'opening', 3)
         ) as v(col, kind, precedence)
    -- `id` is the link for `projects` and for nothing else.
    where (v.col = 'id') = (c.relname = 'projects')
      and exists (
        select 1 from pg_attribute a
        where a.attrelid = c.oid
          and a.attname = v.col
          and a.attnum > 0
          and not a.attisdropped
      )
    order by v.precedence
    limit 1
  ) as link
  where n.nspname = 'public'
    and c.relkind = 'r'
    -- The list of sandbox jobs itself. No client role can read or write it at
    -- all (20260730220000 revokes every grant and enables RLS with no policy),
    -- so guarding it would be guarding a door that is already welded shut.
    and c.relname <> 'sandbox_projects'
  order by 1;
$$;

comment on function public.sandbox_scoped_tables() is
  'Every public table a row can be traced from to a project, and the column that does the tracing. The single definition of "project-scoped" shared by attach_sandbox_guards() and sandbox_guard_census(), so the fence and the report on the fence can never disagree.';

revoke all on function public.sandbox_scoped_tables() from public, anon, authenticated;
grant execute on function public.sandbox_scoped_tables() to service_role;


-- ---------------------------------------------------------------------------
-- 2. Attach the guard everywhere, again, and as often as anyone likes
-- ---------------------------------------------------------------------------
-- The body of 20260730220000's section 5, lifted out of its `do` block so it
-- can be called by the migration that adds a table instead of only by the one
-- that invented the idea.
--
-- A table already carrying the right trigger is left alone rather than dropped
-- and recreated. `drop trigger` takes an ACCESS EXCLUSIVE lock, and this
-- function is meant to be called on a live database on every deploy that adds
-- a table: forty-odd exclusive locks to change nothing is a real cost paid for
-- tidiness. "Right" means the guard function, the timing and events, the two
-- arguments, AND that the trigger is switched on — a trigger reading a column
-- the table no longer links through is re-attached, not passed over.
--
-- SWITCHED ON is checked because a trigger can be present and inert.
-- `alter table … disable trigger` during a bulk data repair, or a pg_restore
-- run with --disable-triggers, leaves tgenabled = 'D': the row is still in
-- pg_trigger with the right name, the right function, the right arguments and
-- the right tgtype, and it fires on nothing. A census that did not look would
-- return no rows and the deploy would print "fence: HOLDING" over a database
-- where a test login can write every job — the same silent rot as the one-shot
-- attach, in a new costume. 'O' fires on ordinary writes and 'A' fires always;
-- 'D' is off and 'R' fires only on a replica, which for our purposes is off.
--
-- tgtype is compared as a number on purpose. 1|2|4|8|16 = 31 is
-- ROW|BEFORE|INSERT|DELETE|UPDATE, the shape 20260730220000 created, and the
-- bits are stable across Postgres versions in a way that the exact wording of
-- pg_get_triggerdef() is not.
--
-- The two arguments are looked for as QUOTED literals, one at a time, rather
-- than as one `('col', 'kind')` string. pg_get_triggerdef() always renders
-- arguments as SQL literals but the spacing between them is its own business,
-- and a check that goes red because a Postgres upgrade dropped a space would
-- fail a deploy over nothing. The quotes are what make it exact: `'opening_id'`
-- does not occur inside `'project_opening_id'`, because the character before
-- `opening_id` there is an underscore and not a quote.

create or replace function public.attach_sandbox_guards()
returns table (table_name text, link_column text, link_kind text, action text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r      record;
  v_def  text;
  v_type smallint;
  v_on   boolean;
begin
  for r in select * from public.sandbox_scoped_tables()
  loop
    select pg_get_triggerdef(tg.oid), tg.tgtype, tg.tgenabled in ('O', 'A')
      into v_def, v_type, v_on
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_trigger tg on tg.tgrelid = c.oid
    where n.nspname = 'public'
      and c.relname::text = r.table_name
      and tg.tgname = 'guard_test_account_sandbox_only'
      and tg.tgfoid = 'public.guard_test_account_sandbox_only()'::regprocedure
      and not tg.tgisinternal;

    if v_def is not null
       and coalesce(v_on, false)
       and v_type = 31
       and position(quote_literal(r.link_column) in v_def) > 0
       and position(quote_literal(r.link_kind) in v_def) > 0
    then
      table_name  := r.table_name;
      link_column := r.link_column;
      link_kind   := r.link_kind;
      action      := 'already armed';
      return next;
      continue;
    end if;

    execute format(
      'drop trigger if exists guard_test_account_sandbox_only on public.%I',
      r.table_name);
    execute format(
      'create trigger guard_test_account_sandbox_only '
      'before insert or update or delete on public.%I '
      'for each row execute function public.guard_test_account_sandbox_only(%L, %L)',
      r.table_name, r.link_column, r.link_kind);

    table_name  := r.table_name;
    link_column := r.link_column;
    link_kind   := r.link_kind;
    action      := case when v_def is null then 'attached' else 're-attached' end;
    return next;
  end loop;
end;
$$;

comment on function public.attach_sandbox_guards() is
  'Puts guard_test_account_sandbox_only on every project-scoped table, and repairs one attached to the wrong column or switched off. Idempotent — a table already correctly guarded is not touched. Any migration that makes a table project-scoped — creating it, recreating it, or adding the column that ties it to a job — must end with `select public.attach_sandbox_guards();`; scripts/test_sandbox_guard.py fails CI if one forgets.';

revoke all on function public.attach_sandbox_guards() from public, anon, authenticated;
grant execute on function public.attach_sandbox_guards() to service_role;


-- ---------------------------------------------------------------------------
-- 3. What the fence still does not cover
-- ---------------------------------------------------------------------------
-- The deploy proof. Every row this returns is a table a test login can write
-- on any job in the database, so the only acceptable answer is no rows.
--
-- Measured off pg_trigger, not off a list of what was intended: the whole
-- reason this file exists is that the intention was recorded in a migration
-- and the database did not match it.

create or replace function public.sandbox_guard_census()
returns table (table_name text, link_column text, link_kind text, reason text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    s.table_name,
    s.link_column,
    s.link_kind,
    case
      when tg.oid is null then 'no sandbox guard on this table'
      when tg.tgenabled not in ('O', 'A') then 'the guard is switched off and fires on nothing'
      when tg.tgtype <> 31 then 'the guard does not fire on every write'
      else 'the guard reads a column this table no longer links through'
    end
  from public.sandbox_scoped_tables() s
  join pg_class c on c.relname::text = s.table_name and c.relkind = 'r'
  join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
  left join pg_trigger tg
    on  tg.tgrelid = c.oid
    and tg.tgname = 'guard_test_account_sandbox_only'
    and tg.tgfoid = 'public.guard_test_account_sandbox_only()'::regprocedure
    and not tg.tgisinternal
  where tg.oid is null
     -- A DISABLEd trigger passes every other test in this query: right name,
     -- right function, right arguments, right tgtype, and it fires on nothing.
     -- Nothing in this repo disables it, but `alter table … disable trigger`
     -- during a data repair and `pg_restore --disable-triggers` both leave it
     -- that way, and a fence that is down has to read as down.
     or tg.tgenabled not in ('O', 'A')
     or tg.tgtype <> 31
     or position(quote_literal(s.link_column) in pg_get_triggerdef(tg.oid)) = 0
     or position(quote_literal(s.link_kind) in pg_get_triggerdef(tg.oid)) = 0
  order by s.table_name;
$$;

comment on function public.sandbox_guard_census() is
  'The project-scoped tables a test login could still write on ANY job, because the sandbox guard is missing, switched off, or mis-attached. Empty is the only healthy answer; scripts/verify-sandbox-guard.sh fails the deploy on any row.';

revoke all on function public.sandbox_guard_census() from public, anon, authenticated;
grant execute on function public.sandbox_guard_census() to service_role;


-- ---------------------------------------------------------------------------
-- 4. Arm it now, and refuse to finish if it did not take
-- ---------------------------------------------------------------------------
-- A migration that exits 0 proves the file ran, not that the fence is up —
-- the same distinction scripts/verify-schema.sh was written for. So this asks
-- the census before it lets the transaction commit.

do $$
declare
  v_total int;
  v_armed int;
  v_left  text;
begin
  select count(*), count(*) filter (where action <> 'already armed')
    into v_total, v_armed
  from public.attach_sandbox_guards();

  raise notice 'sandbox guard: % project-scoped table(s), % newly armed', v_total, v_armed;

  select string_agg(table_name, ', ' order by table_name)
    into v_left
  from public.sandbox_guard_census();

  if v_left is not null then
    raise exception
      'the sandbox guard is still missing from: %', v_left
      using hint = 'A test login can write those tables on any job. Do not deploy over this.';
  end if;
end;
$$;


-- ===========================================================================
-- 20260968000000_profile_language.sql (mirrored)
-- profiles.language ('en'/'es') plus set_my_language(): a person picks English
-- or Spanish once, it rides their profile, and the RPC is the only writer —
-- scoped to auth.uid()'s own row, exactly like set_my_pin / set_profile_role.
-- ===========================================================================

-- A language the app speaks back in: English or Spanish, per person.
--
-- WHY (standard-tracking-jobs grill, 2026-09-02): most of the install crew reads
-- Spanish more comfortably than English. The language layer lets a person pick
-- once, stores it on their profile, and every string later slices add is written
-- in both from the start. This is the DATA half.
--
-- The column is NOT NULL DEFAULT 'en' so a screen never branches on a null; the
-- CHECK keeps the value to the two languages the app speaks; and UPDATE(language)
-- is never granted to authenticated, so set_my_language() is the single writer.

alter table public.profiles
  add column if not exists language text not null default 'en';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'profiles_language_check'
      and conrelid = 'public.profiles'::regclass
  ) then
    alter table public.profiles
      add constraint profiles_language_check
      check (language in ('en', 'es'));
  end if;
end;
$$;

comment on column public.profiles.language is
  'The language the app renders in for this person: ''en'' or ''es''. Written only through set_my_language(); the authenticated role holds SELECT but not UPDATE on it, matching how role and pin_hash are guarded.';

grant select (language) on table public.profiles to authenticated;
revoke update (language) on table public.profiles from anon, authenticated;

create or replace function public.set_my_language(p_lang text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v text := lower(coalesce(trim(p_lang), ''));
begin
  if auth.uid() is null then
    raise exception 'sign in before choosing a language' using errcode = '42501';
  end if;

  if v not in ('en', 'es') then
    raise exception 'language must be en or es' using errcode = '22023';
  end if;

  update public.profiles
     set language = v, updated_at = now()
   where id = auth.uid();
end;
$$;

comment on function public.set_my_language(text) is
  'Set the calling user''s own app language (''en'' or ''es''). SECURITY DEFINER and scoped to auth.uid(); the only client-reachable way to write profiles.language, which is revoked from anon and authenticated at the column level.';

revoke all on function public.set_my_language(text) from public, anon;
grant execute on function public.set_my_language(text) to authenticated;


-- ===========================================================================
-- 20260969000000_drop_redundant_toolbox_recheck.sql (mirrored)
-- clock_in already refuses the day's first punch without today's signed toolbox
-- talk (once per day, all jobs), so the SECOND toolbox check inside each
-- start-work RPC is dead weight. Rebuild start_opening_work, start_opening_phase
-- and start_unit_session in full from their current bodies (same signatures),
-- dropping ONLY the toolbox_completions check and keeping every other guard.
-- ===========================================================================

create or replace function start_opening_work(p_opening_id uuid)
returns project_openings
language plpgsql
as $$
declare
  v_opening project_openings;
  v_uid uuid := auth.uid();
begin
  -- clock_in already enforced today's toolbox talk same-day, so an open shift
  -- is proof the talk is signed. Only the shift needs checking here.
  if not exists (
    select 1 from time_shifts
    where profile_id = v_uid and status = 'open' and clock_out_at is null
  ) then
    raise exception 'clock in before starting a task';
  end if;

  if _flashing_outstanding(p_opening_id) then
    raise exception 'this opening needs flashing before the install starts';
  end if;

  update project_openings
  set work_started_at = coalesce(work_started_at, now())
  where id = p_opening_id
  returning * into v_opening;

  if v_opening is null then
    raise exception 'unknown opening %', p_opening_id;
  end if;

  perform close_open_task_sessions(v_uid);
  insert into task_sessions (profile_id, opening_id, project_id, state)
  values (v_uid, v_opening.id, v_opening.project_id, 'on_task');

  return v_opening;
end;
$$;

create or replace function start_opening_phase(p_opening_id uuid, p_kind text)
returns opening_phases
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_phase opening_phases;
begin
  if not exists (
    select 1 from time_shifts
    where profile_id = v_uid and status = 'open' and clock_out_at is null
  ) then
    raise exception 'clock in before starting a task';
  end if;

  insert into opening_phases (opening_id, kind, started_by)
  values (p_opening_id, p_kind, v_uid)
  on conflict (opening_id, kind) do update
    -- Re-starting an unfinished phase is fine (a second person joining, or a
    -- resume); a submitted phase stays submitted.
    set started_by = coalesce(opening_phases.started_by, excluded.started_by)
  returning * into v_phase;

  if v_phase.status = 'submitted' then
    raise exception 'this % is already submitted', p_kind;
  end if;
  return v_phase;
end;
$$;

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
  ) then
    raise exception 'clock in before starting a task';
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

grant execute on function start_opening_work(uuid) to authenticated;
grant execute on function start_opening_phase(uuid, text) to authenticated;
grant execute on function start_unit_session(uuid, text) to authenticated;


-- ===========================================================================
-- 20260970000000_job_modes.sql (mirrored)
-- A job declares which work modes it allows: data (the full per-window loop) or
-- tracking (a lighter clock-time-and-log-the-day job), or both. projects
-- .allowed_modes is a projects flag written only by set_project_modes (foreman+,
-- SECURITY DEFINER), the same shape as is_test. time_shifts.job_mode records the
-- mode the worker picked at clock-in on a both-mode job; a new clock_in overload
-- (note + mode) carries it, and every older overload is left in place.
-- ===========================================================================

alter table projects
  add column if not exists allowed_modes text[] not null default '{data}'::text[];

alter table projects drop constraint if exists projects_allowed_modes_check;
alter table projects add constraint projects_allowed_modes_check
  check (
    cardinality(allowed_modes) >= 1
    and allowed_modes <@ array['data', 'tracking']::text[]
  );

revoke insert (allowed_modes), update (allowed_modes) on table projects from anon, authenticated;

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

revoke all on function public.set_project_modes(uuid, text[]) from public;
grant execute on function public.set_project_modes(uuid, text[]) to authenticated;

alter table time_shifts
  add column if not exists job_mode text;

alter table time_shifts drop constraint if exists time_shifts_job_mode_check;
alter table time_shifts add constraint time_shifts_job_mode_check
  check (job_mode is null or job_mode in ('data', 'tracking'));

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


-- ===========================================================================
-- 20260973000000_project_cost_codes.sql (mirrored)
-- Cost codes that fit the job: an OPTIONAL per-job pickable subset
-- (project_cost_codes) over the company library, with set/add/remove RPCs
-- (foreman+, SECURITY DEFINER); an is_general fallback code the clock-in
-- picker always folds in; the General/Service call/Warranty seeds; a job-photo
-- soft-delete + 30-day recoverable trash on attachments (deleted_at/deleted_by,
-- soft_delete_job_photo / restore_job_photo, nightly purge); and the sandbox
-- guard armed on the new project-scoped table.
-- ===========================================================================

-- Cost codes that fit the job you're on (standard-tracking-jobs slice 3, 2026-09-03).
--
-- WHY (owner ask, service billing): a service / tracking job doesn't want the
-- whole company cost-code library at clock-in — it wants the handful that apply
-- (a service call, a warranty visit), plus a general catch-all so nobody is ever
-- stuck with nothing valid to pick. This is the Horizon "project cost codes"
-- shape: a company-wide library with an OPTIONAL per-job subset. A job with no
-- subset behaves exactly as today (the full active list); a job WITH a subset
-- shows only those, and the clock-in picker always folds in the general fallback.
--
-- Precedent followed: project_openings / daily_logs (a project-scoped child
-- table, RPC-only writes, RLS select for crew) and set_project_modes
-- (20260970000000 — a foreman+ SECURITY DEFINER writer).

-- ---------------------------------------------------------------------------
-- 1. The general fallback marker on the company library
-- ---------------------------------------------------------------------------
-- getClockCostCodesForProject (app/src/lib/costCodes.ts) ALWAYS includes a
-- general fallback code, so a job whose subset is, say, just "Service call"
-- still lets a worker charge general time. That fallback has to be a real code
-- the picker can point at; the library shipped with none. is_general marks the
-- one general code — a hidden flag (the management screen never edits it), so a
-- rename or an archive of another code can't accidentally move the fallback.
alter table cost_codes
  add column if not exists is_general boolean not null default false;

comment on column cost_codes.is_general is
  'The one general / catch-all cost code the clock-in picker always folds in as a fallback (getClockCostCodesForProject). Hidden from the management UI so it stays put. Exactly one code should carry this.';

-- Seed the general fallback (code 000 so it reads and sorts first) and the two
-- service codes this slice is about. codes chosen to not collide with the
-- shipped 100/110/200/300/400/900. cost_codes.code has no unique constraint, so
-- a guarded not-exists insert (rather than on conflict) keeps this idempotent
-- and safe to re-run without duplicating a code.
insert into cost_codes (code, label, description, sort_order, is_general)
select v.code, v.label, v.description, v.sort_order, v.is_general
from (values
  ('000', 'General', 'General labor / anything not covered by a specific code', 5, true),
  ('500', 'Service call', 'A service visit on an installed job', 70, false),
  ('600', 'Warranty', 'Warranty work — no charge to the customer', 80, false)
) as v(code, label, description, sort_order, is_general)
where not exists (select 1 from cost_codes cc where cc.code = v.code);

-- If a "000 General" row already existed (seeded by hand, or before this flag)
-- make sure it carries is_general.
update cost_codes set is_general = true where code = '000' and is_general = false;

-- ---------------------------------------------------------------------------
-- 2. project_cost_codes: a job's pickable subset
-- ---------------------------------------------------------------------------
-- The optional per-job subset. Empty for a job means "no subset" — the picker
-- falls back to the whole active library, which is every job that exists today.
create table if not exists project_cost_codes (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  cost_code_id uuid not null references cost_codes(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (project_id, cost_code_id)
);

create index if not exists project_cost_codes_project_idx
  on project_cost_codes (project_id);

-- RLS: crew (any signed-in non-partner) READ their job's subset so the clock-in
-- picker can scope itself; writes go only through the foreman+ RPCs below, which
-- are SECURITY DEFINER and bypass RLS — so there is no write policy at all, the
-- same RPC-only shape daily_logs / timecard_periods use. Partner logins never
-- see it (THE WALL).
alter table project_cost_codes enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'project_cost_codes' and policyname = 'project_cost_codes read'
  ) then
    create policy "project_cost_codes read" on project_cost_codes
      for select to authenticated
      using (not public.is_partner_user());
  end if;
end;
$$;

-- The RPCs are the only writers: revoke the table-level write grants so a plain
-- PostgREST insert/delete can't bypass the foreman+ gate.
revoke insert, update, delete on table project_cost_codes from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. set / add / remove the job's subset (foreman+)
-- ---------------------------------------------------------------------------
-- Replace the whole subset in one call — what the per-job editor saves. An empty
-- array clears the subset (the job goes back to the full library).
create or replace function public.set_project_cost_codes(
  p_project_id uuid,
  p_cost_code_ids uuid[]
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not _is_lead(auth.uid()) then
    raise exception 'only a foreman or above can set a job''s cost codes';
  end if;
  if not exists (select 1 from projects where id = p_project_id) then
    raise exception 'that job does not exist';
  end if;

  delete from project_cost_codes where project_id = p_project_id;

  insert into project_cost_codes (project_id, cost_code_id)
  select p_project_id, cc.id
  from cost_codes cc
  where cc.id = any (coalesce(p_cost_code_ids, '{}'::uuid[]))
  on conflict (project_id, cost_code_id) do nothing;
end;
$$;

comment on function public.set_project_cost_codes(uuid, uuid[]) is
  'Replace a job''s pickable cost-code subset (foreman+). An empty array clears it — the job falls back to the full active library at clock-in. Unknown ids are dropped rather than trusted.';

revoke all on function public.set_project_cost_codes(uuid, uuid[]) from public;
grant execute on function public.set_project_cost_codes(uuid, uuid[]) to authenticated;

create or replace function public.add_project_cost_code(
  p_project_id uuid,
  p_cost_code_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not _is_lead(auth.uid()) then
    raise exception 'only a foreman or above can change a job''s cost codes';
  end if;
  if not exists (select 1 from cost_codes where id = p_cost_code_id) then
    raise exception 'that cost code does not exist';
  end if;

  insert into project_cost_codes (project_id, cost_code_id)
  values (p_project_id, p_cost_code_id)
  on conflict (project_id, cost_code_id) do nothing;
end;
$$;

comment on function public.add_project_cost_code(uuid, uuid) is
  'Add one cost code to a job''s pickable subset (foreman+). Idempotent.';

revoke all on function public.add_project_cost_code(uuid, uuid) from public;
grant execute on function public.add_project_cost_code(uuid, uuid) to authenticated;

create or replace function public.remove_project_cost_code(
  p_project_id uuid,
  p_cost_code_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not _is_lead(auth.uid()) then
    raise exception 'only a foreman or above can change a job''s cost codes';
  end if;

  delete from project_cost_codes
  where project_id = p_project_id and cost_code_id = p_cost_code_id;
end;
$$;

comment on function public.remove_project_cost_code(uuid, uuid) is
  'Remove one cost code from a job''s pickable subset (foreman+). No-op if it was not in the subset.';

revoke all on function public.remove_project_cost_code(uuid, uuid) from public;
grant execute on function public.remove_project_cost_code(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Job photos: soft-delete + a 30-day recoverable trash
-- ---------------------------------------------------------------------------
-- A blurry or wrong job photo should be removable without being gone: a foreman
-- deletes it, it drops off the feed, and there are 30 days to bring it back
-- before the nightly sweep erases it and its file for good. attachments had no
-- soft-delete, so this adds one — the SAME void-then-30-days-then-purge shape as
-- projects' trash (20260959000000), on the row rather than a new model. Only job
-- photos reach it (that is what the RPCs touch); the install-capture before/after
-- proof is untouched.
alter table attachments
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by uuid references profiles(id) on delete set null;

comment on column attachments.deleted_at is
  'Set by soft_delete_job_photo(), cleared by restore_job_photo() within 30 days, then purge_expired_job_photos() erases the row and its storage object (nightly pg_cron). The feed hides a non-null row. RPC-only — the column write is revoked below.';

-- deleted_at / deleted_by are written ONLY by the RPCs, so a stale open tab (or a
-- direct PATCH) can't hide a photo without the audit. Column privileges are
-- enforced independently of the open row-level policy, the is_test / allowed_modes
-- precedent (20260933000000 / 20260970000000).
revoke update (deleted_at, deleted_by) on table attachments from anon, authenticated;

create or replace function public.soft_delete_job_photo(p_id uuid)
returns attachments
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_row attachments;
begin
  if not _is_lead(auth.uid()) then
    raise exception 'only a foreman or above can remove a job photo';
  end if;

  update attachments
     set deleted_at = now(), deleted_by = auth.uid()
   where id = p_id and deleted_at is null
  returning * into v_row;

  -- The Horizon fake-success lesson (void_shift, 20260944000000): an UPDATE that
  -- matched nothing must never report success. Either the id is unknown or it is
  -- already in the trash — say so rather than returning a null row.
  if v_row.id is null then
    raise exception 'that photo does not exist, or is already removed';
  end if;
  return v_row;
end;
$$;

comment on function public.soft_delete_job_photo(uuid) is
  'Foreman+: move a job photo to the 30-day trash (deleted_at/deleted_by). Refuses one already removed. Undo via restore_job_photo(); permanent erase via purge_expired_job_photos() after 30 days.';

revoke all on function public.soft_delete_job_photo(uuid) from public;
grant execute on function public.soft_delete_job_photo(uuid) to authenticated;

create or replace function public.restore_job_photo(p_id uuid)
returns attachments
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_row attachments;
begin
  if not _is_lead(auth.uid()) then
    raise exception 'only a foreman or above can restore a job photo';
  end if;

  select * into v_row from attachments where id = p_id for update;
  if v_row.id is null then
    raise exception 'that photo does not exist';
  end if;
  if v_row.deleted_at is null then
    raise exception 'that photo is not in the trash';
  end if;
  -- Exact 30-day promise, regardless of when the nightly sweep last ran — the
  -- same boundary restore_project holds.
  if now() >= v_row.deleted_at + interval '30 days' then
    raise exception 'the 30 days are up — this photo is gone for good';
  end if;

  update attachments
     set deleted_at = null, deleted_by = null
   where id = p_id
  returning * into v_row;
  return v_row;
end;
$$;

comment on function public.restore_job_photo(uuid) is
  'Foreman+: undo a job-photo delete within the 30-day window (clears deleted_at/deleted_by). Refuses a photo not in the trash, and refuses past the 30-day deadline even if the nightly sweep has not run yet.';

revoke all on function public.restore_job_photo(uuid) from public;
grant execute on function public.restore_job_photo(uuid) to authenticated;

-- The nightly erase. Runs under cron with no auth.uid() (trusted the same way a
-- migration is — the sandbox guard returns early when auth.uid() is null). Files
-- go first so a crash mid-sweep leaves a harmless orphan file, never a row
-- pointing at a file already gone (purge_project's own ordering). storage_path is
-- "bucket/path"; split it to reach storage.objects.
create or replace function public.purge_expired_job_photos()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  delete from storage.objects o
   using attachments a
   where a.deleted_at is not null
     and a.deleted_at < now() - interval '30 days'
     and o.bucket_id = split_part(a.storage_path, '/', 1)
     and o.name = substr(a.storage_path, strpos(a.storage_path, '/') + 1);

  delete from attachments
   where deleted_at is not null
     and deleted_at < now() - interval '30 days';
end;
$$;

comment on function public.purge_expired_job_photos() is
  'Nightly sweep (pg_cron, ''purge-expired-job-photos''): erases every job photo whose 30-day trash window has passed, file then row. Trusted JWT-less cron context, same as purge_expired_projects.';

-- Cron-only, and destructive: it permanently erases expired job photos (file
-- then row) across EVERY project. SECURITY DEFINER runs it as the owner, so a
-- grant to `authenticated` would let any signed-in user fire the whole-fleet
-- purge on demand — never the intent. The nightly schedule below runs as its
-- creator (postgres, the pg_cron owner), which owns the function and needs no
-- grant; service_role (the trusted backend key, not a user) keeps the explicit
-- grant the sibling sweeps carry (expire_summons, purge_expired_projects). No
-- user role may call it.
revoke all on function public.purge_expired_job_photos() from public, anon, authenticated;
grant execute on function public.purge_expired_job_photos() to service_role;

create extension if not exists pg_cron;

do $$
begin
  perform cron.unschedule('purge-expired-job-photos');
exception when others then
  null; -- first run: nothing scheduled yet
end;
$$;

select cron.schedule(
  'purge-expired-job-photos',
  '30 7 * * *',   -- once nightly, just after the job-trash sweep; past-due is past-due
  $$ select public.purge_expired_job_photos(); $$
);

-- ---------------------------------------------------------------------------
-- 5. Arm the test-login fence on the new project-scoped table
-- ---------------------------------------------------------------------------
-- project_cost_codes is project-scoped (project_id), so a QA test login could
-- otherwise write it on ANY job. attach_sandbox_guards() (20260967000000) puts
-- the guard on it; scripts/test_sandbox_guard.py fails CI if this call is
-- missing, and scripts/verify-sandbox-guard.sh fails the deploy if it did not
-- take. Must be in THIS file — a later migration's arming call has already run
-- by the time this table lands.
select public.attach_sandbox_guards();


-- ===========================================================================
-- 20260972000000_job_summons.sql (mirrored)
-- A summon can attach to a JOB, not only a window: summons.opening_id DROPs
-- NOT NULL and summons gains where_note (the "where I am on the job" note). A
-- new create_job_summon takes a project directly (a sibling, not an overload,
-- of create_summon); the window-path create_summon is rebuilt in full,
-- unchanged. answer_/close_/expire_ already tolerate a null opening.
-- ===========================================================================
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


-- ===========================================================================
-- 20260974000000_job_deletion_supervisor.sql (mirrored)
-- Delete a job: supervisor+, with a required reason, an all-supervisor notice
-- (client-side), and the trash now visible to supervisors. trash_project /
-- restore_project / purge_project rebuilt in full from 20260959000000 —
-- _is_supervisor gate + deleted_reason; purge_project also picks up
-- project_cost_codes (added after the trash migration). projects gains a
-- deleted_reason column and projects_select_visible widens its trash branch.
-- ===========================================================================
-- Delete a job: supervisor+, with a reason, 30 days to undo, then gone.
--
-- Owner ask (standard-tracking-jobs slice 5, 2026-09-03): a supervisor should
-- be able to delete a bad job — a mistaken quick tracking job, a duplicate
-- callback, a test that leaked onto the board — not only the owner. Deleting a
-- job is a big act, so it now demands a REASON and puts a NOTICE in front of
-- every supervisor (the notice is client-side, lib/jobDeletion.ts; this file is
-- the reason and the gate). The 30-day recoverable trash itself is unchanged
-- (20260959000000 built it); this widens who may work it and records why.
--
-- Read first: 20260959000000_project_trash.sql (the trash model, the full
-- purge order, and every WHY behind it — this migration REBUILDS its three
-- functions verbatim except the gate and the reason, per the "rebuild in full,
-- never a diff" rule the movements_event_ck incident set), _is_supervisor
-- (20260810000000), and the void_shift reason precedent (20260944000000).
--
-- Nothing here creates or re-scopes a project-scoped table: projects already
-- exists and is already fenced by the sandbox guard (20260967000000), and
-- deleted_reason is a plain text column on it — so no attach_sandbox_guards()
-- call is needed (scripts/test_sandbox_guard.py agrees).


-- =============================================================================
-- 1. The reason column
-- =============================================================================
-- Stored on the row beside deleted_at/deleted_by, written ONLY by
-- trash_project() (SECURITY DEFINER) and cleared by restore_project(). It is
-- deliberately NOT added to the projects UPDATE column grant (20260959000000):
-- a direct client PATCH naming deleted_reason must 42501, exactly like
-- deleted_at, is_test and allowed_modes — the RPC is the one door.

alter table projects add column if not exists deleted_reason text;

comment on column projects.deleted_reason is
  'Why the job was deleted — required, set by trash_project(), cleared by restore_project(), erased with the row by purge_project(). RPC-only: not in the projects UPDATE column grant, so a direct PATCH naming it 42501s.';


-- =============================================================================
-- 2. See-the-trash: a supervisor now manages it, so a supervisor must see it
-- =============================================================================
-- projects_select_visible (20260959000000) hid a trashed row from everyone but
-- rank>=3 (the owner). With deletion and restore now supervisor+, a supervisor
-- who deletes a job could not see it in the trash to undo it — restore_project
-- being supervisor+ would be unreachable from the UI. So the trash sub-
-- predicate widens from my_role_rank()>=3 to _is_supervisor(auth.uid()). Every
-- other branch is byte-identical to 20260959000000 — crucially the whole
-- is_test / partner-grant predicate is preserved, so a trashed job still cannot
-- leak to a partner login (the partner branch is ANDed under the same trash
-- gate), and THE WALL's partner_job_grants + is_partner_user guard stays intact
-- (scripts/test_partner_wall.py checks for exactly those two).

drop policy if exists "projects_select_visible" on projects;
create policy "projects_select_visible" on projects
  for select to authenticated using (
    (deleted_at is null or _is_supervisor(auth.uid()))
    and (
      is_test = false or _is_supervisor(auth.uid())
      or (
        public.is_partner_user()
        and exists (
          select 1 from partner_job_grants g
          where g.project_id = projects.id and g.partner_profile_id = auth.uid()
        )
      )
    )
  );


-- =============================================================================
-- 3. trash_project — supervisor+, reason required and stored
-- =============================================================================
-- The signature changes (uuid -> uuid, text), so the old one-arg overload is
-- DROPPED first: leaving it would keep a reasonless, owner-only delete door
-- open alongside this one, defeating "require a reason".

drop function if exists public.trash_project(uuid);

create or replace function public.trash_project(p_project_id uuid, p_reason text)
returns projects
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row projects;
  v_reason text := btrim(coalesce(p_reason, ''));
begin
  if not _is_supervisor(auth.uid()) then
    raise exception 'Only a supervisor or above can delete a job.' using errcode = '42501';
  end if;
  if v_reason = '' then
    raise exception 'Give a reason for deleting this job.';
  end if;

  select * into v_row from projects where id = p_project_id for update;
  if v_row.id is null then
    raise exception 'That job does not exist.';
  end if;
  if v_row.deleted_at is not null then
    raise exception 'That job is already in the trash.';
  end if;

  update projects
     set deleted_at = now(), deleted_by = auth.uid(), deleted_reason = v_reason
   where id = p_project_id
  returning * into v_row;

  -- The Horizon fake-success lesson (cited verbatim in void_shift,
  -- 20260944000000): an UPDATE matching nothing must never be reported back
  -- as though the trash happened. Unreachable given the row lock above; kept
  -- explicit so a future refactor that drops the lock still fails loudly.
  if v_row.id is null then
    raise exception 'trash did not apply to job % — no row was updated', p_project_id;
  end if;

  return v_row;
end;
$$;

comment on function public.trash_project(uuid, text) is
  'Supervisor+: move a job to the 30-day trash (deleted_at/deleted_by/deleted_reason). Reason is required. Refuses a job already in the trash or that does not exist. Undo via restore_project(); permanent erase via purge_project() after 30 days (nightly sweep) or directly. Widened from owner-only + reasonless in 20260974000000.';

revoke all on function public.trash_project(uuid, text) from public, anon;
grant execute on function public.trash_project(uuid, text) to authenticated;


-- =============================================================================
-- 4. restore_project — supervisor+, clears the reason too
-- =============================================================================

create or replace function public.restore_project(p_project_id uuid)
returns projects
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row projects;
begin
  if not _is_supervisor(auth.uid()) then
    raise exception 'Only a supervisor or above can undo a deleted job.' using errcode = '42501';
  end if;

  select * into v_row from projects where id = p_project_id for update;
  if v_row.id is null then
    raise exception 'That job does not exist.';
  end if;
  if v_row.deleted_at is null then
    raise exception 'That job is not in the trash.';
  end if;
  -- Past the deadline refuses even if the nightly sweep has not swept this
  -- row yet, so the 30-day promise is exact regardless of cron timing.
  if now() >= v_row.deleted_at + interval '30 days' then
    raise exception 'The 30 days are up — this job is gone for good.';
  end if;

  update projects
     set deleted_at = null, deleted_by = null, deleted_reason = null
   where id = p_project_id
  returning * into v_row;

  if v_row.id is null then
    raise exception 'restore did not apply to job % — no row was updated', p_project_id;
  end if;

  return v_row;
end;
$$;

comment on function public.restore_project(uuid) is
  'Supervisor+: undo a trash within the 30-day window (clears deleted_at/deleted_by/deleted_reason). Refuses a job not in the trash, and refuses past the 30-day deadline even if the nightly sweep has not run yet. Widened from owner-only in 20260974000000.';

revoke all on function public.restore_project(uuid) from public, anon;
grant execute on function public.restore_project(uuid) to authenticated;


-- =============================================================================
-- 5. purge_project — the permanent erase, now supervisor+
-- =============================================================================
-- REBUILT IN FULL from 20260959000000 (the whole detach-then-purge order, the
-- ADR-0004 package_marks unlink, the attachments dual-anchor split, the storage
-- cleanup) — never a diff. Two changes from that body:
--   * the direct-caller gate: my_role_rank() < 3 becomes not
--     _is_supervisor(auth.uid());
--   * one added delete — project_cost_codes (a job's pickable cost-code subset,
--     standard-tracking-jobs slice 3, 20260973000000) did not exist when
--     20260959000000 was written. It is a direct project_id child, so it is
--     purged explicitly here beside its siblings. (Its FK is ON DELETE CASCADE,
--     so the final projects delete would take it anyway — the explicit delete
--     matches how every other direct child is handled and keeps the cascade
--     legible.)
-- The cron path is untouched: auth.uid() is null under pg_cron (no JWT), so the
-- sweep runs exactly as before, trusted the way a migration or the service key
-- is. The 45-table project-scoped census (sandbox_scoped_tables) maps cleanly
-- onto this body — every scoped table is detached here, deleted here, or
-- cascades from project_openings / the final projects delete;
-- app/src/lib/trashCascade.test.ts is the standing check that it stays so.

create or replace function public.purge_project(p_project_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_project projects;
  v_job_name text;
  v_install_media_paths text[];
  v_issue_photo_paths text[];
begin
  if auth.uid() is not null and not _is_supervisor(auth.uid()) then
    raise exception 'Only a supervisor or above can permanently delete a job.' using errcode = '42501';
  end if;

  select * into v_project from projects where id = p_project_id for update;
  if v_project.id is null then
    raise exception 'That job does not exist.';
  end if;
  if v_project.deleted_at is null then
    raise exception 'That job is not in the trash.';
  end if;
  v_job_name := v_project.name;

  -- ---------------------------------------------------------------------
  -- STEP 0 — every detach runs first, inside this one transaction, so no
  -- FK can block a delete below (movements' FK carries NO on-delete rule
  -- at all — it would abort the whole purge if it still pointed at this
  -- job when the projects row goes).
  -- ---------------------------------------------------------------------
  update movements set project_id = null, job_name = coalesce(job_name, v_job_name)
   where project_id = p_project_id;
  update windows set project_id = null, job_name = coalesce(job_name, v_job_name)
   where project_id = p_project_id;
  update packages set project_id = null, pending_job_name = coalesce(pending_job_name, v_job_name)
   where project_id = p_project_id;
  update time_shifts set project_id = null, job_name = coalesce(job_name, v_job_name)
   where project_id = p_project_id;
  update task_sessions set project_id = null
   where project_id = p_project_id;
  update incidents set project_id = null, job_name = coalesce(job_name, v_job_name)
   where project_id = p_project_id;
  update service_cases set project_id = null, job_name = coalesce(job_name, v_job_name)
   where project_id = p_project_id;
  update trips set project_id = null, job_name = coalesce(job_name, v_job_name)
   where project_id = p_project_id;
  update receipts set project_id = null, pending_job_name = coalesce(pending_job_name, v_job_name)
   where project_id = p_project_id;
  update studio_projects set project_id = null
   where project_id = p_project_id;
  update monday_jobs set project_id = null
   where project_id = p_project_id;
  update job_costs set project_id = null, job_name = coalesce(job_name, v_job_name)
   where project_id = p_project_id;
  update change_orders set project_id = null, job_name = coalesce(job_name, v_job_name)
   where project_id = p_project_id;
  update daily_logs set project_id = null, job_name = coalesce(job_name, v_job_name)
   where project_id = p_project_id;

  -- OPEN Q4: a damage report on a package that survives detaches WITH the
  -- package (project_id nulled, row and photo kept); every other issue on
  -- this job purges below.
  update issues
     set project_id = null
   where project_id = p_project_id
     and kind = 'damage' and package_id is not null;

  -- AUDIT HOLES 3+4: attachments dual-anchored to a surviving physical thing
  -- (window, package, or service case) detach — unlink install_event_id and
  -- project_id, keep the row and its storage file untouched. Two passes:
  -- rows already carrying this project's id, and (defense in depth, in case
  -- a row was ever written without project_id set) rows reached only via
  -- install_event_id whose event belongs to one of this job's openings.
  update attachments
     set install_event_id = null, project_id = null
   where project_id = p_project_id
     and (window_id is not null or package_id is not null or service_case_id is not null);

  update attachments a
     set install_event_id = null, project_id = null
    from install_events ie, project_openings po
   where a.install_event_id = ie.id
     and ie.project_opening_id = po.id
     and po.project_id = p_project_id
     and (a.window_id is not null or a.package_id is not null or a.service_case_id is not null);

  -- OPEN Q3 / ADR-0004: snapshot the mark's text onto every package_marks
  -- row still pointing at one of this job's marks, THEN unlink — must
  -- happen before project_marks purges below, or the RESTRICT FK aborts.
  update package_marks pm
     set mark_code = coalesce(pm.mark_code, pmk.mark_code)
    from project_marks pmk
   where pm.mark_id = pmk.id and pmk.project_id = p_project_id;

  update package_marks
     set mark_id = null
   where mark_id in (select id from project_marks where project_id = p_project_id);

  -- ---------------------------------------------------------------------
  -- The purge order. summon_helpers/summon_declines cascade from summons;
  -- install_events/qc_checks/opening_phases/opening_notes/unit_redos/
  -- unit_sessions/project_opening_pin_moves/install_event_time_repairs all
  -- cascade from project_openings (verified against each table's own
  -- migration) — one delete of the parent takes the whole branch.
  -- project_planset_pages cascades from project_plansets the same way.
  -- ---------------------------------------------------------------------
  delete from summons where project_id = p_project_id;

  -- Gather storage paths BEFORE deleting the rows that name them: install
  -- photos anchored only to this job's install_events (no surviving window/
  -- package/service_case — the survivors above already lost that link), and
  -- opening_phases' finished-work photos, which carry no attachments row of
  -- their own and are about to cascade away with project_openings below.
  select coalesce(array_agg(path), '{}') into v_install_media_paths
    from (
      select a.storage_path as path
        from attachments a
        join install_events ie on ie.id = a.install_event_id
        join project_openings po on po.id = ie.project_opening_id
       where po.project_id = p_project_id
      union all
      select op.photo_path
        from opening_phases op
        join project_openings po on po.id = op.opening_id
       where po.project_id = p_project_id and op.photo_path is not null
    ) paths;

  delete from attachments a
   using install_events ie, project_openings po
   where a.install_event_id = ie.id
     and ie.project_opening_id = po.id
     and po.project_id = p_project_id;

  -- Issues: gather photo paths of what purges (the surviving package-damage
  -- carve-out above already left this project, so it is excluded here).
  select coalesce(array_agg(photo_path), '{}') into v_issue_photo_paths
    from issues where project_id = p_project_id and photo_path is not null;

  delete from issues where project_id = p_project_id;

  -- Takes install_events, qc_checks, opening_phases, opening_notes,
  -- unit_redos, unit_sessions, project_opening_pin_moves and
  -- install_event_time_repairs with it.
  delete from project_openings where project_id = p_project_id;

  -- Takes project_planset_pages with it.
  delete from project_mark_elevation_views where project_id = p_project_id;
  delete from project_plan_outlines where project_id = p_project_id;
  delete from project_plansets where project_id = p_project_id;
  delete from project_spec_discrepancies where project_id = p_project_id;
  delete from project_mark_specs where project_id = p_project_id;
  -- package_marks already unlinked above, so this can never hit RESTRICT.
  delete from project_marks where project_id = p_project_id;
  delete from project_windows where project_id = p_project_id;
  delete from job_notes where project_id = p_project_id;
  delete from supply_orders where project_id = p_project_id;
  delete from flash_run_assignments where project_id = p_project_id;
  delete from schedule_assignments where project_id = p_project_id;
  delete from vehicle_project_assignments where project_id = p_project_id;
  delete from takeoffs where project_id = p_project_id;
  delete from project_message_reads where project_id = p_project_id;
  delete from project_messages where project_id = p_project_id;
  delete from project_cost_codes where project_id = p_project_id;
  delete from sandbox_projects where project_id = p_project_id;
  delete from partner_job_grants where project_id = p_project_id;

  -- Storage cleanup: SQL DELETE against storage.objects — the bytes become
  -- unreachable in the bucket, there is no separate "delete the file" step
  -- this migration can call from SQL. Files go second-to-last, right before
  -- the projects row, so a crash mid-purge leaves harmless orphan files in
  -- the bucket, never a row pointing at a file that is already gone.
  delete from storage.objects
   where bucket_id = 'plansets' and name like p_project_id::text || '/%';

  delete from storage.objects
   where bucket_id = 'install-media' and name = any (v_install_media_paths);

  delete from storage.objects
   where bucket_id = 'issue-photos' and name = any (v_issue_photo_paths);

  delete from projects where id = p_project_id;
end;
$$;

comment on function public.purge_project(uuid) is
  'The permanent erase: supervisor+ when called directly, and fed expired ids by purge_expired_projects (nightly pg_cron sweep, no auth.uid() in that context — trusted the same way a migration or the service key is). Refuses a job that does not exist or is not currently in the trash; does NOT re-check the 30-day deadline itself. Runs the full detach-then-purge order the census specifies. Gate widened from owner-only in 20260974000000; body otherwise identical to 20260959000000.';

revoke all on function public.purge_project(uuid) from public, anon;
grant execute on function public.purge_project(uuid) to authenticated;

-- ===========================================================================
-- 20260975000000_promote_to_data.sql (mirrored)
-- The one-way upgrade from a Tracking job to a full Data job: a foreman+
-- SECURITY DEFINER RPC that ADDS 'data' to projects.allowed_modes (union, never
-- replace — a both-mode job keeps tracking), so the data screens switch on while
-- every project-scoped record (logged time, photos, daily logs, cost codes,
-- summons) stays put. Idempotent; 'data' is only added, never removed, so there
-- is no downgrade path. Same lock as is_test / set_project_modes; no new table.
-- ===========================================================================

create or replace function public.promote_project_to_data(p_project_id uuid)
returns projects
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row projects;
  v_current text[];
  v_next text[];
begin
  if not _is_lead(auth.uid()) then
    raise exception 'only a foreman or above can build a job out into a data job';
  end if;

  select allowed_modes into v_current from projects where id = p_project_id;
  if not found then
    raise exception 'that job does not exist';
  end if;

  select array_agg(distinct m order by m) into v_next
  from (
    select m from unnest(coalesce(v_current, array['data']::text[])) as m
    where m in ('data', 'tracking')
    union
    select 'data'
  ) s;

  update projects set allowed_modes = v_next where id = p_project_id
  returning * into v_row;
  return v_row;
end;
$$;

revoke all on function public.promote_project_to_data(uuid) from public;
grant execute on function public.promote_project_to_data(uuid) to authenticated;


-- 20260976000000_time_honesty.sql (mirrored)
-- Wave K — Time honesty (transcripts program, grill of 2026-09-03).
--
-- Three honest things about time, in one migration because they are one
-- feature: the app knows where you were last seen, it asks once in the evening
-- whether you are really still on the job, and a worker can finally read the
-- record of who changed their own punches.
--
-- THE LOCATION LAW, written here because the database is the only place it
-- cannot be quietly dropped: this app has NO background location and must never
-- grow one. `touch_shift_location` is written ONLY when the app is brought to
-- the foreground, ONLY while the caller is genuinely on the clock, and only
-- from a fix the phone had already granted permission for. It records ONE point
-- per foreground visit, overwriting the last — there is no track, no history,
-- and nothing to reconstruct a day's movements from. A crew member's phone is
-- not a tracker; it is a timecard that can say "I was 14 miles away when I
-- opened the app".
--
-- Timezone: 'America/Denver' spelled out, the same company-local day
-- 20260813000000_toolbox_gate_timezone.sql settled for every clock gate. There
-- is no helper function to reuse — the convention IS the literal — so this file
-- follows it rather than inventing a second source of truth.
--
-- Idempotent throughout (create ... if not exists / create or replace /
-- on conflict do nothing), so re-running it changes nothing.

-- ---------------------------------------------------------------------------
-- 1. K3 — where a shift was last seen, and whether tonight's nudge already went
-- ---------------------------------------------------------------------------
-- On time_shifts rather than a table of its own for two reasons: the answer is
-- about ONE shift ("last seen while on this punch"), and a per-shift column
-- makes the evening claim below a single atomic UPDATE ... RETURNING, the way
-- summon_helpers.warned_at makes the 5-minute warning sweep atomic.
alter table time_shifts add column if not exists last_seen_at timestamptz;
alter table time_shifts add column if not exists last_seen_lat double precision;
alter table time_shifts add column if not exists last_seen_lng double precision;

-- The fix's own accuracy radius, in metres, stored WITH the point it belongs to.
-- Without it the supervisor line would be the one half of this feature that
-- speaks when it is not sure: the prompt (K1) stays silent on a fix fuzzier than
-- the far-from-job threshold, but a bare lat/lng read back later carries no
-- uncertainty, so `farFromJob` skips that guard and a wifi-derived 3 km fix from
-- inside a house prints "last seen 2 mi from where they clocked in" about
-- somebody standing on site. Null means the phone did not report one.
alter table time_shifts add column if not exists last_seen_accuracy_m double precision;

-- The company-local DAY the evening nudge last went out for this shift — a
-- date, not a timestamp, on purpose. A shift nobody closed for three days
-- should be asked about again each evening (that is precisely the shift worth
-- asking about), and a date is what makes "once per person per day" the claim
-- key rather than "once ever".
alter table time_shifts add column if not exists evening_nudged_on date;

comment on column time_shifts.last_seen_at is
  'When the app was last brought to the foreground while this shift was open. Foreground only — there is no background location in this app and there must not be (Wave K, K3).';
comment on column time_shifts.last_seen_lng is
  'Longitude of the last foreground fix on this shift. One point, overwritten each time — never a track.';
comment on column time_shifts.last_seen_accuracy_m is
  'Reported accuracy radius (metres) of the last foreground fix, or null when the phone did not say. Read back together with the point so a fuzzy fix cannot be reported as a confident distance (Wave K, K3).';

-- ---------------------------------------------------------------------------
-- 2. K3 — touch_shift_location: the one door, and it only opens on yourself
-- ---------------------------------------------------------------------------
-- SELF-ONLY by construction: the WHERE clause pins profile_id to auth.uid(),
-- so there is no argument a caller could pass to stamp somebody else's shift.
-- SECURITY DEFINER because time_shifts' table policy is a broad
-- "authenticated full access" today; when that wall tightens, this narrow door
-- keeps working without a second migration.
--
-- A caller who is not on the clock gets `null` and no error. That is deliberate:
-- this runs on every app open, and an app that threw an error at somebody for
-- the crime of opening it off the clock would teach the crew to distrust it.
-- An earlier draft of this migration took two arguments. Dropped rather than
-- left as an overload: with defaults on both, a two-argument call would be
-- ambiguous between the two, and PostgREST would pick by parameter names and
-- quietly keep writing points with no accuracy beside them.
drop function if exists public.touch_shift_location(double precision, double precision);

create or replace function public.touch_shift_location(
  p_lat double precision default null,
  p_lng double precision default null,
  p_accuracy_m double precision default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_id uuid;
begin
  if v_uid is null then
    raise exception 'Sign in before the app can save where you are.';
  end if;

  update time_shifts
     set last_seen_at = now(),
         -- A fix we do not have must not erase the one we do: a foreground
         -- visit with location switched off still updates the TIME (they had
         -- the app open) and leaves the last known point alone.
         last_seen_lat = coalesce(p_lat, last_seen_lat),
         last_seen_lng = coalesce(p_lng, last_seen_lng),
         -- The accuracy moves WITH the point, and only with it. Coalescing it
         -- the way the coordinates are coalesced would pair a brand-new point
         -- with the previous fix's radius, which is a worse lie than storing
         -- nothing: a 3 km fix would inherit "accurate to 20 m" and the
         -- supervisor line would state a distance it has no right to.
         last_seen_accuracy_m = case
           when p_lat is not null and p_lng is not null then p_accuracy_m
           else last_seen_accuracy_m
         end
   where profile_id = v_uid
     and status = 'open'
     and clock_out_at is null
  returning id into v_id;

  return v_id;
end;
$$;

comment on function public.touch_shift_location(double precision, double precision, double precision) is
  'Self-only: stamps the caller''s own OPEN shift with the moment the app came to the foreground and, when the phone already had permission, where it was and how precisely. Returns the shift id, or null when the caller is not on the clock (never an error — this runs on every app open). Foreground only; this app has no background location (Wave K, K3).';

revoke all on function public.touch_shift_location(double precision, double precision, double precision) from public, anon;
grant execute on function public.touch_shift_location(double precision, double precision, double precision) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. K2 — the one company setting behind the evening nudge
-- ---------------------------------------------------------------------------
-- A single-row settings table, the same shape as ai_spend_limits (20260729230000):
-- id fixed at 1 by a CHECK, seeded on creation, changed through an RPC rather
-- than a table grant. There was no general company settings row in this schema
-- to hang this on — ai_spend_limits is about the AI budget and nothing else —
-- so this is the first, and the place the next such setting belongs.
create table if not exists company_settings (
  id integer primary key default 1 check (id = 1),

  -- The company's local time of day the "Still on the job?" nudge goes out.
  -- 17:30 by default: late enough that a normal day is over, early enough that
  -- a forgotten clock-out is fixed the same evening rather than at payroll.
  evening_nudge_local_time time not null default '17:30',

  -- The off switch. A company that decides the nudge is noise turns it off
  -- here rather than having someone unschedule a cron job.
  evening_nudge_enabled boolean not null default true,

  updated_at timestamptz not null default now(),
  updated_by uuid
);

insert into company_settings (id) values (1) on conflict (id) do nothing;

alter table company_settings enable row level security;

-- Revoke BEFORE granting, because this project's default privileges hand every
-- new table in `public` the full set — insert, update, delete, trigger,
-- references — to `authenticated`. 20260729230000 wrote down why "RLS is on and
-- the only policy is a SELECT one" is not good enough: it makes RLS the single
-- thing standing between a crew login and rewriting the company's settings, and
-- one permissive policy added later, by anybody, turns it into a write hole.
-- set_evening_nudge_time runs security definer, so the revoke does not touch it.
revoke all on company_settings from anon, authenticated;
grant select on company_settings to authenticated;
grant all on company_settings to service_role;

-- Readable by any signed-in crew member (the clock sheet may one day want to
-- say when the nudge goes out), never by a partner login — the mechanical
-- wall guard every crew table carries since 20260950000000. No insert/update/
-- delete policy at all: set_evening_nudge_time below is the only writer.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'company_settings' and policyname = 'crew read'
  ) then
    create policy "crew read" on company_settings
      for select to authenticated
      using (not public.is_partner_user() and (true));
  end if;
end;
$$;

create or replace function public.set_evening_nudge_time(
  p_local_time text,
  p_enabled boolean default null
)
returns company_settings
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row company_settings;
  v_time time;
begin
  if not _is_lead(auth.uid()) then
    raise exception 'Only a foreman or above can change when the evening reminder goes out.';
  end if;

  begin
    v_time := p_local_time::time;
  exception when others then
    raise exception 'That is not a time of day. Use something like 17:30.';
  end;

  update company_settings
     set evening_nudge_local_time = v_time,
         evening_nudge_enabled = coalesce(p_enabled, evening_nudge_enabled),
         updated_at = now(),
         updated_by = auth.uid()
   where id = 1
  returning * into v_row;

  return v_row;
end;
$$;

comment on function public.set_evening_nudge_time(text, boolean) is
  'Foreman+: set the company-local time of day the "Still on the job?" nudge goes out (and optionally switch it off). Rejects anything that is not a time of day with a plain sentence.';

revoke all on function public.set_evening_nudge_time(text, boolean) from public, anon;
grant execute on function public.set_evening_nudge_time(text, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. K2 — claiming tonight's nudges, atomically
-- ---------------------------------------------------------------------------
-- The decision and the claim are ONE statement, for the reason ai_spend_limits
-- gives about its own counter: a read-then-write ("who is still on, then mark
-- them") loses exactly when it matters, because two overlapping sweeps both
-- read the same unmarked rows and both push. `update ... where
-- evening_nudged_on is distinct from <today> ... returning` takes the row lock,
-- so the second sweep genuinely sees the first one's work and returns nobody.
--
-- Who is claimed: an OPEN shift, on a cost code that is not Travel (900),
-- clocked in BEFORE tonight's nudge moment. That last clause is what stops a
-- 6 PM clock-in being asked "still on the job?" at 6:05 — the question only
-- makes sense for someone who was already on the clock when the hour came.
--
-- Service context only. auth.uid() is null under the service-role key the edge
-- function uses and under pg_cron, and a crew member has no business firing the
-- company's evening push by hand.
create or replace function public.claim_still_on_the_job_nudges()
returns table (shift_id uuid, profile_id uuid, project_id uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tz constant text := 'America/Denver';
  v_settings company_settings;
  v_now_local timestamp;
  v_nudge_local timestamp;
  v_nudge_moment timestamptz;
  v_local_day date;
begin
  if auth.uid() is not null then
    raise exception 'The evening reminder sends itself — nobody needs to press anything.';
  end if;

  select * into v_settings from company_settings where id = 1;
  if not found or not v_settings.evening_nudge_enabled then
    return;
  end if;

  v_now_local := (now() at time zone v_tz);
  v_local_day := v_now_local::date;
  v_nudge_local := date_trunc('day', v_now_local) + v_settings.evening_nudge_local_time;
  -- Before the hour: nothing is due. The sweep runs every few minutes and
  -- says nothing all day, which is the point.
  if v_now_local < v_nudge_local then
    return;
  end if;
  v_nudge_moment := (v_nudge_local at time zone v_tz);

  return query
  update time_shifts ts
     set evening_nudged_on = v_local_day
    from cost_codes cc
   where ts.cost_code_id = cc.id
     and ts.status = 'open'
     and ts.clock_out_at is null
     and cc.code <> '900'
     and ts.clock_in_at < v_nudge_moment
     and ts.evening_nudged_on is distinct from v_local_day
  returning ts.id, ts.profile_id, ts.project_id;
end;
$$;

comment on function public.claim_still_on_the_job_nudges() is
  'Service-role only (the still-on-the-job-sweep edge function): claims and returns everyone with an open shift on a job cost code — never Travel 900 — once the company-local nudge hour has passed, at most once per person per local day. The claim and the decision are one UPDATE ... RETURNING so two overlapping sweeps cannot both push.';

revoke all on function public.claim_still_on_the_job_nudges() from public, anon, authenticated;
grant execute on function public.claim_still_on_the_job_nudges() to service_role;

-- ---------------------------------------------------------------------------
-- 5. K2 — the sweep itself
-- ---------------------------------------------------------------------------
-- Every few minutes rather than once at 17:30: the hour is a company setting a
-- foreman can move, and a cron line cannot follow a setting. The claim above is
-- what makes a frequent poke free — before the hour it returns nobody, and
-- after it, only the first sweep of the evening claims anyone.
--
-- Wrapped in exception handlers the way 20260963000000_summon_expiry.sql wraps
-- its own: a database without pg_cron (a local `supabase start`, a fork for a
-- test) still applies this migration. The nudge is a courtesy, not a rule —
-- nothing about time depends on it — so a missing scheduler earns a warning in
-- the log, never a failed migration.
do $$
begin
  create extension if not exists pg_cron;
exception when others then
  raise warning 'still-on-the-job-sweep: pg_cron is not available here (%) — the evening reminder will not run. Nothing else about the clock changes.', sqlerrm;
end;
$$;

do $$
begin
  create extension if not exists pg_net;
exception when others then
  raise warning 'still-on-the-job-sweep: pg_net is not available here (%) — the evening reminder will not run. Nothing else about the clock changes.', sqlerrm;
end;
$$;

do $$
begin
  perform cron.unschedule('still-on-the-job-sweep');
exception when others then
  null; -- first run: nothing scheduled yet
end;
$$;

-- The project ref is this repo's one production project, pinned the same way
-- 20260918000000 pins it for the summon sweep. verify_jwt = false on the target
-- function, so no auth header rides along — see the function's own header for
-- why that is safe.
do $$
begin
  perform cron.schedule(
    'still-on-the-job-sweep',
    '*/5 * * * *',
    $c$
    select net.http_post(
      url := 'https://czprjcskmzzagdztqonm.supabase.co/functions/v1/still-on-the-job-sweep',
      body := '{}'::jsonb,
      headers := '{"Content-Type": "application/json"}'::jsonb
    );
    $c$
  );
exception when others then
  raise warning 'still-on-the-job-sweep: could not schedule the sweep (%) — the evening reminder will not run. Nothing else about the clock changes.', sqlerrm;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. K4 — a worker can read the edits made to their OWN punches
-- ---------------------------------------------------------------------------
-- time_shift_edits has been supervisor-read-only since 20260810000000, which
-- means the one person whose hours were changed was the one person who could
-- not see what changed. That is backwards: the audit log exists so a change to
-- somebody's pay is visible to them, not only to the people above them.
--
-- Read-only, and only for rows about their own shifts. There is still no
-- insert/update/delete policy on this table at all — lead_edit_shift, running
-- security definer, remains the single writer, and nothing rewrites history.
drop policy if exists "own shift read" on time_shift_edits;
create policy "own shift read" on time_shift_edits
  for select to authenticated
  using (
    not public.is_partner_user()
    and exists (
      select 1 from time_shifts ts
       where ts.id = time_shift_edits.shift_id
         and ts.profile_id = auth.uid()
    )
  );


-- ===========================================================================
-- 20260977000000_field_truth.sql (mirrored)
-- Field truth, wave E of the transcripts program: "data off" with a REASON
-- (project_openings.flag_kind, five codes, free-text flags backfilled to
-- 'other'), and a window or door added from the site (add_field_unit, which
-- checks an open shift on that job rather than a rank). Raising a flag is
-- anyone's; clearing one is foreman+, enforced in flag_opening's clear branch
-- and again by a trigger on the two flag columns so no door skips it. A missed
-- unit gets its own opening, its own mark spec (source 'field'), a photo
-- attachment and an issue; a supervisor then keeps, renames, merges or
-- withdraws it. Adds no table — project_openings, project_mark_specs and
-- attachments are all already guarded — and re-arms the sandbox cage at the
-- end. Deploy AFTER 20260976000000.
-- ===========================================================================

-- FIELD TRUTH: "data off" with a reason, and a missed unit added from the site.
--
-- Transcripts program, wave E (owner grill 2026-09-03, Q12 + Q18). Two things
-- the crew has been telling each other on the phone instead of telling the app:
--
--   1. "the data is off on this one" — the window is in, but the paperwork was
--      wrong: wrong size, mirrored, not as drawn. Today the only way to say it
--      is a free-text flag nobody counts, so the bad numbers quietly become
--      estimating evidence. This gives the flag a REASON code, leaves the note
--      alone, and never blocks Finish — "done, data off" is the normal case.
--   2. "there's a window here that isn't on the plans" — the crew finds a unit
--      the paperwork never had. add_field_unit lets whoever is standing there
--      add it, with a photo and (when there is a map) a pin, and rings the
--      leads. Presence on the job is the permission, not rank: the person who
--      can see the hole is the person who should be able to record it.
--
-- Every existing caller of flag_opening keeps working: the two-argument form
-- stays, and a note with no kind reads as 'other', which is also what every
-- free-text flag already on the database is backfilled to.

-- ---------------------------------------------------------------------------
-- 1. The columns
-- ---------------------------------------------------------------------------

alter table project_openings
  add column if not exists flag_kind text,
  -- Born in the field rather than read off a planset. The one flag that makes
  -- a row immune to every re-extraction sweep (#476): the extractor may drop
  -- its own guesses, never a person's. Separate from flag_kind on purpose —
  -- a supervisor clearing the data-off flag must not make the row deletable.
  add column if not exists field_added boolean not null default false,
  -- WHICH missed unit this was on this job, kept apart from the name it wears.
  -- The number used to be read back out of opening_code ("Missed 3" → 3), which
  -- made it depend on a field a supervisor is invited to change: rename
  -- "Missed 1" to "W-14" and the 1 is free again, so the next unit added is
  -- "Missed 1" a second time and inherits the first one's spec row — the width
  -- and height somebody orders glass from. A number nothing renames cannot be
  -- handed out twice.
  add column if not exists field_unit_seq int;

alter table project_openings drop constraint if exists project_openings_flag_kind_check;
alter table project_openings add constraint project_openings_flag_kind_check
  check (
    flag_kind is null
    or flag_kind in ('wrong_size', 'mirrored', 'not_as_drawn', 'not_on_plans', 'other')
  );

comment on column project_openings.flag_kind is
  'Why this unit''s record is wrong: wrong_size | mirrored | not_as_drawn | not_on_plans | other. Null means no flag. Free-text flags raised before wave E read as ''other''.';
comment on column project_openings.field_added is
  'True when a person on site added this window or door with add_field_unit. Re-extraction never deletes one.';
comment on column project_openings.field_unit_seq is
  'The N this row was issued as "Missed N". Survives renaming and removal so a number is never handed out twice on a job.';

-- Idempotent backfill, for a database where an earlier cut of this migration
-- already issued codes: read the number back off the name while the name is
-- still the only place it lives.
update project_openings
   set field_unit_seq = (regexp_match(opening_code, '^Missed ([0-9]+)$'))[1]::int
 where field_added
   and field_unit_seq is null
   and opening_code ~ '^Missed [0-9]+$';

-- Every flag already on the database was typed as free text, so the only
-- honest reason for it is "other" — nobody was ever asked which kind it was.
update project_openings
   set flag_kind = 'other'
 where flag_note is not null and flag_kind is null;

create index if not exists project_openings_flagged_idx
  on project_openings (project_id) where flag_kind is not null;

-- The photo of a missed unit hangs off the OPENING, the same way a package
-- photo hangs off its package (20260936000000). attachments_target has to
-- learn the new target or the insert fails the check the moment it is written.
alter table attachments add column if not exists project_opening_id uuid
  references project_openings(id) on delete cascade;
create index if not exists attachments_opening_idx on attachments (project_opening_id);

alter table attachments drop constraint if exists attachments_target;
alter table attachments add constraint attachments_target
  check (
    window_id is not null
    or install_event_id is not null
    or package_id is not null
    or project_opening_id is not null
  );

-- A field-added mark spec records where it came from. 'field' joins the three
-- provenances the extractor and its reviewers already use.
alter table project_mark_specs drop constraint if exists project_mark_specs_source_check;
alter table project_mark_specs add constraint project_mark_specs_source_check
  check (source in ('ai', 'manual', 'deterministic', 'field'));

-- ---------------------------------------------------------------------------
-- 2. flag_opening, with a reason
-- ---------------------------------------------------------------------------
--
-- TWO FUNCTIONS, NOT ONE WITH A DEFAULT. PostgREST picks an overload by the
-- SET OF ARGUMENT NAMES in the request body, and a parameter carrying a
-- default is still a candidate — so `flag_opening(uuid, text, text default
-- null)` alongside the old two-argument form would make every existing
-- {p_opening_id, p_note} call ambiguous and fail. Two exact arities can never
-- be ambiguous, so the old callers keep working untouched and the new one
-- names its kind.

-- NOT security definer, deliberately: the function it replaces was not either,
-- and it has no reason to bypass RLS — an installer may already update the
-- openings they can see. Definer here would additionally let a caller flag (and
-- read back) a REMOVED opening, which is a row nobody is supposed to see.
create or replace function flag_opening(
  p_opening_id uuid,
  p_note text,
  p_kind text
)
returns project_openings
language plpgsql
set search_path = public
as $$
declare
  v_opening project_openings;
  v_clean text;
  v_kind text;
begin
  v_clean := nullif(trim(coalesce(p_note, '')), '');
  v_kind := nullif(trim(coalesce(p_kind, '')), '');

  if v_kind is not null
     and v_kind not in ('wrong_size', 'mirrored', 'not_as_drawn', 'not_on_plans', 'other') then
    raise exception 'Pick one of the listed reasons for the data being off.'
      using errcode = '22023';
  end if;

  -- A note with no kind is the old two-argument call's meaning: something is
  -- wrong and nobody was asked to say which kind. A kind with no note is fine
  -- — the reason IS the message.
  if v_clean is null and v_kind is null then
    -- THE RANK LIVES HERE, not only in clear_opening_flag. Both arities and
    -- both call paths end up in this branch, and the two-argument form is
    -- granted to every signed-in account and cannot be revoked without
    -- breaking the callers it exists for — so a check that sat only in
    -- clear_opening_flag was one `flag_opening(id, null)` away from being no
    -- check at all. Only asked when there is something to take down: clearing
    -- nothing is not a claim about anything.
    if not public.is_foreman_plus(auth.uid())
       and exists (
         select 1 from project_openings
          where id = p_opening_id
            and (flag_kind is not null or flag_note is not null)
       ) then
      raise exception 'Only a foreman or above can clear a data-off flag.'
        using errcode = '42501';
    end if;

    update project_openings
       set flag_kind = null, flag_note = null, flagged_by = null, flagged_at = null
     where id = p_opening_id
     returning * into v_opening;
  else
    update project_openings
       set flag_kind = coalesce(v_kind, 'other'),
           flag_note = v_clean,
           flagged_by = auth.uid(),
           flagged_at = now()
     where id = p_opening_id
     returning * into v_opening;
  end if;

  if v_opening is null then
    raise exception 'That window or door is not on this job.' using errcode = 'P0002';
  end if;

  if v_opening.flag_kind is null then
    update issues
       set status = 'resolved', resolved_by = auth.uid(), resolved_at = now()
     where opening_id = p_opening_id and kind = 'flag' and status = 'open';
  elsif not exists (
    select 1 from issues
     where opening_id = p_opening_id and kind = 'flag' and status = 'open'
  ) then
    -- The NOTE is only ever what a person typed. It used to fall back to the
    -- reason code, so a flag raised with a reason and no note filed an issue
    -- whose note read `wrong_size` — a column value from this database printed
    -- to a foreman on a phone, which is the thing plain-English copy exists to
    -- stop. The reason is already on the opening; Blockers and the Issues page
    -- read it from there and say it in the reader's own language.
    insert into issues (project_id, opening_id, kind, urgency, note, created_by)
    values (v_opening.project_id, p_opening_id, 'flag', 'normal',
            v_clean, auth.uid());
  end if;

  return v_opening;
end;
$$;

-- The old two-argument form, rebuilt on top of the new one so there is exactly
-- one set of rules. Behaviour is unchanged: a note flags, an empty note clears.
create or replace function flag_opening(p_opening_id uuid, p_note text)
returns project_openings
language plpgsql
set search_path = public
as $$
begin
  return flag_opening(p_opening_id, p_note, null);
end;
$$;

-- Clearing is the foreman saying "the record is right again", which is why it
-- is the one half of this that carries a rank. An installer raises the flag;
-- somebody who can go and check takes it down. The named door for it, so the
-- app has something to call and something to hide behind a role — the rule
-- itself is enforced in flag_opening's clear branch, which every path reaches.
create or replace function clear_opening_flag(p_opening_id uuid)
returns project_openings
language plpgsql
set search_path = public
as $$
declare v_opening project_openings;
begin
  if not public.is_foreman_plus(auth.uid()) then
    raise exception 'Only a foreman or above can clear a data-off flag.'
      using errcode = '42501';
  end if;
  return flag_opening(p_opening_id, null, null);
end;
$$;

revoke all on function flag_opening(uuid, text, text) from public, anon;
revoke all on function clear_opening_flag(uuid) from public, anon;
grant execute on function flag_opening(uuid, text, text) to authenticated, service_role;
grant execute on function clear_opening_flag(uuid) to authenticated, service_role;

-- And the same rule at the table, because the RPCs are not the only door.
-- `openings_update_live` (20260730210000) is `for update to authenticated
-- using (removed_at is null) with check (true)`, so a plain PATCH of
-- flag_kind/flag_note goes straight past every function above. Scoped exactly
-- like guard_opening_pin_move (20260730160000): an update that leaves the flag
-- columns alone — every claim, start, finish, measurement, condition check and
-- assignment — never reaches the body.
--
-- RAISING a flag stays anyone's right, which is the whole point of the feature.
-- Only taking one DOWN carries the rank, so this needs no escape hatch for the
-- RPCs: flag_opening's own clear branch is foreman+ now, and the trigger simply
-- agrees with it.
create or replace function public.guard_opening_flag_clear()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.flag_kind is not distinct from old.flag_kind
     and new.flag_note is not distinct from old.flag_note then
    return new;
  end if;

  -- No JWT is a migration or an edge function on the service key, both already
  -- trusted above RLS.
  if auth.uid() is null then
    return new;
  end if;

  -- Still flagged after this write: raising or re-wording one is anyone's.
  if new.flag_kind is not null or new.flag_note is not null then
    return new;
  end if;

  if (old.flag_kind is not null or old.flag_note is not null)
     and not public.is_foreman_plus(auth.uid()) then
    raise exception 'Only a foreman or above can clear a data-off flag.'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists guard_opening_flag_clear on project_openings;
create trigger guard_opening_flag_clear
  before update of flag_kind, flag_note on project_openings
  for each row execute function public.guard_opening_flag_clear();

comment on function public.guard_opening_flag_clear() is
  'Refuses taking a data-off flag down from anyone below foreman, whichever door they came through. Raising one is unrestricted.';

-- ---------------------------------------------------------------------------
-- 3. Adding a unit nobody drew
-- ---------------------------------------------------------------------------
--
-- guard_opening_create_delete (20260730180000) refuses an INSERT from anyone
-- below foreman, and it is right to: re-reading a planset must stay a lead's
-- action. Adding ONE window you are standing in front of is a different act
-- with a different check — an open shift on that job — so it gets the same
-- session-flag escape hatch the removal guard already uses.

create or replace function public.guard_opening_create_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row project_openings;
begin
  v_row := case when tg_op = 'DELETE' then old else new end;

  -- No JWT means this is not a person holding a phone: a migration, or an edge
  -- function on the service key. Both are already trusted above RLS.
  if auth.uid() is null then
    return v_row;
  end if;

  -- add_field_unit, which has already proved the caller is clocked in on this
  -- job. Wave E: presence is the permission for one missed window, and only
  -- for the insert that function makes inside its own transaction.
  if tg_op = 'INSERT'
     and coalesce(current_setting('app.field_unit_add', true), '') = 'on' then
    return v_row;
  end if;

  if not public.is_foreman_plus(auth.uid()) then
    if tg_op = 'DELETE' then
      raise exception 'Only a foreman or above can remove a window or door from a job.'
        using errcode = '42501';
    else
      raise exception 'Only a foreman or above can add windows or doors to a job.'
        using errcode = '42501';
    end if;
  end if;

  return v_row;
end;
$$;

create or replace function add_field_unit(
  p_project_id uuid,
  p_kind text,
  p_width_in numeric,
  p_height_in numeric,
  p_photo_path text,
  p_pin_x numeric,
  p_pin_y numeric,
  p_note text,
  -- Not in the wave's written signature, and needed: a pin is only meaningful
  -- against the sheet it was tapped on, and a job's map has pages. Trailing
  -- and defaulted so the eight-argument call in the spec still works.
  p_page_number int default null
)
returns project_openings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row project_openings;
  v_next int;
  v_code text;
  v_style text;
  v_name text;
begin
  if p_kind not in ('window', 'door') then
    raise exception 'Say whether this is a window or a door.' using errcode = '22023';
  end if;

  -- PRESENCE, NOT RANK (wave E): whoever is on the clock on this job can
  -- record a window nobody drew. Anything less and the person looking at the
  -- hole has to phone someone to write it down, which is how it goes unwritten.
  if not exists (
    select 1 from time_shifts
     where profile_id = auth.uid()
       and project_id = p_project_id
       and status = 'open'
       and clock_out_at is null
  ) then
    raise exception 'Clock in on this job before you add a missed window or door.'
      using errcode = '42501';
  end if;

  -- "Missed 1", "Missed 2", … per job. Read off field_unit_seq and not off the
  -- CODE, because the code is renameable and the number must not be: a job
  -- where "Missed 1" has been renamed to "W-14", or removed, must still call
  -- the next one "Missed 2". Every row on the job counts, hidden ones included.
  --
  -- The advisory lock is per project and lasts the transaction: two people
  -- standing in the same house adding a unit in the same second would otherwise
  -- both read the same max and one of them would meet a raw duplicate-key error
  -- from project_openings_live_code_key instead of getting their window
  -- recorded.
  perform pg_advisory_xact_lock(hashtext('field_unit:' || p_project_id::text));
  select coalesce(max(field_unit_seq), 0) + 1
    into v_next
    from project_openings
   where project_id = p_project_id;
  v_code := 'Missed ' || v_next;

  v_style := case when p_kind = 'door'
                  then 'Missed door — field added'
                  else 'Missed window — field added' end;

  perform set_config('app.field_unit_add', 'on', true);
  insert into project_openings (
    project_id, opening_code, label, page_number, pin_x, pin_y,
    status, confirmed, flag_kind, flag_note, flagged_by, flagged_at,
    field_added, field_unit_seq
  ) values (
    p_project_id, v_code, v_style, coalesce(p_page_number, 1),
    p_pin_x, p_pin_y,
    'planned', true, 'not_on_plans',
    nullif(trim(coalesce(p_note, '')), ''), auth.uid(), now(), true, v_next
  )
  returning * into v_row;
  perform set_config('app.field_unit_add', 'off', true);

  -- The spec row is what makes it a real unit everywhere else: the sheet, the
  -- schedule list and the 3D map all read specs by mark code.
  insert into project_mark_specs (
    project_id, mark_code, style, width_in, height_in, source, confirmed
  ) values (
    p_project_id, v_code, v_style, p_width_in, p_height_in, 'field', false
  )
  -- AUTHORITATIVE FOR A FIELD ROW. `do nothing` meant a leftover spec under
  -- this code silently became the new unit's size — a second missed unit
  -- showing the first one's width and height, which is what a purchase order
  -- gets cut from. The numbering above should make a collision impossible now;
  -- if one happens anyway, the measurements somebody just took on site win. A
  -- row that is not ours, or that a foreman has confirmed, is never touched.
  on conflict (project_id, mark_code) do update
     set style = excluded.style,
         width_in = excluded.width_in,
         height_in = excluded.height_in,
         source = 'field',
         updated_at = now()
   where project_mark_specs.source = 'field'
     and coalesce(project_mark_specs.confirmed, false) = false;

  if nullif(trim(coalesce(p_photo_path, '')), '') is not null then
    insert into attachments (project_id, project_opening_id, kind, storage_path, created_by)
    select p_project_id, v_row.id, 'photo', p_photo_path,
           (select display_name from profiles where id = auth.uid());
  end if;

  -- It lands on the Issues board like every other field problem, so it is
  -- chased rather than admired.
  select display_name into v_name from profiles where id = auth.uid();
  insert into issues (project_id, opening_id, kind, urgency, note, created_by)
  values (
    p_project_id, v_row.id, 'flag', 'normal',
    coalesce(nullif(trim(coalesce(p_note, '')), ''),
             v_style) || ' (added by ' || coalesce(v_name, 'the crew') || ')',
    auth.uid()
  );

  return v_row;
end;
$$;

revoke all on function add_field_unit(uuid, text, numeric, numeric, text, numeric, numeric, text, int) from public, anon;
grant execute on function add_field_unit(uuid, text, numeric, numeric, text, numeric, numeric, text, int) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. What a supervisor does with one
-- ---------------------------------------------------------------------------
-- Keep (rename allowed), Merge into an existing mark, Remove. Merge and Remove
-- are only offered while the unit carries no work — once somebody has clocked
-- time or filed an install on it, the row is evidence and the answer is Keep.

-- SPECS ARE KEYED BY MARK BASE, NOT BY OPENING CODE. `specForOpeningCode`
-- (app/src/lib/install/specs.ts) looks a unit's spec up as
-- markBase(opening_code).toUpperCase(), and markBase strips the instance
-- suffix: "1-3" is an instance of mark "1", while "Add-1" and "W-14" are marks
-- in their own right because a run of LETTERS before the dash is the mark's own
-- identity (the Mad Moose incident, 2026-09-01 — see markBase's comment).
--
-- Renaming a missed unit has to move its spec to the key the app will actually
-- read it back by, so this mirrors markBase exactly, case for case. Both sides
-- of every comparison below are upper()ed, which is what indexSpecsByMark does
-- too, so stored casing never decides whether a spec is found.
create or replace function public.mark_base(p_code text)
returns text
language sql
immutable
set search_path = public
as $$
  select case
    -- Letters-then-dash-then-digits is one whole mark, title-cased so the same
    -- mark always writes the same literal into project_mark_specs.mark_code.
    when v.trimmed ~ '^[A-Za-z]+-[0-9]+$'
      then upper(left(split_part(v.trimmed, '-', 1), 1))
           || lower(substr(split_part(v.trimmed, '-', 1), 2))
           || '-' || split_part(v.trimmed, '-', 2)
    -- Otherwise a trailing "-<digits>" is the instance number. Falling back to
    -- the whole code when stripping leaves nothing matches the TS `|| n`.
    else coalesce(
      nullif(regexp_replace(upper(v.trimmed), '-[0-9]+$', ''), ''),
      upper(v.trimmed)
    )
  end
  from (
    -- trim(), then strip a leading '#', and nothing else — exactly what the TS
    -- does, so the two never disagree on an odd code.
    select regexp_replace(btrim(coalesce(p_code, '')), '^#', '') as trimmed
  ) v;
$$;

comment on function public.mark_base(text) is
  'Mark code behind an opening code (1-3 -> 1, Add-1 -> Add-1). Mirrors markBase in app/src/lib/install/extract.ts; change them together.';

revoke all on function public.mark_base(text) from public, anon;
grant execute on function public.mark_base(text) to authenticated, service_role;

create or replace function public.field_unit_has_work(p_opening_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from unit_sessions where opening_id = p_opening_id)
      or exists (select 1 from install_events
                  where project_opening_id = p_opening_id and voided_at is null);
$$;

create or replace function rename_field_unit(p_opening_id uuid, p_code text)
returns project_openings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row project_openings;
  v_old text;
  v_spec_id uuid;
  v_new_mark text;
  v_code text := nullif(trim(coalesce(p_code, '')), '');
begin
  if public.my_role_rank() < 2 then
    raise exception 'Only a supervisor or above can rename a missed window or door.'
      using errcode = '42501';
  end if;
  if v_code is null then
    raise exception 'Give the window or door a name before saving it.' using errcode = '22023';
  end if;

  select * into v_row from project_openings where id = p_opening_id;
  if not found or not v_row.field_added then
    raise exception 'That is not a missed window or door added from the field.'
      using errcode = 'P0002';
  end if;
  v_old := v_row.opening_code;
  if exists (
    select 1 from project_openings
     where project_id = v_row.project_id and opening_code = v_code
       and removed_at is null and id <> p_opening_id
  ) then
    raise exception 'There is already a % on this job. Pick a different name.', v_code
      using errcode = '23505';
  end if;

  update project_openings set opening_code = v_code
   where id = p_opening_id
   returning * into v_row;

  -- The spec row carries the size somebody measured, so it has to end up under
  -- the key the sheet will read it back by — mark_base of the new name, not the
  -- new name. Rename to "1-3" and the sheet looks up mark "1"; a spec left at
  -- "1-3" is a row nothing ever reads, and the measurement is gone from the
  -- screen that orders the glass.
  --
  -- It is found BY ID and only when it is ours (source 'field'), so a rename
  -- can never pick up and move a spec the planset put there.
  v_new_mark := public.mark_base(v_code);
  select id into v_spec_id
    from project_mark_specs
   where project_id = v_row.project_id
     and upper(mark_code) = upper(public.mark_base(v_old))
     and source = 'field'
   limit 1;

  if v_spec_id is not null then
    if exists (
      select 1 from project_mark_specs
       where project_id = v_row.project_id
         and upper(mark_code) = upper(v_new_mark)
         and id <> v_spec_id
    ) then
      -- The paperwork caught up and that row is the better one. DELETE rather
      -- than leave ours behind: an orphan sitting at the freed "Missed N" code
      -- is what the next missed unit on this job would silently inherit its
      -- width and height from.
      delete from project_mark_specs where id = v_spec_id;
    else
      update project_mark_specs
         set mark_code = v_new_mark, updated_at = now()
       where id = v_spec_id;
    end if;
  end if;
  return v_row;
end;
$$;

create or replace function merge_field_unit(p_opening_id uuid, p_into_code text)
returns project_openings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row project_openings;
  v_target project_openings;
  v_code text := nullif(trim(coalesce(p_into_code, '')), '');
begin
  if public.my_role_rank() < 2 then
    raise exception 'Only a supervisor or above can merge a missed window or door.'
      using errcode = '42501';
  end if;

  select * into v_row from project_openings where id = p_opening_id;
  if not found or not v_row.field_added then
    raise exception 'That is not a missed window or door added from the field.'
      using errcode = 'P0002';
  end if;
  if public.field_unit_has_work(p_opening_id) then
    raise exception 'Somebody has already worked this one, so it cannot be merged away. Keep it and rename it instead.'
      using errcode = '42501';
  end if;

  -- A missed unit that has been renamed answers to a real code of its own, so
  -- "merge into <that code>" would otherwise find ITSELF: attachments repointed
  -- to the same row, a job note reading "W-14 turned out to be W-14", and then
  -- the row and its spec deleted. The list on the sheet never offers it; the
  -- refusal belongs in SQL like every other refusal in this file, because the
  -- RPC is granted to every signed-in account.
  if v_code = v_row.opening_code then
    raise exception 'That is the name this one already has — rename it instead.'
      using errcode = '22023';
  end if;

  select * into v_target from project_openings
   where project_id = v_row.project_id and opening_code = v_code
     and removed_at is null and id <> p_opening_id
   limit 1;
  if not found then
    raise exception 'There is no % on this job to merge it into.', v_code using errcode = 'P0002';
  end if;

  -- The photo is the evidence, so it follows the unit it was really about.
  update attachments set project_opening_id = v_target.id
   where project_opening_id = p_opening_id;

  update issues
     set status = 'resolved', resolved_by = auth.uid(), resolved_at = now()
   where opening_id = p_opening_id and status = 'open';

  insert into job_notes (project_id, author_id, author_name, note)
  select v_row.project_id, auth.uid(),
         (select display_name from profiles where id = auth.uid()),
         v_row.opening_code || ' turned out to be ' || v_target.opening_code || ' — merged.';

  -- ONLY THE ROW THIS FEATURE CREATED. A merge used to delete any spec whose
  -- mark_code matched the unit's current code — and after a rename that code is
  -- a REAL mark, whose spec is the manufacturer's: style, glass, size code,
  -- u-factor, the drawing coordinates, possibly confirmed by a foreman, and
  -- read by every other opening of that mark. project_mark_specs has no soft
  -- delete, so it would simply be gone. Three fences: it must be ours
  -- (source 'field'), nobody may have confirmed it, and no other live opening
  -- may still resolve to that mark.
  delete from project_mark_specs s
   where s.project_id = v_row.project_id
     and upper(s.mark_code) = upper(public.mark_base(v_row.opening_code))
     and s.source = 'field'
     and coalesce(s.confirmed, false) = false
     and not exists (
       select 1 from project_openings o
        where o.project_id = v_row.project_id
          and o.id <> p_opening_id
          and o.removed_at is null
          and upper(public.mark_base(o.opening_code))
              = upper(public.mark_base(v_row.opening_code))
     );
  delete from project_openings where id = p_opening_id;

  return v_target;
end;
$$;

create or replace function remove_field_unit(p_opening_id uuid, p_reason text default null)
returns project_openings
language plpgsql
security definer
set search_path = public
as $$
declare v_row project_openings;
begin
  if public.my_role_rank() < 2 then
    raise exception 'Only a supervisor or above can take a missed window or door back off.'
      using errcode = '42501';
  end if;

  select * into v_row from project_openings where id = p_opening_id;
  if not found or not v_row.field_added then
    raise exception 'That is not a missed window or door added from the field.'
      using errcode = 'P0002';
  end if;
  if public.field_unit_has_work(p_opening_id) then
    raise exception 'Somebody has already worked this one, so it stays on the job. Keep it and rename it instead.'
      using errcode = '42501';
  end if;

  -- The ordinary soft delete: hidden, never destroyed, and restorable from the
  -- removed list like any other window a foreman takes off.
  return public.remove_opening(p_opening_id, coalesce(p_reason, 'Missed unit withdrawn'));
end;
$$;

revoke all on function public.field_unit_has_work(uuid) from public, anon;
revoke all on function rename_field_unit(uuid, text) from public, anon;
revoke all on function merge_field_unit(uuid, text) from public, anon;
revoke all on function remove_field_unit(uuid, text) from public, anon;
grant execute on function public.field_unit_has_work(uuid) to authenticated, service_role;
grant execute on function rename_field_unit(uuid, text) to authenticated, service_role;
grant execute on function merge_field_unit(uuid, text) to authenticated, service_role;
grant execute on function remove_field_unit(uuid, text) to authenticated, service_role;

-- The test-login cage covers every project-scoped table; re-arming is
-- idempotent and costs nothing, and this migration touches two of them.
select public.attach_sandbox_guards();


-- 20260978000000_money_doors.sql (mirrored)
-- Wave Z — Money doors (transcripts program, grill of 2026-09-03).
--
-- THE GAP THIS CLOSES, found by reading the live policies rather than the UI:
-- `job_costs` and `change_orders` were `using (not is_partner_user() and
-- (true))` (20260950000000_partner_wall.sql), `projects.bid_amount` /
-- `target_margin_pct` rode the ordinary projects select policy, and
-- `receipts_select` opened at `my_role_rank() >= 1`. Every one of those is
-- readable by ANY crew login — an installer's phone could read the company's
-- bids, its margins and every receipt, while the Cost screen politely said
-- "Owner only". The nav floor was the whole lock, and a nav floor is not a
-- lock: it is a hidden button. This migration makes the database say no.
--
-- The shape of the answer (Q3/Q4/Q16, owner-approved): money is not a rank, it
-- is a GRANT. An owner can hand one supervisor the cost books without making
-- them an owner, and can hand one person pay rates without handing them costs.
-- Two booleans on `profiles`, written only by an owner-only RPC, read back by
-- two SQL helpers every money policy calls.
--
-- Order of business below:
--   1. Z1  the two grants, their helpers, and set_profile_grants
--   2. Z2  the locks: job_costs, change_orders, project_financials, receipts,
--          the AI spend meters
--   3. Z3  pay_rates and set_pay_rate
--   4. Z4  receipts.cost_code_id, job_costs.billable, and the one bridge that
--          turns a reviewed receipt into a job cost line
--   5. Z5  bank_imports / bank_transactions and their RPCs
--
-- Idempotent throughout (create ... if not exists / create or replace /
-- on conflict / drop policy if exists before create policy), so re-running it
-- changes nothing.


-- ===========================================================================
-- 1. Z1 — two grants: Sees costs, Sees pay rates
-- ===========================================================================
-- On `profiles` rather than a table of their own because they are facts about
-- a PERSON, read on every money policy evaluation — a join per policy check
-- would be a cost paid on every row of every cost query, for two booleans.
--
-- NOT NULL DEFAULT false: a policy must never have to reason about a null, and
-- "we do not know whether this person may see costs" has exactly one safe
-- reading. A brand-new account sees nothing until an owner says otherwise.
alter table public.profiles
  add column if not exists can_see_costs boolean not null default false,
  add column if not exists can_see_pay boolean not null default false;

comment on column public.profiles.can_see_costs is
  'Owner-granted: this person may read the money tables (job_costs, change_orders, project_financials, receipts, the AI spend meters) without being an owner. Written only by set_profile_grants(); the authenticated role holds SELECT but never UPDATE, the same way role, pin_hash and language are guarded (Wave Z, Z1).';
comment on column public.profiles.can_see_pay is
  'Owner-granted: this person may read pay_rates. Separate from can_see_costs on purpose — an office manager who books job costs has no business reading what the crew earns (Wave Z, Z1/Z3).';

-- Section 2 of 20260729200000_profiles_rls_lockdown.sql replaced this table's
-- blanket grants with explicit per-column lists, so a new column is unreadable
-- AND unwritable until it is named. Add both to the readable list only — the
-- Roster has to draw the checkboxes, and canAccess() has to know the grant
-- before it opens /costing.
grant select (can_see_costs, can_see_pay) on table public.profiles to authenticated;

-- A no-op today (the column is not in any grant list, so there is nothing to
-- take away), written out loud for the same reason 20260968000000 writes its
-- own: it states the intent, and it survives a future table-level re-grant.
-- set_profile_grants runs security definer, so the revoke does not touch it.
revoke insert (can_see_costs, can_see_pay), update (can_see_costs, can_see_pay)
  on table public.profiles from anon, authenticated;


-- --- the two helpers every money policy calls ------------------------------
-- SECURITY DEFINER for the same two reasons is_partner_user() gives: it reads
-- `profiles` from inside policies on other tables (and could one day be asked
-- from a policy on profiles itself) without tripping RLS recursion, and it can
-- read a column the calling role holds no privilege on — which matters here,
-- because if a future migration ever takes SELECT (can_see_costs) away from
-- `authenticated`, every policy that calls this keeps working.
--
-- STABLE, not VOLATILE: the planner is then free to evaluate it once per query
-- rather than once per row, which is the difference between a cheap policy and
-- a per-row profiles lookup on a thousand-row cost ledger.
--
-- Owner OR the flag. An owner is never granted anything explicitly — an owner
-- already sees the whole company, and a rule that made owners depend on a row
-- would be one bad UPDATE away from locking the owner out of their own books.
create or replace function public.can_see_costs(p_uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select public.role_rank(p.role) >= 3 or p.can_see_costs
       from public.profiles p
      where p.id = p_uid),
    false);
$$;

comment on function public.can_see_costs(uuid) is
  'True when this person may read the company''s money: an owner, or somebody an owner granted "Sees costs" (profiles.can_see_costs). The single predicate every money policy calls, so widening or narrowing who sees costs is one function, not fifteen policies (Wave Z, Z1).';

create or replace function public.can_see_pay(p_uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select public.role_rank(p.role) >= 3 or p.can_see_pay
       from public.profiles p
      where p.id = p_uid),
    false);
$$;

comment on function public.can_see_pay(uuid) is
  'True when this person may read pay rates: an owner, or somebody an owner granted "Sees pay rates" (profiles.can_see_pay). Deliberately NOT satisfied by reading your own rate — see pay_rates'' policy for why (Wave Z, Z1/Z3).';

revoke all on function public.can_see_costs(uuid) from public, anon;
revoke all on function public.can_see_pay(uuid) from public, anon;
grant execute on function public.can_see_costs(uuid) to authenticated, service_role;
grant execute on function public.can_see_pay(uuid) to authenticated, service_role;


-- --- the one writer --------------------------------------------------------
-- Owner-only, the same floor 20260939000000_owners_manage_owners.sql set for
-- "only owners manage owners" — handing somebody the cost books is the same
-- size of decision as making somebody an owner, so it gets the same door.
--
-- Returns a NARROW row, never `returns profiles`: the composite type of that
-- table includes pin_hash, and a function returning it would hand a credential
-- column back through PostgREST to anyone allowed to call it. The caller gets
-- back exactly what it set.
create or replace function public.set_profile_grants(
  p_profile_id uuid,
  p_costs boolean,
  p_pay boolean
)
-- The OUT columns are `sees_costs` / `sees_pay`, NOT the column names: a
-- `returns table` column in PL/pgSQL is a variable, and one spelled exactly
-- like a column of the table being updated is the classic ambiguous-reference
-- trap. Different words, no ambiguity to reason about.
returns table (profile_id uuid, sees_costs boolean, sees_pay boolean)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_is_partner boolean;
begin
  if public.my_role_rank() < 3 then
    raise exception 'Only an owner can change who sees costs.'
      using errcode = '42501';
  end if;

  select p.is_partner into v_is_partner from public.profiles p where p.id = p_profile_id;
  if not found then
    raise exception 'That person is not on the crew list.';
  end if;
  -- THE WALL (20260950000000) already ANDs `not is_partner_user()` into every
  -- money policy, so a granted partner would read nothing anyway. Refusing here
  -- as well means nobody ever has to work that out from two files: a builder's
  -- login cannot be handed the company's books, full stop.
  if coalesce(v_is_partner, false) then
    raise exception 'A builder login can never be given the company''s costs.'
      using errcode = '42501';
  end if;

  return query
  update public.profiles p
     set can_see_costs = coalesce(p_costs, p.can_see_costs),
         can_see_pay   = coalesce(p_pay, p.can_see_pay),
         updated_at    = now()
   where p.id = p_profile_id
  returning p.id, p.can_see_costs, p.can_see_pay;
end;
$$;

comment on function public.set_profile_grants(uuid, boolean, boolean) is
  'Owner-only: hand somebody (or take back) "Sees costs" and "Sees pay rates". Null leaves that grant alone, so the Roster''s two checkboxes can be flipped one at a time. Returns only the two flags — never the profiles row, which carries pin_hash.';

revoke all on function public.set_profile_grants(uuid, boolean, boolean) from public, anon;
grant execute on function public.set_profile_grants(uuid, boolean, boolean) to authenticated;


-- ===========================================================================
-- 2. Z2 — lock the money tables
-- ===========================================================================
-- Do this even if nothing else in wave Z ships. Everything below is a policy
-- that was open to every crew login until now.
--
-- Every policy keeps its EXISTING NAME. scripts/partner_wall_lib.py replays
-- `create policy` / `drop policy` across the migrations to recover the live
-- policy set; a renamed policy would leave the old name standing in that replay
-- as a second, wide-open policy that no longer exists. Same name, new predicate.

-- ---- job_costs / change_orders --------------------------------------------
-- The ledger and the change orders. `using (not is_partner_user() and (true))`
-- since 20260950000000 — the partner wall correctly kept a builder out and let
-- every installer in.
--
-- The predicate covers writes too (`for all`), which is deliberate: Costing's
-- "Add cost" and "Add change order" write these tables directly, and the person
-- allowed to type a cost line is exactly the person allowed to read them.
-- review_receipt's bridge (Z4) writes job_costs from a SECURITY DEFINER
-- function, so it is unaffected by the narrowing.
drop policy if exists "authenticated full access" on job_costs;
create policy "authenticated full access" on job_costs
  for all to authenticated
  using (not public.is_partner_user() and public.can_see_costs(auth.uid()))
  with check (not public.is_partner_user() and public.can_see_costs(auth.uid()));

drop policy if exists "authenticated full access" on change_orders;
create policy "authenticated full access" on change_orders
  for all to authenticated
  using (not public.is_partner_user() and public.can_see_costs(auth.uid()))
  with check (not public.is_partner_user() and public.can_see_costs(auth.uid()));


-- ---- project_financials: the bid moves off `projects` ----------------------
-- `projects.bid_amount` and `.target_margin_pct` (20260717002000) could not be
-- locked where they sat. A column has no policy of its own: it rides the
-- table's, and `projects` MUST stay readable — the app shell, the job list,
-- every screen with a job code on it reads that row, and a partner reads their
-- granted jobs through it. Column privileges do not help either, because RLS
-- and grants answer different questions: revoking SELECT (bid_amount) would
-- break the owner's own read through PostgREST as surely as an installer's.
--
-- So the money moves to a table that can carry its own policy. One row per job,
-- project_id as the primary key — a job has one bid, and a surrogate id would
-- invite two.
--
-- ON DELETE CASCADE, not the detach treatment `job_costs` and `receipts` get in
-- 20260959000000: a bid is not a money RECORD with retention weight, it is a
-- number about a job, and when the job is purged it goes with it — exactly what
-- happened when it was a column on `projects`. This migration changes where the
-- bid lives, not how long it lives.
create table if not exists project_financials (
  project_id uuid primary key references projects(id) on delete cascade,
  bid_amount numeric,
  target_margin_pct numeric,
  updated_at timestamptz not null default now(),
  -- `default auth.uid()` rather than a column the client fills: this is a
  -- direct table write from the Cost screen, and who last touched a bid is not
  -- something the browser should get to claim. Null under service_role or a
  -- SQL console, which is the honest answer there.
  updated_by uuid default auth.uid() references profiles(id) on delete set null
);

comment on table project_financials is
  'One job''s bid and target margin, moved off `projects` (20260717002000) so it can carry a policy of its own: `projects` has to stay readable by every crew login, and a column cannot be gated separately from its table. Readable and writable by an owner or anybody granted "Sees costs" (Wave Z, Z2).';

-- Backfill BEFORE the drop, and only while the old columns still exist, so a
-- re-run of this migration is a no-op rather than an error. `on conflict do
-- nothing` protects a row the Cost screen already wrote against being reset to
-- whatever the old column happened to hold.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'projects' and column_name = 'bid_amount'
  ) then
    execute $q$
      insert into project_financials (project_id, bid_amount, target_margin_pct)
      select id, bid_amount, target_margin_pct
        from projects
       where bid_amount is not null or target_margin_pct is not null
      on conflict (project_id) do nothing
    $q$;
  end if;
end;
$$;

alter table projects drop column if exists bid_amount;
alter table projects drop column if exists target_margin_pct;

-- THE PROJECTS GRANT LAW (wave D, 20260959000000): table-level INSERT/UPDATE on
-- `projects` is revoked and only the app-written columns are granted back.
-- Dropping a column drops its privilege with it, so the two lists are re-stated
-- here MINUS bid_amount / target_margin_pct — the law says the grant lists move
-- with the columns, and a reader of this file should not have to diff two
-- migrations to learn what is still writable.
revoke insert, update on table projects from anon, authenticated;
grant insert (job_code, name, address, customer_name, contact_phone,
              contact_email, site_state, unit_number, start_date, end_date,
              notes)
  on projects to authenticated;
grant update (name, address, customer_name, contact_phone, contact_email,
              site_state, unit_number, start_date, end_date, notes,
              estimated_minutes, estimated_crew, estimated_at)
  on projects to authenticated;

alter table project_financials enable row level security;

-- Revoke BEFORE granting: this project's default privileges hand every new
-- table in `public` the full set to `authenticated`, and RLS alone is not the
-- place to stand (20260729230000 / wave K's review). Here the policy IS meant
-- to allow writes — the Cost screen saves a bid directly, the same way it adds
-- a job cost line — so select/insert/update are granted back deliberately.
-- DELETE is not: nothing deletes a financials row except the job's own cascade.
revoke all on project_financials from anon, authenticated;
grant select, insert, update on project_financials to authenticated;
grant all on project_financials to service_role;

drop policy if exists "financials_cost_seers" on project_financials;
create policy "financials_cost_seers" on project_financials
  for all to authenticated
  using (not public.is_partner_user() and public.can_see_costs(auth.uid()))
  with check (not public.is_partner_user() and public.can_see_costs(auth.uid()));


-- ---- receipts: the foreman read goes ---------------------------------------
-- `my_role_rank() >= 1` (20260957000000) let every foreman read every receipt
-- the company has ever filed, while the office table itself is supervisor-only.
-- Supervisor+ keeps the office read, a cost-grant holder gains it (a bookkeeper
-- who is not a supervisor still has to reconcile the card statement), and an
-- uploader keeps seeing their OWN receipts — an installer who snapped a gas
-- receipt has to watch it land, and that has nothing to do with seeing the
-- company's spending.
drop policy if exists "receipts_select" on receipts;
create policy "receipts_select" on receipts
  for select to authenticated
  using (
    not public.is_partner_user()
    and (
      public.my_role_rank() >= 2
      or public.can_see_costs(auth.uid())
      or uploaded_by = auth.uid()
    )
  );


-- ---- the AI spend meters ---------------------------------------------------
-- `ai_role_rank(auth.uid()) >= 2` (20260729230000, swept by 20260950000000):
-- supervisor+. What these tables hold is money the company spent, so they move
-- to the same predicate as every other money table.
--
-- These five policies are DEFENCE IN DEPTH and nothing more. Nothing in the app
-- selects from these tables; the only read path is the SECURITY DEFINER RPC
-- below, which bypasses RLS entirely. Tightening the policies without
-- tightening the RPC would have locked the window and left the door open — the
-- first draft of this migration did exactly that, and its comment claimed the
-- opposite. The lock that counts is `ai_spend_overview()`.
drop policy if exists "ai_spend_alerts_select_office" on ai_spend_alerts;
create policy "ai_spend_alerts_select_office" on ai_spend_alerts
  for select to authenticated
  using (not public.is_partner_user() and public.can_see_costs(auth.uid()));

drop policy if exists "ai_spend_limits_select_office" on ai_spend_limits;
create policy "ai_spend_limits_select_office" on ai_spend_limits
  for select to authenticated
  using (not public.is_partner_user() and public.can_see_costs(auth.uid()));

drop policy if exists "ai_spend_months_select_office" on ai_spend_months;
create policy "ai_spend_months_select_office" on ai_spend_months
  for select to authenticated
  using (not public.is_partner_user() and public.can_see_costs(auth.uid()));

drop policy if exists "ai_usage_days_select_office" on ai_usage_days;
create policy "ai_usage_days_select_office" on ai_usage_days
  for select to authenticated
  using (not public.is_partner_user() and public.can_see_costs(auth.uid()));

drop policy if exists "ai_usage_events_select_office" on ai_usage_events;
create policy "ai_usage_events_select_office" on ai_usage_events
  for select to authenticated
  using (not public.is_partner_user() and public.can_see_costs(auth.uid()));

-- ---- and the door the app actually uses ------------------------------------
-- THE READ PATH. app/src/lib/aiSpend.ts calls exactly one thing —
-- `supabase.rpc("ai_spend_overview")` — and that function is SECURITY DEFINER,
-- so it runs as the table owner and the five policies above never fire for it.
-- Its gate was `ai_role_rank(auth.uid()) < 2`: supervisor+. A supervisor with
-- no cost grant could ask it for the month's spend, the cap, and every
-- person's cost by name.
--
-- Same body, same shape, same `can_edit` (still `v_rank >= 3`, so only an owner
-- may move the limits — ai_spend_set_limits enforces that itself and calls this
-- function to return the fresh picture, which keeps working because an owner
-- passes can_see_costs). Only the gate moves, onto the one predicate every
-- other money table in this migration answers to.
create or replace function public.ai_spend_overview()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cfg ai_spend_limits;
  v_month date;
  v_day date;
  v_rank integer := ai_role_rank(auth.uid());
begin
  if not public.can_see_costs(auth.uid()) then
    raise exception 'Only an owner, or somebody given "Sees costs", can see what the assistant costs.'
      using errcode = '42501';
  end if;

  select * into v_cfg from ai_spend_limits where id = 1;
  v_month := date_trunc('month', (now() at time zone coalesce(v_cfg.timezone, 'UTC')))::date;
  v_day := (now() at time zone coalesce(v_cfg.timezone, 'UTC'))::date;

  return jsonb_build_object(
    'can_edit', v_rank >= 3,
    'limits', jsonb_build_object(
      'per_user_daily_calls', v_cfg.per_user_daily_calls,
      'monthly_cap_cents', v_cfg.monthly_cap_cents,
      'content_multiplier', v_cfg.content_multiplier,
      'min_role', v_cfg.min_role,
      'alert_at_pct', v_cfg.alert_at_pct,
      'enforced', v_cfg.enforced,
      'timezone', v_cfg.timezone,
      'updated_at', v_cfg.updated_at
    ),
    'month', jsonb_build_object(
      'usage_month', v_month,
      'calls', coalesce((select calls from ai_spend_months where usage_month = v_month), 0),
      'spent_micros', coalesce((select spent_micros from ai_spend_months where usage_month = v_month), 0),
      'reserved_micros', coalesce((select reserved_micros from ai_spend_months where usage_month = v_month), 0),
      'cap_micros', v_cfg.monthly_cap_cents::bigint * 10000
    ),
    'people', coalesce((
      select jsonb_agg(row_to_json(t))
      from (
        select
          e.user_id,
          coalesce(p.display_name, 'Removed user') as display_name,
          coalesce(p.role, 'unknown') as role,
          count(*) filter (where e.outcome = 'allowed') as calls,
          coalesce(sum(e.cost_micros), 0) as cost_micros,
          count(*) filter (where e.outcome like 'denied%') as blocked,
          coalesce((
            select d.calls from ai_usage_days d
             where d.user_id = e.user_id and d.usage_day = v_day
          ), 0) as calls_today
        from ai_usage_events e
        left join profiles p on p.id = e.user_id
        where e.usage_month = v_month
        group by e.user_id, p.display_name, p.role
        order by coalesce(sum(e.cost_micros), 0) desc,
                 count(*) filter (where e.outcome = 'allowed') desc
        limit 25
      ) t
    ), '[]'::jsonb),
    'functions', coalesce((
      select jsonb_agg(row_to_json(f))
      from (
        select function_name,
               count(*) filter (where outcome = 'allowed') as calls,
               coalesce(sum(cost_micros), 0) as cost_micros
          from ai_usage_events
         where usage_month = v_month
         group by function_name
         order by coalesce(sum(cost_micros), 0) desc
      ) f
    ), '[]'::jsonb),
    'alerts', coalesce((
      select jsonb_agg(row_to_json(a))
      from (
        select level, reserved_micros, cap_micros, created_at
          from ai_spend_alerts
         where usage_month = v_month
         order by created_at desc
      ) a
    ), '[]'::jsonb)
  );
end;
$$;

comment on function public.ai_spend_overview() is
  'The AI spend picture. Wave Z moved its gate from supervisor+ to can_see_costs(auth.uid()) — owner, or somebody the owner granted "Sees costs" — because this SECURITY DEFINER function, not the tables, is what the app reads. can_edit stays owner-only.';

-- `create or replace` keeps the existing ACL, so these are a no-op today. Said
-- out loud anyway: a reader should be able to see what this function is
-- reachable by without opening 20260729230000.
revoke all on function public.ai_spend_overview() from public, anon;
grant execute on function public.ai_spend_overview() to authenticated, service_role;


-- ===========================================================================
-- 3. Z3 — real pay rates
-- ===========================================================================
-- Until now labor cost was hours × a hardcoded table of role rates in
-- app/src/lib/costing.ts (installer 35, foreman 50, …). Every margin the owner
-- has ever looked at was priced off four guesses. This is where the real
-- numbers live.
--
-- A HISTORY, not a column on profiles. A rate that changed in March must not
-- reprice January: a job costed last quarter has to keep costing what it cost,
-- or every historical margin silently moves the next time somebody gets a
-- raise. So a row per rate per start date, and the reader asks "what was in
-- force on the day of this shift".
--
-- NOT project-scoped (no project_id): a rate is about a person, not a job, so
-- it gets no sandbox guard — a test login has no business writing one anyway,
-- which set_pay_rate's owner check already settles.
create table if not exists pay_rates (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles(id) on delete cascade,
  -- Cents, like every other money figure the app stores (receipts.amount_cents,
  -- ai_spend_limits.monthly_cap_cents). Never a float: $32.335 is not a wage.
  hourly_cents integer not null check (hourly_cents >= 0),
  -- The day this rate STARTS. There is no end date on purpose — a rate runs
  -- until the next one begins, so ending one is writing the next, and there is
  -- no way to leave a gap or an overlap by getting two dates out of step.
  effective_from date not null default current_date,
  set_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  -- One rate per person per start date, so "the rate in force on a day" always
  -- has exactly one answer, and re-saving a typo overwrites rather than
  -- stacking a second row nobody can tell apart.
  unique (profile_id, effective_from)
);

create index if not exists pay_rates_profile_idx
  on pay_rates (profile_id, effective_from desc);

comment on table pay_rates is
  'What one person earns per hour, from a given day. A history, not a current value: a raise in March must never reprice January''s margins. Readable only by an owner or somebody granted "Sees pay rates"; written only by set_pay_rate (Wave Z, Z3).';

alter table pay_rates enable row level security;

-- Revoke first (Supabase's default privileges hand `authenticated` the full set
-- on every new public table), then grant back SELECT alone. Unlike
-- project_financials there is no write policy here at all: set_pay_rate,
-- SECURITY DEFINER, is the only writer, so there is no direct path that could
-- skip the owner check.
revoke all on pay_rates from anon, authenticated;
grant select on pay_rates to authenticated;
grant all on pay_rates to service_role;

-- No self arm. "You may read your own rate" sounds kind and is a leak: a
-- person's own rate is on their paycheck already, and the moment the policy
-- says `profile_id = auth.uid()` the table starts answering questions from
-- every phone in the company, one row at a time. Payroll tells people what
-- they earn; this table exists so the owner can cost a job.
drop policy if exists "pay_rates_select" on pay_rates;
create policy "pay_rates_select" on pay_rates
  for select to authenticated
  using (not public.is_partner_user() and public.can_see_pay(auth.uid()));

create or replace function public.set_pay_rate(
  p_profile_id uuid,
  p_hourly_cents integer,
  p_effective_from date default current_date
)
returns pay_rates
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row pay_rates;
begin
  if public.my_role_rank() < 3 then
    raise exception 'Only an owner can set what somebody is paid.'
      using errcode = '42501';
  end if;
  if p_hourly_cents is null or p_hourly_cents < 0 then
    raise exception 'An hourly rate has to be a number, and not a negative one.';
  end if;
  if not exists (select 1 from profiles where id = p_profile_id) then
    raise exception 'That person is not on the crew list.';
  end if;

  insert into pay_rates (profile_id, hourly_cents, effective_from, set_by)
  values (p_profile_id, p_hourly_cents, coalesce(p_effective_from, current_date), auth.uid())
  on conflict (profile_id, effective_from) do update
    set hourly_cents = excluded.hourly_cents,
        set_by = excluded.set_by,
        created_at = now()
  returning * into v_row;

  return v_row;
end;
$$;

comment on function public.set_pay_rate(uuid, integer, date) is
  'Owner-only: set what somebody earns per hour from a given day. Re-saving the same start date corrects that rate rather than stacking a second row, so a typo is fixable without a delete door.';

revoke all on function public.set_pay_rate(uuid, integer, date) from public, anon;
grant execute on function public.set_pay_rate(uuid, integer, date) to authenticated;


-- ===========================================================================
-- 4. Z4 — a reviewed receipt becomes a job cost, exactly once
-- ===========================================================================
-- Nothing has ever written `receipts` into `job_costs`. A crew member snaps a
-- receipt, a supervisor reviews it, and the money never reaches the job it was
-- spent on — the office retyped it, or nobody did. This is the bridge.
--
-- The whole rule, in one sentence: ONE receipt makes AT MOST ONE job cost line,
-- ever. `receipts.job_cost_id` is what enforces it — set once, never cleared —
-- so un-reviewing does not delete the line, re-reviewing does not post a second
-- one, and the receipt reads "posted" from then on.

-- Which kind of purchase this was, from the same cost-code library the clock
-- uses. Nullable: a receipt filed in a hurry with no code is still a receipt,
-- and the office can set it later.
alter table receipts
  add column if not exists cost_code_id uuid references cost_codes(id) on delete set null;

-- The line this receipt became. ON DELETE SET NULL rather than cascade: if a
-- cost line is ever removed, the receipt itself must survive — it is a photo of
-- a real purchase, and 20260959000000 already treats receipts as a record with
-- retention weight.
alter table receipts
  add column if not exists job_cost_id uuid references job_costs(id) on delete set null;

-- The other half of "one receipt, one line, ever", said in the schema rather
-- than only in the function. `_post_receipt_job_cost` takes a row lock so two
-- concurrent posts cannot both insert; this makes a duplicate impossible even
-- if some future caller forgets the lock. Partial, because "not posted yet" is
-- the normal state and every unposted receipt would otherwise collide on null.
create unique index if not exists receipts_one_job_cost
  on receipts (job_cost_id) where job_cost_id is not null;

-- "Bill this to the customer?" travels with the money. Nullable on purpose,
-- exactly like receipts.is_passthrough: null means nobody has answered yet, and
-- printing "not billable" over an unanswered question would be a claim the app
-- has no right to make.
alter table job_costs
  add column if not exists billable boolean;

comment on column receipts.job_cost_id is
  'The job_costs line this receipt became, stamped by review_receipt. Set once and never cleared — it is what makes "one receipt, at most one cost line, ever" true across un-reviewing, re-reviewing, and a later bank match (Wave Z, Z4).';
comment on column job_costs.billable is
  'Passed through to the customer? Copied from the receipt''s is_passthrough and kept in step with it. Null means nobody has answered yet.';

create index if not exists receipts_cost_code_idx on receipts (cost_code_id);

-- ---- set_receipt_cost_code ------------------------------------------------
-- A narrow writer rather than a tenth argument on update_receipt. That
-- function's full-record contract exists so a field edit cannot race the
-- fill-missing-only extraction — a real hazard for amount/vendor/date, which a
-- machine also writes. Nothing but a human ever writes a cost code, so it needs
-- no such protection, and adding an argument would mean DROPPING and recreating
-- update_receipt (a new argument list is a different function to Postgres, so
-- `create or replace` would leave an ambiguous overload behind) and would let
-- any phone still running yesterday's bundle blank the code on its next save.
create or replace function public.set_receipt_cost_code(
  p_id uuid,
  p_cost_code_id uuid
)
returns receipts
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_uploader uuid;
  v_row receipts;
begin
  select uploaded_by into v_uploader from receipts where id = p_id;
  if v_uploader is null then
    raise exception 'no such receipt';
  end if;
  -- The same floor update_receipt uses: the person who filed it, or the office.
  if not (v_uid = v_uploader or public.my_role_rank() >= 2) then
    raise exception 'only the uploader or a supervisor can change this receipt'
      using errcode = '42501';
  end if;
  if p_cost_code_id is not null
     and not exists (select 1 from cost_codes where id = p_cost_code_id) then
    raise exception 'that is not a cost code we have';
  end if;

  update receipts set cost_code_id = p_cost_code_id
   where id = p_id
  returning * into v_row;

  return v_row;
end;
$$;

comment on function public.set_receipt_cost_code(uuid, uuid) is
  'Uploader-or-supervisor: which kind of purchase this receipt was. A narrow writer on purpose — see the function body for why it is not a tenth argument on update_receipt.';

revoke all on function public.set_receipt_cost_code(uuid, uuid) from public, anon;
grant execute on function public.set_receipt_cost_code(uuid, uuid) to authenticated;


-- ---- the bridge itself ----------------------------------------------------
-- Internal: called by review_receipt, and by match_bank_transaction in Z5.
-- Never granted to any client role — a definer function calling it runs as the
-- table owner, which is the only caller it should ever have.
--
-- Refuses to post silently when it cannot: no job means the money is not on a
-- job, and no amount means there is nothing to post. Both return null and leave
-- the receipt exactly as it was.
create or replace function public._post_receipt_job_cost(p_receipt_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r receipts;
  v_label text;
  v_cost_id uuid;
begin
  -- FOR UPDATE, and it is the whole reason "one receipt, one line, ever" is a
  -- rule rather than a hope. Without it this is a read-then-write: review_receipt
  -- and match_bank_transaction can run against the same receipt at the same
  -- moment, both see job_cost_id null in their own READ COMMITTED snapshot, both
  -- insert a ledger line, and the second `update receipts` overwrites the first
  -- one's stamp — leaving an orphaned duplicate the job is billed for twice. The
  -- lock makes the second caller wait, re-read the committed stamp, and return
  -- the line that already exists. A disabled button in the client is not a lock.
  select * into r from receipts where id = p_receipt_id for update;
  if not found then return null; end if;
  -- Already posted. THE rule of this section: one receipt, one line, ever.
  if r.job_cost_id is not null then return r.job_cost_id; end if;
  if r.project_id is null then return null; end if;
  if r.amount_cents is null then return null; end if;

  -- The vendor is what a person reading the ledger recognises; the note is what
  -- they wrote to explain it. Both, when both exist.
  v_label := coalesce(nullif(btrim(r.vendor), ''), 'Receipt');
  if nullif(btrim(coalesce(r.note, '')), '') is not null then
    v_label := v_label || ' — ' || btrim(r.note);
  end if;

  insert into job_costs (project_id, category, label, amount, cost_date, billable, created_by)
  values (
    r.project_id,
    -- Every receipt posts as `materials`. Gas is the other category a receipt
    -- carries, and gas on a job IS a material cost of that job; splitting it
    -- into `other` would just make two lines nobody can add up.
    'materials',
    v_label,
    r.amount_cents / 100.0,
    coalesce(r.purchased_on, current_date),
    r.is_passthrough,
    coalesce(r.reviewed_by, r.uploaded_by)
  )
  returning id into v_cost_id;

  update receipts set job_cost_id = v_cost_id where id = p_receipt_id;
  return v_cost_id;
end;
$$;

comment on function public._post_receipt_job_cost(uuid) is
  'Internal: turn a receipt into its ONE job_costs line and stamp receipts.job_cost_id. Returns the existing line id if it already posted, or null when there is no job or no amount to post. Called by review_receipt and by match_bank_transaction — never by a client.';

revoke all on function public._post_receipt_job_cost(uuid) from public, anon, authenticated;


-- ---- review_receipt now posts ---------------------------------------------
-- Same signature, so every caller and every grant is untouched.
create or replace function public.review_receipt(
  p_id uuid,
  p_reviewed boolean default true
)
returns receipts
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row receipts;
begin
  if public.my_role_rank() < 2 then
    raise exception 'only a supervisor or above can review a receipt'
      using errcode = '42501';
  end if;

  -- Reviewing a receipt that is on a job and has no amount would mark it
  -- correct and post nothing, which is the quiet failure this bridge exists to
  -- end. Say so instead. A JOBLESS receipt (gas, the common case) reviews fine
  -- with or without an amount — there is nothing for it to post to.
  if p_reviewed and exists (
    select 1 from receipts
     where id = p_id and project_id is not null
       and amount_cents is null and job_cost_id is null
  ) then
    raise exception 'Add the amount before you review this one — the job cost line needs it.';
  end if;

  update receipts set
    reviewed_by = case when p_reviewed then auth.uid() else null end,
    reviewed_at = case when p_reviewed then now() else null end
  where id = p_id
  returning * into v_row;

  if v_row.id is null then
    raise exception 'no such receipt';
  end if;

  if p_reviewed then
    -- Un-reviewing deliberately does NOT unpost. The money left the company
    -- whatever the office later decides about the paperwork, and deleting a
    -- ledger line because somebody unticked a box is how a ledger stops being
    -- one. The receipt reads "posted" from here on.
    perform public._post_receipt_job_cost(p_id);
    select * into v_row from receipts where id = p_id;
  end if;

  return v_row;
end;
$$;

comment on function public.review_receipt(uuid, boolean) is
  'Supervisor+ marks (or unmarks) a receipt reviewed. Reviewing one that names a job posts its single job_costs line (Wave Z, Z4); un-reviewing leaves that line standing, because the money was still spent.';


-- ---- who may still edit a receipt once it has posted ----------------------
-- update_receipt is uploader-OR-supervisor (20260957000000): the installer who
-- snapped the photo can fix up their own receipt, which is right, because they
-- are the one who knows what they bought.
--
-- It stops being right the moment that receipt becomes a line in the cost
-- ledger. From then on the same call would move a posted ledger line — its
-- amount, its date, its label, its billable flag, even which JOB it is on —
-- through the sync trigger below, which runs as the table owner. A supervisor
-- reviewed that line; nobody would review it again, and nothing would say it
-- moved. That is a write path from an installer's phone into the company's
-- books, and it needs closing at the source rather than in the trigger, so the
-- refusal is a sentence a person reads instead of a silent no-op.
--
-- Supervisor+ keeps the edit, because the spec's own rule is that fixing the
-- amount afterwards moves the line with it — the office is who does that.
-- Everything else about this function is byte-for-byte 20260957000000's.
create or replace function public.update_receipt(
  p_id uuid,
  p_project_id uuid,
  p_pending_job_name text,
  p_amount_cents int,
  p_vendor text,
  p_purchased_on date,
  p_category text,
  p_is_passthrough boolean,
  p_note text
)
returns receipts
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_uploader uuid;
  v_job_cost uuid;
  v_pending text := nullif(btrim(coalesce(p_pending_job_name, '')), '');
  v_row receipts;
begin
  select uploaded_by, job_cost_id into v_uploader, v_job_cost
    from receipts where id = p_id;
  if v_uploader is null then
    raise exception 'no such receipt';
  end if;
  if not (v_uid = v_uploader or public.my_role_rank() >= 2) then
    raise exception 'only the uploader or a supervisor can edit this receipt'
      using errcode = '42501';
  end if;
  -- Wave Z: posted is posted. The uploader's own edit stops here.
  if v_job_cost is not null and public.my_role_rank() < 2 then
    raise exception 'This receipt is already on the job''s costs. Ask the office to change it.'
      using errcode = '42501';
  end if;
  if p_project_id is not null and v_pending is not null then
    raise exception 'a receipt names a real job or a waiting-job name, never both';
  end if;
  if p_category is not null and p_category not in ('gas', 'other') then
    raise exception 'category must be gas or other';
  end if;
  if p_amount_cents is not null and p_amount_cents < 0 then
    raise exception 'amount cannot be negative';
  end if;

  update receipts set
    project_id      = p_project_id,
    pending_job_name = v_pending,
    amount_cents    = p_amount_cents,
    vendor          = nullif(btrim(coalesce(p_vendor, '')), ''),
    purchased_on    = p_purchased_on,
    category        = p_category,
    category_by     = case
      when p_category is null then null
      when category is distinct from p_category then 'manual'
      else category_by
    end,
    is_passthrough  = p_is_passthrough,
    note            = nullif(btrim(coalesce(p_note, '')), '')
  where id = p_id
  returning * into v_row;

  return v_row;
end;
$$;

comment on function public.update_receipt(uuid, uuid, text, int, text, date, text, boolean, text) is
  'Uploader-or-supervisor field edits (full-record overwrite, file_daily_log-style). Changing category here pins category_by=''manual'' forever; resending the same category value leaves its provenance untouched. Wave Z: once the receipt has posted to job_costs only a supervisor+ may edit it, because the edit moves a reviewed ledger line.';

revoke all on function public.update_receipt(uuid, uuid, text, int, text, date, text, boolean, text) from public, anon;
grant execute on function public.update_receipt(uuid, uuid, text, int, text, date, text, boolean, text) to authenticated;


-- ---- the posted line follows the receipt ----------------------------------
-- Editing a receipt's amount after it posted has to move the ledger line with
-- it, or the two disagree and the receipt photo stops being evidence for the
-- number. A trigger rather than a line inside update_receipt, because
-- apply_receipt_extraction writes the same fields and a rule enforced in two
-- writers is a rule enforced in neither.
create or replace function public.sync_receipt_job_cost()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_label text;
begin
  v_label := coalesce(nullif(btrim(new.vendor), ''), 'Receipt');
  if nullif(btrim(coalesce(new.note, '')), '') is not null then
    v_label := v_label || ' — ' || btrim(new.note);
  end if;

  update job_costs set
    project_id = coalesce(new.project_id, project_id),
    label      = v_label,
    amount     = coalesce(new.amount_cents / 100.0, amount),
    cost_date  = coalesce(new.purchased_on, cost_date),
    billable   = new.is_passthrough
  where id = new.job_cost_id;

  return null;
end;
$$;

comment on function public.sync_receipt_job_cost() is
  'Keeps a posted receipt''s job_costs line in step with the receipt: one source of truth for the amount, the date, the vendor and the bill-to-customer flag (Wave Z, Z4).';

revoke all on function public.sync_receipt_job_cost() from public, anon, authenticated;

drop trigger if exists trg_receipt_syncs_its_job_cost on receipts;
create trigger trg_receipt_syncs_its_job_cost
  after update on receipts
  for each row
  when (
    new.job_cost_id is not null
    -- Unchanged, so this is an edit to an ALREADY posted receipt — not the
    -- stamp _post_receipt_job_cost just made, whose line was built from these
    -- very values a moment ago.
    and old.job_cost_id is not distinct from new.job_cost_id
    and (
      old.amount_cents is distinct from new.amount_cents
      or old.purchased_on is distinct from new.purchased_on
      or old.vendor is distinct from new.vendor
      or old.note is distinct from new.note
      or old.is_passthrough is distinct from new.is_passthrough
      or old.project_id is distinct from new.project_id
    )
  )
  execute function public.sync_receipt_job_cost();


-- ===========================================================================
-- 5. Z5 — the company card statement, and which charges have no receipt
-- ===========================================================================
-- The bookkeeper exports the card feed and wants one answer: which of these
-- charges has nobody handed in a receipt for? That is the whole feature.
--
-- NO BANK CREDENTIALS EVER TOUCH THIS APP. The handoff is a FILE — somebody
-- downloads the export and drops it in. There is no live feed here and there is
-- not going to be one; a live connection is parked with the future QuickBooks
-- link.
--
-- Neither table is project-scoped (a card charge is not about a job until it is
-- matched to a receipt that names one), so neither takes a sandbox guard.
create table if not exists bank_imports (
  id uuid primary key default gen_random_uuid(),
  imported_by uuid references profiles(id) on delete set null,
  filename text,
  imported_at timestamptz not null default now(),
  row_count integer not null default 0,
  -- Set by undo_bank_import. The batch row SURVIVES the undo, so "we imported
  -- that file on Tuesday and took it back on Wednesday" is still readable —
  -- an import that vanished would look like it never happened.
  undone_at timestamptz
);

create table if not exists bank_transactions (
  id uuid primary key default gen_random_uuid(),
  import_id uuid not null references bank_imports(id) on delete cascade,
  posted_on date,
  -- Cents, and NOT NULL: a charge with no amount is not a charge. Signed,
  -- because a refund is a real line on a statement and forcing it positive
  -- would make the month stop adding up.
  amount_cents integer not null,
  description text,
  vendor_guess text,
  cardholder text,
  -- The bank's own id for the charge when the export carries one.
  external_id text,
  receipt_id uuid references receipts(id) on delete set null,
  status text not null default 'unreceipted'
    check (status in ('matched', 'unreceipted', 'ignored')),
  -- What "the same charge" means, so re-importing an overlapping file adds
  -- nothing: the bank's own id when there is one, else a hash of date + amount
  -- + description + CARDHOLDER, plus which occurrence of that hash the line is
  -- within the file. Computed by the RPC (never by the client) and UNIQUE, so
  -- the dedup is the database's job and not a read-then-write somebody could
  -- race. Two crew filling up at the same pump for the same money on the same
  -- morning are two charges, and so are one person's two identical purchases.
  dedupe_key text not null unique,
  created_at timestamptz not null default now()
);

-- One receipt answers for at most one charge. A partial index rather than a
-- plain UNIQUE, because "no receipt yet" is the normal state and every
-- unmatched row would otherwise collide on null.
create unique index if not exists bank_transactions_one_receipt
  on bank_transactions (receipt_id) where receipt_id is not null;

create index if not exists bank_transactions_import_idx
  on bank_transactions (import_id);
create index if not exists bank_transactions_open_idx
  on bank_transactions (status, posted_on desc);

comment on table bank_imports is
  'One dropped-in card statement export. Undoable as a batch — undo_bank_import drops the rows nobody matched and unmatches the rest — and the batch row survives the undo so the history reads honestly (Wave Z, Z5).';
comment on table bank_transactions is
  'One charge off a company card statement, and the receipt somebody handed in for it (or the fact that nobody did). No bank credentials are involved anywhere: the handoff is a file a person exports and drops in.';
comment on column bank_transactions.dedupe_key is
  'What "the same charge" means across two imports of overlapping files: the bank''s external_id when the export has one, else a hash of date + amount + description + cardholder with the line''s occurrence number appended. UNIQUE, so re-importing last month adds nothing while two genuinely identical charges stay two charges.';

alter table bank_imports enable row level security;
alter table bank_transactions enable row level security;

-- Revoke first (Supabase's defaults grant `authenticated` everything on a new
-- public table), then grant back SELECT alone: the five RPCs below are the only
-- writers, so there is no direct path that could skip their checks.
revoke all on bank_imports from anon, authenticated;
revoke all on bank_transactions from anon, authenticated;
grant select on bank_imports to authenticated;
grant select on bank_transactions to authenticated;
grant all on bank_imports to service_role;
grant all on bank_transactions to service_role;

drop policy if exists "bank_imports_cost_seers" on bank_imports;
create policy "bank_imports_cost_seers" on bank_imports
  for select to authenticated
  using (not public.is_partner_user() and public.can_see_costs(auth.uid()));

drop policy if exists "bank_transactions_cost_seers" on bank_transactions;
create policy "bank_transactions_cost_seers" on bank_transactions
  for select to authenticated
  using (not public.is_partner_user() and public.can_see_costs(auth.uid()));


-- ---- import_bank_transactions ---------------------------------------------
-- Takes the rows the browser read out of the file, already mapped to the four
-- fields that matter. The MAPPING is deliberately the client's job and a step a
-- human confirms: nobody here knows what column names any particular export
-- uses, and guessing them in SQL would bake one bank's spelling into the
-- database forever.
--
-- Dedup is `on conflict (dedupe_key) do nothing`, so importing a file that
-- overlaps last month's adds only what is genuinely new, and the count of what
-- landed is the difference — no read-then-write, nothing to race.
create or replace function public.import_bank_transactions(
  p_rows jsonb,
  p_filename text default null
)
returns bank_imports
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_import bank_imports;
  v_added integer;
begin
  if not public.can_see_costs(auth.uid()) then
    raise exception 'Only an owner, or somebody given "Sees costs", can import the card statement.'
      using errcode = '42501';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'That file did not read as a list of charges.';
  end if;

  insert into bank_imports (imported_by, filename, row_count)
  values (auth.uid(), nullif(btrim(coalesce(p_filename, '')), ''), jsonb_array_length(p_rows))
  returning * into v_import;

  -- WITH ORDINALITY, because the position of a line in the file is the only
  -- thing that tells two genuinely identical lines apart — see the key below.
  with incoming as (
    select
      nullif(btrim(coalesce(t.r ->> 'posted_on', '')), '')::date       as posted_on,
      (t.r ->> 'amount_cents')::integer                                as amount_cents,
      nullif(btrim(coalesce(t.r ->> 'description', '')), '')           as description,
      nullif(btrim(coalesce(t.r ->> 'vendor_guess', '')), '')          as vendor_guess,
      nullif(btrim(coalesce(t.r ->> 'cardholder', '')), '')            as cardholder,
      nullif(btrim(coalesce(t.r ->> 'external_id', '')), '')           as external_id,
      t.ord                                                            as ord
    from jsonb_array_elements(p_rows) with ordinality as t(r, ord)
  ),
  -- CARDHOLDER IS PART OF THE KEY. Two people on the crew filling up at the
  -- same station on the same morning for the same $52.00 is an ordinary
  -- Tuesday, not a double entry — and the first draft of this hashed only date
  -- + amount + description, so one of those two charges silently never reached
  -- the "No receipt yet" list. Real money, gone from the one report this
  -- feature exists to produce.
  based as (
    select i.*,
           md5(
             coalesce(i.posted_on::text, '') || '|' ||
             i.amount_cents::text || '|' ||
             lower(coalesce(i.description, '')) || '|' ||
             lower(coalesce(i.cardholder, ''))
           ) as base
      from incoming i
     where i.amount_cents is not null
  ),
  -- And even with the cardholder in it, one person CAN buy the same thing
  -- twice in a day. So a charge with no id of its own is keyed by its base plus
  -- which occurrence of that base it is — "#1", "#2" — counted in file order.
  -- That is stable across re-imports (the same file yields the same numbering,
  -- so `on conflict do nothing` still swallows the whole overlap) while two
  -- identical lines stay two charges. Rows that carry the bank's own id are
  -- counted separately, so mixing them into a file cannot shift the numbering
  -- of the ones that do not.
  keyed as (
    select b.*,
           coalesce(
             b.external_id,
             b.base || '#' || row_number() over (
               partition by b.base, (b.external_id is null) order by b.ord
             )
           ) as dedupe_key
      from based b
  ),
  -- What is left to collapse is a file that repeats one of the bank's OWN ids,
  -- which is the bank claiming those are the same charge. Take it at its word.
  deduped as (
    select distinct on (dedupe_key) * from keyed order by dedupe_key, ord
  ),
  inserted as (
    insert into bank_transactions
      (import_id, posted_on, amount_cents, description, vendor_guess, cardholder,
       external_id, dedupe_key)
    select v_import.id, posted_on, amount_cents, description, vendor_guess, cardholder,
           external_id, dedupe_key
      from deduped
    on conflict (dedupe_key) do nothing
    returning 1
  )
  select count(*) into v_added from inserted;

  update bank_imports set row_count = v_added where id = v_import.id
  returning * into v_import;

  return v_import;
end;
$$;

comment on function public.import_bank_transactions(jsonb, text) is
  'Cost-seers only: file one dropped-in card statement. Rows arrive already mapped by the browser (the header-mapping step a human confirms), and a charge already imported from an overlapping file is dropped by the dedupe_key unique index. Two identical lines inside one file are two charges, not one. row_count is what actually LANDED, not what was in the file.';

revoke all on function public.import_bank_transactions(jsonb, text) from public, anon;
grant execute on function public.import_bank_transactions(jsonb, text) to authenticated;


-- ---- match / unmatch / ignore ---------------------------------------------
-- Matching is the moment a charge and a receipt become one fact. It is also,
-- per the spec, the moment the Z4 bridge fires: a card charge with a receipt
-- that names a job is money spent on that job, evidenced twice.
create or replace function public.match_bank_transaction(
  p_txn_id uuid,
  p_receipt_id uuid
)
returns bank_transactions
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row bank_transactions;
begin
  if not public.can_see_costs(auth.uid()) then
    raise exception 'Only an owner, or somebody given "Sees costs", can match a card charge.'
      using errcode = '42501';
  end if;
  if not exists (select 1 from receipts where id = p_receipt_id) then
    raise exception 'That receipt is not here any more.';
  end if;
  -- One receipt answers for one charge. The unique index would refuse anyway;
  -- this turns a constraint-violation string into a sentence a person can act
  -- on.
  if exists (
    select 1 from bank_transactions
     where receipt_id = p_receipt_id and id <> p_txn_id
  ) then
    raise exception 'That receipt is already matched to another charge.';
  end if;

  update bank_transactions
     set receipt_id = p_receipt_id, status = 'matched'
   where id = p_txn_id
  returning * into v_row;

  if v_row.id is null then
    raise exception 'no such charge';
  end if;

  -- The Z4 bridge. Does nothing unless the receipt names a job, has an amount,
  -- and has not already posted — see _post_receipt_job_cost.
  perform public._post_receipt_job_cost(p_receipt_id);

  return v_row;
end;
$$;

comment on function public.match_bank_transaction(uuid, uuid) is
  'Cost-seers only: this charge is that receipt. One receipt answers for at most one charge. Matching also fires the Z4 bridge, so a card charge whose receipt names a job reaches the cost ledger.';

create or replace function public.unmatch_bank_transaction(p_txn_id uuid)
returns bank_transactions
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row bank_transactions;
begin
  if not public.can_see_costs(auth.uid()) then
    raise exception 'Only an owner, or somebody given "Sees costs", can unmatch a card charge.'
      using errcode = '42501';
  end if;

  -- Unmatching says "that was the wrong receipt", not "that money was never
  -- spent". The job cost line the match posted stays exactly where it is, the
  -- same way un-reviewing does not unpost one.
  update bank_transactions
     set receipt_id = null, status = 'unreceipted'
   where id = p_txn_id
  returning * into v_row;

  if v_row.id is null then
    raise exception 'no such charge';
  end if;
  return v_row;
end;
$$;

create or replace function public.ignore_bank_transaction(
  p_txn_id uuid,
  p_ignored boolean default true
)
returns bank_transactions
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row bank_transactions;
begin
  if not public.can_see_costs(auth.uid()) then
    raise exception 'Only an owner, or somebody given "Sees costs", can set a card charge aside.'
      using errcode = '42501';
  end if;

  -- Set aside, never deleted. A charge somebody decided needs no receipt is
  -- still a charge, and the statement has to keep adding up.
  update bank_transactions
     set status = case
       when p_ignored then 'ignored'
       when receipt_id is not null then 'matched'
       else 'unreceipted'
     end
   where id = p_txn_id
  returning * into v_row;

  if v_row.id is null then
    raise exception 'no such charge';
  end if;
  return v_row;
end;
$$;

comment on function public.ignore_bank_transaction(uuid, boolean) is
  'Cost-seers only: set a charge aside as needing no receipt (or put it back). Never deletes — the statement still has to add up.';

revoke all on function public.match_bank_transaction(uuid, uuid) from public, anon;
revoke all on function public.unmatch_bank_transaction(uuid) from public, anon;
revoke all on function public.ignore_bank_transaction(uuid, boolean) from public, anon;
grant execute on function public.match_bank_transaction(uuid, uuid) to authenticated;
grant execute on function public.unmatch_bank_transaction(uuid) to authenticated;
grant execute on function public.ignore_bank_transaction(uuid, boolean) to authenticated;


-- ---- undo_bank_import ------------------------------------------------------
-- Every import is undoable as a batch, because the fix for "I dropped in the
-- wrong file" must not be forty taps.
--
-- Asymmetric on purpose: rows NOBODY touched are dropped, and rows somebody has
-- since matched or set aside are kept and merely unmatched. A person's decision
-- about which receipt answers which charge is work, and an undo that threw it
-- away would be a worse mistake than the one it is undoing.
create or replace function public.undo_bank_import(p_import_id uuid)
returns bank_imports
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row bank_imports;
begin
  if not public.can_see_costs(auth.uid()) then
    raise exception 'Only an owner, or somebody given "Sees costs", can undo an import.'
      using errcode = '42501';
  end if;

  -- Nobody has touched these: they go.
  delete from bank_transactions
   where import_id = p_import_id
     and receipt_id is null
     and status = 'unreceipted';

  -- Somebody said "that receipt answers for this charge". The charge stays and
  -- goes back on the list; the job cost line the match posted stands, because
  -- the money was still spent.
  update bank_transactions
     set receipt_id = null, status = 'unreceipted'
   where import_id = p_import_id
     and status = 'matched';

  -- Rows somebody set aside as needing no receipt are left exactly as they are.
  -- That is a decision about a charge, and an undo of the IMPORT has no
  -- business reversing it.

  update bank_imports set undone_at = now()
   where id = p_import_id
  returning * into v_row;

  if v_row.id is null then
    raise exception 'no such import';
  end if;
  return v_row;
end;
$$;

comment on function public.undo_bank_import(uuid) is
  'Cost-seers only: take one whole import back. Charges nobody touched are dropped; matched charges are kept and unmatched; charges somebody set aside stay set aside — a person''s decision is work an undo has no business throwing away. Any job cost lines the matches posted stand, because the money was still spent.';

revoke all on function public.undo_bank_import(uuid) from public, anon;
grant execute on function public.undo_bank_import(uuid) to authenticated;


-- ===========================================================================
-- 99. Re-arm the sandbox fence
-- ===========================================================================
-- project_financials carries a `project_id`, which is what makes a table
-- project-scoped (sandbox_scoped_tables, 20260967000000). Without this line a
-- QA test login could write a bid on ANY job, not only its sandbox ones —
-- scripts/test_sandbox_guard.py fails CI for exactly this omission. Idempotent:
-- a table already correctly guarded is left alone rather than re-triggered.
select public.attach_sandbox_guards();
-- ===========================================================================
-- 20260979000000_job_pipeline.sql (mirrored)
-- Job pipeline, wave J of the transcripts program: the stretch between winning
-- a bid and the first window going in. projects gains ready_state (backfilled
-- 'ready'), materials_eta, materials_arrived_at and sort_order, all four
-- RPC-only under wave D's projects grant law — set_project_readiness,
-- set_project_materials and set_projects_order, each foreman+. Adds ONE table,
-- pipeline_nudges: the ledger of what the 7 AM sweep has already said about a
-- job, keyed (project_id, kind, on_date) where on_date is the day the nudge is
-- ABOUT, never the day it was sent. claim_pipeline_nudges decides and claims in
-- one statement (service role only) and pipeline_nudge_audience says who hears
-- it; an hourly pg_cron poke plus a 7 AM company-local gate inside the SQL
-- keeps the morning the crew's morning through both halves of the year. Wave
-- O's credential expiry and wave H's GC-check-in clause are meant to land in
-- the same function and the same ledger — see section 8. Deploy AFTER
-- 20260978000000 (wave Z).
-- ===========================================================================

-- Wave J — Job pipeline (transcripts program, grill of 2026-09-03, Q8 + Q9).
--
-- A job used to be either "active" or not, and everything between winning the
-- bid and the first window going in lived in somebody's head. This migration
-- gives that stretch four facts and one voice:
--
--   * ready_state          — is this job ready for us to work, or not yet?
--   * materials_eta        — when the windows are supposed to land
--   * materials_arrived_at — when they actually did
--   * sort_order           — the order the office wants the jobs read in
--
-- and a 7 AM sweep that says, out loud and before it is too late, "Sand Hollow
-- starts in 7 days — still Not ready · windows not in".
--
-- Timezone: 'America/Denver' spelled out, the same company-local day
-- 20260813000000_toolbox_gate_timezone.sql settled for every clock gate and
-- 20260976000000 (wave K) followed for the evening nudge. There is no shared
-- timezone helper in this schema — the convention IS the literal — so this file
-- follows it rather than inventing a second source of truth.
--
-- Idempotent throughout (add column if not exists / create ... if not exists /
-- create or replace / on conflict do nothing), so re-running it changes nothing.

-- ---------------------------------------------------------------------------
-- 1. J1/J2 — the four columns
-- ---------------------------------------------------------------------------
-- ready_state is NOT NULL with a default of 'ready', which is what backfills
-- every job that already exists: nobody has ever told this app a job was not
-- ready, so claiming otherwise about six months of live jobs would put a red
-- flag on work that is going fine. The two ways a job is BORN not ready — an
-- import from Monday, and a tracking job built in one tap from the clock-in —
-- say so explicitly at creation instead.
alter table projects
  add column if not exists ready_state text not null default 'ready',
  -- A date, not a timestamp: "the windows land on the 15th" is the whole fact.
  -- Deliberately NOT package_deliveries.expected_at, which is a per-TRUCK ETA
  -- for one delivery. This is the job-level answer to "when do we have glass",
  -- and merging the two would make a single early truck look like the whole
  -- order arriving.
  add column if not exists materials_eta date,
  -- A timestamp, because this one is an event somebody did: a foreman tapped
  -- "Materials arrived" at a moment, and the record should say when.
  add column if not exists materials_arrived_at timestamptz,
  -- Null means "nobody has placed this job by hand" — every such job sorts
  -- AFTER the ones somebody deliberately ordered, by start date and then name.
  -- Sparse on purpose: ordering the whole list is a foreman's occasional act,
  -- not a property every job must carry.
  add column if not exists sort_order int;

alter table projects drop constraint if exists projects_ready_state_check;
alter table projects add constraint projects_ready_state_check
  check (ready_state in ('not_ready', 'ready'));

comment on column projects.ready_state is
  'not_ready | ready — whether the site is ready for us to work. Existing jobs backfilled to ready; Monday imports and one-tap tracking jobs are born not_ready. RPC-only (set_project_readiness) — the projects grant law, see below.';
comment on column projects.materials_eta is
  'The day the windows are expected on this job (job-level, not a truck ETA). Written by set_project_materials (foreman+).';
comment on column projects.materials_arrived_at is
  'When somebody tapped "Materials arrived" on this job. Null means the windows are still not in — and, on a job with no materials_eta, that nobody has said anything either way, which is why the sweep needs both. Written by set_project_materials (foreman+). Readable by a builder login granted this job, like every column on this table: it is a fact about their own house, not about our business.';
comment on column projects.sort_order is
  'The office''s hand-made order for the jobs list, 1..n, written by set_projects_order (foreman+). Null sorts last, then start_date, then name. Like every column on this table it is readable by a builder login granted this job (THE WALL, 20260950000000 section 6) — a bare integer with no meaning outside our own list, which is why it is allowed to live here.';

-- THE PROJECTS GRANT LAW (wave D, 20260959000000): table-level INSERT/UPDATE on
-- projects is revoked, and only the columns the app writes directly are granted
-- back. A new column is therefore RPC-only unless it is named there. All four
-- of these are deliberately left OFF the grant list: readiness, the materials
-- dates and the list order are each decisions with a rank behind them
-- (foreman+), and a column-level grant cannot check a rank. `start_date` is
-- already on wave D's update grant, which is why "expected start" stays an
-- ordinary inline edit through updateProject and needs nothing here.
--
-- WHO CAN READ THEM — decided out loud, because the grant law above is only
-- about WRITING and silence about reading is how a leak gets shipped.
--
-- `projects` is the one table a builder (partner) login reads whole. THE WALL
-- (20260950000000 section 6) makes that a deliberate, narrow crack: a partner
-- gets the row for each job they were granted and nothing from any other table.
-- It is a ROW-level rule, and RLS has no column-level half — wave Z spells the
-- consequence out at 20260978000000: a column cannot be gated separately from
-- its table, and revoking column SELECT would break the owner's own `select *`
-- as surely as a builder's. So a new column on `projects` is readable by a
-- granted builder, full stop, and the only real choice is whether it may live
-- here at all.
--
-- For these four, yes, and here is the reasoning per column:
--   ready_state, materials_eta, materials_arrived_at — facts about the
--     BUILDER'S OWN JOB. "Our windows land on the 15th" is a thing the GC is
--     usually told on the phone; it is not a number about our business. Wave
--     J's rule is that a builder is never PUSHED about our problems (see the
--     audience in section 6), not that the dates are secret.
--   sort_order — a bare integer with no meaning outside our own list, and the
--     list it orders is not one a builder can see.
-- Nothing here is a price, a margin, a cost or a wage.
--
-- ANYTHING THAT IS must not be a column on `projects`: put it in a table of its
-- own with its own policy, the way 20260978000000 moves bid_amount and
-- target_margin_pct off this table into project_financials. That is the
-- precedent, and it is the only shape that actually works.
--
-- One correction that belongs here rather than in the file it is about: THE
-- WALL's own comment says "nothing crew-only lives on `projects` itself". That
-- was true when it was written and it is the sentence a reader will meet first.
-- 20260950000000 is applied in production, so it is not edited after the fact;
-- the qualification lives here, in scripts/partner_wall_lib.py beside the
-- exemption it explains, and in CONTEXT.md.

create index if not exists projects_pipeline_start_idx
  on projects (start_date)
  where deleted_at is null;

-- ---------------------------------------------------------------------------
-- 2. J1 — set_project_readiness (foreman+)
-- ---------------------------------------------------------------------------
create or replace function public.set_project_readiness(
  p_project_id uuid,
  p_ready_state text
)
returns projects
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row projects;
begin
  if not _is_lead(auth.uid()) then
    raise exception 'Only a foreman or above can say whether a job is ready.';
  end if;
  if p_ready_state is null or p_ready_state not in ('not_ready', 'ready') then
    raise exception 'A job is either ready or not ready — nothing else.';
  end if;

  update projects
     set ready_state = p_ready_state
   where id = p_project_id
  returning * into v_row;

  if not found then
    raise exception 'That job does not exist.';
  end if;

  return v_row;
end;
$$;

comment on function public.set_project_readiness(uuid, text) is
  'Foreman+: mark a job Ready or Not ready. SECURITY DEFINER because projects'' table-level UPDATE grant is revoked (wave D) and ready_state is deliberately not granted back — the rank check belongs in a body, not in a column grant.';

revoke all on function public.set_project_readiness(uuid, text) from public, anon;
grant execute on function public.set_project_readiness(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. J1 — set_project_materials (foreman+)
-- ---------------------------------------------------------------------------
-- Two facts, one door, and every combination has to be sayable without a
-- sentinel that means two things. So: nulls mean LEAVE ALONE, and the two ways
-- of erasing a fact are said out loud.
--
--   change the ETA        p_materials_eta := '2026-09-15'
--   clear the ETA         p_clear_eta := true
--   the windows are here  p_arrived := true
--   no, they are not      p_arrived := false
--   touch neither         (defaults)
--
-- The alternative — "null clears it" — would have made the one-tap "Materials
-- arrived" button wipe the ETA every time it was pressed, because that call
-- has no ETA to send.
create or replace function public.set_project_materials(
  p_project_id uuid,
  p_materials_eta date default null,
  p_clear_eta boolean default false,
  p_arrived boolean default null
)
returns projects
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row projects;
begin
  if not _is_lead(auth.uid()) then
    raise exception 'Only a foreman or above can set when the windows are coming.';
  end if;

  update projects
     set materials_eta = case
           when coalesce(p_clear_eta, false) then null
           when p_materials_eta is not null then p_materials_eta
           else materials_eta
         end,
         materials_arrived_at = case
           -- Arriving twice must not move the time: the first tap is when the
           -- truck actually showed up, and a second tap (a mis-tap, a refresh,
           -- a second person confirming) should not quietly rewrite it.
           when p_arrived is true then coalesce(materials_arrived_at, now())
           when p_arrived is false then null
           else materials_arrived_at
         end
   where id = p_project_id
  returning * into v_row;

  if not found then
    raise exception 'That job does not exist.';
  end if;

  return v_row;
end;
$$;

comment on function public.set_project_materials(uuid, date, boolean, boolean) is
  'Foreman+: set or clear a job''s window ETA and record that the windows arrived (or un-record it). Null arguments mean "leave that fact alone" so the one-tap Materials-arrived call cannot wipe the ETA.';

revoke all on function public.set_project_materials(uuid, date, boolean, boolean) from public, anon;
grant execute on function public.set_project_materials(uuid, date, boolean, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. J2 — set_projects_order (foreman+)
-- ---------------------------------------------------------------------------
-- Takes the WHOLE visible list in its new order and writes 1..n. Sending the
-- whole list rather than "move this one to position 4" is what makes the
-- result the same whichever way it was dragged, and what makes a second
-- foreman's save land as a whole coherent order instead of interleaving with
-- somebody else's half-finished one.
--
-- Jobs not named in the array keep whatever sort_order they had. The Jobs page
-- always sends every job it is showing, so in practice the array IS the list;
-- leaving absent jobs alone is what stops a filtered or paged caller from
-- silently un-ordering everything it could not see.
create or replace function public.set_projects_order(p_ids uuid[])
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not _is_lead(auth.uid()) then
    raise exception 'Only a foreman or above can reorder the jobs list.';
  end if;
  if p_ids is null or array_length(p_ids, 1) is null then
    return;
  end if;

  update projects p
     set sort_order = o.position
    from (
      select id, ordinality::int as position
      from unnest(p_ids) with ordinality as u(id, ordinality)
    ) as o
   where p.id = o.id;
end;
$$;

comment on function public.set_projects_order(uuid[]) is
  'Foreman+: write the jobs list order as 1..n in the order the ids arrive. Ids not in the array keep the sort_order they had.';

revoke all on function public.set_projects_order(uuid[]) from public, anon;
grant execute on function public.set_projects_order(uuid[]) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. J4 — pipeline_nudges: the record of what has already been said
-- ---------------------------------------------------------------------------
-- One row per thing the sweep has said about a job. The unique key IS the
-- idempotency: a sweep that runs twice, or a database that keeps a cron job
-- alive through a deploy, cannot push the same sentence twice.
--
-- `on_date` is THE DAY THE NUDGE IS ABOUT, not the day it was sent — a
-- deliberate choice, and the one that makes the record survive an outage. The
-- 14-day warning is keyed to the job's start date, so if the sweep misses a
-- morning the warning still goes out the next one and still only once; and if
-- somebody MOVES the start date, the new date is a new key and the crew is
-- warned again about the new plan, which is exactly right. The late-materials
-- nudge is keyed to the ETA it missed, so it fires once per promised date,
-- forever, rather than every morning until somebody notices.
--
-- `kind` deliberately carries NO check constraint. This table is the shared
-- idempotency ledger for every "the app noticed something and said so" rule,
-- and wave O's credential-expiry warnings (O4) are meant to land here as new
-- kinds with no migration at all. See the extension point in section 8.
create table if not exists pipeline_nudges (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  kind text not null,
  on_date date not null,
  created_at timestamptz not null default now(),
  unique (project_id, kind, on_date)
);

create index if not exists pipeline_nudges_project_idx
  on pipeline_nudges (project_id, created_at desc);

alter table pipeline_nudges enable row level security;

-- Revoke BEFORE granting: this project's default privileges hand every new
-- table in `public` the full set to `authenticated`, and RLS alone is not the
-- wall — one permissive policy added later by anybody would turn a table with
-- no write policy into a write hole. The sweep runs on the service-role key,
-- which these revokes never touch.
revoke all on pipeline_nudges from anon, authenticated;
grant select on pipeline_nudges to authenticated;
grant all on pipeline_nudges to service_role;

-- Readable by any signed-in crew member (a job's own history of "we told you"
-- is not a secret, and the Overview may one day show it), never by a partner
-- login — the mechanical wall guard every crew table carries since
-- 20260950000000. No insert/update/delete policy at all: the sweep is the only
-- writer, and it writes as the service role.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'pipeline_nudges' and policyname = 'crew read'
  ) then
    create policy "crew read" on pipeline_nudges
      for select to authenticated
      using (not public.is_partner_user() and (true));
  end if;
end;
$$;

comment on table pipeline_nudges is
  'One row per nudge the pipeline sweep has already sent about a job. The unique (project_id, kind, on_date) is the idempotency: on_date is the day the nudge is ABOUT (a start date, a missed ETA), never the day it was sent. Open vocabulary of kinds so later rules — wave O credential expiry — reuse this ledger.';

-- ---------------------------------------------------------------------------
-- 6. J4 — who hears about it
-- ---------------------------------------------------------------------------
-- Everyone who can actually do something: every supervisor and owner (they own
-- the pipeline), plus every foreman who is either scheduled on the job in the
-- next fortnight or standing on it right now with an open shift. NOT every
-- foreman in the company — a foreman with no connection to Sand Hollow reading
-- about Sand Hollow every morning is how a crew learns to swipe the app's
-- notifications away without reading them.
--
-- SCHEDULED MEANS PUBLISHED. A schedule assignment is born 'draft' and stays
-- invisible to the crew until a supervisor publishes it — that is what the
-- publish step is FOR (20260721010000's own header), and every app-side read of
-- "who is on this job" agrees: My Schedule, the job hub's crew list and the
-- offline fallback all filter status = 'published'. So the sweep filters the
-- statuses the crew has actually been shown, and never `<> 'canceled'`, which
-- would let a draft in. A foreman pencilled into a plan nobody has published
-- would otherwise be pushed at 7 AM about a job the app has deliberately not
-- told him he is on — and the push itself would leak next month's unpublished
-- board. 'in_progress' and 'done' are included because an assignment only
-- reaches them after being published; nothing in the app moves a draft there.
--
-- Partner logins are excluded outright. They are not crew, and a builder must
-- never learn from a notification that our windows are late.
--
-- Defined before the claim that calls it so the file reads in dependency
-- order; plpgsql would not have minded either way, but a reader would.
create or replace function public.pipeline_nudge_audience(p_project_id uuid)
returns uuid[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(array_agg(distinct pr.id), '{}'::uuid[])
    from profiles pr
   where pr.active
     and not coalesce(pr.is_partner, false)
     and (
       public._is_supervisor(pr.id)
       or (
         public._is_lead(pr.id)
         and (
           exists (
             select 1
               from schedule_assignments sa
               join schedule_assignment_members sam on sam.assignment_id = sa.id
              where sa.project_id = p_project_id
                and sam.profile_id = pr.id
                -- Published, not drafted — see the note above.
                and sa.status in ('published', 'in_progress', 'done')
                and sa.end_date >= (now() at time zone 'America/Denver')::date
                and sa.start_date <= (now() at time zone 'America/Denver')::date + 14
           )
           or exists (
             select 1
               from time_shifts ts
              where ts.project_id = p_project_id
                and ts.profile_id = pr.id
                and ts.status = 'open'
                and ts.clock_out_at is null
           )
         )
       )
     );
$$;

comment on function public.pipeline_nudge_audience(uuid) is
  'Who hears a pipeline warning about one job: every active supervisor+, plus every foreman on a PUBLISHED assignment for it within the next fortnight or clocked into it right now. A draft assignment does not count — the crew has not been shown it. Partner logins never.';

revoke all on function public.pipeline_nudge_audience(uuid) from public, anon, authenticated;
grant execute on function public.pipeline_nudge_audience(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 7. J4 — claim_pipeline_nudges: the decision and the claim, in one statement
-- ---------------------------------------------------------------------------
-- THE RULE LIVES TWICE, ON PURPOSE, AND THE TWO COPIES ARE PINNED TOGETHER.
-- app/src/lib/pipeline.ts holds the readable version (needsCall / dueNudges),
-- which drives the "Needs a call" chip on the Jobs page; this body holds the
-- same rule in SQL, because the sweep must decide and claim in ONE statement or
-- two overlapping sweeps both push. pipeline.test.ts carries a test named after
-- this function that spells these clauses out in TypeScript, so a change made
-- to one side and not the other fails a test rather than going quietly live.
--
-- The claim is `insert ... on conflict do nothing returning`, the same trick
-- 20260976000000's claim_still_on_the_job_nudges plays with UPDATE: the insert
-- takes the row lock, so a second sweep genuinely sees the first one's work and
-- returns nobody.
--
-- Two rules today:
--   (a) the job starts soon and something is still not settled — once at the
--       14-day mark, once at the 7-day mark. WINDOWED (8..14 days out, then
--       0..7) rather than "exactly 14", because one missed sweep must not
--       silently drop a warning; the unique key already guarantees each is said
--       once per start date. A job whose start date MOVES is warned again about
--       the new date, which is the right answer and not an accident.
--   (b) the promised ETA came and went with nothing arrived — said once, keyed
--       to the date that was missed, so it does not become a daily drumbeat.
--
-- A PROMISE IS HALF THE MATERIALS RULE. Both branches ask for materials_eta to
-- be set before "nothing arrived" counts, and that is not a detail — it is what
-- stops the very first 7 AM run pushing about every job in the company.
-- materials_arrived_at is a new column: on the morning this deploys it is null
-- everywhere, because nobody has ever been able to set it. A bare
-- `arrived_at is null` would therefore have fired rule (a) for every active job
-- starting inside a fortnight, sent one push per job to every supervisor's
-- phone (distinct tags, so they would not even collapse on the lock screen),
-- and lit a "Needs a call" chip on all of those cards — every one of them
-- wrong. An ETA on file is what turns "no windows" from a gap in the record
-- into a fact: somebody said the 15th, and they are not here.
--
-- That is the same rule the spec's third start-date clause gets, "no GC
-- check-in in the last 14 days", which is NOT here at all: wave H ships the
-- project_gc_checkins table it needs, and a rule that reads a missing table
-- would either break the sweep or fire on every job in the company for the
-- crime of never having been asked. See section 8. app/src/lib/pipeline.ts's
-- materialsMissing() carries the twin of this clause and the same note.
--
-- Service context only. auth.uid() is null under the service-role key the edge
-- function uses and under pg_cron, and no crew member should be able to fire
-- the company's morning push by hand.
create or replace function public.claim_pipeline_nudges()
returns table (
  project_id uuid,
  job_label text,
  kind text,
  days_until int,
  not_ready boolean,
  materials_missing boolean,
  profile_ids uuid[]
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
-- The OUT columns above share their names with real columns in the query below
-- (project_id, kind). Ambiguity between an OUT parameter and a column is a
-- plpgsql runtime error, not a compile one, so it would first appear at 7 AM in
-- production. Every reference below is table-qualified AND this pragma makes
-- the column win regardless — belt and braces on a function nobody watches run.
#variable_conflict use_column
declare
  v_tz constant text := 'America/Denver';
  v_today date;
  v_hour int;
begin
  if auth.uid() is not null then
    raise exception 'The pipeline reminder sends itself — nobody needs to press anything.';
  end if;

  v_today := (now() at time zone v_tz)::date;
  v_hour := extract(hour from (now() at time zone v_tz))::int;

  -- Before 7 AM company time there is nothing due. The cron pokes this hourly
  -- rather than once at a fixed UTC hour so the "morning" stays the crew's
  -- morning through both halves of the year; the claim is what makes a repeated
  -- poke free.
  if v_hour < 7 then
    return;
  end if;

  return query
  with candidate as (
    select p.id as pid,
           coalesce(nullif(btrim(p.name), ''), p.job_code) as label,
           (p.start_date - v_today)::int as days_out,
           p.ready_state as ready,
           p.materials_eta as eta,
           p.materials_arrived_at as arrived_at
      from projects p
     where p.status = 'active'
       and p.deleted_at is null
  ),
  due as (
    -- (a) starting soon, and still not ready or the promised windows are not
    --     here. "Promised" is c.eta is not null — see the note above.
    select c.pid,
           c.label,
           case when c.days_out > 7 then 'start_14' else 'start_7' end::text as due_kind,
           (v_today + c.days_out) as due_date,
           c.days_out,
           c.ready = 'not_ready' as flag_not_ready,
           (c.eta is not null and c.arrived_at is null) as flag_no_materials
      from candidate c
     where c.days_out between 0 and 14
       and (
         c.ready = 'not_ready'
         or (c.eta is not null and c.arrived_at is null)
       )
    union all
    -- (b) the promised day came and went and nothing is here.
    select c.pid,
           c.label,
           'materials_late'::text as due_kind,
           c.eta as due_date,
           c.days_out,
           c.ready = 'not_ready' as flag_not_ready,
           true as flag_no_materials
      from candidate c
     where c.eta is not null
       and c.arrived_at is null
       and c.eta < v_today
  ),
  claimed as (
    insert into pipeline_nudges (project_id, kind, on_date)
    select d.pid, d.due_kind, d.due_date from due d
    on conflict (project_id, kind, on_date) do nothing
    returning pipeline_nudges.project_id as claimed_pid,
              pipeline_nudges.kind as claimed_kind
  )
  select d.pid,
         d.label,
         d.due_kind,
         d.days_out,
         d.flag_not_ready,
         d.flag_no_materials,
         public.pipeline_nudge_audience(d.pid)
    from due d
    join claimed cl
      on cl.claimed_pid = d.pid
     and cl.claimed_kind = d.due_kind;
end;
$$;

comment on function public.claim_pipeline_nudges() is
  'Service-role only (the pipeline-sweep edge function): claims and returns the job warnings due this company-local morning — 14 and 7 days before a start date on a job that is still not ready or has no windows, and the morning after a missed materials ETA. The claim and the decision are one statement, so two overlapping sweeps cannot both push. The readable copy of this rule is needsCall/dueNudges in app/src/lib/pipeline.ts.';

revoke all on function public.claim_pipeline_nudges() from public, anon, authenticated;
grant execute on function public.claim_pipeline_nudges() to service_role;

-- ---------------------------------------------------------------------------
-- 8. J5 — the extension point, written down so the next wave finds it
-- ---------------------------------------------------------------------------
-- Two later waves are meant to ride this sweep rather than grow one of their
-- own. Both need the same three things — a rule that yields (subject, kind,
-- date-it-is-about), a claim through pipeline_nudges, and an audience — and
-- both should arrive as ONE new function plus one call added to the edge
-- function's list, never as a second cron job.
--
--   WAVE O (O4, credential expiry). Add claim_credential_nudges() shaped
--   exactly like claim_pipeline_nudges above: same service-role-only guard,
--   same 7 AM local gate, and an insert into pipeline_nudges with kinds of its
--   own ('cert_expiring_30', 'cert_expired', …) whose on_date is the expiry
--   date the warning is ABOUT. Nothing here needs to change: `kind` carries no
--   check constraint precisely so a new rule needs no migration, and the
--   supabase/functions/pipeline-sweep index.ts already loops over a list of
--   rules rather than hard-coding this one.
--
--   WAVE H (H1, the GC handshake). The spec's third start-date clause — "no GC
--   check-in in the last 14 days" — belongs in the `due` CTE's (a) branch, as
--   one more OR beside `ready_state = 'not_ready'`:
--       or not exists (select 1 from project_gc_checkins g
--                       where g.project_id = c.id
--                         and g.contacted_at >= (v_today - 14))
--   It is deliberately absent today because project_gc_checkins does not exist
--   yet, and a rule that reads a missing table would either fail the sweep or
--   (worse) fire on every job in the company for never having been asked. The
--   matching seam on the app side is needsCall's `gcCheckinsKnown` argument in
--   app/src/lib/pipeline.ts, which defaults to false for exactly this reason.

-- ---------------------------------------------------------------------------
-- 9. J4 — the cron
-- ---------------------------------------------------------------------------
-- Hourly rather than once a day at a fixed UTC hour, for the reason wave K's
-- sweep is every five minutes: pg_cron schedules in UTC, the company's morning
-- is in Denver, and the offset between them changes twice a year. An hourly
-- poke with the 7 AM test inside the SQL is right in both halves of the year
-- and costs nothing — before 7 the claim returns nobody, and after it, only the
-- first sweep of the morning claims anything.
--
-- Wrapped in exception handlers the way 20260963000000_summon_expiry.sql wraps
-- its own: a database without pg_cron (a local `supabase start`, a fork for a
-- test) still applies this migration. The nudge is a courtesy — every fact it
-- reads is on the job's own Overview whether or not anyone is told — so a
-- missing scheduler earns a warning in the log, never a failed migration.
do $$
begin
  create extension if not exists pg_cron;
exception when others then
  raise warning 'pipeline-sweep: pg_cron is not available here (%) — the morning job reminder will not run. Nothing else about the job pipeline changes.', sqlerrm;
end;
$$;

do $$
begin
  create extension if not exists pg_net;
exception when others then
  raise warning 'pipeline-sweep: pg_net is not available here (%) — the morning job reminder will not run. Nothing else about the job pipeline changes.', sqlerrm;
end;
$$;

do $$
begin
  perform cron.unschedule('pipeline-sweep');
exception when others then
  null; -- first run: nothing scheduled yet
end;
$$;

-- The project ref is this repo's one production project, pinned the same way
-- 20260918000000 and 20260976000000 pin it for their sweeps. verify_jwt = false
-- on the target function, so no auth header rides along — see the function's
-- own header for why that is safe.
do $$
begin
  perform cron.schedule(
    'pipeline-sweep',
    '0 * * * *',
    $c$
    select net.http_post(
      url := 'https://czprjcskmzzagdztqonm.supabase.co/functions/v1/pipeline-sweep',
      body := '{}'::jsonb,
      headers := '{"Content-Type": "application/json"}'::jsonb
    );
    $c$
  );
exception when others then
  raise warning 'pipeline-sweep: could not schedule the sweep (%) — the morning job reminder will not run. Nothing else about the job pipeline changes.', sqlerrm;
end;
$$;

-- ---------------------------------------------------------------------------
-- 10. The test-login fence
-- ---------------------------------------------------------------------------
-- pipeline_nudges carries project_id, so it is project-scoped and the fence
-- belongs on it. Re-arming is idempotent and reports what it did
-- (20260967000000); a test login can only ever touch the sandbox job's rows,
-- and the service-role sweep is unaffected because the guard is a no-op when
-- there is no JWT.
select public.attach_sandbox_guards();


-- ===========================================================================
-- 20260980000000_scope_at_a_glance.sql (mirrored)
-- Scope at a glance, wave X of the transcripts program: what kind of unit each
-- mark is (project_mark_specs.unit_kind / .door_kind, written by the app's one
-- classifier), one grouped row per job to read it back (project_scope_counts,
-- SECURITY INVOKER), and projects.stories.
-- ===========================================================================

-- Scope at a glance, wave X of the transcripts program.
--
-- The question this answers is the one an office asks before opening a job:
-- how big is it, and how much of it is doors? Until now a job card could only
-- say "40 openings / 32 done", and it said that by pulling EVERY opening row
-- for EVERY job down to the phone and counting them in JavaScript.
--
-- Three things here, in the order they depend on each other:
--
--   1. project_mark_specs.unit_kind / .door_kind — the answer, STORED, written
--      by the one TypeScript classifier (app/src/lib/install/specKinds.mjs) at
--      every path that writes a spec. Stored rather than derived at read time
--      because a grouped count is what makes the card cheap, and because the
--      classifier's answer is worth being able to correct: a foreman edits the
--      spec text, the kind follows.
--
--   2. add_field_unit fills them in too. It is the one specs writer that lives
--      in SQL (wave E, 20260977000000), so it cannot call the classifier — it
--      already knows the answer from p_kind, and a field-added door is 'other'
--      until somebody says which kind it is.
--
--   3. project_scope_counts — one row per job, counted in the database and
--      read through the caller's own RLS, so a job a person cannot see cannot
--      appear in their counts either. Tolerates null kinds ("unknown"), which
--      is what every row is until the backfill runs.
--
-- Plus projects.stories, the number nothing else in the app knows: a traced 3D
-- model can say how many storeys a building has, but most jobs have no model,
-- and "two storeys" changes what a bid and a crew look like.
--
-- IDEMPOTENT throughout: every object is if-not-exists or or-replace, and the
-- check constraints are dropped before they are added. Safe to run twice.
--
-- MERGE ORDER: after 20260979000000 (wave J). Numbers must land in order, one
-- deploy at a time.
--
-- AND IT MUST LAND AFTER 20260978000000 (wave Z), which is the dependency that
-- actually bites. Wave Z revokes table-level INSERT/UPDATE on `projects` and
-- re-states the whole column grant list — a list that does not contain
-- `stories`, because `stories` did not exist when it was written. This file's
-- `grant ... (stories)` at part 4 is ADDITIVE, so it only survives if it is the
-- later statement. Its number is higher, so it is; do not renumber it below
-- 20260978000000, and do not restate wave Z's lists here (Z drops bid_amount
-- and target_margin_pct, so a list copied from master would grant columns that
-- no longer exist and fail).
--
-- After each of Z and X deploys, check it rather than assuming: a zero-row
-- PATCH naming `stories` as a non-owner login. 204 = the grant is there,
-- 42501 = it was lost. The app degrades either way (api.ts drops the column and
-- retries) but a person silently loses the field.

-- ---------------------------------------------------------------------------
-- 1. What kind of unit is this mark?
-- ---------------------------------------------------------------------------
--
-- WHO MAY WRITE THESE: nobody new. project_mark_specs carries a TABLE-level
-- `grant insert, update, delete ... to authenticated` (20260724000000) rather
-- than a column list, so a new column is writable by exactly the people who
-- could already write the row — and RLS still says that is foreman+
-- (mark_specs_insert_foreman / _update_foreman). That is deliberately unlike
-- `projects`, whose writes ARE a column list (see part 4 below).

alter table project_mark_specs
  add column if not exists unit_kind text,
  add column if not exists door_kind text;

alter table project_mark_specs drop constraint if exists project_mark_specs_unit_kind_check;
alter table project_mark_specs add constraint project_mark_specs_unit_kind_check
  check (unit_kind is null or unit_kind in ('window', 'door'));

-- A door kind only means something on a door. Null-when-not-a-door is the
-- same rule specKindColumns applies in the app; stating it here as well means a
-- future writer that forgets is refused rather than quietly counted.
alter table project_mark_specs drop constraint if exists project_mark_specs_door_kind_check;
alter table project_mark_specs add constraint project_mark_specs_door_kind_check
  check (
    door_kind is null
    or (unit_kind = 'door'
        and door_kind in ('slider', 'french', 'bifold', 'swing', 'other'))
  );

comment on column project_mark_specs.unit_kind is
  'window | door | null, written by doorKind''s module (app/src/lib/install/specKinds.mjs) at every specs write path. Null means the paperwork does not say - project_scope_counts keeps those in their own bucket rather than guessing.';
comment on column project_mark_specs.door_kind is
  'slider | french | bifold | swing | other, null for anything that is not a door. Vocabulary: docs/window-vendor-conventions.md, "Door kinds". Change the classifier and the backfill (scripts/seed-spec-kinds.mjs) must be re-run.';

-- Counting doors on one job is a per-project read; the existing
-- project_mark_specs_project_idx already serves it.

-- ---------------------------------------------------------------------------
-- 2. The one specs writer that lives in SQL
-- ---------------------------------------------------------------------------
--
-- add_field_unit (wave E, 20260977000000) inserts the spec row for a window or
-- door somebody found on site. Replaced here ONLY to carry the two new columns:
-- everything else below is that migration's function, word for word, because a
-- create-or-replace has to restate the whole body and a paraphrase would be a
-- silent behaviour change.
--
-- It does not need the classifier: p_kind is the answer, typed by the person
-- standing in front of the hole. A field-added door is 'other' — nobody has
-- been asked which kind, and 'other' is what the app writes whenever the
-- paperwork does not say.

create or replace function add_field_unit(
  p_project_id uuid,
  p_kind text,
  p_width_in numeric,
  p_height_in numeric,
  p_photo_path text,
  p_pin_x numeric,
  p_pin_y numeric,
  p_note text,
  -- Not in the wave's written signature, and needed: a pin is only meaningful
  -- against the sheet it was tapped on, and a job's map has pages. Trailing
  -- and defaulted so the eight-argument call in the spec still works.
  p_page_number int default null
)
returns project_openings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row project_openings;
  v_next int;
  v_code text;
  v_style text;
  v_name text;
begin
  if p_kind not in ('window', 'door') then
    raise exception 'Say whether this is a window or a door.' using errcode = '22023';
  end if;

  -- PRESENCE, NOT RANK (wave E): whoever is on the clock on this job can
  -- record a window nobody drew. Anything less and the person looking at the
  -- hole has to phone someone to write it down, which is how it goes unwritten.
  if not exists (
    select 1 from time_shifts
     where profile_id = auth.uid()
       and project_id = p_project_id
       and status = 'open'
       and clock_out_at is null
  ) then
    raise exception 'Clock in on this job before you add a missed window or door.'
      using errcode = '42501';
  end if;

  -- "Missed 1", "Missed 2", … per job. Read off field_unit_seq and not off the
  -- CODE, because the code is renameable and the number must not be: a job
  -- where "Missed 1" has been renamed to "W-14", or removed, must still call
  -- the next one "Missed 2". Every row on the job counts, hidden ones included.
  --
  -- The advisory lock is per project and lasts the transaction: two people
  -- standing in the same house adding a unit in the same second would otherwise
  -- both read the same max and one of them would meet a raw duplicate-key error
  -- from project_openings_live_code_key instead of getting their window
  -- recorded.
  perform pg_advisory_xact_lock(hashtext('field_unit:' || p_project_id::text));
  select coalesce(max(field_unit_seq), 0) + 1
    into v_next
    from project_openings
   where project_id = p_project_id;
  v_code := 'Missed ' || v_next;

  v_style := case when p_kind = 'door'
                  then 'Missed door — field added'
                  else 'Missed window — field added' end;

  perform set_config('app.field_unit_add', 'on', true);
  insert into project_openings (
    project_id, opening_code, label, page_number, pin_x, pin_y,
    status, confirmed, flag_kind, flag_note, flagged_by, flagged_at,
    field_added, field_unit_seq
  ) values (
    p_project_id, v_code, v_style, coalesce(p_page_number, 1),
    p_pin_x, p_pin_y,
    'planned', true, 'not_on_plans',
    nullif(trim(coalesce(p_note, '')), ''), auth.uid(), now(), true, v_next
  )
  returning * into v_row;
  perform set_config('app.field_unit_add', 'off', true);

  -- The spec row is what makes it a real unit everywhere else: the sheet, the
  -- schedule list and the 3D map all read specs by mark code.
  insert into project_mark_specs (
    project_id, mark_code, style, width_in, height_in, source, confirmed,
    unit_kind, door_kind
  ) values (
    p_project_id, v_code, v_style, p_width_in, p_height_in, 'field', false,
    p_kind, case when p_kind = 'door' then 'other' end
  )
  -- AUTHORITATIVE FOR A FIELD ROW. `do nothing` meant a leftover spec under
  -- this code silently became the new unit's size — a second missed unit
  -- showing the first one's width and height, which is what a purchase order
  -- gets cut from. The numbering above should make a collision impossible now;
  -- if one happens anyway, the measurements somebody just took on site win. A
  -- row that is not ours, or that a foreman has confirmed, is never touched.
  on conflict (project_id, mark_code) do update
     set style = excluded.style,
         width_in = excluded.width_in,
         height_in = excluded.height_in,
         source = 'field',
         -- Wave X: the kind follows the style it was written with, or the two
         -- would disagree on a row that used to be a window and is now a door.
         unit_kind = excluded.unit_kind,
         door_kind = excluded.door_kind,
         updated_at = now()
   where project_mark_specs.source = 'field'
     and coalesce(project_mark_specs.confirmed, false) = false;

  if nullif(trim(coalesce(p_photo_path, '')), '') is not null then
    insert into attachments (project_id, project_opening_id, kind, storage_path, created_by)
    select p_project_id, v_row.id, 'photo', p_photo_path,
           (select display_name from profiles where id = auth.uid());
  end if;

  -- It lands on the Issues board like every other field problem, so it is
  -- chased rather than admired.
  select display_name into v_name from profiles where id = auth.uid();
  insert into issues (project_id, opening_id, kind, urgency, note, created_by)
  values (
    p_project_id, v_row.id, 'flag', 'normal',
    coalesce(nullif(trim(coalesce(p_note, '')), ''),
             v_style) || ' (added by ' || coalesce(v_name, 'the crew') || ')',
    auth.uid()
  );

  return v_row;
end;
$$;

revoke all on function add_field_unit(uuid, text, numeric, numeric, text, numeric, numeric, text, int) from public, anon;
grant execute on function add_field_unit(uuid, text, numeric, numeric, text, numeric, numeric, text, int) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. One row per job: how big is it, and how much of it is doors?
-- ---------------------------------------------------------------------------
--
-- SECURITY INVOKER, which is the whole point: the counts are computed from
-- `projects`, `project_openings` and `project_mark_specs` under the READER's
-- own row-level security. A trashed job, a testing job below supervisor, a job
-- a partner was never granted — none of them can appear here, because none of
-- their rows are visible to the query in the first place. A definer view would
-- have leaked the existence and size of every job on the company.
--
-- The join from an opening to its spec is markBase, exactly as the app does it
-- (specForOpeningCode): openings "1-1" and "1-2" are both instances of mark
-- "1", while "Add-1" is a mark of its own. public.mark_base is wave E's SQL
-- mirror of that function.
--
-- LATERAL rather than a plain join so one opening can only ever count once. A
-- job could hold two spec rows whose mark codes differ only in case ("Add-1"
-- and "ADD-1"): the unique index is on the literal string, but this join is
-- case-insensitive because indexSpecsByMark is. Confirmed beats draft, then
-- most recently touched — the same row the sheet would show.
--
-- `unknown_units` is not a bug, it is the honest bucket: a mark whose spec
-- nobody has read yet, or which predates the backfill. Openings always add up
-- (windows + doors + unknown = openings), which is what lets the card say "40
-- openings · 32 windows · 8 doors" without the numbers arguing.

drop view if exists project_scope_counts;

create view project_scope_counts
  with (security_invoker = true)
as
select
  p.id                                                              as project_id,
  count(o.id)                                                       as openings,
  count(o.id) filter (where o.status = 'installed')                 as installed,
  count(o.id) filter (where s.unit_kind = 'window')                 as windows,
  count(o.id) filter (where s.unit_kind = 'door')                   as doors,
  count(o.id) filter (where s.door_kind = 'slider')                 as door_sliders,
  count(o.id) filter (where s.door_kind = 'french')                 as door_french,
  count(o.id) filter (where s.door_kind = 'bifold')                 as door_bifold,
  count(o.id) filter (where s.door_kind = 'swing')                  as door_swing,
  count(o.id) filter (where s.door_kind = 'other')                  as door_other,
  count(o.id) filter (where s.unit_kind is null)                    as unknown_units
from projects p
left join project_openings o
  on o.project_id = p.id
left join lateral (
  select ms.unit_kind, ms.door_kind
    from project_mark_specs ms
   where ms.project_id = p.id
     and upper(ms.mark_code) = upper(public.mark_base(o.opening_code))
   order by ms.confirmed desc, ms.updated_at desc
   limit 1
) s on true
group by p.id;

comment on view project_scope_counts is
  'One row per job: openings, installed, windows, doors, and doors by kind. SECURITY INVOKER - counts are computed under the reader''s own RLS, so a hidden job cannot show up as a number. Retires the whole-table project_openings pull the job cards used to do.';

revoke all on project_scope_counts from public, anon;
grant select on project_scope_counts to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. How many storeys is this building?
-- ---------------------------------------------------------------------------
--
-- Typed on the job form, and only ever typed: when a job has a traced 3D model
-- the app SHOWS that model's storey count instead (storiesOf), and never
-- writes it back here. Three writers already share an outline row's `features`
-- and a fourth, writing into a different table on their behalf, is exactly the
-- kind of loop that makes a number nobody can explain.
--
-- THE GRANT IS THE POINT (wave D's law, 20260959000000): table-level INSERT and
-- UPDATE on `projects` are revoked, and only app-written columns are granted
-- back by name. A column missing from those lists is a 42501 on the first PATCH
-- that names it. Granted here per-column and additively, so this never has to
-- restate — or accidentally shorten — the list another wave is extending.

alter table projects add column if not exists stories smallint;

alter table projects drop constraint if exists projects_stories_check;
alter table projects add constraint projects_stories_check
  check (stories is null or (stories >= 1 and stories <= 60));

comment on column projects.stories is
  'How many storeys the building has, typed by a human on the job form. Null means nobody said. A traced fit-view model beats it for display (storiesOf) and never writes back into it.';

grant insert (stories) on projects to authenticated;
grant update (stories) on projects to authenticated;


-- ===========================================================================
-- 20260983000000_credentials.sql (mirrored)
-- Credentials, wave O of the transcripts program: the cards a crew member
-- holds and the day each one runs out. Adds TWO tables — certifications (one
-- row per card; voided, never deleted) and credential_nudges (the sibling of
-- pipeline_nudges, separate because that table's project_id is NOT NULL and a
-- card is about a person) — plus the private credential-docs bucket, the one
-- writer set_certification (self may add their own unverified; supervisor+
-- verifies, edits and voids), and claim_credential_nudges, which rides wave J's
-- existing 7 AM pipeline-sweep as one more rule rather than a second cron.
-- Deploy AFTER 20260982000000 (wave Y).
-- ===========================================================================

-- Wave O — Credentials (transcripts program, grill of 2026-09-03, Q14).
--
-- The app has always known what somebody is GOOD at — a skill tier, a
-- capability badge, a training clearance per window type. It has never known
-- what somebody is CERTIFIED to do, and those are the pieces of paper a general
-- contractor asks for at the gate and a bid asks for on page two: OSHA 10,
-- OSHA 30, first aid, aerial lift, forklift, fall protection.
--
-- Every one of them expires, and nothing in this schema has ever had an expiry
-- date. That is the whole reason this is a table rather than another list of
-- flags: a certification is a fact WITH A DEADLINE, and the deadline is what
-- the 7 AM sweep says out loud thirty days before a card runs out.
--
-- Four things here, in the order they depend on each other:
--
--   1. certifications          — one row per card, per person.
--   2. credential-docs         — a PRIVATE bucket for the photo of the card.
--   3. set_certification       — the one writer: self may add their own
--                                (unverified), supervisor+ verifies, edits
--                                and voids.
--   4. credential_nudges +     — the "we already said this" ledger and the
--      claim_credential_nudges   rule the pipeline sweep runs, wave J's J5
--                                extension point taken up exactly as written.
--
-- MERGE ORDER: this is 20260983000000 and it lands AFTER 20260981000000 (wave
-- H, the GC handshake) and 20260982000000 (wave Y, who did what). It shares no
-- object with either — H touches project_gc_checkins and the pipeline sweep's
-- start-date clause, Y touches install credit — so the order matters only
-- because migration numbers must land in sequence, one deploy at a time.
--
-- NOT PROJECT-SCOPED, on purpose. A certification belongs to a person, not a
-- job, so there is no project_id, no `attach_sandbox_guards()` call, and a test
-- login has no sandbox row to be fenced into. What stops a test login writing a
-- card is set_certification's own rules, which are about identity and rank.
--
-- IDEMPOTENT throughout (create ... if not exists / create or replace / drop
-- policy if exists before create / on conflict), so re-running it changes
-- nothing.


-- ---------------------------------------------------------------------------
-- 1. O1 — certifications
-- ---------------------------------------------------------------------------
-- WHY A KIND LIST AND AN `other_label`. The six named kinds are the cards this
-- company is actually asked for, and naming them is what makes O5's summary
-- countable: "4 OSHA 30 · 12 OSHA 10 · 6 aerial lift" is only possible if
-- everybody spells OSHA 30 the same way. `other` plus a free-text label is the
-- escape hatch, so a card nobody anticipated is still recorded rather than
-- squeezed into the wrong bucket — and it counts as "other", never as one of
-- the six.
--
-- WHY expires_on IS NULLABLE. Some cards genuinely never expire (an OSHA 10
-- wallet card has no printed expiry in most states). Null means "no expiry on
-- the card", which is a real answer, and the chip on screen says so in grey
-- rather than pretending the card is fine forever in green. Nothing with a null
-- expiry can ever be nudged about, which is correct.
--
-- WHY voided_at RATHER THAN DELETE. A card entered against the wrong person, or
-- a card that turned out to be a photo of somebody else's, has to stop counting
-- — but a deleted row takes its history with it, and "who said this person had
-- an OSHA 30" is exactly the question asked after an incident. Void, never
-- delete: the row stays, and every read filters it out.
create table if not exists certifications (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles(id) on delete cascade,
  kind text not null check (
    kind in (
      'osha10',
      'osha30',
      'first_aid_cpr',
      'aerial_lift',
      'forklift',
      'fall_protection',
      'other'
    )
  ),
  -- Only meaningful when kind = 'other'; the RPC clears it otherwise so a kind
  -- corrected from 'other' to 'osha30' does not keep a stale label beside it.
  other_label text,
  issued_on date,
  -- Null = the card carries no expiry. See the note above.
  expires_on date,
  -- "<profile_id>/<uuid>.jpg" inside the credential-docs bucket. A path, never
  -- a URL: the bucket is private and every read is a short-lived signed URL.
  document_path text,
  verified_by uuid references profiles(id) on delete set null,
  verified_at timestamptz,
  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  voided_at timestamptz
);

-- Every read is "this person's cards" or "everybody's cards, soonest expiry
-- first"; both are served by this.
create index if not exists certifications_profile_idx
  on certifications (profile_id, expires_on);

-- The sweep's own read: the cards expiring around today, across the company.
create index if not exists certifications_expiry_idx
  on certifications (expires_on)
  where voided_at is null;

comment on table certifications is
  'One card per row: OSHA 10/30, first aid, aerial lift, forklift, fall protection, or other. A fact with a deadline — expires_on is what the 7 AM sweep warns about thirty days out and again on the day. Voided, never deleted. Written only by set_certification (Wave O, O1).';

alter table certifications enable row level security;

-- Revoke BEFORE granting. This project's default privileges hand every new
-- table in `public` the full set to `authenticated`, and RLS is not the wall on
-- its own: without this, a permissive policy added later by anybody would turn
-- a table with no write policy into a write hole. set_certification, SECURITY
-- DEFINER, is the only writer there is.
revoke all on certifications from anon, authenticated;
grant select on certifications to authenticated;
grant all on certifications to service_role;

-- WHO READS WHAT.
--   * Your own cards, always. Unlike a pay rate (which the app deliberately
--     does not show you, because payroll already does), your OSHA card is a
--     thing you are asked for at a gate and a thing you have to renew. A person
--     who cannot see their own expiry date cannot do anything about it, and O3
--     puts exactly this list on My Work.
--   * Foreman and above, everybody's. A foreman is who gets told at the gate
--     that half the crew cannot go up in the lift today.
--   * A partner (builder) login, never. The mechanical wall guard every crew
--     table has carried since 20260950000000; scripts/test_partner_wall.py
--     fails on a new table without it.
drop policy if exists "certifications_select" on certifications;
create policy "certifications_select" on certifications
  for select to authenticated
  using (
    not public.is_partner_user()
    and (profile_id = auth.uid() or public.my_role_rank() >= 1)
  );


-- ---------------------------------------------------------------------------
-- 2. O1/O2 — the private bucket for the photo of the card
-- ---------------------------------------------------------------------------
-- A photo of an OSHA card carries a full legal name and a card number. It is
-- not a job photo, so it does not live in install-media with them, and it is
-- not public under any circumstances.
--
-- SIZE CAP: 10 MB per file, which is roughly four times a phone camera JPEG at
-- full resolution and comfortably clears a scanned PDF of a two-sided card.
-- Stated rather than left to the project default so nobody has to guess, and
-- low enough that a mis-picked video is refused by the bucket instead of
-- costing the company storage forever. MIME types are pinned to the four things
-- a card can honestly be.
--
-- `do update` rather than `do nothing` on conflict: re-running this migration
-- against a bucket somebody widened by hand puts the cap and the type list
-- back, which is the point of an idempotent migration.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'credential-docs',
  'credential-docs',
  false,
  10485760,
  array['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- THE PATH IS THE PERMISSION. Every object is "<profile_id>/<uuid>.<ext>", so
-- the first folder name IS the person the card belongs to, and the policies
-- below can be written against it without reading the certifications table at
-- all. That is deliberate: a storage policy that joins back to a business table
-- is a storage policy that breaks the day the business table's own policy
-- changes.
--
-- Read: the cardholder, or a supervisor+. NOT every foreman — a foreman needs
-- to know a card exists and when it runs out (the row is readable to them), and
-- that is a different thing from being handed a photograph of somebody's
-- government-adjacent ID. The person verifying is supervisor+ by O1's own
-- rule, and they are the only one who needs to look at the paper.
--
-- Write: the cardholder, their own folder, and nobody else. A supervisor
-- collecting cards at a toolbox talk therefore cannot upload on somebody's
-- behalf — see the PR body; the honest reading of the spec is that the person
-- owns their own document, and the alternative hands one account the ability to
-- write into every crew member's private folder.
drop policy if exists "credential docs read" on storage.objects;
create policy "credential docs read"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'credential-docs'
    and not public.is_partner_user()
    and (
      (storage.foldername(name))[1] = auth.uid()::text
      or public.my_role_rank() >= 2
    )
  );

drop policy if exists "credential docs write own" on storage.objects;
create policy "credential docs write own"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'credential-docs'
    and not public.is_partner_user()
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Update covers a re-upload to the same path (a retaken photo). Delete is
-- deliberately absent: nothing in the app deletes a credential document, for
-- the same reason nothing deletes a certification row.
drop policy if exists "credential docs replace own" on storage.objects;
create policy "credential docs replace own"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'credential-docs'
    and not public.is_partner_user()
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'credential-docs'
    and (storage.foldername(name))[1] = auth.uid()::text
  );


-- ---------------------------------------------------------------------------
-- 3. O1 — set_certification: the only writer
-- ---------------------------------------------------------------------------
-- One function for add, edit, verify and void, because they are the same row
-- and splitting them into four RPCs would mean four places to get the rank
-- check right.
--
-- WHO MAY DO WHAT, and it is not a single rank:
--   * ADD YOUR OWN CARD: anybody, including an installer. This is the whole
--     point — a crew member photographs the card in their wallet at a toolbox
--     talk instead of the office chasing it. It lands UNVERIFIED whatever the
--     caller asks for, so "I have an OSHA 30" is a claim until somebody with a
--     rank has looked at the paper.
--   * ADD SOMEBODY ELSE'S: supervisor+, and they may verify it in the same
--     call, because they are holding the card.
--   * EDIT, VERIFY, UNVERIFY, VOID: supervisor+ only. An installer cannot
--     correct their own typo, which is a deliberate cost: a row somebody can
--     edit after it was verified is a row that means nothing.
--
-- PARTIAL BY DEFAULT, like updateProject learned to be in wave J: on an edit, a
-- null argument means "leave that column alone", never "set it to null". A date
-- is CLEARED through its own explicit flag, so one tap on Verify cannot wipe an
-- expiry date the caller never mentioned. That bug has been shipped in this
-- repo once already (20260979000000's own PR fixed it for job details); this
-- function does not get to ship it again.
create or replace function public.set_certification(
  p_id uuid default null,
  p_profile_id uuid default null,
  p_kind text default null,
  p_other_label text default null,
  p_issued_on date default null,
  p_expires_on date default null,
  p_document_path text default null,
  p_verified boolean default null,
  p_voided boolean default null,
  p_clear_issued boolean default false,
  p_clear_expires boolean default false
)
returns certifications
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row certifications;
  v_rank int := public.my_role_rank();
  v_me uuid := auth.uid();
  v_target uuid;
begin
  if v_me is null then
    raise exception 'Sign in before adding a card.' using errcode = '42501';
  end if;

  -- ---------------------------------------------------------------- new card
  if p_id is null then
    v_target := coalesce(p_profile_id, v_me);
    if v_target <> v_me and v_rank < 2 then
      raise exception 'Only a supervisor can add a card for somebody else.'
        using errcode = '42501';
    end if;
    if p_kind is null then
      raise exception 'Say which card this is.';
    end if;
    if not exists (select 1 from profiles where id = v_target) then
      raise exception 'That person is not on the crew list.';
    end if;
    if p_kind = 'other' and coalesce(btrim(p_other_label), '') = '' then
      raise exception 'Name the card, since it is not one of the listed ones.';
    end if;
    if p_issued_on is not null and p_expires_on is not null
       and p_expires_on < p_issued_on then
      raise exception 'A card cannot run out before the day it was issued.';
    end if;

    insert into certifications (
      profile_id, kind, other_label, issued_on, expires_on, document_path,
      created_by,
      -- Your own card is never self-verified, whatever the call asks for.
      verified_by,
      verified_at
    )
    values (
      v_target,
      p_kind,
      case when p_kind = 'other' then nullif(btrim(p_other_label), '') else null end,
      p_issued_on,
      p_expires_on,
      nullif(btrim(p_document_path), ''),
      v_me,
      case when p_verified is true and v_rank >= 2 and v_target <> v_me then v_me end,
      case when p_verified is true and v_rank >= 2 and v_target <> v_me then now() end
    )
    returning * into v_row;
    return v_row;
  end if;

  -- ------------------------------------------------------------ existing card
  if v_rank < 2 then
    raise exception 'Only a supervisor can change or verify a card.'
      using errcode = '42501';
  end if;

  select * into v_row from certifications where id = p_id;
  if not found then
    raise exception 'That card is not on file any more.';
  end if;

  update certifications set
    kind = coalesce(p_kind, kind),
    other_label = case
      when coalesce(p_kind, kind) <> 'other' then null
      when p_other_label is not null then nullif(btrim(p_other_label), '')
      else other_label
    end,
    issued_on = case
      when p_clear_issued then null
      else coalesce(p_issued_on, issued_on)
    end,
    expires_on = case
      when p_clear_expires then null
      else coalesce(p_expires_on, expires_on)
    end,
    document_path = coalesce(nullif(btrim(p_document_path), ''), document_path),
    -- Verify and unverify are the same argument. Absent leaves the row alone,
    -- so an edit to a date does not quietly re-stamp who verified it.
    verified_by = case
      when p_verified is true then v_me
      when p_verified is false then null
      else verified_by
    end,
    verified_at = case
      when p_verified is true then now()
      when p_verified is false then null
      else verified_at
    end,
    voided_at = case
      when p_voided is true then coalesce(voided_at, now())
      when p_voided is false then null
      else voided_at
    end
  where id = p_id
  returning * into v_row;

  if v_row.issued_on is not null and v_row.expires_on is not null
     and v_row.expires_on < v_row.issued_on then
    raise exception 'A card cannot run out before the day it was issued.';
  end if;

  return v_row;
end;
$$;

comment on function public.set_certification(uuid, uuid, text, text, date, date, text, boolean, boolean, boolean, boolean) is
  'The one writer for certifications. Adding your OWN card needs no rank and always lands unverified; adding somebody else''s, and every edit, verification and void, is supervisor+. Partial: a null argument leaves that column alone, and a date is cleared through its own flag so verifying cannot wipe an expiry (Wave O, O1).';

revoke all on function public.set_certification(uuid, uuid, text, text, date, date, text, boolean, boolean, boolean, boolean) from public, anon;
grant execute on function public.set_certification(uuid, uuid, text, text, date, date, text, boolean, boolean, boolean, boolean) to authenticated;


-- ---------------------------------------------------------------------------
-- 4. O4 — credential_nudges: a SIBLING ledger, and why it is not pipeline_nudges
-- ---------------------------------------------------------------------------
-- Wave J's section 8 invites this wave to write its kinds into pipeline_nudges,
-- and that was the plan. It does not fit, for one concrete reason that only
-- shows up when you read the table: pipeline_nudges.project_id is
-- `not null references projects(id)`, and its idempotency is the UNIQUE
-- (project_id, kind, on_date). A credential belongs to a PERSON, not a job.
--
-- The two ways to force it in are both worse:
--   * Make project_id nullable. Postgres treats NULLs as DISTINCT in a unique
--     constraint, so (null, 'credential_30d', '2026-10-01') would never
--     conflict with itself and every sweep would push again. The one property
--     the ledger exists for would be gone — silently, and only for the rows
--     that used the null.
--   * Hang the warning off some arbitrary project. There isn't one; a card is
--     not about a job.
--
-- So: the same SHAPE, a table of its own, keyed on the thing the warning is
-- actually about. The spec's own idempotency key — (certification_id, kind,
-- on_date) — is this table's UNIQUE, word for word. Everything else follows
-- wave J exactly: on_date is the day the nudge is ABOUT (the expiry date), not
-- the day it was sent, so a missed morning still says it once, and a RENEWED
-- card with a new expiry date earns a fresh warning, which is right.
--
-- `kind` carries no check constraint, for the same reason J's does not: a
-- later rule about credentials should need no migration.
create table if not exists credential_nudges (
  id uuid primary key default gen_random_uuid(),
  certification_id uuid not null references certifications(id) on delete cascade,
  kind text not null,
  on_date date not null,
  created_at timestamptz not null default now(),
  unique (certification_id, kind, on_date)
);

create index if not exists credential_nudges_cert_idx
  on credential_nudges (certification_id, created_at desc);

comment on table credential_nudges is
  'One row per warning already sent about one card. The sibling of pipeline_nudges, separate only because that table''s project_id is NOT NULL and a certification is about a person: making it nullable would break the unique key that IS the idempotency. on_date is the expiry the warning is about, never the day it was sent (Wave O, O4).';

alter table credential_nudges enable row level security;

revoke all on credential_nudges from anon, authenticated;
grant select on credential_nudges to authenticated;
grant all on credential_nudges to service_role;

-- Readable by signed-in crew, never a partner login (the mechanical wall
-- guard). No insert/update/delete policy at all: the sweep is the only writer
-- and it writes as the service role.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'credential_nudges' and policyname = 'crew read'
  ) then
    create policy "crew read" on credential_nudges
      for select to authenticated
      using (not public.is_partner_user() and (true));
  end if;
end;
$$;


-- ---------------------------------------------------------------------------
-- 5. O4 — who hears about an expiring card
-- ---------------------------------------------------------------------------
-- The person whose card it is, and every supervisor and owner. Not foremen at
-- large: a foreman reading every morning that somebody on another crew has a
-- forklift card running out is how a crew learns to swipe this app's
-- notifications away without reading them, and the supervisors are the ones who
-- book the renewal class.
--
-- An inactive person is skipped — somebody who has left does not need to be
-- told, and neither does anybody else on their behalf. Partner logins never.
create or replace function public.credential_nudge_audience(p_profile_id uuid)
returns uuid[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(array_agg(distinct pr.id), '{}'::uuid[])
    from profiles pr
   where pr.active
     and not coalesce(pr.is_partner, false)
     and (pr.id = p_profile_id or public._is_supervisor(pr.id));
$$;

comment on function public.credential_nudge_audience(uuid) is
  'Who hears that a card is running out: the person it belongs to, plus every active supervisor and owner. Partner logins never (Wave O, O4).';

revoke all on function public.credential_nudge_audience(uuid) from public, anon, authenticated;
grant execute on function public.credential_nudge_audience(uuid) to service_role;


-- ---------------------------------------------------------------------------
-- 6. O4 — claim_credential_nudges: the decision and the claim, in one statement
-- ---------------------------------------------------------------------------
-- Shaped deliberately like claim_pipeline_nudges (20260979000000 section 7),
-- because wave J asked for exactly that: same service-role-only guard, same
-- 7 AM company-local gate, same insert-on-conflict-do-nothing-returning claim
-- so two overlapping sweeps cannot both push.
--
-- THE RULE LIVES TWICE, AND THE COPIES ARE PINNED TOGETHER.
-- app/src/lib/credentials.ts holds the readable version (expiryState /
-- dueCredentialNudges) which drives the chips and the Heartbeat tile;
-- credentials.test.ts carries a test named after this function that spells
-- these clauses out in TypeScript, so a change made to one side and not the
-- other fails a test rather than going quietly live.
--
-- Two rules, and the SPEC ASKS FOR TWO PUSHES: one when the card enters its
-- last thirty days, one on the day it runs out. Both rules key their ledger row
-- on the SAME on_date (the expiry date), so the two windows must not overlap —
-- a day claimed by rule (a) is a day rule (b) can never speak on, because the
-- (certification_id, kind, on_date) row rule (a) wrote weeks earlier is still
-- there. The first cut of this function had (a) at 0..30 and (b) at -30..-1,
-- which meant day 0 fell inside a window already claimed on day 30 and the only
-- other warning landed the morning AFTER the card lapsed. The last day a card
-- is good — the one morning somebody can still act before a gate turns them
-- away — was the one day nothing was said. Hence:
--   (a) 1..30 days out: the card is inside its last thirty days. WINDOWED
--       rather than "exactly 30", so one missed sweep does not silently drop
--       the warning; the unique key already guarantees it is said once per
--       expiry date.
--   (b) -30..0 days out: today IS the day, or the card has already run out.
--       Day 0 lives here rather than in (a) so it gets a ledger key of its own
--       and a sentence of its own ("runs out today", credentialCopy in
--       supabase/functions/pipeline-sweep/index.ts). Windowed backwards for the
--       same self-healing reason: a sweep that misses the day itself still says
--       it the next morning, worded as a lapse. Bounded to the last thirty days
--       on purpose: a card that expired in 2019, typed in today as history,
--       must not wake three supervisors' phones about a fact everybody already
--       knows.
--
-- A VOIDED card is silent, and so is a card belonging to somebody who is no
-- longer active. An UNVERIFIED card still warns — the office not having got
-- round to looking at the paper is not a reason to let the crew member's OSHA
-- card lapse, and the push says nothing about whether it was verified.
create or replace function public.claim_credential_nudges()
returns table (
  certification_id uuid,
  profile_id uuid,
  person_name text,
  cert_kind text,
  cert_label text,
  kind text,
  days_until int,
  expires_on date,
  profile_ids uuid[]
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
-- Several OUT parameters share their names with real columns below
-- (certification_id, profile_id, kind, expires_on). Ambiguity between an OUT
-- parameter and a column is a plpgsql RUNTIME error, not a compile one, so it
-- would first appear at 7 AM in production. Every reference below is
-- table-qualified AND this pragma makes the column win regardless.
#variable_conflict use_column
declare
  v_tz constant text := 'America/Denver';
  v_today date;
  v_hour int;
begin
  if auth.uid() is not null then
    raise exception 'The credential reminder sends itself — nobody needs to press anything.';
  end if;

  v_today := (now() at time zone v_tz)::date;
  v_hour := extract(hour from (now() at time zone v_tz))::int;

  -- Before 7 AM company time there is nothing due. The sweep pokes hourly
  -- rather than once at a fixed UTC hour so "the morning" stays the crew's
  -- morning through both halves of the year; the claim is what makes a repeated
  -- poke free.
  if v_hour < 7 then
    return;
  end if;

  return query
  with candidate as (
    select c.id as cid,
           c.profile_id as pid,
           coalesce(nullif(btrim(pr.display_name), ''), 'Somebody') as who,
           c.kind as ckind,
           case
             when c.kind = 'other' then coalesce(nullif(btrim(c.other_label), ''), 'certification')
             else c.kind
           end as clabel,
           c.expires_on as exp,
           (c.expires_on - v_today)::int as days_out
      from certifications c
      join profiles pr on pr.id = c.profile_id
     where c.voided_at is null
       and c.expires_on is not null
       and pr.active
       and not coalesce(pr.is_partner, false)
  ),
  due as (
    select cd.cid, cd.pid, cd.who, cd.ckind, cd.clabel, cd.exp, cd.days_out,
           'credential_30d'::text as due_kind
      from candidate cd
     where cd.days_out between 1 and 30
    union all
    -- Day 0 is deliberately on THIS side of the line. See the note above.
    select cd.cid, cd.pid, cd.who, cd.ckind, cd.clabel, cd.exp, cd.days_out,
           'credential_expired'::text as due_kind
      from candidate cd
     where cd.days_out between -30 and 0
  ),
  claimed as (
    insert into credential_nudges (certification_id, kind, on_date)
    select d.cid, d.due_kind, d.exp from due d
    on conflict (certification_id, kind, on_date) do nothing
    returning credential_nudges.certification_id as claimed_cid,
              credential_nudges.kind as claimed_kind
  )
  select d.cid,
         d.pid,
         d.who,
         d.ckind,
         d.clabel,
         d.due_kind,
         d.days_out,
         d.exp,
         public.credential_nudge_audience(d.pid)
    from due d
    join claimed cl
      on cl.claimed_cid = d.cid
     and cl.claimed_kind = d.due_kind;
end;
$$;

comment on function public.claim_credential_nudges() is
  'Service-role only (the pipeline-sweep edge function): claims and returns the credential warnings due this company-local morning — a card 1 to 30 days from running out, and a card whose day has come or gone within the last thirty. The two windows do not overlap, because both write the same on_date and a day claimed by one is a day the other can never speak on; day 0 belongs to the second so the last day a card is good gets a warning of its own. The claim and the decision are one statement, so two overlapping sweeps cannot both push. The readable copy of this rule is dueCredentialNudges in app/src/lib/credentials.ts (Wave O, O4).';

revoke all on function public.claim_credential_nudges() from public, anon, authenticated;
grant execute on function public.claim_credential_nudges() to service_role;

-- NO NEW CRON, and no new edge function. Wave J's `pipeline-sweep` already
-- pokes hourly and already loops over a LIST of rules; this wave adds one entry
-- to that list (supabase/functions/pipeline-sweep/index.ts) and nothing else.
-- A second cron job would push at almost the same minute as the first, from a
-- second function nobody remembers to watch.
