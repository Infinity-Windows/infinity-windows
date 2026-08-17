-- A package knows which piece it is (warehouse ticket 02).
--
-- The manufacturer prints "#16 2/3" on every package: this one is the second
-- of three pieces of unit 16. The denominator is the trick — the FIRST package
-- to arrive declares how many pieces its window has, so "2 of 3 here, hardware
-- not arrived" needs no parts list and no spec reading (grill, 2026-08-17).
-- This migration stores what the label says; the completeness read model that
-- uses it is ticket 03.
--
-- All four columns are nullable on purpose: a label with no part number is a
-- real, common case, treated downstream as 1 of 1 and flagged "no part number
-- on label". A mismatch never blocks the receiving line.

alter table packages
  add column if not exists part_index int,
  add column if not exists part_total int,
  add column if not exists part_type text,
  -- The manufacturer's own mark, recorded ONLY when it differs from the plan
  -- mark riding in package_marks — matching numbers stay one number.
  add column if not exists mfr_mark text;

-- Postgres has no ADD CONSTRAINT IF NOT EXISTS; guard by name instead so the
-- migration stays rerun-safe like every other one here.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'packages_part_index_ck') then
    alter table packages add constraint packages_part_index_ck
      check (part_index is null or part_index >= 1);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'packages_part_total_ck') then
    alter table packages add constraint packages_part_total_ck
      check (part_total is null or part_total >= 1);
  end if;
  -- "2/3" always has both halves: a numerator without a denominator (or the
  -- reverse) is a data-entry slip, not a label the manufacturer prints.
  if not exists (select 1 from pg_constraint where conname = 'packages_part_pair_ck') then
    alter table packages add constraint packages_part_pair_ck
      check ((part_index is null) = (part_total is null));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'packages_part_range_ck') then
    alter table packages add constraint packages_part_range_ck
      check (part_index is null or part_total is null or part_index <= part_total);
  end if;
  -- The fixed list from the grill (Q17): countable, filterable, no free text.
  -- "other" plus the note field is the escape hatch.
  if not exists (select 1 from pg_constraint where conname = 'packages_part_type_ck') then
    alter table packages add constraint packages_part_type_ck
      check (part_type is null or part_type in
        ('frame', 'glass', 'panel', 'threshold', 'hardware', 'screen', 'other'));
  end if;
end;
$$;

-- ---------------------------------------------------------------- RPC

-- Adding parameters to a Postgres function does not replace it — it OVERLOADS
-- it, and a 6-arg call would then match both versions and fail as ambiguous.
-- Drop the old signature explicitly; clients still on it call the new one via
-- the defaults.
drop function if exists bind_package(uuid, uuid, text, text, text[], uuid);

create or replace function bind_package(
  p_package uuid,
  p_project uuid,
  p_category text default null,
  p_note text default null,
  p_marks text[] default null,
  p_delivery uuid default null,
  p_part_index int default null,
  p_part_total int default null,
  p_part_type text default null,
  p_mfr_mark text default null
)
returns packages
language plpgsql
security definer
as $$
declare
  v_row packages;
  v_mark uuid;
  m text;
begin
  if auth.uid() is null then
    raise exception 'sign in first';
  end if;
  if p_project is null then
    raise exception 'every package binds to a job';
  end if;
  -- Friendlier than letting the check constraints fire: these two are the
  -- slips a phone keyboard actually produces.
  if (p_part_index is null) <> (p_part_total is null) then
    raise exception 'a part number needs both halves — "2 of 3", not just one';
  end if;
  if p_part_index is not null and p_part_index > p_part_total then
    raise exception 'part % of % — the first number can''t be bigger than the second', p_part_index, p_part_total;
  end if;

  -- Resolve every mark BEFORE touching the package: a bad mark list leaves
  -- the sticker blank and reusable rather than half-bound (ticket 01).
  foreach m in array coalesce(p_marks, array[]::text[])
  loop
    select id into v_mark
    from project_marks
    where project_id = p_project and mark_code = upper(trim(m));
    if v_mark is null then
      raise exception 'mark % is not on this job''s schedule', m;
    end if;
  end loop;

  update packages
  set status = 'received',
      project_id = p_project,
      category = p_category,
      note = nullif(trim(coalesce(p_note, '')), ''),
      delivery_id = p_delivery,
      part_index = p_part_index,
      part_total = p_part_total,
      part_type = p_part_type,
      mfr_mark = nullif(upper(trim(coalesce(p_mfr_mark, ''))), ''),
      bound_at = now(),
      bound_by = auth.uid()::text
  where id = p_package and status = 'blank'
  returning * into v_row;
  if not found then
    raise exception 'that sticker is already assigned — a package ID never moves to another package';
  end if;

  foreach m in array coalesce(p_marks, array[]::text[])
  loop
    select id into v_mark
    from project_marks
    where project_id = p_project and mark_code = upper(trim(m));
    insert into package_marks (package_id, mark_id)
    values (p_package, v_mark)
    on conflict do nothing;
  end loop;

  insert into package_events (package_id, event, project_id, actor)
  values (p_package, 'bound', p_project, auth.uid()::text);

  return v_row;
end;
$$;
