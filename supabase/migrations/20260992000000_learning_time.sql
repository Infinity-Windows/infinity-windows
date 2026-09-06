-- Learning time (the owner's own ask, 2026-09-05): "I want a timer that I can
-- see as an owner how long they spend in the learning tab and on what item.
-- That way I can figure out if someone is trying to go above and beyond in a
-- good way, as well as a timer for watching the YouTube videos, to see if they
-- watch the whole thing and how many times."
--
-- TIME, NOT POINTS. The points cap landing beside this (20260991000000) makes
-- quiz points new-content-only, because points were the only measure of effort
-- the app had and they could be farmed by re-taking the same round. This is the
-- honest companion: minutes actually spent, stamped by the SERVER, on named
-- items. Nothing here pays anybody anything — it is a record an owner reads,
-- not a currency a phone can mint.
--
-- MERGE ORDER: this is 20260992000000 and it must land AFTER 20260991000000
-- (the points cap). They share no object — the cap touches points_ledger and
-- the quiz round, this touches two new tables — so the order matters only
-- because migration numbers deploy in sequence, one at a time.
--
-- WHAT IS RECORDED, stated here because a crew member is told the same thing on
-- their own Learn tab and the two sentences have to agree:
--   * Seconds spent on a NAMED item of the Learn section, while the screen is
--     visible and the app has focus. Nothing while the phone is locked, the
--     tab is hidden, or the app is in the background.
--   * Which parts of a YouTube lesson were actually played, so "watched the
--     whole thing" is a fact rather than a click.
-- What is NOT recorded: any content, any answer, any keystroke, any location.
-- Two tables, two RPCs to write them, two RPCs to read them back.
--
-- THE SERVER STAMPS THE TIME. Both writers take a duration or a position from
-- the phone and refuse to believe it beyond a clamp, and both cross-check what
-- they are told against `now()` — a page that called the heartbeat in a tight
-- loop would still bank no more than the wall clock it has actually been open.
-- See the clamps in learning_heartbeat and learning_video_heartbeat.
--
-- IDEMPOTENT throughout (create ... if not exists / create or replace / drop
-- policy if exists before create / on conflict), so re-running it changes
-- nothing.
--
-- NOT PROJECT-SCOPED, on purpose, exactly like certifications (20260983000000):
-- learning belongs to a person, not a job, so there is no project_id, no
-- `attach_sandbox_guards()` call, and a test login has nothing to be fenced
-- into. What stops a test login writing here is the RPCs' own rules.


-- ---------------------------------------------------------------------------
-- 1. L1 — learning_time: one row per item per visit
-- ---------------------------------------------------------------------------
-- THE GRAIN IS (person, visit, item). `session_id` is a uuid the page mints on
-- load and throws away on unload, so one row is "this person, this open tab,
-- this item" and `active_seconds` is how long they had it in front of them. A
-- person who opens Learn three times in a day makes three rows; a person who
-- flips between Glossary and Videos and back makes one row per item and the
-- glossary row simply grows.
--
-- WHY A SESSION AT ALL, rather than a running per-person total: a total answers
-- "how many minutes" and nothing else. The owner's question is about somebody
-- going above and beyond, which is a shape — five separate evenings on the
-- glossary reads differently from one four-hour afternoon, and only a row per
-- visit can tell them apart. It is also what makes "times watched" countable
-- for videos, one table down.
--
-- item_kind / item_key: the five places of the Learn section, and which one.
--   'tab'      — the Learn page itself; key is the open tab (daily/quiz/…)
--   'term'     — one glossary term; key is the term id
--   'quiz'     — the Quiz tab's round; key is 'round'
--   'sequence' — the Sequence tab's round; key is the branch (win/door)
--   'video'    — one lesson's card; key is the learning_videos id
-- A kind outside that list is refused by the check AND by the RPC, so a typo
-- in a future caller lands as a refusal rather than as a sixth silent bucket
-- nobody's report adds up.
create table if not exists learning_time (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles(id) on delete cascade,
  item_kind text not null check (
    item_kind in ('tab', 'term', 'quiz', 'sequence', 'video')
  ),
  item_key text not null,
  session_id uuid not null,
  started_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  -- Whole seconds. Nothing here needs sub-second precision and an int is what
  -- every report below sums.
  active_seconds int not null default 0 check (active_seconds >= 0),
  created_at timestamptz not null default now(),
  unique (profile_id, session_id, item_kind, item_key)
);

-- The two reads there are: "this person's time" (their own line on Learn, and
-- one row of the owner's table) and "everything in a date window" (the owner's
-- table itself, which filters on last_seen_at).
create index if not exists learning_time_profile_idx
  on learning_time (profile_id, last_seen_at desc);
create index if not exists learning_time_seen_idx
  on learning_time (last_seen_at desc);

comment on table learning_time is
  'Seconds a person spent on one named item of the Learn section during one visit. Written only by learning_heartbeat, which stamps the time itself. Nothing accrues while the screen is hidden or the phone is locked (Learning time, L1).';

alter table learning_time enable row level security;

-- Revoke BEFORE granting, the same reasoning every table since 20260983000000
-- carries: this project's default privileges hand every new table in `public`
-- the full set to `authenticated`, and RLS is not the wall on its own. There is
-- deliberately NO insert/update/delete policy anywhere in this file — the RPC,
-- SECURITY DEFINER, is the only writer there is, so a phone cannot file a row
-- claiming an hour it did not spend.
revoke all on learning_time from anon, authenticated;
grant select on learning_time to authenticated;
grant all on learning_time to service_role;

-- WHO READS WHAT.
--   * Your own rows, always. The Learn tab tells you what it recorded about
--     you, in the same breath as recording it (L4). A measure of a person that
--     the person cannot see is a measure they cannot argue with.
--   * Supervisor and above, everybody's. Rank 2, matching the Data tab: on-tool
--     and per-person time is already a supervisor+ read in this app, and this
--     is more of the same thing. A FOREMAN deliberately does not get their
--     crew's learning time — see the PR body; it is the owner's call to make,
--     not this migration's to assume.
--   * A partner (builder) login, never. The mechanical wall guard every crew
--     table has carried since 20260950000000;
--     scripts/test_partner_wall.py fails on a new table without it.
drop policy if exists "learning_time_select" on learning_time;
create policy "learning_time_select" on learning_time
  for select to authenticated
  using (
    not public.is_partner_user()
    and (profile_id = auth.uid() or public.my_role_rank() >= 2)
  );


-- ---------------------------------------------------------------------------
-- 2. L1 — learning_heartbeat: the only writer
-- ---------------------------------------------------------------------------
-- The page sends one of these every 15 seconds of VISIBLE, FOCUSED time. It
-- never sends while the tab is hidden, the phone is locked, or the app is in
-- the background — that gate is in the client (useLearningTime), and this
-- clamp is what makes the gate's honesty not matter:
--
--   * p_seconds is clamped to [0, 30]. Twice the real cadence, so one late
--     beat after a slow network still lands whole, and a phone that asked for
--     an hour gets thirty seconds.
--   * active_seconds can never exceed the wall clock this row has existed for,
--     plus one beat. This is the clamp that matters. Without it a page could
--     call this in a loop — thirty seconds a call, a hundred calls a second —
--     and bank a day of "study" in a minute. With it, the only way to have sat
--     on the glossary for an hour is for an hour to have passed.
--
-- The row's own started_at is the reference, and it is set by `default now()`
-- on insert, so the phone never supplies the beginning either.
--
-- BEST EFFORT, and the client treats it that way: a failed heartbeat is
-- dropped, never queued. See the note in app/src/lib/learningTime.ts.
create or replace function public.learning_heartbeat(
  p_session_id uuid,
  p_item_kind text,
  p_item_key text,
  p_seconds int
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_me uuid := auth.uid();
  v_add int := least(greatest(coalesce(p_seconds, 0), 0), 30);
begin
  if v_me is null then
    raise exception 'Sign in before the app can record learning time.'
      using errcode = '42501';
  end if;

  -- THE PARTNER WALL, and it has to be here as well as on the table. The policy
  -- above is a gate on direct table access; this function is SECURITY DEFINER
  -- and writes straight past every policy there is. A builder login is pinned to
  -- role 'installer' (20260950000000) and would otherwise be filing learning
  -- rows against itself — rows it could never read back, but rows the owner's
  -- table would count as crew.
  if public.is_partner_user() then
    raise exception 'Not available for your account.' using errcode = '42501';
  end if;

  if p_session_id is null then
    raise exception 'The app did not say which visit this time belongs to.';
  end if;
  if p_item_kind is null
     or p_item_kind not in ('tab', 'term', 'quiz', 'sequence', 'video') then
    raise exception 'That is not a part of Learn this app records time for.';
  end if;
  if coalesce(btrim(p_item_key), '') = '' then
    raise exception 'The app did not say which item this time belongs to.';
  end if;

  -- Nothing to add is not an error: the client sends a first beat to open the
  -- row so a visit that ends before the first full interval still shows up as
  -- a visit. It just banks no seconds.
  insert into learning_time (
    profile_id, item_kind, item_key, session_id, active_seconds
  )
  values (v_me, p_item_kind, btrim(p_item_key), p_session_id, v_add)
  on conflict (profile_id, session_id, item_kind, item_key) do update
    set active_seconds = least(
          learning_time.active_seconds + v_add,
          -- The wall-clock ceiling. floor(), not round(), so the ceiling is
          -- never generous by half a second; + 30 is one whole beat of slack so
          -- an honest first beat that lands late is not shaved.
          floor(extract(epoch from (now() - learning_time.started_at)))::int + 30
        ),
        last_seen_at = now();
end;
$$;

comment on function public.learning_heartbeat(uuid, text, text, int) is
  'Add up to 30 seconds of visible, focused time to this person''s row for one Learn item in one visit. The server stamps the time and caps the row at the wall clock it has existed for, so a phone cannot inflate it (Learning time, L1).';

revoke all on function public.learning_heartbeat(uuid, text, text, int) from public, anon;
grant execute on function public.learning_heartbeat(uuid, text, text, int) to authenticated;


-- ---------------------------------------------------------------------------
-- 3. L2 — merge_watch_ranges: which seconds of a lesson were really played
-- ---------------------------------------------------------------------------
-- "Did they watch the whole thing" cannot be answered by counting presses of
-- play. A lesson left running to an empty room answers yes; a scrubber dragged
-- to the last second answers yes. So what is stored is the SET OF SECONDS a
-- person has actually played, as merged [start, end] ranges, and every answer
-- above it is arithmetic on that set.
--
-- THE RULE, and it is deliberately simple enough to hold in one head: sort by
-- start, then walk. A stretch beginning at or before the end of the one in hand
-- extends it — 0-10 and 10-20 are one viewing of 0-20, not two — and anything
-- else starts a new range. Nothing is counted twice, so watching the same
-- thirty seconds four times covers thirty seconds and no more.
--
-- THIS FUNCTION HAS A TWIN in app/src/lib/videoWatch.ts, because the app has to
-- render what this computed and the tests have to exercise it without a
-- database. The two are pinned to each other by the cases below:
-- app/src/lib/videoWatch.test.ts generates these lines from TWIN_CASES and
-- fails unless every one of them appears in this file, verbatim. A change to
-- either copy that is not made to both cannot land quietly.
--
-- TWIN CASES (ranges + new stretch -> merged, and the seconds they cover):
--   [] + 0..10 -> [[0,10]] covered 10
--   [[0,10]] + 10..20 -> [[0,20]] covered 20
--   [[0,10]] + 20..30 -> [[0,10],[20,30]] covered 20
--   [[0,10],[20,30]] + 5..25 -> [[0,30]] covered 30
--   [[0,30]] + 5..10 -> [[0,30]] covered 30
--   [[20,30]] + 0..10 -> [[0,10],[20,30]] covered 20
--   [] + 10..10 -> [] covered 0
--   [] + -5..10 -> [[0,10]] covered 10
--   [[0,10],[5,15]] + 30..40 -> [[0,15],[30,40]] covered 25
--
-- Whole seconds throughout. A player reports a fractional position and nobody
-- needs the fraction; integers keep the stored json small and the twin exact.
create or replace function public.merge_watch_ranges(
  p_ranges jsonb,
  p_start int,
  p_end int
)
returns jsonb
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_out jsonb := '[]'::jsonb;
  v_s int;
  v_e int;
  r record;
begin
  for r in
    select s, e from (
      select greatest(0, (x->>0)::int) as s, (x->>1)::int as e
        from jsonb_array_elements(coalesce(p_ranges, '[]'::jsonb)) x
      union all
      select greatest(0, least(coalesce(p_start, 0), coalesce(p_end, 0))),
             greatest(coalesce(p_start, 0), coalesce(p_end, 0))
    ) t
    where t.e > t.s
    order by s, e
  loop
    if v_s is null then
      v_s := r.s;
      v_e := r.e;
    elsif r.s <= v_e then
      -- Touching counts as continuous: a beat ending at 10 and the next one
      -- starting at 10 are one stretch of watching, not two.
      v_e := greatest(v_e, r.e);
    else
      v_out := v_out || jsonb_build_array(jsonb_build_array(v_s, v_e));
      v_s := r.s;
      v_e := r.e;
    end if;
  end loop;

  if v_s is not null then
    v_out := v_out || jsonb_build_array(jsonb_build_array(v_s, v_e));
  end if;
  return v_out;
end;
$$;

comment on function public.merge_watch_ranges(jsonb, int, int) is
  'Fold one newly-watched stretch into the seconds of a lesson already covered, merging anything that touches or overlaps. Twin of mergeWatchRanges in app/src/lib/videoWatch.ts (Learning time, L2).';

-- Internal: nothing in a browser calls this. learning_video_heartbeat, which is
-- SECURITY DEFINER and runs as the owner, is the only caller there is.
revoke all on function public.merge_watch_ranges(jsonb, int, int)
  from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 4. L2 — learning_video_watches: one row per lesson per visit
-- ---------------------------------------------------------------------------
-- Same grain as learning_time, for the same reason: a row per (person, lesson,
-- visit) is what makes "how many times" countable at all. A running total could
-- only ever say "forty minutes", which cannot tell four viewings from one long
-- afternoon with the tab open.
--
-- `ranges` is the record; `watch_seconds` is its sum, kept beside it so every
-- read is not a fold over json, and `completed` is the verdict. All three are
-- written by the RPC and by nothing else.
--
-- `last_position_s` is the marker that makes a seek detectable: without the
-- previous position there is no way to tell ten seconds of playing from a drag
-- of the scrubber, and the whole point of this table is that the difference
-- shows up.
create table if not exists learning_video_watches (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles(id) on delete cascade,
  video_id uuid not null references learning_videos(id) on delete cascade,
  session_id uuid not null,
  started_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  -- The sum of `ranges` — seconds of the lesson actually seen in this visit.
  watch_seconds int not null default 0 check (watch_seconds >= 0),
  -- [[start, end], …] in whole seconds, merged. See merge_watch_ranges.
  ranges jsonb not null default '[]'::jsonb,
  -- What the player said the lesson runs to. Null until a player reports it —
  -- an embed that never loaded has no length, and a percentage of null is not
  -- zero percent, it is "we do not know".
  duration_seconds int,
  completed boolean not null default false,
  -- Where the play head was at the last beat. See the note above.
  last_position_s int,
  created_at timestamptz not null default now(),
  unique (profile_id, video_id, session_id)
);

create index if not exists learning_video_watches_profile_idx
  on learning_video_watches (profile_id, last_seen_at desc);
create index if not exists learning_video_watches_video_idx
  on learning_video_watches (video_id, last_seen_at desc);

comment on table learning_video_watches is
  'Which seconds of one lesson a person actually played during one visit, as merged ranges. Written only by learning_video_heartbeat. "Times watched" counts the visits that got through 30 seconds; "watched the whole thing" is completed (Learning time, L2).';

alter table learning_video_watches enable row level security;

revoke all on learning_video_watches from anon, authenticated;
grant select on learning_video_watches to authenticated;
grant all on learning_video_watches to service_role;

-- Same three rules as learning_time above, for the same three reasons: your own
-- rows so the Learn tab can tell you what it recorded, supervisor+ for the
-- owner's table, and never a partner login.
drop policy if exists "learning_video_watches_select" on learning_video_watches;
create policy "learning_video_watches_select" on learning_video_watches
  for select to authenticated
  using (
    not public.is_partner_user()
    and (profile_id = auth.uid() or public.my_role_rank() >= 2)
  );


-- ---------------------------------------------------------------------------
-- 5. L2 — learning_video_heartbeat: the only writer
-- ---------------------------------------------------------------------------
-- While a lesson is playing the page sends the play head's position every ten
-- seconds. This decides how much of that is real.
--
-- A BEAT CLAIMS THE SMALLEST OF THREE NUMBERS: the fifteen-second cap, the wall
-- clock that really passed since the last beat (measured here, from
-- last_seen_at — the phone never supplies it), and the distance the play head
-- actually moved. It claims NOTHING at all when:
--
--   * the player was not playing. A pause is not watching.
--   * this is the first beat of a visit. There is no marker yet, so no play
--     time has been observed. A visit therefore under-reports by up to one
--     beat, which is the direction to be wrong in.
--   * the head went backwards. A rewind is watching, but the seconds it
--     re-covers are already covered, and the range merge would drop them
--     anyway.
--   * the head jumped further forward than the clock could explain. That is a
--     drag of the scrubber, not ten seconds of anybody's attention. The
--     allowance is twice the elapsed time plus two seconds, so double-speed
--     playback is credited — at the slower of the two, deliberately — and a
--     jump is not.
--
-- COMPLETED is either "covered ninety percent" or "the player said it ended",
-- and the second half is why every screen shows the percentage BESIDE the
-- verdict rather than instead of it. Dragging to the last second and letting
-- the player stop does end a video; the honest answer is to let an owner read
-- "finished · 4% watched" and draw their own conclusion, not to guess at
-- intent in here. Once true it stays true: rewinding a lesson you finished
-- does not unfinish it.
--
-- The client sends p_position_s = the duration and p_playing = false when the
-- player fires ENDED, which is what the check below is reading.
create or replace function public.learning_video_heartbeat(
  p_video_id uuid,
  p_session_id uuid,
  p_position_s numeric,
  p_duration_s numeric,
  p_playing boolean
)
returns learning_video_watches
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_me uuid := auth.uid();
  v_row learning_video_watches;
  v_pos int := floor(greatest(coalesce(p_position_s, 0), 0))::int;
  v_dur int := floor(greatest(coalesce(p_duration_s, 0), 0))::int;
  v_known_dur int;
  v_elapsed int;
  v_delta int;
  v_window int := 0;
  v_ranges jsonb;
  v_covered int;
  v_ended boolean;
begin
  if v_me is null then
    raise exception 'Sign in before the app can record what you watched.'
      using errcode = '42501';
  end if;

  -- The partner wall, for the same reason it is in learning_heartbeat: this
  -- function is SECURITY DEFINER and writes straight past the table policy.
  if public.is_partner_user() then
    raise exception 'Not available for your account.' using errcode = '42501';
  end if;

  if p_session_id is null then
    raise exception 'The app did not say which visit this belongs to.';
  end if;
  if not exists (select 1 from learning_videos where id = p_video_id) then
    raise exception 'That lesson is not in the library any more.';
  end if;

  select * into v_row
    from learning_video_watches
   where profile_id = v_me
     and video_id = p_video_id
     and session_id = p_session_id;

  -- A position past the end of the lesson is a rounding artefact of the
  -- player, not a discovery of extra video.
  if v_dur > 0 then
    v_pos := least(v_pos, v_dur);
  end if;

  if not found then
    -- The opening beat of a visit. It banks no seconds — there is no marker to
    -- measure from — it just starts the row and plants one.
    insert into learning_video_watches (
      profile_id, video_id, session_id, watch_seconds, ranges,
      duration_seconds, completed, last_position_s
    )
    values (
      v_me, p_video_id, p_session_id, 0, '[]'::jsonb,
      nullif(v_dur, 0),
      -- An ENDED on the very first beat of a visit is somebody who opened the
      -- card at the end of the video. It is recorded as finished with nothing
      -- watched, and the screens say exactly that.
      (v_dur > 0 and v_pos >= v_dur - 1 and not coalesce(p_playing, false)),
      v_pos
    )
    returning * into v_row;
    return v_row;
  end if;

  v_known_dur := coalesce(nullif(v_dur, 0), v_row.duration_seconds);
  v_elapsed := greatest(0, floor(extract(epoch from (now() - v_row.last_seen_at)))::int);
  v_delta := v_pos - coalesce(v_row.last_position_s, v_pos);

  if coalesce(p_playing, false)
     and v_row.last_position_s is not null
     and v_delta > 0
     and v_delta <= v_elapsed * 2 + 2 then
    v_window := least(15, v_elapsed, v_delta);
  end if;

  v_ranges := v_row.ranges;
  if v_window > 0 then
    v_ranges := public.merge_watch_ranges(v_ranges, v_pos - v_window, v_pos);
  end if;

  select coalesce(sum((x->>1)::int - (x->>0)::int), 0)::int
    into v_covered
    from jsonb_array_elements(v_ranges) x;

  v_ended := v_known_dur is not null
         and v_known_dur > 0
         and v_pos >= v_known_dur - 1
         and not coalesce(p_playing, false);

  update learning_video_watches set
    ranges = v_ranges,
    watch_seconds = v_covered,
    duration_seconds = v_known_dur,
    last_position_s = v_pos,
    last_seen_at = now(),
    completed = completed
      or v_ended
      or (v_known_dur is not null and v_known_dur > 0
          and v_covered::numeric / v_known_dur >= 0.9)
  where id = v_row.id
  returning * into v_row;

  return v_row;
end;
$$;

comment on function public.learning_video_heartbeat(uuid, uuid, numeric, numeric, boolean) is
  'Record the seconds of one lesson a person has actually played in this visit. The server measures the elapsed time itself and credits only a window the wall clock and the play head both agree on, so a seek never counts as watching (Learning time, L2).';

revoke all on function public.learning_video_heartbeat(uuid, uuid, numeric, numeric, boolean)
  from public, anon;
grant execute on function public.learning_video_heartbeat(uuid, uuid, numeric, numeric, boolean)
  to authenticated;


-- ---------------------------------------------------------------------------
-- 6. L3 — learning_time_report: what the owner's table reads
-- ---------------------------------------------------------------------------
-- One row per (person, kind, item) inside a date window, already added up.
--
-- WHY AN RPC RATHER THAN A SELECT. Two reasons. The rows are per visit, so a
-- month of one company's learning is thousands of them and a phone should not
-- be summing that; and the totals have to be the same numbers whoever asks,
-- which means the adding up belongs in one place rather than in every screen
-- that ever wants it.
--
-- WHO SEES WHOSE. Supervisor and above see everybody. Anybody else sees exactly
-- their own rows and nothing else — the same answer the table policy gives, so
-- this function cannot become a way around it. A partner login is refused
-- outright.
--
-- EVERY COLUMN REFERENCE BELOW IS QUALIFIED, on purpose: the OUT parameters of
-- a `returns table` are in scope inside the query, so a bare `profile_id` here
-- would silently mean the OUT parameter and not the column. Same family of bug
-- as the 2026-09-02 finish_unit incident that bought scripts/migration_lint.py.
create or replace function public.learning_time_report(
  p_from timestamptz default null,
  p_to timestamptz default null
)
returns table (
  profile_id uuid,
  display_name text,
  item_kind text,
  item_key text,
  active_seconds bigint,
  visits bigint,
  last_seen_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_me uuid := auth.uid();
  v_all boolean;
begin
  if v_me is null then
    raise exception 'Sign in to read learning time.' using errcode = '42501';
  end if;
  if public.is_partner_user() then
    raise exception 'Not available for your account.' using errcode = '42501';
  end if;
  v_all := public.my_role_rank() >= 2;

  return query
  select t.profile_id,
         coalesce(pr.display_name, 'Someone')::text,
         t.item_kind,
         t.item_key,
         sum(t.active_seconds)::bigint,
         count(distinct t.session_id)::bigint,
         max(t.last_seen_at)
    from learning_time t
    join profiles pr on pr.id = t.profile_id
   where (v_all or t.profile_id = v_me)
     and (p_from is null or t.last_seen_at >= p_from)
     and (p_to is null or t.last_seen_at < p_to)
   group by t.profile_id, pr.display_name, t.item_kind, t.item_key;
end;
$$;

comment on function public.learning_time_report(timestamptz, timestamptz) is
  'Learning time added up per person, per kind, per item, inside a date window. Supervisor+ sees everybody; anybody else sees only their own (Learning time, L3).';

revoke all on function public.learning_time_report(timestamptz, timestamptz)
  from public, anon;
grant execute on function public.learning_time_report(timestamptz, timestamptz)
  to authenticated;


-- ---------------------------------------------------------------------------
-- 7. L3 — learning_video_report: per person, per lesson
-- ---------------------------------------------------------------------------
-- The four numbers the owner asked for, per person per lesson:
--
--   times_watched  — visits that got through 30 seconds. Not presses of play:
--                    a card scrolled past eleven times is not a lesson watched
--                    eleven times. The floor is stated on screen.
--   best_seconds   — the best single visit's covered seconds.
--   union_seconds  — every visit's ranges merged together, so somebody who
--                    watched the first half on Monday and the second half on
--                    Tuesday reads as having seen the whole lesson, which they
--                    have.
--   completed      — did any visit finish it.
--
-- THE UNION IS THE SAME RULE AS merge_watch_ranges, spelled as a window query
-- because it folds across visits rather than into one row: sort every stretch
-- by where it starts, and start a new island only where one begins AFTER the
-- furthest end seen so far. Touching stretches merge, exactly as they do there.
create or replace function public.learning_video_report(
  p_from timestamptz default null,
  p_to timestamptz default null
)
returns table (
  profile_id uuid,
  display_name text,
  video_id uuid,
  video_title text,
  times_watched bigint,
  best_seconds int,
  union_seconds int,
  duration_seconds int,
  completed boolean,
  last_watched_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_me uuid := auth.uid();
  v_all boolean;
begin
  if v_me is null then
    raise exception 'Sign in to read what has been watched.' using errcode = '42501';
  end if;
  if public.is_partner_user() then
    raise exception 'Not available for your account.' using errcode = '42501';
  end if;
  v_all := public.my_role_rank() >= 2;

  return query
  with scoped as (
    select w.id as wid,
           w.profile_id as pid,
           w.video_id as vid,
           w.watch_seconds as secs,
           w.duration_seconds as dur,
           w.completed as done,
           w.last_seen_at as seen,
           w.ranges as rs
      from learning_video_watches w
     where (v_all or w.profile_id = v_me)
       and (p_from is null or w.last_seen_at >= p_from)
       and (p_to is null or w.last_seen_at < p_to)
  ),
  segs as (
    select sc.pid, sc.vid, (x->>0)::int as s0, (x->>1)::int as s1
      from scoped sc, lateral jsonb_array_elements(sc.rs) x
  ),
  ordered as (
    select sg.pid, sg.vid, sg.s0, sg.s1,
           max(sg.s1) over (
             partition by sg.pid, sg.vid
             order by sg.s0, sg.s1
             rows between unbounded preceding and 1 preceding
           ) as prev_max
      from segs sg
  ),
  islands as (
    select od.pid, od.vid, od.s0, od.s1,
           sum(case when od.prev_max is null or od.s0 > od.prev_max then 1 else 0 end)
             over (
               partition by od.pid, od.vid
               order by od.s0, od.s1
               rows between unbounded preceding and current row
             ) as grp
      from ordered od
  ),
  merged as (
    select il.pid, il.vid, il.grp, min(il.s0) as g0, max(il.s1) as g1
      from islands il
     group by il.pid, il.vid, il.grp
  ),
  unioned as (
    select mg.pid, mg.vid, sum(mg.g1 - mg.g0)::int as covered
      from merged mg
     group by mg.pid, mg.vid
  )
  select sc.pid,
         coalesce(pr.display_name, 'Someone')::text,
         sc.vid,
         coalesce(lv.title, 'Lesson')::text,
         count(*) filter (where sc.secs >= 30)::bigint,
         coalesce(max(sc.secs), 0)::int,
         coalesce(max(un.covered), 0)::int,
         max(sc.dur)::int,
         bool_or(sc.done),
         max(sc.seen)
    from scoped sc
    join profiles pr on pr.id = sc.pid
    join learning_videos lv on lv.id = sc.vid
    left join unioned un on un.pid = sc.pid and un.vid = sc.vid
   group by sc.pid, pr.display_name, sc.vid, lv.title;
end;
$$;

comment on function public.learning_video_report(timestamptz, timestamptz) is
  'Per person per lesson: how many visits got through 30 seconds, the best visit, every visit''s seconds merged together, whether it was ever finished, and when it was last watched. Supervisor+ sees everybody; anybody else sees only their own (Learning time, L3).';

revoke all on function public.learning_video_report(timestamptz, timestamptz)
  from public, anon;
grant execute on function public.learning_video_report(timestamptz, timestamptz)
  to authenticated;
