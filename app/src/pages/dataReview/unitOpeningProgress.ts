import type { ReviewOpening } from "./openingReviewContext";
export interface UnitPhase { id: string; opening_id: string; kind: string; status: string; started_at?:string; submitted_at?:string|null }
export function unitOpeningProgress(opening: ReviewOpening, phases: UnitPhase[]) {
 const stages: { label: string; state: "open" | "progress" | "completed" | "unknown" }[] = [];
 if (opening.needs_flashing !== false) {
  const flash = phases.filter(p => p.opening_id === opening.id && p.kind === "flashing");
  stages.push({ label: opening.needs_flashing == null ? "Flashing requirement unknown" : "Flashing", state: opening.needs_flashing == null ? "unknown" : flash.some(p => p.status === "submitted") ? "completed" : flash.some(p => p.status === "active") ? "progress" : "open" });
 }
 stages.push({label:"Installation",state:opening.status === "installed" ? "completed" : opening.work_started_at ? "progress" : ["planned","assigned"].includes(opening.status) ? "open" : "unknown"});
 return { stages, expected: stages.filter(s => s.state !== "unknown").length, completed: stages.filter(s => s.state === "completed").length };
}

export function openingRecords(opening: ReviewOpening, rows: import("./activityRows").ActivityRow[]) {
 return rows.filter(r => r.scope === "Specific" && r.openingId === opening.id && r.jobId === opening.project_id && !r.unitFacts?.linkConflict);
}
