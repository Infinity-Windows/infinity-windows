import { describe, expect, it } from "vitest";
import {
  type ConflictAssignment,
  assignmentOverlapKind,
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

  it("treats a missing or malformed time as unknown — still can't be ruled out", () => {
    // Legacy assignment with no times at all still can't be ruled out on a shared day.
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
    // An end time at/before the start time is nonsensical (and this app has no
    // overnight-shift support), so it's unknown too — not an implied wrap.
    expect(
      assignmentsOverlap(
        AT("a", "2026-10-01", "2026-10-01", "12:00", "12:00", ["jordan"]),
        AT("b", "2026-10-01", "2026-10-01", "13:00", "17:00", ["jordan"]),
      ),
    ).toBe(true);
    expect(
      assignmentsOverlap(
        AT("a", "2026-10-01", "2026-10-01", "22:00", "06:00", ["jordan"]),
        AT("b", "2026-10-01", "2026-10-01", "13:00", "17:00", ["jordan"]),
      ),
    ).toBe(true);
  });
});

describe("assignmentOverlapKind", () => {
  it("is confirmed when both sides' hours are known and actually overlap", () => {
    expect(
      assignmentOverlapKind(
        AT("deck", "2026-10-01", "2026-10-01", "07:00", "12:00", ["jordan"]),
        AT("sister", "2026-10-01", "2026-10-01", "11:00", "17:00", ["jordan"]),
      ),
    ).toBe("confirmed");
  });

  it("is null (no conflict) when both sides' hours are known and disjoint or touching", () => {
    expect(
      assignmentOverlapKind(
        AT("deck", "2026-10-01", "2026-10-01", "07:00", "11:00", ["jordan"]),
        AT("sister", "2026-10-01", "2026-10-01", "13:00", "17:00", ["jordan"]),
      ),
    ).toBeNull();
    expect(
      assignmentOverlapKind(
        AT("a", "2026-10-01", "2026-10-01", "07:00", "12:00", ["jordan"]),
        AT("b", "2026-10-01", "2026-10-01", "12:00", "17:00", ["jordan"]),
      ),
    ).toBeNull();
  });

  it("is null when the date ranges don't even touch, regardless of hours", () => {
    expect(
      assignmentOverlapKind(
        AT("a", "2026-07-01", "2026-07-02", "07:00", "12:00", ["jordan"]),
        AT("b", "2026-07-03", "2026-07-04", "07:00", "12:00", ["jordan"]),
      ),
    ).toBeNull();
  });

  it("is review — never confirmed — when either side's hours are missing or malformed", () => {
    expect(
      assignmentOverlapKind(
        AT("a", "2026-10-01", "2026-10-01", null, null, ["jordan"]),
        AT("b", "2026-10-01", "2026-10-01", "13:00", "17:00", ["jordan"]),
      ),
    ).toBe("review");
    expect(
      assignmentOverlapKind(
        A("a", "2026-10-01", "2026-10-01", ["jordan"]),
        A("b", "2026-10-01", "2026-10-01", ["jordan"]),
      ),
    ).toBe("review");
    // Overnight-shaped input (end <= start) is unknown, not a silent overnight shift.
    expect(
      assignmentOverlapKind(
        AT("a", "2026-10-01", "2026-10-01", "22:00", "06:00", ["jordan"]),
        AT("b", "2026-10-01", "2026-10-01", "13:00", "17:00", ["jordan"]),
      ),
    ).toBe("review");
  });
});

describe("detectConflicts", () => {
  it("finds a confirmed double-booking when both assignments' hours are known and overlap", () => {
    const conflicts = detectConflicts([
      AT("a", "2026-07-01", "2026-07-03", "07:00", "15:00", ["p1", "p2"]),
      AT("b", "2026-07-03", "2026-07-04", "08:00", "16:00", ["p1"]),
      AT("c", "2026-07-10", "2026-07-11", "08:00", "16:00", ["p2"]),
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].profileId).toBe("p1");
    expect(conflicts[0].kind).toBe("confirmed");
    expect(conflicts[0].assignmentIds.sort()).toEqual(["a", "b"]);
  });

  it("reports a review — not a confirmed — conflict when the hours aren't known", () => {
    const conflicts = detectConflicts([
      A("a", "2026-07-01", "2026-07-03", ["p1"]),
      A("b", "2026-07-03", "2026-07-04", ["p1"]),
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toEqual({ profileId: "p1", kind: "review", assignmentIds: ["a", "b"] });
  });

  it("gives a person two entries — one per kind — when they have both a confirmed and a review pair", () => {
    const conflicts = detectConflicts([
      AT("a", "2026-07-01", "2026-07-03", "07:00", "15:00", ["p1"]),
      AT("b", "2026-07-01", "2026-07-03", "08:00", "16:00", ["p1"]),
      A("c", "2026-08-01", "2026-08-03", ["p1"]),
      A("d", "2026-08-01", "2026-08-03", ["p1"]),
    ]);
    const confirmed = conflicts.find((c) => c.kind === "confirmed");
    const review = conflicts.find((c) => c.kind === "review");
    expect(confirmed?.assignmentIds.sort()).toEqual(["a", "b"]);
    expect(review?.assignmentIds.sort()).toEqual(["c", "d"]);
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

  it("dedupes repeated membership on the same assignment pair", () => {
    const conflicts = detectConflicts([
      AT("a", "2026-07-01", "2026-07-03", "07:00", "15:00", ["p1", "p1"]),
      AT("b", "2026-07-01", "2026-07-03", "08:00", "16:00", ["p1"]),
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].assignmentIds.sort()).toEqual(["a", "b"]);
  });
});

describe("conflictPairs + conflictingAssignmentIds", () => {
  it("de-duplicates a confirmed pair and collects its outlined (red) ids", () => {
    const items = [
      AT("a", "2026-07-01", "2026-07-05", "07:00", "15:00", ["p1"]),
      AT("b", "2026-07-04", "2026-07-06", "08:00", "16:00", ["p1"]),
    ];
    expect(conflictPairs(items)).toEqual([{ profileId: "p1", aId: "a", bId: "b", kind: "confirmed" }]);
    expect([...conflictingAssignmentIds(items)].sort()).toEqual(["a", "b"]);
  });

  it("tags an unknown-hours pair as review, never outlining it red", () => {
    const items = [
      A("a", "2026-07-01", "2026-07-05", ["p1"]),
      A("b", "2026-07-04", "2026-07-06", ["p1"]),
    ];
    expect(conflictPairs(items)).toEqual([{ profileId: "p1", aId: "a", bId: "b", kind: "review" }]);
    expect(conflictingAssignmentIds(items).size).toBe(0);
  });

  it("returns an empty outline set when nothing overlaps", () => {
    expect(conflictingAssignmentIds([A("a", "2026-07-01", "2026-07-02", ["p1"])]).size).toBe(0);
  });
});

describe("conflictingMembersFor", () => {
  it("lists confirmed members of the target that clash with overlapping others", () => {
    const target = AT("t", "2026-07-05", "2026-07-08", "07:00", "15:00", ["p1", "p2", "p3"]);
    const others = [
      AT("x", "2026-07-07", "2026-07-09", "08:00", "16:00", ["p2"]),
      AT("y", "2026-07-20", "2026-07-21", "07:00", "15:00", ["p1"]),
      AT("t", "2026-07-05", "2026-07-08", "07:00", "15:00", ["p1", "p2", "p3"]),
    ];
    expect(conflictingMembersFor(target, others)).toEqual({ confirmed: ["p2"], review: [] });
  });

  it("buckets an unknown-hours clash as review, not confirmed", () => {
    const target = A("t", "2026-07-05", "2026-07-08", ["p1"]);
    const others = [A("x", "2026-07-07", "2026-07-09", ["p1"])];
    expect(conflictingMembersFor(target, others)).toEqual({ confirmed: [], review: ["p1"] });
  });

  it("puts a member in both buckets when they clash confirmed with one other and review with another", () => {
    const target = AT("t", "2026-07-05", "2026-07-08", "07:00", "15:00", ["p1"]);
    const others = [
      AT("confirmed-other", "2026-07-06", "2026-07-06", "08:00", "16:00", ["p1"]),
      A("review-other", "2026-07-07", "2026-07-07", ["p1"]),
    ];
    expect(conflictingMembersFor(target, others)).toEqual({ confirmed: ["p1"], review: ["p1"] });
  });

  it("clears once the target's daily hours are edited to no longer overlap (inline warning)", () => {
    const others = [AT("x", "2026-10-01", "2026-10-01", "13:00", "17:00", ["jordan"])];
    const overlapping = AT("t", "2026-10-01", "2026-10-01", "12:00", "14:00", ["jordan"]);
    expect(conflictingMembersFor(overlapping, others)).toEqual({ confirmed: ["jordan"], review: [] });

    const edited = AT("t", "2026-10-01", "2026-10-01", "07:00", "11:00", ["jordan"]);
    expect(conflictingMembersFor(edited, others)).toEqual({ confirmed: [], review: [] });
  });

  it("reclassifies from review to confirmed the moment the missing end time is filled in", () => {
    const others = [AT("x", "2026-10-01", "2026-10-01", "13:00", "17:00", ["jordan"])];
    const onlyStart = AT("t", "2026-10-01", "2026-10-01", "12:00", null, ["jordan"]);
    expect(conflictingMembersFor(onlyStart, others)).toEqual({ confirmed: [], review: ["jordan"] });

    const complete = AT("t", "2026-10-01", "2026-10-01", "12:00", "14:00", ["jordan"]);
    expect(conflictingMembersFor(complete, others)).toEqual({ confirmed: ["jordan"], review: [] });
  });

  it("leaves review state alone when editing just one of two missing times without resolving it", () => {
    const others = [A("x", "2026-10-01", "2026-10-01", ["jordan"])];
    const bothMissing = AT("t", "2026-10-01", "2026-10-01", null, null, ["jordan"]);
    expect(conflictingMembersFor(bothMissing, others)).toEqual({ confirmed: [], review: ["jordan"] });

    // Filling in only the start (end still missing) stays a review clash —
    // it must not accidentally read as resolved, nor jump to confirmed.
    const oneFilled = AT("t", "2026-10-01", "2026-10-01", "07:00", null, ["jordan"]);
    expect(conflictingMembersFor(oneFilled, others)).toEqual({ confirmed: [], review: ["jordan"] });
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

  it("returns null when known hours rule the clash out even though the dates touch", () => {
    expect(
      overlapDays(
        AT("a", "2026-03-01", "2026-03-05", "07:00", "11:00", []),
        AT("b", "2026-03-03", "2026-03-09", "13:00", "17:00", []),
      ),
    ).toBeNull();
  });
});

describe("conflictBannerEntries", () => {
  it("shapes a review pair (hours unknown) with no invented time window", () => {
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
      kind: "review",
      overlap: { start: "2026-03-03", end: "2026-03-05" },
      aTime: { start: null, end: null },
      bTime: { start: null, end: null },
      timeOverlap: null,
    });
  });

  it("shapes a confirmed pair with each side's hours and the exact overlapping window", () => {
    const rows = conflictBannerEntries([
      AT("smith", "2026-03-01", "2026-03-05", "07:00", "15:00", ["ammon"]),
      AT("jones", "2026-03-03", "2026-03-08", "13:00", "20:00", ["ammon"]),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      profileId: "ammon",
      aId: "smith",
      bId: "jones",
      kind: "confirmed",
      overlap: { start: "2026-03-03", end: "2026-03-05" },
      aTime: { start: "07:00", end: "15:00" },
      bTime: { start: "13:00", end: "20:00" },
      timeOverlap: { start: "13:00", end: "15:00" },
    });
  });

  it("keeps whichever side's hours ARE known without inventing the missing one", () => {
    const rows = conflictBannerEntries([
      AT("smith", "2026-03-01", "2026-03-05", "07:00", null, ["ammon"]),
      AT("jones", "2026-03-03", "2026-03-08", "13:00", "20:00", ["ammon"]),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("review");
    expect(rows[0].aTime).toEqual({ start: "07:00", end: null });
    expect(rows[0].bTime).toEqual({ start: "13:00", end: "20:00" });
    expect(rows[0].timeOverlap).toBeNull();
  });

  it("returns no rows when nobody is double-booked", () => {
    expect(
      conflictBannerEntries([
        A("a", "2026-03-01", "2026-03-02", ["p1"]),
        A("b", "2026-03-01", "2026-03-02", ["p2"]),
      ]),
    ).toEqual([]);
  });

  it("reports both a confirmed row and a review row for the same person across different pairs", () => {
    const rows = conflictBannerEntries([
      AT("a", "2026-04-01", "2026-04-02", "07:00", "15:00", ["ammon"]),
      AT("b", "2026-04-01", "2026-04-02", "08:00", "16:00", ["ammon"]),
      A("c", "2026-05-01", "2026-05-02", ["ammon"]),
      A("d", "2026-05-01", "2026-05-02", ["ammon"]),
    ]);
    const kinds = rows.map((r) => r.kind).sort();
    expect(kinds).toEqual(["confirmed", "review"]);
  });
});


describe("displayed overlap precision", () => {
  it("preserves a subminute overlap instead of rendering a zero length window", () => {
    const rows = conflictBannerEntries([
      AT("a", "2026-10-01", "2026-10-01", "07:00:00", "11:00:30", ["p"]),
      AT("b", "2026-10-01", "2026-10-01", "11:00:10", "17:00:00", ["p"]),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].timeOverlap).toEqual({ start: "11:00:10", end: "11:00:30" });
  });
});
