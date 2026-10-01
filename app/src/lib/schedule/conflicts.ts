// Pure double-booking / conflict detection. Given a set of assignments (each
// with a date range, an optional daily clock window, and its ad-hoc members),
// find every person booked on two overlapping assignments. Two assignments on
// the same day only conflict if their daily hours actually overlap — the
// board WARNS but never blocks, so this only ever reports — it never mutates
// or filters.
//
// A pair's daily hours fall into exactly one of three buckets:
//   - both known and overlapping    -> "confirmed": an actual double-booking.
//   - both known and NOT overlapping -> no conflict at all (not even review).
//   - either side missing/malformed -> "review": legacy data can't be ruled
//     out, so it's never silently dropped, but it must never be reported as
//     a CONFIRMED double-booking — that's a promise this file keeps for every
//     consumer (red outlines, banners, publish counts, notifications).

import { rangesOverlap } from "./dates";

/** The inclusive day-span two assignments share. */
export interface OverlapRange {
  start: string;
  end: string;
}

/** Whether a clashing pair's daily hours are actually known to overlap, or
 * merely can't be ruled out because one side's hours are missing/malformed. */
export type ConflictKind = "confirmed" | "review";

/** Minimal shape the conflict math needs from an assignment. */
export interface ConflictAssignment {
  id: string;
  start_date: string;
  end_date: string;
  /** Daily clock window applied to every day in the range ("HH:MM" or
   * "HH:MM:SS"). Missing, malformed, or not a well-formed start/end pair is
   * unknown — a pair touching it is classified "review", never "confirmed" —
   * since legacy assignments predate these columns. A caller that manually
   * re-projects a `ScheduleAssignment` into this shape must carry these
   * through or every shared day will read as needing review. */
  start_time?: string | null;
  end_time?: string | null;
  members: { profile_id: string }[];
}

/** One overlapping pair for a person, with how certain the clash is. */
export interface ConflictPair {
  profileId: string;
  aId: string;
  bId: string;
  kind: ConflictKind;
}

/** Grouped per-person conflict summary for one kind — a person with both a
 * confirmed pair and a review pair gets two of these, one per kind, so each
 * can drive its own section of the UI without one hiding the other. */
export interface PersonConflict {
  profileId: string;
  kind: ConflictKind;
  /** All assignment ids this person is clashing across, for this kind. */
  assignmentIds: string[];
}

/** One row of the actionable double-booking / hours-review banner. */
export interface ConflictBannerEntry {
  profileId: string;
  /** The two clashing assignment ids (order stable: as reported by conflictPairs). */
  aId: string;
  bId: string;
  kind: ConflictKind;
  /** The days on which the assignments' date ranges clash. */
  overlap: OverlapRange;
  /** Each assignment's own daily hours, exactly as given — never invented. */
  aTime: { start: string | null; end: string | null };
  bTime: { start: string | null; end: string | null };
  /** The actual overlapping daily clock window ("HH:MM[:SS]"), set only when
   * `kind === "confirmed"` — a review pair has no known window to report. */
  timeOverlap: { start: string; end: string } | null;
}

/** Parse a "HH:MM" or "HH:MM:SS" clock string to seconds since midnight, or
 * null when it isn't well-formed. */
export function parseClockSeconds(value: string | null | undefined): number | null {
  if (!value) return null;
  const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  const s = Number(match[3] ?? 0);
  if (h > 23 || m > 59 || s > 59) return null;
  return h * 3600 + m * 60 + s;
}

/** Preserve nonzero seconds so a subminute overlap never displays as zero. */
function formatClockSeconds(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const hm = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  return seconds ? `${hm}:${String(seconds).padStart(2, "0")}` : hm;
}

/** An assignment's daily clock window in seconds-since-midnight, or null when
 * it isn't known well enough to narrow (missing, malformed, or end at/before
 * start — this app has no overnight-shift support, so that's unknown too,
 * never an implied wrap to the next day). */
function dailyWindow(a: ConflictAssignment): { start: number; end: number } | null {
  const start = parseClockSeconds(a.start_time);
  const end = parseClockSeconds(a.end_time);
  if (start === null || end === null || end <= start) return null;
  return { start, end };
}

/** Used by Fix to prefer the assignment whose hours need correction. */
export function hasKnownDailyHours(a: ConflictAssignment): boolean {
  return dailyWindow(a) !== null;
}

/** How two assignments' daily clock windows relate on a shared day: known and
 * actually overlapping is "confirmed"; known and disjoint is no conflict
 * (null); either side unknown can't be ruled out, so it's "review" — never
 * silently promoted to "confirmed". */
function dailyOverlapKind(a: ConflictAssignment, b: ConflictAssignment): ConflictKind | null {
  const aWindow = dailyWindow(a);
  const bWindow = dailyWindow(b);
  if (!aWindow || !bWindow) return "review";
  return aWindow.start < bWindow.end && bWindow.start < aWindow.end ? "confirmed" : null;
}

/** The exact overlapping seconds-since-midnight window — only meaningful (and
 * only ever called) once both sides are known to actually overlap. */
function dailyOverlapWindow(
  a: ConflictAssignment,
  b: ConflictAssignment,
): { start: number; end: number } | null {
  const aWindow = dailyWindow(a);
  const bWindow = dailyWindow(b);
  if (!aWindow || !bWindow) return null;
  const start = Math.max(aWindow.start, bWindow.start);
  const end = Math.min(aWindow.end, bWindow.end);
  return start < end ? { start, end } : null;
}

/**
 * How two assignments clash, or null when they don't at all: their date
 * ranges must share a day AND, on that shared day, their daily hours must
 * either be confirmed to overlap or be too uncertain to rule out.
 */
export function assignmentOverlapKind(
  a: ConflictAssignment,
  b: ConflictAssignment,
): ConflictKind | null {
  if (!rangesOverlap(a.start_date, a.end_date, b.start_date, b.end_date)) return null;
  return dailyOverlapKind(a, b);
}

/** True when two assignments clash in EITHER sense (confirmed or needing
 * review) — kept for callers that only need a yes/no. Anything that reports a
 * confirmed double-booking (a red outline, a "double-booked" count) must use
 * `assignmentOverlapKind` instead; this boolean must never be read as proof
 * of a confirmed clash. */
export function assignmentsOverlap(a: ConflictAssignment, b: ConflictAssignment): boolean {
  return assignmentOverlapKind(a, b) !== null;
}

/**
 * Every overlapping (person, assignment-pair), each tagged with how certain
 * the clash is. Assignment order within a pair is stable (as given); pairs
 * are de-duplicated so (a,b) is reported once.
 */
export function conflictPairs(assignments: ConflictAssignment[]): ConflictPair[] {
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
        const kind = assignmentOverlapKind(list[i], list[j]);
        if (kind) out.push({ profileId, aId: list[i].id, bId: list[j].id, kind });
      }
    }
  }
  return out;
}

/**
 * Grouped per-person conflict summary (drives the pre-publish list). A
 * person with both a confirmed pair and a review pair gets two entries —
 * one per kind — so a consumer can show them in the right section of each.
 */
export function detectConflicts(assignments: ConflictAssignment[]): PersonConflict[] {
  const pairs = conflictPairs(assignments);
  const byKey = new Map<string, { profileId: string; kind: ConflictKind; ids: Set<string> }>();
  for (const p of pairs) {
    const key = `${p.profileId}::${p.kind}`;
    const entry = byKey.get(key) ?? { profileId: p.profileId, kind: p.kind, ids: new Set<string>() };
    entry.ids.add(p.aId);
    entry.ids.add(p.bId);
    byKey.set(key, entry);
  }
  return [...byKey.values()].map(({ profileId, kind, ids }) => ({
    profileId,
    kind,
    assignmentIds: [...ids],
  }));
}

/**
 * The set of assignment ids involved in a CONFIRMED conflict — used to paint
 * a red outline on conflicting blocks. A pair that only needs hours review
 * is deliberately excluded: unknown hours must never paint as a confirmed
 * double-booking.
 */
export function conflictingAssignmentIds(assignments: ConflictAssignment[]): Set<string> {
  const ids = new Set<string>();
  for (const p of conflictPairs(assignments)) {
    if (p.kind !== "confirmed") continue;
    ids.add(p.aId);
    ids.add(p.bId);
  }
  return ids;
}

/**
 * The inclusive day-span two assignments share, or null when they don't
 * clash at all (either their date ranges don't touch, or their date ranges
 * touch but their known daily hours don't). Drives the "days they clash"
 * text in the conflict banner.
 */
export function overlapDays(a: ConflictAssignment, b: ConflictAssignment): OverlapRange | null {
  if (assignmentOverlapKind(a, b) === null) return null;
  const start = a.start_date >= b.start_date ? a.start_date : b.start_date;
  const end = a.end_date <= b.end_date ? a.end_date : b.end_date;
  return { start, end };
}

/**
 * Shape every clashing pair into a banner row: the person, the two
 * assignments, the days they clash, each side's own hours as given, and —
 * only for a confirmed pair — the actual overlapping window. Nothing here
 * invents an hour neither assignment has.
 */
export function conflictBannerEntries(assignments: ConflictAssignment[]): ConflictBannerEntry[] {
  const byId = new Map<string, ConflictAssignment>();
  for (const a of assignments) byId.set(a.id, a);
  const out: ConflictBannerEntry[] = [];
  for (const pair of conflictPairs(assignments)) {
    const a = byId.get(pair.aId);
    const b = byId.get(pair.bId);
    if (!a || !b) continue;
    const overlap = overlapDays(a, b);
    if (!overlap) continue;
    const window = pair.kind === "confirmed" ? dailyOverlapWindow(a, b) : null;
    out.push({
      profileId: pair.profileId,
      aId: pair.aId,
      bId: pair.bId,
      kind: pair.kind,
      overlap,
      aTime: { start: a.start_time ?? null, end: a.end_time ?? null },
      bTime: { start: b.start_time ?? null, end: b.end_time ?? null },
      timeOverlap: window
        ? { start: formatClockSeconds(window.start), end: formatClockSeconds(window.end) }
        : null,
    });
  }
  return out;
}

/** Members of `target`, split by how certain their clash with an overlapping
 * other assignment is — the inline warning shown while editing one
 * assignment. A member can appear in both buckets if they clash confirmed
 * with one other assignment and merely need review against a different one.
 */
export function conflictingMembersFor(
  target: ConflictAssignment,
  others: ConflictAssignment[],
): { confirmed: string[]; review: string[] } {
  const targetMembers = new Set(target.members.map((m) => m.profile_id));
  const confirmed = new Set<string>();
  const review = new Set<string>();
  for (const other of others) {
    if (other.id === target.id) continue;
    const kind = assignmentOverlapKind(target, other);
    if (!kind) continue;
    for (const m of other.members) {
      if (!targetMembers.has(m.profile_id)) continue;
      (kind === "confirmed" ? confirmed : review).add(m.profile_id);
    }
  }
  return { confirmed: [...confirmed], review: [...review] };
}
