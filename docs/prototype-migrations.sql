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
-- 20260981000000_gc_handshake.sql (mirrored)
-- Wave H of the transcripts program: the GC handshake, plus one wall fix on the
-- wave before it. H0 MOVES ready_state / materials_eta / materials_arrived_at
-- off `projects` into project_pipeline, because a granted builder (partner)
-- login reads a `projects` row whole and was therefore reading our own "not
-- ready / windows still not in" — the same correction 20260978000000 made for
-- the bid. sort_order stays. H1 adds project_gc_checkins (the six answers,
-- append-only, log_gc_checkin foreman+) and switches on the sweep's fourth
-- reason, "no GC check-in in the last 14 days", which 20260979000000 section 8
-- was written to hand over. H2 adds gc_links and gc_messages: a 32-random-byte
-- token, stored hashed, behind a no-login page whose every read and write goes
-- through the gc-link edge function on the SERVICE ROLE — no anon policy is
-- added to any table here, and a token never grants table access. projects
-- gains gc_brand (stg | forge, RPC-only) so the page and the email wear the
-- brand the office chose for that job. Deploy AFTER 20260979000000 (wave J),
-- whose columns it moves and whose sweep it rewrites — and therefore after
-- 20260980000000 (wave X), which merged first.
-- ===========================================================================
-- Wave H — The GC handshake (transcripts program, grill of 2026-09-03, Q10 +
-- Q11 + Q20), plus one wall fix on the wave that came before it.
--
-- Three things happen here:
--
--   H0  ready_state, materials_eta and materials_arrived_at MOVE off `projects`
--       into a crew-only side table. Wave J weighed leaving them there and
--       decided they were harmless; they are not. A builder (partner) login
--       granted a job reads the whole `projects` row, so "your windows have not
--       arrived" was readable by the general contractor — which is the exact
--       fact this wave exists to let us tell a GC on OUR schedule, in our own
--       words, on a page we built for the purpose.
--
--   H1  project_gc_checkins — the six answers somebody gets off the GC on the
--       phone, filed once, append-only, and read by the sweep so "nobody has
--       called this builder in a fortnight" finally counts for something.
--
--   H2  gc_links + gc_messages — a no-login page a GC opens from a text or an
--       email, answers the same six questions on, and asks a question back
--       through. Every read and write on that page goes through the gc-link
--       edge function on the service role. NO ANON POLICY IS ADDED TO ANY TABLE
--       BY THIS MIGRATION: a token is a key to a function, never to a table.
--
-- Idempotent throughout (add column if not exists / create ... if not exists /
-- create or replace / drop ... if exists before a signature change), so
-- re-running it changes nothing.
--
-- Timezone: 'America/Denver' spelled out, the same company-local day every
-- clock gate and both sweeps use. There is no shared helper — the convention IS
-- the literal.

-- ===========================================================================
-- H0. The wall fix: the pipeline facts move off `projects`
-- ===========================================================================
-- WHY THIS IS A BUG AND NOT A PREFERENCE. `projects` is the one table a partner
-- login reads whole, row-level, for each job they were granted (THE WALL,
-- 20260950000000 section 6). RLS has no column-level half. So when wave J put
-- readiness and the two materials dates on that table, it handed every granted
-- builder a live feed of whether we are behind on their house — no push
-- required, just the row. 20260979000000's own reasoning says a builder "is
-- never PUSHED about our problems", and that is true of the sweep and false of
-- the table.
--
-- The three facts are not secrets in the way a bid is. They are worse: they are
-- OUR OPERATIONAL STATE, and the whole point of wave H is that a GC learns
-- where we are from a conversation we start — a check-in, a link, an email —
-- and not by refreshing a portal at 6 AM. "Not ready" is a note we write to
-- ourselves about a site nobody has walked yet. Read by the builder who owns
-- that site, it is an accusation.
--
-- The shape is Z's, verbatim: a side table with its own policy, one row per
-- job, project_id as the primary key (a job has one pipeline state, and a
-- surrogate id would invite two). 20260978000000 moved bid_amount and
-- target_margin_pct off `projects` for exactly this reason and left the note
-- saying so; this is the second time, and the note was right.
--
-- sort_order STAYS on `projects`. It is a bare integer whose meaning is "fourth
-- in a list a builder cannot see", it orders every one of those lists in SQL,
-- and moving it would put a join in the hot path of the app shell to hide a
-- number that says nothing.
create table if not exists project_pipeline (
  project_id uuid primary key references projects(id) on delete cascade,
  -- Same default as the column it replaces: every job that already existed is
  -- ready, because nobody has ever been able to say otherwise about them.
  ready_state text not null default 'ready',
  materials_eta date,
  materials_arrived_at timestamptz,
  updated_at timestamptz not null default now(),
  -- Filled by the RPCs below (auth.uid()), never by a client: who last said a
  -- job was ready is not something the browser gets to claim. Null under the
  -- service role or a SQL console, which is the honest answer there.
  updated_by uuid references profiles(id) on delete set null
);

alter table project_pipeline drop constraint if exists project_pipeline_ready_state_check;
alter table project_pipeline add constraint project_pipeline_ready_state_check
  check (ready_state in ('not_ready', 'ready'));

comment on table project_pipeline is
  'One job''s readiness and materials dates, moved off `projects` (20260979000000) by wave H so they can carry a policy of their own. A partner login reads the whole `projects` row for a job it was granted, so anything about how WE are doing has to live somewhere else — the same reasoning that moved the bid to project_financials. Written only by set_project_readiness / set_project_materials (foreman+); read by any crew login, never by a partner.';

comment on column project_pipeline.ready_state is
  'not_ready | ready — whether the site is ready for us to work. Existing jobs are ready; Monday imports and one-tap tracking jobs are born not_ready.';
comment on column project_pipeline.materials_eta is
  'The day the windows are expected on this job (job-level, not package_deliveries.expected_at, which is one truck).';
comment on column project_pipeline.materials_arrived_at is
  'When somebody tapped "Materials arrived". Null means the windows are still not in — and, with no materials_eta, that nobody has said anything either way, which is why both the sweep and needsCall read the pair.';

-- Backfill BEFORE the drop and only while the old columns still exist, so a
-- second run of this file is a no-op instead of an error. `on conflict do
-- nothing` protects a row the app has already written since.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'projects' and column_name = 'ready_state'
  ) then
    execute $q$
      insert into project_pipeline (project_id, ready_state, materials_eta, materials_arrived_at)
      select id,
             coalesce(ready_state, 'ready'),
             materials_eta,
             materials_arrived_at
        from projects
       where ready_state is distinct from 'ready'
          or materials_eta is not null
          or materials_arrived_at is not null
      on conflict (project_id) do nothing
    $q$;
  end if;
end;
$$;

alter table projects drop constraint if exists projects_ready_state_check;
alter table projects drop column if exists ready_state;
alter table projects drop column if exists materials_eta;
alter table projects drop column if exists materials_arrived_at;

alter table project_pipeline enable row level security;

-- Revoke BEFORE granting: this project's default privileges hand every new
-- table in `public` the full set to `authenticated`, and RLS alone is not the
-- place to stand. SELECT only — both writers are SECURITY DEFINER RPCs with a
-- rank check in the body, because "is this job ready" is a foreman's call and a
-- column grant cannot check a rank.
revoke all on project_pipeline from anon, authenticated;
grant select on project_pipeline to authenticated;
grant all on project_pipeline to service_role;

-- Any signed-in crew member reads it, and no partner ever does. An installer
-- opening a job wants to know there is no glass on site just as much as the
-- office does — hiding that behind a rank is how a crew drives to a job that
-- was never going to happen.
drop policy if exists "pipeline_crew_read" on project_pipeline;
create policy "pipeline_crew_read" on project_pipeline
  for select to authenticated
  using (not public.is_partner_user() and (true));

-- THE PROJECTS GRANT LAW (wave D, 20260959000000, re-stated by wave Z): the
-- table-level INSERT/UPDATE on `projects` is revoked and only the columns the
-- app writes directly are granted back. Dropping a column drops its privilege
-- with it, so the lists are re-stated here. Re-stating them is the law's point:
-- a reader should learn what is writable from the newest migration that touched
-- this table rather than by diffing three of them.
--
-- A RE-STATEMENT IS THE WHOLE WRITABLE SET, NEVER A COPY OF THE LAST ONE.
-- `stories` is in both lists below and must stay there. Wave X (20260980000000)
-- granted it one migration number earlier and ADDITIVELY — a bare
-- `grant insert (stories)` with no revoke of its own. A table-level
-- `revoke insert, update` takes every COLUMN-level grant of those privileges
-- with it, so the revoke on the next line un-grants `stories` and only these
-- lists put it back. Copying wave Z's lists, which predate the column, was the
-- first cut of this file and it lost the privilege silently: nothing errors,
-- because api.ts's isMissingStoriesColumn reads the 42501 as "that column is
-- not deployed yet", drops `stories` from the write and retries — so the save
-- succeeds and the storey count a foreman typed is quietly gone. Wave X's own
-- header names this file's hazard; scripts/migration_lint.py
-- (shrinking_grants) now fails the merge gate on it, which is the only reason
-- the paragraph above can be trusted by the next wave to restate these lists.
--
-- Deliberately absent and staying absent: the three columns dropped above (all
-- RPC-only, never named here), and gc_brand, which section H2 adds RPC-only
-- behind set_project_gc_brand.
revoke insert, update on table projects from anon, authenticated;
grant insert (job_code, name, address, customer_name, contact_phone,
              contact_email, site_state, unit_number, start_date, end_date,
              notes, stories)
  on projects to authenticated;
grant update (name, address, customer_name, contact_phone, contact_email,
              site_state, unit_number, start_date, end_date, notes,
              estimated_minutes, estimated_crew, estimated_at, stories)
  on projects to authenticated;

-- ---------------------------------------------------------------------------
-- H0. set_project_readiness — same name, same arguments, new home
-- ---------------------------------------------------------------------------
-- The RETURN TYPE changes (a `projects` row no longer carries these facts), and
-- Postgres will not let CREATE OR REPLACE change one, so the old function is
-- dropped first. Its only caller is lib/api.ts's wrapper, which has always
-- ignored the returned row.
drop function if exists public.set_project_readiness(uuid, text);

create or replace function public.set_project_readiness(
  p_project_id uuid,
  p_ready_state text
)
returns project_pipeline
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row project_pipeline;
begin
  if not _is_lead(auth.uid()) then
    raise exception 'Only a foreman or above can say whether a job is ready.';
  end if;
  if p_ready_state is null or p_ready_state not in ('not_ready', 'ready') then
    raise exception 'A job is either ready or not ready — nothing else.';
  end if;
  if not exists (select 1 from projects where id = p_project_id) then
    raise exception 'That job does not exist.';
  end if;

  insert into project_pipeline (project_id, ready_state, updated_at, updated_by)
  values (p_project_id, p_ready_state, now(), auth.uid())
  on conflict (project_id) do update
    set ready_state = excluded.ready_state,
        updated_at = now(),
        updated_by = auth.uid()
  returning * into v_row;

  return v_row;
end;
$$;

comment on function public.set_project_readiness(uuid, text) is
  'Foreman+: mark a job Ready or Not ready. Writes project_pipeline, not `projects` — wave H moved the fact off a table a granted builder reads whole. SECURITY DEFINER because the side table grants no write to any client role; the rank check belongs in a body, not in a column grant.';

revoke all on function public.set_project_readiness(uuid, text) from public, anon;
grant execute on function public.set_project_readiness(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- H0. set_project_materials — same name, same arguments, new home
-- ---------------------------------------------------------------------------
-- The argument contract is untouched, and it is worth restating because it is
-- load-bearing: nulls mean LEAVE THAT FACT ALONE, and the two ways of erasing
-- one are said out loud. "Null clears it" would make the one-tap "Materials
-- arrived" button wipe the ETA every time it was pressed, because that call has
-- no ETA to send.
drop function if exists public.set_project_materials(uuid, date, boolean, boolean);

create or replace function public.set_project_materials(
  p_project_id uuid,
  p_materials_eta date default null,
  p_clear_eta boolean default false,
  p_arrived boolean default null
)
returns project_pipeline
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row project_pipeline;
begin
  if not _is_lead(auth.uid()) then
    raise exception 'Only a foreman or above can set when the windows are coming.';
  end if;
  if not exists (select 1 from projects where id = p_project_id) then
    raise exception 'That job does not exist.';
  end if;

  -- The row may not exist yet (a job nobody has touched since wave H), so this
  -- is an upsert whose INSERT branch applies the same three-way logic against
  -- "no row" that the UPDATE branch applies against the stored one.
  insert into project_pipeline (project_id, materials_eta, materials_arrived_at, updated_at, updated_by)
  values (
    p_project_id,
    case when coalesce(p_clear_eta, false) then null else p_materials_eta end,
    case when p_arrived is true then now() else null end,
    now(),
    auth.uid()
  )
  on conflict (project_id) do update
    set materials_eta = case
          when coalesce(p_clear_eta, false) then null
          when p_materials_eta is not null then p_materials_eta
          else project_pipeline.materials_eta
        end,
        materials_arrived_at = case
          -- Arriving twice must not move the time: the first tap is when the
          -- truck actually showed up, and a second tap (a mis-tap, a refresh,
          -- a second person confirming) should not quietly rewrite it.
          when p_arrived is true then coalesce(project_pipeline.materials_arrived_at, now())
          when p_arrived is false then null
          else project_pipeline.materials_arrived_at
        end,
        updated_at = now(),
        updated_by = auth.uid()
  returning * into v_row;

  return v_row;
end;
$$;

comment on function public.set_project_materials(uuid, date, boolean, boolean) is
  'Foreman+: set or clear a job''s window ETA and record that the windows arrived (or un-record it). Writes project_pipeline (wave H moved the facts off `projects`). Null arguments mean "leave that fact alone" so the one-tap Materials-arrived call cannot wipe the ETA.';

revoke all on function public.set_project_materials(uuid, date, boolean, boolean) from public, anon;
grant execute on function public.set_project_materials(uuid, date, boolean, boolean) to authenticated;

-- ===========================================================================
-- H1. project_gc_checkins — what the general contractor actually said
-- ===========================================================================
-- Six questions get asked on every job, and the answers used to live in
-- somebody's memory of a phone call: when does the GC think the house is
-- finished, when does the roof go on, has the framing been checked, does he
-- want the windows inset or outset, and what is going on the outside and the
-- inside. Six answers, one row, and the row IS the record that somebody talked
-- to the builder.
--
-- APPEND-ONLY, and that is the design rather than an omission. A check-in is
-- what a person said on a day. If the GC changes his mind next week that is a
-- SECOND check-in, and the pair of them is the story: "he told us the 14th in
-- August and the 28th in September" is a fact worth having, and an UPDATE would
-- erase it. There is no update or delete policy on this table at all, and the
-- one writer below only ever inserts.
--
-- All six are NOT NULL. A half-filled check-in is worse than none: it looks
-- like somebody asked, and the next person to open the job believes it.
--
-- inset/outset here is the GC's JOB-LEVEL answer, and it does not decide
-- anything about a unit. The per-unit spec field in the signature stays
-- authoritative for what actually gets installed where — this is what the
-- builder SAID he wanted, which is a different fact and sometimes a different
-- answer.
create table if not exists project_gc_checkins (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  -- Who filed it. Null when the GC answered on the no-login page (there is no
  -- profile to point at) and when a crew member's account is later removed.
  author_id uuid references profiles(id) on delete set null,
  -- When the conversation happened, which is not always when it was typed up.
  contacted_at timestamptz not null default now(),
  contact_name text,
  channel text not null,
  expected_end_date date not null,
  roof_on_date date not null,
  framing_checked boolean not null,
  set_preference text not null,
  exterior_material text not null,
  interior_material text not null,
  notes text,
  -- 'crew' — somebody in the office filed it after a call. 'gc' — the builder
  -- answered it himself on the link. The difference matters when the answers
  -- disagree: one of them is a memory of a phone call and the other is the
  -- builder's own typing.
  source text not null default 'crew',
  created_at timestamptz not null default now()
);

alter table project_gc_checkins drop constraint if exists project_gc_checkins_channel_check;
alter table project_gc_checkins add constraint project_gc_checkins_channel_check
  -- 'link' is the GC answering on his own page (H2). It is deliberately NOT
  -- offered to a crew member by log_gc_checkin below — nobody in the office
  -- ever talked to the builder "on the link" — so the constraint is wider than
  -- the RPC on purpose rather than by accident.
  check (channel in ('call', 'text', 'email', 'site', 'link'));

alter table project_gc_checkins drop constraint if exists project_gc_checkins_set_pref_check;
alter table project_gc_checkins add constraint project_gc_checkins_set_pref_check
  check (set_preference in ('inset', 'outset', 'unknown'));

alter table project_gc_checkins drop constraint if exists project_gc_checkins_source_check;
alter table project_gc_checkins add constraint project_gc_checkins_source_check
  check (source in ('crew', 'gc'));

-- The sweep asks "when was the last one on this job" for every active job every
-- morning, and the GC card asks the same question about one job. Both are this
-- index.
create index if not exists project_gc_checkins_project_idx
  on project_gc_checkins (project_id, contacted_at desc);

comment on table project_gc_checkins is
  'One conversation with a job''s general contractor: the six standing questions, who said it, how, and when. Append-only — a changed answer is a second row, and the pair is the story. source = crew (the office filed it after a call) or gc (the builder answered on the no-login link). Filing one is what "communicated with the GC" means, and the 7 AM sweep reads the latest one.';

alter table project_gc_checkins enable row level security;

-- Revoke BEFORE granting: this project's default privileges hand every new
-- table in `public` the full set to `authenticated`. SELECT only — the RPC
-- below is the only writer, so append-only is a fact about the grants and not
-- just about the code.
revoke all on project_gc_checkins from anon, authenticated;
grant select on project_gc_checkins to authenticated;
grant all on project_gc_checkins to service_role;

-- Any signed-in crew member reads it, and no partner ever does. THE WALL, and
-- more than mechanically: this table holds one side of a conversation with the
-- builder, written by us, and a builder login reading our own notes about
-- talking to him is the same mistake H0 just undid.
drop policy if exists "gc_checkins_crew_read" on project_gc_checkins;
create policy "gc_checkins_crew_read" on project_gc_checkins
  for select to authenticated
  using (not public.is_partner_user() and (true));

-- ---------------------------------------------------------------------------
-- H1. log_gc_checkin (foreman+)
-- ---------------------------------------------------------------------------
-- Validated in here as well as in the browser, because the browser's copy is a
-- courtesy and this one is the rule. Every refusal is a sentence somebody in a
-- truck can act on — "Say when the GC expects the house to be finished", not
-- "null value in column expected_end_date violates not-null constraint".
create or replace function public.log_gc_checkin(
  p_project_id uuid,
  p_expected_end_date date,
  p_roof_on_date date,
  p_framing_checked boolean,
  p_set_preference text,
  p_exterior_material text,
  p_interior_material text,
  p_channel text default 'call',
  p_contact_name text default null,
  p_notes text default null,
  p_contacted_at timestamptz default null
)
returns project_gc_checkins
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row project_gc_checkins;
begin
  if not _is_lead(auth.uid()) then
    raise exception 'Only a foreman or above can file a GC check-in.';
  end if;
  if not exists (select 1 from projects where id = p_project_id) then
    raise exception 'That job does not exist.';
  end if;

  if p_expected_end_date is null then
    raise exception 'Say when the GC expects the house to be finished.';
  end if;
  if p_roof_on_date is null then
    raise exception 'Say when the roof goes on.';
  end if;
  if p_framing_checked is null then
    raise exception 'Say whether the framing has been checked.';
  end if;
  if coalesce(p_set_preference, '') not in ('inset', 'outset', 'unknown') then
    raise exception 'Say whether the GC wants the windows inset, outset, or that he has not said.';
  end if;
  if coalesce(btrim(p_exterior_material), '') = '' then
    raise exception 'Say what is going on the outside.';
  end if;
  if coalesce(btrim(p_interior_material), '') = '' then
    raise exception 'Say what is going on the inside.';
  end if;
  if coalesce(p_channel, '') not in ('call', 'text', 'email', 'site') then
    raise exception 'Say how you talked to the GC: a call, a text, an email, or on site.';
  end if;

  insert into project_gc_checkins (
    project_id, author_id, contacted_at, contact_name, channel,
    expected_end_date, roof_on_date, framing_checked, set_preference,
    exterior_material, interior_material, notes, source
  )
  values (
    p_project_id,
    auth.uid(),
    -- A check-in typed up the morning after is dated to the conversation, not
    -- to the typing. Null means "just now", which is the common case.
    coalesce(p_contacted_at, now()),
    nullif(btrim(coalesce(p_contact_name, '')), ''),
    p_channel,
    p_expected_end_date,
    p_roof_on_date,
    p_framing_checked,
    p_set_preference,
    btrim(p_exterior_material),
    btrim(p_interior_material),
    nullif(btrim(coalesce(p_notes, '')), ''),
    'crew'
  )
  returning * into v_row;

  return v_row;
end;
$$;

comment on function public.log_gc_checkin(uuid, date, date, boolean, text, text, text, text, text, text, timestamptz) is
  'Foreman+: file one conversation with a job''s GC — the six standing answers plus who, how and any notes. Append-only; a changed answer is a second row. SECURITY DEFINER because project_gc_checkins grants no INSERT to any client role, which is what makes append-only a fact about the grants rather than a promise about the code.';

revoke all on function public.log_gc_checkin(uuid, date, date, boolean, text, text, text, text, text, text, timestamptz) from public, anon;
grant execute on function public.log_gc_checkin(uuid, date, date, boolean, text, text, text, text, text, text, timestamptz) to authenticated;

-- ---------------------------------------------------------------------------
-- H0 + H1. The 7 AM sweep: the new home, and the fourth reason
-- ---------------------------------------------------------------------------
-- Two changes, and they arrive together because the function has to be dropped
-- and recreated either way — Postgres will not let CREATE OR REPLACE change a
-- function's OUT columns, and the second change adds one.
--
-- H0. claim_pipeline_nudges() decided from three columns on `projects`; they
-- are gone, so its candidate CTE joins project_pipeline instead. A LEFT JOIN
-- with coalesce, not an inner one: a job nobody has ever set readiness on has
-- no row there at all, and it is READY — the same answer the NOT NULL DEFAULT
-- gave when these were columns, and the only one that does not put a red flag
-- on every job in the company the morning this deploys.
--
-- H1. THE FOURTH REASON, which 20260979000000 section 8 was written to hand
-- over: "no GC check-in in the last 14 days", as one more OR beside
-- ready_state = 'not_ready'. Wave J left it out because project_gc_checkins did
-- not exist and a rule reading a missing table either breaks the sweep or fires
-- on every job in the company. The table exists now, and here is the thing
-- worth saying out loud before this ships:
--
--   IT WILL FIRE ON EVERY JOB STARTING INSIDE A FORTNIGHT, on the first
--   morning, because no job in the company has ever had a check-in filed. THAT
--   IS THE POINT AND NOT A BUG. Unlike materials_arrived_at — where a blank
--   meant "nobody could record it" and counting it would have been a lie — a
--   missing check-in now means exactly what it says: nobody has talked to that
--   builder, and somebody should. The list empties itself as the calls get
--   made, one row each.
--
-- THE RULE STILL LIVES TWICE AND THE COPIES ARE STILL PINNED. The readable
-- version is needsCall / dueNudges in app/src/lib/pipeline.ts; this body is the
-- one the sweep runs, because it has to decide and claim in one statement or
-- two overlapping sweeps both push. pipeline.test.ts carries a block named
-- after this function that spells these clauses out in TypeScript, including
-- the fourteen days.
drop function if exists public.claim_pipeline_nudges();

create or replace function public.claim_pipeline_nudges()
returns table (
  project_id uuid,
  job_label text,
  kind text,
  days_until int,
  not_ready boolean,
  materials_missing boolean,
  no_gc_checkin boolean,
  profile_ids uuid[]
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
-- The OUT columns above share their names with real columns in the query below.
-- Ambiguity between an OUT parameter and a column is a plpgsql RUNTIME error,
-- not a compile one, so it would first appear at 7 AM in production. Every
-- reference below is table-qualified AND this pragma makes the column win
-- regardless — belt and braces on a function nobody watches run.
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
           -- No row means nobody has ever said anything about this job, and
           -- that job is READY — the same answer wave J's NOT NULL DEFAULT gave
           -- while these were columns, and the only one that does not red-flag
           -- every job in the company on the morning the table appears.
           coalesce(pp.ready_state, 'ready') as ready,
           pp.materials_eta as eta,
           pp.materials_arrived_at as arrived_at,
           -- The company-local DAY of the most recent conversation, so "14
           -- days ago" means fourteen of the crew's days and not fourteen
           -- times twenty-four hours measured in UTC. Null means there has
           -- never been one, which is itself the thing worth calling about.
           (select max((g.contacted_at at time zone v_tz)::date)
              from project_gc_checkins g
             where g.project_id = p.id) as last_checkin_day
      from projects p
      left join project_pipeline pp on pp.project_id = p.id
     where p.status = 'active'
       and p.deleted_at is null
  ),
  due as (
    -- (a) starting soon, and still not ready or the promised windows are not
    --     here. "Promised" is c.eta is not null — a job nobody promised windows
    --     for cannot be missing them.
    select c.pid,
           c.label,
           case when c.days_out > 7 then 'start_14' else 'start_7' end::text as due_kind,
           (v_today + c.days_out) as due_date,
           c.days_out,
           c.ready = 'not_ready' as flag_not_ready,
           (c.eta is not null and c.arrived_at is null) as flag_no_materials,
           (c.last_checkin_day is null or c.last_checkin_day <= v_today - 14) as flag_no_checkin
      from candidate c
     where c.days_out between 0 and 14
       and (
         c.ready = 'not_ready'
         or (c.eta is not null and c.arrived_at is null)
         or c.last_checkin_day is null
         or c.last_checkin_day <= v_today - 14
       )
    union all
    -- (b) the promised day came and went and nothing is here.
    select c.pid,
           c.label,
           'materials_late'::text as due_kind,
           c.eta as due_date,
           c.days_out,
           c.ready = 'not_ready' as flag_not_ready,
           true as flag_no_materials,
           -- Late windows are their own message. Whether anybody has called
           -- the builder lately is not part of it, and saying so here would
           -- pad a sentence that is already the only one that matters.
           false as flag_no_checkin
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
         d.flag_no_checkin,
         public.pipeline_nudge_audience(d.pid)
    from due d
    join claimed cl
      on cl.claimed_pid = d.pid
     and cl.claimed_kind = d.due_kind;
end;
$$;

comment on function public.claim_pipeline_nudges() is
  'Service-role only (the pipeline-sweep edge function): claims and returns the job warnings due this company-local morning — 14 and 7 days before a start date on a job that is still not ready, has no windows, or has had no GC check-in in a fortnight, and the morning after a missed materials ETA. Reads project_pipeline (wave H moved readiness and the materials dates off `projects`); a job with no row there is ready. The claim and the decision are one statement, so two overlapping sweeps cannot both push. The readable copy of this rule is needsCall/dueNudges in app/src/lib/pipeline.ts.';

revoke all on function public.claim_pipeline_nudges() from public, anon, authenticated;
grant execute on function public.claim_pipeline_nudges() to service_role;

-- ===========================================================================
-- H2. The GC's own page: gc_brand, gc_links, gc_messages
-- ===========================================================================
-- A general contractor does not have a login here and is never going to want
-- one. He gets a link in a text or an email, opens it on his phone, answers the
-- same six questions, and can ask a question back. That is the whole feature.
--
-- HOW THE TOKEN IS SAFE, said plainly because this is the first thing in this
-- schema a stranger on the internet can reach with a credential we minted:
--
--   * 32 random bytes — 256 bits. There is no guessing it, and no rate limit
--     is what makes that true; the entropy is.
--   * STORED HASHED (sha256, hex). A database backup, a support query, a
--     screenshot of a table: none of them hand anybody a working link.
--   * IT IS A KEY TO A FUNCTION, NEVER TO A TABLE. No policy in this migration
--     grants anon anything. Everything the page reads and writes goes through
--     the gc-link edge function on the service role, which builds its answer
--     field by field (wave S's projection law) from exactly four things: the
--     job's name, the brand, the six questions with any prior answers, and the
--     thread. A crew login pointing the same token at PostgREST directly gets
--     nothing it could not already read, because the token is not a grant.
--   * 30 days, then it stops working. Revocable at any time, from the card.
--
-- WHAT THE GC NEVER SEES, and this is the whole reason H0 came first: our
-- readiness, our materials dates, our schedule, our costs, our crew. The page
-- shows him the questions and his own answers. It is a conversation we started,
-- not a window into the company.

-- ---- The brand this job is presented under (Q20, the owner's design) --------
-- One company, two names, and which one a customer hears is a per-JOB decision
-- rather than a company-wide setting: some builders know us as STG Windows &
-- Doors and some as Forge, and the wrong name on an email is the kind of small
-- wrong thing that makes somebody wonder who they are actually dealing with.
--
-- On `projects` rather than on gc_links, because a job's brand outlives any one
-- link — revoke and resend and it is still the same relationship — and because
-- the page header and the email subject both need it. RPC-ONLY under the
-- projects grant law: it is deliberately NOT added to the insert or update
-- grant lists restated in section H0 above, so set_project_gc_brand is the only
-- writer. A granted builder reading it learns which of our two names we use
-- with them, which they already know.
alter table projects
  add column if not exists gc_brand text not null default 'stg';

alter table projects drop constraint if exists projects_gc_brand_check;
alter table projects add constraint projects_gc_brand_check
  check (gc_brand in ('stg', 'forge'));

comment on column projects.gc_brand is
  'stg | forge — which of the company''s two names this job''s general contractor hears, on the GC page and in the email. Default stg, the outward-facing brand. Written only by set_project_gc_brand (foreman+); deliberately absent from the projects grant lists.';

create or replace function public.set_project_gc_brand(
  p_project_id uuid,
  p_brand text
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
    raise exception 'Only a foreman or above can choose which name the GC sees.';
  end if;
  if coalesce(p_brand, '') not in ('stg', 'forge') then
    raise exception 'The GC sees us as STG Windows & Doors or as Forge Windows and Doors — nothing else.';
  end if;

  update projects set gc_brand = p_brand where id = p_project_id
  returning * into v_row;

  if not found then
    raise exception 'That job does not exist.';
  end if;

  return v_row;
end;
$$;

comment on function public.set_project_gc_brand(uuid, text) is
  'Foreman+: choose which of the company''s two names this job''s GC sees on his page and in his email. SECURITY DEFINER because gc_brand is deliberately off the projects grant lists — a column grant cannot check a rank.';

revoke all on function public.set_project_gc_brand(uuid, text) from public, anon;
grant execute on function public.set_project_gc_brand(uuid, text) to authenticated;

-- ---- gc_links ---------------------------------------------------------------
create table if not exists gc_links (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  -- The credential, hashed. UNIQUE so a hash collision or a double-insert is a
  -- constraint error rather than two links that both open one job.
  token_hash text not null unique,
  -- A RECORD OF THE NAME WE USED WHEN THIS LINK WENT OUT, not the name the
  -- page wears today. Every live read — gc_link_open, the send-email function
  -- — takes projects.gc_brand instead, so tapping the brand pill changes the
  -- builder's open page and the next email. Kept because "which name did that
  -- email say" is a real question months later, and the sent mail cannot be
  -- edited to match a later change of mind.
  brand text not null default 'stg',
  -- Who the office meant to mail. Written at mint time; it is an INTENT, and
  -- on its own it is not evidence that anything was delivered.
  sent_to_email text,
  sent_by uuid references profiles(id) on delete set null,
  -- WRITTEN ONLY BY THE send-email FUNCTION, ONLY ON A REAL 2xx FROM RESEND.
  -- The first cut stamped it here at mint time alongside sent_to_email, which
  -- made the card say "Sent to bob@builder.com" for a link no mail server ever
  -- saw — including the RESEND_API_KEY-unset case, where the only honest thing
  -- to tell a foreman is "copy it and text it". Null means nothing has left the
  -- building, and the card says so.
  sent_at timestamptz,
  -- Thirty days. Long enough to survive a builder who reads his email weekly,
  -- short enough that a forwarded text from last spring is dead.
  expires_at timestamptz not null default now() + interval '30 days',
  -- The first time anybody answered anything on it. Not "opened" — a link the
  -- GC looked at and closed has told us nothing.
  used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  -- Rate limiting, on the row rather than in a side table: the row IS the
  -- rate-limit subject, one link is one conversation, and a table of attempts
  -- would need its own purge.
  post_count int not null default 0,
  last_post_at timestamptz,
  -- Reads are COUNTED, not limited. Refusing a refresh loop would lock out the
  -- one person the link exists for, and a read costs a lookup; 256 bits of
  -- token is what stops a stranger, not a counter.
  hit_count int not null default 0,
  last_hit_at timestamptz
);

alter table gc_links drop constraint if exists gc_links_brand_check;
alter table gc_links add constraint gc_links_brand_check
  check (brand in ('stg', 'forge'));

-- One job's links, newest first — what the GC card lists, and how "is there a
-- live link on this job" is answered.
create index if not exists gc_links_project_idx
  on gc_links (project_id, created_at desc);

comment on table gc_links is
  'A no-login link handed to one job''s general contractor. token_hash is sha256 of 32 random bytes; the plaintext is returned by create_gc_link ONCE and never stored, so a link that was not copied or emailed is gone and a fresh one gets minted. 30-day expiry, revocable. NO ROLE HAS ANY POLICY TO WRITE THIS TABLE and anon has none at all: the token is a key to the gc-link edge function, never to a table.';

alter table gc_links enable row level security;

revoke all on gc_links from anon, authenticated;
grant select on gc_links to authenticated;
grant all on gc_links to service_role;

-- Crew read, never a partner. The office has to be able to see that a link is
-- out, when it was sent and to whom — and the token is not in this table in any
-- usable form, so reading it hands nobody the ability to open the page.
drop policy if exists "gc_links_crew_read" on gc_links;
create policy "gc_links_crew_read" on gc_links
  for select to authenticated
  using (not public.is_partner_user() and (true));

-- ---- gc_messages -------------------------------------------------------------
-- The thread. Two people talk on it: the general contractor, on his page, and
-- the office, from the GC card.
--
-- NEVER CREW CHAT. project_messages is where the crew talks to each other about
-- a job, and it is walled from partners for a reason; putting an outsider's
-- words in it — or letting him read what is already there — is the one mistake
-- that would make this feature dangerous rather than useful. Two tables, no
-- join between them, and nothing on this one is shown on the chat tab.
create table if not exists gc_messages (
  id uuid primary key default gen_random_uuid(),
  -- Which link it came in on. SET NULL rather than CASCADE: revoking a link
  -- must not delete what the builder already said.
  gc_link_id uuid references gc_links(id) on delete set null,
  project_id uuid not null references projects(id) on delete cascade,
  -- 'gc' — the builder typed it on his page. 'office' — one of ours replied.
  author text not null,
  -- Who, when it was one of ours. Always null for a GC message: there is no
  -- profile to point at, and that is the honest answer.
  author_profile_id uuid references profiles(id) on delete set null,
  body text not null,
  created_at timestamptz not null default now()
);

alter table gc_messages drop constraint if exists gc_messages_author_check;
alter table gc_messages add constraint gc_messages_author_check
  check (author in ('gc', 'office'));

create index if not exists gc_messages_project_idx
  on gc_messages (project_id, created_at);

comment on table gc_messages is
  'The thread between one job''s general contractor and the office. Deliberately NOT project_messages: crew chat is walled from outsiders, and an outsider''s words must not land in it nor his eyes on what is already there. Written only by post_gc_message (office, foreman+) and gc_link_say (the GC, through the edge function on the service role).';

alter table gc_messages enable row level security;

revoke all on gc_messages from anon, authenticated;
grant select on gc_messages to authenticated;
grant all on gc_messages to service_role;

drop policy if exists "gc_messages_crew_read" on gc_messages;
create policy "gc_messages_crew_read" on gc_messages
  for select to authenticated
  using (not public.is_partner_user() and (true));

-- ---------------------------------------------------------------------------
-- H2. create_gc_link (foreman+) — the only place a token is ever born
-- ---------------------------------------------------------------------------
-- Returns the PLAINTEXT token exactly once, to the person who pressed the
-- button. It is never stored, never logged and cannot be recovered: "send it
-- again" mints a fresh link and revokes the old one, which is both simpler than
-- keeping a secret around and better hygiene — a resend rotates the credential.
--
-- ONE LIVE LINK PER JOB. Any earlier link on the same job is revoked in the
-- same statement, so a builder who was sent two links last month cannot answer
-- on the older one and have it look current.
create or replace function public.create_gc_link(
  p_project_id uuid,
  p_email text default null,
  p_brand text default null
)
returns table (link_id uuid, token text, expires_at timestamptz, brand text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
-- The OUT columns (brand, expires_at) share their names with real columns of
-- gc_links. Ambiguity between an OUT parameter and a column is a plpgsql
-- RUNTIME error, not a compile one, so make the column win — the same pragma
-- and the same reason as claim_pipeline_nudges above.
#variable_conflict use_column
declare
  v_token text;
  v_hash text;
  v_brand text;
  v_row gc_links;
begin
  if not _is_lead(auth.uid()) then
    raise exception 'Only a foreman or above can hand a job to its GC.';
  end if;
  if not exists (select 1 from projects where id = p_project_id) then
    raise exception 'That job does not exist.';
  end if;
  if p_brand is not null and p_brand not in ('stg', 'forge') then
    raise exception 'The GC sees us as STG Windows & Doors or as Forge Windows and Doors — nothing else.';
  end if;

  -- The job's own brand unless the caller names one, so the page and the email
  -- match whatever the office chose on this job.
  select coalesce(p_brand, pr.gc_brand, 'stg') into v_brand
    from projects pr where pr.id = p_project_id;

  -- base64url: the standard alphabet's + and / become - and _, and translate
  -- drops the padding = because it has no replacement character. 43 characters,
  -- safe in a URL and in a text message.
  v_token := translate(encode(extensions.gen_random_bytes(32), 'base64'), '+/=', '-_');
  v_hash := encode(extensions.digest(v_token, 'sha256'), 'hex');

  update gc_links
     set revoked_at = now()
   where gc_links.project_id = p_project_id
     and gc_links.revoked_at is null;

  -- sent_at IS DELIBERATELY NOT SET HERE. Minting a link sends nothing — the
  -- send-email edge function does that, and stamps sent_at itself on a real 2xx
  -- from Resend. Stamping it here (the first cut did, whenever an address was
  -- supplied) makes every link look delivered the instant it exists, which is
  -- exactly wrong in the case that matters most: RESEND_API_KEY unset, where
  -- the function answers "email is not configured" and the foreman needs the
  -- card to keep telling him to copy the link and text it.
  insert into gc_links (project_id, token_hash, brand, sent_to_email, sent_by)
  values (
    p_project_id,
    v_hash,
    v_brand,
    nullif(btrim(lower(coalesce(p_email, ''))), ''),
    auth.uid()
  )
  returning * into v_row;

  return query select v_row.id, v_token, v_row.expires_at, v_row.brand;
end;
$$;

comment on function public.create_gc_link(uuid, text, text) is
  'Foreman+: mint a no-login link for one job''s GC and revoke any earlier live one. Returns the plaintext token ONCE — it is stored only as a sha256 hash, so it cannot be shown again and "send it again" mints a fresh link, rotating the credential.';

revoke all on function public.create_gc_link(uuid, text, text) from public, anon;
grant execute on function public.create_gc_link(uuid, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- H2. revoke_gc_link (foreman+)
-- ---------------------------------------------------------------------------
create or replace function public.revoke_gc_link(p_link_id uuid)
returns gc_links
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row gc_links;
begin
  if not _is_lead(auth.uid()) then
    raise exception 'Only a foreman or above can turn a GC link off.';
  end if;

  -- Revoking twice is not an error and does not move the time: the first
  -- revoke is when somebody decided, and a second tap should not rewrite it.
  update gc_links
     set revoked_at = coalesce(revoked_at, now())
   where id = p_link_id
  returning * into v_row;

  if not found then
    raise exception 'That link does not exist.';
  end if;

  return v_row;
end;
$$;

comment on function public.revoke_gc_link(uuid) is
  'Foreman+: turn a GC link off. Idempotent — revoking twice keeps the first time, because that is when somebody decided.';

revoke all on function public.revoke_gc_link(uuid) from public, anon;
grant execute on function public.revoke_gc_link(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- H2. post_gc_message (foreman+) — the office's side of the thread
-- ---------------------------------------------------------------------------
create or replace function public.post_gc_message(
  p_project_id uuid,
  p_body text
)
returns gc_messages
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row gc_messages;
  v_link uuid;
begin
  if not _is_lead(auth.uid()) then
    raise exception 'Only a foreman or above can write to the GC.';
  end if;
  if coalesce(btrim(p_body), '') = '' then
    raise exception 'Write something before you send it.';
  end if;
  if length(btrim(p_body)) > 4000 then
    raise exception 'That message is too long to send — keep it under 4000 characters.';
  end if;

  -- Attached to the live link when there is one, so the GC sees the reply on
  -- the page he already has open. With no live link the reply is still recorded
  -- against the job, and the office can see it was written before anybody had
  -- somewhere to read it.
  select id into v_link
    from gc_links
   where project_id = p_project_id
     and revoked_at is null
     and expires_at > now()
   order by created_at desc
   limit 1;

  insert into gc_messages (gc_link_id, project_id, author, author_profile_id, body)
  values (v_link, p_project_id, 'office', auth.uid(), btrim(p_body))
  returning * into v_row;

  return v_row;
end;
$$;

comment on function public.post_gc_message(uuid, text) is
  'Foreman+: reply to a job''s GC on the thread he sees on his link page. Never crew chat — project_messages is a different table for a different audience.';

revoke all on function public.post_gc_message(uuid, text) from public, anon;
grant execute on function public.post_gc_message(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- H2. The three service-role doors the gc-link edge function knocks on
-- ---------------------------------------------------------------------------
-- These are the ONLY way a token turns into anything. Each is
-- service-role-only: `revoke ... from authenticated` means a crew login holding
-- a token cannot call them from the browser, and anon was never granted
-- anything. The edge function hashes the token it was handed and passes the
-- HASH, so the plaintext never reaches the database.
--
-- Each one re-checks the link's state itself rather than trusting the caller to
-- have checked: expired, revoked, or unknown all end the same way, and the
-- function tells the page one plain sentence rather than four.

/*
 * The state check and the rate limit, in one place, for both write doors.
 *
 * It CLAIMS the attempt as it checks it — the update that bumps post_count is
 * the same statement that reads last_post_at, so two taps arriving together
 * cannot both pass. A separate read-then-write would be a race with a stranger
 * on the other end of it.
 *
 * The limits are deliberately loose. Somebody answering six questions on a
 * phone with bad signal will retry, and a limit tight enough to catch a script
 * would catch him first; 256 bits of token is what stops a stranger, and this
 * only stops a stuck retry loop from filling the table.
 *
 * And it can only ever be that, for a reason worth writing down: a REFUSED
 * write rolls back its own claim along with everything else in the statement,
 * so somebody posting nothing but invalid answers is never throttled by this.
 * That is fine here — the counter is a guard against a loop, not against an
 * attacker, and the attacker would need the token first.
 */
create or replace function public._gc_link_for_write(p_token_hash text)
returns gc_links
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_link gc_links;
begin
  update gc_links
     set post_count = gc_links.post_count + 1,
         last_post_at = now()
   where token_hash = p_token_hash
     and revoked_at is null
     and expires_at > now()
     and (last_post_at is null or last_post_at < now() - interval '2 seconds')
     and post_count < 200
  returning * into v_link;

  if found then
    return v_link;
  end if;

  -- Work out WHY, but only in the two cases where saying so helps the person
  -- holding the link. An unknown token and a revoked one get the same sentence,
  -- because telling a stranger which of the two he has is telling him something.
  select * into v_link from gc_links where token_hash = p_token_hash;
  if found and v_link.revoked_at is null and v_link.expires_at > now() then
    raise exception 'That went through a moment ago — give it a second and try again.';
  end if;

  raise exception 'This link has expired — ask your installer for a new one.';
end;
$$;

comment on function public._gc_link_for_write(text) is
  'Service role only: the shared state check and rate limit behind gc_link_answer and gc_link_say. Claims the attempt in the same statement that checks it, so two taps at once cannot both pass. An unknown token and a revoked one get the same sentence on purpose.';

revoke all on function public._gc_link_for_write(text) from public, anon, authenticated;
grant execute on function public._gc_link_for_write(text) to service_role;

/* Resolve a token to the little the page is allowed to know. */
create or replace function public.gc_link_open(p_token_hash text)
returns table (
  link_id uuid,
  project_id uuid,
  job_label text,
  brand text,
  state text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
-- OUT columns project_id / brand / state share names with real columns.
#variable_conflict use_column
declare
  v_link gc_links;
begin
  select * into v_link from gc_links where token_hash = p_token_hash;
  if not found then
    -- No row, and no hint about why. A stranger learns nothing from the shape
    -- of the answer, and the one real user is told the same plain sentence
    -- whatever went wrong.
    return;
  end if;

  update gc_links
     set hit_count = gc_links.hit_count + 1,
         last_hit_at = now()
   where id = v_link.id;

  return query
  select v_link.id,
         v_link.project_id,
         coalesce(nullif(btrim(p.name), ''), p.job_code) as job_label,
         -- THE JOB'S BRAND, NOT THE LINK'S. gc_links.brand is a record of the
         -- name we used when this link went out; the page has to wear the name
         -- the office is using with this builder NOW. A foreman who sends a
         -- link, then realises this builder knows us as Forge and taps the
         -- pill, would otherwise leave the builder's open page headed "STG
         -- Windows & Doors" with nothing on either screen saying it is stale —
         -- and the column comment on projects.gc_brand says the opposite is
         -- the intent ("a job's brand outlives any one link").
         coalesce(p.gc_brand, v_link.brand, 'stg') as brand,
         -- Cast spelled out: RETURN QUERY matches the function's declared
         -- result type by TYPE, and a bare string literal is `unknown` until
         -- something resolves it. claim_pipeline_nudges casts its own CASE for
         -- the same reason.
         (case
           when v_link.revoked_at is not null then 'revoked'
           when v_link.expires_at <= now() then 'expired'
           else 'live'
         end)::text as state
    from projects p
   where p.id = v_link.project_id;
end;
$$;

comment on function public.gc_link_open(text) is
  'Service role only (the gc-link edge function): turn a token HASH into the job label, the job''s CURRENT brand (projects.gc_brand, not the link''s record of what was sent) and whether the link is live. Counts the read. Returns no row at all for a token nobody minted, so a stranger cannot tell an unknown token from an expired one.';

revoke all on function public.gc_link_open(text) from public, anon, authenticated;
grant execute on function public.gc_link_open(text) to service_role;

/* The GC answers the six questions. Returns who should be told. */
create or replace function public.gc_link_answer(
  p_token_hash text,
  p_expected_end_date date,
  p_roof_on_date date,
  p_framing_checked boolean,
  p_set_preference text,
  p_exterior_material text,
  p_interior_material text,
  p_contact_name text default null,
  p_notes text default null
)
returns table (project_id uuid, job_label text, profile_ids uuid[])
language plpgsql
security definer
set search_path = public, pg_temp
as $$
-- OUT column project_id shares its name with a real column on both tables
-- touched below.
#variable_conflict use_column
declare
  v_link gc_links;
begin
  v_link := public._gc_link_for_write(p_token_hash);

  -- The same six checks log_gc_checkin makes, in the same words. The GC reads
  -- these sentences too, so they say what to do rather than what failed.
  if p_expected_end_date is null then
    raise exception 'Please say when you expect the house to be finished.';
  end if;
  if p_roof_on_date is null then
    raise exception 'Please say when the roof goes on.';
  end if;
  if p_framing_checked is null then
    raise exception 'Please say whether the framing has been checked.';
  end if;
  if coalesce(p_set_preference, '') not in ('inset', 'outset', 'unknown') then
    raise exception 'Please say whether you want the windows inset or outset.';
  end if;
  if coalesce(btrim(p_exterior_material), '') = '' then
    raise exception 'Please say what is going on the outside.';
  end if;
  if coalesce(btrim(p_interior_material), '') = '' then
    raise exception 'Please say what is going on the inside.';
  end if;

  insert into project_gc_checkins (
    project_id, author_id, contacted_at, contact_name, channel,
    expected_end_date, roof_on_date, framing_checked, set_preference,
    exterior_material, interior_material, notes, source
  )
  values (
    v_link.project_id,
    -- No profile: the person who typed this has no login here, and inventing
    -- one for them would put a crew member's name on the builder's words.
    null,
    now(),
    nullif(btrim(coalesce(p_contact_name, '')), ''),
    -- He typed it on the page we sent him, which is neither a call nor an
    -- email. Recording it as one of those would put a conversation in the
    -- record that never happened.
    'link',
    p_expected_end_date,
    p_roof_on_date,
    p_framing_checked,
    p_set_preference,
    btrim(p_exterior_material),
    btrim(p_interior_material),
    nullif(btrim(coalesce(p_notes, '')), ''),
    'gc'
  );

  update gc_links
     set used_at = coalesce(used_at, now())
   where id = v_link.id;

  return query
  select p.id,
         coalesce(nullif(btrim(p.name), ''), p.job_code),
         public.pipeline_nudge_audience(p.id)
    from projects p
   where p.id = v_link.project_id;
end;
$$;

comment on function public.gc_link_answer(text, date, date, boolean, text, text, text, text, text) is
  'Service role only (the gc-link edge function): file the GC''s own answers as a project_gc_checkins row with source = gc, and return who to push. Rate-limited and state-checked through _gc_link_for_write.';

revoke all on function public.gc_link_answer(text, date, date, boolean, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.gc_link_answer(text, date, date, boolean, text, text, text, text, text) to service_role;

/* The GC asks a question. Returns who should be told. */
create or replace function public.gc_link_say(
  p_token_hash text,
  p_body text
)
returns table (project_id uuid, job_label text, profile_ids uuid[])
language plpgsql
security definer
set search_path = public, pg_temp
as $$
-- OUT column project_id shares its name with a real column on both tables
-- touched below.
#variable_conflict use_column
declare
  v_link gc_links;
begin
  v_link := public._gc_link_for_write(p_token_hash);

  if coalesce(btrim(p_body), '') = '' then
    raise exception 'Please write something before you send it.';
  end if;
  if length(btrim(p_body)) > 4000 then
    raise exception 'That message is too long to send — please keep it under 4000 characters.';
  end if;

  insert into gc_messages (gc_link_id, project_id, author, author_profile_id, body)
  values (v_link.id, v_link.project_id, 'gc', null, btrim(p_body));

  update gc_links
     set used_at = coalesce(used_at, now())
   where id = v_link.id;

  return query
  select p.id,
         coalesce(nullif(btrim(p.name), ''), p.job_code),
         public.pipeline_nudge_audience(p.id)
    from projects p
   where p.id = v_link.project_id;
end;
$$;

comment on function public.gc_link_say(text, text) is
  'Service role only (the gc-link edge function): record a message the GC typed on his page and return who to push. Never writes project_messages — crew chat is a different table for a different audience.';

revoke all on function public.gc_link_say(text, text) from public, anon, authenticated;
grant execute on function public.gc_link_say(text, text) to service_role;

-- ---------------------------------------------------------------------------
-- The test-login fence
-- ---------------------------------------------------------------------------
-- All four tables this wave adds carry a project_id, which is what makes a
-- table project-scoped (sandbox_scoped_tables, 20260967000000), so all four are
-- fenced by this one line at the end of the file. Re-arming is idempotent and
-- reports what it did; a test login can only ever touch the sandbox job's rows,
-- and neither the service-role sweep nor the gc-link function is affected,
-- because the guard is a no-op when there is no JWT.
select public.attach_sandbox_guards();


-- ===========================================================================
-- 20260982000000_who_did_what.sql (mirrored)
-- Who did what, wave Y of the transcripts program. install_events gains
-- credited_to (null = installer_id, the filer): finish_unit and
-- submit_install_event each gain a WIDER EXACT ARITY carrying p_credited_to
-- (never a defaulted parameter — PostgREST would call the old form ambiguous),
-- with the old arity kept as a delegator so a phone behind this migration
-- finishes units exactly as before. credit_refusal is the one rule — rank 0
-- may credit self or the unit's assignee, foreman+ any active crew member —
-- and it is enforced twice, in the RPC and in a table trigger, because a plain
-- PATCH is a door too. Every per-person rollup switches to
-- coalesce(credited_to, installer_id): installer_type_stats,
-- installer_category_stats, recompute_window_type_rollups, pick_golden_install
-- and open_service_case. Adds ONE table, opening_assignment_events, written by
-- a trigger on project_openings.assigned_to so no assigning surface can forget,
-- and finally puts the foreman+ rank INSIDE assign_opening_to_installer (now
-- carrying p_via) and unassign_opening, where until today it lived only in the
-- buttons the UI chose to draw. Deploy AFTER 20260980000000 (wave X) and
-- 20260981000000 (wave H).
-- ===========================================================================

-- Wave Y — Who did what (transcripts program, grill of 2026-09-03, Q2).
--
-- Until now the app answered "who installed this window?" with "whoever
-- pressed Submit". That is the same person about nine times in ten, and wrong
-- the tenth: a foreman finishing a unit for an installer whose phone is dead,
-- a lead filing the last three of the day so the crew can drive home. Every
-- one of those quietly moved a window onto the filer's record — into his
-- median, his fail rate, the figures dispatch ranks him on — and off the
-- person who actually stood on the ladder.
--
-- Two facts, kept apart, fix it:
--
--   * WHO INSTALLED IT   install_events.credited_to (null = the filer)
--   * WHO FILED IT       install_events.installer_id, unchanged
--
-- The Record reads "Installed by Sam · filed by Jed", and every per-person
-- rollup in this database reads coalesce(credited_to, installer_id) from here
-- on. Credit is about the RECORD; it never moves a session. The finisher's
-- session stays the finisher's, because sessions follow the human (CONTEXT.md,
-- "Session") and the walk Jed made to that window is Jed's time.
--
-- And a second, older silence: assignment. `assigned_to` is a single column
-- that gets overwritten, so "who was this on before, and who moved it?" had no
-- answer at all — the previous assignee was simply gone. opening_assignment_events
-- is that answer, written by a trigger so no writing surface can forget, and
-- assign_opening_to_installer / unassign_opening finally carry the foreman+
-- rank that until today lived only in the buttons the UI chose to draw.
--
-- Deploy AFTER 20260980000000 (wave X) and 20260981000000 (wave H).

-- ===========================================================================
-- 1. Y1 — the credited installer
-- ===========================================================================
-- Nullable, and null MEANS "the filer installed it". Not a backfill: every row
-- filed before today was filed by whoever installed it as far as anyone knew,
-- and writing that guess into a column would turn an assumption into a record.

alter table install_events
  add column if not exists credited_to uuid references profiles(id) on delete set null;

comment on column install_events.credited_to is
  'Who actually installed this unit, when that is not the person who filed the event. NULL means installer_id — the filer did the work — and is the ordinary case. Every per-person rollup reads coalesce(credited_to, installer_id); nothing reads this column alone.';

-- The leaderboard and the timecard both ask "everything this person installed",
-- which is now two columns. One partial index on the rare one keeps that cheap
-- without paying for an index entry on the millions of rows where it is null.
create index if not exists install_events_credited_idx
  on install_events (credited_to, created_at desc)
  where credited_to is not null;


-- ---------------------------------------------------------------------------
-- 1a. The rule, in one place
-- ---------------------------------------------------------------------------
-- Returns NULL when the credit is allowed, and the SENTENCE to refuse with when
-- it is not — so the RPC and the table trigger below enforce one rule and say
-- the same words, rather than two copies that drift.
--
-- Who may credit whom:
--   * anybody may credit THEMSELVES (that is just filing your own work)
--   * a plain installer may additionally credit the person this unit is
--     ASSIGNED to — the one on-site case that needs no permission: the window
--     was Sam's, Sam did it, somebody else typed it in
--   * foreman and above may credit any active crew member
--
-- "Any active crew member" rather than "anyone with a shift on this job" on
-- purpose: a helper who walked over for a four-man lift and never clocked in to
-- that job still installed the window, and a rule that refuses the honest
-- answer teaches people to file the dishonest one. The picker on the sheet
-- offers the job's own crew first; the DATABASE only refuses names that are not
-- crew at all.
create or replace function public.credit_refusal(
  p_opening_id uuid,
  p_credited_to uuid
)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_assigned uuid;
begin
  -- Nothing claimed, nothing to check.
  if p_credited_to is null then
    return null;
  end if;

  -- No JWT means the service role or a migration, not a phone. The key IS the
  -- fence there; a rank check would only break the server's own jobs.
  if v_actor is null then
    return null;
  end if;

  if p_credited_to = v_actor then
    return null;
  end if;

  if not exists (
    select 1 from profiles
     where id = p_credited_to
       and active
       and not coalesce(is_partner, false)
  ) then
    return 'That person is not on the crew list, so the install cannot be filed under their name.';
  end if;

  if public.is_foreman_plus(v_actor) then
    return null;
  end if;

  select assigned_to into v_assigned from project_openings where id = p_opening_id;
  if v_assigned is not null and v_assigned = p_credited_to then
    return null;
  end if;

  return 'Only a foreman or above can file an install under somebody else''s name. You can record it as yours, or as the person this unit is assigned to.';
end;
$$;

comment on function public.credit_refusal(uuid, uuid) is
  'NULL when the calling user may credit p_credited_to with an install on p_opening_id, otherwise the plain-English sentence to refuse with. Rank 0 may credit self or the unit''s current assignee; foreman+ may credit any active crew member; a partner login is never a candidate. One rule, shared by submit_install_event and the table trigger.';

revoke all on function public.credit_refusal(uuid, uuid) from public, anon;
grant execute on function public.credit_refusal(uuid, uuid) to authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 1b. submit_install_event — the wider arity
-- ---------------------------------------------------------------------------
-- A NEW EXACT ARITY, not a defaulted parameter on the old one. PostgREST picks
-- an overload by the SET OF ARGUMENT NAMES in the request body and a parameter
-- carrying a default is still a candidate, so a 17th defaulted parameter
-- alongside the 16-argument form would make every existing call ambiguous and
-- fail. Two exact arities never can be (the same reasoning wave E wrote down
-- for flag_opening, 20260977000000). The old form stays, rebuilt as a
-- one-line delegator, so there is exactly one body and one set of rules.
--
-- Rebuilt from the CURRENT body (20260811000000_opening_phases.sql — the
-- flashing gate included), never from an older copy.
create or replace function submit_install_event(
  p_opening_id uuid,
  p_installer text,
  p_minutes int,
  p_quality_grade int,
  p_difficulty text,
  p_went_well text,
  p_went_poorly text,
  p_obstacles text,
  p_tools_helped text,
  p_time_vs_estimate text,
  p_safety_notes text,
  p_do_again text,
  p_transcript_raw text,
  p_started_at timestamptz,
  p_installer_id uuid,
  p_estimate_minutes int,
  p_credited_to uuid
)
returns install_events
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_opening project_openings;
  v_event install_events;
  v_actor uuid := auth.uid();
  v_profile uuid := coalesce(p_installer_id, auth.uid());
  v_credited uuid;
  v_refusal text;
begin
  select * into v_opening from project_openings where id = p_opening_id;
  if v_opening is null then
    raise exception 'unknown opening %', p_opening_id;
  end if;

  if _flashing_outstanding(p_opening_id) then
    raise exception 'this opening needs flashing submitted before the install is filed';
  end if;

  -- p_installer_id has always been able to name somebody else, and doing so
  -- has always meant "file it as them". From wave Y that IS a credit, so it
  -- answers to the credit rule like every other one — otherwise the rule below
  -- would be one argument away from being no rule at all.
  v_refusal := public.credit_refusal(p_opening_id, nullif(v_profile, v_actor));
  if v_refusal is not null then
    raise exception '%', v_refusal using errcode = '42501';
  end if;

  v_refusal := public.credit_refusal(p_opening_id, nullif(p_credited_to, v_actor));
  if v_refusal is not null then
    raise exception '%', v_refusal using errcode = '42501';
  end if;

  -- Crediting the filer is what NULL already means. Storing it twice would
  -- give the same fact two spellings and every reader a choice to get wrong.
  v_credited := nullif(p_credited_to, v_profile);

  insert into install_events (
    project_opening_id, window_id, window_type_id, installer, installer_id,
    credited_to, started_at, minutes, estimate_minutes, quality_grade,
    difficulty, went_well, went_poorly, obstacles, tools_helped,
    time_vs_estimate, safety_notes, do_again, transcript_raw
  ) values (
    v_opening.id, v_opening.assigned_window_id, v_opening.window_type_id,
    p_installer, v_profile, v_credited, p_started_at, p_minutes,
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

  -- Task-time follows the FILER, not the credited person: whoever is standing
  -- here is the one who is now between windows. Sessions follow the human.
  if v_profile is not null then
    perform close_open_task_sessions(v_profile);
    insert into task_sessions (profile_id, opening_id, project_id, state)
    values (v_profile, null, v_opening.project_id, 'off_task');
  end if;

  return v_event;
end;
$$;

-- The old sixteen-argument form, kept for every caller that has no credit to
-- name (which is most of them, most of the time) and rebuilt on top of the new
-- one so the rules live in exactly one body.
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
set search_path = public, pg_temp
as $$
begin
  return submit_install_event(
    p_opening_id, p_installer, p_minutes, p_quality_grade, p_difficulty,
    p_went_well, p_went_poorly, p_obstacles, p_tools_helped,
    p_time_vs_estimate, p_safety_notes, p_do_again, p_transcript_raw,
    p_started_at, p_installer_id, p_estimate_minutes, null);
end;
$$;

revoke all on function submit_install_event(
  uuid, text, int, int, text, text, text, text, text, text, text, text, text,
  timestamptz, uuid, int, uuid) from public, anon;
grant execute on function submit_install_event(
  uuid, text, int, int, text, text, text, text, text, text, text, text, text,
  timestamptz, uuid, int, uuid) to authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 1c. finish_unit — the wider arity
-- ---------------------------------------------------------------------------
-- Same two-exact-arities shape. Rebuilt IN FULL from the current body
-- (20260964000000_finish_unit_own_sessions.sql), including the corrected
-- `project_opening_id` cutoff — the 2026-09-02 incident's fix, which
-- scripts/migration_lint.py now guards. Nothing about the minutes maths, the
-- session close or the chain moves; the only new line is the credit riding
-- through to submit_install_event.
create or replace function finish_unit(
  p_opening_id uuid,
  p_next_opening_id uuid,
  p_installer text,
  p_quality_grade int,
  p_difficulty text,
  p_went_well text,
  p_went_poorly text,
  p_obstacles text,
  p_tools_helped text,
  p_time_vs_estimate text,
  p_safety_notes text,
  p_do_again text,
  p_transcript_raw text,
  p_installer_id uuid,
  p_estimate_minutes int,
  p_credited_to uuid
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
  -- Close the caller's open session on this unit first so it counts. THE
  -- CALLER'S — crediting somebody else does not reach into their clock, and a
  -- finish filed for Sam still ends the session of whoever is standing here.
  update unit_sessions
  set ended_at = now(), end_reason = 'finish'
  where profile_id = v_uid and ended_at is null and opening_id = p_opening_id;

  -- Session-derived figures for THIS round: sessions since the last
  -- non-voided event ON THIS UNIT (all of them for a first install). The
  -- column is `project_opening_id`; a bare `opening_id` here resolves to the
  -- outer unit_sessions row instead and picks the newest install on the whole
  -- database (2026-09-02).
  select coalesce(sum(least(480,
           greatest(0, floor(extract(epoch from (ended_at - started_at)) / 60)))), 0)::int,
         min(started_at)
  into v_minutes, v_started
  from unit_sessions
  where opening_id = p_opening_id and ended_at is not null
    and started_at > coalesce(
      (select max(created_at) from install_events
       where project_opening_id = p_opening_id and voided_at is null),
      '-infinity'::timestamptz);

  v_event := submit_install_event(
    p_opening_id, p_installer, nullif(v_minutes, 0), p_quality_grade,
    p_difficulty, p_went_well, p_went_poorly, p_obstacles, p_tools_helped,
    p_time_vs_estimate, p_safety_notes, p_do_again, p_transcript_raw,
    v_started, p_installer_id, p_estimate_minutes, p_credited_to);

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

-- The old fifteen-argument form, delegating. A phone that is behind this
-- migration keeps finishing units exactly as it always has.
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
begin
  return finish_unit(
    p_opening_id, p_next_opening_id, p_installer, p_quality_grade,
    p_difficulty, p_went_well, p_went_poorly, p_obstacles, p_tools_helped,
    p_time_vs_estimate, p_safety_notes, p_do_again, p_transcript_raw,
    p_installer_id, p_estimate_minutes, null);
end;
$$;

revoke all on function finish_unit(
  uuid, uuid, text, int, text, text, text, text, text, text, text, text, text,
  uuid, int, uuid) from public, anon;
grant execute on function finish_unit(
  uuid, uuid, text, int, text, text, text, text, text, text, text, text, text,
  uuid, int, uuid) to authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 1d. The same rule at the table, because the RPC is not the only door
-- ---------------------------------------------------------------------------
-- install_events' policy is `for all to authenticated using (not
-- is_partner_user() and (true))` (20260950000000), so a plain PATCH can set
-- credited_to on any row. Wave E made the same discovery about flag_kind and
-- answered it the same way: put the rule on the table too.
--
-- TWO questions have to be asked here, not one. credit_refusal answers "may
-- this person be credited?" — but on a PATCH of somebody ELSE'S row that is
-- the wrong question, and asking only it leaves three doors wide open:
--
--   * Sam PATCHes {"credited_to": "<sam>"} onto Jed's install. Crediting
--     yourself is always allowed, so the value passes — and Jed's window
--     lands on Sam's median, Sam's fail rate, Sam's leaderboard row.
--   * Anybody PATCHes {"credited_to": null} onto a credited install and the
--     credit a foreman set is silently gone, handing the work back to
--     whoever typed it in.
--   * Anybody PATCHes {"installer_id": "<someone>"}, which the RPC has
--     guarded since this migration but the table never looked at.
--
-- So the row's AUTHORITY is checked first — only the person who filed an
-- install, or a foreman, may change who it is filed under — and only then the
-- value. Every ordinary update (a void, a memo confirm, an unsubmit) leaves
-- both columns alone and returns before either question is asked.
--
-- It also normalises credit-to-the-filer down to NULL from every door, so
-- "null means the filer" can never be broken by a caller that spells it out.
create or replace function public.guard_install_credit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_refusal text;
begin
  if new.credited_to is not null and new.credited_to = new.installer_id then
    new.credited_to := null;
  end if;

  -- No JWT is the service role or a migration, not a phone — the same
  -- exemption credit_refusal makes, for the same reason: the key is the fence
  -- there, and a rank check would only break the server's own jobs.
  if v_actor is null then
    return new;
  end if;

  if tg_op = 'UPDATE' then
    -- Nothing about who did this is moving: every void, restore, unsubmit and
    -- memo confirm in the app takes this door and is none of our business.
    if new.credited_to is not distinct from old.credited_to
       and new.installer_id is not distinct from old.installer_id then
      return new;
    end if;

    -- WHOSE ROW IS THIS. Correcting your own filing is ordinary bookkeeping;
    -- reaching into somebody else's is the theft this guard exists for.
    if v_actor is distinct from old.installer_id
       and not public.is_foreman_plus(v_actor) then
      raise exception 'Only the person who filed this install, or a foreman, can change who it is filed under.'
        using errcode = '42501';
    end if;

    -- WHAT IT IS BEING CHANGED TO. Only the columns that actually moved, so a
    -- foreman clearing a credit on a round whose filer has since left the crew
    -- is not refused over a name nobody is touching.
    if new.installer_id is distinct from old.installer_id then
      v_refusal := public.credit_refusal(new.project_opening_id, nullif(new.installer_id, v_actor));
      if v_refusal is not null then
        raise exception '%', v_refusal using errcode = '42501';
      end if;
    end if;
    if new.credited_to is distinct from old.credited_to then
      v_refusal := public.credit_refusal(new.project_opening_id, nullif(new.credited_to, v_actor));
      if v_refusal is not null then
        raise exception '%', v_refusal using errcode = '42501';
      end if;
    end if;
    return new;
  end if;

  -- INSERT. Filing under somebody else's name through installer_id is the same
  -- claim as crediting them, so it answers to the same rule — which is exactly
  -- what submit_install_event says about its own p_installer_id. A null
  -- installer_id (the oldest rows' shape) claims nothing and passes.
  v_refusal := public.credit_refusal(new.project_opening_id, nullif(new.installer_id, v_actor));
  if v_refusal is not null then
    raise exception '%', v_refusal using errcode = '42501';
  end if;
  v_refusal := public.credit_refusal(new.project_opening_id, nullif(new.credited_to, v_actor));
  if v_refusal is not null then
    raise exception '%', v_refusal using errcode = '42501';
  end if;
  return new;
end;
$$;

comment on function public.guard_install_credit() is
  'Guards who an install is filed under, on every write to install_events. On UPDATE: only the filer or a foreman may change installer_id or credited_to at all, and the new value must pass credit_refusal; an update touching neither column returns untouched. On INSERT: both columns answer to credit_refusal. Also folds "credited to the filer" down to NULL. The RPC says it first and better; this is the door a plain PATCH would otherwise walk through.';

drop trigger if exists install_events_credit_guard on install_events;
create trigger install_events_credit_guard
  before insert or update on install_events
  for each row execute function public.guard_install_credit();


-- ===========================================================================
-- 2. Y1 — every per-person reader switches to coalesce(credited_to, installer_id)
-- ===========================================================================
-- These are the figures a person is measured by, and the whole point of the
-- column is that they follow the work rather than the typing. Rebuilt from
-- their CURRENT definitions (20260730120000_test_accounts_excluded_from_learning.sql)
-- with one substitution each; the column lists are untouched, so
-- `create or replace view` is legal.

create or replace view installer_type_stats as
select
  coalesce(e.credited_to, e.installer_id) as installer_id,
  e.window_type_id,
  count(*) filter (where e.minutes is not null) as n,
  percentile_cont(0.5) within group (order by e.minutes)
    filter (where e.minutes is not null) as median_minutes,
  avg(e.quality_grade) filter (where e.quality_grade is not null) as avg_grade,
  (count(distinct e.id) filter (where e.quality_grade <= 2 or q.status = 'callback'))::numeric
    / nullif(count(*), 0) as fail_rate,
  max(e.created_at) as last_at
from install_events e
left join qc_checks q on q.project_opening_id = e.project_opening_id
where coalesce(e.credited_to, e.installer_id) is not null and e.window_type_id is not null
  and not public.is_test_profile(coalesce(e.credited_to, e.installer_id))
group by coalesce(e.credited_to, e.installer_id), e.window_type_id;

comment on view installer_type_stats is
  'Per-person proven performance per window type, which dispatch ranks on. The person is coalesce(credited_to, installer_id) — who installed it, not who typed it in (wave Y).';

create or replace view installer_category_stats as
select
  coalesce(e.credited_to, e.installer_id) as installer_id,
  t.category,
  count(*) filter (where e.minutes is not null) as n,
  percentile_cont(0.5) within group (order by e.minutes)
    filter (where e.minutes is not null) as median_minutes,
  avg(e.quality_grade) filter (where e.quality_grade is not null) as avg_grade
from install_events e
join window_types t on t.id = e.window_type_id
where coalesce(e.credited_to, e.installer_id) is not null and t.category is not null
  and not public.is_test_profile(coalesce(e.credited_to, e.installer_id))
group by coalesce(e.credited_to, e.installer_id), t.category;


-- The type rollups' test-account exclusion asks "was this a real person's
-- install?", so it has to ask about the person who INSTALLED it. A foreman
-- filing on behalf of the QA login is still a QA install and must still be
-- kept out of the numbers the crew is measured against.
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
  from install_events
  where window_type_id = p_type_id
    and not public.is_test_profile(coalesce(credited_to, installer_id));

  -- Problem = low grade OR a QC callback on that opening.
  select count(distinct e.id)
  into v_problem
  from install_events e
  left join qc_checks q on q.project_opening_id = e.project_opening_id
  where e.window_type_id = p_type_id
    and not public.is_test_profile(coalesce(e.credited_to, e.installer_id))
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


-- The golden install is the worked example a real installer is shown. Same
-- reasoning: a test account's install must not become the how-to, whoever
-- filed it.
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
    and not public.is_test_profile(coalesce(e.credited_to, e.installer_id))
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


-- A service case names the installer whose work is being called back. That is
-- a per-person fact — the Service page groups by it — so it follows the credit
-- too. Rebuilt in full from 20260718080030_chain_correctness_fixes.sql.
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

  -- Idempotent: one open case per unit. Return the existing open case if any.
  select * into v_case
  from service_cases
  where window_id = p_window_id and status = 'open'
  order by created_at desc
  limit 1;
  if v_case.id is not null then
    return v_case;
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
    coalesce(v_event.credited_to, v_event.installer_id),
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


-- ===========================================================================
-- 3. Y5 — assignment history
-- ===========================================================================
-- `assigned_to` is one column that gets overwritten, so a reassignment erased
-- the fact that anybody else ever had the unit. Every "why was this sitting
-- unstarted for two days" conversation ran into that wall. One row per change,
-- written by a trigger rather than by each of the four surfaces that assign
-- (Dispatch, the flat map, Maps Interactive, auto-distribute) — a surface can
-- forget; a trigger on the column cannot.

create table if not exists opening_assignment_events (
  id uuid primary key default gen_random_uuid(),
  opening_id uuid not null references project_openings(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  from_profile uuid references profiles(id) on delete set null,
  to_profile uuid references profiles(id) on delete set null,
  changed_by uuid references profiles(id) on delete set null,
  changed_at timestamptz not null default now(),
  via text not null check (via in ('dispatch', 'map', 'auto', 'unassign'))
);

create index if not exists opening_assignment_events_opening_idx
  on opening_assignment_events (opening_id, changed_at desc);
create index if not exists opening_assignment_events_project_idx
  on opening_assignment_events (project_id, changed_at desc);

comment on table opening_assignment_events is
  'One row per time a unit changed hands: who it was on, who it went to, who moved it, and from which surface. Written only by the trigger on project_openings.assigned_to, so no assigning screen can forget to log. Read by foreman+; a partner login never.';

alter table opening_assignment_events enable row level security;

-- Revoke BEFORE granting: this project's default privileges hand every new
-- table in `public` the full set to `authenticated`, and RLS alone is not the
-- wall. No insert/update/delete grant at all — the trigger is the only writer,
-- and it is SECURITY DEFINER for exactly that reason.
revoke all on opening_assignment_events from anon, authenticated;
grant select on opening_assignment_events to authenticated;
grant all on opening_assignment_events to service_role;

-- Foreman+ read: who is on what, and who moved it, is a supervision fact.
-- An installer sees their own list; they do not need the ledger of everyone
-- else's. Never a partner login — the mechanical wall guard every crew table
-- carries since 20260950000000.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'opening_assignment_events' and policyname = 'foreman read'
  ) then
    create policy "foreman read" on opening_assignment_events
      for select to authenticated
      using (not public.is_partner_user() and public.my_role_rank() >= 1);
  end if;
end;
$$;


-- The trigger. AFTER UPDATE OF assigned_to only: an opening is INSERTED
-- unassigned by every path that makes one (extraction, Studio, wave E's
-- add_field_unit), so there is no birth event to record, and a log row for
-- every one of the thousands of openings a planset creates would bury the
-- handful that are real handovers.
--
-- `via` cannot be worked out from the row — the database has no idea which
-- screen the tap came from — so assign_opening_to_installer states it in a
-- transaction-local setting below. Anything that writes assigned_to WITHOUT
-- going through the RPC (a plain PATCH) leaves it unset and reads as
-- 'dispatch', which is honest: somebody handed the unit out.
create or replace function public.trg_opening_assignment_event()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_via text;
begin
  if new.assigned_to is not distinct from old.assigned_to then
    return new;
  end if;

  if new.assigned_to is null then
    v_via := 'unassign';
  else
    v_via := coalesce(nullif(current_setting('app.assignment_via', true), ''), 'dispatch');
    -- A stray value must never be able to refuse an assignment: the check
    -- constraint is about the vocabulary, not about the crew's afternoon.
    if v_via not in ('dispatch', 'map', 'auto') then
      v_via := 'dispatch';
    end if;
  end if;

  insert into opening_assignment_events (
    opening_id, project_id, from_profile, to_profile, changed_by, via
  ) values (
    new.id, new.project_id, old.assigned_to, new.assigned_to, auth.uid(), v_via
  );

  return new;
end;
$$;

drop trigger if exists project_openings_assignment_log on project_openings;
create trigger project_openings_assignment_log
  after update of assigned_to on project_openings
  for each row execute function public.trg_opening_assignment_event();


-- ---------------------------------------------------------------------------
-- 3a. The rank the buttons were carrying on their own
-- ---------------------------------------------------------------------------
-- assign_opening_to_installer and unassign_opening (20260715240000) have never
-- had a rank check in SQL. The gate was `isForemanPlus` in the UI, which is a
-- hidden button, not a lock: any signed-in crew phone could hand work to
-- anybody. Every caller in the app is already behind that same UI gate
-- (DispatchBoard is only mounted for isLead, ProjectMap's controls are isLead,
-- MapsInteractive and JobModelViewer pass onAssign only for foreman+), so
-- nothing legitimate loses a door today — the check simply moves to where it
-- cannot be walked around.
--
-- assign_opening_to_installer is DROPPED and recreated rather than overloaded:
-- it gains a trailing p_via, and a defaulted parameter alongside the old
-- four-argument form would make every existing call ambiguous through
-- PostgREST (see 1b). With exactly ONE function, an old four-name call resolves
-- to it and takes the default.
drop function if exists assign_opening_to_installer(uuid, uuid, uuid, int);

create or replace function assign_opening_to_installer(
  p_opening_id uuid,
  p_profile_id uuid,
  p_actor_id uuid default null,
  p_sequence int default null,
  p_via text default 'dispatch'
)
returns project_openings
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_opening project_openings;
begin
  -- No JWT is the service role or a migration, not a phone; the key is the
  -- fence there.
  if auth.uid() is not null and not public.is_foreman_plus(auth.uid()) then
    raise exception 'Only a foreman or above can hand out work.'
      using errcode = '42501';
  end if;

  -- Which screen this came from, for the history row the trigger writes.
  -- Transaction-local, so it can never leak into the next request.
  perform set_config('app.assignment_via', coalesce(p_via, 'dispatch'), true);

  update project_openings
  set assigned_to = p_profile_id,
      assigned_by = p_actor_id,
      assigned_at = now(),
      sequence = coalesce(p_sequence, sequence)
  where id = p_opening_id
  returning * into v_opening;

  if v_opening is null then
    raise exception 'That window or door is not on this job.' using errcode = 'P0002';
  end if;
  return v_opening;
end;
$$;

revoke all on function assign_opening_to_installer(uuid, uuid, uuid, int, text)
  from public, anon;
grant execute on function assign_opening_to_installer(uuid, uuid, uuid, int, text)
  to authenticated, service_role;

create or replace function unassign_opening(p_opening_id uuid)
returns project_openings
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_opening project_openings;
begin
  if auth.uid() is not null and not public.is_foreman_plus(auth.uid()) then
    raise exception 'Only a foreman or above can take work off somebody''s list.'
      using errcode = '42501';
  end if;

  update project_openings
  set assigned_to = null, assigned_by = null, assigned_at = null
  where id = p_opening_id
  returning * into v_opening;

  if v_opening is null then
    raise exception 'That window or door is not on this job.' using errcode = 'P0002';
  end if;
  return v_opening;
end;
$$;

revoke all on function unassign_opening(uuid) from public, anon;
grant execute on function unassign_opening(uuid) to authenticated, service_role;


-- ===========================================================================
-- 4. Re-arm the sandbox fence
-- ===========================================================================
-- opening_assignment_events carries a project_id, which is what makes a table
-- project-scoped (sandbox_scoped_tables, 20260967000000), so the test-login
-- fence belongs on it. Idempotent: a table already correctly guarded is left
-- alone. scripts/test_sandbox_guard.py fails CI for exactly this omission.
select public.attach_sandbox_guards();


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
--   * VERIFY YOUR OWN CARD: nobody, at any rank. Both paths refuse it — the
--     insert with `v_target <> v_me`, the update with its own check further
--     down. "Checked" has to mean a second person looked at the paper, or it
--     means nothing at all, and every supervisor and owner clears the rank bar.
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

  -- THE PARTNER WALL, and it has to be here rather than only on the table. Both
  -- policies below carry `not is_partner_user()`, but a policy is a READ and
  -- WRITE gate for direct table access, and this function is SECURITY DEFINER —
  -- it writes straight past every policy on the table. A builder login is
  -- pinned to role 'installer' (20260950000000), which is rank 0, which is
  -- exactly the rank "anybody may add their OWN card" was written for. Without
  -- this line a GC could file certifications against themselves: rows they
  -- could never read back, but rows the company's own screens and the 7 AM
  -- sweep would count as crew.
  if public.is_partner_user() then
    raise exception 'Not available for your account.' using errcode = '42501';
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

  -- YOUR OWN CARD IS NEVER SELF-CHECKED, and this is the half that was missing.
  -- The insert path above refuses it (`v_target <> v_me`), so an installer
  -- adding their own card always lands unchecked — but every supervisor and
  -- owner is rank 2+, and the rank check a few lines up was the ONLY gate on
  -- this path. One tap on their own Roster row and the claim checked itself,
  -- which is the one thing "checked" is supposed to mean it is not. Somebody
  -- else has to look at the paper, whatever rank the holder happens to be.
  --
  -- UNchecking your own card stays allowed: taking a claim back is not the same
  -- as making one, and a supervisor who realises their own card is out of date
  -- should not have to find a colleague to say so. Everything else on this path
  -- — a date, a kind, a void — is a correction, not a claim, and stays open.
  if p_verified is true and v_row.profile_id = v_me then
    raise exception 'Somebody else has to check your own card.'
      using errcode = '42501';
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
  'The one writer for certifications. A partner (builder/GC) login is refused outright — SECURITY DEFINER writes past the table''s own partner guard, so the wall is repeated in here. Adding your OWN card needs no rank and always lands unverified; adding somebody else''s, and every edit, verification and void, is supervisor+. NOBODY checks their own card, whatever their rank — un-checking it is allowed, because taking a claim back is not making one. Partial: a null argument leaves that column alone, and a date is cleared through its own flag so verifying cannot wipe an expiry (Wave O, O1).';

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
-- NOT `profiles.active`, and this is the trap. In this app `active` means "on
-- site TODAY" — the Roster renders it as "On site / Off today" and a foreman
-- flips it every morning (20260730010000 says so in as many words: "It is
-- availability, not permission"). Filtering the audience on it would mean a
-- supervisor who happened to be marked off on the ONE morning a card entered
-- its window never hears about that card at all: the warning is claimed once
-- per expiry date and the ledger stops it ever being claimed again, so the
-- recipient list is frozen the first time it is computed. Being off sick on a
-- Tuesday is not a reason to be cut out of a deadline for good.
--
-- `access_revoked_at` is the column that means what "inactive" was reaching
-- for: the login has been switched off, the person has left, and it does not
-- change from one day to the next. Partner logins never.
create or replace function public.credential_nudge_audience(p_profile_id uuid)
returns uuid[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(array_agg(distinct pr.id), '{}'::uuid[])
    from profiles pr
   where pr.access_revoked_at is null
     and not coalesce(pr.is_partner, false)
     and (pr.id = p_profile_id or public._is_supervisor(pr.id));
$$;

comment on function public.credential_nudge_audience(uuid) is
  'Who hears that a card is running out: the person it belongs to, plus every supervisor and owner whose login is still switched on. Deliberately NOT filtered on profiles.active, which means "on site today" — the warning is claimed once per expiry date, so a supervisor who happened to be off that one morning would never hear about that card again. Partner logins never (Wave O, O4).';

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
-- A VOIDED card is silent, and so is a card belonging to somebody whose login
-- has been switched off. A card belonging to somebody merely marked "off today"
-- is NOT silent — see the candidate CTE, where that distinction is the whole
-- note. An UNVERIFIED card still warns — the office not having got
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
       -- Same column, same reason as the audience above: a card belonging to
       -- somebody who is off site today still runs out on the day it runs out,
       -- and each rule fires once per expiry date, so a morning skipped here is
       -- a warning lost rather than delayed. `access_revoked_at` — the login
       -- has been switched off — is the one that means "no longer ours".
       and pr.access_revoked_at is null
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

-- ===========================================================================
-- 20260984000000_recordings_by_link.sql (mirrored)
-- Recordings by link, wave U of the transcripts program: learning_videos.status
-- (draft | published) with the crew read policy that enforces it,
-- save_learning_video / publish_learning_video, and foreman_contacts_for_me —
-- the minimal name+email projection the "Send a recording" button addresses.
-- ===========================================================================

-- Recordings by link, wave U of the transcripts program (owner's design,
-- Q15 + Q19 — cited, never re-decided).
--
-- WHAT THE OWNER ACTUALLY ASKED FOR, and what this deliberately does NOT build:
-- installers already film themselves working. The app is not going to collect
-- that raw footage. An installer emails the video to their lead, the lead puts
-- it on YouTube, and the app gets the LINK. So there is no new upload path
-- here, no raw-footage inbox, and no file size cap to argue about — three
-- features that would each have needed storage, review and a retention policy
-- to hold footage nobody wanted to keep.
--
-- Three things, in the order they depend on each other:
--
--   1. learning_videos.status — draft | published. A lesson is now born a
--      DRAFT: a link with nothing else on it is not a lesson, and a half-built
--      one appearing in the crew's library the second it is saved is how the
--      library fills with untitled fragments. Crews read published rows only;
--      supervisors read everything, which is what makes the Inbox on the Videos
--      tab possible.
--
--   2. save_learning_video learns that column, and publish_learning_video is
--      the one-tap flip at the end of the flow (paste the link, paste the
--      transcript, Generate summary & quiz, Approve, Publish).
--
--   3. foreman_contacts_for_me — the address the "Send a recording" button
--      needs. Emails live in auth.users, which no client role may read, so the
--      only way an installer's phone can address their lead is a SECURITY
--      DEFINER function that answers with a MINIMAL PROJECTION: a display name
--      and an email, for foreman-and-up only, and nothing else about anybody.
--      Never the profiles row (wave S's projection law: build an outward
--      payload field by field, never spread-and-delete).
--
-- IDEMPOTENT throughout: add-column-if-not-exists, drop-then-add for the check
-- constraint, drop-then-create for the policy, create-or-replace for every
-- function. Safe to run twice.
--
-- MERGE ORDER: after 20260981000000 (wave H), 20260982000000 (wave Y) and
-- 20260983000000 (wave O). Numbers land in order, one deploy at a time. This
-- file touches learning_videos and nothing any of those three touch, so the
-- only real constraint is the number.
--
-- NO NEW TABLE, so there is nothing here for attach_sandbox_guards() to arm and
-- nothing new for the partner wall to sweep — the existing learning_videos
-- policy already carries the is_partner_user() guard (20260950000000) and the
-- replacement below keeps it.


-- ---------------------------------------------------------------------------
-- 1. U1 — draft until published
-- ---------------------------------------------------------------------------
--
-- DEFAULT 'published', which reads backwards until you remember what a default
-- does to rows that already exist: every lesson in the library today was made
-- under the old rule, was visible to crews yesterday, and must still be visible
-- to them tomorrow. A default of 'draft' would have silently emptied the whole
-- Learn library on deploy. NEW rows land 'draft' one layer up, inside
-- save_learning_video, where the app's own writer can tell the difference
-- between "somebody just made this" and "this was always here".

alter table learning_videos
  add column if not exists status text not null default 'published';

alter table learning_videos drop constraint if exists learning_videos_status_check;
alter table learning_videos add constraint learning_videos_status_check
  check (status in ('draft', 'published'));

comment on column learning_videos.status is
  'draft while a supervisor is still building the lesson (link pasted, transcript missing, quiz not approved); published once it is ready for crews. Crews read published rows only — see the "crew read" policy. New rows are born draft by save_learning_video; the column default is published so every lesson that existed before this migration stays visible.';

-- The crew read policy, replaced rather than added to: two select policies OR
-- together in Postgres, so a second permissive policy saying "supervisors see
-- everything" alongside an unchanged "everyone sees everything" would have
-- changed nothing at all. One policy, both rules.
--
-- The partner guard is carried over verbatim from THE WALL (20260950000000).
-- test_partner_wall.py replays every migration in this repo and fails if a
-- live select policy on this table loses it.
drop policy if exists "crew read" on learning_videos;
create policy "crew read" on learning_videos
  for select to authenticated
  using (
    not public.is_partner_user()
    and (status = 'published' or public.my_role_rank() >= 2)
  );


-- ---------------------------------------------------------------------------
-- 2. U1 — the writer learns the column
-- ---------------------------------------------------------------------------
--
-- The older signatures go first. `create or replace` with a different argument
-- list makes an OVERLOAD, not a replacement, and a pile of near-identical
-- overloads is how PostgREST starts answering PGRST203 ("could not choose the
-- best candidate function") to a supervisor who only wanted to save a video.
-- The app is the only caller and it always sends the whole argument set, so
-- exactly one signature should exist.
drop function if exists public.save_learning_video(
  uuid, text, uuid, text, text, text, text, text, boolean);
drop function if exists public.save_learning_video(
  uuid, text, uuid, text, text, text, text, text, boolean, uuid);

create or replace function public.save_learning_video(
  p_id uuid,
  p_title text,
  p_window_type uuid default null,
  p_topic text default null,
  p_video_path text default null,
  p_youtube_url text default null,
  p_summary text default null,
  p_transcript text default null,
  p_active boolean default true,
  p_grants_clearance uuid default null,
  p_status text default null
)
returns learning_videos
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role text;
  v_status text;
  v_row learning_videos;
begin
  select role into v_role from profiles where id = auth.uid();
  if v_role is null or v_role in ('installer', 'foreman') then
    raise exception 'only a supervisor or above can manage training videos';
  end if;
  if p_title is null or length(trim(p_title)) = 0 then
    raise exception 'a training video needs a title';
  end if;
  if p_video_path is null and nullif(trim(coalesce(p_youtube_url, '')), '') is null then
    raise exception 'upload a video or paste a YouTube address';
  end if;

  v_status := nullif(trim(coalesce(p_status, '')), '');
  if v_status is not null and v_status not in ('draft', 'published') then
    raise exception 'a training video is either a draft or published';
  end if;

  if p_id is null then
    insert into learning_videos (
      title, window_type_id, topic, video_path, youtube_url,
      summary, transcript, active, created_by, grants_clearance, status
    )
    values (
      trim(p_title), p_window_type, nullif(trim(coalesce(p_topic, '')), ''),
      p_video_path, nullif(trim(coalesce(p_youtube_url, '')), ''),
      p_summary, p_transcript, coalesce(p_active, true), auth.uid()::text,
      p_grants_clearance,
      -- A brand new lesson is a DRAFT unless the caller says otherwise. The
      -- column default cannot do this job: it has to stay 'published' so the
      -- lessons that predate this migration keep working.
      coalesce(v_status, 'draft')
    )
    returning * into v_row;
  else
    update learning_videos
    set title = trim(p_title),
        window_type_id = p_window_type,
        topic = nullif(trim(coalesce(p_topic, '')), ''),
        video_path = p_video_path,
        youtube_url = nullif(trim(coalesce(p_youtube_url, '')), ''),
        summary = p_summary,
        transcript = p_transcript,
        active = coalesce(p_active, true),
        grants_clearance = p_grants_clearance,
        -- Silence means "leave it where it is". An ordinary edit of a
        -- published lesson must not quietly unpublish it, and an edit of a
        -- draft must not publish it — publishing is its own deliberate tap.
        status = coalesce(v_status, learning_videos.status),
        updated_at = now()
    where id = p_id
    returning * into v_row;
    if not found then
      raise exception 'training video not found';
    end if;
  end if;
  return v_row;
end;
$$;

comment on function public.save_learning_video(uuid, text, uuid, text, text, text, text, text, boolean, uuid, text) is
  'Create or update a training video (supervisor+). A new row is born draft; an edit leaves status exactly as it found it, so publishing is always its own deliberate act.';

revoke all on function public.save_learning_video(uuid, text, uuid, text, text, text, text, text, boolean, uuid, text) from public, anon;
grant execute on function public.save_learning_video(uuid, text, uuid, text, text, text, text, text, boolean, uuid, text) to authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 3. U1 — Publish
-- ---------------------------------------------------------------------------
--
-- One tap at the end of the flow. Its own function rather than a flag on the
-- save above because that is what the Inbox needs: a supervisor scrolling a
-- list of drafts publishes one without opening it, and nothing else about the
-- row changes.

create or replace function public.publish_learning_video(p_id uuid)
returns learning_videos
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row learning_videos;
begin
  if public.my_role_rank() < 2 then
    raise exception 'Only a supervisor or above can publish a training video.';
  end if;

  update learning_videos
  set status = 'published',
      updated_at = now()
  where id = p_id
  returning * into v_row;

  if not found then
    raise exception 'That training video is not there any more.';
  end if;
  return v_row;
end;
$$;

comment on function public.publish_learning_video(uuid) is
  'Flip one training video from draft to published so crews can see it. Supervisor+ only.';

revoke all on function public.publish_learning_video(uuid) from public, anon;
grant execute on function public.publish_learning_video(uuid) to authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 4. U2 — who to send a recording to
-- ---------------------------------------------------------------------------
--
-- The button on Learn and on My Work opens the phone's mail composer already
-- addressed to the installer's lead. To do that it needs an email address, and
-- there is no email address anywhere a client can read: `profiles` has no email
-- column at all (20260715240000) and the addresses live in `auth.users`, which
-- the `authenticated` role cannot touch. Hence this function.
--
-- MINIMAL PROJECTION, and only that. It returns a display name and an email,
-- for foreman-and-above, and nothing else — never a profiles row, never a
-- phone, never a rank, never an id. Two named columns are the whole contract,
-- so a future column on `profiles` cannot leak through it by accident, which is
-- exactly what a `select p.*` here would have guaranteed one day.
--
-- WHO COUNTS AS "ON THE JOB": the same answer wave J's pipeline sweep gives
-- (pipeline_nudge_audience, 20260979000000) — a lead on a PUBLISHED assignment
-- covering today, or one standing on the job right now with an open shift. A
-- draft assignment does not count; the crew has not been shown it. When the
-- caller is not clocked into a job, or nobody on it qualifies, it falls back to
-- every active lead in the company — an installer with a video always has
-- somebody to send it to, which is the whole point.
--
-- Partners are refused outright. A builder login is not crew and must never be
-- handed the crew's address book.
--
-- The two returned columns are named contact_name / contact_email rather than
-- display_name / email on purpose. It says what they are — a contact card, not
-- a profiles row — and it keeps every identifier inside the body unambiguous:
-- an OUT parameter sharing a name with a column of a table the body queries is
-- the classic way a plpgsql function that reads fine refuses to compile.
create or replace function public.foreman_contacts_for_me()
returns table (contact_name text, contact_email text)
language plpgsql
stable
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_project uuid;
begin
  if v_uid is null then
    raise exception 'Sign in first.';
  end if;
  if public.is_partner_user() then
    raise exception 'This is the crew address book, and a builder login is not crew.';
  end if;

  -- The job the caller is standing on, if any. Newest open shift wins, the
  -- same way getOpenShift() picks one on the phone.
  select ts.project_id into v_project
    from time_shifts ts
   where ts.profile_id = v_uid
     and ts.status = 'open'
     and ts.clock_out_at is null
   order by ts.clock_in_at desc
   limit 1;

  if v_project is not null then
    return query
      select p.display_name, u.email::text
        from profiles p
        join auth.users u on u.id = p.id
       where p.active
         and not coalesce(p.is_partner, false)
         and public._is_lead(p.id)
         and p.id <> v_uid
         and u.email is not null
         and (
           exists (
             select 1
               from schedule_assignments sa
               join schedule_assignment_members sam on sam.assignment_id = sa.id
              where sa.project_id = v_project
                and sam.profile_id = p.id
                -- Published, not drafted — see pipeline_nudge_audience's own
                -- note on why a pencilled-in plan must not count.
                and sa.status in ('published', 'in_progress', 'done')
                and sa.end_date >= (now() at time zone 'America/Denver')::date
                and sa.start_date <= (now() at time zone 'America/Denver')::date
           )
           or exists (
             select 1
               from time_shifts ts2
              where ts2.project_id = v_project
                and ts2.profile_id = p.id
                and ts2.status = 'open'
                and ts2.clock_out_at is null
           )
         )
       order by p.display_name;
    -- RETURN QUERY sets FOUND. Somebody answered, so stop here rather than
    -- adding every other lead in the company to the To: line.
    if found then
      return;
    end if;
  end if;

  return query
    select p.display_name, u.email::text
      from profiles p
      join auth.users u on u.id = p.id
     where p.active
       and not coalesce(p.is_partner, false)
       and public._is_lead(p.id)
       and p.id <> v_uid
       and u.email is not null
     order by p.display_name;
end;
$$;

comment on function public.foreman_contacts_for_me() is
  'The name and email of every foreman-and-up on the job the caller is clocked into, else every active one in the company. A MINIMAL PROJECTION — two columns, nothing else about anybody — because emails live in auth.users where no client role may read them. Refuses partner logins.';

revoke all on function public.foreman_contacts_for_me() from public, anon;
grant execute on function public.foreman_contacts_for_me() to authenticated, service_role;


-- ===========================================================================
-- 20260985000000_clock_the_crew.sql (mirrored)
-- Clock the crew in and out from the roster: time_shifts.clocked_in_by /
-- clocked_out_by, toolbox_completions.signed_by / signed_via (the group
-- sign-in), and the supervisor+ RPCs clock_in_for / clock_out_for and their
-- bulk clock_in_many / clock_out_many loops.
-- ===========================================================================

-- Clock the crew in and out from the roster (owner ask, 2026-09-04).
--
-- WHAT HE SAW: fourteen people on Team timecards, every one of them clocked
-- into OFFICE a minute or two apart. Somebody stood in the shop and punched
-- fourteen phones in by hand, one at a time, and the timestamps are the
-- fingerprint of it. He asked for one tap that clocks the whole list in — and
-- one that clocks them out again at the end of the day.
--
-- THE HONESTY PROBLEM this creates, and how it is answered here. Every punch
-- in this database has meant "this person tapped this button". A punch a
-- supervisor makes FOR somebody is a different fact, and if it looked
-- identical the timecard would quietly stop being evidence of anything:
--
--   * time_shifts.clocked_in_by / clocked_out_by say who pressed it. NULL
--     keeps its old meaning — the person themselves — so every row that
--     already exists reads correctly without a backfill.
--   * every on-behalf punch also writes a time_shift_edits row, so it lands
--     in the audit trail supervisors already read AND in the worker's own
--     "Your timecard was changed" feed (Wave K, K4, 20260976000000). The
--     person finds out from the app, not from a short cheque.
--   * the bulk loops repeat only the refusals written here, marked with
--     `using hint = 'crew-clock'`. Anything else `when others` catches is an
--     accident, and its raw Postgres wording is logged rather than shown.
--
-- THE TOOLBOX PROBLEM, and why this is not a hole in the safety gate. Since
-- 20260718003000 nobody may clock in without today's signed toolbox talk, and
-- 20260813000000 made that day company-local. A bulk clock-in that ignored the
-- gate would let one tap put fourteen people on the clock with nobody having
-- heard a safety talk — the exact failure the gate exists to prevent. So:
--
--   * clock_in_for REFUSES unless the supervisor ticks p_talk_attested. The
--     box says "I gave today's toolbox talk to everyone selected", and that
--     claim is what is being recorded.
--   * for anybody who has not already signed today, it files a real
--     toolbox_completions row marked signed_via = 'group' with signed_by =
--     the supervisor. A group sign-in is a WEAKER record than a signature and
--     is stored as one — no typed name, no drawn signature, no PDF — but it
--     is a record, with a named person answerable for it, rather than a gate
--     switched off. Somebody who already signed for themselves keeps their
--     own row; this never overwrites a signature with an attestation.
--
-- RANK: supervisor+ (_is_supervisor, 20260810000000), the same tier that may
-- already edit and void crew time. A foreman reads this screen and cannot
-- change time on it, which is Q3's settled line; a partner login is refused
-- outright even though its pinned 'installer' rank would refuse it anyway.
--
-- IDEMPOTENT throughout: add-column-if-not-exists, a guarded create type,
-- drop-then-add for the check constraint, create-or-replace for every
-- function. Safe to run twice.
--
-- NO NEW TABLE. The on-behalf marks live on time_shifts and time_shift_edits,
-- and the group sign-in lives in toolbox_completions — three tables that all
-- already carry their partner-wall policy (20260950000000) and, being company-
-- wide rather than project-scoped, nothing for attach_sandbox_guards() to arm.
--
-- MERGE ORDER: nothing else in flight carries a migration. This is 20260985000000
-- and it lands after 20260984000000 (wave U). It touches time_shifts,
-- toolbox_completions and time_shift_edits, which no open branch touches.

-- ---------------------------------------------------------------------------
-- 1. Who pressed the button
-- ---------------------------------------------------------------------------
-- Nullable with NO default and no backfill: null means "the person themselves",
-- which is what every one of the punches already in this table is. Wave K added
-- last_seen_* to this table the same way (20260976000000).
--
-- `on delete set null` rather than cascade: a supervisor leaving the company
-- must never delete somebody else's timecard. The name goes; the punch stays.
alter table time_shifts
  add column if not exists clocked_in_by uuid references profiles(id) on delete set null;
alter table time_shifts
  add column if not exists clocked_out_by uuid references profiles(id) on delete set null;

comment on column time_shifts.clocked_in_by is
  'The supervisor who started this punch FOR the crew member, from the Team timecards roster. NULL = the person clocked themselves in, which is every punch made before 20260985000000. Written by clock_in_for(); the same event is also recorded in time_shift_edits so the worker sees it in their own notifications feed.';
comment on column time_shifts.clocked_out_by is
  'The supervisor who ended this punch FOR the crew member. NULL = the person clocked themselves out. Also set on the punch a move closes, when clock_in_for moves somebody from another job.';

create index if not exists time_shifts_clocked_in_by_idx
  on time_shifts (clocked_in_by) where clocked_in_by is not null;

-- ---------------------------------------------------------------------------
-- 2. A group sign-in on the toolbox talk
-- ---------------------------------------------------------------------------
-- signed_via defaults to 'self' so EVERY existing row, and every row the
-- worker's own sign-off path keeps inserting, reads as a real signature
-- without touching either. The clock gate is untouched: it asks only "is there
-- a row for this person today", which is the point — a group sign-in satisfies
-- it exactly like a signature does.
--
-- The screens are NOT untouched, and must not be. Recording the difference in
-- the database and then showing the two identically would be the worst of both
-- (2026-09-04 review: for a day, that is exactly what shipped — a worker's own
-- Safety page said "Signed today ✓" above a blank name for a talk they never
-- saw). lib/toolbox.ts now names these columns in every read, todayCompliance
-- counts signatures and attestations separately, and the Safety page and the
-- personal history say which one a row is. todayCompliance falls back to the
-- old two-column select on a missing-column error, so a phone running ahead of
-- this migration still gets its compliance list.
alter table toolbox_completions
  add column if not exists signed_by uuid references profiles(id) on delete set null;
alter table toolbox_completions
  add column if not exists signed_via text not null default 'self';

alter table toolbox_completions drop constraint if exists toolbox_completions_signed_via_check;
alter table toolbox_completions add constraint toolbox_completions_signed_via_check
  check (signed_via in ('self', 'group'));

comment on column toolbox_completions.signed_by is
  'Who filed this completion. NULL (or equal to profile_id) = the crew member signed for themselves. Set to the supervisor when signed_via = ''group''.';
comment on column toolbox_completions.signed_via is
  'How today''s talk was recorded: ''self'' = the crew member read it and signed it on their own phone (typed name + drawn signature + archived PDF); ''group'' = a supervisor gave the talk to a group in person and attested to it while clocking them in from the roster. A group row deliberately carries no signature and no PDF — it is a weaker record, and stored as one. Defaults to ''self'' so every pre-existing row and every self sign-off keeps its meaning.';

-- ---------------------------------------------------------------------------
-- 3. File the group sign-in, once, for one person
-- ---------------------------------------------------------------------------
-- Internal helper, called only by the SECURITY DEFINER functions below, so it
-- is granted to nobody: a crew login must not be able to sign somebody else's
-- safety talk directly.
--
-- The day comparison is 'America/Denver' spelled out — the company-local day
-- 20260813000000 settled for every clock gate. There is no helper to reuse;
-- the convention IS the literal, so this follows it rather than inventing a
-- second source of truth.
create or replace function public._file_group_toolbox_signin(
  p_profile_id uuid,
  p_by uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_day date := (now() at time zone 'America/Denver')::date;
  v_talk uuid;
begin
  -- Already covered for today — by their own signature, or by an earlier
  -- group sign-in this morning. Never a second row: the gate is satisfied,
  -- and a duplicate would make the compliance list say two people signed.
  if exists (
    select 1 from toolbox_completions tc
     where tc.profile_id = p_profile_id
       and (tc.signed_at at time zone 'America/Denver')::date = v_day
  ) then
    return;
  end if;

  -- Today's talk, if there is one. A company that has not published one yet
  -- still gets a dated record of the attestation, with no talk attached —
  -- talk_id is nullable and always has been.
  select st.id into v_talk
    from safety_talks st
   where st.talk_date = v_day
   order by st.created_at desc
   limit 1;

  insert into toolbox_completions
    (talk_id, profile_id, signed_at, typed_name, signed_by, signed_via)
  values
    (v_talk, p_profile_id, now(), null, p_by, 'group');
end;
$$;

comment on function public._file_group_toolbox_signin(uuid, uuid) is
  'Record that a supervisor gave today''s toolbox talk to this person in person, so the clock-in gate is satisfied. No-op when they are already covered for the company-local day. Internal: called only by clock_in_for / clock_in_many.';

revoke all on function public._file_group_toolbox_signin(uuid, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. One person, one answer
-- ---------------------------------------------------------------------------
-- A named composite rather than `returns table (profile_id uuid, ...)`: an OUT
-- parameter called profile_id would shadow the column of the same name on
-- time_shifts, toolbox_completions and profiles, and every unqualified
-- reference inside these bodies would become ambiguous. A type has no such
-- trap, and it lets the bulk functions be `setof` the exact same shape the
-- single-person ones return, so the client parses one row the same way it
-- parses fourteen.
do $$
begin
  create type crew_clock_result as (profile_id uuid, outcome text);
exception when duplicate_object then
  null;
end;
$$;

comment on type crew_clock_result is
  'One person''s answer from an on-behalf clock action. outcome is one of: clocked_in, already_on_this_job, moved_from_other_job, clocked_out, already_out, or refused:<plain sentence>. Everything a bulk call needs to say who it actually touched.';

-- ---------------------------------------------------------------------------
-- 5. clock_in_for: a real punch, made by somebody else
-- ---------------------------------------------------------------------------
-- The rules are the ones the newest clock_in overload (20260970000000) plays
-- by, plus the ones a picker on a phone enforces client-side and a bulk call
-- from the office has no business trusting: the job is live, the cost code is
-- one this job actually uses, and the mode is one this job allows. Getting
-- fourteen punches onto a deleted job because a roster was stale is not a
-- mistake anybody would notice until payroll.
--
-- NO GEO, deliberately. Every other clock-in stamps clock_in_lat/lng from the
-- phone that pressed it. Here that phone is the supervisor's, standing in the
-- shop, and writing it onto fourteen crew punches would put fourteen people at
-- a place none of them chose to report. An absent fix is the truthful record.
--
-- p_move_if_elsewhere is the server half of the sheet's "Move anyone already on
-- another job here" box. Off by default and REFUSED rather than silently
-- honoured, because the decision has to survive the gap between reading the
-- roster and tapping the button: somebody can start their own punch on another
-- job in that half-second, and a client-side skip would move them anyway.
create or replace function public.clock_in_for(
  p_profile_id uuid,
  p_project_id uuid,
  p_cost_code_id uuid,
  p_note text default null,
  p_mode text default null,
  p_talk_attested boolean default false,
  p_move_if_elsewhere boolean default false
)
returns crew_clock_result
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_actor_name text;
  v_person profiles;
  v_project projects;
  v_open time_shifts;
  v_shift time_shifts;
  v_mode text;
  v_outcome text := 'clocked_in';
  v_moved_from text;
begin
  -- ---- who is asking ------------------------------------------------------
  if v_actor is null then
    raise exception 'Sign in before clocking anybody in.' using hint = 'crew-clock';
  end if;
  -- A builder/GC login is pinned to 'installer' (20260950000000), so the rank
  -- check below already refuses it. Said out loud anyway: this function is
  -- SECURITY DEFINER and writes straight past every policy on time_shifts, so
  -- the wall has to stand in the body, not only on the table.
  if public.is_partner_user() then
    raise exception 'Not available for your account.' using errcode = '42501', hint = 'crew-clock';
  end if;
  if not _is_supervisor(v_actor) then
    raise exception 'Only a supervisor or above can clock somebody else in.' using hint = 'crew-clock';
  end if;
  if not coalesce(p_talk_attested, false) then
    raise exception 'Give today''s toolbox talk first, then tick the box to say you did.' using hint = 'crew-clock';
  end if;

  -- ---- who is being clocked in -------------------------------------------
  select * into v_person from profiles where id = p_profile_id;
  if not found then
    raise exception 'That person is not on the crew list.' using hint = 'crew-clock';
  end if;
  if not coalesce(v_person.active, false) then
    raise exception 'They are not an active crew member.' using hint = 'crew-clock';
  end if;
  if coalesce(v_person.is_partner, false) then
    raise exception 'That is a builder login, not a crew member.' using hint = 'crew-clock';
  end if;

  -- ---- the job ------------------------------------------------------------
  select * into v_project from projects where id = p_project_id;
  if not found or v_project.deleted_at is not null then
    raise exception 'That job is not there any more.' using hint = 'crew-clock';
  end if;
  if v_project.status is distinct from 'active' then
    raise exception '% is not an active job, so nobody can put time on it.', v_project.job_code
      using hint = 'crew-clock';
  end if;

  -- ---- the cost code ------------------------------------------------------
  if p_cost_code_id is null then
    raise exception 'Pick a cost code before clocking anybody in.' using hint = 'crew-clock';
  end if;
  if not exists (
    select 1 from cost_codes cc where cc.id = p_cost_code_id and cc.active
  ) then
    raise exception 'That cost code is not in use any more.' using hint = 'crew-clock';
  end if;
  -- The same rule resolveClockCostCodes plays by on the phone (20260973000000):
  -- a job with its own subset allows only those codes, a job without one allows
  -- the whole active library, and the general catch-all is allowed either way
  -- so nobody is ever left with nothing valid to charge to.
  if exists (
        select 1 from project_cost_codes pcc where pcc.project_id = p_project_id
      )
     and not exists (
        select 1 from project_cost_codes pcc
         where pcc.project_id = p_project_id and pcc.cost_code_id = p_cost_code_id
      )
     and not exists (
        select 1 from cost_codes cc where cc.id = p_cost_code_id and cc.is_general
      )
  then
    raise exception 'That cost code is not one % uses.', v_project.job_code using hint = 'crew-clock';
  end if;

  -- ---- the mode -----------------------------------------------------------
  v_mode := case when p_mode in ('data', 'tracking') then p_mode else null end;
  if v_mode is not null and not (v_mode = any (v_project.allowed_modes)) then
    raise exception '% is not set up for % work.', v_project.job_code, v_mode
      using hint = 'crew-clock';
  end if;

  -- ---- are they already on the clock? -------------------------------------
  select * into v_open
    from time_shifts ts
   where ts.profile_id = p_profile_id
     and ts.status = 'open'
     and ts.clock_out_at is null
   order by ts.clock_in_at desc
   limit 1;

  if found then
    if v_open.project_id is not distinct from p_project_id then
      -- Already exactly where this call wanted them. Opening a second punch
      -- would split one day into two and double nothing but the paperwork.
      return (p_profile_id, 'already_on_this_job')::crew_clock_result;
    end if;
    select pj.job_code into v_moved_from from projects pj where pj.id = v_open.project_id;
    if not coalesce(p_move_if_elsewhere, false) then
      raise exception 'Already on %. Tick "Move anyone already on another job here" to bring them over.',
        coalesce(v_moved_from, 'another job') using hint = 'crew-clock';
    end if;
    v_outcome := 'moved_from_other_job';
  end if;

  select p.display_name into v_actor_name from profiles p where p.id = v_actor;
  v_actor_name := coalesce(v_actor_name, 'a supervisor');

  -- ---- the safety talk ----------------------------------------------------
  -- Files a group sign-in for anybody not already covered today, which is what
  -- makes the gate below pass honestly rather than being bypassed.
  perform public._file_group_toolbox_signin(p_profile_id, v_actor);

  -- ---- close whatever was running ----------------------------------------
  -- The shared close every clock_in overload calls (20260945000000): a
  -- believable punch is closed at now() and marked auto-closed; one that ran
  -- past the cap is put into needs_finish rather than given a made-up end.
  perform _close_dangling_shift(p_profile_id);

  if v_open.id is not null then
    -- Say who ended it, and log it, for the same reason the new punch does:
    -- a move is a clock-out somebody else performed.
    update time_shifts ts
       set clocked_out_by = v_actor
     where ts.id = v_open.id
       and ts.clock_out_at is not null
       and ts.clocked_out_by is null;

    insert into time_shift_edits (shift_id, edited_by, field, old_value, new_value, reason)
    select v_open.id, v_actor, 'clock_out', null, ts.clock_out_at::text,
           'clocked out by ' || v_actor_name || ' from the roster, moving them to '
             || v_project.job_code
      from time_shifts ts
     where ts.id = v_open.id
       and ts.clock_out_at is not null;
  end if;

  -- ---- the punch ----------------------------------------------------------
  insert into time_shifts
    (profile_id, project_id, cost_code_id, note, job_mode, clocked_in_by)
  values
    (p_profile_id, p_project_id, p_cost_code_id,
     nullif(btrim(p_note), ''), v_mode, v_actor)
  returning * into v_shift;

  -- ---- the audit trail, and with it the worker's own notice ---------------
  insert into time_shift_edits (shift_id, edited_by, field, old_value, new_value, reason)
  values (v_shift.id, v_actor, 'clock_in', null, v_shift.clock_in_at::text,
          'clocked in by ' || v_actor_name || ' from the roster');

  return (p_profile_id, v_outcome)::crew_clock_result;
end;
$$;

comment on function public.clock_in_for(uuid, uuid, uuid, text, text, boolean, boolean) is
  'Supervisor+: start a punch FOR a crew member from the Team timecards roster. Plays by the same rules as clock_in (live job, a cost code the job uses, a mode the job allows, the shared dangling-shift close) and additionally requires p_talk_attested — the supervisor''s claim that they gave today''s toolbox talk — which files a group sign-in for anybody not already covered. Stamps clocked_in_by and writes a time_shift_edits row so the worker is told. Returns (profile_id, outcome).';

revoke all on function public.clock_in_for(uuid, uuid, uuid, text, text, boolean, boolean) from public, anon;
grant execute on function public.clock_in_for(uuid, uuid, uuid, text, text, boolean, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. clock_out_for
-- ---------------------------------------------------------------------------
-- Closes at now(), the same moment clock_out uses. Two things it deliberately
-- does NOT do, both because the person is not holding the phone:
--
--   * time_confirmed is left alone. On the worker's own clock-out, leaving the
--     "my time is wrong" box unticked IS the answer "yes, it's correct". Nobody
--     answered that here, and writing `true` would put words in their mouth on
--     the one field the office reads to decide whether to look twice.
--   * a running break is folded into break_seconds instead of being abandoned,
--     so a person clocked out while at lunch is not paid for the lunch.
create or replace function public.clock_out_for(p_profile_id uuid)
returns crew_clock_result
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_actor_name text;
  v_open time_shifts;
  v_shift time_shifts;
begin
  if v_actor is null then
    raise exception 'Sign in before clocking anybody out.' using hint = 'crew-clock';
  end if;
  if public.is_partner_user() then
    raise exception 'Not available for your account.' using errcode = '42501', hint = 'crew-clock';
  end if;
  if not _is_supervisor(v_actor) then
    raise exception 'Only a supervisor or above can clock somebody else out.' using hint = 'crew-clock';
  end if;

  select * into v_open
    from time_shifts ts
   where ts.profile_id = p_profile_id
     and ts.clock_out_at is null
     and ts.status in ('open', 'needs_finish')
   order by ts.clock_in_at desc
   limit 1;

  if not found then
    -- Not an error and not a refusal: a bulk call sweeps up whoever is on the
    -- clock, and "they were already off" is a perfectly good thing to report.
    return (p_profile_id, 'already_out')::crew_clock_result;
  end if;

  if v_open.status = 'needs_finish' then
    -- The app already refused to guess an end for this one. Stamping now()
    -- here would be that same guess, made by somebody who was not there.
    raise exception 'Their punch ran too long to guess an end for. Set the real finish time on "Still on the clock".'
      using hint = 'crew-clock';
  end if;

  select p.display_name into v_actor_name from profiles p where p.id = v_actor;
  v_actor_name := coalesce(v_actor_name, 'a supervisor');

  update time_shifts ts
     set clock_out_at = now(),
         break_seconds = ts.break_seconds + case
           when ts.break_started_at is not null
             then greatest(0, floor(extract(epoch from (now() - ts.break_started_at)))::int)
           else 0
         end,
         break_started_at = null,
         break_type = null,
         signed_at = now(),
         status = 'submitted',
         clocked_out_by = v_actor
   where ts.id = v_open.id
  returning * into v_shift;

  insert into time_shift_edits (shift_id, edited_by, field, old_value, new_value, reason)
  values (v_shift.id, v_actor, 'clock_out', null, v_shift.clock_out_at::text,
          'clocked out by ' || v_actor_name || ' from the roster');

  return (p_profile_id, 'clocked_out')::crew_clock_result;
end;
$$;

comment on function public.clock_out_for(uuid) is
  'Supervisor+: close a crew member''s open punch now, stamping clocked_out_by and logging it to time_shift_edits. A person already off the clock is a no-op that answers ''already_out''. Refuses a punch the app has already stopped counting (needs_finish) rather than guessing its end. Returns (profile_id, outcome).';

revoke all on function public.clock_out_for(uuid) from public, anon;
grant execute on function public.clock_out_for(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. The whole list, in one request
-- ---------------------------------------------------------------------------
-- One tap is one round trip. Fourteen separate calls from a phone on site is
-- fourteen chances for the signal to drop halfway through, leaving half a crew
-- on the clock and nobody sure which half.
--
-- Each person is attempted inside their OWN exception block, which is a
-- subtransaction: one refusal rolls back that person and nothing else, so a
-- deactivated account or somebody who wandered onto another job cannot take
-- the other thirteen down with them. Their line comes back as
-- 'refused:<sentence>' and the roster prints it beside their name.
--
-- WHOSE WORDS end up on that line matters, and it is why every deliberate
-- refusal above carries `using hint = 'crew-clock'`. `when others` catches far
-- more than the sentences this file writes: a check constraint on time_shifts,
-- one of the unit_sessions triggers, a deadlock. Passing sqlerrm straight
-- through would print
--   Not done — new row for relation "time_shifts" violates check constraint
--   "time_shifts_job_mode_check"
-- onto a supervisor's phone, which is exactly the leak the app's own rule
-- against String(err) exists to stop. The hint is the marker that separates
-- "we refused this, on purpose, in plain English" from "something broke": the
-- first is repeated word for word, the second becomes one generic line and the
-- real text goes to the Postgres log for whoever is fixing it.
create or replace function public.clock_in_many(
  p_profile_ids uuid[],
  p_project_id uuid,
  p_cost_code_id uuid,
  p_note text default null,
  p_mode text default null,
  p_talk_attested boolean default false,
  p_move_if_elsewhere boolean default false
)
returns setof crew_clock_result
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
  v_hint text;
begin
  -- The whole-call refusals are checked ONCE, up front, and thrown rather than
  -- returned: "you are not allowed to do this" and "you have not said you gave
  -- the talk" are facts about the request, not fourteen separate outcomes.
  if auth.uid() is null then
    raise exception 'Sign in before clocking anybody in.' using hint = 'crew-clock';
  end if;
  if public.is_partner_user() then
    raise exception 'Not available for your account.' using errcode = '42501', hint = 'crew-clock';
  end if;
  if not _is_supervisor(auth.uid()) then
    raise exception 'Only a supervisor or above can clock somebody else in.' using hint = 'crew-clock';
  end if;
  if not coalesce(p_talk_attested, false) then
    raise exception 'Give today''s toolbox talk first, then tick the box to say you did.' using hint = 'crew-clock';
  end if;

  for v_id in
    select distinct u from unnest(coalesce(p_profile_ids, '{}'::uuid[])) as u
  loop
    begin
      return next public.clock_in_for(
        v_id, p_project_id, p_cost_code_id, p_note, p_mode,
        p_talk_attested, p_move_if_elsewhere);
    exception when others then
      -- Only a refusal this file WROTE is repeated to a supervisor. Everything
      -- else caught here is an accident — a check constraint, a trigger, a
      -- deadlock — and sqlerrm for those is raw Postgres wording, which is the
      -- one thing an installer-facing app must never put on a screen. It is
      -- logged instead, where whoever is fixing it can read it.
      get stacked diagnostics v_hint = pg_exception_hint;
      if v_hint is distinct from 'crew-clock' then
        raise warning 'clock_in_many: unexpected error for %: % (%)',
          v_id, sqlerrm, sqlstate;
        return next (
          v_id,
          'refused:Something went wrong for this person. Try again, or clock them in from their own phone.'
        )::crew_clock_result;
      else
        return next (v_id, 'refused:' || sqlerrm)::crew_clock_result;
      end if;
    end;
  end loop;
end;
$$;

comment on function public.clock_in_many(uuid[], uuid, uuid, text, text, boolean, boolean) is
  'Supervisor+: clock a whole selection in, one row back per person (clocked_in | already_on_this_job | moved_from_other_job | refused:<sentence>). Each person is attempted in their own subtransaction, so one refusal never rolls back the rest. Duplicated ids are collapsed.';

revoke all on function public.clock_in_many(uuid[], uuid, uuid, text, text, boolean, boolean) from public, anon;
grant execute on function public.clock_in_many(uuid[], uuid, uuid, text, text, boolean, boolean) to authenticated;

create or replace function public.clock_out_many(p_profile_ids uuid[])
returns setof crew_clock_result
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
  v_hint text;
begin
  if auth.uid() is null then
    raise exception 'Sign in before clocking anybody out.' using hint = 'crew-clock';
  end if;
  if public.is_partner_user() then
    raise exception 'Not available for your account.' using errcode = '42501', hint = 'crew-clock';
  end if;
  if not _is_supervisor(auth.uid()) then
    raise exception 'Only a supervisor or above can clock somebody else out.' using hint = 'crew-clock';
  end if;

  for v_id in
    select distinct u from unnest(coalesce(p_profile_ids, '{}'::uuid[])) as u
  loop
    begin
      return next public.clock_out_for(v_id);
    exception when others then
      -- Same rule as clock_in_many: our own sentence, or one generic line.
      get stacked diagnostics v_hint = pg_exception_hint;
      if v_hint is distinct from 'crew-clock' then
        raise warning 'clock_out_many: unexpected error for %: % (%)',
          v_id, sqlerrm, sqlstate;
        return next (
          v_id,
          'refused:Something went wrong for this person. Try again, or clock them out from their own phone.'
        )::crew_clock_result;
      else
        return next (v_id, 'refused:' || sqlerrm)::crew_clock_result;
      end if;
    end;
  end loop;
end;
$$;

comment on function public.clock_out_many(uuid[]) is
  'Supervisor+: clock a whole selection out, one row back per person (clocked_out | already_out | refused:<sentence>). Same one-subtransaction-per-person shape as clock_in_many.';

revoke all on function public.clock_out_many(uuid[]) from public, anon;
grant execute on function public.clock_out_many(uuid[]) to authenticated;

-- ===========================================================================
-- 20260986000000_warehouse_is_crew_work.sql (mirrored)
-- Warehouse actions are crew actions (ADR-0007, owner call 2026-09-04): the
-- foreman+ rank check comes off eighteen warehouse RPCs and off the takeoff
-- read policies. Destructive doors (burn/delete) stay foreman+; scheduling
-- and settings stay supervisor+. Lands AFTER 20260985000000.
-- ===========================================================================

-- Warehouse work is crew work (owner call, 2026-09-04 — ADR-0007).
--
-- Every warehouse action in this app used to draw the same line: foreman and
-- up. That line was drawn when the warehouse was one person's job. It isn't:
-- the person at the tailgate at 6am, the person who puts the crate in the
-- conex, and the person who drives to the yard for one more tube of caulk are
-- all installers. Making them wait for a lead to tap a button is how material
-- ends up untracked — the rule stopped protecting anything and started
-- costing the record.
--
-- So the floor drops to "any crew member" for the ordinary warehouse actions,
-- and stays where it is for exactly two kinds of door:
--
--   Destructive (foreman+, untouched here): burn_packages, delete_packages,
--   delete_delivery. These END things — a burned label, a deleted package, a
--   deleted truck. Nothing about opening putaway argues for opening those.
--
--   Scheduling and settings (supervisor+, untouched here): schedule_delivery,
--   save_checkout_reason. Putting a truck on the company calendar and editing
--   the company's reason list are office decisions, not warehouse work.
--
-- WHAT CHANGED IN EACH FUNCTION BELOW: the rank check, and nothing else.
-- Every one is rebuilt IN FULL from its CURRENT definition (the latest
-- migration that defines it, named above each block), with the rank check
-- replaced by the two questions that still matter — are you signed in, and
-- are you a builder login. Every validation, every refusal, every movement
-- line and every message is byte-for-byte what it was.
--
-- THE PARTNER WALL IS THE REASON THE PARTNER LINE IS NEW, NOT MISSING BEFORE.
-- A builder login (wave S, 20260950000000) carries `role = 'installer'` — the
-- rank floor — with `is_partner` telling it apart. Until today, the foreman+
-- rank check was ALSO what kept partners out of these RPCs. Drop the rank and
-- that protection would leave with it, silently. So every function opened here
-- gains an explicit `is_partner_user()` refusal in the same breath: the wall
-- stands exactly where it stood, on its own legs now instead of leaning on a
-- rank check that no longer exists.
--
-- Deploy order: this migration must land AFTER 20260985000000
-- (clock-crew-in-and-out), which is in flight.


-- ==========================================================================
-- Coming in — stickers and labels
-- ==========================================================================

-- mint_packages — rebuilt from 20260814000000_storage_tracking.sql
create or replace function mint_packages(p_count int)
returns setof packages
language plpgsql
security definer
as $$
declare
  i int;
  v_row packages;
begin
  -- Warehouse work is crew work (ADR-0007, owner call 2026-09-04). The rank
  -- check that stood here is gone; signed in, and not a builder login, is
  -- the whole door now. Every other line of this function is byte-for-byte
  -- what it was.
  if auth.uid() is null then
    raise exception 'sign in first';
  end if;
  if public.is_partner_user() then
    raise exception 'Only a crew member can do warehouse work.'
      using errcode = '42501';
  end if;
  if p_count is null or p_count < 1 or p_count > 500 then
    raise exception 'sticker batches are 1-500 at a time';
  end if;

  for i in 1..p_count loop
    insert into packages (short_code)
    values (issue_package_short_code())
    returning * into v_row;
    return next v_row;
  end loop;
  return;
end;
$$;

-- mint_mark_packages — rebuilt from 20260906000000_minted_packages.sql
create or replace function mint_mark_packages(
  p_project uuid,
  p_mark text,
  p_total int,
  p_category text default 'windows'
)
returns setof packages
language plpgsql
security definer
set search_path = public
as $$
declare
  v_mark uuid;
  v_mark_code text;
  v_existing_total int;
  v_have int[];
  i int;
  v_row packages;
begin
  -- Warehouse work is crew work (ADR-0007, owner call 2026-09-04). The rank
  -- check that stood here is gone; signed in, and not a builder login, is
  -- the whole door now. Every other line of this function is byte-for-byte
  -- what it was.
  if auth.uid() is null then
    raise exception 'sign in first';
  end if;
  if public.is_partner_user() then
    raise exception 'Only a crew member can do warehouse work.'
      using errcode = '42501';
  end if;
  if p_total is null or p_total < 1 or p_total > 20 then
    raise exception 'a window arrives as 1 to 20 packages';
  end if;

  v_mark_code := upper(trim(coalesce(p_mark, '')));
  select id into v_mark
  from project_marks
  where project_id = p_project and mark_code = v_mark_code;
  if v_mark is null then
    raise exception 'mark % is not on this job''s schedule', v_mark_code;
  end if;

  -- Every package already carrying this mark, whatever its stage. A label
  -- that disagrees about the total is a contradiction, not a top-up.
  select array_agg(distinct p.part_index) filter (where p.part_index is not null),
         max(p.part_total)
    into v_have, v_existing_total
  from packages p
  join package_marks pm on pm.package_id = p.id
  where pm.mark_id = v_mark;

  if v_existing_total is not null and v_existing_total <> p_total then
    raise exception
      'window % already has labels saying "of %" — burn those first if the count is really %',
      v_mark_code, v_existing_total, p_total;
  end if;

  for i in 1..p_total loop
    if v_have is not null and i = any(v_have) then
      continue; -- that part slot already has its label
    end if;
    insert into packages
      (status, project_id, category, part_index, part_total,
       short_code, bound_at, bound_by)
    values
      ('minted', p_project, p_category, i, p_total,
       issue_package_short_code(), now(), auth.uid()::text)
    returning * into v_row;

    insert into package_marks (package_id, mark_id)
    values (v_row.id, v_mark)
    on conflict do nothing;

    -- 'preissued' is already in movements_event_ck — the unit chain put it
    -- there, and this is its idea living on. The constraint stays untouched.
    insert into movements (package_id, event, project_id, actor, reason)
    values (v_row.id, 'preissued', p_project, auth.uid()::text,
            'label minted — part ' || i || ' of ' || p_total);

    return next v_row;
  end loop;
  return;
end;
$$;

-- add_project_mark — rebuilt from 20260913000000_add_project_mark.sql
-- Not on the original inventory, and it has to be here: the tag screen's
-- "Add window N to the schedule" button — opened to every crew member in
-- this same wave — is this RPC. Leaving it foreman+ would put a live
-- button in front of an installer that answers with a refusal.
create or replace function add_project_mark(p_project uuid, p_mark text)
returns project_marks
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text;
  v_row project_marks;
begin
  -- Warehouse work is crew work (ADR-0007, owner call 2026-09-04). The rank
  -- check that stood here is gone; signed in, and not a builder login, is
  -- the whole door now. Every other line of this function is byte-for-byte
  -- what it was.
  if auth.uid() is null then
    raise exception 'sign in first';
  end if;
  if public.is_partner_user() then
    raise exception 'Only a crew member can do warehouse work.'
      using errcode = '42501';
  end if;
  if not exists (select 1 from projects where id = p_project) then
    raise exception 'job not found';
  end if;
  v_code := upper(trim(coalesce(p_mark, '')));
  if v_code = '' or length(v_code) > 12 then
    raise exception 'a window number is 1 to 12 characters';
  end if;

  insert into project_marks (project_id, mark_code)
  values (p_project, v_code)
  on conflict (project_id, mark_code) do nothing;

  select * into v_row
  from project_marks
  where project_id = p_project and mark_code = v_code;
  return v_row;
end;
$$;

-- set_mark_part_total — rebuilt from 20260912000000_set_mark_part_total.sql
create or replace function set_mark_part_total(
  p_project uuid,
  p_mark text,
  p_total int
)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_mark uuid;
  v_mark_code text;
  v_max_index int;
  v_count int;
begin
  -- Warehouse work is crew work (ADR-0007, owner call 2026-09-04). The rank
  -- check that stood here is gone; signed in, and not a builder login, is
  -- the whole door now. Every other line of this function is byte-for-byte
  -- what it was.
  if auth.uid() is null then
    raise exception 'sign in first';
  end if;
  if public.is_partner_user() then
    raise exception 'Only a crew member can do warehouse work.'
      using errcode = '42501';
  end if;
  if p_total is null or p_total < 1 or p_total > 20 then
    raise exception 'a window arrives as 1 to 20 packages';
  end if;

  v_mark_code := upper(trim(coalesce(p_mark, '')));
  select id into v_mark
  from project_marks
  where project_id = p_project and mark_code = v_mark_code;
  if v_mark is null then
    raise exception 'mark % is not on this job''s schedule', v_mark_code;
  end if;

  select max(p.part_index), count(*)
    into v_max_index, v_count
  from packages p
  join package_marks pm on pm.package_id = p.id
  where pm.mark_id = v_mark and p.status <> 'blank';

  if v_count = 0 then
    raise exception 'window % has no packages yet — nothing to renumber', v_mark_code;
  end if;
  -- Shrinking below an existing part number would orphan real paper: a
  -- package printed "4 of 4" cannot live under "of 3".
  if v_max_index is not null and p_total < v_max_index then
    raise exception
      'window % already has a part numbered % — the count cannot be smaller than that',
      v_mark_code, v_max_index;
  end if;

  update packages p
  set part_total = p_total
  from package_marks pm
  where pm.package_id = p.id
    and pm.mark_id = v_mark
    and p.status <> 'blank'
    and p.part_total is distinct from p_total;

  insert into movements (event, project_id, actor, reason)
  values (
    'override', p_project, auth.uid()::text,
    'window ' || v_mark_code || ' package count set to ' || p_total ||
      ' — every part label now reads "of ' || p_total || '"'
  );

  return v_count;
end;
$$;

-- ==========================================================================
-- Put away — containers, areas, windows, jobs
-- ==========================================================================

-- save_storage_container — rebuilt from 20260903000000_container_address_history.sql
create or replace function save_storage_container(
  p_id uuid,
  p_name text,
  p_address text default null,
  p_access_code text default null,
  p_notes text default null,
  p_active boolean default true,
  p_kind text default null,
  p_length_cm numeric default null,
  p_width_cm numeric default null,
  p_height_cm numeric default null,
  p_weight_kg numeric default null
)
returns storage_containers
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row storage_containers;
  v_old_address text;
begin
  -- Warehouse work is crew work (ADR-0007, owner call 2026-09-04). The rank
  -- check that stood here is gone; signed in, and not a builder login, is
  -- the whole door now. Every other line of this function is byte-for-byte
  -- what it was.
  if auth.uid() is null then
    raise exception 'sign in first';
  end if;
  if public.is_partner_user() then
    raise exception 'Only a crew member can do warehouse work.'
      using errcode = '42501';
  end if;
  if p_name is null or length(trim(p_name)) = 0 then
    raise exception 'a container needs a name';
  end if;

  if p_id is null then
    if coalesce(p_kind, 'conex') = 'building'
       and exists (select 1 from storage_containers where kind = 'building') then
      raise exception 'there is already a building — the main warehouse is one of a kind';
    end if;
    insert into storage_containers
      (name, address, access_code, notes, active, kind,
       length_cm, width_cm, height_cm, weight_kg)
    values
      (trim(p_name), p_address, p_access_code, p_notes, coalesce(p_active, true),
       coalesce(p_kind, 'conex'),
       p_length_cm, p_width_cm, p_height_cm, p_weight_kg)
    returning * into v_row;
  else
    select address into v_old_address from storage_containers where id = p_id;
    if not found then
      raise exception 'container not found';
    end if;

    update storage_containers
    set name = trim(p_name), address = p_address, access_code = p_access_code,
        notes = p_notes, active = coalesce(p_active, true),
        length_cm = p_length_cm, width_cm = p_width_cm,
        height_cm = p_height_cm, weight_kg = p_weight_kg
    where id = p_id
    returning * into v_row;

    -- The trail. Whitespace-insensitive so a stray space is not a "move", and
    -- written AFTER the update so a failed update writes no phantom line.
    if nullif(trim(coalesce(v_old_address, '')), '')
       is distinct from nullif(trim(coalesce(p_address, '')), '') then
      insert into movements (container_id, event, actor, reason)
      values (
        p_id,
        'moved',
        auth.uid()::text,
        case
          when nullif(trim(coalesce(v_old_address, '')), '') is null
            then 'address set: ' || trim(p_address)
          when nullif(trim(coalesce(p_address, '')), '') is null
            then 'address cleared — was ' || trim(v_old_address)
          else 'address changed: ' || trim(v_old_address) || ' → ' || trim(p_address)
        end
      );
    end if;
  end if;
  return v_row;
end;
$$;

-- set_package_area — rebuilt from 20260923030000_package_zones.sql
-- ADR-0006 said "foreman and up set it". ADR-0007 supersedes that one
-- sentence and nothing else in ADR-0006: an area is still a pointer, not a
-- place, still cleared by every move, still no label printed for it.
create or replace function set_package_area(p_package uuid, p_area text)
returns packages
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row packages;
  v_kind text;
  v_allowed text[];
begin
  -- Warehouse work is crew work (ADR-0007, owner call 2026-09-04). The rank
  -- check that stood here is gone; signed in, and not a builder login, is
  -- the whole door now. Every other line of this function is byte-for-byte
  -- what it was.
  if auth.uid() is null then
    raise exception 'sign in first';
  end if;
  if public.is_partner_user() then
    raise exception 'Only a crew member can do warehouse work.'
      using errcode = '42501';
  end if;

  select p.* into v_row from packages p where p.id = p_package;
  if not found then
    raise exception 'package not found';
  end if;

  if p_area is not null then
    if v_row.container_id is null then
      raise exception 'put it in a box first — an area is where inside the box it sits';
    end if;
    select kind into v_kind from storage_containers where id = v_row.container_id;
    if coalesce(v_kind, 'conex') = 'building' then
      v_allowed := array['north','northeast','east','southeast',
                         'south','southwest','west','northwest','middle'];
    else
      -- Anything that moves: the compass would lie the day the box is
      -- re-parked facing the other way, so it only gets the door-relative
      -- three plus their six finer zones (ADR-0006, owner call).
      v_allowed := array['front','middle','back',
                         'front-left','front-right','middle-left','middle-right',
                         'back-left','back-right'];
    end if;
    if not (p_area = any(v_allowed)) then
      raise exception 'that area does not fit this kind of box';
    end if;
  end if;

  update packages set area = p_area where id = p_package
  returning * into v_row;
  return v_row;
end;
$$;

-- set_package_window — rebuilt from 20260914000000_set_package_window.sql
create or replace function set_package_window(p_package uuid, p_mark text)
returns packages
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row packages;
  v_mark uuid;
  v_code text;
  v_old text;
begin
  -- Warehouse work is crew work (ADR-0007, owner call 2026-09-04). The rank
  -- check that stood here is gone; signed in, and not a builder login, is
  -- the whole door now. Every other line of this function is byte-for-byte
  -- what it was.
  if auth.uid() is null then
    raise exception 'sign in first';
  end if;
  if public.is_partner_user() then
    raise exception 'Only a crew member can do warehouse work.'
      using errcode = '42501';
  end if;

  select p.* into v_row from packages p where p.id = p_package;
  if not found then
    raise exception 'package not found';
  end if;
  if v_row.status = 'blank' then
    raise exception 'that sticker is not on a package yet — tag it first';
  end if;
  if v_row.project_id is null then
    raise exception 'Boneyard stock has no window — assign it to a job first';
  end if;

  v_code := upper(trim(coalesce(p_mark, '')));
  select id into v_mark
  from project_marks
  where project_id = v_row.project_id and mark_code = v_code;
  if v_mark is null then
    raise exception 'mark % is not on this job''s schedule', v_code;
  end if;

  select string_agg(pm2.mark_code, ', ') into v_old
  from package_marks pm
  join project_marks pm2 on pm2.id = pm.mark_id
  where pm.package_id = p_package;

  delete from package_marks where package_id = p_package;
  insert into package_marks (package_id, mark_id)
  values (p_package, v_mark)
  on conflict do nothing;

  insert into movements (package_id, event, project_id, actor, reason)
  values (
    p_package, 'assigned', v_row.project_id, auth.uid()::text,
    case
      when v_old is null then 'window set to ' || v_code || ' — tagged without one'
      else 'window changed: ' || v_old || ' → ' || v_code
    end
  );

  return v_row;
end;
$$;

-- assign_package_to_job — rebuilt from 20260929000000_assign_clears_pending.sql
-- CONTEXT.md called this "the foreman-and-up action"; ADR-0007 makes it
-- any crew member's. The refusals it already carries do the real work —
-- only Boneyard stock can be assigned, and only to a window on that job's
-- schedule.
create or replace function assign_package_to_job(
  p_package uuid,
  p_project uuid,
  p_mark text
)
returns packages
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row packages;
  v_mark uuid;
  v_mark_code text;
  v_job text;
  v_issue uuid;
begin
  -- Warehouse work is crew work (ADR-0007, owner call 2026-09-04). The rank
  -- check that stood here is gone; signed in, and not a builder login, is
  -- the whole door now. Every other line of this function is byte-for-byte
  -- what it was.
  if auth.uid() is null then
    raise exception 'sign in first';
  end if;
  if public.is_partner_user() then
    raise exception 'Only a crew member can do warehouse work.'
      using errcode = '42501';
  end if;
  if p_project is null then
    raise exception 'pick the job this package is going on';
  end if;

  select p.* into v_row from packages p where p.id = p_package;
  if not found then
    raise exception 'package not found';
  end if;
  if v_row.status = 'blank' then
    raise exception 'that sticker is not on a package yet — tag it first';
  end if;
  if v_row.project_id is not null then
    raise exception 'this package already belongs to a job — only Boneyard stock can be assigned';
  end if;

  v_issue := v_row.pending_issue_id;

  v_mark_code := upper(trim(coalesce(p_mark, '')));
  if v_mark_code = '' then
    raise exception 'pick the window this package becomes part of';
  end if;
  select id into v_mark
  from project_marks
  where project_id = p_project and mark_code = v_mark_code;
  if v_mark is null then
    raise exception 'mark % is not on this job''s schedule', v_mark_code;
  end if;

  update packages
  set project_id = p_project,
      pending_job_name = null,
      pending_issue_id = null
  where id = p_package
  returning * into v_row;

  insert into package_marks (package_id, mark_id)
  values (p_package, v_mark)
  on conflict do nothing;

  select job_code into v_job from projects where id = p_project;
  insert into movements (package_id, event, project_id, actor, reason)
  values (
    p_package, 'assigned', p_project, auth.uid()::text,
    'assigned from the Boneyard to ' || coalesce(v_job, 'a job') ||
      ' as window ' || v_mark_code
  );

  -- The missing_job issue resolves when its last waiting package files —
  -- byte-for-byte the rule file_pending_packages follows.
  if v_issue is not null and not exists (
    select 1 from packages
    where pending_issue_id = v_issue and project_id is null
  ) then
    update issues
       set status = 'resolved', resolved_by = auth.uid(), resolved_at = now()
     where id = v_issue and status = 'open';
  end if;

  return v_row;
end;
$$;

-- ==========================================================================
-- Supplies and takeoffs
-- ==========================================================================

-- add_supply — rebuilt from 20260829000000_lock_movements_and_supplies.sql
create or replace function add_supply(p_name text, p_unit text default 'ea')
returns supplies
language plpgsql
security definer
as $$
declare
  v_name text := nullif(trim(coalesce(p_name, '')), '');
  v_row supplies;
begin
  -- Warehouse work is crew work (ADR-0007, owner call 2026-09-04). The rank
  -- check that stood here is gone; signed in, and not a builder login, is
  -- the whole door now. Every other line of this function is byte-for-byte
  -- what it was.
  if auth.uid() is null then
    raise exception 'sign in first';
  end if;
  if public.is_partner_user() then
    raise exception 'Only a crew member can do warehouse work.'
      using errcode = '42501';
  end if;
  if v_name is null then
    raise exception 'give the supply a name';
  end if;

  -- Case-insensitive duplicate guard: "Caulk", "caulk" and "CAULK" are one
  -- supply, and a split catalog makes every count on it meaningless.
  select * into v_row from supplies where lower(name) = lower(v_name) limit 1;
  if found then
    return v_row;
  end if;

  insert into supplies (name, unit)
  values (v_name, coalesce(nullif(trim(coalesce(p_unit, '')), ''), 'ea'))
  returning * into v_row;
  return v_row;
end;
$$;

-- set_supply_home — rebuilt from 20260916000000_supply_home_container.sql
create or replace function set_supply_home(
  p_supply uuid,
  p_location uuid default null,
  p_container uuid default null,
  p_note text default null
)
returns supplies
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row supplies;
begin
  -- Warehouse work is crew work (ADR-0007, owner call 2026-09-04). The rank
  -- check that stood here is gone; signed in, and not a builder login, is
  -- the whole door now. Every other line of this function is byte-for-byte
  -- what it was.
  if auth.uid() is null then
    raise exception 'sign in first';
  end if;
  if public.is_partner_user() then
    raise exception 'Only a crew member can do warehouse work.'
      using errcode = '42501';
  end if;
  if p_container is not null
     and not exists (select 1 from storage_containers where id = p_container and active) then
    raise exception 'that container is not on the list (or is archived)';
  end if;

  update supplies
  set home_location_id = p_location,
      home_container_id = p_container,
      home_note = nullif(trim(coalesce(p_note, '')), '')
  where id = p_supply
  returning * into v_row;
  if not found then
    raise exception 'that supply is not in the catalog';
  end if;
  return v_row;
end;
$$;

-- create_takeoff — rebuilt from 20260917000000_takeoffs.sql
create or replace function create_takeoff(
  p_project uuid,
  p_for uuid,
  p_items jsonb,
  p_note text default null,
  p_ready boolean default false
)
returns takeoffs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row takeoffs;
  v_item jsonb;
  v_supply uuid;
  v_qty numeric;
  v_count int := 0;
begin
  -- Warehouse work is crew work (ADR-0007, owner call 2026-09-04). The rank
  -- check that stood here is gone; signed in, and not a builder login, is
  -- the whole door now. Every other line of this function is byte-for-byte
  -- what it was.
  if auth.uid() is null then
    raise exception 'sign in first';
  end if;
  if public.is_partner_user() then
    raise exception 'Only a crew member can do warehouse work.'
      using errcode = '42501';
  end if;
  if not exists (select 1 from projects where id = p_project) then
    raise exception 'job not found';
  end if;
  if p_for is not null and not exists (select 1 from profiles where id = p_for) then
    raise exception 'that person is not on the roster';
  end if;

  insert into takeoffs (project_id, for_profile_id, created_by, status, note,
                        ready_at)
  values (
    p_project,
    coalesce(p_for, auth.uid()),
    auth.uid(),
    case when coalesce(p_ready, false) then 'ready' else 'requested' end,
    nullif(trim(coalesce(p_note, '')), ''),
    case when coalesce(p_ready, false) then now() end
  )
  returning * into v_row;

  for v_item in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb))
  loop
    v_supply := (v_item->>'supply_id')::uuid;
    v_qty := (v_item->>'qty')::numeric;
    if v_supply is null or v_qty is null or v_qty <= 0 then
      raise exception 'every line needs a supply and a count above zero';
    end if;
    if not exists (select 1 from supplies where id = v_supply) then
      raise exception 'a line names a supply that is not in the catalog';
    end if;
    insert into takeoff_items (takeoff_id, supply_id, qty)
    values (v_row.id, v_supply, v_qty);
    v_count := v_count + 1;
  end loop;
  if v_count = 0 then
    raise exception 'a takeoff needs at least one line';
  end if;

  return v_row;
end;
$$;

-- acknowledge_takeoff — rebuilt from 20260917000000_takeoffs.sql
create or replace function acknowledge_takeoff(
  p_takeoff uuid,
  p_eta text default null,
  p_eta_note text default null
)
returns takeoffs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row takeoffs;
begin
  -- Warehouse work is crew work (ADR-0007, owner call 2026-09-04). The rank
  -- check that stood here is gone; signed in, and not a builder login, is
  -- the whole door now. Every other line of this function is byte-for-byte
  -- what it was.
  if auth.uid() is null then
    raise exception 'sign in first';
  end if;
  if public.is_partner_user() then
    raise exception 'Only a crew member can do warehouse work.'
      using errcode = '42501';
  end if;
  update takeoffs
  set status = 'acknowledged',
      acknowledged_at = now(),
      eta = p_eta,
      eta_note = nullif(trim(coalesce(p_eta_note, '')), '')
  where id = p_takeoff and status = 'requested'
  returning * into v_row;
  if not found then
    raise exception 'that request is not waiting for an answer';
  end if;
  return v_row;
end;
$$;

-- ready_takeoff — rebuilt from 20260917000000_takeoffs.sql
create or replace function ready_takeoff(p_takeoff uuid)
returns takeoffs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row takeoffs;
begin
  -- Warehouse work is crew work (ADR-0007, owner call 2026-09-04). The rank
  -- check that stood here is gone; signed in, and not a builder login, is
  -- the whole door now. Every other line of this function is byte-for-byte
  -- what it was.
  if auth.uid() is null then
    raise exception 'sign in first';
  end if;
  if public.is_partner_user() then
    raise exception 'Only a crew member can do warehouse work.'
      using errcode = '42501';
  end if;
  update takeoffs
  set status = 'ready', ready_at = now()
  where id = p_takeoff and status in ('requested', 'acknowledged')
  returning * into v_row;
  if not found then
    raise exception 'that takeoff is not in a state that can become ready';
  end if;
  return v_row;
end;
$$;

-- ==========================================================================
-- Deliveries and sets
-- ==========================================================================

-- create_manual_delivery — rebuilt from 20260932000000_crates_are_packages.sql
create or replace function create_manual_delivery(
  p_label text,
  p_entries jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_delivery uuid;
  v_entry jsonb;
  v_set jsonb;
  v_project uuid;
  v_job_name text;
  v_issue uuid;
  v_crate_name text;
  v_created int := 0;
  v_unfiled int := 0;
  v_entry_count int := 0;
  v_set_count int;
  v_n int;
begin
  -- Warehouse work is crew work (ADR-0007, owner call 2026-09-04). The rank
  -- check that stood here is gone; signed in, and not a builder login, is
  -- the whole door now. Every other line of this function is byte-for-byte
  -- what it was.
  if auth.uid() is null then
    raise exception 'sign in first';
  end if;
  if public.is_partner_user() then
    raise exception 'Only a crew member can do warehouse work.'
      using errcode = '42501';
  end if;
  if p_entries is null or jsonb_typeof(p_entries) <> 'array'
     or jsonb_array_length(p_entries) < 1 then
    raise exception 'Log at least one job''s material.';
  end if;
  if jsonb_array_length(p_entries) > 17 then
    raise exception 'A delivery covers at most 17 jobs.';
  end if;

  insert into package_deliveries (label, arrived_on, created_by)
  values (
    coalesce(nullif(trim(p_label), ''), 'Hand-logged delivery'),
    current_date,
    auth.uid()::text
  )
  returning id into v_delivery;

  for v_entry in select * from jsonb_array_elements(p_entries) loop
    v_entry_count := v_entry_count + 1;
    v_project := nullif(v_entry->>'project_id', '')::uuid;
    v_job_name := nullif(trim(coalesce(v_entry->>'job_name', '')), '');
    if v_project is null and v_job_name is null then
      raise exception 'Entry % names no job.', v_entry_count;
    end if;
    if jsonb_typeof(v_entry->'sets') <> 'array'
       or jsonb_array_length(v_entry->'sets') < 1 then
      raise exception 'Job % has no sets.', v_entry_count;
    end if;
    v_set_count := jsonb_array_length(v_entry->'sets');
    if v_set_count > 50 then
      raise exception 'A job takes at most 50 sets in one delivery.';
    end if;

    v_issue := null;
    if v_project is null then
      insert into issues (project_id, kind, urgency, note, created_by)
      values (
        null, 'missing_job', 'normal',
        'Build the job "' || v_job_name || '" — ' || v_set_count ||
        ' set(s) from the delivery "' ||
        coalesce(nullif(trim(p_label), ''), 'Hand-logged delivery') ||
        '" arrived under that name and are waiting to be filed.',
        auth.uid()
      )
      returning id into v_issue;
    end if;

    for v_set in select * from jsonb_array_elements(v_entry->'sets') loop
      v_n := public.create_delivery_set(
        v_delivery, v_project,
        v_set->>'mark',
        coalesce(v_set->>'kind', 'window'),
        (v_set->>'package_count')::int,
        v_set#>>'{crate,name}',
        (v_set#>>'{crate,pieces}')::int,
        v_set#>>'{crate,part_type}',
        coalesce((v_set->>'quantity')::int, 1),
        v_job_name,
        v_issue
      );
      v_created := v_created + v_n;
      if v_project is null then
        v_unfiled := v_unfiled + v_n;
      end if;
    end loop;

    -- One sealed crate per distinct name this entry mentioned.
    for v_crate_name in
      select distinct upper(trim(s#>>'{crate,name}'))
      from jsonb_array_elements(v_entry->'sets') s
      where nullif(trim(coalesce(s#>>'{crate,name}', '')), '') is not null
    loop
      insert into packages
        (status, project_id, category, part_type, mfr_mark,
         pending_job_name, pending_issue_id,
         delivery_id, short_code, bound_at, bound_by)
      values
        ('minted', v_project, 'other', 'crate', v_crate_name,
         case when v_project is null then v_job_name end,
         case when v_project is null then v_issue end,
         v_delivery, issue_package_short_code(), now(), auth.uid()::text);
      v_created := v_created + 1;
      if v_project is null then
        v_unfiled := v_unfiled + 1;
      end if;
    end loop;
  end loop;

  return jsonb_build_object(
    'delivery_id', v_delivery,
    'created', v_created,
    'unfiled', v_unfiled,
    'pending', 0
  );
end;
$$;

-- file_pending_packages — rebuilt from 20260932000000_crates_are_packages.sql
create or replace function file_pending_packages(
  p_package_ids uuid[],
  p_project uuid
)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row packages;
  v_mark uuid;
  v_id uuid;
  v_issue uuid;
  v_count int := 0;
begin
  -- Warehouse work is crew work (ADR-0007, owner call 2026-09-04). The rank
  -- check that stood here is gone; signed in, and not a builder login, is
  -- the whole door now. Every other line of this function is byte-for-byte
  -- what it was.
  if auth.uid() is null then
    raise exception 'sign in first';
  end if;
  if public.is_partner_user() then
    raise exception 'Only a crew member can do warehouse work.'
      using errcode = '42501';
  end if;
  if not exists (select 1 from projects where id = p_project) then
    raise exception 'That job does not exist.';
  end if;

  foreach v_id in array coalesce(p_package_ids, array[]::uuid[])
  loop
    select * into v_row from packages
    where id = v_id and project_id is null and pending_job_name is not null;
    if not found then
      continue;
    end if;

    v_issue := v_row.pending_issue_id;

    update packages
    set project_id = p_project,
        pending_job_name = null,
        pending_issue_id = null
    where id = v_id;

    if v_row.mfr_mark is not null and coalesce(v_row.part_type, '') <> 'crate' then
      insert into project_marks (project_id, mark_code)
      values (p_project, v_row.mfr_mark)
      on conflict (project_id, mark_code) do nothing;
      select id into v_mark from project_marks
      where project_id = p_project and mark_code = v_row.mfr_mark;
      insert into package_marks (package_id, mark_id)
      values (v_id, v_mark) on conflict do nothing;
    end if;

    insert into movements (package_id, event, project_id, actor, reason)
    values (v_id, 'assigned', p_project, auth.uid()::text,
            'filed onto the job — was waiting as "' || v_row.pending_job_name || '"');
    v_count := v_count + 1;

    if v_issue is not null and not exists (
      select 1 from packages
      where pending_issue_id = v_issue and project_id is null
    ) then
      update issues
         set status = 'resolved', resolved_by = auth.uid(), resolved_at = now()
       where id = v_issue and status = 'open';
    end if;
  end loop;

  return v_count;
end;
$$;

-- add_delivery_set — rebuilt from 20260949900000_fix_add_delivery_set_table.sql
-- The wrapper the app actually calls (storage.ts -> "add_delivery_set").
-- 20260938000000 defined it against a table that never existed; this is
-- the 20260949900000 repair, rebuilt. create_delivery_set, the helper it
-- forwards to, has no rank check of its own and needs no edit.
create or replace function add_delivery_set(
  p_delivery uuid,
  p_project uuid,
  p_job_name text,
  p_mark text,
  p_kind text,
  p_package_count int,
  p_crate_name text default null,
  p_crate_pieces int default null,
  p_crate_part_type text default null
)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- Warehouse work is crew work (ADR-0007, owner call 2026-09-04). The rank
  -- check that stood here is gone; signed in, and not a builder login, is
  -- the whole door now. Every other line of this function is byte-for-byte
  -- what it was.
  if auth.uid() is null then
    raise exception 'sign in first';
  end if;
  if public.is_partner_user() then
    raise exception 'Only a crew member can do warehouse work.'
      using errcode = '42501';
  end if;
  if not exists (select 1 from package_deliveries where id = p_delivery) then
    raise exception 'That delivery does not exist.';
  end if;
  if p_kind not in ('window', 'door') then
    raise exception 'A set is a window or a door.';
  end if;

  return public.create_delivery_set(
    p_delivery, p_project, p_mark, p_kind, p_package_count,
    p_crate_name, p_crate_pieces, p_crate_part_type,
    1, p_job_name, null
  );
end;
$$;

-- update_delivery — rebuilt from 20260934000000_delivery_scheduling.sql
create or replace function update_delivery(
  p_delivery uuid,
  p_label text default null,
  p_expected_at timestamptz default null
)
returns package_deliveries
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_row package_deliveries;
begin
  -- Warehouse work is crew work (ADR-0007, owner call 2026-09-04). The rank
  -- check that stood here is gone; signed in, and not a builder login, is
  -- the whole door now. Every other line of this function is byte-for-byte
  -- what it was.
  if auth.uid() is null then
    raise exception 'sign in first';
  end if;
  if public.is_partner_user() then
    raise exception 'Only a crew member can do warehouse work.'
      using errcode = '42501';
  end if;
  update package_deliveries
  set label = coalesce(nullif(trim(coalesce(p_label, '')), ''), label),
      expected_at = coalesce(p_expected_at, expected_at)
  where id = p_delivery
  returning * into v_row;
  if not found then
    raise exception 'That delivery is gone.';
  end if;
  -- The schedule entry follows the truck's new time.
  if p_expected_at is not null then
    update schedule_assignments
    set start_date = p_expected_at::date,
        end_date = p_expected_at::date,
        start_time = p_expected_at::time
    where delivery_id = p_delivery;
  end if;
  return v_row;
end;
$$;

-- rewrite_set — rebuilt from 20260958000000_rewrite_set.sql
-- Safe to open because of what it already refuses: arrived material never
-- dies by arithmetic here. A shrinking line releases only never-arrived
-- placeholders, and a line that would fall below what has already arrived
-- refuses the WHOLE apply. "Start this set over" — the one path that does
-- delete real material — is not this function; it is delete_packages,
-- which stays foreman+ (see the header).
create or replace function public.rewrite_set(
  p_project_id uuid default null,
  p_pending_job_name text default null,
  p_mark text default null,
  p_lines jsonb default '[]'::jsonb,
  p_kind text default 'window'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_mark text := upper(regexp_replace(trim(coalesce(p_mark, '')), '^#', ''));
  v_pending text := nullif(trim(coalesce(p_pending_job_name, '')), '');
  v_category text := case when p_kind = 'door' then 'doors' else 'windows' end;
  v_existing_category text;
  v_project_mark uuid;
  v_removed_count int;
  v_candidate_count int;
  v_removed_part_type text;
  v_removed_packaging text;
  v_removed_arrived int;
  v_refit_from_type text;
  v_refit_from_packaging text;
  v_refit_to_type text;
  v_refit_to_packaging text;
  v_parts text;
  v_row record;
  v_key_type text;
  v_key_packaging text;
  v_old_arrived int;
  v_old_expected int;
  v_old_arrived_ids uuid[];
  v_old_expected_ids uuid[];
  v_target_count int;
  v_target_expected int;
  v_mint int;
  v_release int;
  v_minted int := 0;
  v_deleted int := 0;
  v_delivery uuid;
begin
  -- Warehouse work is crew work (ADR-0007, owner call 2026-09-04). The rank
  -- check that stood here is gone; signed in, and not a builder login, is
  -- the whole door now. Every other line of this function is byte-for-byte
  -- what it was.
  if auth.uid() is null then
    raise exception 'sign in first';
  end if;
  if public.is_partner_user() then
    raise exception 'Only a crew member can do warehouse work.'
      using errcode = '42501';
  end if;

  if (p_project_id is null) = (v_pending is null) then
    raise exception 'That set does not exist.';
  end if;
  if p_project_id is not null and not exists (select 1 from projects where id = p_project_id) then
    raise exception 'That set does not exist.';
  end if;
  if length(v_mark) < 1 then
    raise exception 'That set does not exist.';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then
    raise exception 'That set does not exist.';
  end if;
  if jsonb_array_length(p_lines) > 12 then
    raise exception 'A set holds at most 12 lines — split it if it needs more.';
  end if;

  -- Register the mark on the job's schedule (create_delivery_set's own
  -- precedent) — a real job's mark may not be on it yet: the whole point of
  -- this screen is fixing material that never matched the manifest.
  if p_project_id is not null then
    insert into project_marks (project_id, mark_code)
    values (p_project_id, v_mark)
    on conflict (project_id, mark_code) do nothing;
    select id into v_project_mark from project_marks
    where project_id = p_project_id and mark_code = v_mark;
  end if;

  -- ---------------------------------------------------- normalize the ask

  drop table if exists _rw_new;
  create temp table _rw_new (
    part_type text not null default '',
    packaging text not null,
    count int not null
  ) on commit drop;

  insert into _rw_new (part_type, packaging, count)
  select coalesce(nullif(trim(lower(x.part_type)), ''), ''), x.packaging, sum(x.count)::int
  from jsonb_to_recordset(p_lines) as x(part_type text, packaging text, count int)
  where x.packaging in ('package', 'crate_pool') and x.count is not null and x.count > 0
  group by 1, 2;

  if exists (select 1 from _rw_new where packaging = 'package' and count > 20) then
    raise exception 'A line of packages holds at most 20.';
  end if;
  if exists (select 1 from _rw_new where packaging = 'crate_pool' and count > 99) then
    raise exception 'A line of pieces in a crate holds at most 99.';
  end if;

  -- ---------------------------------------------------- current reality

  drop table if exists _rw_old;
  create temp table _rw_old (
    part_type text not null default '',
    packaging text not null,
    arrived int not null default 0,
    expected int not null default 0,
    arrived_ids uuid[] not null default array[]::uuid[],
    expected_ids uuid[] not null default array[]::uuid[]
  ) on commit drop;

  insert into _rw_old (part_type, packaging, arrived, expected, arrived_ids, expected_ids)
  with scope as (
    select p.*
    from packages p
    where coalesce(p.part_type, '') <> 'crate'
      and (
        (p_project_id is not null and p.project_id = p_project_id and exists (
          select 1 from package_marks pm
          join project_marks pmk on pmk.id = pm.mark_id
          where pm.package_id = p.id and pmk.mark_code = v_mark
        ))
        or
        (v_pending is not null and p.project_id is null
           and p.pending_job_name = v_pending and p.mfr_mark = v_mark)
      )
  )
  select coalesce(nullif(trim(lower(part_type)), ''), ''),
         'package',
         coalesce(count(*) filter (where status in ('received', 'stored', 'checked_out')), 0)::int,
         coalesce(count(*) filter (where status = 'minted'), 0)::int,
         coalesce(array_agg(id order by part_index nulls last) filter (where status in ('received', 'stored', 'checked_out')), array[]::uuid[]),
         coalesce(array_agg(id order by part_index nulls last) filter (where status = 'minted'), array[]::uuid[])
  from scope where piece_count is null
  group by 1
  union all
  select coalesce(nullif(trim(lower(part_type)), ''), ''),
         'crate_pool',
         coalesce(sum(piece_count) filter (where status in ('received', 'stored', 'checked_out')), 0)::int,
         coalesce(sum(piece_count) filter (where status = 'minted'), 0)::int,
         coalesce(array_agg(id) filter (where status in ('received', 'stored', 'checked_out')), array[]::uuid[]),
         coalesce(array_agg(id) filter (where status = 'minted'), array[]::uuid[])
  from scope where piece_count is not null
  group by 1;

  select category into v_existing_category from packages p
  where coalesce(p.part_type, '') <> 'crate' and p.category is not null
    and (
      (p_project_id is not null and p.project_id = p_project_id and exists (
        select 1 from package_marks pm join project_marks pmk on pmk.id = pm.mark_id
        where pm.package_id = p.id and pmk.mark_code = v_mark
      ))
      or
      (v_pending is not null and p.project_id is null
         and p.pending_job_name = v_pending and p.mfr_mark = v_mark)
    )
  limit 1;
  if v_existing_category is not null then
    v_category := v_existing_category;
  end if;

  -- The tailgate lists a delivery's packages by delivery_id, and the whole
  -- point of this screen is fixing a set WHILE unloading — so replacements
  -- minted here inherit the delivery the set's existing packages rode in on
  -- (latest first when a set somehow spans two trucks). Captured BEFORE the
  -- apply loop deletes anything. Declaring from scratch has no truck to
  -- inherit; those mint delivery-less, same as the ledger's own additions.
  select p.delivery_id into v_delivery from packages p
  where p.delivery_id is not null
    and coalesce(p.part_type, '') <> 'crate'
    and (
      (p_project_id is not null and p.project_id = p_project_id and exists (
        select 1 from package_marks pm join project_marks pmk on pmk.id = pm.mark_id
        where pm.package_id = p.id and pmk.mark_code = v_mark
      ))
      or
      (v_pending is not null and p.project_id is null
         and p.pending_job_name = v_pending and p.mfr_mark = v_mark)
    )
  order by p.bound_at desc nulls last
  limit 1;

  -- --------------------------------------- ambiguity / re-fit resolution
  -- A "removed" line: an old group with arrived material whose (type,
  -- packaging) is absent from the new declaration entirely — the line
  -- vanished, not merely shrank. Re-fit is allowed ONLY when exactly one
  -- such line exists and exactly one brand-new line (same packaging) can
  -- hold its arrived count; anything less clear-cut refuses rather than
  -- guess with real material.

  drop table if exists _rw_removed;
  create temp table _rw_removed on commit drop as
  select o.* from _rw_old o
  left join _rw_new n on n.part_type = o.part_type and n.packaging = o.packaging
  where n.part_type is null and o.arrived > 0;

  drop table if exists _rw_new_only;
  create temp table _rw_new_only on commit drop as
  select n.* from _rw_new n
  left join _rw_old o on o.part_type = n.part_type and o.packaging = n.packaging
  where o.part_type is null;

  select count(*) into v_removed_count from _rw_removed;

  if v_removed_count = 1 then
    select part_type, packaging, arrived into v_removed_part_type, v_removed_packaging, v_removed_arrived
    from _rw_removed;
    select count(*) into v_candidate_count from _rw_new_only
    where packaging = v_removed_packaging and count >= v_removed_arrived;
  else
    v_candidate_count := null;
  end if;

  if v_removed_count = 1 and v_candidate_count = 1 then
    select v_removed_part_type, v_removed_packaging, part_type, packaging
      into v_refit_from_type, v_refit_from_packaging, v_refit_to_type, v_refit_to_packaging
    from _rw_new_only
    where packaging = v_removed_packaging and count >= v_removed_arrived;
  elsif v_removed_count > 0 then
    select string_agg(
      arrived || ' ' || coalesce(nullif(part_type, ''), 'untyped') || ' ' ||
      (case when packaging = 'crate_pool' then 'piece' else 'package' end) ||
      (case when arrived = 1 then '' else 's' end),
      ', ' order by part_type
    ) into v_parts
    from _rw_removed;
    raise exception '%', 'Some arrived material doesn''t clearly fit the new plan: ' || v_parts ||
      '. Retype it one at a time first.';
  end if;

  -- ------------------------------------------------------- apply, per line

  for v_row in
    select part_type, packaging from _rw_old
    union
    select part_type, packaging from _rw_new
  loop
    v_key_type := v_row.part_type;
    v_key_packaging := v_row.packaging;

    select coalesce(arrived, 0), coalesce(expected, 0),
           coalesce(arrived_ids, array[]::uuid[]), coalesce(expected_ids, array[]::uuid[])
      into v_old_arrived, v_old_expected, v_old_arrived_ids, v_old_expected_ids
    from _rw_old where part_type = v_key_type and packaging = v_key_packaging;
    v_old_arrived := coalesce(v_old_arrived, 0);
    v_old_expected := coalesce(v_old_expected, 0);
    v_old_arrived_ids := coalesce(v_old_arrived_ids, array[]::uuid[]);
    v_old_expected_ids := coalesce(v_old_expected_ids, array[]::uuid[]);

    if v_refit_from_type is not null
       and v_key_type = v_refit_from_type and v_key_packaging = v_refit_from_packaging then
      -- This line's arrived material moved on; only its never-arrived
      -- placeholders remain, and those are simply released below.
      v_old_arrived := 0;
      v_old_arrived_ids := array[]::uuid[];
    elsif v_refit_to_type is not null
       and v_key_type = v_refit_to_type and v_key_packaging = v_refit_to_packaging then
      declare
        v_src_arrived int;
        v_src_ids uuid[];
      begin
        select coalesce(arrived, 0), coalesce(arrived_ids, array[]::uuid[])
          into v_src_arrived, v_src_ids
        from _rw_old where part_type = v_refit_from_type and packaging = v_refit_from_packaging;
        v_old_arrived := v_old_arrived + coalesce(v_src_arrived, 0);
        v_old_arrived_ids := v_old_arrived_ids || coalesce(v_src_ids, array[]::uuid[]);
      end;
    end if;

    select count into v_target_count from _rw_new
    where part_type = v_key_type and packaging = v_key_packaging;
    v_target_count := coalesce(v_target_count, 0);

    if v_target_count < v_old_arrived then
      raise exception '%',
        v_old_arrived::text || ' ' || coalesce(nullif(v_key_type, ''), 'untyped') ||
        (case when v_key_packaging = 'crate_pool'
              then ' piece' || (case when v_old_arrived = 1 then '' else 's' end)
              else '' end) ||
        ' already arrived — the new plan only holds ' || v_target_count::text ||
        '. Un-arrive or delete pieces first, so nothing real disappears.';
    end if;

    if v_target_count = 0 and v_old_arrived = 0 and v_old_expected = 0 then
      continue; -- nothing here at all — not a line, before or after
    end if;

    v_target_expected := v_target_count - v_old_arrived;
    v_mint := greatest(0, v_target_expected - v_old_expected);
    v_release := greatest(0, v_old_expected - v_target_expected);

    if v_key_packaging = 'package' then
      declare
        v_release_ids uuid[];
        v_keep_expected_ids uuid[];
        v_new_minted_ids uuid[] := array[]::uuid[];
        v_final_ids uuid[];
        v_idx int;
        v_mint_i int;
        v_id uuid;
        v_len int := coalesce(array_length(v_old_expected_ids, 1), 0);
      begin
        if v_release > 0 then
          v_release_ids := v_old_expected_ids[(v_len - v_release + 1):v_len];
          v_keep_expected_ids := v_old_expected_ids[1:(v_len - v_release)];
        else
          v_release_ids := array[]::uuid[];
          v_keep_expected_ids := v_old_expected_ids;
        end if;

        if coalesce(array_length(v_release_ids, 1), 0) > 0 then
          delete from packages where id = any (v_release_ids);
          v_deleted := v_deleted + array_length(v_release_ids, 1);
        end if;

        if v_mint > 0 then
          for v_mint_i in 1..v_mint loop
            insert into packages
              (status, project_id, category, part_type, pending_job_name,
               short_code, bound_at, bound_by, mfr_mark, delivery_id)
            values
              ('minted', p_project_id, v_category, nullif(v_key_type, ''),
               case when p_project_id is null then v_pending end,
               issue_package_short_code(), now(), auth.uid()::text, v_mark, v_delivery)
            returning id into v_id;
            v_new_minted_ids := v_new_minted_ids || v_id;
            if p_project_id is not null then
              insert into package_marks (package_id, mark_id)
              values (v_id, v_project_mark) on conflict do nothing;
            end if;
            insert into movements (package_id, event, project_id, actor, reason)
            values (v_id, 'preissued', p_project_id, auth.uid()::text,
                    'rewrite: mark #' || v_mark || ' declared to hold ' || v_target_count::text ||
                    ' ' || coalesce(nullif(v_key_type, ''), 'untyped'));
          end loop;
          v_minted := v_minted + v_mint;
        end if;

        v_final_ids := v_old_arrived_ids || v_keep_expected_ids || v_new_minted_ids;
        v_idx := 0;
        foreach v_id in array v_final_ids loop
          v_idx := v_idx + 1;
          update packages
          set part_index = v_idx, part_total = v_target_count, part_type = nullif(v_key_type, '')
          where id = v_id;
        end loop;
      end;
    else -- crate_pool
      declare
        v_id uuid;
      begin
        if coalesce(array_length(v_old_expected_ids, 1), 0) > 0 then
          delete from packages where id = any (v_old_expected_ids);
          v_deleted := v_deleted + array_length(v_old_expected_ids, 1);
        end if;

        if v_target_expected > 0 then
          insert into packages
            (status, project_id, category, part_type, piece_count, mfr_mark,
             pending_job_name, short_code, bound_at, bound_by, delivery_id)
          values
            ('minted', p_project_id, v_category, nullif(v_key_type, ''), v_target_expected, v_mark,
             case when p_project_id is null then v_pending end,
             issue_package_short_code(), now(), auth.uid()::text, v_delivery)
          returning id into v_id;
          if p_project_id is not null then
            insert into package_marks (package_id, mark_id)
            values (v_id, v_project_mark) on conflict do nothing;
          end if;
          insert into movements (package_id, event, project_id, actor, reason)
          values (v_id, 'preissued', p_project_id, auth.uid()::text,
                  'rewrite: mark #' || v_mark || ' declared to hold ' || v_target_expected::text ||
                  ' piece(s) of ' || coalesce(nullif(v_key_type, ''), 'untyped') || ' in the crates');
          v_minted := v_minted + 1;
        end if;

        if coalesce(array_length(v_old_arrived_ids, 1), 0) > 0 then
          update packages set part_type = nullif(v_key_type, '')
          where id = any (v_old_arrived_ids);
        end if;
      end;
    end if;
  end loop;

  return jsonb_build_object('minted', v_minted, 'deleted', v_deleted);
end;
$$;

-- ==========================================================================
-- Reads: a takeoff is the crew's, not a rank's
-- ==========================================================================
-- The bundle the warehouse builds is FOR somebody, and until now only
-- foreman+ (or the person named on it, or whoever made it) could see one at
-- all. With every crew member able to file a takeoff and answer one, the read
-- policy that hid other people's takeoffs is hiding the shared warehouse
-- inbox from the people now working it. So the rank/ownership filter goes and
-- the wall stays: any signed-in crew member reads takeoffs; a builder login
-- reads none, exactly as before. Rebuilt from their CURRENT definitions —
-- the partner-wall sweep's (20260950000000), not the originals.

drop policy if exists "takeoff_items_read" on takeoff_items;
create policy "takeoff_items_read" on takeoff_items
  for select to authenticated
  using (not public.is_partner_user());

drop policy if exists "takeoffs_read" on takeoffs;
create policy "takeoffs_read" on takeoffs
  for select to authenticated
  using (not public.is_partner_user());


-- ==========================================================================
-- Grants
-- ==========================================================================
-- `create or replace function` keeps a function's existing grants, so these
-- change nothing today. They are re-stated for the three functions whose own
-- migrations state them, so this file stands on its own if it is ever the
-- first place somebody looks.

grant execute on function add_delivery_set(uuid, uuid, text, text, text, int, text, int, text) to authenticated;
grant execute on function update_delivery(uuid, text, timestamptz) to authenticated;
grant execute on function public.rewrite_set(uuid, text, text, jsonb, text) to authenticated;

-- ===========================================================================
-- 20260987000000_remove_login_start_fresh.sql (mirrored)
-- Remove a login and start fresh, plus access-request hygiene
-- (owner's decision, 2026-09-04: "the ability to delete user accounts and
-- start fresh").
--
-- Two unrelated-looking halves ship together because they are the same
-- complaint: an account that came in wrong stays wrong forever. One half is
-- the login; the other is the request that asked for it.
--
--   1. profiles.retired_at / retired_by — the roster's word for a login that
--      was removed for good rather than merely switched off.
--   2. access_requests.decision_note, and RLS that finally matches who is
--      allowed to decide anything.
--   3. decide_access_request() — the one client-side writer of a decision,
--      supervisor+, which can deny, note a reason, and re-open a denial, and
--      can NEVER write 'approved'.
--
-- MERGE ORDER: this is 20260987000000 and it lands AFTER 20260985000000 and
-- 20260986000000, both in flight. It shares no object with either; the order
-- matters only because migration numbers land in sequence, one deploy at a
-- time.
--
-- IDEMPOTENT throughout (add column if not exists / create or replace / drop
-- policy if exists before create), so re-running it changes nothing.


-- ---------------------------------------------------------------------------
-- 1. profiles.retired_at / retired_by — "Removed", not "switched off"
-- ---------------------------------------------------------------------------
-- THREE COLUMNS NOW SAY THREE DIFFERENT THINGS ABOUT ONE PERSON, and they are
-- easy to confuse, so:
--
--   active            — "on site today". A foreman toggles it every morning.
--                       Availability, never permission.
--   access_revoked_at — "their login is switched off". Reversible; the auth
--                       user is banned and "Let them back in" un-bans them.
--   retired_at        — "this login was removed for good". The auth user is
--                       banned AND its email has been handed back (renamed to
--                       a tombstone by manage-crew-access), so there is nothing
--                       to switch back on: the address they used to sign in
--                       with belongs to nobody now, and the way back is a fresh
--                       invite. That is the whole point — an email that stays
--                       taken forever is what made "start fresh" impossible.
--
-- WHY A FLAG AND NOT A DELETE. `profiles.id` references `auth.users(id) ON
-- DELETE CASCADE` (20260715240000), so deleting the account deletes the
-- profile, and from there the person's record goes three ways at once:
-- CASCADE takes time_shifts, receipts, pay_rates, certifications,
-- toolbox_completions, points_ledger, task_sessions and project_messages with
-- it; SET NULL leaves install_events.installer_id pointing at nobody, so the
-- window stays installed and nobody installed it; and eight columns with no ON
-- DELETE clause at all (unit_sessions.profile_id, unit_redos.pressed_by,
-- daily_logs.filed_by, summons.requested_by, opening_phases.started_by and
-- .submitted_by, time_shift_edits.edited_by, flash_run_assignments.assigned_by)
-- make the delete FAIL outright. So a person with anything on file is retired,
-- never deleted, and the hard delete is reserved for a login with genuinely
-- nothing behind it — which the edge function establishes by counting, not by
-- asking. See supabase/functions/_shared/purgeLogin.ts.
--
-- The display name is deliberately NOT changed. Every screen that reads back
-- who did something joins to this row, and renaming it to "Removed" would
-- rewrite years of finished work into anonymity. The roster says "Removed"
-- beside the name it always had.

alter table public.profiles
  add column if not exists retired_at timestamptz,
  add column if not exists retired_by uuid references public.profiles(id) on delete set null;

comment on column public.profiles.retired_at is
  'When this login was removed for good (banned AND its email handed back to a tombstone by manage-crew-access purge_login). Distinct from access_revoked_at, which is reversible, and from active, which means "on site today". NULL = not retired. Never set from a client.';
comment on column public.profiles.retired_by is
  'The owner who removed the login. NULL for a removal done by the service role directly.';

create index if not exists profiles_retired_idx
  on public.profiles (retired_at)
  where retired_at is not null;

-- The profiles lockdown (20260729200000) replaced the table-level grants with
-- explicit column lists, so a new column is unreachable until it is named.
-- Read-only for clients: both are written by the edge function on the
-- service-role key, exactly like access_revoked_at.
grant select (retired_at, retired_by) on table public.profiles to authenticated;
revoke insert (retired_at, retired_by), update (retired_at, retired_by)
  on table public.profiles from anon, authenticated;

-- The Crew access screen reads this view rather than the table. security_invoker
-- keeps the CALLER's row-level security in force, so widening it cannot become
-- a way around the policies on profiles.
drop view if exists public.crew_access_directory;
create view public.crew_access_directory
  with (security_invoker = true)
  as select id, display_name, role, skill_level, active, access_revoked_at,
            retired_at, retired_by, created_at
     from public.profiles;

comment on view public.crew_access_directory is
  'Who has access: the crew directory plus access_revoked_at and retired_at/retired_by. security_invoker, so the caller''s RLS on profiles still applies.';

revoke all on public.crew_access_directory from public, anon, authenticated;
grant select on public.crew_access_directory to authenticated;


-- ---------------------------------------------------------------------------
-- 1b. person_record_counts — the count that decides which shape happens
-- ---------------------------------------------------------------------------
-- One row per table this person appears in, as one jsonb object, keyed
-- `table.column`. The keys here are the contract: they are the exact strings
-- WORK_HISTORY_PROBES uses in app/src/lib/purgeWords.ts, and
-- app/src/lib/purgeWords.test.ts reads THIS FILE and fails if the two lists
-- ever stop agreeing. The rule lives twice on purpose — SQL owns the counting,
-- TypeScript owns the words and the order they are said in — and the two copies
-- are pinned together rather than trusted to stay in step.
--
-- WHAT HAS TO BE IN HERE, and why the first cut of this list was dangerous.
-- The RESTRICT columns are the loud ones: a hard delete against a person who
-- appears in any of them FAILS, so missing one is a 500 on a phone and nothing
-- worse. The CASCADE columns are the quiet ones, and they are the reason this
-- list is now derived from the schema rather than written from memory: a
-- CASCADE column that is NOT counted here makes the person look empty, the
-- delete SUCCEEDS, and their rows go with it without a word. The first cut
-- counted nine of the twenty-seven CASCADE columns and missed, among others,
-- `safety_acks` (a signed safety talk, a DIFFERENT table from
-- toolbox_completions), `timecard_periods` (the row carrying the employee's
-- and the supervisor's signatures on a pay period), `overtime_rules` (a
-- person's own overtime deal) and `capability_badges` (what a foreman signed
-- them off to touch). Every one of those is exactly the record this feature
-- promises to keep.
--
-- purgeWords.test.ts now parses every `references profiles(id)` in
-- supabase/migrations and fails unless each CASCADE and RESTRICT column is
-- either counted below or on a short, commented allow-list of ephemera (push
-- subscriptions, notification dismissals, chat read receipts, and the two
-- partner-only tables — a builder login is refused by this door outright).
--
-- WHY THIS IS A DATABASE FUNCTION AND NOT NINETEEN READS FROM THE EDGE
-- FUNCTION. Two reasons, and the second is the binding one:
--
--   1. Nineteen round trips to decide one button is nineteen round trips.
--   2. Wave Z's standing guarantee is that NO edge function ever names
--      `pay_rates` — they hold the service-role key, which bypasses RLS
--      entirely, so a single `.from("pay_rates")` in one of them would put
--      every wage in the company one edit away from a model's context.
--      app/src/lib/payRates.test.ts enforces that by scanning the function
--      source. Counting a person's rows is not reading a wage, but the scan
--      cannot tell the difference and should not have to: the table names stay
--      in SQL, where that guarantee is not at stake.
--
-- SECURITY DEFINER so the counts are complete — daily_logs is foreman+ and
-- pay_rates is grant-gated, and a count that RLS quietly shortened would make a
-- person look emptier than they are, which is the one error that loses records.
-- Granted to service_role ONLY: the sole caller is manage-crew-access, which
-- does its own owner-rank check first, and nothing in a browser has any reason
-- to ask how many receipts somebody has.
create or replace function public.person_record_counts(p_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
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

comment on function public.person_record_counts(uuid) is
  'How many rows of work, money and safety record one person has, keyed table.column. The input to "remove this login": nothing anywhere means the account can be deleted outright, anything at all means it is retired and every row kept. Service role only — manage-crew-access checks the caller is the owner before it asks.';

revoke all on function public.person_record_counts(uuid) from public, anon, authenticated;
grant execute on function public.person_record_counts(uuid) to service_role;


-- ---------------------------------------------------------------------------
-- 1c. Nobody removed ever hears a push again
-- ---------------------------------------------------------------------------
-- Both nightly audiences already exclude a removed person by accident:
-- pipeline_nudge_audience filters on `pr.active` and credential_nudge_audience
-- on `pr.access_revoked_at is null`, and purge_login sets both. "By accident"
-- is the problem. `active` means "on site today" and a foreman toggles it every
-- morning from the Roster — one tap on the wrong row would put a removed login
-- back on the 7 AM push list, addressed to a phone whose owner left. So each
-- one says it outright, beside the filter it already had.
--
-- Restated in full (create or replace) rather than patched, so the whole
-- predicate is readable in one place; the only change to either is the new
-- `retired_at is null` line.
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
     and pr.retired_at is null
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
                -- Published, not drafted — a foreman pencilled into a plan
                -- nobody has published must not be pushed about it.
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
  'Who hears a pipeline warning about one job: every active supervisor+, plus every foreman on a PUBLISHED assignment for it within the next fortnight or clocked into it right now. A draft assignment does not count — the crew has not been shown it. Partner logins never, and removed logins never (retired_at).';

create or replace function public.credential_nudge_audience(p_profile_id uuid)
returns uuid[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(array_agg(distinct pr.id), '{}'::uuid[])
    from profiles pr
   where pr.access_revoked_at is null
     and pr.retired_at is null
     and not coalesce(pr.is_partner, false)
     and (pr.id = p_profile_id or public._is_supervisor(pr.id));
$$;

comment on function public.credential_nudge_audience(uuid) is
  'Who hears that a card is running out: the person it belongs to, plus every supervisor and owner whose login is still switched on. Deliberately NOT filtered on profiles.active, which means "on site today" — the warning is claimed once per expiry date, so a supervisor who happened to be off that one morning would never hear about that card again. Partner logins never (Wave O, O4); removed logins never (retired_at).';

-- And the third audience, which is the one that matters most: this is the only
-- function in the database that hands a raw email ADDRESS to a browser.
-- foreman_contacts_for_me (20260984000000) fills the To: line of the "Send a
-- recording" mailto:, and it filtered on `p.active` alone — the flag a foreman
-- toggles every morning from the Roster. One tap on the wrong row and a removed
-- login's address goes into a mail composer, and after a removal that address
-- is the tombstone `<uid>@removed.invalid`, which is not a mailbox at all.
-- Restated in full so the whole predicate is readable in one place; the only
-- change to either branch is the new `p.retired_at is null` line.
create or replace function public.foreman_contacts_for_me()
returns table (contact_name text, contact_email text)
language plpgsql
stable
security definer
set search_path = public, auth, pg_temp
as $fn$
declare
  v_uid uuid := auth.uid();
  v_project uuid;
begin
  if v_uid is null then
    raise exception 'Sign in first.';
  end if;
  if public.is_partner_user() then
    raise exception 'This is the crew address book, and a builder login is not crew.';
  end if;

  -- The job the caller is standing on, if any. Newest open shift wins, the
  -- same way getOpenShift() picks one on the phone.
  select ts.project_id into v_project
    from time_shifts ts
   where ts.profile_id = v_uid
     and ts.status = 'open'
     and ts.clock_out_at is null
   order by ts.clock_in_at desc
   limit 1;

  if v_project is not null then
    return query
      select p.display_name, u.email::text
        from profiles p
        join auth.users u on u.id = p.id
       where p.active
         and p.retired_at is null
         and not coalesce(p.is_partner, false)
         and public._is_lead(p.id)
         and p.id <> v_uid
         and u.email is not null
         and (
           exists (
             select 1
               from schedule_assignments sa
               join schedule_assignment_members sam on sam.assignment_id = sa.id
              where sa.project_id = v_project
                and sam.profile_id = p.id
                -- Published, not drafted — see pipeline_nudge_audience's own
                -- note on why a pencilled-in plan must not count.
                and sa.status in ('published', 'in_progress', 'done')
                and sa.end_date >= (now() at time zone 'America/Denver')::date
                and sa.start_date <= (now() at time zone 'America/Denver')::date
           )
           or exists (
             select 1
               from time_shifts ts2
              where ts2.project_id = v_project
                and ts2.profile_id = p.id
                and ts2.status = 'open'
                and ts2.clock_out_at is null
           )
         )
       order by p.display_name;
    -- RETURN QUERY sets FOUND. Somebody answered, so stop here rather than
    -- adding every other lead in the company to the To: line.
    if found then
      return;
    end if;
  end if;

  return query
    select p.display_name, u.email::text
      from profiles p
      join auth.users u on u.id = p.id
     where p.active
       and p.retired_at is null
       and not coalesce(p.is_partner, false)
       and public._is_lead(p.id)
       and p.id <> v_uid
       and u.email is not null
     order by p.display_name;
end;
$fn$;

comment on function public.foreman_contacts_for_me() is
  'The name and email of every foreman-and-up on the job the caller is clocked into, else every active one in the company. A MINIMAL PROJECTION — two columns, nothing else about anybody — because emails live in auth.users where no client role may read them. Refuses partner logins, and never answers with a removed login: its address is a tombstone by then.';

revoke all on function public.foreman_contacts_for_me() from public, anon;
grant execute on function public.foreman_contacts_for_me() to authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 2. access_requests: a reason, and RLS that means something
-- ---------------------------------------------------------------------------
-- WHAT WAS WRONG. Since 20260717000000 this table has carried exactly one
-- policy for signed-in users:
--
--     "authenticated full access"  FOR ALL  USING (true)  WITH CHECK (true)
--
-- (wrapped in the partner guard by THE WALL, 20260950000000, and otherwise
-- untouched). So ANY signed-in user — an installer, anybody's first-day
-- account — could approve their own access request, deny somebody else's, or
-- delete the queue. Nothing in the app offers those taps, but a greyed-out
-- button is not a control; the row was writable by anyone who could open a
-- console. The Admin screen's own gate is supervisor+, and this makes the
-- database agree with it.
--
-- The four policies below replace that one. INSERT stays exactly as permissive
-- as it was — the public request form must keep working, and the separate
-- `anon can request` INSERT policy from 20260717000000 is left alone; an
-- anonymous visitor has no rank to check. SELECT, UPDATE and DELETE all become
-- supervisor+.
--
-- WHY SELECT NARROWED TOO, which the first cut of this migration left wide.
-- This queue now carries `decision_note`: free text a supervisor types about a
-- person the crew knows, under a sheet that tells him "only people who can see
-- this screen ever read it". The screen is gated at supervisor+ in the client
-- and nowhere else, so with a wide SELECT that sentence was not true — any
-- installer with a browser console could read the whole queue and the reason
-- each person was turned down. Nothing in the app reads this table below
-- supervisor: Admin.tsx and Notifications.tsx are the only two readers and both
-- are already gated there, and submitAccessRequest is an INSERT with no
-- read-back (scripts/prove-onboarding.py asserts exactly that shape, and reads
-- the queue back on the service role).

alter table public.access_requests
  add column if not exists decision_note text;

comment on column public.access_requests.decision_note is
  'Why this request was decided the way it was, in the decider''s own words. Optional. Written only by decide_access_request (client side) or the approve-access-request edge function (service role).';

-- Every policy carries the partner guard, the same way THE WALL's sweep left
-- it: a builder's login is not crew and never reads or writes this queue.
drop policy if exists "authenticated full access" on public.access_requests;

drop policy if exists "access_requests_select" on public.access_requests;
create policy "access_requests_select" on public.access_requests
  for select to authenticated
  using (not public.is_partner_user() and public.my_role_rank() >= 2);

-- INSERT stays open to any signed-in user: somebody already inside the app
-- asking for a different role is the same request as somebody outside asking
-- for one, and the `anon can request` policy already allows the anonymous case.
drop policy if exists "access_requests_insert" on public.access_requests;
create policy "access_requests_insert" on public.access_requests
  for insert to authenticated
  with check (not public.is_partner_user() and (true));

-- The WITH CHECK names the statuses a client may leave behind, and 'approved'
-- is not one of them. Rank alone is not enough here: 'approved' MEANS "an
-- account now exists", and a supervisor PATCHing this row to 'approved'
-- straight at PostgREST would reproduce the exact failure the RPC below was
-- written to prevent — a row that says approved beside a person who cannot
-- sign in. Two independent controls now say it: this clause, and
-- decide_access_request's own refusal. The approve-access-request edge function
-- writes on the service role, which is not subject to this policy at all, so
-- the one legitimate writer of 'approved' is unaffected.
drop policy if exists "access_requests_update_supervisor" on public.access_requests;
create policy "access_requests_update_supervisor" on public.access_requests
  for update to authenticated
  using (not public.is_partner_user() and public.my_role_rank() >= 2)
  with check (
    not public.is_partner_user()
    and public.my_role_rank() >= 2
    and status in ('denied', 'pending')
  );

drop policy if exists "access_requests_delete_supervisor" on public.access_requests;
create policy "access_requests_delete_supervisor" on public.access_requests
  for delete to authenticated
  using (not public.is_partner_user() and public.my_role_rank() >= 2);


-- ---------------------------------------------------------------------------
-- 3. decide_access_request — the only decision a client may write
-- ---------------------------------------------------------------------------
-- WHY AN RPC WHEN THE UPDATE POLICY ALREADY SAYS SUPERVISOR+. Because one
-- status is not the client's to write at all. 'approved' MEANS "an account now
-- exists": the approve-access-request edge function creates the auth user, the
-- profile and the one-time password, and only then marks the row. A client that
-- could write 'approved' itself would put the queue back in the state the owner
-- reported last time — "when I admin approve his login it still won't work" —
-- a row that says approved beside a person who cannot sign in. So this function
-- refuses that word outright, and the edge function stays the only writer of it.
--
-- 'denied' → 'pending' is deliberately allowed. Denying is one tap and a
-- mis-tap is the ordinary human error here; Re-open puts the request back in
-- the queue with the note that explains why, rather than making somebody ask
-- for access all over again to undo a slip.
--
-- SECURITY DEFINER, so the rank check is this function's rather than the
-- caller's policy — and so `decided_by` is written from auth.uid() and can
-- never be somebody else's id.
create or replace function public.decide_access_request(
  p_id uuid,
  p_status text,
  p_note text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_note text;
begin
  if public.my_role_rank() < 2 then
    raise exception 'only a supervisor or the owner can decide an access request'
      using errcode = '42501';
  end if;

  if p_status not in ('denied', 'pending') then
    raise exception
      'decide_access_request writes denied or pending only; approving creates an account and is the approve-access-request function''s job'
      using errcode = '22023';
  end if;

  v_note := nullif(btrim(coalesce(p_note, '')), '');

  update access_requests
     set status = p_status,
         decided_by = case when p_status = 'pending' then null else auth.uid() end,
         decided_at = case when p_status = 'pending' then null else now() end,
         -- Re-opening clears the old reason with the old decision: a note
         -- saying "no vacancies" sitting on a pending request would read as
         -- this decision rather than the one that was undone.
         decision_note = case when p_status = 'pending' then null else v_note end
   where id = p_id;

  if not found then
    raise exception 'no such access request' using errcode = 'P0002';
  end if;
end;
$$;

comment on function public.decide_access_request(uuid, text, text) is
  'Deny an access request with an optional reason, or re-open a denied one. Supervisor+. Never writes ''approved'' — approving creates a login and belongs to the approve-access-request edge function.';

revoke all on function public.decide_access_request(uuid, text, text)
  from public, anon;
grant execute on function public.decide_access_request(uuid, text, text)
  to authenticated, service_role;

-- ===========================================================================
-- 20260988000000_monday_files.sql (mirrored)
-- Monday files (owner's decision, 2026-09-04): "when we build a job from a
-- Monday row, the PDFs on that row should come with it."
--
-- The office has always kept a job's paperwork on the Monday item — the
-- building plans, the signed CAD sheets, the quote, the marked-up survey — and
-- the app has never seen any of it. Somebody downloaded each file from Monday
-- and uploaded it again on the Plans page, by hand, every time. This migration
-- is the storage half of stopping that.
--
-- The naming convention is the office's own, not ours: a file called "LP" is
-- the building PLANS ("LP" = the plan set), a file called "CU" is the SPECS
-- (the CAD/cut sheets), and everything else is a job document worth keeping
-- but not worth extracting. The guess is made in the app
-- (`guessMondayFileKind`), shown to the office before anything is pulled, and
-- always overridable — because a convention that holds on most rows is a
-- convention that will be wrong on one, and being wrong quietly is what turns
-- a spec sheet into a building plan the map then draws from.
--
-- IN THE ORDER THEY DEPEND ON EACH OTHER:
--
--   1. monday_jobs.files    — what Monday says is attached to the row. A LIST,
--                             never the bytes and never a URL. Readable by the
--                             office, writable by nobody but the sync.
--   2. project_plansets
--        .source_asset_id   — which Monday file a planset came from, so the
--                             same file is never pulled twice.
--   3. project_documents    — the home a job document has never had, plus the
--      + job-documents        private bucket its bytes live in, plus the
--                             `money` flag that keeps a signed quote off the
--                             crew's phones (section 3b).
--   4. attach_sandbox_guards() — project_documents is project-scoped, so the
--                             test-login fence has to be re-armed over it.
--   5. the plansets bucket  — the other half of what the pull writes, and it
--                             has been open to every signed-in login, partner
--                             logins included, since 20260715120000
--                             (section 7).
--
-- IDEMPOTENT throughout (if not exists / do update / drop policy if exists
-- before create), so re-running it changes nothing.
--
-- NO NEW SECRET AND NO NEW EDGE FUNCTION: the pull is an action on the
-- existing monday-sync function, which already holds MONDAY_API_TOKEN. The
-- Monday board belongs to STG Windows and this app is a GUEST on it — every
-- call the function makes is a read, and a test in the app pins that.


-- ---------------------------------------------------------------------------
-- 1. F1 — what Monday says is attached to the row
-- ---------------------------------------------------------------------------
-- One JSON array per staged row:
--   [{ "asset_id": "3100578592", "name": "HC24 - LP.pdf", "ext": ".pdf",
--      "size": 17904294, "column_id": "files_1",
--      "uploaded_at": "2026-07-09T19:10:07Z" }]
--
-- WHY NO public_url. Monday hands out a `public_url` for an asset that is valid
-- for ONE HOUR. Storing it would mean a list that looks fine and 404s an hour
-- after the sync — and it would put a live, unauthenticated link to another
-- company's document in a table that a foreman can read. The asset id is
-- durable; the URL is asked for again, server-side, at the moment of the pull.
--
-- WHY A COLUMN AND NOT A TABLE. This is a mirror of somebody else's board,
-- rewritten whole on every sync, with no history worth keeping and nothing that
-- points at it. `raw` beside it is the same idea and has held for a year.
alter table monday_jobs
  add column if not exists files jsonb not null default '[]'::jsonb;

comment on column monday_jobs.files is
  'Files Monday says are attached to this item: [{asset_id, name, ext, size, column_id, uploaded_at}]. Rewritten by every sync. Never a public_url — Monday''s expires in an hour and is fetched fresh at pull time (Monday files, F1).';

-- IT IS A MIRROR, AND NOBODY BUT THE SYNC MAY WRITE IT.
--
-- monday_jobs has carried a whole-row "lead update" policy since the connector
-- shipped (20260812000000), and this project's default privileges hand every
-- new table in `public` the full set to `authenticated` — so before this line
-- any foreman could rewrite any column of any staged row from the browser. That
-- was harmless while the row was only ever read back onto a screen. It stops
-- being harmless the moment a column of it names a file this server will go and
-- download: a list of asset ids the caller can write is not an allow-list.
--
-- The pull does not trust this column any more either (it asks Monday again,
-- and refuses an item that is not on the Ops Gantt Chart) — this is the second
-- lock, and the one that keeps `raw`, `monday_item_id` and the synced dates
-- honest as well. The office still needs the only two columns it actually
-- writes: `project_id` when it builds a job from a row, `dismissed_at` when it
-- says "not this one".
--
-- Column-level GRANTs, not a policy: RLS decides which ROWS, grants decide
-- which COLUMNS, and only the second one can say "this row, but not this field".
revoke update on monday_jobs from anon, authenticated;
grant update (project_id, dismissed_at) on monday_jobs to authenticated;


-- ---------------------------------------------------------------------------
-- 2. F4 — which Monday file a planset came from
-- ---------------------------------------------------------------------------
-- Null for every planset somebody uploaded by hand, which is all of them today.
-- Set by the pull, and it is what makes the pull IDEMPOTENT: press Pull twice
-- on the same file and the second press is answered "already on the job"
-- instead of putting a second copy of the plans on the map. It is also half of
-- the "new on Monday" diff — a file is new exactly when no planset and no
-- document on this job carries its asset id.
alter table project_plansets
  add column if not exists source_asset_id text;

comment on column project_plansets.source_asset_id is
  'The Monday asset this planset was pulled from, or null when somebody uploaded it by hand. Unique per job, so pulling the same file twice is a no-op (Monday files, F4).';

-- PARTIAL, so the hundreds of hand-uploaded plansets carrying null are not
-- competing for one slot. Postgres ignores nulls in a unique index anyway; the
-- WHERE clause says the intent out loud and keeps the index small.
create unique index if not exists project_plansets_monday_asset_idx
  on project_plansets (project_id, source_asset_id)
  where source_asset_id is not null;


-- ---------------------------------------------------------------------------
-- 3. F6 — project_documents: the home a job document never had
-- ---------------------------------------------------------------------------
-- A job's paperwork is not all plans. "HC24 - Iron C.pdf" is the ironwork
-- order, "Estates at Sand Hollow 20 - FINAL - Iron - signed.pdf" is a signed
-- quote, and neither is something to run an extraction over — but both are
-- things a foreman standing on the site wants to be able to open. Until now the
-- app had exactly two slots, building plan and specs, and anything else either
-- got forced into one of them (where the extractor then tried to read it) or
-- stayed on Monday where the crew cannot reach it.
--
-- WRITTEN BY THE SERVER ONLY, in this version. Every row here today arrives
-- through the pull, which runs on the service role inside monday-sync: it is
-- the only thing that can prove a file really is attached to the Monday item it
-- claims to be. A crew-facing "attach a document" button is a fair next step
-- and it will need its own RPC and its own rules; leaving the client with no
-- INSERT grant at all is what stops that arriving by accident in the meantime.
create table if not exists project_documents (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  -- The file's own name, as the office typed it on Monday. Kept separately from
  -- storage_path because the path is sanitised (see below) and a crew member
  -- should read the name the office knows the file by.
  name text not null,
  -- "<project_id>/<timestamp>-<safe name>" inside the job-documents bucket. A
  -- path, never a URL: the bucket is private and every open is a short-lived
  -- signed URL.
  storage_path text not null,
  size_bytes bigint,
  content_type text,
  source text not null default 'monday' check (source in ('monday', 'upload')),
  -- The Monday asset this came from; null for anything not pulled from Monday.
  source_asset_id text,
  -- OUR NUMBER IS ON THIS ONE. See section 3b below for why it exists.
  money boolean not null default false,
  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

-- Separately as well as in the CREATE above, so a database that already took an
-- earlier run of this migration gains the column rather than silently keeping a
-- table with no money flag and a policy that reads one.
alter table project_documents
  add column if not exists money boolean not null default false;

comment on table project_documents is
  'A job document that is not a planset — the quote, the signed order, the survey. Pulled from the job''s Monday item by monday-sync; the client holds no write grant (Monday files, F6).';

comment on column project_documents.money is
  'This document has the company''s own number on it — a quote, a bid, a signed order. Only somebody with can_see_costs may read it or its bytes, which is the money wall (CONTEXT.md, wave Z) applied to paperwork (Monday files, F6).';


-- ---------------------------------------------------------------------------
-- 3b. F6 — the ones with our number on them
-- ---------------------------------------------------------------------------
-- THE MONEY WALL APPLIES TO PAPERWORK TOO. Wave Z (20260978000000) moved money
-- off the rank ladder and onto an explicit grant for one stated reason: before
-- it, "the lock was the nav floor, which is not a lock: it is a hidden button,
-- and every crew phone could read the company's bids". A job's Monday item
-- carries "Estates at Sand Hollow 20 - FINAL - Iron - signed.pdf" — a signed
-- quote, with our price on it — in the same column as the ironwork order every
-- foreman on that site needs. Filing both under "whoever can see the job" would
-- hand the company's bids to every crew phone through a different door than the
-- one wave Z just shut, six days later.
--
-- So documents are sorted, once, by the pull that creates them
-- (`looksLikeMoneyDocument` in _shared/mondayFiles.ts, unit-tested), and the
-- flag is read by both policies below. The sort is allowed to be WRONG IN ONE
-- DIRECTION ONLY: a word that might mean money makes a document office-only.
-- Being wrong that way costs a foreman a phone call; being wrong the other way
-- is the thing wave Z existed to stop.
--
-- WHY A COLUMN AND NOT A SEPARATE TABLE. CONTEXT.md's rule is that "anything
-- genuinely ours — a price, a margin, a cost — goes in a table of its own with
-- its own policy". That rule is about FIELDS: a bid amount sitting in a column
-- of `projects` is readable by anyone who reads the row. Here the sensitive
-- thing is the whole document, row and bytes together, and a second table would
-- be the same columns twice with the same pull writing both — two things to
-- keep in step for no extra wall. One flag, read by one predicate, in both the
-- table policy and the storage policy.

-- Every read is "this job's documents, newest first".
create index if not exists project_documents_project_idx
  on project_documents (project_id, created_at desc);

-- Same reasoning as the planset index above: pulling one Monday file twice is a
-- no-op, not a second row.
create unique index if not exists project_documents_monday_asset_idx
  on project_documents (project_id, source_asset_id)
  where source_asset_id is not null;

alter table project_documents enable row level security;

-- Revoke BEFORE granting. This project's default privileges hand every new
-- table in `public` the full set to `authenticated`, and RLS is not the wall on
-- its own: without this, a permissive policy added later by anybody would turn
-- a table with no write policy into a write hole.
revoke all on project_documents from anon, authenticated;
grant select on project_documents to authenticated;
grant all on project_documents to service_role;

-- WHO READS WHAT.
--   * Any crew member, on a job they can already see — for a document with no
--     price on it. The document list is the same fact as the Plans list —
--     paperwork for a job somebody is working — and `projects`' own policy is
--     what decides which jobs those are. Asking it here rather than restating
--     its rules means a job in the trash, or a job a test login is fenced out
--     of, disappears from this list for free.
--   * A money document (`money = true`), only somebody with can_see_costs. See
--     section 3b: the quote and the signed order are the company's own numbers,
--     and wave Z settled that those answer to a grant and not to a rank.
--   * A partner (builder) login, never. THE WALL's mechanical guard, which
--     every crew table has carried since 20260950000000 and which
--     scripts/test_partner_wall.py checks dynamically. Worth saying plainly for
--     this table in particular: these are OUR documents about a builder's job —
--     the quote, the signed order — and handing them to the builder's own login
--     is exactly the accident the wall exists to prevent.
drop policy if exists "project_documents_select" on project_documents;
create policy "project_documents_select" on project_documents
  for select to authenticated
  using (
    not public.is_partner_user()
    and (not money or public.can_see_costs(auth.uid()))
    and exists (
      select 1 from public.projects p where p.id = project_documents.project_id
    )
  );


-- ---------------------------------------------------------------------------
-- 4. F6 — the private bucket the bytes live in
-- ---------------------------------------------------------------------------
-- Not `plansets`, on purpose: the map, the Studio and the trace tools all treat
-- everything in that bucket as a drawing they might render, and a signed quote
-- is not one. A separate bucket also means the 80 MB cap below is stated for
-- documents without loosening or tightening plansets, where a 17 MB plan set is
-- ordinary.
--
-- SIZE CAP: 80 MB, the same number the pull refuses above, so a file too big to
-- pull is also a file the bucket would refuse — one limit, said twice, rather
-- than two limits that can drift apart.
--
-- `do update` rather than `do nothing`: re-running this migration against a
-- bucket somebody widened by hand puts the cap back, which is the point of an
-- idempotent migration. No allowed_mime_types list, deliberately — a job
-- document is whatever the office attached, and refusing a .heic photograph of
-- a signed page at the bucket would be refusing the office's own paperwork.
insert into storage.buckets (id, name, public, file_size_limit)
values ('job-documents', 'job-documents', false, 83886080)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit;

-- THE PATH IS THE PERMISSION, the same shape the credential-docs bucket uses:
-- every object is "<project_id>/<timestamp>-<safe name>", so the first folder
-- name IS the job, and the policy can be written against it.
--
-- The project id is compared AS TEXT rather than cast to uuid. A cast would be
-- an error on any object whose first folder is not a uuid, and Postgres makes
-- no promise about evaluating a guarding `~` regex before the cast beside it —
-- a single stray object would then break reads for the whole bucket.
--
-- Read: exactly the people who can read the ROW for this file, asked by looking
-- for that row rather than by restating its rules.
--
-- The first version of this policy restated them — no partner, plus a `projects`
-- join on the folder name — and that was already two copies of one sentence.
-- Adding the money gate (section 3b) would have made it three, and the third
-- copy is where they drift: a `money` document whose bytes stayed readable
-- through a signed link is the whole wall gone, silently, and nothing would
-- have failed. `project_documents`' own SELECT policy runs inside this
-- subquery for the person asking, so the bytes are readable exactly when the
-- row is — partner wall, money wall and job visibility, all of them, once.
--
-- The project folder is still checked, because it costs nothing and it keeps
-- the bucket's own shape honest: an object filed under a folder that is not a
-- job is unreachable even if a row somehow pointed at it. The project id is
-- compared AS TEXT for the reason given above.
--
-- Write: nobody, from a client, in this version. There is no INSERT, UPDATE or
-- DELETE policy here at all, so the only writer is the service role inside
-- monday-sync, which bypasses RLS. That is the same shape as the table's
-- grants above and for the same reason.
drop policy if exists "job documents read" on storage.objects;
create policy "job documents read"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'job-documents'
    and not public.is_partner_user()
    and exists (
      select 1 from public.project_documents d
      where d.storage_path = storage.objects.name
        and d.project_id::text = (storage.foldername(storage.objects.name))[1]
    )
  );


-- ---------------------------------------------------------------------------
-- 5. F6 — the bytes go when the row goes
-- ---------------------------------------------------------------------------
-- `project_documents.project_id` is ON DELETE CASCADE, so purging a job takes
-- every document row with it on the final `delete from projects`. That handles
-- the rows. It does NOT handle the BYTES: purge_project names each bucket it
-- clears by hand, and it was written before this bucket existed.
--
-- A trigger rather than a fourth copy of purge_project's 184-line body. The
-- alternative was re-declaring that whole function here to add one DELETE, and
-- app/src/lib/trashCascade.test.ts reads its definition out of
-- 20260974000000 by path — a second definition somewhere else is a copy that
-- test would stop watching, which is a worse trap than the leak it fixes.
--
-- This also covers every other way a document row can go, including the
-- "remove this document" button that does not exist yet. SECURITY DEFINER for
-- the same reason purge_project is: storage.objects belongs to the storage
-- admin, and only a definer-rights function can clear a row out of it.
--
-- Deliberately best-effort about the object already being gone: `delete` on a
-- name that is not there removes nothing and raises nothing, which is the right
-- answer for a purge that crashed halfway through and is being run again.
create or replace function public.forget_job_document_bytes()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  delete from storage.objects
   where bucket_id = 'job-documents'
     and name = old.storage_path;
  return old;
end;
$$;

comment on function public.forget_job_document_bytes() is
  'Clears a job document''s file out of the job-documents bucket when its row goes — including the cascade from purging a job, which purge_project does not name this bucket in (Monday files, F6).';

drop trigger if exists forget_job_document_bytes on project_documents;
create trigger forget_job_document_bytes
  after delete on project_documents
  for each row execute function public.forget_job_document_bytes();


-- ---------------------------------------------------------------------------
-- 6. Re-arm the test-login fence over the new table
-- ---------------------------------------------------------------------------
-- project_documents carries a project_id, which is what makes it project-scoped
-- and therefore something a test login must not be able to write outside its
-- sandbox. attach_sandbox_guards() is idempotent and re-attaches only what is
-- missing; scripts/test_sandbox_guard.py fails CI on a migration that adds a
-- project-scoped table and forgets this line.
select public.attach_sandbox_guards();


-- ---------------------------------------------------------------------------
-- 7. The plansets bucket, which this migration starts writing into
-- ---------------------------------------------------------------------------
-- HALF OF WHAT THE PULL WRITES GOES SOMEWHERE ELSE. A pulled "LP" or "CU" sheet
-- is a planset, so it lands in the `plansets` bucket rather than in the private
-- one above — and that bucket has carried a single policy since
-- 20260715120000: bucket-wide ALL, to every authenticated user, with no partner
-- guard and no scoping of any kind.
--
--   create policy "authenticated install buckets"
--     on storage.objects for all to authenticated
--     using (bucket_id in ('plansets','install-media'))
--     with check (...);
--
-- That predates THE WALL (20260950000000), which went through every crew table
-- and never touched storage.objects. So a builder's own login — a partner, who
-- is meant to see one job's readiness and nothing else — can today list,
-- download, overwrite and DELETE every job's plan sets. This migration is what
-- makes that material: it starts filing another company's paperwork in there.
-- docs/security-followups-2026-07-29.md has had the general form of this on its
-- list since July; the branch that fills the bucket is the branch that fixes it.
--
-- Two changes, and deliberately only two:
--
--   1. THE PARTNER WALL, on both buckets. Same sentence every crew table
--      carries, and scripts/test_partner_wall.py is the test that keeps it
--      there. install-media matters just as much — it holds job photos and the
--      photographs of receipts.
--   2. NO CLIENT DELETE ON PLANSETS. Nothing in the app deletes a planset
--      object: uploads always write a new timestamped path, and purging a job
--      clears the folder inside purge_project, which is SECURITY DEFINER and
--      does not answer to these policies. Until this line, any crew member
--      could delete any job's plan set from a browser console, and the job's
--      map would simply stop drawing.
--
-- WHAT IS DELIBERATELY NOT CHANGED: which crew member may read which job's
-- plansets. `project_plansets`' own policy is `using (true)` for all non-partner
-- crew, so the ROWS are already company-wide; scoping the bytes to jobs a
-- person can see would make the bucket stricter than the table it belongs to,
-- which reads like a wall without being one and would quietly break a foreman
-- opening a sandbox job's plans. Scoping both together is a change of its own,
-- with its own decision to take.
--
-- install-media is left bucket-wide for the same reason plus a mechanical one:
-- its paths are not all job folders ("receipts/…" is one), so there is no
-- folder rule to write there yet.
drop policy if exists "authenticated install buckets" on storage.objects;

drop policy if exists "install media crew" on storage.objects;
create policy "install media crew"
  on storage.objects for all to authenticated
  using (bucket_id = 'install-media' and not public.is_partner_user())
  with check (bucket_id = 'install-media' and not public.is_partner_user());

drop policy if exists "plansets crew read" on storage.objects;
create policy "plansets crew read"
  on storage.objects for select to authenticated
  using (bucket_id = 'plansets' and not public.is_partner_user());

drop policy if exists "plansets crew add" on storage.objects;
create policy "plansets crew add"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'plansets' and not public.is_partner_user());

-- Update, not delete: an upload that retries onto the same path has to be able
-- to finish, and the offline outbox does replay one.
drop policy if exists "plansets crew replace" on storage.objects;
create policy "plansets crew replace"
  on storage.objects for update to authenticated
  using (bucket_id = 'plansets' and not public.is_partner_user())
  with check (bucket_id = 'plansets' and not public.is_partner_user());

-- ===========================================================================
-- 20260989000000_capture_anywhere.sql (mirrored)
-- Capture anywhere (owner's ask, 2026-09-05): "it should also be able to
-- capture a photo and assign it to a job."
--
-- ONE CHANGE, AND IT IS A BUG FIX, NOT A FEATURE.
--
-- `attachments_target` says an attachment must hang off SOMETHING. It has
-- listed four things since 20260977000000 — a window, an install event, a
-- package, an opening — and has never listed the job itself:
--
--     check (window_id is not null
--         or install_event_id is not null
--         or package_id is not null
--         or project_opening_id is not null)
--
-- A job-feed photo hangs off the job and nothing else. `JobPhotoCapture` has
-- written exactly that row since the feed was built — project_id set, every
-- other target null — which is a 23514 check violation on every single one.
--
-- HOW THAT STAYED INVISIBLE. The photo is queued in the offline outbox first
-- and the person is told it saved, truthfully: it did, to their phone. The
-- upload handler then peels back through its tiers on a MISSING COLUMN, and a
-- check violation is not a missing column, so the entry burned its eight
-- retries and dead-lettered into Stuck writes — a screen an installer had no
-- menu row for until this same change gave them one. The photo was on the
-- phone and nowhere else, and nobody was told.
--
-- Verified against production on 2026-09-05, read-only: `project_opening_id`
-- exists on `attachments`, so 20260977000000 (the migration that last rewrote
-- this constraint) is applied and the live constraint is the four-target form
-- above. Rows with project_id set and every other target null: zero — which is
-- what a constraint that rejects them looks like from the outside. The two
-- attachments rows that exist both carry an install_event_id.
--
-- Widening rather than hanging the photo off a fake target: a photo of a job
-- is about the job. Inventing a window to point it at would be a lie in the
-- data to satisfy a check, and the next person to read the row would believe
-- it. `project_id` is already a real, indexed, foreign-keyed column here
-- (20260721002000) — it just was never allowed to stand on its own.
--
-- Note for whoever touches this next, carried forward from 20260936000000:
-- `attachments.service_case_id` (20260718070000) still is not in this list. It
-- costs nothing today because no app code writes that column alone, but a row
-- that set only service_case_id would fail the same way this one did.

alter table attachments drop constraint if exists attachments_target;
alter table attachments add constraint attachments_target
  check (
    window_id is not null
    or install_event_id is not null
    or package_id is not null
    or project_opening_id is not null
    or project_id is not null
  );

comment on constraint attachments_target on attachments is
  'An attachment hangs off something: a window, an install event, a package, an '
  'opening, or the job itself. The job was added 2026-09-05 — the job photo feed '
  'had been writing project-only rows since it was built and every one of them '
  'was failing this check and dead-lettering in the offline queue.';
