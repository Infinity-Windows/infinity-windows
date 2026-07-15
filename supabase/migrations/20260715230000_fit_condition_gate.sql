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
