import { describe, expect, it } from "vitest";
import {
  type ConflictAssignment,
  assignmentsOverlap,
  conflictBannerEntries,
  conflictPairs,
  conflictingAssignmentIds,
  conflictingMembersFor,
  detectConflicts,
  overlapDays,
} from "./conflicts";

const A = (
  id: string,
  start: string,
  end: string,
  members: string[],
): ConflictAssignment => ({
  id,
  start_date: start,
  end_date: end,
  members: members.map((profile_id) => ({ profile_id })),
});

/** Same as `A` but with an explicit daily clock window. */
const AT = (
  id: string,
  start: string,
  end: string,
  startTime: string | null,
  endTime: string | null,
  members: string[],
): ConflictAssignment => ({
  ...A(id, start, end, members),
  start_time: startTime,
  end_time: endTime,
});

describe("assignmentsOverlap", () => {
  it("detects shared days inclusively", () => {
    expect(assignmentsOverlap(A("1", "2026-07-01", "2026-07-03", []), A("2", "2026-07-03", "2026-07-05", []))).toBe(true);
    expect(assignmentsOverlap(A("1", "2026-07-01", "2026-07-02", []), A("2", "2026-07-03", "2026-07-05", []))).toBe(false);
  });

  it("does not conflict on a shared day when the daily clock windows don't overlap", () => {
    // Jordan Williams on ISAAC-DECK 7:00-11:00 and SSIMISTER 13:00-17:00, same day.
    expect(
      assignmentsOverlap(
        AT("deck", "2026-10-01", "2026-10-01", "07:00", "11:00", ["jordan"]),
        AT("sister", "2026-10-01", "2026-10-01", "13:00", "17:00", ["jordan"]),
      ),
    ).toBe(false);
  });

  it("conflicts on a shared day when the daily clock windows actually overlap", () => {
    expect(
      assignmentsOverlap(
        AT("deck", "2026-10-01", "2026-10-01", "07:00", "12:00", ["jordan"]),
        AT("sister", "2026-10-01", "2026-10-01", "11:00", "17:00", ["jordan"]),
      ),
    ).toBe(true);
  });

  it("does not conflict when one shift ends exactly as the other starts", () => {
    expect(
      assignmentsOverlap(
        AT("a", "2026-10-01", "2026-10-01", "07:00", "12:00", ["jordan"]),
        AT("b", "2026-10-01", "2026-10-01", "12:00", "17:00", ["jordan"]),
      ),
    ).toBe(false);
  });

  it("compares HH:MM:SS precision correctly", () => {
    expect(
      assignmentsOverlap(
        AT("a", "2026-10-01", "2026-10-01", "07:00:00", "12:00:30", ["jordan"]),
        AT("b", "2026-10-01", "2026-10-01", "12:00:30", "17:00:00", ["jordan"]),
      ),
    ).toBe(false);
    expect(
      assignmentsOverlap(
        AT("a", "2026-10-01", "2026-10-01", "07:00:00", "12:00:31", ["jordan"]),
        AT("b", "2026-10-01", "2026-10-01", "12:00:30", "17:00:00", ["jordan"]),
      ),
    ).toBe(true);
  });

  it("does not conflict across different dates even with overlapping daily hours", () => {
    expect(
      assignmentsOverlap(
        AT("a", "2026-10-01", "2026-10-01", "07:00", "12:00", ["jordan"]),
        AT("b", "2026-10-02", "2026-10-02", "07:00", "12:00", ["jordan"]),
      ),
    ).toBe(false);
  });

  it("applies the daily window across every day of a multi-day assignment", () => {
    // Multi-day shift 7-12 every day; the other job is only 13-17 every day —
    // ranges overlap on 10-03/10-04 but the daily hours never clash.
    expect(
      assignmentsOverlap(
        AT("a", "2026-10-01", "2026-10-05", "07:00", "12:00", ["jordan"]),
        AT("b", "2026-10-03", "2026-10-07", "13:00", "17:00", ["jordan"]),
      ),
    ).toBe(false);
    expect(
      assignmentsOverlap(
        AT("a", "2026-10-01", "2026-10-05", "07:00", "12:00", ["jordan"]),
        AT("b", "2026-10-03", "2026-10-07", "11:00", "17:00", ["jordan"]),
      ),
    ).toBe(true);
  });

  it("treats a missing or malformed time as unknown — conservatively the whole day", () => {
    // Legacy assignment with no times at all still conflicts on a shared day.
    expect(
      assignmentsOverlap(
        AT("a", "2026-10-01", "2026-10-01", null, null, ["jordan"]),
        AT("b", "2026-10-01", "2026-10-01", "13:00", "17:00", ["jordan"]),
      ),
    ).toBe(true);
    // Only a start time with no end time is also unknown.
    expect(
      assignmentsOverlap(
        AT("a", "2026-10-01", "2026-10-01", "07:00", null, ["jordan"]),
        AT("b", "2026-10-01", "2026-10-01", "13:00", "17:00", ["jordan"]),
      ),
    ).toBe(true);
    // Malformed time strings are also unknown, not a crash.
    expect(
      assignmentsOverlap(
        AT("a", "2026-10-01", "2026-10-01", "not-a-time", "17:00", ["jordan"]),
        AT("b", "2026-10-01", "2026-10-01", "13:00", "17:00", ["jordan"]),
      ),
    ).toBe(true);
    // An end time at/before the start time is nonsensical, so it's unknown too.
    expect(
      assignmentsOverlap(
        AT("a", "2026-10-01", "2026-10-01", "12:00", "12:00", ["jordan"]),
        AT("b", "2026-10-01", "2026-10-01", "13:00", "17:00", ["jordan"]),
      ),
    ).toBe(true);
  });
});

describe("detectConflicts", () => {
  it("finds a person double-booked on overlapping assignments", () => {
    const conflicts = detectConflicts([
      A("a", "2026-07-01", "2026-07-03", ["p1", "p2"]),
      A("b", "2026-07-03", "2026-07-04", ["p1"]),
      A("c", "2026-07-10", "2026-07-11", ["p2"]),
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].profileId).toBe("p1");
    expect(conflicts[0].assignmentIds.sort()).toEqual(["a", "b"]);
  });

  it("reports no conflict when a person's assignments don't overlap", () => {
    expect(
      detectConflicts([
        A("a", "2026-07-01", "2026-07-03", ["p1"]),
        A("b", "2026-07-04", "2026-07-06", ["p1"]),
      ]),
    ).toEqual([]);
  });

  it("does not flag two different people on the same day", () => {
    expect(
      detectConflicts([
        A("a", "2026-07-01", "2026-07-03", ["p1"]),
        A("b", "2026-07-01", "2026-07-03", ["p2"]),
      ]),
    ).toEqual([]);
  });

  it("does not flag the same person on the same day when the daily hours don't overlap", () => {
    expect(
      detectConflicts([
        AT("a", "2026-10-01", "2026-10-01", "07:00", "11:00", ["jordan"]),
        AT("b", "2026-10-01", "2026-10-01", "13:00", "17:00", ["jordan"]),
      ]),
    ).toEqual([]);
  });
});

describe("conflictPairs + conflictingAssignmentIds", () => {
  it("de-duplicates a pair and collects the outlined ids", () => {
    const items = [
      A("a", "2026-07-01", "2026-07-05", ["p1"]),
      A("b", "2026-07-04", "2026-07-06", ["p1"]),
    ];
    expect(conflictPairs(items)).toEqual([{ profileId: "p1", aId: "a", bId: "b" }]);
    expect([...conflictingAssignmentIds(items)].sort()).toEqual(["a", "b"]);
  });

  it("returns an empty outline set when nothing overlaps", () => {
    expect(conflictingAssignmentIds([A("a", "2026-07-01", "2026-07-02", ["p1"])]).size).toBe(0);
  });
});

describe("conflictingMembersFor", () => {
  it("lists members of the target that clash with overlapping others", () => {
    const target = A("t", "2026-07-05", "2026-07-08", ["p1", "p2", "p3"]);
    const others = [
      A("x", "2026-07-07", "2026-07-09", ["p2"]),
      A("y", "2026-07-20", "2026-07-21", ["p1"]),
      A("t", "2026-07-05", "2026-07-08", ["p1", "p2", "p3"]),
    ];
    expect(conflictingMembersFor(target, others)).toEqual(["p2"]);
  });

  it("clears once the target's daily hours are edited to no longer overlap (inline warning)", () => {
    const others = [AT("x", "2026-10-01", "2026-10-01", "13:00", "17:00", ["jordan"])];
    const overlapping = AT("t", "2026-10-01", "2026-10-01", "12:00", "14:00", ["jordan"]);
    expect(conflictingMembersFor(overlapping, others)).toEqual(["jordan"]);

    const edited = AT("t", "2026-10-01", "2026-10-01", "07:00", "11:00", ["jordan"]);
    expect(conflictingMembersFor(edited, others)).toEqual([]);
  });
});

describe("overlapDays", () => {
  it("returns the inclusive shared span for a partial overlap", () => {
    expect(
      overlapDays(A("a", "2026-03-01", "2026-03-05", []), A("b", "2026-03-03", "2026-03-09", [])),
    ).toEqual({ start: "2026-03-03", end: "2026-03-05" });
  });

  it("returns the contained range when one nests inside the other", () => {
    expect(
      overlapDays(A("a", "2026-03-01", "2026-03-10", []), A("b", "2026-03-04", "2026-03-06", [])),
    ).toEqual({ start: "2026-03-04", end: "2026-03-06" });
  });

  it("returns null when the ranges don't touch", () => {
    expect(
      overlapDays(A("a", "2026-03-01", "2026-03-02", []), A("b", "2026-03-03", "2026-03-04", [])),
    ).toBeNull();
  });
});

describe("conflictBannerEntries", () => {
  it("shapes each double-booking into person + both jobs + clash days", () => {
    const rows = conflictBannerEntries([
      A("smith", "2026-03-01", "2026-03-05", ["ammon", "kb"]),
      A("jones", "2026-03-03", "2026-03-08", ["ammon"]),
      A("far", "2026-06-01", "2026-06-02", ["kb"]),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      profileId: "ammon",
      aId: "smith",
      bId: "jones",
      overlap: { start: "2026-03-03", end: "2026-03-05" },
    });
  });

  it("returns no rows when nobody is double-booked", () => {
    expect(
      conflictBannerEntries([
        A("a", "2026-03-01", "2026-03-02", ["p1"]),
        A("b", "2026-03-01", "2026-03-02", ["p2"]),
      ]),
    ).toEqual([]);
  });
});
