import { describe, expect, it } from "vitest";
import {
  computeInstallPoints,
  POINT_KINDS,
  pointsByCategory,
  POINT_RULES,
  rankLeaderboard,
  sumPoints,
} from "./points";

describe("computeInstallPoints", () => {
  it("awards base + par + photos + teach + quality when all conditions met", () => {
    const entries = computeInstallPoints({
      minutes: 40,
      parMinutes: 45,
      grade: 5,
      hasPhotos: true,
      hasMemo: true,
    });
    expect(sumPoints(entries)).toBe(
      POINT_RULES.installBase +
        POINT_RULES.parBeat +
        POINT_RULES.photos +
        POINT_RULES.teach +
        POINT_RULES.quality,
    );
  });

  it("no par bonus when over par, no quality bonus under grade 4", () => {
    const entries = computeInstallPoints({
      minutes: 60,
      parMinutes: 45,
      grade: 3,
      hasPhotos: false,
      hasMemo: false,
    });
    expect(entries.map((e) => e.kind)).toEqual(["install"]);
    expect(sumPoints(entries)).toBe(POINT_RULES.installBase);
  });

  it("par bonus is exactly at par (<=), missing data skips par", () => {
    expect(
      computeInstallPoints({ minutes: 45, parMinutes: 45, grade: null, hasPhotos: false, hasMemo: false })
        .some((e) => e.kind === "par"),
    ).toBe(true);
    expect(
      computeInstallPoints({ minutes: null, parMinutes: 45, grade: null, hasPhotos: false, hasMemo: false })
        .some((e) => e.kind === "par"),
    ).toBe(false);
  });
});

describe("pointsByCategory", () => {
  it("returns all six categories in canonical order with zeros for missing kinds", () => {
    const result = pointsByCategory([]);
    expect(result.map((r) => r.kind)).toEqual([
      "install",
      "par",
      "photos",
      "teach",
      "quality",
      "quiz",
    ]);
    expect(result.map((r) => r.kind)).toEqual(POINT_KINDS);
    expect(result.every((r) => r.points === 0)).toBe(true);
  });

  it("sums only confirmed rows, ignoring pending and void", () => {
    const result = pointsByCategory([
      { kind: "install", points: 20, status: "confirmed" },
      { kind: "install", points: 20, status: "pending" },
      { kind: "install", points: 20, status: "void" },
      { kind: "quality", points: 5, status: "confirmed" },
    ]);
    const byKind = Object.fromEntries(result.map((r) => [r.kind, r.points]));
    expect(byKind.install).toBe(20);
    expect(byKind.quality).toBe(5);
    expect(byKind.par).toBe(0);
  });

  it("accumulates correct subtotals per category and keeps categories separate", () => {
    const result = pointsByCategory([
      { kind: "install", points: 20, status: "confirmed" },
      { kind: "install", points: 20, status: "confirmed" },
      { kind: "par", points: 15, status: "confirmed" },
      { kind: "teach", points: 15, status: "confirmed" },
      { kind: "quality", points: 5, status: "confirmed" },
      { kind: "quiz", points: 10, status: "confirmed" },
      { kind: "photos", points: 10, status: "confirmed" },
    ]);
    expect(result).toEqual([
      { kind: "install", points: 40 },
      { kind: "par", points: 15 },
      { kind: "photos", points: 10 },
      { kind: "teach", points: 15 },
      { kind: "quality", points: 5 },
      { kind: "quiz", points: 10 },
    ]);
  });

  it("ignores unknown kinds without throwing", () => {
    const result = pointsByCategory([
      { kind: "mystery", points: 99, status: "confirmed" },
      { kind: "install", points: 20, status: "confirmed" },
    ]);
    expect(result).toHaveLength(POINT_KINDS.length);
    expect(result.find((r) => r.kind === "install")?.points).toBe(20);
  });
});

describe("rankLeaderboard", () => {
  const crew = [
    { id: "mike", display_name: "Mike Alvarez" },
    { id: "sam", display_name: "Sam Reed" },
  ];

  it("totals points per person, highest first", () => {
    const rows = rankLeaderboard(
      [
        { profile_id: "mike", points: 20 },
        { profile_id: "sam", points: 15 },
        { profile_id: "mike", points: 20 },
      ],
      crew,
    );
    expect(rows).toEqual([
      { profile_id: "mike", display_name: "Mike Alvarez", points: 40 },
      { profile_id: "sam", display_name: "Sam Reed", points: 15 },
    ]);
  });

  it("leaves a test account out of the ranking entirely", () => {
    const rows = rankLeaderboard(
      [
        { profile_id: "mike", points: 20 },
        { profile_id: "bot", points: 9999 },
      ],
      [...crew, { id: "bot", display_name: "TEST — automation", is_test: true }],
    );
    expect(rows.map((r) => r.profile_id)).toEqual(["mike"]);
  });

  it("counts everyone when the test flag is absent, so an old database still ranks", () => {
    const rows = rankLeaderboard(
      [{ profile_id: "mike", points: 20 }, { profile_id: "sam", points: 5 }],
      crew,
    );
    expect(rows.map((r) => r.profile_id)).toEqual(["mike", "sam"]);
  });

  it("names someone it has no profile for rather than dropping their points", () => {
    const rows = rankLeaderboard([{ profile_id: "ghost", points: 7 }], crew);
    expect(rows).toEqual([{ profile_id: "ghost", display_name: "crew", points: 7 }]);
  });
});
