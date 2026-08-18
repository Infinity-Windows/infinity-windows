-- Ticket 17: the Boneyard — company stock no job owns yet.
--
-- The crew's word, kept on purpose (owner, 2026-08-18): a cleaner word would
-- be one the crew has to learn. The owner's warehouse reorganization is
-- mostly labeling stock that belongs to nobody, and until now the tag screen
-- could not express that — bind_package required a job.
--
-- A boneyard package is tagged like any other: sticker, category, part fields
-- off the maker's label. What it does NOT carry is a window number — a window
-- number is a position on ONE job's plans, and boneyard stock has no job. It
-- leaves the boneyard through assign_package_to_job (ticket 18), a foreman
-- decision, not through tagging.
--
-- NOT the same thing as a finished job's packages: those keep their job.
-- project_id null is the ONLY boneyard signal, and it has always been legal
-- in the schema (references projects on delete set null) — what changes here
-- is that a person can now say it on purpose.
--
-- Rebuilt from the CURRENT definition in 20260825000000 (nothing since has
-- redefined bind_package — verified), plus the boneyard branch. The old
-- signature stays callable: p_boneyard defaults false, so a stale bundle's
-- named-argument call behaves exactly as it always did.
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
  p_mfr_mark text default null,
  p_boneyard boolean default false
)
returns packages
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row packages;
  v_mark uuid;
  m text;
begin
  if auth.uid() is null then
    raise exception 'sign in first';
  end if;
  if coalesce(p_boneyard, false) then
    if p_project is not null then
      raise exception 'boneyard stock has no job — pick one or the other';
    end if;
    if p_marks is not null and array_length(p_marks, 1) > 0 then
      raise exception 'a window number is a position on one job''s plans — boneyard stock has none';
    end if;
  elsif p_project is null then
    raise exception 'every package binds to a job — or to the Boneyard, said on purpose';
  end if;
  if (p_part_index is null) <> (p_part_total is null) then
    raise exception 'a part number needs both halves — "2 of 3", not just one';
  end if;
  if p_part_index is not null and p_part_index > p_part_total then
    raise exception 'part % of % — the first number can''t be bigger than the second', p_part_index, p_part_total;
  end if;

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

  insert into movements (package_id, event, project_id, actor, reason)
  values (p_package, 'bound', p_project, auth.uid()::text,
          case when coalesce(p_boneyard, false) then 'tagged into the Boneyard — company stock' end);

  return v_row;
end;
$$;
