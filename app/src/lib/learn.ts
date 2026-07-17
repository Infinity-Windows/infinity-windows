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
