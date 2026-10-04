import { describe, expect, it } from "vitest";
import { unitLabor, type UnitFacts, type UnitLabor as UnitLaborRow } from "./cohorts";
import type { CoverageSlice, EvidenceClaim, EvidenceShift, ShiftCoverage } from "./reconcile";
import { facetValues, filterUnits, groupUnitMetrics, summarizeUnits, unitActivityRows } from "./exploration";

let nextId = 0;
function unitFacts(overrides: Partial<UnitFacts> = {}): UnitFacts {
  nextId += 1;
  return {
    id: `unit-${nextId}`,
    label: `Unit ${nextId}`,
    category: null,
    subtype: null,
    material: null,
    floor: null,
    widthIn: null,
    heightIn: null,
    dimensionSource: null,
    dimensionsVerified: false,
    complete: true,
    qcAccepted: false,
    hasUntimedEvidence: false,
    ...overrides,
  };
}

function evidenceShift(overrides: Partial<EvidenceShift> = {}): EvidenceShift {
  return {
    id: "shift-1",
    profileId: "person-1",
    projectId: "project-1",
    startedAt: "2026-01-01T08:00:00.000Z",
    endedAt: "2026-01-01T16:00:00.000Z",
    breakSeconds: 0,
    breakStartedAt: null,
    status: "approved",
    ...overrides,
  };
}

function claim(
  overrides: { sourceId: string; unitId: string | null; activityId: string; label: string } & Partial<EvidenceClaim>,
): EvidenceClaim {
  return {
    sourceTable: "custom_work_sessions",
    revision: null,
    profileId: "person-1",
    projectId: "project-1",
    shiftId: "shift-1",
    startedAt: "2026-01-01T08:00:00.000Z",
    endedAt: "2026-01-01T09:00:00.000Z",
    scope: "specific",
    ...overrides,
  };
}

function slice(startedAt: string, endedAt: string, seconds: number, kind: CoverageSlice["kind"], sourceIds: string[]): CoverageSlice {
  return { startedAt, endedAt, seconds, kind, sourceIds };
}

function shiftCoverage(shift: EvidenceShift, slices: CoverageSlice[]): ShiftCoverage {
  const total = slices.reduce((n, s) => n + s.seconds, 0);
  return {
    shift,
    grossSeconds: total,
    payrollSeconds: total,
    provisional: false,
    classifiedSeconds: total,
    unknownSeconds: 0,
    conflictSeconds: 0,
    paidBreakSeconds: 0,
    unpaidBreakSeconds: 0,
    pendingCount: 0,
    breakPlacementKnown: true,
    issues: [],
    slices,
  };
}

function rowsOf(units: UnitFacts[], claims: EvidenceClaim[] = [], coverage: ShiftCoverage[] = []): UnitLaborRow[] {
  return unitLabor(units, claims, coverage);
}

describe("summarizeUnits", () => {
  it("counts a helper-assisted unit's area once and sums both contributors' labor", () => {
    const unit = unitFacts({
      id: "unit-a", widthIn: 36, heightIn: 48, dimensionSource: "measured",
      dimensionsVerified: true, complete: true, qcAccepted: true,
    });
    const claims = [
      claim({ sourceId: "s1", unitId: "unit-a", activityId: "frame", label: "Frame", profileId: "p1", shiftId: "shift-1" }),
      claim({ sourceId: "s2", unitId: "unit-a", activityId: "frame", label: "Frame", profileId: "p2", shiftId: "shift-2",
        startedAt: "2026-01-01T09:00:00.000Z", endedAt: "2026-01-01T09:30:00.000Z" }),
    ];
    const shift1 = evidenceShift({ id: "shift-1", profileId: "p1" });
    const shift2 = evidenceShift({ id: "shift-2", profileId: "p2" });
    const coverage = [
      shiftCoverage(shift1, [slice("2026-01-01T08:00:00.000Z", "2026-01-01T08:15:00.000Z", 900, "specific", ["s1"])]),
      shiftCoverage(shift2, [slice("2026-01-01T09:00:00.000Z", "2026-01-01T09:30:00.000Z", 1800, "specific", ["s2"])]),
    ];
    const rows = rowsOf([unit], claims, coverage);
    const metrics = summarizeUnits(rows);
    expect(metrics.count).toBe(1);
    expect(metrics.knownAreaSqFt).toBeCloseTo(12, 5);
    expect(metrics.trustedAreaSqFt).toBeCloseTo(12, 5);
    expect(metrics.trustedSeconds).toBe(2700);
    expect(metrics.paidSeconds).toBe(2700);
    expect(metrics.excludedCount).toBe(0);
  });

  it("excludes an unaccepted-QC unit from the trusted numerator/denominator while keeping its labor in the operational total", () => {
    const unitA = unitFacts({
      id: "unit-a", widthIn: 36, heightIn: 48, dimensionSource: "measured",
      dimensionsVerified: true, complete: true, qcAccepted: true,
    });
    const unitB = unitFacts({
      id: "unit-b", widthIn: 24, heightIn: 36, dimensionSource: "measured",
      dimensionsVerified: true, complete: true, qcAccepted: false,
    });
    const claimA = claim({ sourceId: "ca", unitId: "unit-a", activityId: "frame", label: "Frame" });
    const claimB = claim({ sourceId: "cb", unitId: "unit-b", activityId: "frame", label: "Frame",
      startedAt: "2026-01-01T09:00:00.000Z", endedAt: "2026-01-01T09:10:00.000Z" });
    const shift = evidenceShift();
    const coverage = [shiftCoverage(shift, [
      slice("2026-01-01T08:00:00.000Z", "2026-01-01T08:20:00.000Z", 1200, "specific", ["ca"]),
      slice("2026-01-01T09:00:00.000Z", "2026-01-01T09:10:00.000Z", 600, "specific", ["cb"]),
    ])];
    const rows = rowsOf([unitA, unitB], [claimA, claimB], coverage);
    const metrics = summarizeUnits(rows);
    expect(metrics.eligibleCount).toBe(1);
    expect(metrics.excludedCount).toBe(1);
    expect(metrics.trustedAreaSqFt).toBeCloseTo(12, 5);
    expect(metrics.trustedSeconds).toBe(1200);
    expect(metrics.excludedSeconds).toBe(600);
    expect(metrics.paidSeconds).toBe(1800);
  });

  it("counts an overlapping multi-reason exclusion once per reason without doubling the excluded total", () => {
    const unit = unitFacts({
      id: "unit-c", widthIn: null, heightIn: null, dimensionSource: null,
      dimensionsVerified: false, complete: true, qcAccepted: true,
    });
    const claimC = claim({ sourceId: "cc", unitId: "unit-c", activityId: "frame", label: "Frame" });
    const shift = evidenceShift();
    const coverage = [shiftCoverage(shift, [
      slice("2026-01-01T08:00:00.000Z", "2026-01-01T08:08:20.000Z", 500, "specific", ["cc"]),
    ])];
    const rows = rowsOf([unit], [claimC], coverage);
    const metrics = summarizeUnits(rows);
    expect(metrics.excludedCount).toBe(1);
    expect(metrics.excludedSeconds).toBe(500);
    const reasons = new Map(metrics.reasons.map(r => [r.reason, r]));
    expect(reasons.get("dimensions_missing")).toEqual({ reason: "dimensions_missing", count: 1, seconds: 500 });
    expect(reasons.get("dimensions_unverified")).toEqual({ reason: "dimensions_unverified", count: 1, seconds: 500 });
  });

  it("returns an all-zero summary for an empty cohort", () => {
    const metrics = summarizeUnits([]);
    expect(metrics).toEqual({
      count: 0, knownAreaSqFt: 0, paidSeconds: 0, eligibleCount: 0, trustedAreaSqFt: 0,
      trustedSeconds: 0, excludedCount: 0, excludedSeconds: 0, hoursPerSqFt: null, reasons: [],
    });
  });

  it("refuses duplicate canonical unit IDs instead of double-counting them", () => {
    const unit = unitFacts({ id: "unit-dup" });
    const row = rowsOf([unit])[0];
    expect(() => summarizeUnits([row, row])).toThrow(/Duplicate canonical unit/);
    expect(() => groupUnitMetrics([row, row], "floor")).toThrow(/Duplicate canonical unit/);
    expect(() => unitActivityRows([row, row], [], [])).toThrow(/Duplicate canonical unit/);
    expect(() => filterUnits([row, row], {})).not.toThrow();
  });
});

describe("facetValues and filterUnits", () => {
  it("keeps a literal 'Unknown' label distinct from a missing (null/blank) floor", () => {
    const missing = unitFacts({ id: "u-missing", floor: null });
    const blank = unitFacts({ id: "u-blank", floor: "  " });
    const literal = unitFacts({ id: "u-literal", floor: "Unknown" });
    const named = unitFacts({ id: "u-named", floor: "2" });
    const rows = rowsOf([missing, blank, literal, named]);

    expect(facetValues(rows, "floor")).toEqual(["2", "Unknown", null]);

    const unknownFloor = filterUnits(rows, { floor: null }).map(r => r.unit.id).sort();
    expect(unknownFloor).toEqual(["u-blank", "u-missing"]);

    const literalFloor = filterUnits(rows, { floor: "Unknown" }).map(r => r.unit.id);
    expect(literalFloor).toEqual(["u-literal"]);
  });

  it("applies inclusive area bounds and excludes unknown area only when a bound is set", () => {
    const area10 = unitFacts({ id: "u10", widthIn: 120, heightIn: 12 });
    const area20 = unitFacts({ id: "u20", widthIn: 240, heightIn: 12 });
    const area30 = unitFacts({ id: "u30", widthIn: 120, heightIn: 36 });
    const unknown = unitFacts({ id: "u-unknown", widthIn: null, heightIn: null });
    const rows = rowsOf([area10, area20, area30, unknown]);

    expect(filterUnits(rows, {}).map(r => r.unit.id).sort()).toEqual(["u-unknown", "u10", "u20", "u30"]);

    const bounded = filterUnits(rows, { minArea: 10, maxArea: 20 }).map(r => r.unit.id).sort();
    expect(bounded).toEqual(["u10", "u20"]);
  });

  it("refuses invalid area bounds instead of silently ignoring them", () => {
    const rows = rowsOf([unitFacts()]);
    expect(() => filterUnits(rows, { minArea: -1 })).toThrow();
    expect(() => filterUnits(rows, { maxArea: Number.NaN })).toThrow();
    expect(() => filterUnits(rows, { minArea: 20, maxArea: 10 })).toThrow();
  });
});

describe("groupUnitMetrics", () => {
  it("reconciles floor buckets to the same filtered category set, with Unknown explicit", () => {
    const w1 = unitFacts({ id: "w1", category: "Window", floor: "1", widthIn: 120, heightIn: 12, dimensionSource: "measured", dimensionsVerified: true, qcAccepted: true });
    const w2 = unitFacts({ id: "w2", category: "Window", floor: "2", widthIn: 240, heightIn: 12, dimensionSource: "measured", dimensionsVerified: true, qcAccepted: true });
    const w3 = unitFacts({ id: "w3", category: "Window", floor: null, widthIn: 60, heightIn: 12, dimensionSource: "measured", dimensionsVerified: true, qcAccepted: true });
    const d1 = unitFacts({ id: "d1", category: "Door", floor: "1", widthIn: 120, heightIn: 36, dimensionSource: "measured", dimensionsVerified: true, qcAccepted: true });

    const claims = [
      claim({ sourceId: "c-w1", unitId: "w1", activityId: "frame", label: "Frame" }),
      claim({ sourceId: "c-w2", unitId: "w2", activityId: "frame", label: "Frame" }),
      claim({ sourceId: "c-w3", unitId: "w3", activityId: "frame", label: "Frame" }),
      claim({ sourceId: "c-d1", unitId: "d1", activityId: "frame", label: "Frame" }),
    ];
    const shift = evidenceShift();
    const coverage = [shiftCoverage(shift, [
      slice("2026-01-01T08:00:00.000Z", "2026-01-01T08:16:40.000Z", 1000, "specific", ["c-w1"]),
      slice("2026-01-01T08:16:40.000Z", "2026-01-01T08:50:00.000Z", 2000, "specific", ["c-w2"]),
      slice("2026-01-01T08:50:00.000Z", "2026-01-01T09:08:20.000Z", 500, "specific", ["c-w3"]),
      slice("2026-01-01T09:08:20.000Z", "2026-01-01T09:20:00.000Z", 700, "specific", ["c-d1"]),
    ])];

    const rows = rowsOf([w1, w2, w3, d1], claims, coverage);
    const windowsOnly = filterUnits(rows, { category: "Window" });
    const byFloor = groupUnitMetrics(windowsOnly, "floor");

    expect(byFloor.map(g => g.value)).toEqual(["1", "2", null]);
    const unknownBucket = byFloor.find(g => g.value === null)!;
    expect(unknownBucket.count).toBe(1);
    expect(unknownBucket.paidSeconds).toBe(500);

    const totals = summarizeUnits(windowsOnly);
    expect(byFloor.reduce((n, g) => n + g.knownAreaSqFt, 0)).toBeCloseTo(totals.knownAreaSqFt, 5);
    expect(byFloor.reduce((n, g) => n + g.paidSeconds, 0)).toBe(totals.paidSeconds);
  });
});

describe("unitActivityRows", () => {
  function buildFixture() {
    const unit = unitFacts({ id: "unit-d" });
    const claims = [
      claim({ sourceId: "d1", unitId: "unit-d", activityId: "rfq", label: "RO Check" }),
      claim({ sourceId: "d2", unitId: "unit-d", activityId: "rfq", label: "RO quality check/fix" }),
      claim({ sourceId: "d3", unitId: "unit-d", activityId: "frame", label: "Frame" }),
    ];
    const shift = evidenceShift();
    const coverage = [shiftCoverage(shift, [
      slice("2026-01-01T08:00:00.000Z", "2026-01-01T08:15:00.000Z", 900, "specific", ["d1"]),
      slice("2026-01-01T08:15:00.000Z", "2026-01-01T08:45:00.000Z", 1800, "specific", ["d2"]),
      slice("2026-01-01T08:45:00.000Z", "2026-01-01T08:55:00.000Z", 600, "specific", ["d3"]),
      slice("2026-01-01T08:55:00.000Z", "2026-01-01T09:15:00.000Z", 1200, "specific", ["d4", "d5"]),
    ])];
    const rows = rowsOf([unit], claims, coverage);
    return { rows, claims, coverage };
  }

  it("keeps the same activityId under two different historical labels as separate rows", () => {
    const { rows, claims, coverage } = buildFixture();
    const byUnit = unitActivityRows(rows, claims, coverage);
    const entries = byUnit.get("unit-d")!;
    const rfqEntries = entries.filter(e => e.activityId === "rfq");
    expect(rfqEntries.map(e => e.label).sort()).toEqual(["RO Check", "RO quality check/fix"]);
    expect(rfqEntries.find(e => e.label === "RO Check")?.seconds).toBe(900);
    expect(rfqEntries.find(e => e.label === "RO quality check/fix")?.seconds).toBe(1800);
  });

  it("omits an ambiguous multi-source slice and reconciles to the unit's attributed paidSeconds", () => {
    const { rows, claims, coverage } = buildFixture();
    const byUnit = unitActivityRows(rows, claims, coverage);
    const entries = byUnit.get("unit-d")!;
    expect(entries.some(e => e.activityId === "sill")).toBe(false);
    const total = entries.reduce((n, e) => n + e.seconds, 0);
    expect(total).toBe(rows[0].paidSeconds);
    expect(total).toBe(3300);
  });

  it("returns an empty map for an empty unit selection", () => {
    expect(unitActivityRows([], [], [])).toEqual(new Map());
  });
});
