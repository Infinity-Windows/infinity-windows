// Pure double-booking / conflict detection. Given a set of assignments (each
// with a date range, an optional daily clock window, and its ad-hoc members),
// find every person booked on two overlapping assignments. Two assignments on
// the same day only conflict if their daily hours actually overlap — the
// board WARNS but never blocks, so this only ever reports — it never mutates
// or filters.

import { rangesOverlap } from "./dates";

/** The inclusive day-span two assignments share. */
export interface OverlapRange {
  start: string;
  end: string;
}

/** One row of the actionable double-booking banner. */
export interface ConflictBannerEntry {
  profileId: string;
  /** The two clashing assignment ids (order stable: as reported by conflictPairs). */
  aId: string;
  bId: string;
  /** The days on which they clash. */
  overlap: OverlapRange;
}

/** Minimal shape the conflict math needs from an assignment. */
export interface ConflictAssignment {
  id: string;
  start_date: string;
  end_date: string;
  /** Daily clock window applied to every day in the range ("HH:MM" or
   * "HH:MM:SS"). Missing, malformed, or not a well-formed start/end pair is
   * treated as unknown — conservatively, the whole day — since legacy
   * assignments predate these columns. A caller that manually re-projects a
   * `ScheduleAssignment` into this shape must carry these through or every
   * shared day will conservatively read as booked. */
  start_time?: string | null;
  end_time?: string | null;
  members: { profile_id: string }[];
}

/** One overlapping pair for a person, with the days they clash. */
export interface ConflictPair {
  profileId: string;
  aId: string;
  bId: string;
}

export interface PersonConflict {
  profileId: string;
  /** All assignment ids this person is double-booked across. */
  assignmentIds: string[];
}

/** Parse a "HH:MM" or "HH:MM:SS" clock string to seconds since midnight, or
 * null when it isn't well-formed. */
function parseClockSeconds(value: string | null | undefined): number | null {
  if (!value) return null;
  const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  const s = Number(match[3] ?? 0);
  if (h > 23 || m > 59 || s > 59) return null;
  return h * 3600 + m * 60 + s;
}

/** An assignment's daily clock window in seconds-since-midnight, or null when
 * it isn't known well enough to narrow (missing, malformed, or end at/before
 * start) — callers then treat the whole day as booked. */
function dailyWindow(a: ConflictAssignment): { start: number; end: number } | null {
  const start = parseClockSeconds(a.start_time);
  const end = parseClockSeconds(a.end_time);
  if (start === null || end === null || end <= start) return null;
  return { start, end };
}

/** True when two assignments' daily clock windows overlap on a shared day.
 * An unknown window (either side) is conservative: it's treated as occupying
 * the whole day, so it always overlaps. Known windows use a half-open
 * comparison, so a shift ending exactly when another starts doesn't clash. */
function dailyTimesOverlap(a: ConflictAssignment, b: ConflictAssignment): boolean {
  const aWindow = dailyWindow(a);
  const bWindow = dailyWindow(b);
  if (!aWindow || !bWindow) return true;
  return aWindow.start < bWindow.end && bWindow.start < aWindow.end;
}

/** True when two assignments share any day AND, on that shared day, their
 * daily clock windows overlap. */
export function assignmentsOverlap(
  a: ConflictAssignment,
  b: ConflictAssignment,
): boolean {
  return (
    rangesOverlap(a.start_date, a.end_date, b.start_date, b.end_date) &&
    dailyTimesOverlap(a, b)
  );
}

/**
 * Every overlapping (person, assignment-pair). Assignment order within a pair is
 * stable (as given); pairs are de-duplicated so (a,b) is reported once.
 */
export function conflictPairs(
  assignments: ConflictAssignment[],
): ConflictPair[] {
  const byPerson = new Map<string, ConflictAssignment[]>();
  for (const a of assignments) {
    for (const m of a.members) {
      const list = byPerson.get(m.profile_id);
      if (list) list.push(a);
      else byPerson.set(m.profile_id, [a]);
    }
  }

  const out: ConflictPair[] = [];
  for (const [profileId, list] of byPerson) {
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        if (list[i].id === list[j].id) continue;
        if (assignmentsOverlap(list[i], list[j])) {
          out.push({ profileId, aId: list[i].id, bId: list[j].id });
        }
      }
    }
  }
  return out;
}

/** Grouped per-person conflict summary (drives the pre-publish list). */
export function detectConflicts(
  assignments: ConflictAssignment[],
): PersonConflict[] {
  const pairs = conflictPairs(assignments);
  const byPerson = new Map<string, Set<string>>();
  for (const p of pairs) {
    const set = byPerson.get(p.profileId) ?? new Set<string>();
    set.add(p.aId);
    set.add(p.bId);
    byPerson.set(p.profileId, set);
  }
  return [...byPerson.entries()].map(([profileId, ids]) => ({
    profileId,
    assignmentIds: [...ids],
  }));
}

/**
 * The set of assignment ids involved in ANY conflict — used to paint a red
 * outline on conflicting blocks in every view.
 */
export function conflictingAssignmentIds(
  assignments: ConflictAssignment[],
): Set<string> {
  const ids = new Set<string>();
  for (const p of conflictPairs(assignments)) {
    ids.add(p.aId);
    ids.add(p.bId);
  }
  return ids;
}

/**
 * The inclusive day-span two assignments share, or null when they don't
 * overlap at all. Drives the "days they clash" text in the conflict banner.
 */
export function overlapDays(
  a: ConflictAssignment,
  b: ConflictAssignment,
): OverlapRange | null {
  if (!assignmentsOverlap(a, b)) return null;
  const start = a.start_date >= b.start_date ? a.start_date : b.start_date;
  const end = a.end_date <= b.end_date ? a.end_date : b.end_date;
  return { start, end };
}

/**
 * Shape every double-booking into a banner row: the person, the two clashing
 * assignments, and the days they clash. One row per (person, pair); pairs are
 * already de-duplicated by `conflictPairs`.
 */
export function conflictBannerEntries(
  assignments: ConflictAssignment[],
): ConflictBannerEntry[] {
  const byId = new Map<string, ConflictAssignment>();
  for (const a of assignments) byId.set(a.id, a);
  const out: ConflictBannerEntry[] = [];
  for (const pair of conflictPairs(assignments)) {
    const a = byId.get(pair.aId);
    const b = byId.get(pair.bId);
    if (!a || !b) continue;
    const overlap = overlapDays(a, b);
    if (!overlap) continue;
    out.push({ profileId: pair.profileId, aId: pair.aId, bId: pair.bId, overlap });
  }
  return out;
}

/**
 * People on `target` who are ALSO booked on an overlapping other assignment —
 * the inline warning shown while editing one assignment.
 */
export function conflictingMembersFor(
  target: ConflictAssignment,
  others: ConflictAssignment[],
): string[] {
  const targetMembers = new Set(target.members.map((m) => m.profile_id));
  const clashing = new Set<string>();
  for (const other of others) {
    if (other.id === target.id) continue;
    if (!assignmentsOverlap(target, other)) continue;
    for (const m of other.members) {
      if (targetMembers.has(m.profile_id)) clashing.add(m.profile_id);
    }
  }
  return [...clashing];
}
