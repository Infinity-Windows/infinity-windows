import { supabase } from "./supabase";
import { isMissingFunction } from "./schemaErrors";

/**
 * Lesson write-ups waiting with me by name, for the in-app notification feed
 * (hex_learning_waiting, 20261026000000). One row per write-up and revision:
 * a forward or a new revision is a new notice; a retried tap is not. Kept apart
 * from lib/hexLearning so the feed does not load the Ask-only learning code.
 * Before the migration reaches the server the feed simply has no such rows.
 */
export interface WaitingReview { id: string; revision: number; job_code: string | null; unit_label: string; author: string | null }
export async function listWaitingReviews(): Promise<WaitingReview[]> {
  const { data, error } = await supabase.rpc("hex_learning_waiting");
  if (error) {
    if (isMissingFunction(error)) return [];
    throw error;
  }
  return (data ?? []) as WaitingReview[];
}
