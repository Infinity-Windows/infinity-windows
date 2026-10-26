import { expect, it } from "vitest";
import type { ActivityRow } from "./activityRows";
import { visitStats } from "./visitStats";

const row = (seconds: number, index: number, activity = "Installing") => ({ id: String(index), seconds, activity, scope: "Specific" }) as ActivityRow;

it("shows an extreme without silently removing it from mean, range or inspection", () => {
  const result = visitStats([60, 120, 180, 240, 300, 360, 7200].map((seconds, i) => row(seconds, i)))[0];
  expect(result.median).toBe(240);
  expect(result.q1).toBe(150); expect(result.q3).toBe(330);
  expect(result.mean).toBeCloseTo(8460 / 7);
  expect(result.max).toBe(7200); expect(result.flaggedIds).toEqual(["6"]);
  expect(result.records).toHaveLength(7);
});

it("does not assign outlier status to tiny samples or mix unlike activities", () => {
  const result = visitStats([row(2, 0), row(80000, 1), row(90, 2, "Flashing")]);
  expect(result).toHaveLength(2);
  expect(result.every(group => group.flaggedIds.length === 0)).toBe(true);
  expect(result.find(group => group.label.endsWith("Installing"))?.shortIds).toEqual(["0"]);
  expect(visitStats([])).toEqual([]);
});
