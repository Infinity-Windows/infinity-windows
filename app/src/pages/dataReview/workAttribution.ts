import type { ActivityRow } from "./activityRows";

export const workAttributions = ["Unit-linked work", "Job-level work", "Missing attribution"] as const;
/** Reporting labels only: source scope remains intact for reconciliation and coverage. */
export function workAttribution(row: ActivityRow): typeof workAttributions[number] {
  if (!row.jobId || row.unitFacts?.linkConflict) return "Missing attribution";
  if (row.scope === "General") return row.unitId || row.openingId ? "Missing attribution" : "Job-level work";
  const unit = row.unitRecord;
  if (row.scope !== "Specific" || (unit && unit.project_id !== row.jobId)) return "Missing attribution";
  if (unit?.opening_id && row.openingId && unit.opening_id !== row.openingId) return "Missing attribution";
  return row.openingId || unit?.opening_id ? "Unit-linked work" : "Missing attribution";
}
