-- Recordings by link, wave U of the transcripts program (owner's design,
-- Q15 + Q19 — cited, never re-decided).
--
-- WHAT THE OWNER ACTUALLY ASKED FOR, and what this deliberately does NOT build:
-- installers already film themselves working. The app is not going to collect
-- that raw footage. An installer emails the video to their lead, the lead puts
-- it on YouTube, and the app gets the LINK. So there is no new upload path
-- here, no raw-footage inbox, and no file size cap to argue about — three
-- features that would each have needed storage, review and a retention policy
-- to hold footage nobody wanted to keep.
--
-- Three things, in the order they depend on each other:
--
--   1. learning_videos.status — draft | published. A lesson is now born a
--      DRAFT: a link with nothing else on it is not a lesson, and a half-built
--      one appearing in the crew's library the second it is saved is how the
--      library fills with untitled fragments. Crews read published rows only;
--      supervisors read everything, which is what makes the Inbox on the Videos
--      tab possible.
--
--   2. save_learning_video learns that column, and publish_learning_video is
--      the one-tap flip at the end of the flow (paste the link, paste the
--      transcript, Generate summary & quiz, Approve, Publish).
--
--   3. foreman_contacts_for_me — the address the "Send a recording" button
--      needs. Emails live in auth.users, which no client role may read, so the
--      only way an installer's phone can address their lead is a SECURITY
--      DEFINER function that answers with a MINIMAL PROJECTION: a display name
--      and an email, for foreman-and-up only, and nothing else about anybody.
--      Never the profiles row (wave S's projection law: build an outward
--      payload field by field, never spread-and-delete).
--
-- IDEMPOTENT throughout: add-column-if-not-exists, drop-then-add for the check
-- constraint, drop-then-create for the policy, create-or-replace for every
-- function. Safe to run twice.
--
-- MERGE ORDER: after 20260981000000 (wave H), 20260982000000 (wave Y) and
-- 20260983000000 (wave O). Numbers land in order, one deploy at a time. This
-- file touches learning_videos and nothing any of those three touch, so the
-- only real constraint is the number.
--
-- NO NEW TABLE, so there is nothing here for attach_sandbox_guards() to arm and
-- nothing new for the partner wall to sweep — the existing learning_videos
-- policy already carries the is_partner_user() guard (20260950000000) and the
-- replacement below keeps it.


-- ---------------------------------------------------------------------------
-- 1. U1 — draft until published
-- ---------------------------------------------------------------------------
--
-- DEFAULT 'published', which reads backwards until you remember what a default
-- does to rows that already exist: every lesson in the library today was made
-- under the old rule, was visible to crews yesterday, and must still be visible
-- to them tomorrow. A default of 'draft' would have silently emptied the whole
-- Learn library on deploy. NEW rows land 'draft' one layer up, inside
-- save_learning_video, where the app's own writer can tell the difference
-- between "somebody just made this" and "this was always here".

alter table learning_videos
  add column if not exists status text not null default 'published';

alter table learning_videos drop constraint if exists learning_videos_status_check;
alter table learning_videos add constraint learning_videos_status_check
  check (status in ('draft', 'published'));

comment on column learning_videos.status is
  'draft while a supervisor is still building the lesson (link pasted, transcript missing, quiz not approved); published once it is ready for crews. Crews read published rows only — see the "crew read" policy. New rows are born draft by save_learning_video; the column default is published so every lesson that existed before this migration stays visible.';

-- The crew read policy, replaced rather than added to: two select policies OR
-- together in Postgres, so a second permissive policy saying "supervisors see
-- everything" alongside an unchanged "everyone sees everything" would have
-- changed nothing at all. One policy, both rules.
--
-- The partner guard is carried over verbatim from THE WALL (20260950000000).
-- test_partner_wall.py replays every migration in this repo and fails if a
-- live select policy on this table loses it.
drop policy if exists "crew read" on learning_videos;
create policy "crew read" on learning_videos
  for select to authenticated
  using (
    not public.is_partner_user()
    and (status = 'published' or public.my_role_rank() >= 2)
  );


-- ---------------------------------------------------------------------------
-- 2. U1 — the writer learns the column
-- ---------------------------------------------------------------------------
--
-- The older signatures go first. `create or replace` with a different argument
-- list makes an OVERLOAD, not a replacement, and a pile of near-identical
-- overloads is how PostgREST starts answering PGRST203 ("could not choose the
-- best candidate function") to a supervisor who only wanted to save a video.
-- The app is the only caller and it always sends the whole argument set, so
-- exactly one signature should exist.
drop function if exists public.save_learning_video(
  uuid, text, uuid, text, text, text, text, text, boolean);
drop function if exists public.save_learning_video(
  uuid, text, uuid, text, text, text, text, text, boolean, uuid);

create or replace function public.save_learning_video(
  p_id uuid,
  p_title text,
  p_window_type uuid default null,
  p_topic text default null,
  p_video_path text default null,
  p_youtube_url text default null,
  p_summary text default null,
  p_transcript text default null,
  p_active boolean default true,
  p_grants_clearance uuid default null,
  p_status text default null
)
returns learning_videos
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role text;
  v_status text;
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

  v_status := nullif(trim(coalesce(p_status, '')), '');
  if v_status is not null and v_status not in ('draft', 'published') then
    raise exception 'a training video is either a draft or published';
  end if;

  if p_id is null then
    insert into learning_videos (
      title, window_type_id, topic, video_path, youtube_url,
      summary, transcript, active, created_by, grants_clearance, status
    )
    values (
      trim(p_title), p_window_type, nullif(trim(coalesce(p_topic, '')), ''),
      p_video_path, nullif(trim(coalesce(p_youtube_url, '')), ''),
      p_summary, p_transcript, coalesce(p_active, true), auth.uid()::text,
      p_grants_clearance,
      -- A brand new lesson is a DRAFT unless the caller says otherwise. The
      -- column default cannot do this job: it has to stay 'published' so the
      -- lessons that predate this migration keep working.
      coalesce(v_status, 'draft')
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
        grants_clearance = p_grants_clearance,
        -- Silence means "leave it where it is". An ordinary edit of a
        -- published lesson must not quietly unpublish it, and an edit of a
        -- draft must not publish it — publishing is its own deliberate tap.
        status = coalesce(v_status, learning_videos.status),
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

comment on function public.save_learning_video(uuid, text, uuid, text, text, text, text, text, boolean, uuid, text) is
  'Create or update a training video (supervisor+). A new row is born draft; an edit leaves status exactly as it found it, so publishing is always its own deliberate act.';

revoke all on function public.save_learning_video(uuid, text, uuid, text, text, text, text, text, boolean, uuid, text) from public, anon;
grant execute on function public.save_learning_video(uuid, text, uuid, text, text, text, text, text, boolean, uuid, text) to authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 3. U1 — Publish
-- ---------------------------------------------------------------------------
--
-- One tap at the end of the flow. Its own function rather than a flag on the
-- save above because that is what the Inbox needs: a supervisor scrolling a
-- list of drafts publishes one without opening it, and nothing else about the
-- row changes.

create or replace function public.publish_learning_video(p_id uuid)
returns learning_videos
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row learning_videos;
begin
  if public.my_role_rank() < 2 then
    raise exception 'Only a supervisor or above can publish a training video.';
  end if;

  update learning_videos
  set status = 'published',
      updated_at = now()
  where id = p_id
  returning * into v_row;

  if not found then
    raise exception 'That training video is not there any more.';
  end if;
  return v_row;
end;
$$;

comment on function public.publish_learning_video(uuid) is
  'Flip one training video from draft to published so crews can see it. Supervisor+ only.';

revoke all on function public.publish_learning_video(uuid) from public, anon;
grant execute on function public.publish_learning_video(uuid) to authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 4. U2 — who to send a recording to
-- ---------------------------------------------------------------------------
--
-- The button on Learn and on My Work opens the phone's mail composer already
-- addressed to the installer's lead. To do that it needs an email address, and
-- there is no email address anywhere a client can read: `profiles` has no email
-- column at all (20260715240000) and the addresses live in `auth.users`, which
-- the `authenticated` role cannot touch. Hence this function.
--
-- MINIMAL PROJECTION, and only that. It returns a display name and an email,
-- for foreman-and-above, and nothing else — never a profiles row, never a
-- phone, never a rank, never an id. Two named columns are the whole contract,
-- so a future column on `profiles` cannot leak through it by accident, which is
-- exactly what a `select p.*` here would have guaranteed one day.
--
-- WHO COUNTS AS "ON THE JOB": the same answer wave J's pipeline sweep gives
-- (pipeline_nudge_audience, 20260979000000) — a lead on a PUBLISHED assignment
-- covering today, or one standing on the job right now with an open shift. A
-- draft assignment does not count; the crew has not been shown it. When the
-- caller is not clocked into a job, or nobody on it qualifies, it falls back to
-- every active lead in the company — an installer with a video always has
-- somebody to send it to, which is the whole point.
--
-- Partners are refused outright. A builder login is not crew and must never be
-- handed the crew's address book.
--
-- The two returned columns are named contact_name / contact_email rather than
-- display_name / email on purpose. It says what they are — a contact card, not
-- a profiles row — and it keeps every identifier inside the body unambiguous:
-- an OUT parameter sharing a name with a column of a table the body queries is
-- the classic way a plpgsql function that reads fine refuses to compile.
create or replace function public.foreman_contacts_for_me()
returns table (contact_name text, contact_email text)
language plpgsql
stable
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_project uuid;
begin
  if v_uid is null then
    raise exception 'Sign in first.';
  end if;
  if public.is_partner_user() then
    raise exception 'This is the crew address book, and a builder login is not crew.';
  end if;

  -- The job the caller is standing on, if any. Newest open shift wins, the
  -- same way getOpenShift() picks one on the phone.
  select ts.project_id into v_project
    from time_shifts ts
   where ts.profile_id = v_uid
     and ts.status = 'open'
     and ts.clock_out_at is null
   order by ts.clock_in_at desc
   limit 1;

  if v_project is not null then
    return query
      select p.display_name, u.email::text
        from profiles p
        join auth.users u on u.id = p.id
       where p.active
         and not coalesce(p.is_partner, false)
         and public._is_lead(p.id)
         and p.id <> v_uid
         and u.email is not null
         and (
           exists (
             select 1
               from schedule_assignments sa
               join schedule_assignment_members sam on sam.assignment_id = sa.id
              where sa.project_id = v_project
                and sam.profile_id = p.id
                -- Published, not drafted — see pipeline_nudge_audience's own
                -- note on why a pencilled-in plan must not count.
                and sa.status in ('published', 'in_progress', 'done')
                and sa.end_date >= (now() at time zone 'America/Denver')::date
                and sa.start_date <= (now() at time zone 'America/Denver')::date
           )
           or exists (
             select 1
               from time_shifts ts2
              where ts2.project_id = v_project
                and ts2.profile_id = p.id
                and ts2.status = 'open'
                and ts2.clock_out_at is null
           )
         )
       order by p.display_name;
    -- RETURN QUERY sets FOUND. Somebody answered, so stop here rather than
    -- adding every other lead in the company to the To: line.
    if found then
      return;
    end if;
  end if;

  return query
    select p.display_name, u.email::text
      from profiles p
      join auth.users u on u.id = p.id
     where p.active
       and not coalesce(p.is_partner, false)
       and public._is_lead(p.id)
       and p.id <> v_uid
       and u.email is not null
     order by p.display_name;
end;
$$;

comment on function public.foreman_contacts_for_me() is
  'The name and email of every foreman-and-up on the job the caller is clocked into, else every active one in the company. A MINIMAL PROJECTION — two columns, nothing else about anybody — because emails live in auth.users where no client role may read them. Refuses partner logins.';

revoke all on function public.foreman_contacts_for_me() from public, anon;
grant execute on function public.foreman_contacts_for_me() to authenticated, service_role;
