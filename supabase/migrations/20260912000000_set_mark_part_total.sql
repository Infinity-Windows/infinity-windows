-- The late package (owner ask, 2026-08-18): a window tagged as three pieces
-- turns out to have four — one was missed at the truck, or an add-on part got
-- ordered later. The new package binds as 4/4, and the THREE OLDER LABELS
-- still say "of 3", which would make every completeness answer lie forever
-- ("3 of 3 here" while a threshold is on order).
--
-- So growing the count is one deliberate act: rewrite part_total on every
-- package the window already has, then bind the new one. Foreman+, because it
-- rewrites what printed paper means; one history line records the change,
-- under 'override' — the event that already means "a person corrected the
-- record by authority" (same reasoning as burn's tombstone).
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
  if not public.is_foreman_plus(auth.uid()) then
    raise exception 'only a foreman-level user or above can change a window''s package count';
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
