-- The kind of a set (owner rec-4, wave M, 2026-08-28): the SetEditor gets a
-- Window/Door toggle for a set's whole run of packages, the same loop
-- rename_package's own rename already uses. Category is an existing
-- concept (packages.category, checked against 'windows'/'doors'/'frames'/
-- 'hardware'/'other' since 20260814000000) — this only gives the crew a
-- door to CHANGE it after the fact, on a whole set at once.
--
-- p_category defaults to null and null means "leave it alone" — unlike
-- pending_job_name/mfr_mark (which the storage.ts wrapper always sends,
-- current value included, so "unchanged" is spelled out loud every call),
-- a 3-arg caller from before this migration keeps working with category
-- untouched, and the toggle only sends a value when it was actually tapped.
-- Applies whether or not the set is bound to a real job — unlike the mark/
-- pending-name fields, category never belonged to the job's own window, so
-- no guard restricts it.
--
-- House rule for defaulted-arg changes (20260823000000, 20260902000000,
-- 20260910000000): `create or replace` only replaces a function with the
-- IDENTICAL argument list — adding a param creates an OVERLOAD instead of
-- replacing anything, and two candidates with the same shared arguments
-- makes Postgres refuse to pick. Drop the 3-arg signature first so exactly
-- one survives.

drop function if exists rename_package(uuid, text, text);

create or replace function rename_package(
  p_package uuid,
  p_pending_job_name text,
  p_mark text,
  p_category text default null
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
  v_category text := nullif(trim(coalesce(p_category, '')), '');
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
  if v_category is not null and v_category not in ('windows', 'doors') then
    raise exception 'A set is windows or doors.';
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
      mfr_mark = v_mark,
      category = coalesce(v_category, category)
  where id = p_package
  returning * into v_row;

  return v_row;
end;
$$;

grant execute on function rename_package(uuid, text, text, text) to authenticated;
