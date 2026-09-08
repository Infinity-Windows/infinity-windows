// Jobs on the yard (the "Jobs with material" tally, reimagined — owner ask
// 2026-09-06): the same per-job unit count, drawn as a chip in the job's own
// colour with a fill bar, and tied to the picture — tapping a job lights up
// the boxes holding its material. Pure over the tallies and the packages.

import { containerHue, type StoragePackage } from "../storage";
import type { JobTally } from "./jobTally";
import { CATALOG } from "../i18n/catalog";
import { translate, type Lang } from "../i18n/translate";
import type { TFn } from "../i18n/context";

const englishT: TFn = (key, vars) => translate(CATALOG, "en" as Lang, key, vars);

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

export function jobChips(tallies: readonly JobTally[], t: TFn = englishT): JobChip[] {
  return tallies.map((tally) => ({
    key: tally.projectId ?? `pending:${tally.label}`,
    projectId: tally.projectId,
    pendingName: tally.projectId ? null : tally.label,
    label: tally.label,
    hue: containerHue(tally.label),
    here: tally.loggedUnits,
    total: tally.totalUnits,
    ready: tally.remainingUnits === 0,
    line:
      tally.remainingUnits === 0
        ? `${tally.totalUnits}/${tally.totalUnits}`
        : t("warehouse.jobStrip.toCome", {
            here: tally.loggedUnits,
            total: tally.totalUnits,
            remaining: tally.remainingUnits,
          }),
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
