// Wave Q: the video quiz — draft/approve, the crew-facing sanitized read,
// server-scored attempts, and the pure client-side logic none of that needs
// a round trip for (shuffling, and reading the RPC's own verdict).
//
// THE LAW this whole file is built around: correct answers are never
// trusted from the client and never even SHAPED to look like they could be.
// list_video_quiz (the RPC) already strips correct_idx/why in SQL;
// stripAnswerKey below exists so nothing in this module ever passes a full
// QuizQuestion through to crew-facing state by accident, even if a future
// change to list_video_quiz's SQL slipped and returned more than it should.

import { supabase } from "./supabase";
import { isMissingFunction, isMissingTable } from "./schemaErrors";
import { isNetworkError } from "./offline/outbox-core";
import { enqueueVideoQuizSubmit } from "./offline/outbox";

/** Author-eyes-only shape: what save_video_quiz_draft sends up and what a
 * supervisor sees while reviewing a draft or an already-approved quiz. */
export interface QuizQuestionFull {
  q: string;
  choices: string[];
  correct_idx: number;
  why: string;
}

/** What a crew member is actually allowed to see before answering — no
 * correct_idx, no why. list_video_quiz never returns more than this. */
export interface QuizQuestionPublic {
  q: string;
  choices: string[];
}

export type QuizStatus = "draft" | "approved";

export interface LearningVideoQuiz {
  id: string;
  video_id: string;
  draft_summary: string | null;
  draft_questions: QuizQuestionFull[];
  questions: QuizQuestionFull[];
  status: QuizStatus;
  generated_at: string;
  approved_by: string | null;
  approved_at: string | null;
}

/** Drop everything but q/choices. Defense in depth alongside list_video_quiz's
 * own SQL-level stripping — see the file header. */
export function stripAnswerKey(q: QuizQuestionFull): QuizQuestionPublic {
  return { q: q.q, choices: q.choices };
}

// --------------------------------------------------------- summarize-learning-video

export interface TranscribeResponse {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  limited?: boolean;
  note?: string | null;
  transcript?: string;
}

/** Whisper on this video's own uploaded file — the Transcribe button, for an
 * uploaded video with nothing typed into the transcript field yet. */
export async function transcribeLearningVideo(videoId: string): Promise<TranscribeResponse> {
  const { data, error } = await supabase.functions.invoke("summarize-learning-video", {
    body: { videoId, action: "transcribe" },
  });
  if (error) throw error;
  return data as TranscribeResponse;
}

export interface GenerateResponse {
  ok: boolean;
  skipped?: boolean;
  limited?: boolean;
  note?: string | null;
  generation: { summary: string; questions: QuizQuestionFull[] } | null;
}

/** One Claude call: a plain-English summary plus a 5-question quiz, grounded
 * only in the given transcript. Compute-only — the caller persists the
 * result as a draft via saveVideoQuizDraft. */
export async function generateVideoQuiz(
  videoId: string,
  title: string,
  transcript: string,
): Promise<GenerateResponse> {
  const { data, error } = await supabase.functions.invoke("summarize-learning-video", {
    body: { videoId, action: "generate", title, transcript },
  });
  if (error) throw error;
  return data as GenerateResponse;
}

// --------------------------------------------------------------------- RPCs

/** Persist summarize-learning-video's raw reading as a draft. Supervisor+. */
export async function saveVideoQuizDraft(
  videoId: string,
  summary: string,
  questions: QuizQuestionFull[],
): Promise<LearningVideoQuiz> {
  const { data, error } = await supabase.rpc("save_video_quiz_draft", {
    p_video_id: videoId,
    p_summary: summary,
    p_questions: questions,
  });
  if (error) throw error;
  return data as LearningVideoQuiz;
}

/** Publish the current draft. Supervisor+. */
export async function approveVideoQuiz(videoId: string): Promise<LearningVideoQuiz> {
  const { data, error } = await supabase.rpc("approve_video_quiz", {
    p_video_id: videoId,
  });
  if (error) throw error;
  return data as LearningVideoQuiz;
}

/**
 * The supervisor-facing read: the full row, correct_idx and all — this is
 * what the video edit form shows while authoring/reviewing a draft or an
 * already-approved quiz. Safe as a direct select: learning_video_quizzes'
 * own RLS ("supervisor read") already gates this to supervisor+, so there is
 * nothing here list_video_quiz needs to protect a second time.
 */
export async function getVideoQuizForAuthor(videoId: string): Promise<LearningVideoQuiz | null> {
  const { data, error } = await supabase
    .from("learning_video_quizzes")
    .select("*")
    .eq("video_id", videoId)
    .maybeSingle();
  if (error) {
    if (isMissingTable(error, "learning_video_quizzes")) return null;
    throw error;
  }
  return (data as LearningVideoQuiz | null) ?? null;
}

/**
 * How many times this installer has already attempted this quiz — the seed
 * shuffleQuiz uses so a retake reshuffles (Q4: "unlimited retakes with
 * reshuffled order"). Own rows only, which is exactly what "own or lead
 * read" already grants an installer reading their own history.
 */
export async function myAttemptCount(videoId: string, profileId: string): Promise<number> {
  const { count, error } = await supabase
    .from("learning_video_quiz_attempts")
    .select("id", { count: "exact", head: true })
    .eq("video_id", videoId)
    .eq("profile_id", profileId);
  if (error) {
    if (isMissingTable(error, "learning_video_quiz_attempts")) return 0;
    throw error;
  }
  return count ?? 0;
}

/**
 * The crew-facing read: approved questions with the answer key stripped, or
 * null when there is no approved quiz yet (draft, never generated) — or when
 * the migration hasn't reached this database yet, which degrades the same
 * way (house law, lib/schemaErrors.ts): the "Take the quiz" button just
 * never appears rather than the video card crashing.
 */
export async function listVideoQuiz(videoId: string): Promise<QuizQuestionPublic[] | null> {
  const { data, error } = await supabase.rpc("list_video_quiz", { p_video_id: videoId });
  if (error) {
    if (isMissingFunction(error) || isMissingTable(error, "learning_video_quizzes")) return null;
    throw error;
  }
  if (!Array.isArray(data)) return null;
  return data.map((q) => stripAnswerKey(q as QuizQuestionFull));
}

/** One scored question, as submit_video_quiz hands it back — only AFTER the
 * whole attempt has been recomputed server-side. Safe to show in full. */
export interface QuizResult {
  correct: boolean;
  correct_idx: number;
  why: string;
}

export interface SubmitVideoQuizResponse {
  score: number;
  passed: boolean;
  points_awarded: number;
  cleared: boolean;
  grants_clearance: string | null;
  results: QuizResult[];
}

export interface SubmitVideoQuizResult {
  /** True when this went into the offline outbox instead of the server —
   * there is no scored result to show yet. */
  queued: boolean;
  data: SubmitVideoQuizResponse | null;
}

/**
 * Submit a completed attempt. Tries the server first — this is what lets an
 * installer see their score immediately — and only queues (the new
 * `video_quiz_submit` outbox op) when the failure looks like no signal
 * (isNetworkError), the same "try direct, fall back to the outbox" shape
 * lib/warehouse/offlineWrites.ts uses for every write made standing where
 * there is no signal. `answers` is five picks, 0-3, in the ORIGINAL
 * (unshuffled) question order — see unshuffleAnswers.
 */
export async function submitVideoQuiz(
  videoId: string,
  answers: number[],
): Promise<SubmitVideoQuizResult> {
  try {
    const { data, error } = await supabase.rpc("submit_video_quiz", {
      p_video_id: videoId,
      p_answers: answers,
    });
    if (error) throw error;
    return { queued: false, data: data as SubmitVideoQuizResponse };
  } catch (err) {
    if (!isNetworkError(err)) throw err;
    await enqueueVideoQuizSubmit({ videoId, answers });
    return { queued: true, data: null };
  }
}

// --------------------------------------------------------- pure: shuffling

/**
 * Deterministic, seedable PRNG (mulberry32). Same seed -> same sequence,
 * every time, on every device — what makes shuffleQuiz testable at all.
 */
function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates, driven by an injected RNG so it can be seeded. */
function seededShuffle<T>(items: T[], rand: () => number): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** One choice, shuffled, remembering where it really lives so a pick can be
 * translated back before it is ever sent to the server. */
export interface ShuffledChoice {
  text: string;
  /** Index into the ORIGINAL (unshuffled) choices array — 0-3. */
  originalChoiceIndex: number;
}

/** One question, shuffled, remembering its original position too. */
export interface ShuffledQuestion {
  /** Index into the ORIGINAL (unshuffled) questions array — what
   * submit_video_quiz's p_answers array is keyed by. */
  originalIndex: number;
  q: string;
  choices: ShuffledChoice[];
}

/**
 * Shuffle both question order and each question's choice order, seeded by
 * the attempt count (retake 1 gets a different order than retake 2,
 * deterministically) so a memorized "it's always C" never works and so this
 * is exactly reproducible in a test. Pure — no RPC, no correct_idx anywhere
 * near it (QuizQuestionPublic never carries one).
 */
export function shuffleQuiz(
  questions: QuizQuestionPublic[],
  attemptSeed: number,
): ShuffledQuestion[] {
  const rand = mulberry32(attemptSeed);
  const order = seededShuffle(
    questions.map((_, i) => i),
    rand,
  );
  return order.map((originalIndex) => {
    const question = questions[originalIndex];
    const choiceOrder = seededShuffle(
      question.choices.map((_, i) => i),
      rand,
    );
    return {
      originalIndex,
      q: question.q,
      choices: choiceOrder.map((originalChoiceIndex) => ({
        text: question.choices[originalChoiceIndex],
        originalChoiceIndex,
      })),
    };
  });
}

/**
 * Turn { originalIndex -> picked original choice index } into the flat,
 * original-question-order array submit_video_quiz's p_answers expects.
 * Throws if any of the 5 original questions has no pick yet — the caller is
 * expected to have already required all five (the "Answer all five before
 * turning it in" guard sentence is enforced twice: here, before a submit is
 * even attempted, and again server-side).
 */
export function buildAnswers(picks: Map<number, number>, questionCount: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < questionCount; i++) {
    const picked = picks.get(i);
    if (picked == null) {
      throw new Error("Answer all five before turning it in.");
    }
    out.push(picked);
  }
  return out;
}

// ------------------------------------------------------------- pure: score

/**
 * Sum the RPC's own per-question verdicts. This is display arithmetic, not a
 * second scorer: by the time `results` exists, submit_video_quiz has already
 * scored the attempt server-side and revealed correct_idx/why for review —
 * there is nothing left to guess. Kept as its own pure function (rather than
 * trusting `data.score` blindly everywhere it is shown) so a parity test can
 * pin down that the two numbers can never legitimately disagree.
 */
export function scoreFromResults(results: QuizResult[]): number {
  return results.filter((r) => r.correct).length;
}

// ---------------------------------------------------- pure: draft/approve

/** The two columns that matter for the state machine below, isolated from
 * the rest of the row so tests can build one without a real uuid in sight. */
export interface QuizDraftState {
  status: QuizStatus;
  draftSummary: string | null;
  draftQuestions: QuizQuestionFull[];
  /** The LIVE, crew-visible set. Untouched by applyGenerate. */
  questions: QuizQuestionFull[];
}

/**
 * What save_video_quiz_draft does to the row, mirrored in TS: a fresh
 * Generate always lands as a new draft (status flips to 'draft' even if the
 * previous generation was already approved) and — Q3's law, the one this
 * function exists to pin down — the LIVE `questions` a crew is currently
 * quizzed on is untouched until the next Approve.
 */
export function applyGenerate(
  prev: QuizDraftState | null,
  summary: string,
  questions: QuizQuestionFull[],
): QuizDraftState {
  return {
    status: "draft",
    draftSummary: summary,
    draftQuestions: questions,
    questions: prev?.questions ?? [],
  };
}

/**
 * What approve_video_quiz does to the row, mirrored in TS: the draft is
 * copied onto the live, crew-visible columns and status flips to approved.
 */
export function applyApprove(prev: QuizDraftState): QuizDraftState {
  return {
    status: "approved",
    draftSummary: prev.draftSummary,
    draftQuestions: prev.draftQuestions,
    questions: prev.draftQuestions,
  };
}
