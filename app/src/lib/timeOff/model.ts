import { addDaysISO, enumerateDays } from "../schedule/dates";
import type { ScheduleAssignment } from "../schedule/types";
export type TimeOffKind = "sick" | "vacation" | "other";
export interface TimeOffRequest {
  id: string;
  profile_id: string;
  kind: TimeOffKind;
  start_date: string;
  end_date: string;
  status: "pending" | "approved" | "declined" | "canceled";
  created_at: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  profiles?: { display_name: string | null } | null;
}
export function absenceOn(
  rows: readonly TimeOffRequest[],
  person: string,
  day: string,
) {
  return rows.find(
    (r) =>
      r.profile_id === person &&
      r.status === "approved" &&
      r.start_date <= day &&
      r.end_date >= day,
  );
}
/** Count unique calendar days, clipped to the selected period. Pending leave
 * never counts as taken, and future approved days are explicitly separate. */
export function timeOffCounts(
  rows: readonly TimeOffRequest[],
  today: string,
  from = "0000-01-01",
  to = "9999-12-31",
) {
  const taken = { sick: 0, vacation: 0, other: 0 };
  const planned = { sick: 0, vacation: 0, other: 0 };
  const seen = new Set<string>();
  for (const row of rows.filter((r) => r.status === "approved")) {
    const start = row.start_date > from ? row.start_date : from;
    const end = row.end_date < to ? row.end_date : to;
    for (const day of enumerateDays(start, end)) {
      const key = `${row.profile_id}:${day}`;
      if (seen.has(key)) continue;
      seen.add(key);
      (day <= today ? taken : planned)[row.kind]++;
    }
  }
  return { taken, planned };
}
/** Expand an assignment into day-specific availability, then compress adjacent
 * identical crews. This preserves source IDs for editing and published history. */
export function availableAssignments(
  assignments: ScheduleAssignment[],
  absences: readonly TimeOffRequest[],
  person?: string,
) {
  const out: ScheduleAssignment[] = [];
  for (const a of assignments) {
    if (
      !absences.some(
        (r) =>
          r.status === "approved" &&
          r.start_date <= a.end_date &&
          r.end_date >= a.start_date &&
          a.members.some((m) => m.profile_id === r.profile_id),
      )
    ) {
      out.push(a);
      continue;
    }
    let segment: ScheduleAssignment | undefined;
    for (const day of enumerateDays(a.start_date, a.end_date, 3660)) {
      const members = a.members.filter(
        (m) => !absenceOn(absences, m.profile_id, day),
      );
      if (person && !members.some((m) => m.profile_id === person)) {
        segment = undefined;
        continue;
      }
      if (
        segment &&
        addDaysISO(segment.end_date, 1) === day &&
        JSON.stringify(segment.members) === JSON.stringify(members)
      )
        segment.end_date = day;
      else {
        segment = { ...a, start_date: day, end_date: day, members };
        out.push(segment);
      }
    }
  }
  return out;
}
export function localDay() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function availableMembers(a: ScheduleAssignment, day: string) {
  return a.members.filter(
    (m) => !absenceOn(a.time_off ?? [], m.profile_id, day),
  );
}
