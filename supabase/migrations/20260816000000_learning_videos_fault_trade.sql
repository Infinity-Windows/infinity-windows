-- Two owner asks (2026-08-13):
--
-- 1. Issue FAULT becomes a TRADE, not a person — "fault: Carpentry,
--    Plumbing, HVAC, Concrete, Sheetrock, Insulation, Siding, Windows,
--    etc." Assign stays a person. fault_by (uuid) stays for history but
--    the board now reads/writes fault_trade.
--
-- 2. Learning videos: supervisors title a window type they want to teach,
--    upload a training video (or hyperlink YouTube), and provide TWO
--    transcripts — a summary for reviewing the video and the full text to
--    read along. Installers watch and read; supervisors author.

alter table issues add column if not exists fault_trade text;

create or replace function set_issue_fault_trade(p_id uuid, p_trade text default null)
returns issues
language plpgsql
security definer
as $$
declare
  v_role text;
  v_row issues;
begin
  select role into v_role from profiles where id = auth.uid();
  if v_role is null or v_role = 'installer' then
    raise exception 'only a foreman-level user or above can attribute fault';
  end if;
  update issues
  set fault_trade = nullif(trim(coalesce(p_trade, '')), '')
  where id = p_id
  returning * into v_row;
  if not found then
    raise exception 'issue not found';
  end if;
  return v_row;
end;
$$;

-- ---------------------------------------------------------------- videos

create table if not exists learning_videos (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  -- The window type the lesson teaches; free-text topic when it's general.
  window_type_id uuid references window_types (id) on delete set null,
  topic text,
  -- Exactly one source: an uploaded file in the learning-videos bucket, or
  -- a YouTube address.
  video_path text,
  youtube_url text,
  -- Supervisor-authored: the review summary and the read-along full text.
  summary text,
  transcript text,
  active boolean not null default true,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table learning_videos enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'learning_videos' and policyname = 'crew read'
  ) then
    create policy "crew read" on learning_videos
      for select to authenticated using (true);
  end if;
end;
$$;

-- Supervisor+: create/update/retire in one call (null p_id inserts).
create or replace function save_learning_video(
  p_id uuid,
  p_title text,
  p_window_type uuid default null,
  p_topic text default null,
  p_video_path text default null,
  p_youtube_url text default null,
  p_summary text default null,
  p_transcript text default null,
  p_active boolean default true
)
returns learning_videos
language plpgsql
security definer
as $$
declare
  v_role text;
  v_row learning_videos;
begin
  select role into v_role from profiles where id = auth.uid();
  if v_role is null or v_role in ('installer', 'foreman') then
    raise exception 'only a supervisor or above can manage training videos';
  end if;
  if p_title is null or length(trim(p_title)) = 0 then
    raise exception 'a training video needs a title';
  end if;
  if p_video_path is null and nullif(trim(coalesce(p_youtube_url, '')), '') is null then
    raise exception 'upload a video or paste a YouTube address';
  end if;

  if p_id is null then
    insert into learning_videos (
      title, window_type_id, topic, video_path, youtube_url,
      summary, transcript, active, created_by
    )
    values (
      trim(p_title), p_window_type, nullif(trim(coalesce(p_topic, '')), ''),
      p_video_path, nullif(trim(coalesce(p_youtube_url, '')), ''),
      p_summary, p_transcript, coalesce(p_active, true), auth.uid()::text
    )
    returning * into v_row;
  else
    update learning_videos
    set title = trim(p_title),
        window_type_id = p_window_type,
        topic = nullif(trim(coalesce(p_topic, '')), ''),
        video_path = p_video_path,
        youtube_url = nullif(trim(coalesce(p_youtube_url, '')), ''),
        summary = p_summary,
        transcript = p_transcript,
        active = coalesce(p_active, true),
        updated_at = now()
    where id = p_id
    returning * into v_row;
    if not found then
      raise exception 'training video not found';
    end if;
  end if;
  return v_row;
end;
$$;

-- Storage for uploaded lesson videos (mirrors the toolbox-records pattern).
insert into storage.buckets (id, name, public)
values ('learning-videos', 'learning-videos', false)
on conflict (id) do nothing;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'objects' and policyname = 'authenticated learning videos'
  ) then
    create policy "authenticated learning videos"
      on storage.objects for all to authenticated
      using (bucket_id = 'learning-videos')
      with check (bucket_id = 'learning-videos');
  end if;
end;
$$;
