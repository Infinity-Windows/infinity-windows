-- The rough-opening checklist SAVES — taps, diagonals, every point.
--
-- The checklist shipped remembering only the smallest width/height; the
-- Good/Bad taps and the individual measurements lived in the browser and
-- vanished on reload, so the framer fixing 12-1 couldn't see what was judged
-- or flip Bad back to Good afterward. The whole checklist now rides the
-- opening as jsonb, editable by anyone who can measure (same trusted-crew
-- write path as the dimensions themselves), and the client auto-resolves the
-- open framing issue when a re-check comes back all good.

alter table project_openings
  add column if not exists ro_check jsonb;

-- Body identical to 20260715230000 plus the optional checklist payload.
-- Passing null leaves an existing saved checklist alone (older clients).
create or replace function set_opening_rough_opening(
  p_opening_id uuid,
  p_width_in numeric,
  p_height_in numeric,
  p_actor text default null,
  p_check jsonb default null
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
      ro_measured_at = now(),
      ro_check = coalesce(p_check, ro_check)
  where id = p_opening_id
  returning * into v_opening;

  if v_opening is null then
    raise exception 'unknown opening %', p_opening_id;
  end if;
  return v_opening;
end;
$$;
