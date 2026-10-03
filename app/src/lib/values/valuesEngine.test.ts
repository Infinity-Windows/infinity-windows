import { describe, expect, it } from "vitest";
import {
  VALUES_MONTHLY_LAUNCH,
  VALUES_TZ,
  activeScoringPeriodStart,
  addMonthsToPeriod,
  assignmentsToStore,
  buildMirror,
  buildQuarterlyRating,
  dealAssignments,
  daysInPeriod,
  lastClosedPeriodStart,
  lastClosedQuarterStart,
  mirrorWindowRange,
  nextQuarterStart,
  periodEndExclusive,
  periodIsScorable,
  periodLabel,
  periodStartOfDay,
  previousQuarterStart,
  quarterCollectionCutoff,
  quarterEndOfStart,
  quarterIsClosed,
  quarterLabel,
  quarterStartOfDay,
  scoringWindowOpen,
  scoringWindowOpensOn,
  seededRng,
  type Assignment,
  type ScoreRow,
  valuesDayOf,
} from "./valuesEngine";

describe("valuesDayOf — Denver calendar day", () => {
  it("is the Denver locale adaptation, not Eastern — a 11pm Eastern tap is still 'today' in Denver", () => {
    // 2026-06-15T03:30:00Z is 2026-06-14 21:30 Denver (MDT, UTC-6) and
    // 2026-06-14 23:30 Eastern (EDT, UTC-4) — same instant, same calendar day
    // either way, which is the easy case.
    expect(valuesDayOf(new Date("2026-06-15T03:30:00Z"))).toBe("2026-06-14");
    // 2026-06-15T05:30:00Z: 2026-06-14 23:30 Denver, but 2026-06-15 01:30
    // Eastern — this is the case that actually differs by timezone.
    expect(valuesDayOf(new Date("2026-06-15T05:30:00Z"))).toBe("2026-06-14");
    expect(valuesDayOf(new Date("2026-06-15T05:30:00Z"), "America/New_York")).toBe("2026-06-15");
  });

  it("handles the March DST spring-forward boundary in Denver", () => {
    // 2026-03-08 is the US spring-forward day; 09:00Z is 02:00 MST the moment
    // before, 03:00 MDT the moment after — valuesDayOf must not throw or skip
    // a day across the transition.
    expect(valuesDayOf(new Date("2026-03-08T08:00:00Z"))).toBe("2026-03-08");
    expect(valuesDayOf(new Date("2026-03-08T10:00:00Z"))).toBe("2026-03-08");
  });

  it("handles a December leap-free month boundary", () => {
    expect(valuesDayOf(new Date("2025-03-01T06:59:00Z"))).toBe("2025-02-28");
    expect(valuesDayOf(new Date("2025-03-01T07:01:00Z"))).toBe("2025-03-01");
  });
});

describe("period math", () => {
  it("names a period by its first day and shifts in whole months", () => {
    expect(periodStartOfDay("2026-10-15")).toBe("2026-10-01");
    expect(addMonthsToPeriod("2026-10-01", -1)).toBe("2026-09-01");
    expect(addMonthsToPeriod("2026-01-01", -1)).toBe("2025-12-01");
    expect(periodEndExclusive("2026-10-01")).toBe("2026-11-01");
  });

  it("knows February's length, leap and non-leap", () => {
    expect(daysInPeriod("2026-02-01")).toBe(28);
    expect(daysInPeriod("2024-02-01")).toBe(29);
  });

  it("opens the window on the final seven calendar days, whatever the month length", () => {
    expect(scoringWindowOpensOn("2026-10-01")).toBe("2026-10-25"); // 31 days
    expect(scoringWindowOpensOn("2026-02-01")).toBe("2026-02-22"); // 28 days
    expect(scoringWindowOpensOn("2024-02-01")).toBe("2024-02-23"); // 29 days (leap)
  });

  it("scoringWindowOpen / activeScoringPeriodStart agree at the boundary", () => {
    expect(scoringWindowOpen(new Date("2026-10-24T18:00:00Z"))).toBe(false); // Oct 24 Denver
    expect(scoringWindowOpen(new Date("2026-10-25T18:00:00Z"))).toBe(true); // Oct 25 Denver
    expect(activeScoringPeriodStart(new Date("2026-10-24T18:00:00Z"))).toBe("2026-09-01");
    expect(activeScoringPeriodStart(new Date("2026-10-25T18:00:00Z"))).toBe("2026-10-01");
    // The 1st of the new month: still last month's scoring, until the window reopens.
    expect(activeScoringPeriodStart(new Date("2026-11-01T18:00:00Z"))).toBe("2026-10-01");
  });

  it("lastClosedPeriodStart is always last month, regardless of window state", () => {
    expect(lastClosedPeriodStart(new Date("2026-10-05T18:00:00Z"))).toBe("2026-09-01");
    expect(lastClosedPeriodStart(new Date("2026-10-29T18:00:00Z"))).toBe("2026-09-01");
  });

  it("periodIsScorable floors at the launch month", () => {
    expect(periodIsScorable(VALUES_MONTHLY_LAUNCH)).toBe(true);
    expect(periodIsScorable("2026-09-01")).toBe(false);
    expect(periodIsScorable("2026-11-01")).toBe(true);
  });

  it("periodLabel reads the month name", () => {
    expect(periodLabel("2026-10-01")).toBe("October");
    expect(periodLabel("2026-10-01", { short: true })).toBe("Oct");
  });

  it("VALUES_TZ is the explicit Denver adaptation", () => {
    expect(VALUES_TZ).toBe("America/Denver");
  });
});

describe("quarter math", () => {
  it("names a quarter by its first month and finds its neighbors", () => {
    expect(quarterStartOfDay("2026-08-15")).toBe("2026-07-01");
    expect(quarterStartOfDay("2026-10-01")).toBe("2026-10-01");
    expect(quarterEndOfStart("2026-07-01")).toBe("2026-09-30");
    expect(previousQuarterStart("2026-01-01")).toBe("2025-10-01");
    expect(nextQuarterStart("2026-10-01")).toBe("2027-01-01");
    expect(quarterLabel("2026-07-01")).toBe("Q3 2026");
  });

  it("the most recent fully-closed quarter is the one before today's", () => {
    expect(lastClosedQuarterStart(new Date("2026-11-15T18:00:00Z"))).toBe("2026-07-01");
  });

  it("the collection cutoff is Denver midnight on the 10th of the month after the quarter ends", () => {
    expect(quarterCollectionCutoff("2026-07-01")).toBe("2026-10-10");
    expect(quarterCollectionCutoff("2026-10-01")).toBe("2027-01-10");
  });

  it("quarterIsClosed flips exactly at the cutoff day", () => {
    expect(quarterIsClosed("2026-07-01", new Date("2026-10-09T23:00:00Z"))).toBe(false); // Oct 9 Denver
    expect(quarterIsClosed("2026-07-01", new Date("2026-10-10T08:00:00Z"))).toBe(true); // Oct 10 Denver
  });
});

describe("mirrorWindowRange — the honest label", () => {
  it("is the current month start minus three months through the as-of day, not a vague '3 months'", () => {
    const range = mirrorWindowRange(new Date("2026-10-15T18:00:00Z"));
    expect(range).toEqual({ start: "2026-07-01", end: "2026-10-15" });
  });
});

describe("the deal", () => {
  const rng = () => seededRng("test-seed:2026-10-01");

  it("gives every active worker exactly their own self row plus up to quota, and every active lead their coworkers plus self", () => {
    const personDays = [
      { userId: "owner1", projectId: "p1", day: "2026-10-01" },
      { userId: "lead1", projectId: "p1", day: "2026-10-01" },
      { userId: "w1", projectId: "p1", day: "2026-10-01" },
      { userId: "w2", projectId: "p1", day: "2026-10-01" },
      { userId: "w3", projectId: "p1", day: "2026-10-01" },
    ];
    const out = dealAssignments({
      periodStart: "2026-10-01",
      personDays,
      leadIds: new Set(["lead1"]),
      ownerIds: new Set(["owner1"]),
      recentCoworkers: new Map(),
      rng: rng(),
    });
    // Every worker reviews themselves exactly once. (The top-up pass may
    // still add a worker as an EXTRA rater for someone short of the coverage
    // floor, so their total outgoing count is not bounded at quota+self —
    // see the pinned source's own comment: "a top-up may push a rater to
    // three [or more, in a small enough crew]".)
    for (const w of ["w1", "w2", "w3"]) {
      expect(out.filter((a) => a.raterId === w && a.subjectId === w && a.reason === "self")).toHaveLength(1);
    }
    // The lead reviews everyone they worked beside, plus self.
    const leadRows = out.filter((a) => a.raterId === "lead1");
    expect(leadRows.map((a) => a.subjectId).sort()).toEqual(["lead1", "owner1", "w1", "w2", "w3"]);
    // The owner reviews the active lead.
    expect(out.some((a) => a.raterId === "owner1" && a.subjectId === "lead1" && a.reason === "owner_lead")).toBe(true);
  });

  it("gives a solo worker up to two of last month's coworkers at solo weight, never themselves twice", () => {
    const out = dealAssignments({
      periodStart: "2026-10-01",
      personDays: [{ userId: "solo1", projectId: "p9", day: "2026-10-05" }],
      leadIds: new Set(),
      ownerIds: new Set(),
      recentCoworkers: new Map([["solo1", ["mate1", "mate2", "mate3"]]]),
      rng: rng(),
    });
    const dealt = out.filter((a) => a.raterId === "solo1" && a.reason === "solo");
    expect(dealt.length).toBeLessThanOrEqual(2);
    expect(dealt.every((a) => a.solo)).toBe(true);
    expect(out.some((a) => a.raterId === "solo1" && a.subjectId === "solo1" && a.reason === "self")).toBe(true);
  });

  it("never assigns a non-self row where rater === subject", () => {
    const out = dealAssignments({
      periodStart: "2026-10-01",
      personDays: [
        { userId: "a", projectId: "p1", day: "2026-10-01" },
        { userId: "b", projectId: "p1", day: "2026-10-01" },
      ],
      leadIds: new Set(),
      ownerIds: new Set(),
      recentCoworkers: new Map(),
      rng: rng(),
    });
    for (const a of out) {
      if (a.raterId === a.subjectId) expect(a.reason).toBe("self");
    }
  });

  it("the top-up pass cannot lift a one-person site to the coverage floor — the gap is real, not invented", () => {
    const out = dealAssignments({
      periodStart: "2026-10-01",
      personDays: [{ userId: "lonely", projectId: "p1", day: "2026-10-01" }],
      leadIds: new Set(),
      ownerIds: new Set(),
      recentCoworkers: new Map(),
      rng: rng(),
    });
    expect(out.filter((a) => a.subjectId === "lonely" && a.reason !== "self")).toHaveLength(0);
  });
});

describe("assignmentsToStore — redeal is idempotent, late arrivals still collect raters", () => {
  it("a re-deal of an unchanged crew adds nothing new", () => {
    const dealt: Assignment[] = [
      { raterId: "a", subjectId: "b", reason: "dealt", solo: false },
      { raterId: "a", subjectId: "a", reason: "self", solo: false },
    ];
    const stored = [{ raterId: "a", subjectId: "b" }, { raterId: "a", subjectId: "a" }];
    expect(assignmentsToStore(dealt, stored)).toEqual([]);
  });

  it("a rater who already holds rows is never dealt a fresh base pick again", () => {
    const dealt: Assignment[] = [{ raterId: "a", subjectId: "c", reason: "dealt", solo: false }];
    // "a" already has a row this period, and "c" already has two raters (at
    // the coverage floor) — so this is a fresh base pick for an EXISTING
    // rater toward an subject who is not short. Refused.
    const stored = [
      { raterId: "a", subjectId: "b" },
      { raterId: "x", subjectId: "c" },
      { raterId: "y", subjectId: "c" },
    ];
    expect(assignmentsToStore(dealt, stored)).toEqual([]);
  });

  it("a brand-new rater is dealt in full even mid-period", () => {
    const dealt: Assignment[] = [
      { raterId: "new", subjectId: "b", reason: "dealt", solo: false },
      { raterId: "new", subjectId: "new", reason: "self", solo: false },
    ];
    expect(assignmentsToStore(dealt, [])).toEqual(dealt);
  });

  it("a subject still short of the floor can still collect a rater, even an existing one", () => {
    const dealt: Assignment[] = [{ raterId: "a", subjectId: "short", reason: "dealt", solo: false }];
    const stored = [{ raterId: "a", subjectId: "other" }]; // "a" exists, "short" has 0 received
    expect(assignmentsToStore(dealt, stored)).toEqual(dealt);
  });
});

describe("buildMirror — per-value rater threshold (safety fix)", () => {
  const weights = { owner: 1, crew_leader: 0.9, worker: 0.65, self: 0.15, soloFactor: 0.5 };

  it("suppresses a value with fewer than the floor's distinct non-self raters, even when OTHER values in the same window clear it", () => {
    const rows: ScoreRow[] = [
      // Three distinct raters on fullsend — clears the floor.
      { raterId: "r1", raterClass: "worker", solo: false, slug: "fullsend", score: 8 },
      { raterId: "r2", raterClass: "worker", solo: false, slug: "fullsend", score: 7 },
      { raterId: "r3", raterClass: "worker", solo: false, slug: "fullsend", score: 9 },
      // Only ONE rater on safety — must NOT be exposed just because the
      // window overall has three raters (the exact bug this fix closes).
      { raterId: "r1", raterClass: "worker", solo: false, slug: "safety", score: 10 },
    ];
    const mirror = buildMirror(rows, weights);
    expect(mirror.byValue.fullsend.average).not.toBeNull();
    expect(mirror.byValue.safety.average).toBeNull();
    expect(mirror.byValue.safety.raters).toBe(1);
    // The informational overall count is still 3 — it must never be read as
    // "every value has three raters".
    expect(mirror.raterCount).toBe(3);
  });

  it("includes the self score in the combined weighted average, and also reports self separately", () => {
    const rows: ScoreRow[] = [
      { raterId: "r1", raterClass: "worker", solo: false, slug: "growth", score: 6 },
      { raterId: "r2", raterClass: "worker", solo: false, slug: "growth", score: 6 },
      { raterId: "r3", raterClass: "worker", solo: false, slug: "growth", score: 6 },
      { raterId: "subject", raterClass: "self", solo: false, slug: "growth", score: 10 },
    ];
    const mirror = buildMirror(rows, weights);
    expect(mirror.byValue.growth.self).toBe(10);
    // The self weight (0.15) pulls the combined average up from a flat 6.
    expect(mirror.byValue.growth.average!).toBeGreaterThan(6);
    expect(mirror.byValue.growth.average!).toBeLessThan(10);
  });

  it("halves a solo row's weight", () => {
    const base: ScoreRow[] = [
      { raterId: "r1", raterClass: "worker", solo: false, slug: "tribe", score: 2 },
      { raterId: "r2", raterClass: "worker", solo: false, slug: "tribe", score: 2 },
      { raterId: "r3", raterClass: "worker", solo: false, slug: "tribe", score: 2 },
    ];
    const withSolo: ScoreRow[] = [...base, { raterId: "r4", raterClass: "worker", solo: true, slug: "tribe", score: 10 }];
    const plain = buildMirror(base, weights).byValue.tribe.average!;
    const solo = buildMirror(withSolo, weights).byValue.tribe.average!;
    const fullWeight: ScoreRow[] = [...base, { raterId: "r4", raterClass: "worker", solo: false, slug: "tribe", score: 10 }];
    const full = buildMirror(fullWeight, weights).byValue.tribe.average!;
    expect(solo).toBeGreaterThan(plain);
    expect(solo).toBeLessThan(full);
  });
});

describe("buildQuarterlyRating", () => {
  const weights = { owner: 1, crew_leader: 0.9, worker: 0.65, self: 0.15, soloFactor: 0.5 };

  it("overall is the mean of the value averages that cleared the floor, excluding absent ones", () => {
    const rows: ScoreRow[] = [
      { raterId: "r1", raterClass: "worker", solo: false, slug: "fullsend", score: 10 },
      { raterId: "r2", raterClass: "worker", solo: false, slug: "fullsend", score: 10 },
      { raterId: "r3", raterClass: "worker", solo: false, slug: "fullsend", score: 10 },
      // safety has only one rater — never counted toward overall.
      { raterId: "r1", raterClass: "worker", solo: false, slug: "safety", score: 1 },
    ];
    const rating = buildQuarterlyRating(rows, weights);
    expect(rating.overall).toBe(10);
    expect(rating.byValue.safety.average).toBeNull();
  });

  it("overall is null when no value clears the floor", () => {
    const rows: ScoreRow[] = [{ raterId: "r1", raterClass: "worker", solo: false, slug: "fullsend", score: 5 }];
    expect(buildQuarterlyRating(rows, weights).overall).toBeNull();
  });
});

describe("seededRng", () => {
  it("is deterministic for the same seed and varies with the period", () => {
    const a = seededRng("values-deal:2026-10-01");
    const b = seededRng("values-deal:2026-10-01");
    const c = seededRng("values-deal:2026-11-01");
    const seqA = [a(), a(), a()];
    const seqB = [b(), b(), b()];
    const seqC = [c(), c(), c()];
    expect(seqA).toEqual(seqB);
    expect(seqA).not.toEqual(seqC);
  });
});
