import type { WorkSession, WorkUnit } from "../../lib/customWork/model";
export interface ActivityRow { id: string; activity: string; scope: string; person: string; personId: string; unit: string; unitId: string | null; floor: string; seconds: number; started: string; ended: string; outcome: string; revision: number; }
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
    rows.push({ id: s.id, activity: s.kind === "idle" ? s.description.trim() || "Unlabeled general activity" : s.stage.trim() || "Unlabeled unit activity",
      scope: s.kind === "unit" ? "Specific" : "General", person: people.get(s.profile_id) ?? s.profile_id,
      personId: s.profile_id, unitId: s.unit_id,
      unit: unit?.label ?? (s.unit_id ? `Unresolved ${s.unit_id}` : "No unit"),
      floor: s.kind === "idle" ? "Not allocated" : unit?.facts.story?.trim() || "Unknown", seconds,
      started: s.started_at, ended: s.ended_at!, outcome: s.outcome ?? "Not recorded", revision: s.revision });
  }
  return { rows, excluded };
}
export function groupActivities(rows: ActivityRow[], group: "activity" | "floor" | "unit" | "person") {
  const groups = new Map<string, { key: string; label: string; seconds: number; records: number }>();
  for (const row of rows) {
    const label = group === "activity" ? `${row.scope} · ${row.activity}` : row[group];
    const key = group === "person" ? row.personId : group === "unit" ? row.unitId ?? "no-unit" : label;
    const value = groups.get(key) ?? { key, label: group === "unit" && row.unitId ? `${label} · ${row.unitId.slice(0, 8)}` : label, seconds: 0, records: 0 };
    value.seconds += row.seconds; value.records++; groups.set(key, value);
  }
  return [...groups.values()].sort((a, b) => b.seconds - a.seconds || a.label.localeCompare(b.label));
}
