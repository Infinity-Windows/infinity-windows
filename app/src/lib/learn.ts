import { supabase } from "./supabase";
import { dueDateFor, nextBox, type CardProgress, type Grade } from "./glossary";

export async function listMyProgress(profileId: string): Promise<CardProgress[]> {
  const { data, error } = await supabase
    .from("learn_progress")
    .select("term_id, box, due")
    .eq("profile_id", profileId);
  if (error) throw error;
  return (data ?? []) as CardProgress[];
}

export async function recordCard(
  profileId: string,
  termId: string,
  currentBox: number,
  grade: Grade,
): Promise<void> {
  const box = nextBox(currentBox, grade);
  const due = dueDateFor(box);
  const { error } = await supabase.from("learn_progress").upsert(
    {
      profile_id: profileId,
      term_id: termId,
      box,
      due,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "profile_id,term_id" },
  );
  if (error) throw error;
}

export async function listPriorityTerms(): Promise<string[]> {
  const { data, error } = await supabase
    .from("learn_priority_terms")
    .select("term_id");
  if (error) throw error;
  return (data ?? []).map((r) => r.term_id as string);
}

export async function addPriorityTerm(termId: string, reason?: string): Promise<void> {
  const { error } = await supabase
    .from("learn_priority_terms")
    .upsert({ term_id: termId, reason: reason ?? null }, { onConflict: "term_id" });
  if (error) throw error;
}

// --- Learn-tab points: new content only (2026-09-05) ---
//
// The Education quizzes used to write their own points into the ledger from the
// browser after every round, with no record of which terms were asked — so
// "Another round" paid for the same five terms as many times as somebody cared
// to tap it, and two profiles ran up a year's worth of points in a day. Points
// are now
// awarded by award_education_quiz (20260991000000), which pays for a glossary
// term the FIRST time a person answers it correctly and never again.
//
// Practising is deliberately still free: the round runs exactly as it did, the
// button is still there, and the only thing that changed is what it is worth.

/** The item key the server knows a glossary term by. */
export function educationTermKey(termId: string): string {
  return `term:${termId}`;
}

/** The whole install-sequence quiz is one item, earned once. */
export const EDUCATION_SEQUENCE_KEY = "seq:install";

/** One question of a finished round: what was asked, and whether they got it. */
export interface EducationQuizItem {
  key: string;
  correct: boolean;
}

/** What the round was worth, as the server scored it. */
export interface EducationQuizResult {
  pointsAwarded: number;
  newTerms: number;
  alreadyHad: number;
}

/**
 * File a finished round and get back what it earned.
 *
 * The client sends WHAT WAS ASKED, not a total — the points are the server's
 * arithmetic, off its own list of items and its own record of what this person
 * has already been credited for. A key the server has never heard of pays
 * nothing, which is what keeps the lifetime ceiling real.
 */
export async function awardEducationQuiz(
  items: EducationQuizItem[],
): Promise<EducationQuizResult> {
  const { data, error } = await supabase.rpc("award_education_quiz", {
    p_items: items,
  });
  if (error) throw error;
  const row = (data ?? {}) as Record<string, unknown>;
  return {
    pointsAwarded: Number(row.points_awarded ?? 0),
    newTerms: Number(row.new_terms ?? 0),
    alreadyHad: Number(row.already_had ?? 0),
  };
}

/** The caller's own standing on the Learn tab, for the "Earned N of M" line. */
export interface EducationProgress {
  termsEarned: number;
  termsTotal: number;
  sequenceDone: boolean;
}

export async function getEducationProgress(): Promise<EducationProgress> {
  const { data, error } = await supabase.rpc("my_education_progress");
  if (error) throw error;
  const row = (data ?? {}) as Record<string, unknown>;
  return {
    termsEarned: Number(row.terms_earned ?? 0),
    termsTotal: Number(row.terms_total ?? 0),
    sequenceDone: Boolean(row.sequence_done ?? false),
  };
}
