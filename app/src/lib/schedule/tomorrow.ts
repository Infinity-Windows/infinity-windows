// Pure logic behind the Tomorrow line + week chips on the three landings
// (S6). Kept free of React/Supabase, same reasoning as dates.ts: the read
// (`listMyPublished`, already date-windowed) lives in api.ts, this file only
// decides what to do with what comes back.

import { addDaysISO, enumerateDays, startOfWeekISO } from "./dates";
import type { ScheduleAssignment } from "./types";

/** One Mon–Fri chip on the Tomorrow strip's week row. */
export interface WeekChip {
  dateISO: string;
  hasWork: boolean;
  isToday: boolean;
}

/**
 * The next PUBLISHED assignment starting strictly after `todayISO`, within
 * the following 7 days — never a draft, and never today's own assignment
 * (that one is the Today strip's job, above this line). `assignments` is
 * expected to already be published-only (what `listMyPublished` returns),
 * but this re-checks status so a caller that hands in a wider set — the
 * local offline fallback store, say — can't slip a draft onto the line.
 */
export function nextPublishedAfter(
  assignments: ScheduleAssignment[],
  todayISO: string,
): ScheduleAssignment | null {
  const limit = addDaysISO(todayISO, 7);
  const candidates = assignments
    .filter(
      (a) =>
        a.status === "published" &&
        a.start_date > todayISO &&
        a.start_date <= limit,
    )
    .sort((a, b) => a.start_date.localeCompare(b.start_date));
  return candidates[0] ?? null;
}

/**
 * Monday–Friday of the CURRENT week (the week containing `todayISO`), each
 * day marked with whether a published assignment touches it and whether it
 * is today. Weekend days are left off the strip on purpose — nobody expects
 * a dot on Saturday.
 */
export function weekChips(
  assignments: ScheduleAssignment[],
  todayISO: string,
): WeekChip[] {
  const monday = startOfWeekISO(todayISO);
  const days = enumerateDays(monday, addDaysISO(monday, 4));
  const published = assignments.filter((a) => a.status === "published");
  return days.map((dateISO) => ({
    dateISO,
    hasWork: published.some(
      (a) => a.start_date <= dateISO && a.end_date >= dateISO,
    ),
    isToday: dateISO === todayISO,
  }));
}

/** The pieces the Tomorrow line renders, decided here so the component only
 * has to interpolate strings — nothing about how a job or a crew count is
 * counted lives in the component. */
export interface TomorrowLineParts {
  projectId: string | null;
  jobLabel: string;
  /** Raw "HH:MM[:SS]" — the component formats it with the same helper the
   * Today strip already uses (formatStartTime). */
  startTime: string | null;
  endTime?: string | null;
  truckLabel: string | null;
  /** Crew on the assignment, not counting the viewer themself. */
  othersCount: number;
  unitCount: number;
}

export function tomorrowLineParts(
  assignment: ScheduleAssignment,
  profileId: string,
  truckLabel: string | null,
  unitCount: number,
): TomorrowLineParts {
  return {
    projectId: assignment.project_id,
    jobLabel: assignment.project?.name ?? assignment.project?.job_code ?? "",
    startTime: assignment.start_time,
    ...(assignment.end_time ? { endTime: assignment.end_time } : {}),
    truckLabel,
    othersCount: assignment.members.filter((m) => m.profile_id !== profileId)
      .length,
    unitCount,
  };
}
