-- Keep the photo namespace classifier private without breaking Storage's
-- SECURITY INVOKER row guard during privileged completion/timestamp updates.
-- Preserve all writable evidence fields; ignore generated values that PostgreSQL
-- has not recomputed yet in this BEFORE UPDATE trigger.
begin;
revoke execute on function public._is_daily_log_photo_name(text) from public, anon;
grant execute on function public._is_daily_log_photo_name(text)
  to authenticated, service_role, supabase_storage_admin;

create or replace function public._daily_log_photo_storage_guard()
returns trigger language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  v_old_protected boolean := old.bucket_id = 'install-media'
    and public._is_daily_log_photo_name(old.name);
  v_new_protected boolean := false;
  v_attachment public.attachments;
  v_ignored text[] := array['last_accessed_at', 'updated_at'];
  v_trusted boolean := current_user = pg_get_userbyid(
    (select relowner from pg_class where oid = 'public.attachments'::regclass))
    or current_user = 'service_role';
begin
  if tg_op = 'UPDATE' then
    -- PostgreSQL computes generated values AFTER BEFORE triggers. NEW's
    -- transient generated fields cannot establish a writable evidence change.
    -- Exclude only catalog-confirmed generated columns; every ordinary column
    -- (including future fields) remains immutable on a protected object.
    select v_ignored || coalesce(array_agg(attname::text), '{}'::text[])
      into v_ignored from pg_attribute
      where attrelid = tg_relid and attnum > 0 and not attisdropped
        and attgenerated <> '';
    v_new_protected := new.bucket_id = 'install-media' and public._is_daily_log_photo_name(new.name);
    if not v_old_protected and not v_new_protected then return new; end if;
    if (to_jsonb(new) - v_ignored) is distinct from
       (to_jsonb(old) - v_ignored) then
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
commit;
