-- Wave Q: video summaries and quizzes (grill 2026-09-01, Q1-Q4 approved).
--
-- Owner decisions, ALL settled (see scratchpad/q-video-quiz-spec.md, cited,
-- never re-decided): (Q1) transcripts arrive by paste or, for an uploaded
-- file, Whisper on our own stored copy — the app never scrapes YouTube.
-- (Q2) links stay YouTube-only (learnVideos.ts's youtubeEmbedUrl already
-- enforces this; unchanged here). (Q3) AI output is DRAFT-FIRST — a
-- supervisor approves before crews ever see it (the crew-board drafts
-- precedent, wave A). (Q4) attempts are recorded per person, points are
-- awarded like the existing Education Quiz tab, pass is 4-of-5, retakes are
-- unlimited, and a pass may grant an installer clearance through the
-- never-called setClearance hook (app/src/lib/install/api.ts) this wave
-- finally wires up.
--
-- Ground truth this builds on (learning_videos, 20260816000000): supervisors
-- already title a lesson, upload or link it, and author two transcripts.
-- This migration adds the QUIZ half — a draft/approve state machine sitting
-- next to that row, plus the attempts and clearance-grant this generates.
--
-- THE LAW carried over from receipts (20260957000000) and placement_
-- suggestions (20260961000000): zero insert/update/delete policies on
-- either new table below. save_video_quiz_draft, approve_video_quiz,
-- list_video_quiz and submit_video_quiz (all SECURITY DEFINER, search_path
-- pinned) are the only writers, so there is no direct-write path that could
-- skip a rule any of them enforces — most importantly, that correct answers
-- never reach a client that has not already submitted (see submit_video_
-- quiz's own comment).
--
-- THE PARTNER WALL (20260950000000): every select policy below carries
-- `not public.is_partner_user()`. test_partner_wall.py replays every
-- migration in this repo and fails if a live select-granting policy on a
-- new table skips it — that is the trap that catches a naive
-- `using (true))` on day one instead of six months later.
--
-- Draft vs approved, concretely: ONE row per video (learning_video_quizzes,
-- unique on video_id). A fresh Generate always overwrites draft_summary /
-- draft_questions and flips status back to 'draft' — Q3's "regenerating
-- replaces the draft, never the approved version" — while `questions` and
-- learning_videos.summary (what crews actually see) sit untouched until the
-- NEXT Approve & publish copies the draft over them.

-- ---------------------------------------------------------------- learning_videos

alter table learning_videos
  add column if not exists grants_clearance uuid references window_types(id) on delete set null;

comment on column learning_videos.grants_clearance is
  'Optional: the window type a passing quiz on this video clears the installer for (installer_clearance''s own window_type_id — same FK target, so a clearance this grants is indistinguishable from one a lead granted by hand). Null means the video teaches without gating any work.';

-- ---------------------------------------------------------------- learning_video_quizzes

create table if not exists learning_video_quizzes (
  id uuid primary key default gen_random_uuid(),
  video_id uuid not null unique references learning_videos(id) on delete cascade,
  -- The newest AI generation. Supervisor-eyes-only, always — this is where
  -- correct_idx/why live before anyone has agreed the questions are fair.
  draft_summary text,
  draft_questions jsonb not null default '[]'::jsonb,
  -- What crews are actually quizzed on, once approved. A fresh Generate
  -- never touches these two — only approve_video_quiz does.
  questions jsonb not null default '[]'::jsonb,
  status text not null default 'draft' check (status in ('draft', 'approved')),
  generated_at timestamptz not null default now(),
  approved_by uuid references profiles(id) on delete set null,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table learning_video_quizzes is
  'Wave Q: one row per learning_videos lesson holding its AI-generated quiz, draft-first. RPC-only writes: save_video_quiz_draft (Generate), approve_video_quiz (supervisor+ publish), list_video_quiz (the crew-facing sanitized read), submit_video_quiz (server-scored attempt). See each function''s own comment.';
comment on column learning_video_quizzes.draft_questions is
  'Exactly 5 objects: {q, choices: [4 strings], correct_idx: 0-3, why: one line}. Never selected by an installer-rank caller — the table''s own select policy is supervisor+ only, and the crew-facing read (list_video_quiz) strips correct_idx/why entirely.';
comment on column learning_video_quizzes.questions is
  'Same shape as draft_questions, but this is the LIVE, approved set a crew is actually quizzed on. Untouched by a fresh Generate until the next Approve & publish (Q3).';

alter table learning_video_quizzes enable row level security;

-- Supervisor+ only, whatever the status — a draft's correct answers are as
-- sensitive as an approved quiz's, and only a supervisor authors/reviews
-- either. Crews never read this table directly; list_video_quiz is their
-- only door, and it never selects draft_questions or the answer keys inside
-- questions.
drop policy if exists "supervisor read" on learning_video_quizzes;
create policy "supervisor read" on learning_video_quizzes
  for select to authenticated
  using (not public.is_partner_user() and public._is_supervisor(auth.uid()));
-- No insert/update/delete policy — save_video_quiz_draft and
-- approve_video_quiz are the only writers.

-- ---------------------------------------------------------------- learning_video_quiz_attempts

create table if not exists learning_video_quiz_attempts (
  id uuid primary key default gen_random_uuid(),
  video_id uuid not null references learning_videos(id) on delete cascade,
  profile_id uuid not null references profiles(id) on delete cascade,
  -- The five picks, in the ORIGINAL (unshuffled) question order — the same
  -- order submit_video_quiz scores against. Kept even though the score is
  -- also stored, so a dispute or a later "what did they actually pick" read
  -- never has to be reconstructed.
  answers jsonb not null,
  score int not null check (score between 0 and 5),
  passed boolean not null,
  created_at timestamptz not null default now()
);

create index if not exists learning_video_quiz_attempts_profile_idx
  on learning_video_quiz_attempts (profile_id, created_at desc);
create index if not exists learning_video_quiz_attempts_video_idx
  on learning_video_quiz_attempts (video_id, created_at desc);

comment on table learning_video_quiz_attempts is
  'Wave Q: one row per quiz submission, server-scored by submit_video_quiz (SECURITY DEFINER) — never client-computed and never client-written. Unlimited retakes; a FIRST pass (score >= 4) is what pays points and grants a clearance.';

alter table learning_video_quiz_attempts enable row level security;

-- Own rows, or foreman+ sees everyone's — the exact shape of timecard_
-- periods' "own or lead read" (20260950000000), copied rather than
-- reinvented: an installer's quiz history is exactly as private as their
-- timecard is to their peers, and exactly as visible to a lead.
drop policy if exists "own or lead read" on learning_video_quiz_attempts;
create policy "own or lead read" on learning_video_quiz_attempts
  for select to authenticated
  using (not public.is_partner_user() and (profile_id = auth.uid() or _is_lead(auth.uid())));
-- No insert/update/delete policy — submit_video_quiz is the only writer.

-- ---------------------------------------------------------------- save_video_quiz_draft

create or replace function public.save_video_quiz_draft(
  p_video_id uuid,
  p_summary text,
  p_questions jsonb
)
returns learning_video_quizzes
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row learning_video_quizzes;
begin
  if not public._is_supervisor(auth.uid()) then
    raise exception 'Only a supervisor or above can generate a summary and quiz.'
      using errcode = '42501';
  end if;
  if p_questions is null or jsonb_typeof(p_questions) <> 'array' or jsonb_array_length(p_questions) <> 5 then
    raise exception 'A video quiz needs exactly 5 questions.';
  end if;

  insert into learning_video_quizzes (video_id, draft_summary, draft_questions, status, generated_at, updated_at)
  values (p_video_id, p_summary, p_questions, 'draft', now(), now())
  on conflict (video_id) do update
    set draft_summary = excluded.draft_summary,
        draft_questions = excluded.draft_questions,
        -- Q3: a fresh Generate is always a new draft — even a video that was
        -- already approved goes back to awaiting review, while `questions`
        -- (untouched by this statement) keeps crews on the old approved set.
        status = 'draft',
        generated_at = now(),
        updated_at = now()
  returning * into v_row;

  return v_row;
end;
$$;

comment on function public.save_video_quiz_draft(uuid, text, jsonb) is
  'Persists summarize-learning-video''s raw {summary, questions} reading as a draft (upsert on video_id). Supervisor+ only. Never touches learning_videos.summary or the approved `questions` column — approve_video_quiz is the only path that publishes a draft.';

revoke all on function public.save_video_quiz_draft(uuid, text, jsonb) from public, anon;
grant execute on function public.save_video_quiz_draft(uuid, text, jsonb) to authenticated;

-- ---------------------------------------------------------------- approve_video_quiz

create or replace function public.approve_video_quiz(p_video_id uuid)
returns learning_video_quizzes
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row learning_video_quizzes;
begin
  if not public._is_supervisor(auth.uid()) then
    raise exception 'Only a supervisor or above can approve a video quiz.'
      using errcode = '42501';
  end if;

  select * into v_row from learning_video_quizzes where video_id = p_video_id;
  if not found or v_row.draft_questions is null or jsonb_array_length(v_row.draft_questions) = 0 then
    raise exception 'Generate a summary and quiz before approving.';
  end if;

  update learning_videos
  set summary = v_row.draft_summary,
      updated_at = now()
  where id = p_video_id;

  update learning_video_quizzes
  set questions = draft_questions,
      status = 'approved',
      approved_by = auth.uid(),
      approved_at = now(),
      updated_at = now()
  where video_id = p_video_id
  returning * into v_row;

  return v_row;
end;
$$;

comment on function public.approve_video_quiz(uuid) is
  'Publishes the current draft: copies draft_summary onto learning_videos.summary and draft_questions onto the live `questions` column, flips status to approved. Supervisor+ only. Crews cannot see a quiz (list_video_quiz returns null) until this has run at least once.';

revoke all on function public.approve_video_quiz(uuid) from public, anon;
grant execute on function public.approve_video_quiz(uuid) to authenticated;

-- ---------------------------------------------------------------- list_video_quiz

create or replace function public.list_video_quiz(p_video_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_status text;
  v_questions jsonb;
begin
  -- Partner wall: even the fact that a quiz exists stays inside the crew.
  if public.is_partner_user() then
    return null;
  end if;

  select status, questions into v_status, v_questions
  from learning_video_quizzes
  where video_id = p_video_id;

  if v_status is distinct from 'approved' then
    return null;
  end if;

  -- THE LAW: correct_idx and why never leave this function. Only q/choices,
  -- in the approved order — the client shuffles both question and choice
  -- order per attempt on its own (a pure, unit-tested, seeded helper).
  return (
    select jsonb_agg(jsonb_build_object('q', elem ->> 'q', 'choices', elem -> 'choices') order by ord)
    from jsonb_array_elements(coalesce(v_questions, '[]'::jsonb)) with ordinality as t(elem, ord)
  );
end;
$$;

comment on function public.list_video_quiz(uuid) is
  'The crew-facing read: approved questions with correct_idx/why stripped, or null when there is no approved quiz for this video (draft, never generated, or a partner login). Any authenticated non-partner may call it — no role floor, same as watching the video itself.';

revoke all on function public.list_video_quiz(uuid) from public, anon;
grant execute on function public.list_video_quiz(uuid) to authenticated;

-- ---------------------------------------------------------------- submit_video_quiz

create or replace function public.submit_video_quiz(p_video_id uuid, p_answers jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_quiz learning_video_quizzes;
  v_grants uuid;
  v_score int := 0;
  v_passed boolean;
  v_already_passed boolean;
  v_points int := 0;
  v_cleared boolean := false;
  v_results jsonb := '[]'::jsonb;
  v_i int;
  v_q jsonb;
  v_picked int;
  v_correct int;
  v_ok boolean;
begin
  if public.is_partner_user() then
    raise exception 'That quiz isn''t published yet.';
  end if;

  select * into v_quiz from learning_video_quizzes
  where video_id = p_video_id and status = 'approved';
  if not found then
    raise exception 'That quiz isn''t published yet.';
  end if;

  if p_answers is null or jsonb_typeof(p_answers) <> 'array' or jsonb_array_length(p_answers) <> 5
     or v_quiz.questions is null or jsonb_array_length(v_quiz.questions) <> 5 then
    raise exception 'Answer all five before turning it in.';
  end if;

  for v_i in 0..4 loop
    if (p_answers ->> v_i) is null then
      raise exception 'Answer all five before turning it in.';
    end if;
    v_picked := (p_answers ->> v_i)::int;
    v_q := v_quiz.questions -> v_i;
    v_correct := (v_q ->> 'correct_idx')::int;
    v_ok := v_picked = v_correct;
    if v_ok then
      v_score := v_score + 1;
    end if;
    v_results := v_results || jsonb_build_array(jsonb_build_object(
      'correct', v_ok,
      'correct_idx', v_correct,
      'why', v_q ->> 'why'
    ));
  end loop;

  v_passed := v_score >= 4;

  -- "First pass" has to be asked BEFORE this attempt is inserted, or every
  -- attempt would see itself in the history and never pay out twice by
  -- definition instead of by design.
  select exists (
    select 1 from learning_video_quiz_attempts
    where video_id = p_video_id and profile_id = auth.uid() and passed
  ) into v_already_passed;

  insert into learning_video_quiz_attempts (video_id, profile_id, answers, score, passed)
  values (p_video_id, auth.uid(), p_answers, v_score, v_passed);

  if v_passed and not v_already_passed then
    -- Matches the Education Quiz tab's payout exactly (lib/points.ts,
    -- POINT_RULES.quizPerCorrect = 10 per correct answer). SQL cannot import
    -- that TS constant, so this is kept in sync by hand — the same
    -- arrangement spendGuard.ts's MODEL_PRICES table already lives with.
    v_points := v_score * 10;
    insert into points_ledger (profile_id, kind, points, ref, status)
    values (auth.uid(), 'quiz', v_points, 'video_quiz:' || p_video_id::text, 'confirmed');

    select grants_clearance into v_grants from learning_videos where id = p_video_id;
    if v_grants is not null then
      -- The server-side equivalent of setClearance's own write
      -- (app/src/lib/install/api.ts ~:723 -> set_clearance,
      -- 20260716002000/20260718000000): same insert, same on-conflict
      -- no-op. cleared_by is auth.uid() here too — the installer's own pass
      -- is what cleared them, and this is the identity that was actually
      -- signed in when it happened.
      insert into installer_clearance (installer_id, window_type_id, cleared_by)
      values (auth.uid(), v_grants, auth.uid())
      on conflict (installer_id, window_type_id) do nothing;
      v_cleared := true;
    end if;
  end if;

  return jsonb_build_object(
    'score', v_score,
    'passed', v_passed,
    'points_awarded', v_points,
    'cleared', v_cleared,
    'grants_clearance', v_grants,
    'results', v_results
  );
end;
$$;

comment on function public.submit_video_quiz(uuid, jsonb) is
  'Server-scored quiz submission — THE LAW: correct answers are never trusted from the client, only recomputed here against the stored, approved `questions`. p_answers is the 5 picks in original question order. On a FIRST pass (score >= 4) awards points (matches the Education Quiz tab, lib/points.ts) and, if the video carries grants_clearance, grants it the same way setClearance does. Any authenticated non-partner may call it.';

revoke all on function public.submit_video_quiz(uuid, jsonb) from public, anon;
grant execute on function public.submit_video_quiz(uuid, jsonb) to authenticated;
