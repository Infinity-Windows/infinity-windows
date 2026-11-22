import type { CrewWorkRecord, WorkSession, WorkUnit } from "../customWork/model";
import type { ProjectOpening } from "../install/types";
import { unitKindLabel } from "../install/unitDetails";

export interface DayTask { id: string; unit: WorkUnit; opening: ProjectOpening | null; stage: string; assignmentIds: string[] }
export function resolveWalkthroughProject<T extends { id: string; job_code: string; name: string }>(rows: T[]): T {
  const exact = rows.filter(row => row.job_code?.trim().toLowerCase() === "zztest");
  const candidates = exact.length ? exact : rows.filter(row => row.name?.trim().toLowerCase() === "zztest");
  if (!candidates.length) throw new Error("No accessible zztest project was found. Check that the project is available to your account, then retry.");
  if (candidates.length > 1) throw new Error("More than one zztest project matches. Give the intended project a unique zztest job code before opening the walkthrough.");
  return candidates[0];
}
/** An assignment is a suggestion, never evidence of time or completion. */
export function assignedDayTasks(records: CrewWorkRecord[], units: WorkUnit[], openings: ProjectOpening[], person: string, day: string): DayTask[] {
  const tasks = new Map<string, DayTask>();
  for (const record of records) {
    if (record.outcome !== "assigned" || record.work_date !== day || !record.people.some(p => p.profile_id === person && !p.voided_at)) continue;
    const unit = units.find(u => u.id === record.unit_id && u.project_id === record.project_id);
    if (!unit) continue;
    const opening = openings.find(o => o.id === unit.opening_id && o.project_id === unit.project_id) ?? null;
    if (unit.opening_id && !opening) continue;
    const id = `${unit.id}:${record.stage}`;
    const existing = tasks.get(id);
    if (existing) existing.assignmentIds.push(record.id);
    else tasks.set(id, { id, unit, opening, stage: record.stage, assignmentIds: [record.id] });
  }
  return [...tasks.values()];
}
export function assignmentUnit(opening: ProjectOpening, units: WorkUnit[], id: string) {
  const existing = units.find(u => u.project_id === opening.project_id && u.opening_id === opening.id);
  return existing ? { ...existing, reason: "ZZTEST walkthrough assignment" } : {
    id, revision: 0, project_id: opening.project_id, opening_id: opening.id,
    label: opening.opening_code, type_label: (opening.unit_details?.kind && unitKindLabel(opening.unit_details.kind)) ?? opening.window_types?.name ?? "Unknown",
    facts: {}, reason: "ZZTEST walkthrough assignment",
  };
}
export function nativeStartPayload(args: { projectId: string | null; shiftId: string; actorId: string; active: WorkSession | null; task?: DayTask; general?: string; id: string; at: string }) {
  if (args.active && (args.active.profile_id !== args.actorId || args.active.project_id !== args.projectId)) throw new Error("Finish the active work on its own job before starting work on another job.");
  if (args.task && args.task.unit.project_id !== args.projectId) throw new Error("This unit belongs to another job.");
  if (!args.task && !args.general) throw new Error("Choose an activity.");
  return {
    id: args.id, shift_id: args.shiftId, project_id: args.projectId,
    unit_id: args.task?.unit.id ?? null, stage: args.task?.stage ?? "Idle time",
    expected_session_id: args.active?.id ?? null, at: args.at,
    participation: "install", description: args.task ? "" : args.general,
    outcome: args.active ? "partial" : undefined, delay_reason: "",
  };
}
