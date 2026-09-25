// The Today card's facts (crew redesign K1.2 / K1.6, 2026-09-23): which
// published entry is "today" (or the next one when today is empty), whether
// it has CHANGED since it was published, and how "Updated" reads.
//
// "Changed" is a fact about the record, not a memory on the phone: an
// assignment edited after it was published, recently enough to still be
// news. Reading it off updated_at / published_at means every phone on the
// crew agrees, and a person switching phones is told the same thing.

import type { ScheduleAssignment } from "../schedule/types";

/** An edit counts as a change only once it is clearly after publishing. */
export const CHANGED_MIN_GAP_MS = 60_000;
/** After this, a change is old news and the tag comes off. */
export const CHANGED_TTL_MS = 48 * 3600_000;

export function assignmentChanged(
  a: Pick<ScheduleAssignment, "updated_at" | "published_at" | "status">,
  now: number,
): boolean {
  if (a.status !== "published" || !a.published_at) return false;
  const updated = new Date(a.updated_at).getTime();
  const published = new Date(a.published_at).getTime();
  if (Number.isNaN(updated) || Number.isNaN(published)) return false;
  if (updated - published < CHANGED_MIN_GAP_MS) return false;
  return now - updated <= CHANGED_TTL_MS;
}

/**
 * This person's published rows in the window, in the order the day reads
 * them: by the day they matter next, then start time. The same filter and
 * sort the classic CrewStartBar uses, lifted here so the new Today card and
 * the Schedule tab cannot disagree with it.
 */
export function myPublishedInWindow(
  rows: readonly ScheduleAssignment[],
  meId: string,
  todayISO: string,
  throughISO: string,
): ScheduleAssignment[] {
  return rows
    .filter(
      (a) =>
        a.status === "published" &&
        a.end_date >= todayISO &&
        a.start_date <= throughISO &&
        a.members.some((m) => m.profile_id === meId),
    )
    .sort((a, b) => {
      const dayA = a.start_date < todayISO ? todayISO : a.start_date;
      const dayB = b.start_date < todayISO ? todayISO : b.start_date;
      return (
        dayA.localeCompare(dayB) ||
        (a.start_time ?? "99").localeCompare(b.start_time ?? "99") ||
        a.id.localeCompare(b.id)
      );
    });
}

export interface TodayPick {
  /** The day the card is about: today, or the next day with work, or null. */
  day: string | null;
  entries: ScheduleAssignment[];
}

/** Today's entries, else the next day's, else nothing. */
export function pickTodayEntries(
  rows: readonly ScheduleAssignment[],
  meId: string,
  todayISO: string,
  throughISO: string,
): TodayPick {
  const mine = myPublishedInWindow(rows, meId, todayISO, throughISO);
  if (mine.length === 0) return { day: null, entries: [] };
  const first = mine[0];
  const day = first.start_date < todayISO ? todayISO : first.start_date;
  return { day, entries: mine.filter((a) => a.start_date <= day && a.end_date >= day) };
}

/** "4:12 PM" today, "Mon 4:12 PM" on another day. Locale-formatted. */
export function formatUpdatedAt(iso: string, now: number): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const sameDay = new Date(now).toDateString() === d.toDateString();
  if (sameDay) return time;
  return `${d.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
}

/** The crewmates on an assignment, by name, without the viewer. */
export function crewmateNamesOn(a: ScheduleAssignment, meId: string): string[] {
  return a.members
    .filter((m) => m.profile_id !== meId)
    .map((m) => m.display_name)
    .filter((n): n is string => Boolean(n));
}
