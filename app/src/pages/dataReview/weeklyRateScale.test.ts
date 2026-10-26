import { expect, it } from "vitest";
import { weeklyRateScale } from "./weeklyRateScale";
it("keeps the main pack linear while retaining extremes in a marked compressed range", () => {
  const values = [0, .1, .2, .3, .4, .5, .6, 100];
  const axis = weeklyRateScale(values);
  expect(axis.cutoff).not.toBeNull();
  expect(axis.position(.2) - axis.position(.1)).toBeCloseTo(axis.position(.3) - axis.position(.2));
  expect(axis.position(.6)).toBeGreaterThan(.2);
  for (const value of values) { expect(axis.position(value)).toBeGreaterThanOrEqual(0); expect(axis.position(value)).toBeLessThan(1); }
  expect(axis.position(100)).toBeGreaterThan(.75);
  expect(axis.position(axis.cutoff!)).toBeCloseTo(.75);
});
it("uses one linear scale for ordinary ranges, empty data and sparse samples", () => {
  for (const values of [[], [0, 0], [1, 2, 3, 4, 5], [1, 1000]]) {
    const axis = weeklyRateScale(values);
    expect(axis.cutoff).toBeNull(); expect(axis.ticks.every(Number.isFinite)).toBe(true);
  }
});

it("fits a small-rate range without forcing a one-minute ceiling", () => { expect(weeklyRateScale([.001, .002]).position(.002)).toBeGreaterThan(.9); });
