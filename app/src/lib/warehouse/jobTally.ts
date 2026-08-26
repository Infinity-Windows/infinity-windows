// Per-job unit tallies (owner ask, 2026-08-26): "Mad Moose 20/22, 2
// remaining." A UNIT is a window or door — a distinct mark — not a box; a
// 7-piece window is one unit however many packages carry it. "Logged" means
// at least one of the unit's packages has physically arrived (scanned past
// minted); "remaining" is what the manifest still owes.
//
// Pure over already-fetched rows, same contract as find.ts: the page holds
// the queries, this holds the arithmetic.

import type { StoragePackage } from "../storage";

export interface JobTally {
  /** A real job's id, or null for a waiting job known only by name. */
  projectId: string | null;
  /** Job code for built jobs; the typed name for waiting ones. */
  label: string;
  totalUnits: number;
  loggedUnits: number;
  remainingUnits: number;
}

const markOf = (p: StoragePackage): string | null =>
  (p.package_marks ?? [])[0]?.mark_code ?? p.mfr_mark ?? null;

/**
 * Tallies for every job with any non-blank material. Crate-supply pool rows
 * with no mark ride along in the crates but are not windows — they never
 * count as units.
 */
export function jobTallies(
  packages: StoragePackage[],
  jobCodeById: Map<string, string>,
): JobTally[] {
  const jobs = new Map<
    string,
    { projectId: string | null; label: string; total: Set<string>; logged: Set<string> }
  >();
  for (const p of packages) {
    if (p.status === "blank") continue;
    const mark = markOf(p);
    if (!mark) continue;
    const key = p.project_id ?? (p.pending_job_name ? `pending:${p.pending_job_name}` : null);
    if (!key) continue; // true Boneyard: ownerless stock is not a job's unit
    let job = jobs.get(key);
    if (!job) {
      job = {
        projectId: p.project_id,
        label: p.project_id
          ? (jobCodeById.get(p.project_id) ?? "job not listed")
          : (p.pending_job_name as string),
        total: new Set(),
        logged: new Set(),
      };
      jobs.set(key, job);
    }
    job.total.add(mark);
    if (p.status !== "minted") job.logged.add(mark);
  }
  return [...jobs.values()]
    .map((j) => ({
      projectId: j.projectId,
      label: j.label,
      totalUnits: j.total.size,
      loggedUnits: j.logged.size,
      remainingUnits: j.total.size - j.logged.size,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** "20/22 · 2 remaining" — the owner's exact phrasing; "all 22 here" when done. */
export function tallyLine(t: JobTally): string {
  if (t.remainingUnits === 0) return `all ${t.totalUnits} here`;
  return `${t.loggedUnits}/${t.totalUnits} · ${t.remainingUnits} remaining`;
}
