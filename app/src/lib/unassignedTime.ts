import type { TimeShift } from "./timeclock";

/** Missing joins are not missing assignments. Keep removed punches out and
 * retain the original entry order even when someone backdates or edits work. */
export function unassignedTimeEntries(shifts: TimeShift[]): TimeShift[] {
  const seen = new Set<string>();
  const recordedAt = (s: TimeShift) => {
    const created = Date.parse(s.created_at);
    return Number.isFinite(created) ? created : Date.parse(s.clock_in_at) || 0;
  };
  return shifts.filter(s => {
    if (s.project_id !== null || s.status === "voided" || seen.has(s.id)) return false;
    seen.add(s.id);
    return true;
  }).sort((a, b) => recordedAt(a) - recordedAt(b) ||
    Date.parse(a.clock_in_at) - Date.parse(b.clock_in_at) || a.id.localeCompare(b.id));
}
