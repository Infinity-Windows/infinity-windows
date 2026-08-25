// The suggestions tab's little api: one query serves everyone — RLS hands
// installers their own reports and owners the whole list.
import { supabase } from "./supabase";

export interface AppFeedback {
  id: string;
  author: string | null;
  kind: "bug" | "idea";
  body: string;
  status: "open" | "resolved";
  created_at: string;
}

export async function listAppFeedback(): Promise<AppFeedback[]> {
  const { data, error } = await supabase
    .from("app_feedback")
    .select("id, author, kind, body, status, created_at")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as AppFeedback[];
}

export async function submitAppFeedback(
  kind: "bug" | "idea",
  body: string,
): Promise<void> {
  const { data: auth } = await supabase.auth.getUser();
  const { error } = await supabase.from("app_feedback").insert({
    author: auth.user?.id,
    kind,
    body,
  });
  if (error) throw error;
}

export async function resolveAppFeedback(id: string): Promise<void> {
  const { data: auth } = await supabase.auth.getUser();
  const { error } = await supabase
    .from("app_feedback")
    .update({
      status: "resolved",
      resolved_by: auth.user?.id,
      resolved_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (error) throw error;
}
