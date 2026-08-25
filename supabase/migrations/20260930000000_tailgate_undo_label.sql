-- The tailgate grows its two missing verbs (owner, 2026-08-25, mid-unload):
--
--   unstore_packages: un-put-away. A box stored into a conex from the
--   delivery screen comes back to arrived-and-loose (container cleared),
--   so the walk-back is complete: stored -> received -> expected, most
--   recent step first. Movement logs it with 'override' (the vocabulary's
--   escape hatch — the constraint stays untouched, as always). Checked-out
--   packages still refuse: material on a truck to a jobsite is not a
--   tailgate slip.
--
--   label_packages: "what is it?" asked AT check-in. The wizard defers
--   part labels on purpose (the boxes decide), and the tailgate is where
--   the boxes are finally read — one call labels every twin just received.
--   Pure metadata; no movement row, same as set_package_part.

create or replace function unstore_packages(p_packages uuid[])
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row packages%rowtype;
  v_id uuid;
  v_count int := 0;
begin
  if auth.uid() is null then
    raise exception 'sign in first';
  end if;
  foreach v_id in array coalesce(p_packages, array[]::uuid[])
  loop
    select * into v_row from packages where id = v_id;
    if not found or v_row.status <> 'stored' then
      continue;
    end if;
    update packages
    set status = 'received', container_id = null, area = null
    where id = v_id;
    insert into movements (package_id, event, project_id, actor, from_container_id, reason)
    values (v_id, 'override', v_row.project_id, auth.uid()::text, v_row.container_id,
            'put-away undone at the tailgate — back to loose');
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

grant execute on function unstore_packages(uuid[]) to authenticated;

create or replace function label_packages(p_packages uuid[], p_part_type text)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_type text := lower(nullif(trim(coalesce(p_part_type, '')), ''));
  v_count int := 0;
begin
  if auth.uid() is null then
    raise exception 'sign in first';
  end if;
  if v_type is null or length(v_type) not between 1 and 40 then
    raise exception 'A part label is 1 to 40 characters.';
  end if;
  update packages
  set part_type = v_type
  where id = any (coalesce(p_packages, array[]::uuid[]))
    and status <> 'blank';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

grant execute on function label_packages(uuid[], text) to authenticated;
