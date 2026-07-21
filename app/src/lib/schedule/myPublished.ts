import type { ScheduleAssignment } from "./types";

/**
 * Published assignments a person is on, overlapping the inclusive [from, to]
 * window, sorted by start date. Shared by the local-fallback path in the data
 * layer so its behaviour matches the remote query (published + member +
 * overlap).
 */
export function filterMyPublished(
  rows: ScheduleAssignment[],
  profileId: string,
  fromISO: string,
  toISO: string,
): ScheduleAssignment[] {
  return rows
    .filter(
      (a) =>
        a.status === "published" &&
        a.start_date <= toISO &&
        a.end_date >= fromISO &&
        a.members.some((m) => m.profile_id === profileId),
    )
    .sort((a, b) => a.start_date.localeCompare(b.start_date));
}
