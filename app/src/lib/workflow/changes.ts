import type { PlanDraft } from "./api";
import type { TKey } from "../i18n";
export interface PlanChange { section: string; field: TKey; before: string; after: string }
/** Compare only editable instructions; database timestamps and roster row IDs
 * do not turn an unchanged plan into a misleading change summary. */
export function planChanges(before: PlanDraft, after: PlanDraft, person: (id: string) => string): PlanChange[] {
  const changes: PlanChange[] = [];
  const add = (section: string, field: TKey, old: unknown, next: unknown) => {
    const a = old == null ? "" : String(old); const b = next == null ? "" : String(next);
    if (a !== b) changes.push({ section, field, before: a, after: b });
  };
  const crew = (members: { profile_id: string; role: string }[]) => [...members].sort((a,b) => a.profile_id.localeCompare(b.profile_id)).map(m => `${person(m.profile_id)} (${m.role})`).join(", ");
  for (const a of after.assignments) {
    const old = before.assignments.find(b => b.id === a.id); if (!old) continue;
    add(a.id, "workflow.start", old.start_date, a.start_date); add(a.id, "workflow.end", old.end_date, a.end_date);
    add(a.id, "workflow.startTime", old.start_time?.slice(0,5), a.start_time?.slice(0,5));
    add(a.id, "workflow.endTime", old.end_time?.slice(0,5), a.end_time?.slice(0,5));
    add(a.id, "workflow.notes", old.note, a.note); add(a.id, "workflow.crew", crew(old.members), crew(a.members));
  }
  for (const a of after.trips) {
    const old = before.trips.find(b => b.trip.id === a.trip.id); if (!old) continue;
    add(a.trip.id, "workflow.name", old.trip.name, a.trip.name); add(a.trip.id, "workflow.destination", old.trip.destination, a.trip.destination);
    add(a.trip.id, "workflow.travelStart", old.trip.start_date, a.trip.start_date); add(a.trip.id, "workflow.travelEnd", old.trip.end_date, a.trip.end_date);
    add(a.trip.id, "workflow.timezone", old.trip.timezone, a.trip.timezone); add(a.trip.id, "workflow.notes", old.trip.notes, a.trip.notes);
    add(a.trip.id, "workflow.crew", crew(old.crew), crew(a.crew));
  }
  return changes;
}
