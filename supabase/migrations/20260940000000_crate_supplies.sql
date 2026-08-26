-- Supplies riding in crates (owner ask, 2026-08-26): "sometimes materials
-- such as caulk are thrown in crates — log these items as part of the
-- crate." A supply in the crates is a POOL ROW — the exact shape crate
-- glass already uses (piece_count + part_type, no mark): it reads "6 pieces
-- of caulk (in the crates)" everywhere pool rows already show, counts down
-- as it gets used, and dies by delete when it is gone. No new tables, no
-- new vocabulary — one door to make such a row after the truck has left.
--
-- Any signed-in crew can log one (the tailgate trust level: label_packages,
-- custom_checkin). Movement event 'received' — the same word custom_checkin
-- writes for material appearing at the door; the ck list is untouched.

create or replace function add_crate_supplies(
  p_project uuid,
  p_job_name text,
  p_part_type text,
  p_pieces int
)
returns packages
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row packages;
  v_type text := lower(nullif(trim(coalesce(p_part_type, '')), ''));
  v_name text := nullif(trim(coalesce(p_job_name, '')), '');
begin
  if auth.uid() is null then
    raise exception 'sign in first';
  end if;
  if v_type is null or length(v_type) not between 1 and 40 then
    raise exception 'Say what the supply is — 1 to 40 characters.';
  end if;
  if p_pieces is null or p_pieces < 1 or p_pieces > 99 then
    raise exception 'How many pieces ride in the crates? 1 to 99.';
  end if;
  if p_project is null and v_name is null then
    raise exception 'Crate supplies belong to a job — picked, or at least named.';
  end if;
  if p_project is not null and not exists (select 1 from projects where id = p_project) then
    raise exception 'That job does not exist.';
  end if;

  insert into packages
    (status, project_id, pending_job_name, category, part_type, piece_count,
     short_code, bound_at, bound_by)
  values
    ('received', p_project,
     case when p_project is null then v_name end,
     'other', v_type, p_pieces,
     issue_package_short_code(), now(), auth.uid()::text)
  returning * into v_row;

  insert into movements (package_id, event, project_id, actor, reason)
  values (v_row.id, 'received', p_project, auth.uid()::text,
          'supply logged into the crates — ' || p_pieces || ' × ' || v_type);

  return v_row;
end;
$$;

grant execute on function add_crate_supplies(uuid, text, text, int) to authenticated;
