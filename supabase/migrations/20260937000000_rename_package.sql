-- Rename a package's headline (owner, 2026-08-26): the container list now
-- leads with the package's real name — job or waiting-job text, mark, piece
-- — and the crew can fix that name right on the row. Piece numbers and the
-- what-is-it label already have set_package_part / label_packages; this
-- covers the two halves nothing else edits:
--
--   * pending_job_name — the waiting-job text on material whose job isn't
--     built in the app yet. Only meaningful while the package is unbound;
--     a bound package's job line IS its job code, renamed on the job.
--   * mfr_mark — the manufacturer's mark. Only while no package_marks row
--     exists: once a package is tied to a real window, its mark comes from
--     that window, and "renaming" it here would quietly break the tie the
--     load lists and completeness math stand on — reassigning is the honest
--     move there, so this raises instead.
--
-- Pure metadata, no movements row — the label_packages precedent.

create or replace function rename_package(
  p_package uuid,
  p_pending_job_name text,
  p_mark text
)
returns packages
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row packages%rowtype;
  v_pending text := nullif(trim(coalesce(p_pending_job_name, '')), '');
  v_mark text := nullif(trim(coalesce(p_mark, '')), '');
begin
  if auth.uid() is null then
    raise exception 'sign in first';
  end if;
  if v_pending is not null and length(v_pending) > 120 then
    raise exception 'A waiting-job name is at most 120 characters.';
  end if;
  if v_mark is not null and length(v_mark) > 40 then
    raise exception 'A mark is at most 40 characters.';
  end if;

  select * into v_row from packages where id = p_package;
  if not found then
    raise exception 'That package does not exist.';
  end if;
  if v_row.status = 'blank' then
    raise exception 'That package is a blank sticker — tag it first.';
  end if;
  if v_row.project_id is not null and v_pending is not null then
    raise exception 'This piece belongs to a job already — its name comes from the job.';
  end if;
  if v_mark is distinct from v_row.mfr_mark
     and exists (select 1 from package_marks where package_id = p_package) then
    raise exception 'This piece is tied to a real window — reassign it instead of renaming the mark.';
  end if;

  update packages
  set pending_job_name = case when project_id is null then v_pending else pending_job_name end,
      mfr_mark = v_mark
  where id = p_package
  returning * into v_row;

  return v_row;
end;
$$;

grant execute on function rename_package(uuid, text, text) to authenticated;
