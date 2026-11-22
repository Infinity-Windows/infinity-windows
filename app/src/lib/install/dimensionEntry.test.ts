import { describe, expect, it } from "vitest";
import { formatDimensionMm, inchFraction, readDimensionMm } from "./dimensionEntry";

describe("unit dimension entry", () => {
  it("rounds the display without changing the millimeters", () => {
    const mm = readDimensionMm("2781", "metric");
    expect(mm).toBe(2781);
    expect(formatDimensionMm(mm, "imperial")).toBe(`9'1 1/2"`);
    expect(formatDimensionMm(mm, "metric")).toBe("2781");
  });

  it("accepts typical fractional inch and foot inputs", () => {
    expect(readDimensionMm(`3'6½"`, "imperial")).toBeCloseTo(1079.5, 8);
    expect(readDimensionMm(`3′-6 1/2″`, "imperial")).toBeCloseTo(1079.5, 8);
    expect(readDimensionMm("1/16", "imperial")).toBeCloseTo(1.5875, 8);
    expect(readDimensionMm("42", "imperial")).toBeCloseTo(1066.8, 8);
    expect(formatDimensionMm(1.5875, "imperial")).toBe(`0'0 1/16"`);
    expect(inchFraction(12)).toBe("3/4");
  });

  it("carries rounding into the next foot and limits metric display to two places", () => {
    expect(formatDimensionMm(11.98 * 25.4, "imperial")).toBe(`1'0"`);
    expect(formatDimensionMm(1050.126666, "metric")).toBe("1050.13");
    expect(formatDimensionMm(1050.1, "metric")).toBe("1050.1");
    expect(readDimensionMm("1050,125 mm", "metric")).toBe(1050.125);
  });

  it("distinguishes an empty field from an invalid one", () => {
    expect(readDimensionMm("", "metric")).toBeNull();
    expect(readDimensionMm("0", "metric")).toBeUndefined();
    expect(readDimensionMm("2.5.4", "metric")).toBeUndefined();
    expect(readDimensionMm(`4'1/0"`, "imperial")).toBeUndefined();
  });
});
