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
