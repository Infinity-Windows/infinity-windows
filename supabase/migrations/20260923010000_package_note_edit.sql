-- A note on any tagged piece (owner ask), and a cap it never had.
--
-- packages.note has existed since the original storage_tracking migration —
-- bind_package writes it once at tag time, and nothing has ever let it
-- change again. This adds the cap the column was missing and the one writer
-- that can touch it after tagging.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'packages_note_ck') then
    alter table packages add constraint packages_note_ck
      check (note is null or char_length(note) <= 1000);
  end if;
end;
$$;

-- Any signed-in crew — the same rule report_maker_count and bind_package's
-- own note field follow. Flagging something out of the ordinary about a
-- piece is not an authority question the way an area pointer is. No
-- movement row: a note is not a move (ADR-0006's reasoning for areas holds
-- here the same way it does for report_maker_count).
create or replace function set_package_note(p_package uuid, p_note text)
returns packages
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row packages;
  v_note text;
begin
  if auth.uid() is null then
    raise exception 'sign in first';
  end if;
  v_note := nullif(trim(coalesce(p_note, '')), '');
  if v_note is not null and char_length(v_note) > 1000 then
    raise exception 'that note is too long — 1000 characters, max';
  end if;

  update packages set note = v_note
  where id = p_package and status <> 'blank'
  returning * into v_row;
  if not found then
    raise exception 'that sticker is not on a package yet';
  end if;
  return v_row;
end;
$$;
