import { describe, expect, it } from "vitest";
import type { WorkUnit } from "../../lib/customWork/model";
import type { ActivityRow } from "./activityRows";
import { allUnitFilters, unitMatches, unitReporting } from "./unitReporting";

describe("unit reporting", () => {
  it("normalizes equivalent facts without asserting verification", () => {
    const facts = unitReporting({ facts: { story: " 1st ", material: " Aluminum ", width_in: 60, height_in: 60, area_source: "From plans" } } as WorkUnit);
    expect(facts).toMatchObject({ floor: "1", material: "aluminum", area: 25, areaBand: "small", dimensionsVerified: false, dimensionSource: "From plans" });
    expect(unitReporting({ facts: { story: "1" } } as WorkUnit).floor).toBe(facts.floor);
  });
  it("retains unknown, invalid and unresolved unit facts", () => {
    expect(unitReporting()).toMatchObject({ floor: "unknown", material: "unknown", area: null, areaBand: "unknown" });
    expect(unitReporting({ facts: { width_in: Infinity, height_in: 10 } } as WorkUnit).area).toBeNull();
    const row = { scope: "Specific", unitId: "missing" } as ActivityRow;
    expect(unitMatches(row, new Map(), { ...allUnitFilters(), area: ["unknown"] })).toBe(true);
    expect(unitMatches(row, new Map(), { ...allUnitFilters(), area: ["small"] })).toBe(false);
  });
  it("intersects selected unit facets while preserving General labor", () => {
    const units = new Map([["u", { facts: { story: "2nd", material: "Wood", width_in: 120, height_in: 120 } } as WorkUnit]]);
    const filters = { floor: ["2"], material: ["wood"], area: ["large"] };
    expect(unitMatches({ scope: "Specific", unitId: "u" } as ActivityRow, units, filters)).toBe(true);
    expect(unitMatches({ scope: "Specific", unitId: "u" } as ActivityRow, units, { ...filters, material: [] })).toBe(false);
    expect(unitMatches({ scope: "General", unitId: null } as ActivityRow, units, { ...filters, material: [] })).toBe(true);
  });
});
