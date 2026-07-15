-- Window Ops prototype — paste into Supabase SQL editor (project czprjcskmzzagdztqonm).
-- Run once. Safe to re-run (create or replace / if not exists).
-- Covers: smart assignment + demand rollup + AI brain columns.

-- =============================================================================
-- 1) Lifecycle unify: assign logs movement + demand rollup from openings
-- =============================================================================

alter table movements drop constraint if exists movements_event_check;
alter table movements add constraint movements_event_check
  check (event in (
    'received','putaway','moved','staged','loaded','installed','damaged',
    'count_verified','count_missing','override','assigned'
  ));

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

create or replace function sync_project_windows_from_openings(p_project_id uuid)
returns void
language plpgsql
as $$
begin
  delete from project_windows pw
  where pw.project_id = p_project_id
    and not exists (
      select 1
      from project_openings o
      where o.project_id = p_project_id
        and o.confirmed = true
        and o.window_type_id = pw.window_type_id
    );

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

-- =============================================================================
-- 2) AI brain columns (tips / watch-outs / outcome difficulty + transcription flag)
-- =============================================================================

alter table window_types
  add column if not exists tips_json jsonb not null default '[]'::jsonb,
  add column if not exists watch_outs_json jsonb not null default '[]'::jsonb,
  add column if not exists outcome_difficulty int
    check (outcome_difficulty is null or outcome_difficulty between 1 and 5),
  add column if not exists tips_synthesized_at timestamptz,
  add column if not exists tips_install_count int not null default 0;

alter table attachments
  add column if not exists transcribed_at timestamptz;

create index if not exists attachments_voice_pending_idx
  on attachments (created_at)
  where kind = 'voice_memo' and transcribed_at is null;

-- =============================================================================
-- 3) Fit + condition gate (Pillar 1): rough-opening dims + damage check
-- =============================================================================

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

  return v_opening;
end;
$$;
