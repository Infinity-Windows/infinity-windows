-- Correction to 20260902 (ticket 12), same day.
--
-- The building seed checked "is there a building yet" and nothing else. But
-- production already HAD a container named "Main Warehouse" — created before
-- kinds existed, so it defaulted to conex — and the seed walked right past it
-- and made a second main warehouse. Two rows for one building is the same
-- disease as a supply catalog holding "Caulk" and "caulk": every count and
-- every answer built on it forks.
--
-- The fix keeps the OWNER'S row and removes the SEEDED one, not the other way
-- around: his row carries the serial and any codes his crew may already know,
-- and mine was minutes old and empty. His row's kind flips to building — the
-- one legitimate kind change there will ever be, because this row IS the
-- building and was only ever a "conex" by default-backfill. The kind lock in
-- save_storage_container stays exactly as it is; this is a migration fixing a
-- migration, not a door for edits.
--
-- Every step is guarded so this is safe to run anywhere, any number of times:
-- it acts only when both rows exist, and it deletes only a building row that
-- holds no packages, holds no containers, and appears in no movement line.
do $$
declare
  v_seeded uuid;
  v_original uuid;
begin
  -- The seed's row: a building named "main warehouse" (case-insensitive).
  select id into v_seeded
  from storage_containers
  where kind = 'building' and lower(trim(name)) = 'main warehouse'
  order by created_at desc
  limit 1;

  -- The owner's row: same name, wrong kind, older.
  select id into v_original
  from storage_containers
  where kind <> 'building' and lower(trim(name)) = 'main warehouse'
  order by created_at asc
  limit 1;

  if v_seeded is null or v_original is null then
    return; -- nothing to fix (or already fixed)
  end if;

  if exists (select 1 from packages where container_id = v_seeded)
     or exists (select 1 from storage_containers where parent_container_id = v_seeded)
     or exists (
       select 1 from movements
       where container_id = v_seeded
          or from_container_id = v_seeded
          or to_container_id = v_seeded
     ) then
    -- Somebody used the seeded row in the hours it existed. Deleting it now
    -- would eat their work; converging two USED rows is a human decision, so
    -- stop loudly rather than guess.
    raise exception 'two main warehouses exist and both have been used — resolve by hand';
  end if;

  delete from storage_containers where id = v_seeded;

  update storage_containers
  set kind = 'building',
      -- A building sits inside nothing and on no slot, whatever the row said
      -- while it was mislabeled.
      parent_container_id = null,
      location_id = null
  where id = v_original;
end;
$$;
