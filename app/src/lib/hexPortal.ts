import { supabase } from "./supabase";
import { enqueue } from "./offline/outbox";
export interface PortalSource {
  id: string;
  title: string;
  kind: "hex-portal" | "reference";
  revision?: number;
}
export interface PortalGuidance {
  id: string;
  revision: number;
  title: string;
  answer: string;
  applicability: string;
  evidence: string;
  reviewBy: string;
}
export interface LearningDraft {
  actorId: string;
  projectId: string;
  unitLabel: string;
  question: string;
  answer: string;
  sources: PortalSource[];
}
export interface LearningCase {
  id: string;
  project_id: string;
  asker_id: string;
  unit_label: string;
  question: string;
  answer: string;
  created_at: string;
  hex_portal_outcomes: {
    id: string;
    outcome: "resolved" | "needs-help";
    explanation: string;
    created_at: string;
  }[];
}
export async function findPortalGuidance(
  projectId: string,
  question: string,
): Promise<{ enabled: boolean; items: PortalGuidance[]; notice?: string }> {
  const { data, error } = await supabase.functions.invoke("hex-portal", {
    body: { projectId, question },
    signal: AbortSignal.timeout(15000),
  });
  if (error) throw error;
  if (!data || typeof data.enabled !== "boolean" || !Array.isArray(data.items))
    throw new Error("Guidance is unavailable");
  return data;
}
export async function saveLearningCase(d: LearningDraft, id: string) {
  return enqueue({
    op: "hex_portal_case",
    payload: {
      actorId: d.actorId,
      args: {
        p_id: id,
        p_project_id: d.projectId,
        p_unit_label: d.unitLabel,
        p_question: d.question,
        p_answer: d.answer,
        p_sources: d.sources.slice(0, 12),
      },
    },
  });
}
export async function saveLearningOutcome(
  actorId: string,
  caseId: string,
  outcome: "resolved" | "needs-help",
  explanation: string,
  id: string,
  dependsOn?: string,
) {
  return enqueue({
    op: "hex_portal_outcome",
    dependsOn,
    payload: {
      actorId,
      args: {
        p_id: id,
        p_case_id: caseId,
        p_outcome: outcome,
        p_explanation: explanation,
      },
    },
  });
}
export async function listLearningCases(projectId: string, actorId: string) {
  const { data, error } = await supabase
    .from("hex_portal_cases")
    .select(
      "id,project_id,asker_id,unit_label,question,answer,created_at,hex_portal_outcomes(id,outcome,explanation,created_at)",
    )
    .eq("project_id", projectId)
    .eq("asker_id", actorId)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw error;
  return data as LearningCase[];
}
