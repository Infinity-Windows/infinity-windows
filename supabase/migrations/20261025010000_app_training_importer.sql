-- The "Using Forge" walkthrough IMPORTER (2026-09-23): a supervisor or owner,
-- signed in to the ordinary app, publishes reviewed walkthroughs without a
-- service key. docs/role-training-importer.md is the runbook; this file is the
-- lock, and it sits on top of 20261025000000 without loosening the catalog.
--
-- THE SHAPE. Three steps, each one checked here, never trusted from a browser:
--   1. RESERVE  app_training_import_reserve() validates one walkthrough's
--      metadata, allocates the next version under a per-walkthrough lock and
--      writes a STAGING row that names the exact object paths, byte counts and
--      types that are expected, bound to the caller and to an expiry.
--   2. UPLOAD   the browser's ordinary storage upload (upsert off). Storage
--      admits an INSERT into 'app-training' only at a path the caller has
--      reserved, unexpired, unpublished. Nothing can UPDATE or DELETE there.
--   3. PUBLISH  app_training_import_publish() re-checks the caller, then, in
--      ONE transaction and under the same locks, checks every reserved object
--      against what storage actually recorded (owner, bytes, type), switches
--      the old version off and the new one on. Any miss rolls back all of it:
--      the old walkthrough keeps playing.
--
-- WHO. The caller's REAL profile row, read here by auth.uid(): supervisor or
-- owner (and their legacy aliases), not a partner login, not switched off
-- (access_revoked_at), not Removed (retired_at). profiles.active = false is
-- "off today" (CONTEXT.md) and does NOT stop an owner at home importing. The
-- app's "view as role" preview hides the importer on screen; it is never asked
-- here and can never grant anything.
--
-- WHAT IS STILL IMPOSSIBLE from a browser, for every role: writing a catalog
-- row or a staging row directly, claiming 'live', choosing a path, landing a
-- file on a published path, replacing or deleting any object in the bucket,
-- reusing a version number, and publishing over a NEWER version somebody else
-- published in the meantime.

-- ---------------------------------------------------------------------------
-- 1. Who may import
-- ---------------------------------------------------------------------------
-- Not granted to anybody: it is a building block for the functions and the
-- storage policies below, all of which run it as its owner.
create or replace function public.app_training_importer_ok()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select auth.uid() is not null
    and exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and not coalesce(p.is_partner, false)
        and p.retired_at is null
        and p.access_revoked_at is null
        and p.role in ('supervisor', 'admin', 'owner', 'big_boss')
    );
$$;

revoke all on function public.app_training_importer_ok() from public, anon, authenticated;

-- One lock per walkthrough per language. Taken by reserve (version allocation)
-- and publish (the switch), so two tabs, two people or a retried request can
-- never hand out one version twice or interleave two switches.
create or replace function public.app_training_import_lock(p_slug text, p_language text)
returns void
language sql
volatile
set search_path = public, pg_temp
as $$
  select pg_advisory_xact_lock(hashtextextended('app_training_import:' || p_slug || ':' || p_language, 0));
$$;

revoke all on function public.app_training_import_lock(text, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Staging
-- ---------------------------------------------------------------------------
-- A reservation, not a catalog row. Crew never read it and no browser writes
-- it; the functions below are its only door. Rows are kept after publication
-- or cancellation as the record of who imported what, and because a cancelled
-- reservation's version number (and so its paths) must never be handed out
-- again — an object uploaded there cannot be deleted by a browser.
create table if not exists public.app_training_imports (
  id uuid primary key default gen_random_uuid(),
  -- The browser's retry key: the same person re-sending the same reservation
  -- gets the same row back instead of a second version.
  request_id uuid not null,
  -- Who reserved it. Nullable on purpose: a person with no work history is
  -- deleted outright (manage-crew-access; the profile goes with the auth user
  -- by ON DELETE CASCADE), and their reservation must then keep its version
  -- number and paths without keeping a dangling personal id. A NULL actor
  -- matches no auth.uid(), so such a row can never be uploaded to, published
  -- or cancelled again. Nothing here deletes reservations.
  actor_id uuid references public.profiles (id) on delete set null,
  slug text not null check (slug in ('installer', 'foreman', 'leadership')),
  min_role text not null,
  language text not null check (language in ('en', 'es')),
  -- Proposal only. A live walkthrough is not something this door can claim.
  content_status text not null default 'proposal' check (content_status = 'proposal'),
  version integer not null check (version between 1 and 999),
  title text not null check (length(btrim(title)) between 1 and 160),
  duration_seconds integer not null check (duration_seconds between 1 and 7200),
  chapters jsonb not null,
  transcript_text text not null check (length(btrim(transcript_text)) between 1 and 200000),
  -- Server-chosen names under <slug>/<language>/v<version>/.
  video_path text not null,
  video_bytes bigint not null check (video_bytes between 1 and 47185920),
  video_sha256 text not null check (video_sha256 ~ '^[0-9a-f]{64}$'),
  captions_path text not null,
  captions_bytes bigint not null check (captions_bytes between 1 and 1048576),
  captions_sha256 text not null check (captions_sha256 ~ '^[0-9a-f]{64}$'),
  poster_path text,
  poster_bytes bigint check (poster_bytes between 1 and 5242880),
  poster_mime text check (poster_mime in ('image/jpeg', 'image/png', 'image/webp')),
  poster_sha256 text check (poster_sha256 ~ '^[0-9a-f]{64}$'),
  state text not null default 'reserved' check (state in ('reserved', 'published', 'cancelled')),
  reserved_at timestamptz not null default now(),
  expires_at timestamptz not null,
  published_at timestamptz,
  cancelled_at timestamptz,
  constraint app_training_imports_floor_matches_slug check (
    (slug = 'installer' and min_role = 'installer')
    or (slug = 'foreman' and min_role = 'foreman')
    or (slug = 'leadership' and min_role = 'supervisor')
  ),
  constraint app_training_imports_poster_whole check (
    (poster_path is null and poster_bytes is null and poster_mime is null and poster_sha256 is null)
    or (poster_path is not null and poster_bytes is not null and poster_mime is not null and poster_sha256 is not null)
  ),
  constraint app_training_imports_chapters check (public.app_training_chapters_valid(chapters, duration_seconds)),
  constraint app_training_imports_version_once unique (slug, language, version),
  constraint app_training_imports_request_once unique (actor_id, request_id, slug, language)
);

alter table public.app_training_imports enable row level security;
revoke all on table public.app_training_imports from public, anon, authenticated;
grant select on table public.app_training_imports to service_role;

comment on table public.app_training_imports is
  'Staging for the supervisor/owner walkthrough importer: one reservation per version, bound to its actor, expiry and exact expected objects. No client grants; reached only through app_training_import_* functions. See docs/role-training-importer.md.';

-- ---------------------------------------------------------------------------
-- 3. The storage half: which exact object may this caller upload or see?
-- ---------------------------------------------------------------------------
-- A path the caller reserved, still reserved (not published, not cancelled),
-- unexpired, and named by no catalog row. Everything else in the bucket is
-- closed to a browser upload, including every published path.
create or replace function public.can_upload_app_training_object(p_name text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p_name is not null
    and public.app_training_importer_ok()
    and exists (
      select 1 from public.app_training_imports i
      where i.actor_id = auth.uid()
        and i.state = 'reserved'
        and i.expires_at > now()
        and p_name in (i.video_path, i.captions_path, i.poster_path)
    )
    and not exists (
      select 1 from public.app_training_videos v
      where p_name in (v.video_path, v.captions_path, v.poster_path)
    );
$$;

revoke all on function public.can_upload_app_training_object(text) from public, anon;
grant execute on function public.can_upload_app_training_object(text) to authenticated, service_role;

-- The uploader may see the objects of its OWN reservations (any state), which
-- storage needs in order to hand an upload's own row back to it. Nobody else
-- sees an unpublished object; crews still only see what can_read_* allows.
create or replace function public.can_see_staged_app_training_object(p_name text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p_name is not null
    and public.app_training_importer_ok()
    and exists (
      select 1 from public.app_training_imports i
      where i.actor_id = auth.uid()
        and p_name in (i.video_path, i.captions_path, i.poster_path)
    );
$$;

revoke all on function public.can_see_staged_app_training_object(text) from public, anon;
grant execute on function public.can_see_staged_app_training_object(text) to authenticated, service_role;

-- INSERT: the base file's single flat wall (anon + authenticated) is split in
-- two. anon keeps a flat wall with no function in it (anon cannot execute one,
-- and every anonymous upload to every OTHER bucket would start failing).
-- authenticated gets the reserved-path exception, and nothing wider.
drop policy if exists app_training_no_client_insert on storage.objects;
drop policy if exists app_training_no_anon_insert on storage.objects;
create policy app_training_no_anon_insert on storage.objects
  as restrictive for insert to anon
  with check (bucket_id <> 'app-training');

drop policy if exists app_training_insert_boundary on storage.objects;
create policy app_training_insert_boundary on storage.objects
  as restrictive for insert to authenticated
  with check (bucket_id <> 'app-training' or public.can_upload_app_training_object(name));

-- Restrictive policies only ever narrow; something permissive has to say yes.
drop policy if exists app_training_import_upload on storage.objects;
create policy app_training_import_upload on storage.objects
  for insert to authenticated
  with check (bucket_id = 'app-training' and public.can_upload_app_training_object(name));

-- SELECT: the read wall gains the uploader's own staged objects. Storage
-- inserts with RETURNING, and a row the inserter may not see fails the insert.
drop policy if exists app_training_read_boundary on storage.objects;
create policy app_training_read_boundary on storage.objects
  as restrictive for select to authenticated
  using (
    bucket_id <> 'app-training'
    or (not public.is_partner_user() and (
      public.can_read_app_training_object(name)
      or public.can_see_staged_app_training_object(name)
    ))
  );

drop policy if exists app_training_staged_read on storage.objects;
create policy app_training_staged_read on storage.objects
  for select to authenticated
  using (bucket_id = 'app-training' and not public.is_partner_user() and public.can_see_staged_app_training_object(name));

-- UPDATE and DELETE walls (app_training_no_client_update / _delete) are the
-- base file's and are not touched: no browser replaces or removes an object,
-- so `upsert: true` fails and a published file's bytes never change.

-- The bucket is the base file's; if it already existed with other settings,
-- insert ... on conflict do nothing would have left them. Pin it private and
-- narrow again here so the importer's promises hold regardless.
--
-- 45 MiB, not the base file's 200 MB. The upload policy knows the PATH a
-- caller reserved but not the size storage will record (storage's permission
-- probe inserts before the bytes exist, so a metadata check in the policy
-- would refuse every honest upload). The bucket ceiling is the byte bound at
-- upload time; publication then requires the exact reserved size. Nothing
-- this bucket holds is larger: videos are capped at 45 MiB everywhere.
update storage.buckets
   set public = false,
       file_size_limit = 47185920,
       allowed_mime_types = array['video/mp4', 'text/vtt', 'image/jpeg', 'image/png', 'image/webp']
 where id = 'app-training'
   and (public is distinct from false
        or file_size_limit is distinct from 47185920
        or allowed_mime_types is distinct from array['video/mp4', 'text/vtt', 'image/jpeg', 'image/png', 'image/webp']);

-- ---------------------------------------------------------------------------
-- 4. Strict JSON readers (missing and null are refusals, never "unknown")
-- ---------------------------------------------------------------------------
-- `jsonb_typeof(x->'k') <> 'string'` is NULL when k is absent, and an IF on
-- NULL does not fire — which is how a missing field slips through a check.
-- Every test below is IS DISTINCT FROM, so absence is a mismatch.
create or replace function public.app_training_import_int(p_obj jsonb, p_key text, p_min numeric, p_max numeric)
returns integer
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v numeric;
begin
  if jsonb_typeof(p_obj -> p_key) is distinct from 'number' then
    raise exception 'The walkthrough''s % is missing or not a number.', p_key using errcode = '22023', hint = 'invalid_' || p_key;
  end if;
  v := (p_obj ->> p_key)::numeric;
  if v <> trunc(v) or v < p_min or v > p_max then
    raise exception 'The walkthrough''s % is out of range.', p_key using errcode = '22023', hint = 'invalid_' || p_key;
  end if;
  return v::integer;
end;
$$;

create or replace function public.app_training_import_text(p_obj jsonb, p_key text, p_max integer)
returns text
language plpgsql
immutable
set search_path = public, pg_temp
as $$
begin
  if jsonb_typeof(p_obj -> p_key) is distinct from 'string'
     or length(btrim(p_obj ->> p_key)) not between 1 and p_max then
    raise exception 'The walkthrough''s % is missing or too long.', p_key using errcode = '22023', hint = 'invalid_' || p_key;
  end if;
  return p_obj ->> p_key;
end;
$$;

-- One file description: {bytes, sha256[, mime]}.
create or replace function public.app_training_import_asset(p_obj jsonb, p_key text, p_max_bytes bigint, p_mimes text[])
returns jsonb
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v jsonb := p_obj -> p_key;
  v_bytes numeric;
begin
  if jsonb_typeof(v) is distinct from 'object' then
    raise exception 'The % file description is incomplete.', p_key using errcode = '22023', hint = 'invalid_' || p_key;
  end if;
  if exists (select 1 from jsonb_object_keys(v) k where k not in ('bytes', 'sha256', 'mime'))
     or jsonb_typeof(v -> 'bytes') is distinct from 'number'
     or jsonb_typeof(v -> 'sha256') is distinct from 'string'
     or jsonb_typeof(v -> 'mime') is distinct from 'string' then
    raise exception 'The % file description is incomplete.', p_key using errcode = '22023', hint = 'invalid_' || p_key;
  end if;
  v_bytes := (v ->> 'bytes')::numeric;
  if v_bytes <> trunc(v_bytes) or v_bytes < 1 or v_bytes > p_max_bytes then
    raise exception 'The % file is empty or too large.', p_key using errcode = '22023', hint = 'too_large_' || p_key;
  end if;
  if (v ->> 'sha256') !~ '^[0-9a-f]{64}$' then
    raise exception 'The % file fingerprint is malformed.', p_key using errcode = '22023', hint = 'invalid_' || p_key;
  end if;
  if not ((v ->> 'mime') = any (p_mimes)) then
    raise exception 'The % file type is not allowed.', p_key using errcode = '22023', hint = 'invalid_' || p_key;
  end if;
  return jsonb_build_object('bytes', v_bytes::bigint, 'sha256', v ->> 'sha256', 'mime', v ->> 'mime');
end;
$$;

-- The base validator's rules, but with every field REQUIRED and typed and no
-- extra keys: a chapter with no time or no title is refused here even on a
-- database where app_training_chapters_valid() still reads absence as NULL.
create or replace function public.app_training_import_chapters_ok(p_chapters jsonb, p_duration integer)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select jsonb_typeof(p_chapters) is not distinct from 'array'
    and not exists (
      select 1 from jsonb_array_elements(p_chapters) c
      where case
        when jsonb_typeof(c) is distinct from 'object' then true
        else jsonb_typeof(c -> 'seconds') is distinct from 'number'
          or jsonb_typeof(c -> 'title') is distinct from 'string'
          or jsonb_typeof(c -> 'status') is distinct from 'string'
          or exists (select 1 from jsonb_object_keys(c) k where k not in ('seconds', 'title', 'status'))
      end
    )
    and coalesce(public.app_training_chapters_valid(p_chapters, p_duration), false);
$$;

revoke all on function public.app_training_import_chapters_ok(jsonb, integer) from public, anon;
grant execute on function public.app_training_import_chapters_ok(jsonb, integer) to authenticated, service_role;

revoke all on function public.app_training_import_int(jsonb, text, numeric, numeric) from public, anon, authenticated;
revoke all on function public.app_training_import_text(jsonb, text, integer) from public, anon, authenticated;
revoke all on function public.app_training_import_asset(jsonb, text, bigint, text[]) from public, anon, authenticated;

-- What a browser is told about a reservation. Paths are the server's.
create or replace function public.app_training_import_json(i public.app_training_imports)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'id', i.id, 'requestId', i.request_id, 'slug', i.slug, 'language', i.language,
    'version', i.version, 'state', i.state, 'expiresAt', i.expires_at,
    'publishedAt', i.published_at,
    'assets', jsonb_build_array(
      jsonb_build_object('kind', 'video', 'path', i.video_path, 'bytes', i.video_bytes, 'mime', 'video/mp4'),
      jsonb_build_object('kind', 'captions', 'path', i.captions_path, 'bytes', i.captions_bytes, 'mime', 'text/vtt')
    ) || case when i.poster_path is null then '[]'::jsonb else jsonb_build_array(
      jsonb_build_object('kind', 'poster', 'path', i.poster_path, 'bytes', i.poster_bytes, 'mime', i.poster_mime)
    ) end
  );
$$;

revoke all on function public.app_training_import_json(public.app_training_imports) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. RESERVE
-- ---------------------------------------------------------------------------
-- p_entry: {slug, minRole, language, contentStatus:'proposal', title,
--   durationSeconds, chapters, transcriptText, version|null,
--   video:{bytes,sha256,mime:'video/mp4'}, captions:{bytes,sha256,mime:'text/vtt'},
--   poster:{bytes,sha256,mime}|null}
-- Unknown keys are refused: a field this function does not read is a field
-- somebody hoped would be read somewhere else.
create or replace function public.app_training_import_reserve(p_request_id uuid, p_entry jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_slug text;
  v_min_role text;
  v_language text;
  v_title text;
  v_duration integer;
  v_version integer;
  v_requested integer;
  v_transcript text;
  v_video jsonb;
  v_captions jsonb;
  v_poster jsonb;
  v_prefix text;
  v_row public.app_training_imports;
begin
  if not public.app_training_importer_ok() then
    raise exception 'Only a supervisor or owner can publish walkthroughs.' using errcode = '42501', hint = 'not_allowed';
  end if;
  if p_request_id is null or jsonb_typeof(p_entry) is distinct from 'object' then
    raise exception 'The walkthrough description is missing.' using errcode = '22023', hint = 'invalid_entry';
  end if;
  if exists (
    select 1 from jsonb_object_keys(p_entry) k
    where k not in ('slug', 'minRole', 'language', 'contentStatus', 'title', 'durationSeconds',
                    'chapters', 'transcriptText', 'version', 'video', 'captions', 'poster')
  ) then
    raise exception 'The walkthrough description has fields this importer does not accept.' using errcode = '22023', hint = 'invalid_entry';
  end if;

  v_slug := public.app_training_import_text(p_entry, 'slug', 20);
  v_min_role := public.app_training_import_text(p_entry, 'minRole', 20);
  if (v_slug, v_min_role) not in (('installer', 'installer'), ('foreman', 'foreman'), ('leadership', 'supervisor')) then
    raise exception 'That walkthrough and role floor do not belong together.' using errcode = '22023', hint = 'invalid_slug';
  end if;
  v_language := public.app_training_import_text(p_entry, 'language', 5);
  if v_language not in ('en', 'es') then
    raise exception 'Unknown narration language.' using errcode = '22023', hint = 'invalid_language';
  end if;
  if (p_entry ->> 'contentStatus') is distinct from 'proposal'
     or jsonb_typeof(p_entry -> 'contentStatus') is distinct from 'string' then
    raise exception 'The importer only publishes design previews (contentStatus "proposal").' using errcode = '22023', hint = 'invalid_contentStatus';
  end if;
  v_title := btrim(public.app_training_import_text(p_entry, 'title', 160));
  v_duration := public.app_training_import_int(p_entry, 'durationSeconds', 1, 7200);
  v_transcript := public.app_training_import_text(p_entry, 'transcriptText', 200000);
  if not public.app_training_import_chapters_ok(p_entry -> 'chapters', v_duration) then
    raise exception 'The chapter list is not valid for this video.' using errcode = '22023', hint = 'invalid_chapters';
  end if;
  if jsonb_typeof(p_entry -> 'version') is distinct from 'null' then
    v_requested := public.app_training_import_int(p_entry, 'version', 1, 999);
  end if;
  v_video := public.app_training_import_asset(p_entry, 'video', 47185920, array['video/mp4']);
  v_captions := public.app_training_import_asset(p_entry, 'captions', 1048576, array['text/vtt']);
  if jsonb_typeof(p_entry -> 'poster') is distinct from 'null' then
    v_poster := public.app_training_import_asset(p_entry, 'poster', 5242880, array['image/jpeg', 'image/png', 'image/webp']);
  end if;

  perform public.app_training_import_lock(v_slug, v_language);

  -- The same request again (a lost answer, a retry): hand back the same
  -- reservation if, and only if, it describes exactly the same thing.
  select * into v_row from public.app_training_imports i
   where i.actor_id = v_actor and i.request_id = p_request_id
     and i.slug = v_slug and i.language = v_language;
  if found then
    if (v_row.title, v_row.duration_seconds, v_row.chapters, v_row.transcript_text,
        v_row.video_bytes, v_row.video_sha256, v_row.captions_bytes, v_row.captions_sha256,
        v_row.poster_bytes, v_row.poster_sha256, v_row.poster_mime)
       is distinct from
       (v_title, v_duration, p_entry -> 'chapters', v_transcript,
        (v_video ->> 'bytes')::bigint, v_video ->> 'sha256',
        (v_captions ->> 'bytes')::bigint, v_captions ->> 'sha256',
        (v_poster ->> 'bytes')::bigint, v_poster ->> 'sha256', v_poster ->> 'mime')
       or (v_requested is not null and v_requested <> v_row.version) then
      raise exception 'These files differ from the ones this import started with. Start a new import.' using errcode = '22023', hint = 'request_changed';
    end if;
    return public.app_training_import_json(v_row);
  end if;

  -- Next version: past every catalog version AND every reservation, cancelled
  -- ones included, so no path is ever used twice.
  select greatest(
           coalesce((select max(v.version) from public.app_training_videos v where v.slug = v_slug and v.language = v_language), 0),
           coalesce((select max(i.version) from public.app_training_imports i where i.slug = v_slug and i.language = v_language), 0)
         ) + 1
    into v_version;
  if v_requested is not null then
    if v_requested < v_version then
      raise exception 'Version % of this walkthrough already exists. Leave the version out, or use a higher one.', v_requested
        using errcode = '23505', hint = 'version_taken';
    end if;
    v_version := v_requested;
  end if;
  if v_version > 999 then
    raise exception 'This walkthrough has run out of version numbers.' using errcode = '22023', hint = 'invalid_version';
  end if;

  v_prefix := v_slug || '/' || v_language || '/v' || v_version::text || '/';
  insert into public.app_training_imports (
    request_id, actor_id, slug, min_role, language, version, title, duration_seconds,
    chapters, transcript_text,
    video_path, video_bytes, video_sha256,
    captions_path, captions_bytes, captions_sha256,
    poster_path, poster_bytes, poster_mime, poster_sha256,
    expires_at
  ) values (
    p_request_id, v_actor, v_slug, v_min_role, v_language, v_version, v_title, v_duration,
    p_entry -> 'chapters', v_transcript,
    v_prefix || 'walkthrough.mp4', (v_video ->> 'bytes')::bigint, v_video ->> 'sha256',
    v_prefix || 'captions.vtt', (v_captions ->> 'bytes')::bigint, v_captions ->> 'sha256',
    case when v_poster is null then null else v_prefix || 'poster.' ||
      case v_poster ->> 'mime' when 'image/jpeg' then 'jpg' when 'image/png' then 'png' else 'webp' end end,
    (v_poster ->> 'bytes')::bigint, v_poster ->> 'mime', v_poster ->> 'sha256',
    now() + interval '6 hours'
  )
  returning * into v_row;
  return public.app_training_import_json(v_row);
end;
$$;

revoke all on function public.app_training_import_reserve(uuid, jsonb) from public, anon;
grant execute on function public.app_training_import_reserve(uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. STATUS — what storage actually holds for the caller's reservations
-- ---------------------------------------------------------------------------
-- The browser uses this to skip a file that already landed (a retry after a
-- lost answer) and to tell a 409 "already exists" that is its own upload from
-- one that is not. Only the caller's own reservations; others read as absent.
create or replace function public.app_training_import_status(p_ids uuid[])
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_out jsonb := '[]'::jsonb;
  v_row public.app_training_imports;
  v_json jsonb;
  v_assets jsonb;
begin
  if not public.app_training_importer_ok() then
    raise exception 'Only a supervisor or owner can publish walkthroughs.' using errcode = '42501', hint = 'not_allowed';
  end if;
  if p_ids is null or cardinality(p_ids) not between 1 and 3 then
    raise exception 'Ask about one to three imports at a time.' using errcode = '22023', hint = 'invalid_entry';
  end if;
  for v_row in
    select * from public.app_training_imports i
     where i.id = any (p_ids) and i.actor_id = auth.uid()
     order by i.slug
  loop
    v_json := public.app_training_import_json(v_row);
    select coalesce(jsonb_agg(
             a || jsonb_build_object(
               'present', o.name is not null,
               'ownedByYou', o.name is not null and coalesce(o.owner_id, o.owner::text) = auth.uid()::text,
               'storedBytes', case when (o.metadata ->> 'size') ~ '^[0-9]{1,15}$' then (o.metadata ->> 'size')::bigint end,
               'storedMime', o.metadata ->> 'mimetype'
             ) order by ord), '[]'::jsonb)
      into v_assets
      from jsonb_array_elements(v_json -> 'assets') with ordinality as e(a, ord)
      left join storage.objects o on o.bucket_id = 'app-training' and o.name = a ->> 'path';
    v_out := v_out || jsonb_build_array(jsonb_set(v_json, '{assets}', v_assets)
      || jsonb_build_object('expired', v_row.state = 'reserved' and v_row.expires_at <= now()));
  end loop;
  return v_out;
end;
$$;

revoke all on function public.app_training_import_status(uuid[]) from public, anon;
grant execute on function public.app_training_import_status(uuid[]) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. CANCEL — only the caller's own, only while still reserved
-- ---------------------------------------------------------------------------
-- Closes the upload door for that reservation. Touches no object and no
-- catalog row: anything already uploaded stays where it is, unreadable to
-- crews, and its version number is never reused.
create or replace function public.app_training_import_cancel(p_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.app_training_imports;
begin
  if not public.app_training_importer_ok() then
    raise exception 'Only a supervisor or owner can publish walkthroughs.' using errcode = '42501', hint = 'not_allowed';
  end if;
  update public.app_training_imports i
     set state = 'cancelled', cancelled_at = now()
   where i.id = p_id and i.actor_id = auth.uid() and i.state = 'reserved'
  returning * into v_row;
  if not found then
    select * into v_row from public.app_training_imports i where i.id = p_id and i.actor_id = auth.uid();
    if not found then
      raise exception 'That import was not found.' using errcode = 'P0002', hint = 'not_found';
    end if;
  end if;
  return public.app_training_import_json(v_row);
end;
$$;

revoke all on function public.app_training_import_cancel(uuid) from public, anon;
grant execute on function public.app_training_import_cancel(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 8. PUBLISH — all or nothing, one to three walkthroughs
-- ---------------------------------------------------------------------------
-- Idempotent: an import this caller already published answers with its
-- catalog row (the catalog id IS the import id) and is not published twice.
-- Refuses, changing nothing, when any reservation is not the caller's, is
-- cancelled or expired, is missing an object, has an object whose owner,
-- byte count or type differs from the reservation, or is older than the
-- version already live (somebody published a newer one meanwhile).
create or replace function public.app_training_import_publish(p_ids uuid[])
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_row public.app_training_imports;
  v_asset jsonb;
  v_obj record;
  v_active record;
  v_out jsonb := '[]'::jsonb;
  v_count integer;
begin
  if not public.app_training_importer_ok() then
    raise exception 'Only a supervisor or owner can publish walkthroughs.' using errcode = '42501', hint = 'not_allowed';
  end if;
  if p_ids is null or cardinality(p_ids) not between 1 and 3
     or (select count(distinct x) from unnest(p_ids) x) <> cardinality(p_ids)
     or array_position(p_ids, null) is not null then
    raise exception 'Publish one to three different imports at a time.' using errcode = '22023', hint = 'invalid_entry';
  end if;
  select count(*) into v_count from public.app_training_imports i
   where i.id = any (p_ids) and i.actor_id = v_actor;
  if v_count <> cardinality(p_ids) then
    raise exception 'That import was not found.' using errcode = 'P0002', hint = 'not_found';
  end if;
  if (select count(distinct (i.slug, i.language)) from public.app_training_imports i where i.id = any (p_ids)) <> cardinality(p_ids) then
    raise exception 'Two imports of the same walkthrough cannot be published together.' using errcode = '22023', hint = 'invalid_entry';
  end if;

  -- Locks in a fixed order, so two batches can never deadlock each other.
  perform public.app_training_import_lock(i.slug, i.language)
     from public.app_training_imports i
    where i.id = any (p_ids)
    order by i.slug, i.language;

  for v_row in
    select * from public.app_training_imports i
     where i.id = any (p_ids)
     order by i.slug, i.language
     for update
  loop
    if v_row.state = 'published' then
      -- Already done by this caller: report the row, change nothing.
      select v.id, v.slug, v.language, v.version, v.active into v_active
        from public.app_training_videos v where v.id = v_row.id;
      if not found then
        raise exception 'This import is marked published but its catalog row is missing.' using errcode = 'P0002', hint = 'not_found';
      end if;
      v_out := v_out || jsonb_build_array(jsonb_build_object(
        'id', v_row.id, 'slug', v_row.slug, 'language', v_row.language, 'version', v_row.version,
        'active', v_active.active, 'alreadyPublished', true));
      continue;
    end if;
    if v_row.state = 'cancelled' then
      raise exception 'This import was cancelled. Start a new one.' using errcode = '22023', hint = 'cancelled';
    end if;
    if v_row.expires_at <= now() then
      raise exception 'This import expired before it was published. Start a new one.' using errcode = '22023', hint = 'expired';
    end if;

    -- Every expected object, exactly as storage recorded it.
    for v_asset in select value from jsonb_array_elements(public.app_training_import_json(v_row) -> 'assets') loop
      select o.owner_id, o.owner, o.metadata into v_obj
        from storage.objects o
       where o.bucket_id = 'app-training' and o.name = v_asset ->> 'path';
      if not found then
        raise exception 'A file for the % walkthrough has not finished uploading.', v_row.slug
          using errcode = '22023', hint = 'missing_' || (v_asset ->> 'kind');
      end if;
      if coalesce(v_obj.owner_id, v_obj.owner::text) is distinct from v_actor::text
         or (v_obj.metadata ->> 'size') is distinct from (v_asset ->> 'bytes')
         or (v_obj.metadata ->> 'mimetype') is distinct from (v_asset ->> 'mime') then
        raise exception 'A file for the % walkthrough does not match what was reserved.', v_row.slug
          using errcode = '22023', hint = 'mismatch_' || (v_asset ->> 'kind');
      end if;
    end loop;

    -- Never publish over a newer version (a stale tab, a second importer).
    select v.id, v.version into v_active
      from public.app_training_videos v
     where v.slug = v_row.slug and v.language = v_row.language and v.active
     for update;
    if found and v_active.version > v_row.version then
      raise exception 'A newer version of the % walkthrough is already published.', v_row.slug
        using errcode = '22023', hint = 'newer_published';
    end if;

    update public.app_training_videos v
       set active = false
     where v.slug = v_row.slug and v.language = v_row.language and v.active;

    insert into public.app_training_videos (
      id, slug, title, min_role, language, content_status, version, duration_seconds,
      video_path, captions_path, poster_path, transcript_text, chapters, published_at, active
    ) values (
      v_row.id, v_row.slug, v_row.title, v_row.min_role, v_row.language, 'proposal', v_row.version,
      v_row.duration_seconds, v_row.video_path, v_row.captions_path, v_row.poster_path,
      v_row.transcript_text, v_row.chapters, now(), true
    );

    update public.app_training_imports i
       set state = 'published', published_at = now()
     where i.id = v_row.id;

    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'id', v_row.id, 'slug', v_row.slug, 'language', v_row.language, 'version', v_row.version,
      'active', true, 'alreadyPublished', false));
  end loop;
  return v_out;
end;
$$;

revoke all on function public.app_training_import_publish(uuid[]) from public, anon;
grant execute on function public.app_training_import_publish(uuid[]) to authenticated;
