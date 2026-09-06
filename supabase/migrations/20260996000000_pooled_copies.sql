-- Copies of a unit, with or without their own stickers (warehouse redesign
-- wave 5, owner call 2026-09-06).
--
-- The owner's ask: keep the ability to copy a unit N times, every copy with
-- its own unique ID, and add the option of a copy that carries no sticker of
-- its own. The industry names for the two are serial-tracked (each copy its
-- own sticker) and lot-tracked (copies pooled under one ID, moved by count).
--
--   packages.tracking — 'serial' (default, today's behaviour) or 'pooled': a
--                       copy that rides on the original's sticker. The label
--                       printer writes "×N" on the original; a scan of it asks
--                       how many are moving; every pooled copy still has its
--                       own serial and short code, so history stays per piece,
--                       and set_package_part / reprint can give it its own
--                       sticker later — promotion is a flag flip plus paper.
--   copy_unit          — N more of a unit on the same job and window: every
--                       part slot the unit has gets N more expected packages,
--                       the same interchangeable-pool idea as the delivery
--                       wizard's clone sets (PR #409). Crew work (ADR-0007).
--
-- Also retired here: materialize_pending_set, which nothing has called since
-- pending_delivery_sets went (ADR-0007's own closing note flagged it).

alter table packages
  add column if not exists tracking text not null default 'serial';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'packages_tracking_ck') then
    alter table packages add constraint packages_tracking_ck
      check (tracking in ('serial', 'pooled'));
  end if;
end;
$$;

create or replace function copy_unit(
  p_project uuid,
  p_mark text,
  p_times int,
  p_pooled boolean default false
)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_code text;
  v_mark uuid;
  v_src record;
  v_row packages;
  v_n int := 0;
  i int;
begin
  -- Warehouse work is crew work (ADR-0007): signed in, and not a builder
  -- login, is the whole door.
  if auth.uid() is null then
    raise exception 'sign in first';
  end if;
  if public.is_partner_user() then
    raise exception 'Only a crew member can do warehouse work.'
      using errcode = '42501';
  end if;
  if p_times is null or p_times < 1 or p_times > 20 then
    raise exception 'copy a unit 1 to 20 times at once';
  end if;

  v_code := upper(trim(coalesce(p_mark, '')));
  select id into v_mark from project_marks
  where project_id = p_project and mark_code = v_code;
  if v_mark is null then
    raise exception 'window % is not on this job''s schedule', v_code;
  end if;

  -- One representative per part slot: the unit's shape, not its twins.
  for v_src in
    select distinct on (p.part_index, coalesce(p.part_type, ''), coalesce(p.piece_count, -1))
           p.category, p.part_index, p.part_total, p.part_type, p.piece_count, p.mfr_mark
    from packages p
    join package_marks pm on pm.package_id = p.id
    where pm.mark_id = v_mark and p.status <> 'blank'
    order by p.part_index, coalesce(p.part_type, ''), coalesce(p.piece_count, -1), p.created_at
  loop
    for i in 1..p_times loop
      insert into packages
        (status, project_id, category, part_index, part_total, part_type,
         piece_count, mfr_mark, tracking, short_code, bound_at, bound_by)
      values
        ('minted', p_project, v_src.category, v_src.part_index, v_src.part_total,
         v_src.part_type, v_src.piece_count, v_src.mfr_mark,
         case when p_pooled then 'pooled' else 'serial' end,
         issue_package_short_code(), now(), auth.uid()::text)
      returning * into v_row;
      insert into package_marks (package_id, mark_id) values (v_row.id, v_mark)
      on conflict do nothing;
      insert into movements (package_id, event, project_id, actor, reason)
      values (v_row.id, 'preissued', p_project, auth.uid()::text,
              'copy ' || i || ' of ' || p_times || ' of window ' || v_code
              || case when p_pooled then ' — rides on the original''s sticker' else '' end);
      v_n := v_n + 1;
    end loop;
  end loop;

  if v_n = 0 then
    raise exception 'window % has no packages to copy yet', v_code;
  end if;
  return v_n;
end;
$$;

revoke execute on function copy_unit(uuid, text, int, boolean) from public, anon;
grant execute on function copy_unit(uuid, text, int, boolean) to authenticated;

drop function if exists materialize_pending_set(uuid, uuid);
