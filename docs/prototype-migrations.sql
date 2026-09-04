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
create or replace function public.touch_shift_location(
  p_lat double precision default null,
  p_lng double precision default null
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
         last_seen_lng = coalesce(p_lng, last_seen_lng)
   where profile_id = v_uid
     and status = 'open'
     and clock_out_at is null
  returning id into v_id;

  return v_id;
end;
$$;

comment on function public.touch_shift_location(double precision, double precision) is
  'Self-only: stamps the caller''s own OPEN shift with the moment the app came to the foreground and, when the phone already had permission, where it was. Returns the shift id, or null when the caller is not on the clock (never an error — this runs on every app open). Foreground only; this app has no background location (Wave K, K3).';

revoke all on function public.touch_shift_location(double precision, double precision) from public, anon;
grant execute on function public.touch_shift_location(double precision, double precision) to authenticated;

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
