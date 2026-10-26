import { expect, it } from "vitest";
import { presetRange, reorderDimension, reportDimensions } from "./reportControls";

it("uses Monday–Sunday calendar weeks and whole months across year and leap-day boundaries", () => {
  expect(presetRange("thisWeek", "2026-10-23")).toEqual({ from: "2026-10-19", until: "2026-10-25" });
  expect(presetRange("lastWeek", "2026-10-23")).toEqual({ from: "2026-10-12", until: "2026-10-18" });
  expect(presetRange("thisWeek", "2027-01-01")).toEqual({ from: "2026-12-28", until: "2027-01-03" });
  expect(presetRange("thisMonth", "2026-10-23")).toEqual({ from: "2026-10-01", until: "2026-10-31" });
  expect(presetRange("lastMonth", "2027-01-01")).toEqual({ from: "2026-12-01", until: "2026-12-31" });
  expect(presetRange("lastMonth", "2024-03-01")).toEqual({ from: "2024-02-01", until: "2024-02-29" });
});

it("builds inclusive rolling dates with month-end and leap-year clamping", () => {
  expect(presetRange("week", "2026-10-22")).toEqual({ from: "2026-10-16", until: "2026-10-22" });
  expect(presetRange("month", "2026-03-31")).toEqual({ from: "2026-02-28", until: "2026-03-31" });
  expect(presetRange("quarter", "2026-10-22").from).toBe("2026-07-22");
  expect(presetRange("year", "2024-02-29").from).toBe("2023-02-28");
  expect(presetRange("all", "2026-10-22")).toEqual({ from: "", until: "" });
});

it("moves a card to the drop position without losing or duplicating dimensions", () => {
  const moved = reorderDimension(reportDimensions, "job", "person");
  expect(moved).toEqual(["floor", "activity", "scope", "person", "job", "category", "subtype", "configuration", "system", "material"]);
  expect(reorderDimension(moved, "job", "floor")).toEqual(reportDimensions);
  expect(new Set(moved).size).toBe(reportDimensions.length);
  expect(reportDimensions).not.toContain("unit");
});
