import type { TripPhase } from "./types";

/**
 * Lifecycle phase from a trip's [start_date, end_date] against today (all
 * "YYYY-MM-DD" strings, compared lexicographically so no timezone drift):
 * before it starts = upcoming, within the range = in_progress, after = past.
 */
export function tripPhase(
  startDate: string,
  endDate: string,
  todayISO: string,
): TripPhase {
  if (todayISO < startDate) return "upcoming";
  if (todayISO > endDate) return "past";
  return "in_progress";
}

export function phaseLabel(phase: TripPhase): string {
  switch (phase) {
    case "upcoming":
      return "Upcoming";
    case "in_progress":
      return "In progress";
    case "past":
      return "Past";
  }
}

/**
 * Whether sensitive codes (wifi password, door/lockbox code, confirmation
 * codes) should still be surfaced. We hide them once a trip is over so a stale
 * pack doesn't keep exposing a host's codes after checkout.
 */
export function areCodesVisible(
  startDate: string,
  endDate: string,
  todayISO: string,
): boolean {
  return tripPhase(startDate, endDate, todayISO) !== "past";
}

/** Sort key so upcoming/in-progress float above past, each by start date. */
export function tripSortKey(
  startDate: string,
  endDate: string,
  todayISO: string,
): string {
  const phase = tripPhase(startDate, endDate, todayISO);
  // in_progress first, then upcoming (soonest), then past (most recent first).
  if (phase === "in_progress") return `0-${startDate}`;
  if (phase === "upcoming") return `1-${startDate}`;
  // Past: invert the date so the most recent past trip sorts first.
  return `2-${invertDate(endDate)}`;
}

function invertDate(iso: string): string {
  // Map digits so a later date yields a smaller string (9's complement).
  return iso.replace(/\d/g, (d) => String(9 - Number(d)));
}
