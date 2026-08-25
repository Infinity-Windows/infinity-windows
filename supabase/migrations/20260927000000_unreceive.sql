-- Undo an arrival tap (owner ask, 2026-08-25, five minutes into using the
-- tailgate screen): a thumb slips, "1 arrived" was wrong, the box is still
-- on the truck. Flip it back to expected.
--
-- Allowed: received-and-loose boxes, and crate pieces (whose arrive tap
-- auto-stored them INTO their crate — undoing puts them back to expected,
-- crate assignment untouched). REFUSED: anything a person actually stored
-- in a container or checked out — a real put-away is not a thumb slip;
-- take it out first. The movement log records the undo with 'override',
-- the vocabulary's existing escape hatch — movements_event_ck stays
-- untouched, as always.

create or replace function unreceive_packages(p_packages uuid[])
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
    if not found then
      continue;
    end if;
    if v_row.status = 'received'
       or (v_row.status = 'stored' and v_row.piece_count is not null) then
      update packages set status = 'minted' where id = v_id;
      insert into movements (package_id, event, project_id, actor, reason)
      values (v_id, 'override', v_row.project_id, auth.uid()::text,
              'arrival tap undone — back to expected');
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end;
$$;

grant execute on function unreceive_packages(uuid[]) to authenticated;
