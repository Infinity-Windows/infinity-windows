// Pure grouping/sort for the "My Schedule" agenda and the unassigned-projects
// tray. The agenda expands each multi-day assignment into one entry per day it
// covers within the visible window, grouped and sorted by day, then by start
// time within a day.

import { addDaysISO, daysBetween, enumerateDays } from "./dates";
import type { ScheduleAssignment } from "./types";

export interface AgendaEntry {
  assignment: ScheduleAssignment;
  /** The specific day this entry represents. */
  day: string;
  /** True on the assignment's own start_date (vs. a continuation day). */
  isFirstDay: boolean;
}

export interface AgendaDay {
  day: string;
  entries: AgendaEntry[];
}

/** Sort key for a day's entries: timed first (by time), then untimed, by job. */
function entrySortKey(entry: AgendaEntry): string {
  const time = entry.assignment.start_time ?? "99:99";
  const job = entry.assignment.project?.job_code ?? entry.assignment.project_id;
  return `${time}|${job}`;
}

/**
 * Group assignments into a day-by-day agenda over [fromISO, toISO], expanding
 * multi-day ranges. Only days that actually have entries are returned, in
 * ascending date order.
 */
export function buildAgenda(
  assignments: ScheduleAssignment[],
  fromISO: string,
  toISO: string,
): AgendaDay[] {
  const byDay = new Map<string, AgendaEntry[]>();
  for (const a of assignments) {
    const spanStart =
      daysBetween(fromISO, a.start_date) >= 0 ? a.start_date : fromISO;
    const spanEnd = daysBetween(a.end_date, toISO) >= 0 ? a.end_date : toISO;
    if (daysBetween(spanStart, spanEnd) < 0) continue;
    for (const day of enumerateDays(spanStart, spanEnd)) {
      const entry: AgendaEntry = {
        assignment: a,
        day,
        isFirstDay: day === a.start_date,
      };
      const list = byDay.get(day) ?? [];
      list.push(entry);
      byDay.set(day, list);
    }
  }

  return [...byDay.entries()]
    .sort((a, b) => daysBetween(b[0], a[0]))
    .map(([day, entries]) => ({
      day,
      entries: entries.sort((x, y) => entrySortKey(x).localeCompare(entrySortKey(y))),
    }));
}

/** Assignments that include a given person (by profile id). */
export function assignmentsForMember(
  assignments: ScheduleAssignment[],
  profileId: string,
): ScheduleAssignment[] {
  return assignments.filter((a) =>
    a.members.some((m) => m.profile_id === profileId),
  );
}

/**
 * Crewmate display names for one assignment, excluding the viewer — the "who
 * you're with" line on a My Schedule card.
 */
export function crewmateNames(
  assignment: ScheduleAssignment,
  viewerId: string,
): string[] {
  return assignment.members
    .filter((m) => m.profile_id !== viewerId)
    .map((m) => m.display_name ?? "Crew")
    .sort((a, b) => a.localeCompare(b));
}

export interface UnassignedProject {
  id: string;
  job_code: string;
  name: string;
}

/**
 * Projects with no upcoming (end_date >= today) assignment — the tray that
 * lets an owner schedule a job fast. `todayISO` is passed in to keep this pure.
 */
export function unassignedProjects<
  P extends { id: string; job_code: string; name: string },
>(
  projects: P[],
  assignments: ScheduleAssignment[],
  todayISO: string,
): P[] {
  const scheduled = new Set<string>();
  for (const a of assignments) {
    if (daysBetween(todayISO, a.end_date) >= 0) scheduled.add(a.project_id);
  }
  return projects.filter((p) => !scheduled.has(p.id));
}

/** Next day after a window end (used for "load more" agenda paging). */
export function nextWindowStart(toISO: string): string {
  return addDaysISO(toISO, 1);
}
