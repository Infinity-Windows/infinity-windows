// Standalone Studio projects + the one list that shows BOTH kinds of model:
// blank/linked rows from `studio_projects`, and the job-attached models that
// already live in project_plan_outlines.features.modelstudio. "Linked but
// independent" (owner pick): a blank project can gain a job later; a job
// model keeps living on its outline so Publish/Revert stay untouched.

import { supabase } from "../supabase";
import { isMissingTable } from "../schemaErrors";
import type { RoofStyle } from "./floors";
import { fitviewModel, humanTraceModel } from "../fitview/adapter";

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

/**
 * B1 (wave V-B): where a job's model stands, derived from what actually
 * exists rather than stored as its own field — "not_started" (no trace, no
 * Studio model), "seeded" (a trace or a saved Studio model, never
 * published), "published" (Studio has Submitted at least once). See
 * deriveJobModelState.
 */
export type JobModelState = "not_started" | "seeded" | "published";

/** One row in the Studio list, whichever store it lives in. */
export interface StudioWorkspace {
  /** Editor route id: standalone rows use their uuid, job models "j-<projectId>". */
  key: string;
  kind: "standalone" | "job";
  name: string;
  jobCode: string | null;
  projectId: string | null;
  savedAt: string | null;
  /** Undefined only for a standalone project with no linked job — there is
   * no map/model pipeline to report a state for. */
  state?: JobModelState;
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

/**
 * PURE (B1): which state one job's model is in, from every outline row its
 * plans have produced. Published beats seeded beats not-started — a job
 * with one traced page and one Studio-published page reads as published,
 * the state a crew actually cares about.
 *
 * The three states read off two independent facts, both already on the
 * outline row: humanTraceModel (a trace was Submitted) and
 * jobModelFromFeatures (a Studio model was saved). "Published" is the one
 * that needs the adapter's own distinction — buildFitviewModelFromStudio
 * (toFitview.ts) never writes a `building.trace`, so a `fitview.model` with
 * no trace can only be Studio's own Submit-final output; the BLACK22 echo
 * comment on humanTraceModel is the same fact this reads in reverse.
 */
export function deriveJobModelState(featuresList: unknown[]): JobModelState {
  let seeded = false;
  for (const features of featuresList) {
    const model = fitviewModel(features);
    const traced = humanTraceModel(features) !== null;
    if (model && !traced) return "published";
    if (traced || jobModelFromFeatures(features)) seeded = true;
  }
  return seeded ? "seeded" : "not_started";
}

/**
 * One query, no N+1 (B1): every plan-outline row's project + features,
 * reduced client-side to one state per project. Feeds Studio's home list —
 * EVERY active job gets a chip, not just the ones with a saved model.
 */
export async function listJobModelStates(): Promise<Map<string, JobModelState>> {
  const { data, error } = await supabase
    .from("project_plan_outlines")
    .select("project_id, features");
  if (error) {
    if (isMissingTable(error, "project_plan_outlines")) return new Map();
    throw error;
  }
  const byProject = new Map<string, unknown[]>();
  for (const r of (data ?? []) as { project_id: string; features: unknown }[]) {
    const list = byProject.get(r.project_id) ?? [];
    list.push(r.features);
    byProject.set(r.project_id, list);
  }
  const out = new Map<string, JobModelState>();
  for (const [projectId, featuresList] of byProject) {
    out.set(projectId, deriveJobModelState(featuresList));
  }
  return out;
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

/** Enough of a project row to name a Studio workspace after it. */
export interface WorkspaceProject {
  id: string;
  job_code: string;
  name: string;
}

/**
 * PURE union for the list page: standalone rows first (newest saved first),
 * then every job not already represented by a linked standalone row — a
 * linked row IS that job's studio presence, listing both would read as two
 * models when there is one authoring surface.
 *
 * B1 (wave V-B): `activeProjects` is EVERY active job, not just ones with a
 * saved model — Studio's home used to only list jobs someone had already
 * seeded, so a fresh job had no door in at all. `jobModels` still covers
 * the one case `activeProjects` can't: a finished/cancelled job that kept
 * an earlier Studio model, which stays visible rather than orphaned.
 */
export function buildWorkspaces(
  standalone: StudioProjectRow[],
  jobModels: JobModelRow[],
  activeProjects: WorkspaceProject[],
  jobModelStates: Map<string, JobModelState>,
): StudioWorkspace[] {
  const out: StudioWorkspace[] = [];
  const linkedJobs = new Set<string>();
  const projectsById = new Map(activeProjects.map((p) => [p.id, p]));
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
      state: row.project_id
        ? jobModelStates.get(row.project_id) ?? "not_started"
        : undefined,
    });
  }
  // Jobs a model already exists for (any job status) — the pre-B1 list,
  // kept so a finished job's model is never orphaned.
  const seenJobIds = new Set<string>();
  for (const jm of jobModels) {
    if (linkedJobs.has(jm.project_id)) continue;
    seenJobIds.add(jm.project_id);
    const job = projectsById.get(jm.project_id);
    out.push({
      key: `j-${jm.project_id}`,
      kind: "job",
      name: job ? `${job.job_code} — ${job.name}` : "Job model",
      jobCode: job?.job_code ?? null,
      projectId: jm.project_id,
      savedAt: jm.savedAt,
      state: jobModelStates.get(jm.project_id) ?? "seeded",
    });
  }
  // B1: every remaining active job, model or not — "not started" included.
  for (const project of activeProjects) {
    if (linkedJobs.has(project.id) || seenJobIds.has(project.id)) continue;
    out.push({
      key: `j-${project.id}`,
      kind: "job",
      name: `${project.job_code} — ${project.name}`,
      jobCode: project.job_code,
      projectId: project.id,
      savedAt: null,
      state: jobModelStates.get(project.id) ?? "not_started",
    });
  }
  return out.sort((a, b) => (b.savedAt ?? "").localeCompare(a.savedAt ?? ""));
}
