-- Ticket 16: Burn — killing a minted label that never lived.
--
-- The owner asked for this directly ("unassign one or multiple labels in case
-- of damaging and needing to re label them"), and review split the accident
-- in two: a ruined sticker on a package WITH history is a Reprint (same
-- serial, fresh paper, trail intact — client-side, no SQL needed); Burn is
-- only for labels whose material never arrived. One action covering both
-- would eat history.
--
-- Burn DELETES the row. The serial dies — a standing decision says serials
-- are never reused, and a deleted row cannot leak back into any roll — and
-- the part slot reopens, so mint_mark_packages can issue a fresh "2 of 4".
-- movements.package_id cascades on delete, so the row's own 'preissued' line
-- dies with it; the tombstone below is written FIRST, with no package id, so
-- the destruction itself stays on the record in plain words. Its event is
-- 'override' — the one event that already means "a person corrected the
-- record by authority" — because widening movements_event_ck is how
-- production broke once, and a new value is not worth that risk here.
--
-- All or nothing, on purpose: burning is destruction, and a multi-select that
-- quietly burns four of five is worse than one that stops loudly. A missing
-- id is the one exception — that label is already gone, which is what the
-- caller wanted; a resend after a lost answer must not fail the batch.
create or replace function burn_packages(p_packages uuid[])
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_row packages;
  v_mark text;
  v_count int := 0;
begin
  if not public.is_foreman_plus(auth.uid()) then
    raise exception 'only a foreman-level user or above can burn labels';
  end if;

  -- Refuse the whole batch before touching anything.
  foreach v_id in array coalesce(p_packages, array[]::uuid[])
  loop
    select p.* into v_row from packages p where p.id = v_id;
    if not found then
      continue; -- already gone — a resend is not a second burn
    end if;
    if v_row.status <> 'minted' then
      raise exception
        '% has a life behind it — reprint the sticker instead of burning it',
        v_row.serial;
    end if;
  end loop;

  foreach v_id in array coalesce(p_packages, array[]::uuid[])
  loop
    select p.* into v_row from packages p where p.id = v_id;
    if not found then
      continue;
    end if;

    select pm2.mark_code into v_mark
    from package_marks pm
    join project_marks pm2 on pm2.id = pm.mark_id
    where pm.package_id = v_id
    limit 1;

    insert into movements (event, project_id, actor, reason)
    values (
      'override',
      v_row.project_id,
      auth.uid()::text,
      'burned label ' || v_row.serial ||
        coalesce(' — window ' || v_mark, '') ||
        coalesce(', part ' || v_row.part_index || ' of ' || v_row.part_total, '') ||
        ' — never arrived, paper destroyed'
    );

    delete from packages where id = v_id;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;
