// The suggestions tab's little api: one query serves everyone — RLS hands
// installers their own reports and owners the whole list.
import { supabase } from "./supabase";
import { isMissingColumn } from "./schemaErrors";

export type AppFeedbackCategory = "app" | "ai";

export interface AppFeedback {
  id: string;
  author: string | null;
  kind: "bug" | "idea";
  body: string;
  status: "open" | "resolved";
  created_at: string;
  category?: AppFeedbackCategory;
  resolution_note?: string | null;
}

export async function listAppFeedback(): Promise<AppFeedback[]> {
  const { data, error } = await supabase
    .from("app_feedback")
    .select("id, author, kind, body, status, created_at, category, resolution_note")
    .order("created_at", { ascending: false });
  if (error && isMissingColumn(error)) {
    const legacy = await supabase.from("app_feedback")
      .select("id, author, kind, body, status, created_at")
      .order("created_at", { ascending: false });
    if (legacy.error) throw legacy.error;
    return (legacy.data ?? []) as AppFeedback[];
  }
  if (error) throw error;
  return (data ?? []) as AppFeedback[];
}

export async function submitAppFeedback(
  kind: "bug" | "idea",
  body: string,
  options?: { category?: AppFeedbackCategory; actorId?: string },
): Promise<void> {
  const { data: auth, error: authError } = await supabase.auth.getUser();
  if (authError) throw authError;
  if (!auth.user || (options?.actorId && auth.user.id !== options.actorId))
    throw new Error("Your sign-in changed. Open Ask again before sending this report.");
  const { error } = await supabase.from("app_feedback").insert({
    author: auth.user.id,
    kind,
    body,
    ...(options?.category ? { category: options.category } : {}),
  });
  if (error) throw error;
}

export async function resolveAppFeedback(id: string, resolutionNote?: string): Promise<void> {
  const { data: auth, error: authError } = await supabase.auth.getUser();
  if (authError) throw authError;
  if (!auth.user) throw new Error("Sign in before resolving a report.");
  const { error } = await supabase
    .from("app_feedback")
    .update({
      status: "resolved",
      resolved_by: auth.user?.id,
      resolved_at: new Date().toISOString(),
      ...(resolutionNote?.trim() ? { resolution_note: resolutionNote.trim() } : {}),
    })
    .eq("id", id)
    .select("id, status")
    .single();
  if (error) throw error;
}
