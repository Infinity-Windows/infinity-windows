-- "Using Forge" walkthrough videos (2026-09-23): narrated app-design previews,
-- one per role floor, shown inside Learn. docs/role-training-videos.md is the
-- runbook; this file is the lock.
--
-- WHY A NEW TABLE AND A NEW BUCKET, not rows in learning_videos. Those are
-- lessons: they carry quizzes, clearances, points and learning time, and their
-- policies were tuned for that (20260984000000). A walkthrough of PROPOSED
-- screens must never be any of those things — watching one is not study time,
-- not a passed quiz, and not an approved way of working. Keeping it in its own
-- table means no existing learning policy is touched and no learning report can
-- pick one up by accident.
--
-- WHO SEES WHAT. The installer walkthrough is for installer and up, the foreman
-- one for foreman and up, the leadership one for supervisor and owner. The
-- decision is made from the caller's REAL profile row, never from the app's
-- "view as role" preview (that lives in the browser and narrows the list
-- further on the screen, but it can only ever hide, not grant). Denied outright:
-- anonymous callers, partner (builder) logins, switched-off logins
-- (access_revoked_at) and Removed ones (retired_at), and any role this file does
-- not know. NOT denied: profiles.active = false, which means "off site today"
-- (CONTEXT.md, Removed) — somebody at home can still watch.
--
-- BOTH DOORS CHECK. The catalog row and the storage object are each gated
-- server-side by the same function, so a guessed object path, an object that
-- was uploaded but never published, or an older version that has been retired
-- all read as "not found" to a crew login. createSignedUrl goes through the
-- same storage SELECT policy, so a phone can only mint a link for an object it
-- is allowed to read; the link itself is then a bearer token until it expires
-- (one hour, set in app/src/lib/appTraining.ts) — see the runbook.
--
-- WRITES. This migration grants no browser write at all. Publication is the
-- supervisor/owner importer's job (its own migration, which reserves exact
-- paths and switches versions in one transaction);
-- scripts/publish-role-walkthroughs.mjs only validates a package. Published rows are
-- immutable except for being switched off; a correction is a new version with
-- new object paths, so the thing somebody watched yesterday is still exactly
-- what the catalog says it was.
--
-- NO BUSINESS DATA IN HERE. Titles, transcripts and chapters arrive with the
-- publisher from a reviewed manifest, never as literals in a migration.

-- ---------------------------------------------------------------------------
-- 1. Chapters: one validator, used by the table's check
-- ---------------------------------------------------------------------------
-- A chapter list the player can trust without re-checking: an array of 1–60
-- objects, the first at 0 s, strictly increasing, every one inside the video,
-- each with a short title and one of three honest statuses.
create or replace function public.app_training_chapters_valid(p_chapters jsonb, p_duration integer)
returns boolean
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_item jsonb;
  v_prev numeric := -1;
  v_sec numeric;
  v_title text;
  v_i integer := 0;
begin
  if p_chapters is null or jsonb_typeof(p_chapters) <> 'array' then return false; end if;
  if jsonb_array_length(p_chapters) not between 1 and 60 then return false; end if;
  if p_duration is null or p_duration < 1 then return false; end if;
  for v_item in select value from jsonb_array_elements(p_chapters) loop
    if jsonb_typeof(v_item) <> 'object' then return false; end if;
    if jsonb_typeof(v_item->'seconds') is distinct from 'number' then return false; end if;
    if jsonb_typeof(v_item->'title') is distinct from 'string' then return false; end if;
    v_sec := (v_item->>'seconds')::numeric;
    v_title := btrim(v_item->>'title');
    if v_sec <> trunc(v_sec) then return false; end if;
    if v_i = 0 and v_sec <> 0 then return false; end if;
    if v_sec <= v_prev or v_sec >= p_duration then return false; end if;
    if length(v_title) not between 1 and 120 then return false; end if;
    if coalesce(v_item->>'status', '') not in ('proposal', 'live', 'mixed') then return false; end if;
    v_prev := v_sec;
    v_i := v_i + 1;
  end loop;
  return true;
end;
$$;

revoke all on function public.app_training_chapters_valid(jsonb, integer) from public, anon;
grant execute on function public.app_training_chapters_valid(jsonb, integer) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. The catalog
-- ---------------------------------------------------------------------------
create table if not exists public.app_training_videos (
  id uuid primary key default gen_random_uuid(),
  slug text not null check (slug in ('installer', 'foreman', 'leadership')),
  title text not null check (length(btrim(title)) between 1 and 160),
  -- The floor, stated rather than derived, and pinned to its slug below so a
  -- typo in a manifest cannot hand the leadership walkthrough to installers.
  min_role text not null check (min_role in ('installer', 'foreman', 'supervisor')),
  -- The narration's language. Captions and transcript are the same language;
  -- the app's interface around them is translated separately.
  language text not null check (language in ('en', 'es')),
  -- 'proposal' is everything this release ships. The app shows the design
  -- preview warning for anything that is not literally 'live'.
  content_status text not null check (content_status in ('proposal', 'live')),
  version integer not null check (version between 1 and 999),
  duration_seconds integer not null check (duration_seconds between 1 and 7200),
  -- Object names inside the private 'app-training' bucket. Always under
  -- <slug>/<language>/v<version>/, so a new version can never land on top of an
  -- old one's files and a row can never point at another walkthrough's media.
  video_path text not null,
  captions_path text,
  poster_path text,
  transcript_text text check (transcript_text is null or length(transcript_text) <= 200000),
  chapters jsonb not null,
  published_at timestamptz,
  active boolean not null default false,
  created_at timestamptz not null default now(),
  constraint app_training_videos_floor_matches_slug check (
    (slug = 'installer' and min_role = 'installer')
    or (slug = 'foreman' and min_role = 'foreman')
    or (slug = 'leadership' and min_role = 'supervisor')
  ),
  constraint app_training_videos_video_path check (
    video_path ~ ('^' || slug || '/' || language || '/v' || version::text || '/[a-z0-9][a-z0-9._-]{0,119}\.mp4$')
  ),
  constraint app_training_videos_captions_path check (
    captions_path is null
    or captions_path ~ ('^' || slug || '/' || language || '/v' || version::text || '/[a-z0-9][a-z0-9._-]{0,119}\.vtt$')
  ),
  constraint app_training_videos_poster_path check (
    poster_path is null
    or poster_path ~ ('^' || slug || '/' || language || '/v' || version::text || '/[a-z0-9][a-z0-9._-]{0,119}\.(jpg|jpeg|png|webp)$')
  ),
  constraint app_training_videos_chapters check (public.app_training_chapters_valid(chapters, duration_seconds)),
  constraint app_training_videos_active_is_published check (not active or published_at is not null),
  constraint app_training_videos_version_once unique (slug, language, version)
);

-- One live copy of each walkthrough per language. Publishing v2 switches v1 off
-- first (the publisher does it in that order).
create unique index if not exists app_training_videos_one_active
  on public.app_training_videos (slug, language) where active;

comment on table public.app_training_videos is
  'Using Forge walkthrough videos: narrated DESIGN PREVIEWS per role floor (installer / foreman / leadership). Not lessons: no quiz, clearance, points or learning time. No direct client writes; published through the supervisor/owner importer functions; read by crew roles at or above min_role (real profile role, not view-as). See docs/role-training-videos.md.';

-- ---------------------------------------------------------------------------
-- 3. Published rows do not change
-- ---------------------------------------------------------------------------
-- Even the service key goes through a trigger. The only edits a row accepts are
-- switching it on or off and stamping published_at once; a published row is
-- never deleted, only switched off, so "what did that video say" always has
-- an answer.
create or replace function public.app_training_videos_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    if old.published_at is not null then
      raise exception 'A published walkthrough is never deleted. Switch it off (active = false) instead.';
    end if;
    return old;
  end if;
  if (new.id, new.slug, new.title, new.min_role, new.language, new.content_status,
      new.version, new.duration_seconds, new.video_path, new.captions_path,
      new.poster_path, new.transcript_text, new.chapters, new.created_at)
     is distinct from
     (old.id, old.slug, old.title, old.min_role, old.language, old.content_status,
      old.version, old.duration_seconds, old.video_path, old.captions_path,
      old.poster_path, old.transcript_text, old.chapters, old.created_at) then
    raise exception 'Walkthrough rows are immutable. Publish a new version instead.';
  end if;
  if old.published_at is not null and new.published_at is distinct from old.published_at then
    raise exception 'published_at is stamped once.';
  end if;
  return new;
end;
$$;

revoke all on function public.app_training_videos_guard() from public, anon, authenticated;

drop trigger if exists app_training_videos_guard on public.app_training_videos;
create trigger app_training_videos_guard
  before update or delete on public.app_training_videos
  for each row execute function public.app_training_videos_guard();

-- ---------------------------------------------------------------------------
-- 4. Who may watch
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER for the same reason as can_read_app_update (20261021000000):
-- it reads the caller's own profile flags, which a policy on another table
-- cannot see through the caller's column grants. Returns only a boolean about
-- the caller. Unknown roles are refused here even though role_rank() would
-- floor them to installer — a login whose role this app does not recognise is
-- not somebody to show internal previews to.
create or replace function public.can_watch_app_training(p_min_role text)
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
        and p.role in ('installer', 'foreman', 'lead', 'supervisor', 'admin', 'owner', 'big_boss')
        and public.role_rank(p.role) >= case p_min_role
          when 'installer' then 0
          when 'foreman' then 1
          when 'supervisor' then 2
          else 99
        end
    );
$$;

revoke all on function public.can_watch_app_training(text) from public, anon;
grant execute on function public.can_watch_app_training(text) to authenticated, service_role;

-- The storage half of the same question: is this exact object name one of the
-- files of a published, switched-on walkthrough this caller may watch? A name
-- that is not in the catalog — a guess, an upload awaiting publication, a
-- retired version — is false.
create or replace function public.can_read_app_training_object(p_name text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p_name is not null
    and exists (
      select 1 from public.app_training_videos v
      where v.active
        and v.published_at is not null
        and v.published_at <= now()
        and p_name in (v.video_path, v.captions_path, v.poster_path)
        and public.can_watch_app_training(v.min_role)
    );
$$;

revoke all on function public.can_read_app_training_object(text) from public, anon;
grant execute on function public.can_read_app_training_object(text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. Catalog grants and policy
-- ---------------------------------------------------------------------------
alter table public.app_training_videos enable row level security;
revoke all on table public.app_training_videos from public, anon, authenticated;
grant select (id, slug, title, min_role, language, content_status, version,
              duration_seconds, video_path, captions_path, poster_path,
              transcript_text, chapters, published_at, active)
  on table public.app_training_videos to authenticated;
grant select, insert, update, delete on table public.app_training_videos to service_role;

drop policy if exists app_training_videos_read on public.app_training_videos;
create policy app_training_videos_read on public.app_training_videos
  for select to authenticated
  using (
    not public.is_partner_user()
    and active
    and published_at is not null
    and published_at <= now()
    and public.can_watch_app_training(min_role)
  );

-- ---------------------------------------------------------------------------
-- 6. The private bucket and its boundary
-- ---------------------------------------------------------------------------
-- Private, and narrow about what it holds: MP4 video, WebVTT captions, a poster
-- image. The transcript lives on the catalog row, not here. 200 MB per object
-- is this bucket's own ceiling; the project's global upload limit also applies
-- (the publisher checks both are respected before it sends anything).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'app-training',
  'app-training',
  false,
  209715200,
  array['video/mp4', 'text/vtt', 'image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- The door: a signed-in crew member may read exactly the objects the catalog
-- says they may watch.
drop policy if exists app_training_read on storage.objects;
create policy app_training_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'app-training'
    and not public.is_partner_user()
    and public.can_read_app_training_object(name)
  );

-- The walls. RESTRICTIVE, so they hold even if an older, broader policy on
-- storage.objects (a "for all using (true)" from an early migration, say) would
-- otherwise let a login in. Each one only speaks about this bucket and passes
-- every other bucket through untouched.
--
-- anon gets its own flat wall with no function call in it: anon has no
-- EXECUTE on can_read_app_training_object, and a policy that asked would turn
-- every anonymous read of every OTHER bucket into a permission error.
drop policy if exists app_training_read_boundary on storage.objects;
create policy app_training_read_boundary on storage.objects
  as restrictive for select to authenticated
  using (bucket_id <> 'app-training' or (not public.is_partner_user() and public.can_read_app_training_object(name)));

drop policy if exists app_training_anon_boundary on storage.objects;
create policy app_training_anon_boundary on storage.objects
  as restrictive for select to anon
  using (bucket_id <> 'app-training');

drop policy if exists app_training_no_client_insert on storage.objects;
create policy app_training_no_client_insert on storage.objects
  as restrictive for insert to anon, authenticated
  with check (bucket_id <> 'app-training');

drop policy if exists app_training_no_client_update on storage.objects;
create policy app_training_no_client_update on storage.objects
  as restrictive for update to anon, authenticated
  using (bucket_id <> 'app-training')
  with check (bucket_id <> 'app-training');

drop policy if exists app_training_no_client_delete on storage.objects;
create policy app_training_no_client_delete on storage.objects
  as restrictive for delete to anon, authenticated
  using (bucket_id <> 'app-training');
