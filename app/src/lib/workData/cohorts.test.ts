import { describe, expect, it } from "vitest";
import { reconcileWorkday, type EvidenceClaim, type EvidenceShift } from "./reconcile";
import { summarizeCohort, unitLabor, type UnitFacts } from "./cohorts";
const at = (h: number) => new Date(Date.UTC(2026, 9, 3, h)).toISOString();
const unit: UnitFacts = { id: "u", label: "W1", category: "Window", subtype: null, material: "Aluminum",
  floor: null, widthIn: 48, heightIn: 72, dimensionSource: "verified field measurement",
  dimensionsVerified: true, complete: true, qcAccepted: true, hasUntimedEvidence: false };
const shift: EvidenceShift = { id: "s", profileId: "p", projectId: "job", startedAt: at(8), endedAt: at(10),
  breakSeconds: 0, breakStartedAt: null, status: "approved" };
const claim: EvidenceClaim = { sourceId: "custom:1", sourceTable: "custom_work_sessions", revision: 1,
  profileId: "p", projectId: "job", shiftId: "s", unitId: "u", activityId: "frame", label: "Frame",
  scope: "specific", startedAt: at(8), endedAt: at(10) };
describe("matched unit cohorts", () => {
  it("counts helper labor while counting the same unit area only once", () => {
    const claims = [claim, { ...claim, sourceId: "custom:2", profileId: "helper", shiftId: "h" }];
    const coverage = reconcileWorkday([shift, { ...shift, id: "h", profileId: "helper" }], claims, [], Date.parse(at(11)));
    const rows = unitLabor([unit], claims, coverage);
    const total = summarizeCohort(rows);
    expect(total.areaSqFt).toBe(24); expect(total.paidSeconds).toBe(14400);
    expect(total.hoursPerSqFt).toBe(4 / 24); expect(total.floorArea.get("unknown")).toBe(24);
  });
  it("excludes estimates and their labor together without borrowing another unit's area", () => {
    const c = { ...claim, sourceId: "custom:2", unitId: "estimate", profileId: "other", shiftId: "other" };
    const claims = [claim, c];
    const coverage = reconcileWorkday([shift, { ...shift, id: "other", profileId: "other" }], claims, [], Date.parse(at(11)));
    const rows = unitLabor([unit, { ...unit, id: "estimate", widthIn: 120, dimensionsVerified: false }], claims, coverage);
    const total = summarizeCohort(rows);
    expect(total.eligibleIds).toEqual(["u"]); expect(total.areaSqFt).toBe(24);
    expect(total.paidSeconds).toBe(7200); expect(total.excludedSeconds).toBe(7200);
  });
  it("keeps untimed names, rework, unaccepted QC and payroll exceptions out of trusted averages", () => {
    const claims = [{ ...claim, rework: true }];
    const coverage = reconcileWorkday([{ ...shift, breakSeconds: 60 }], claims, [], Date.parse(at(11)));
    const rows = unitLabor([{ ...unit, qcAccepted: false, hasUntimedEvidence: true }], claims, coverage);
    expect(rows[0].exclusions).toEqual(expect.arrayContaining(["qc_not_accepted", "untimed_evidence", "rework", "coverage_exception"]));
    expect(summarizeCohort(rows).hoursPerSqFt).toBeNull();
  });
  it("refuses duplicate canonical areas and exposes missing dimensions and outside-clock evidence", () => {
    expect(() => unitLabor([unit, unit], [], [])).toThrow(/Duplicate/);
    const rows = unitLabor([{ ...unit, heightIn: 0 }], [claim], []);
    expect(rows[0].exclusions).toEqual(expect.arrayContaining(["dimensions_missing", "outside_payroll", "no_attributed_labor"]));
    expect(rows[0].areaSqFt).toBeNull();
  });
});
