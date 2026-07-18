import { supabase } from "./supabase";
import { listIssues } from "./issues";

/**
 * Supervisor "Heartbeat": one glance (~10s) at the live pulse of every active
 * project. Per-installer current task + how long, anomaly flags, per-project %
 * complete, open-issue counts (Phase 2 issues model), and a supervisor-controlled
 * green light.
 */

/**
 * A running task is "anomalous" when it has been going noticeably longer than the
 * learned median for its window type. Tune the multiple here.
 */
export const ANOMALY_THRESHOLD = 2.0;

/**
 * Pure anomaly decision (unit-tested): a task is flagged when we have a positive
 * median and the elapsed time exceeds it by the threshold multiple. No median →
 * no anomaly (we never guess).
 */
export function isAnomaly(
  elapsedSec: number,
  medianSec: number | null | undefined,
  threshold: number = ANOMALY_THRESHOLD,
): boolean {
  if (medianSec == null || medianSec <= 0) return false;
  return elapsedSec > medianSec * threshold;
}

export interface HeartbeatTask {
  openingId: string;
  projectId: string;
  installerName: string;
  openingLabel: string;
  /** Seconds since work_started_at, snapshotted at fetch (UI re-ticks live). */
  elapsedSec: number;
  /** Expected duration in seconds (median_minutes * 60), or null if unknown. */
  medianSec: number | null;
  anomaly: boolean;
}

export interface HeartbeatProject {
  id: string;
  name: string;
  jobCode: string;
  /** % of openings installed. */
  pct: number;
  installed: number;
  total: number;
  greenLight: boolean;
  greenLightNote: string | null;
  openIssues: number;
  activeTasks: HeartbeatTask[];
}

export interface HeartbeatSnapshot {
  projects: HeartbeatProject[];
  /** ISO time the snapshot was computed (elapsed timers tick from here). */
  generatedAt: string;
}

interface ProjectRow {
  id: string;
  job_code: string;
  name: string | null;
  green_light: boolean | null;
  green_light_note: string | null;
}

interface OpeningRow {
  id: string;
  project_id: string;
  opening_code: string;
  label: string | null;
  status: string;
  work_started_at: string | null;
  assignee: { display_name: string | null } | null;
  window_types: { median_minutes: number | null } | null;
}

/**
 * Aggregate the live pulse across ACTIVE projects. Supervisor+ only (the page
 * route guards it, and list_issues is itself foreman+ guarded server-side).
 */
export async function getHeartbeat(): Promise<HeartbeatSnapshot> {
  const now = Date.now();

  const projRes = await supabase
    .from("projects")
    .select("id, job_code, name, green_light, green_light_note")
    .eq("status", "active")
    .order("job_code");
  if (projRes.error) throw projRes.error;
  const projects = (projRes.data ?? []) as ProjectRow[];
  const activeIds = projects.map((p) => p.id);

  // No active jobs → nothing to show.
  if (activeIds.length === 0) {
    return { projects: [], generatedAt: new Date(now).toISOString() };
  }

  const openRes = await supabase
    .from("project_openings")
    .select(
      "id, project_id, opening_code, label, status, work_started_at, assignee:assigned_to(display_name), window_types(median_minutes)",
    )
    .in("project_id", activeIds);
  if (openRes.error) throw openRes.error;
  const openings = (openRes.data ?? []) as unknown as OpeningRow[];

  // Open-issue counts per project (Phase 2 model; foreman+ guarded server-side).
  const openIssuesByProject = new Map<string, number>();
  try {
    const issues = await listIssues();
    for (const i of issues) {
      if (i.status !== "open") continue;
      openIssuesByProject.set(
        i.project_id,
        (openIssuesByProject.get(i.project_id) ?? 0) + 1,
      );
    }
  } catch {
    // If issues are unavailable, the board still renders without counts.
  }

  // Per-project opening tallies for % complete.
  const tally = new Map<string, { installed: number; total: number }>();
  for (const o of openings) {
    const t = tally.get(o.project_id) ?? { installed: 0, total: 0 };
    t.total += 1;
    if (o.status === "installed") t.installed += 1;
    tally.set(o.project_id, t);
  }

  // "Who is on what right now": in-progress openings across all active jobs.
  const tasksByProject = new Map<string, HeartbeatTask[]>();
  for (const o of openings) {
    if (!o.work_started_at || o.status === "installed") continue;
    const startedMs = new Date(o.work_started_at).getTime();
    if (Number.isNaN(startedMs)) continue;
    const elapsedSec = Math.max(0, Math.round((now - startedMs) / 1000));
    const medianMin = o.window_types?.median_minutes ?? null;
    const medianSec = medianMin != null ? medianMin * 60 : null;
    const task: HeartbeatTask = {
      openingId: o.id,
      projectId: o.project_id,
      installerName: o.assignee?.display_name ?? "Unassigned",
      openingLabel: o.label || o.opening_code,
      elapsedSec,
      medianSec,
      anomaly: isAnomaly(elapsedSec, medianSec),
    };
    const arr = tasksByProject.get(o.project_id) ?? [];
    arr.push(task);
    tasksByProject.set(o.project_id, arr);
  }

  const shaped: HeartbeatProject[] = projects.map((p) => {
    const t = tally.get(p.id) ?? { installed: 0, total: 0 };
    const pct = t.total > 0 ? Math.round((t.installed / t.total) * 100) : 0;
    const activeTasks = (tasksByProject.get(p.id) ?? []).sort((a, b) => {
      // Anomalies first, then longest-running.
      if (a.anomaly !== b.anomaly) return a.anomaly ? -1 : 1;
      return b.elapsedSec - a.elapsedSec;
    });
    return {
      id: p.id,
      name: p.name || p.job_code,
      jobCode: p.job_code,
      pct,
      installed: t.installed,
      total: t.total,
      greenLight: !!p.green_light,
      greenLightNote: p.green_light_note ?? null,
      openIssues: openIssuesByProject.get(p.id) ?? 0,
      activeTasks,
    };
  });

  return { projects: shaped, generatedAt: new Date(now).toISOString() };
}

/** Supervisor+ toggles a project's green light (guarded in-RPC). */
export async function setProjectGreenLight(
  projectId: string,
  on: boolean,
  note?: string | null,
): Promise<void> {
  const { error } = await supabase.rpc("set_project_green_light", {
    p_project: projectId,
    p_on: on,
    p_note: note ?? null,
  });
  if (error) throw error;
}
