-- Daily-log photos are immutable uploads and durable history anchors.
-- Existing gallery SELECT and unrelated Storage paths keep their current scope.
-- The project FK's existing ON DELETE SET NULL, after purge_project detaches
-- daily_logs, preserves these photos without replacing the shared Workflow purge.
begin;

alter table public.attachments add column if not exists daily_log_id uuid;
alter table public.attachments drop constraint if exists attachments_daily_log_id_fkey;
alter table public.attachments add constraint attachments_daily_log_id_fkey
  foreign key (daily_log_id) references public.daily_logs(id) on delete restrict;
create index if not exists attachments_daily_log_id_idx on public.attachments(daily_log_id) where daily_log_id is not null;
create unique index if not exists attachments_daily_log_storage_unique
  on public.attachments(storage_path) where daily_log_id is not null;

alter table public.attachments drop constraint if exists attachments_target;
alter table public.attachments add constraint attachments_target check (
  window_id is not null or install_event_id is not null or package_id is not null
  or project_opening_id is not null or project_id is not null or daily_log_id is not null
);

-- Broad namespace detection also catches malformed names. A malformed daily-log
-- name must not fall back to the legacy bucket policy or an untagged attachment.
create or replace function public._is_daily_log_photo_name(p_name text)
returns boolean language sql immutable set search_path = public, pg_temp as $$
  select coalesce(split_part(p_name, '/', 2) = 'daily-logs', false);
$$;
create or replace function public._daily_log_photo_actor()
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select public.can_file_daily_log() and exists (
    select 1 from public.profiles where id = auth.uid()
      and retired_at is null and access_revoked_at is null
  );
$$;

-- Called by Storage INSERT policy and the attachment's new-row guard. Holding
-- the project lock until commit serializes association with trash/purge. The
-- path's UUIDs bind job, log, uploader and stable operation; none is inferred
-- from a caller-editable display name. Storage owner_id is authoritative.
create or replace function public._daily_log_photo_upload_allowed(
  p_name text, p_owner_id text, p_metadata jsonb
)
returns boolean language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_project uuid;
  v_deleted timestamptz;
begin
  if not public._daily_log_photo_actor() or p_owner_id is distinct from auth.uid()::text then
    return false;
  end if;
  if p_name is null or p_name !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/daily-logs/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$'
     or split_part(p_name, '/', 4) <> auth.uid()::text then
    return false;
  end if;
  -- Storage canUpload is a permission preflight: modern releases supply
  -- mimetype/contentLength, older releases may supply no metadata. Final size
  -- does not exist yet. Refuse a known wrong MIME here; the attachment guard
  -- separately requires the completed object's MIME and actual stored size.
  if p_metadata->>'mimetype' is not null and p_metadata->>'mimetype' <> 'image/jpeg' then
    return false;
  end if;

  v_project := split_part(p_name, '/', 1)::uuid;
  select deleted_at into v_deleted from public.projects where id = v_project for share;
  if not found or v_deleted is not null then return false; end if;
  return exists (
    select 1 from public.daily_logs
      where id = split_part(p_name, '/', 3)::uuid and project_id = v_project
  );
end;
$$;

create or replace function public._daily_log_photo_metadata_valid(p_metadata jsonb)
returns boolean language plpgsql immutable set search_path = public, pg_temp as $$
begin
  if p_metadata is null or p_metadata->>'mimetype' is distinct from 'image/jpeg'
     or coalesce(p_metadata->>'size', '') !~ '^[0-9]{1,10}$' then return false; end if;
  return (p_metadata->>'size')::numeric between 1 and 25 * 1024 * 1024;
end;
$$;
revoke all on function public._daily_log_photo_metadata_valid(jsonb) from public, anon;
grant execute on function public._daily_log_photo_metadata_valid(jsonb) to authenticated, service_role;

revoke all on function public._is_daily_log_photo_name(text) from public, anon;
revoke all on function public._daily_log_photo_actor() from public, anon;
revoke all on function public._daily_log_photo_upload_allowed(text, text, jsonb) from public, anon;
grant execute on function public._is_daily_log_photo_name(text) to public;
grant execute on function public._daily_log_photo_actor() to authenticated, service_role;
grant execute on function public._daily_log_photo_upload_allowed(text, text, jsonb) to authenticated, service_role;

-- Restrictive policies AND with legacy permissive FOR ALL bucket policies.
-- Both sides of UPDATE are checked, so moving an ordinary object into the
-- namespace is no more allowed than moving a protected object out of it.
-- SELECT is intentionally unchanged; this is write/evidence protection.
drop policy if exists daily_log_photo_storage_insert on storage.objects;
create policy daily_log_photo_storage_insert on storage.objects as restrictive
  for insert to authenticated with check (
    bucket_id <> 'install-media' or not public._is_daily_log_photo_name(name)
    or public._daily_log_photo_upload_allowed(name, owner_id, metadata)
  );
drop policy if exists daily_log_photo_storage_update on storage.objects;
create policy daily_log_photo_storage_update on storage.objects as restrictive
  for update to authenticated
  using (bucket_id <> 'install-media' or not public._is_daily_log_photo_name(name))
  with check (bucket_id <> 'install-media' or not public._is_daily_log_photo_name(name));
drop policy if exists daily_log_photo_storage_delete on storage.objects;
create policy daily_log_photo_storage_delete on storage.objects as restrictive
  for delete to authenticated
  using (bucket_id <> 'install-media' or not public._is_daily_log_photo_name(name));

-- Storage authorizes a permission-only INSERT before uploading bytes, then
-- completes with a privileged upsert. Two concurrent upsert=true preflights
-- could both observe absence; restrictive RLS alone cannot stop the second
-- privileged completion from replacing the first committed object's version.
-- Freeze protected object rows as well. A failed replacement cannot delete the
-- original metadata through a generic privileged cleanup: only expired photo
-- trash (or an aged orphan) may be removed by the attachment owner/backend.
create or replace function public._daily_log_photo_storage_guard()
returns trigger language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  v_old_protected boolean := old.bucket_id = 'install-media'
    and public._is_daily_log_photo_name(old.name);
  v_new_protected boolean := false;
  v_attachment public.attachments;
  v_trusted boolean := current_user = pg_get_userbyid(
    (select relowner from pg_class where oid = 'public.attachments'::regclass))
    or current_user = 'service_role';
begin
  if tg_op = 'UPDATE' then
    v_new_protected := new.bucket_id = 'install-media' and public._is_daily_log_photo_name(new.name);
    if not v_old_protected and not v_new_protected then return new; end if;
    if (to_jsonb(new) - array['last_accessed_at','updated_at']) is distinct from
       (to_jsonb(old) - array['last_accessed_at','updated_at']) then
      raise exception 'A completed daily log upload cannot be replaced or moved.' using errcode = '42501';
    end if;
    return new;
  end if;
  if not v_old_protected then return old; end if;
  if v_trusted then
    -- Same path lock as association: an aged orphan cannot disappear between
    -- the uploader's object proof and its new attachment INSERT. Lock an
    -- existing attachment before rechecking expiry, so a concurrent restore
    -- cannot commit between the old sweep's object and attachment DELETEs.
    perform pg_advisory_xact_lock(hashtextextended('daily_log_photo:' || old.bucket_id || '/' || old.name, 0));
    select * into v_attachment from public.attachments
      where daily_log_id is not null and storage_path = old.bucket_id || '/' || old.name
      for update;
    if found then
      if v_attachment.deleted_at < now() - interval '30 days' then return old; end if;
    elsif old.created_at < now() - interval '30 days' and not exists (
        select 1 from public.attachments where storage_path = old.bucket_id || '/' || old.name
      ) then return old;
    end if;
  end if;
  raise exception 'Keep this daily log upload until its recoverable photo trash expires.' using errcode = '42501';
end;
$$;
revoke all on function public._daily_log_photo_storage_guard() from public, anon, authenticated;
drop trigger if exists daily_log_photo_storage_guard on storage.objects;
create trigger daily_log_photo_storage_guard before update or delete on storage.objects
  for each row execute function public._daily_log_photo_storage_guard();

create or replace function public._attachments_daily_log_guard()
returns trigger language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  -- A DEFINER trigger would erase this distinction. No request GUC is a bypass.
  v_trusted boolean := current_user = pg_get_userbyid((select relowner from pg_class where oid = tg_relid))
                       or current_user = 'service_role';
  v_old_protected boolean := false;
  v_new_protected boolean := false;
  v_path text;
  v_owner text;
  v_metadata jsonb;
  v_log_project uuid;
  v_row_changed boolean;
begin
  if tg_op <> 'INSERT' then
    v_old_protected := old.daily_log_id is not null or
      (split_part(old.storage_path, '/', 1) = 'install-media'
       and public._is_daily_log_photo_name(substr(old.storage_path, strpos(old.storage_path, '/') + 1)));
  end if;
  if tg_op <> 'DELETE' then
    v_new_protected := new.daily_log_id is not null or
      (split_part(new.storage_path, '/', 1) = 'install-media'
       and public._is_daily_log_photo_name(substr(new.storage_path, strpos(new.storage_path, '/') + 1)));
  end if;
  if not v_old_protected and not v_new_protected then return coalesce(new, old); end if;

  if tg_op = 'DELETE' then
    if v_trusted and old.daily_log_id is not null
       and old.deleted_at < now() - interval '30 days' then return old; end if;
    raise exception 'Remove this daily log photo through the recoverable photo trash.' using errcode = '42501';
  end if;
  if new.daily_log_id is null then
    raise exception 'A daily log upload must retain its daily log association.' using errcode = '42501';
  end if;

  if tg_op = 'UPDATE' then
    if old.daily_log_id is null then
      raise exception 'Attach a new photo; an existing photo cannot be claimed by a daily log.' using errcode = '42501';
    end if;
    -- All fields, including future columns, are immutable except the one
    -- ordinary editorial field and the exact named lifecycle transitions.
    v_row_changed := (to_jsonb(new) - array['caption','project_id','deleted_at','deleted_by'])
                     is distinct from
                     (to_jsonb(old) - array['caption','project_id','deleted_at','deleted_by']);
    if v_row_changed then
      raise exception 'A saved daily log photo cannot change identity.' using errcode = '42501';
    end if;

    if new.project_id is distinct from old.project_id then
      -- The final projects DELETE fires its existing FK SET NULL after the
      -- log has detached. At that point the project is already invisible to
      -- this transaction; an explicit earlier detach may still see its trash.
      select project_id into v_log_project from public.daily_logs where id = old.daily_log_id;
      if not found or not v_trusted or new.project_id is not null or old.project_id is null
         or v_log_project is not null
         or exists (select 1 from public.projects where id = old.project_id and deleted_at is null)
         or (auth.uid() is not null and (not public._daily_log_photo_actor() or not public._is_supervisor(auth.uid())))
         or (to_jsonb(new) - 'project_id') is distinct from (to_jsonb(old) - 'project_id') then
        raise exception 'This photo can only detach as part of an authorized job purge.' using errcode = '42501';
      end if;
      return new;
    end if;

    -- Preserve deleted_by's existing profile FK ON DELETE SET NULL. This is
    -- only a trusted referential cleanup after that profile actually vanished,
    -- not permission for a client to erase an audit actor.
    if v_trusted and old.deleted_by is not null and new.deleted_by is null
       and not exists (select 1 from public.profiles where id = old.deleted_by)
       and (to_jsonb(new) - 'deleted_by') is not distinct from (to_jsonb(old) - 'deleted_by') then
      return new;
    end if;

    if new.deleted_at is distinct from old.deleted_at or new.deleted_by is distinct from old.deleted_by then
      if not v_trusted or not public._daily_log_photo_actor() or not public._is_lead(auth.uid())
         or (to_jsonb(new) - array['deleted_at','deleted_by']) is distinct from
            (to_jsonb(old) - array['deleted_at','deleted_by']) then
        raise exception 'Use the authorized photo trash or restore action.' using errcode = '42501';
      end if;
      if old.deleted_at is null and new.deleted_at = now() and new.deleted_by = auth.uid() then return new; end if;
      if old.deleted_at is not null and now() < old.deleted_at + interval '30 days'
         and new.deleted_at is null and new.deleted_by is null then return new; end if;
      raise exception 'That photo trash or restore transition is not allowed.' using errcode = '42501';
    end if;

    -- An exact retry may not resurrect a removed photo. Its original row is
    -- still the confirmed result. Only an active original uploader may retry
    -- or edit a caption; the immutable UUID path remains valid after email changes.
    if not public._daily_log_photo_actor()
       or split_part(old.storage_path, '/', 5) is distinct from auth.uid()::text
       or (old.deleted_at is not null and new.caption is distinct from old.caption) then
      raise exception 'Only the active uploader may update this photo.' using errcode = '42501';
    end if;
    return new;
  end if;

  -- New association. No secondary anchor may broaden gallery access later.
  if not public._daily_log_photo_actor() or not public.is_my_upload_name(new.created_by)
     or new.kind is distinct from 'photo' or new.client_id is null
     or new.project_id is null or new.deleted_at is not null or new.deleted_by is not null
     or new.window_id is not null or new.install_event_id is not null
     or new.package_id is not null or new.project_opening_id is not null or new.service_case_id is not null then
    raise exception 'A daily log photo needs its active uploader, job, and original upload identity.' using errcode = '42501';
  end if;
  v_path := new.project_id::text || '/daily-logs/' || new.daily_log_id::text || '/'
            || auth.uid()::text || '/' || new.client_id::text || '.jpg';
  if new.storage_path is distinct from 'install-media/' || v_path then
    raise exception 'The upload path does not match this daily log and operation.' using errcode = '42501';
  end if;
  -- Validate and lock project before object/attachment work, matching purge's
  -- project-first order. A missing or foreign-owned object fails closed.
  if not public._daily_log_photo_upload_allowed(v_path, auth.uid()::text,
       '{"mimetype":"image/jpeg","size":1}'::jsonb) then
    raise exception 'Choose a live job and its matching daily log.' using errcode = '42501';
  end if;
  -- Serialize new association with aged-orphan deletion as well as retries.
  perform pg_advisory_xact_lock(hashtextextended('daily_log_photo:' || new.storage_path, 0));
  -- Serialize retries with the sweep BEFORE reading its immutable object.
  -- FOR KEY SHARE on storage.objects under this invoker would require its
  -- intentionally denied UPDATE policy. Objects cannot otherwise be changed
  -- by a client; protected deletion takes the same path and attachment locks.
  perform 1 from public.attachments where client_id = new.client_id for update;
  if exists (select 1 from public.attachments where client_id = new.client_id and deleted_at is not null) then
    raise exception 'This upload is already in photo trash; reconcile its existing row.' using errcode = '42501';
  end if;
  select owner_id, metadata into v_owner, v_metadata from storage.objects
    where bucket_id = 'install-media' and name = v_path;
  if not found or not public._daily_log_photo_upload_allowed(v_path, v_owner, v_metadata)
     or not public._daily_log_photo_metadata_valid(v_metadata) then
    raise exception 'Upload your original JPEG before attaching it to the daily log.' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public._attachments_daily_log_guard() from public, anon, authenticated;
drop trigger if exists attachments_daily_log_matches_job on public.attachments;
drop trigger if exists attachments_daily_log_guard on public.attachments;
drop function if exists public._attachments_daily_log_matches_job();
create trigger attachments_daily_log_guard before insert or update or delete on public.attachments
  for each row execute function public._attachments_daily_log_guard();

-- Existing photo trash/restore/sweep and the latest Workflow-aware job purge
-- retain their bodies and grants. The row guards enforce the new photo shape
-- and retain locks through those existing SECURITY DEFINER transactions.

comment on column public.attachments.daily_log_id is
  'Durable daily-log photo association. Original upload identity is immutable; job purge detaches project_id and retains this log/date/job-name history anchor.';
commit;
