-- A damage report can carry a photo (warehouse ticket 11).
--
-- The package map and the Damaged card both promised a photo the app never
-- took. The words were corrected on 2026-08-17 (warehouseCards.test.ts,
-- packageFlow.test.ts) to say "a note" instead, which is what actually
-- happened. This migration is what makes the original promise true.
--
-- arrive_packages already opens a `damage` issue per package and stamps
-- created_by (20260827000000_package_staging_and_arrival.sql) — "who
-- reported it" was already real. This only adds somewhere to put a picture.

-- ------------------------------------------------------- where the path goes
--
-- A column on issues, not a widened attachments_target. `attachments`
-- requires a window_id or an install_event_id (20260715120000) and a
-- damaged package has neither. Widening that check to also accept an issue
-- would work, but issues already dedupes damage reports on
-- package_id + kind + status (20260827000000) — the row that will OWN the
-- photo already exists at the moment the photo does, so adding a column here
-- keeps "everything about this damage report" on the one row instead of
-- splitting it across two tables for a single field.
alter table issues add column if not exists photo_path text;

-- ---------------------------------------------------------------- the bucket
--
-- Private, path-scoped by project id — same shape as install-media
-- (20260715120000) and trip-attachments (20260723020000). Ungated for any
-- authenticated user, matching install-media and NOT trip-attachments' own
-- supervisor gate: arrive_packages itself is open to "any signed-in crew"
-- (20260827000000's comment) because the person who opens the crate is the
-- one who has to be able to report — and photograph — what is broken inside.
insert into storage.buckets (id, name, public)
values ('issue-photos', 'issue-photos', false)
on conflict (id) do nothing;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'objects' and policyname = 'authenticated issue photos'
  ) then
    create policy "authenticated issue photos"
      on storage.objects for all to authenticated
      using (bucket_id = 'issue-photos')
      with check (bucket_id = 'issue-photos');
  end if;
end;
$$;

-- ------------------------------------------------------------ arrive_packages
--
-- Rebuilt from its current definition (20260827000000_package_staging_and_
-- arrival.sql — nothing has touched it since) with one addition: p_photos, a
-- package id -> "bucket/path" map naming whichever damaged packages got a
-- photo. A defaulted new argument still changes the function's signature, so
-- the old 4-argument overload is dropped in the same breath — leaving it
-- behind would let a not-yet-updated client keep calling it and never notice
-- photos are silently going nowhere.
--
-- The path is looked up, never generated here: the client mints it (see
-- damagePhotoPath in lib/storage.ts) and queues the matching upload through
-- the outbox BEFORE calling this function, so a path this function writes
-- down is always one something has already promised to deliver bytes to.
drop function if exists arrive_packages(uuid[], uuid[], uuid, text);

create or replace function arrive_packages(
  p_ok uuid[],
  p_damaged uuid[],
  p_project uuid,
  p_note text default null,
  p_photos jsonb default '{}'::jsonb
)
returns int
language plpgsql
security definer
as $$
declare
  v_id uuid;
  v_note text;
  v_serial text;
  v_count int := 0;
begin
  if auth.uid() is null then
    raise exception 'sign in first';
  end if;
  if p_project is null then
    raise exception 'pick the job this material arrived at';
  end if;
  v_note := nullif(trim(coalesce(p_note, '')), '');

  foreach v_id in array coalesce(p_ok, array[]::uuid[])
  loop
    if not exists (
      select 1 from packages where id = v_id and status = 'checked_out'
    ) then
      continue;
    end if;
    insert into movements (package_id, event, project_id, actor, reason)
    values (v_id, 'unloaded', p_project, auth.uid()::text,
            coalesce('arrived on site — ' || v_note, 'arrived on site'));
    v_count := v_count + 1;
  end loop;

  foreach v_id in array coalesce(p_damaged, array[]::uuid[])
  loop
    select serial into v_serial from packages where id = v_id and status = 'checked_out';
    if v_serial is null then
      continue;
    end if;

    insert into movements (package_id, event, project_id, actor, reason)
    values (v_id, 'damaged', p_project, auth.uid()::text,
            coalesce('damaged on arrival — ' || v_note, 'damaged on arrival'));

    -- Deduped per package, mirroring the unit-side rule: a second report on
    -- the same package while the first is still open is the same problem.
    -- The photo follows the same rule the note already did — a repeat report
    -- on a package that already has an open issue does not retro-fit either
    -- one onto history it didn't carry when that issue was opened.
    if not exists (
      select 1 from issues
      where package_id = v_id and kind = 'damage' and status = 'open'
    ) then
      insert into issues (project_id, package_id, kind, urgency, note, created_by, photo_path)
      values (
        p_project, v_id, 'damage', 'urgent',
        coalesce('Package ' || v_serial || ' damaged on arrival — ' || v_note,
                 'Package ' || v_serial || ' damaged on arrival'),
        auth.uid(),
        p_photos ->> v_id::text
      );
    end if;
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;
