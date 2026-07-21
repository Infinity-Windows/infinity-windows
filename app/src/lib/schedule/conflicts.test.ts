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

describe("assignmentsOverlap", () => {
  it("detects shared days inclusively", () => {
    expect(assignmentsOverlap(A("1", "2026-07-01", "2026-07-03", []), A("2", "2026-07-03", "2026-07-05", []))).toBe(true);
    expect(assignmentsOverlap(A("1", "2026-07-01", "2026-07-02", []), A("2", "2026-07-03", "2026-07-05", []))).toBe(false);
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
