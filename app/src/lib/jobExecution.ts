import { supabase } from "./supabase";
import { isMissingTable } from "./schemaErrors";

export const JOB_STAGES = [
  ["material_delivered", "Material Delivered"], ["material_onsite", "Material Onsite"],
  ["ros_checked", "RO's Checked"], ["ros_flashed", "RO's Flashed"],
  ["frames_set", "Frames Set"], ["glass_doors_installed", "Glass/Doors Installed"],
  ["hardware_installed", "Hardware Installed"], ["detail_work", "Detail Work"],
  ["qc_passed", "QC Passed"], ["customer_approved", "Customer Approved"],
] as const;
export interface LaborTarget {
  project_id: string; projected_hours: number | null; goal_hours: number | null;
  square_feet: number | null; revision: number; updated_at: string;
}
export interface JobStage {
  project_id: string; stage_key: string; completed: boolean; note: string;
  revision: number; updated_at: string;
}
export interface LaborJob { id: string; name: string; job_code: string; status: string; is_test: boolean }
async function completeRows<T>(fetchPage: (offset: number) => PromiseLike<{ data: unknown; error: unknown; count: number | null }>): Promise<T[]> {
  const rows: T[] = [];
  let expected: number | null = null;
  for (let page = 0; page < 1000; page++) {
    const { data, error, count } = await fetchPage(rows.length);
    if (error) throw error;
    if (count === null || (expected !== null && expected !== count)) throw new Error("Job records changed while loading. Please refresh.");
    expected = count;
    const batch = (data ?? []) as T[];
    if (!batch.length && rows.length < count) throw new Error("Could not load the complete job list.");
    rows.push(...batch);
    if (rows.length >= count) return rows;
  }
  throw new Error("This report is too large to load completely.");
}
export async function getLaborJobs(): Promise<LaborJob[]> {
  return completeRows<LaborJob>((offset) => supabase.from("projects")
    .select("id,name,job_code,status,is_test", { count: "exact" }).is("deleted_at", null)
    .order("id").range(offset, offset + 499));
}
export async function getLaborTargets(): Promise<LaborTarget[]> {
  try {
    return await completeRows<LaborTarget>((offset) => supabase.from("project_labor_targets")
      .select("project_id,projected_hours,goal_hours,square_feet,revision,updated_at", { count: "exact" })
      .order("project_id").range(offset, offset + 499));
  } catch (error) {
    if (isMissingTable(error)) throw new Error("Job labor targets need the database update before they can be used.");
    throw error;
  }
}
export async function getJobStages(projectId: string): Promise<JobStage[]> {
  const { data, error } = await supabase.from("project_stage_progress")
    .select("project_id,stage_key,completed,note,revision,updated_at").eq("project_id", projectId);
  if (isMissingTable(error)) throw new Error("Job stages need the database update before they can be used.");
  if (error) throw error;
  return data ?? [];
}
export function optionalPositive(value: string): number | null {
  if (!value.trim()) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error("Enter a positive number, or leave the field blank.");
  return n;
}
export function laborVariance(actual: number, expected: number | null | undefined): number | null {
  return expected != null && Number.isFinite(expected) && expected > 0 && Number.isFinite(actual)
    ? (actual - expected) / expected * 100 : null;
}
export async function saveLaborTargets(projectId: string, target: Pick<LaborTarget, "projected_hours" | "goal_hours" | "square_feet">, revision: number, reason: string) {
  const { error } = await supabase.rpc("set_project_labor_targets", { p_project_id: projectId,
    p_projected_hours: target.projected_hours, p_goal_hours: target.goal_hours,
    p_square_feet: target.square_feet, p_revision: revision, p_reason: reason });
  if (error) throw error;
}
export async function saveJobStage(projectId: string, stageKey: string, completed: boolean, note: string, revision: number) {
  const { error } = await supabase.rpc("set_project_stage", { p_project_id: projectId,
    p_stage_key: stageKey, p_completed: completed, p_note: note, p_revision: revision });
  if (error) throw error;
}
