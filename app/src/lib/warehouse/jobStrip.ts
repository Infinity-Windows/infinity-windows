// Jobs on the yard (the "Jobs with material" tally, reimagined — owner ask
// 2026-09-06): the same per-job unit count, drawn as a chip in the job's own
// colour with a fill bar, and tied to the picture — tapping a job lights up
// the boxes holding its material. Pure over the tallies and the packages.

import { containerHue, type StoragePackage } from "../storage";
import type { JobTally } from "./jobTally";

export interface JobChip {
  key: string;
  projectId: string | null;
  pendingName: string | null;
  label: string;
  /** 0–359, the same hue the yard stripes this job with. */
  hue: number;
  here: number;
  total: number;
  /** Every expected unit has at least one piece on hand. */
  ready: boolean;
  /** "27/27" or "20/22 · 2 to come". */
  line: string;
}

export function jobChips(tallies: readonly JobTally[]): JobChip[] {
  return tallies.map((t) => ({
    key: t.projectId ?? `pending:${t.label}`,
    projectId: t.projectId,
    pendingName: t.projectId ? null : t.label,
    label: t.label,
    hue: containerHue(t.label),
    here: t.loggedUnits,
    total: t.totalUnits,
    ready: t.remainingUnits === 0,
    line:
      t.remainingUnits === 0
        ? `${t.totalUnits}/${t.totalUnits}`
        : `${t.loggedUnits}/${t.totalUnits} · ${t.remainingUnits} to come`,
  }));
}

/** The boxes holding a job's stored material — what lights up on the yard
 *  when its chip is tapped. A crate inside a conex lights both (the yard
 *  already lifts a lit crate to its parent). */
export function boxesForJob(
  chip: Pick<JobChip, "projectId" | "pendingName">,
  packages: readonly StoragePackage[],
): Set<string> {
  const out = new Set<string>();
  for (const p of packages) {
    if (p.status !== "stored" || !p.container_id) continue;
    const mine = chip.projectId
      ? p.project_id === chip.projectId
      : p.project_id == null && p.pending_job_name === chip.pendingName;
    if (mine) out.add(p.container_id);
  }
  return out;
}
