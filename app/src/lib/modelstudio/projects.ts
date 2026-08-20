// Standalone Studio projects + the one list that shows BOTH kinds of model:
// blank/linked rows from `studio_projects`, and the job-attached models that
// already live in project_plan_outlines.features.modelstudio. "Linked but
// independent" (owner pick): a blank project can gain a job later; a job
// model keeps living on its outline so Publish/Revert stay untouched.

import { supabase } from "../supabase";
import { isMissingTable } from "../schemaErrors";
import type { RoofStyle } from "./floors";

export interface StudioProjectRow {
  id: string;
  name: string;
  project_id: string | null;
  model: { serialized?: string; savedAt?: string; floors?: string[]; roof?: RoofStyle } | null;
  archived: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/** One row in the Studio list, whichever store it lives in. */
export interface StudioWorkspace {
  /** Editor route id: standalone rows use their uuid, job models "j-<projectId>". */
  key: string;
  kind: "standalone" | "job";
  name: string;
  jobCode: string | null;
  projectId: string | null;
  savedAt: string | null;
}

export async function listStudioProjectRows(): Promise<StudioProjectRow[]> {
  const { data, error } = await supabase
    .from("studio_projects")
    .select("*")
    .eq("archived", false)
    .order("updated_at", { ascending: false });
  if (error) {
    if (isMissingTable(error, "studio_projects")) return [];
    throw error;
  }
  return (data ?? []) as StudioProjectRow[];
}

export async function getStudioProject(id: string): Promise<StudioProjectRow | null> {
  const { data, error } = await supabase
    .from("studio_projects")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) {
    if (isMissingTable(error, "studio_projects")) return null;
    throw error;
  }
  return (data as StudioProjectRow) ?? null;
}

export async function saveStudioProject(input: {
  id?: string | null;
  name: string;
  projectId?: string | null;
  model?: { serialized: string; savedAt: string; floors?: string[]; roof?: RoofStyle } | null;
  archived?: boolean;
}): Promise<StudioProjectRow> {
  const { data, error } = await supabase.rpc("save_studio_project", {
    p_id: input.id ?? null,
    p_name: input.name,
    p_project: input.projectId ?? null,
    p_model: input.model ?? null,
    p_archived: input.archived ?? false,
  });
  if (error) throw error;
  return data as StudioProjectRow;
}

interface JobModelRow {
  project_id: string;
  savedAt: string | null;
}

/**
 * The Studio model saved on a job's plan outline (features.modelstudio),
 * read the same way for every consumer: ModelStudio.tsx (a job source),
 * JobModelViewer.tsx (the phone-friendly read-only viewer) and the
 * jobModelCache offline fallback. A lone `serialized` string is a
 * one-floor building; `floors` carries multi-story saves (floor 0 mirrors
 * `serialized` for old readers).
 */
export interface JobModel {
  serialized?: string;
  floors?: string[];
  savedAt?: string | null;
  /** Building-wide roof choice (Studio 100x #49) — see floors.ts's
   * parseRoof for the "absent/unrecognized = none" fallback every reader
   * should use rather than trusting this field raw. */
  roof?: RoofStyle;
}

/**
 * Pull the Studio model off a plan-outline row's `features`, or null when
 * the job has never had one saved. PURE — drives both what JobModelViewer
 * loads and whether Maps Interactive shows the "Walk the 3D model" door.
 */
export function jobModelFromFeatures(features: unknown): JobModel | null {
  if (!features || typeof features !== "object") return null;
  const m = (features as { modelstudio?: unknown }).modelstudio;
  if (!m || typeof m !== "object") return null;
  const model = m as JobModel;
  if (!model.serialized && !(model.floors && model.floors.length > 0)) return null;
  return model;
}

/** Jobs whose outline carries a saved Studio model. */
export async function listJobModelRows(): Promise<JobModelRow[]> {
  const { data, error } = await supabase
    .from("project_plan_outlines")
    .select("project_id, features")
    .not("features->modelstudio", "is", null);
  if (error) {
    if (isMissingTable(error, "project_plan_outlines")) return [];
    throw error;
  }
  const rows: JobModelRow[] = [];
  for (const r of (data ?? []) as { project_id: string; features: unknown }[]) {
    const saved = (r.features as { modelstudio?: { savedAt?: string } } | null)
      ?.modelstudio;
    if (saved) rows.push({ project_id: r.project_id, savedAt: saved.savedAt ?? null });
  }
  return rows;
}

/**
 * PURE union for the list page: standalone rows first (newest saved first),
 * then job models not already represented by a linked standalone row —
 * a linked row IS that job's studio presence, listing both would read as
 * two models when there is one authoring surface.
 */
export function buildWorkspaces(
  standalone: StudioProjectRow[],
  jobModels: JobModelRow[],
  projectsById: Map<string, { job_code: string; name: string }>,
): StudioWorkspace[] {
  const out: StudioWorkspace[] = [];
  const linkedJobs = new Set<string>();
  for (const row of standalone) {
    if (row.project_id) linkedJobs.add(row.project_id);
    const job = row.project_id ? projectsById.get(row.project_id) : null;
    out.push({
      key: row.id,
      kind: "standalone",
      name: row.name,
      jobCode: job?.job_code ?? null,
      projectId: row.project_id,
      savedAt: row.model?.savedAt ?? row.updated_at,
    });
  }
  for (const jm of jobModels) {
    if (linkedJobs.has(jm.project_id)) continue;
    const job = projectsById.get(jm.project_id);
    out.push({
      key: `j-${jm.project_id}`,
      kind: "job",
      name: job ? `${job.job_code} — ${job.name}` : "Job model",
      jobCode: job?.job_code ?? null,
      projectId: jm.project_id,
      savedAt: jm.savedAt,
    });
  }
  return out.sort((a, b) => (b.savedAt ?? "").localeCompare(a.savedAt ?? ""));
}
