-- Custom check-in (owner ask, 2026-08-25): standing at a conex or in the
-- main warehouse with something in hand that no delivery list predicted —
-- a box of hardware, spare glass, anything. Check it in RIGHT THERE:
-- pick a job or no job at all, label it anything from the open part list,
-- and optionally attach it to an existing set by mark. The attachment is
-- the mark itself, so it holds across containers — the rest of the set
-- can sit in a different conex and the unit views still gather it.

create or replace function custom_checkin(
  p_container uuid,
  p_project uuid default null,
  p_mark text default null,
  p_part_type text default null,
  p_note text default null,
  p_count int default 1
)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_mark_code text := upper(regexp_replace(trim(coalesce(p_mark, '')), '^#', ''));
  v_mark uuid;
  v_type text := lower(nullif(trim(coalesce(p_part_type, '')), ''));
  v_category text := 'other';
  v_row packages;
  v_count int := coalesce(p_count, 1);
  i int;
begin
  if auth.uid() is null then
    raise exception 'sign in first';
  end if;
  if not exists (select 1 from storage_containers where id = p_container and active) then
    raise exception 'container not found or inactive';
  end if;
  if v_count < 1 or v_count > 20 then
    raise exception 'Check in 1 to 20 at a time.';
  end if;
  if v_type is not null and length(v_type) not between 1 and 40 then
    raise exception 'A part label is 1 to 40 characters.';
  end if;
  if p_project is not null
     and not exists (select 1 from projects where id = p_project) then
    raise exception 'That job does not exist.';
  end if;

  if p_project is not null and v_mark_code <> '' then
    insert into project_marks (project_id, mark_code)
    values (p_project, v_mark_code)
    on conflict (project_id, mark_code) do nothing;
    select id into v_mark from project_marks
    where project_id = p_project and mark_code = v_mark_code;
    -- Borrow the set's own category so the new piece counts with its unit.
    select p2.category into v_category
    from packages p2
    join package_marks pm on pm.package_id = p2.id
    where pm.mark_id = v_mark and p2.category in ('windows', 'doors')
    limit 1;
    v_category := coalesce(v_category, 'other');
  end if;

  for i in 1..v_count loop
    insert into packages
      (status, project_id, category, part_type, mfr_mark, note,
       container_id, short_code, bound_at, bound_by)
    values
      ('stored', p_project, v_category, v_type,
       nullif(v_mark_code, ''),
       nullif(trim(coalesce(p_note, '')), ''),
       p_container, issue_package_short_code(), now(), auth.uid()::text)
    returning * into v_row;
    if v_mark is not null then
      insert into package_marks (package_id, mark_id)
      values (v_row.id, v_mark) on conflict do nothing;
    end if;
    insert into movements (package_id, event, project_id, actor, to_container_id, reason)
    values (v_row.id, 'received', p_project, auth.uid()::text, p_container,
            'custom check-in' || case when v_type is not null then ' — ' || v_type else '' end);
    insert into movements (package_id, event, project_id, actor, to_container_id, reason)
    values (v_row.id, 'stored', p_project, auth.uid()::text, p_container,
            'checked in on the spot');
  end loop;

  return v_count;
end;
$$;

grant execute on function custom_checkin(uuid, uuid, text, text, text, int) to authenticated;
