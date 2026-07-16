import { describe, expect, it } from "vitest";
import {
  estimateJob,
  fallbackMinutes,
  recommendCrew,
  variance,
  type EstimateOpening,
  type TypeStat,
} from "./estimate";

const stats: TypeStat[] = [
  { window_type_id: "cas", median_minutes: 40, p90_minutes: 55, difficulty: 3 },
  { window_type_id: "dh", median_minutes: 25, p90_minutes: 32, difficulty: 1 },
];

function op(type: string | null, installed = false): EstimateOpening {
  return { window_type_id: type, installed };
}

describe("estimateJob", () => {
  it("sums per-type medians and P90 for remaining openings", () => {
    const e = estimateJob([op("cas"), op("dh"), op("cas", true)], stats);
    expect(e.remaining).toBe(2);
    expect(e.expectedMinutes).toBe(65); // 40 + 25
    expect(e.p90Minutes).toBe(87); // 55 + 32
    expect(e.unknownTypes).toBe(0);
  });

  it("uses a difficulty-scaled fallback for unknown types", () => {
    const e = estimateJob([op("unknown-type")], stats);
    expect(e.unknownTypes).toBe(1);
    expect(e.expectedMinutes).toBe(fallbackMinutes(null));
  });

  it("ignores installed openings", () => {
    const e = estimateJob([op("cas", true), op("dh", true)], stats);
    expect(e.remaining).toBe(0);
    expect(e.expectedMinutes).toBe(0);
  });
});

describe("recommendCrew", () => {
  it("recommends enough installers to hit the target window", () => {
    // 16 crew-hours over an 8h day -> 2 installers.
    const e = estimateJob(
      Array.from({ length: 24 }, () => op("cas")),
      stats,
    ); // 24 * 40 = 960m = 16h
    const rec = recommendCrew(e, 8);
    expect(rec.crewHours).toBe(16);
    expect(rec.recommendedCrew).toBe(2);
    expect(rec.hoursToFinish).toBe(8);
  });

  it("always recommends at least one installer", () => {
    const e = estimateJob([op("dh")], stats);
    expect(recommendCrew(e).recommendedCrew).toBe(1);
  });
});

describe("variance", () => {
  it("computes over/under estimate", () => {
    expect(variance(40, 50)).toMatchObject({ deltaMinutes: 10, pctOver: 25 });
    expect(variance(40, 30).pctOver).toBe(-25);
  });
  it("handles zero estimate", () => {
    expect(variance(0, 30).pctOver).toBe(0);
  });
});
