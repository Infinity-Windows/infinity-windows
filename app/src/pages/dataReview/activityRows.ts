import type { ReportingFacts } from "./reportingFacts";
import type { WorkSession, WorkUnit } from "../../lib/customWork/model";
export interface ActivityRow { shiftId?: string; originalActivity?: string; reviewKind?: "duplicate" | "overlap" | "timer"; reviewRelatedIds?: string[]; reviewReason?: string; unitFacts?: ReportingFacts; material?: string; area?: number | null; sourceTable?: string; openingId?: string; openingCode?: string; configuration?: string | null; system?: string | null; category?: string | null; subtype?: string | null; unitRecord?: WorkUnit; id: string; jobId?: string; job?: string; activity: string; scope: string; machinerySeconds?: number; person: string; personId: string; unit: string; unitId: string | null; floor: string; seconds: number; started: string; ended: string; outcome: string; revision: number; }
export function activityRows(sessions: WorkSession[], units: WorkUnit[], people: Map<string, string>, from = -Infinity, until = Infinity) {
  const byUnit = new Map(units.map(u => [u.id, u]));
  const rows: ActivityRow[] = [];
  let excluded = 0;
  for (const s of sessions) {
    const start = Date.parse(s.started_at), end = s.ended_at ? Date.parse(s.ended_at) : NaN;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || s.shift_status === "voided") { excluded++; continue; }
    const seconds = (Math.min(end, until) - Math.max(start, from)) / 1000;
    if (seconds <= 0) continue;
    const unit = s.unit_id ? byUnit.get(s.unit_id) : undefined;
    rows.push({ id: s.id, shiftId: s.shift_id, jobId: s.project_id ?? "", job: s.project_id ?? "No job", activity: s.kind === "idle" ? s.description.split(" — ", 1)[0]?.trim() || "Unlabeled job-level activity" : s.stage.trim() || "Unlabeled unit activity",
      scope: s.kind === "unit" ? "Specific" : "General", person: people.get(s.profile_id) ?? s.profile_id,
      personId: s.profile_id, unitId: s.unit_id,
      category: null, subtype: null, unitRecord: unit, sourceTable: "custom_work_sessions", openingId: unit?.opening_id ?? undefined,
      unit: unit?.label ?? (s.unit_id ? `Unresolved ${s.unit_id}` : "No unit"),
      machinerySeconds: start >= from && end <= until && s.workday_machinery_ms ? s.workday_machinery_ms / 1000 : undefined,
      floor: s.kind === "idle" ? "Not allocated" : unit?.facts.story?.trim() || "Unknown", seconds,
      started: s.started_at, ended: s.ended_at!, outcome: s.outcome ?? "Not recorded", revision: s.revision });
  }
  return { rows, excluded };
}
