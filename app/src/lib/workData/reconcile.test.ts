import { describe, expect, it } from "vitest";
import { reconcileShift, reconcileWorkday, rollupActivities, type EvidenceClaim, type EvidenceShift } from "./reconcile";
import { shiftHours } from "../../../../supabase/functions/_shared/timeMath";

const at = (minutes: number) => new Date(Date.UTC(2026, 9, 3, 8) + minutes * 60000).toISOString();
const shift: EvidenceShift = { id: "shift", profileId: "worker", projectId: "job", startedAt: at(0),
  endedAt: at(480), breakSeconds: 1800, breakStartedAt: null, status: "approved" };
const claim = (id: string, start: number, end: number, scope: EvidenceClaim["scope"] = "specific"): EvidenceClaim => ({
  sourceId: `sessions:${id}`, sourceTable: "sessions", revision: 1, profileId: "worker", projectId: "job",
  shiftId: "shift", unitId: scope === "specific" ? "unit" : null, activityId: id, label: id, scope,
  startedAt: at(start), endedAt: at(end),
});
const cutoff = Date.parse(at(480));
const lunch = { sourceId: "break:1", shiftId: "shift", startedAt: at(240), endedAt: at(270), paid: false };
function conserved(result: ReturnType<typeof reconcileShift>) {
  expect(result.classifiedSeconds + result.conflictSeconds + result.unknownSeconds + result.paidBreakSeconds)
    .toBeCloseTo(result.payrollSeconds, 7);
}

describe("permission-filtered workday reconciliation", () => {
  it("reconciles 480 gross / 30 unpaid to 450 paid without adding activity labor to payroll", () => {
    const result = reconcileShift(shift, [claim("setup", 0, 10, "setup"), claim("morning", 10, 240),
      claim("afternoon", 270, 425)], [lunch], cutoff);
    expect(result.grossSeconds).toBe(480 * 60);
    expect(result.payrollSeconds).toBe(450 * 60);
    expect(result.classifiedSeconds).toBe(395 * 60);
    expect(result.unknownSeconds).toBe(55 * 60);
    expect(result.unpaidBreakSeconds).toBe(30 * 60);
    conserved(result);
    expect(result.payrollSeconds).toBe(shiftHours({ clock_in_at: shift.startedAt, clock_out_at: shift.endedAt,
      break_seconds: shift.breakSeconds, break_started_at: null }) * 3600);
  });
  it("preserves both overlapping claims but counts the conflict once", () => {
    const result = reconcileShift({ ...shift, endedAt: at(60), breakSeconds: 0 },
      [claim("A", 0, 40), claim("B", 30, 60)], [], cutoff);
    expect(result.classifiedSeconds).toBe(50 * 60);
    expect(result.conflictSeconds).toBe(10 * 60);
    expect(result.slices.find(s => s.kind === "conflict")?.sourceIds).toEqual(["sessions:A", "sessions:B"]);
    conserved(result);
  });
  it("deduplicates a replay by original source ID and refuses contradictory copies", () => {
    const c = claim("A", 0, 60);
    const s = { ...shift, endedAt: at(60), breakSeconds: 0 };
    expect(reconcileShift(s, [c, { ...c }], [], cutoff).classifiedSeconds).toBe(3600);
    expect(() => reconcileShift(s, [c, { ...c, endedAt: at(70) }], [], cutoff)).toThrow(/changed/);
  });
  it("uses half-open same-timestamp boundaries without inventing overlap", () => {
    const result = reconcileShift({ ...shift, endedAt: at(60), breakSeconds: 0 },
      [claim("A", 0, 30, "general"), claim("B", 30, 60)], [], cutoff);
    expect(result.classifiedSeconds).toBe(3600);
    expect(result.conflictSeconds).toBe(0);
    conserved(result);
  });
  it("never guesses where a scalar historical break happened", () => {
    const result = reconcileShift(shift, [claim("A", 0, 480)], [], cutoff);
    expect(result.payrollSeconds).toBe(27000);
    expect(result.classifiedSeconds).toBe(0);
    expect(result.unknownSeconds).toBe(27000);
    expect(result.breakPlacementKnown).toBe(false);
    expect(result.issues).toContain("break_placement_unknown");
    expect(result.slices).toEqual([]);
    conserved(result);
  });
  it("distinguishes saved-on-phone claims from confirmed server evidence", () => {
    const result = reconcileShift({ ...shift, endedAt: at(60), breakSeconds: 0 },
      [{ ...claim("queued", 0, 60), pending: true }], [], cutoff);
    expect(result.pendingCount).toBe(1);
    expect(result.classifiedSeconds).toBe(0);
    expect(result.unknownSeconds).toBe(3600);
  });
  it("clips claims to their exact authoritative shift and never borrows another worker's time", () => {
    const result = reconcileShift({ ...shift, endedAt: at(60), breakSeconds: 0 },
      [claim("A", -20, 80), { ...claim("helper", 0, 60), profileId: "helper" },
        { ...claim("old_shift", 0, 60), shiftId: "other_shift" }], [], cutoff);
    expect(result.classifiedSeconds).toBe(3600);
    expect(result.conflictSeconds).toBe(0);
    expect(result.issues).toContain("outside_shift:sessions:A");
  });
  it("retains explicitly linked project mismatches as unresolved, never attributing them to a unit", () => {
    const result = reconcileShift({ ...shift, endedAt: at(60), breakSeconds: 0 },
      [{ ...claim("A", 0, 60), projectId: "old_job" }], [], cutoff);
    expect(result.classifiedSeconds).toBe(0);
    expect(result.conflictSeconds).toBe(3600);
    expect(result.issues).toContain("project_mismatch:sessions:A");
  });
  it("does not manufacture missing finish time or pay for a voided shift", () => {
    for (const status of ["needs_finish", "voided"]) {
      const result = reconcileShift({ ...shift, endedAt: null, status }, [claim("A", 0, 480)], [], cutoff);
      expect(result.payrollSeconds).toBe(0);
      expect(result.unpaidBreakSeconds).toBe(1800);
      expect(result.slices).toEqual([]);
    }
  });
  it("retains invalid evidence as an issue instead of NaN labor", () => {
    const result = reconcileShift({ ...shift, endedAt: at(60), breakSeconds: 0 },
      [{ ...claim("A", 0, 60), startedAt: "invalid" }], [], cutoff);
    expect(result.issues).toContain("invalid_claim:sessions:A");
    expect(result.unknownSeconds).toBe(3600);
    conserved(result);
  });
  it("preserves live payroll and excludes an active break", () => {
    const result = reconcileShift({ ...shift, endedAt: null, breakSeconds: 0, breakStartedAt: at(60), status: "open" },
      [claim("A", 0, 60)], [], Date.parse(at(90)));
    expect(result.payrollSeconds).toBe(3600);
    expect(result.unpaidBreakSeconds).toBe(1800);
    expect(result.classifiedSeconds).toBe(3600);
    expect(result.provisional).toBe(true);
    conserved(result);
  });
  it("flags overlapping break evidence without changing payroll", () => {
    const result = reconcileShift(shift, [], [lunch, { ...lunch, sourceId: "break:2" }], cutoff);
    expect(result.breakPlacementKnown).toBe(false);
    expect(result.issues).toContain("overlapping_breaks");
    expect(result.payrollSeconds).toBe(27000);
    conserved(result);
  });
  it("handles explicit paid breaks as part of the same paid pool without changing policy", () => {
    const result = reconcileShift({ ...shift, endedAt: at(60), breakSeconds: 0 }, [claim("A", 0, 60)],
      [{ ...lunch, startedAt: at(30), endedAt: at(40), paid: true }], cutoff);
    expect(result.classifiedSeconds).toBe(3000);
    expect(result.paidBreakSeconds).toBe(600);
    expect(result.payrollSeconds).toBe(3600);
    conserved(result);
  });
  it("keeps live subsecond payroll rounding provisional without over-attributing paid time", () => {
    const result = reconcileShift({ ...shift, endedAt: null, breakSeconds: 0, status: "open" },
      [{ ...claim("A", 0, 60), endedAt: null }], [], Date.parse(at(60)) + 500);
    expect(result.payrollSeconds).toBe(3600);
    expect(result.classifiedSeconds).toBe(0);
    expect(result.issues).toContain("live_rounding");
    conserved(result);
  });
  it("preserves future-dated recorded payroll as an exception rather than clipping its pay", () => {
    const result = reconcileShift({ ...shift, endedAt: at(60), breakSeconds: 0 }, [claim("A", 0, 60)], [], Date.parse(at(30)));
    expect(result.payrollSeconds).toBe(3600);
    expect(result.grossSeconds).toBe(3600);
    expect(result.classifiedSeconds).toBe(0);
    expect(result.issues).toContain("finish_after_snapshot");
    conserved(result);
  });
  it("retains activity during breaks as an explicit source exception", () => {
    const result = reconcileShift(shift, [claim("A", 0, 480)], [lunch], cutoff);
    expect(result.issues).toContain("activity_during_break:sessions:A");
    conserved(result);
  });
  it("flags overlapping shifts without unioning or changing either payroll record", () => {
    const result = reconcileWorkday([{ ...shift, endedAt: at(60), breakSeconds: 0 },
      { ...shift, id: "second", startedAt: at(30), endedAt: at(90), breakSeconds: 0 }], [claim("A", 0, 60)], [], cutoff);
    expect(result.map(r => r.payrollSeconds)).toEqual([3600, 3600]);
    for (const r of result) { expect(r.conflictSeconds).toBe(3600); expect(r.issues).toContain("overlapping_payroll_shifts"); conserved(r); }
    expect(() => reconcileWorkday([shift, shift], [], [], cutoff)).toThrow(/Duplicate/);
  });
  it("does not attach a different day's unlinked activity to every shift", () => {
    const result = reconcileShift({ ...shift, endedAt: at(60), breakSeconds: 0 },
      [{ ...claim("old", -120, -60), shiftId: null }], [], cutoff);
    expect(result.issues).toEqual([]);
    expect(result.unknownSeconds).toBe(3600);
  });
  it("retains clock review warnings even when activity completely covers paid time", () => {
    const result = reconcileShift({ ...shift, endedAt: at(60), breakSeconds: 0, reviewReason: "clock_off" }, [claim("A", 0, 60)], [], cutoff);
    expect(result.classifiedSeconds).toBe(3600);
    expect(result.issues).toContain("clock_review_required");
  });
});

describe("reversible reporting rollups", () => {
  const rows = [{ activityId: "measuring", label: "Measuring", seconds: 120, sourceIds: ["1"] },
    { activityId: "ro", label: "RO check", seconds: 240, sourceIds: ["2"] },
    { activityId: "unknown", label: "Legacy", seconds: 60, sourceIds: ["3"] }];
  it("counts Measuring + RO once and preserves searchable raw evidence", () => {
    const result = rollupActivities(rows, { measuring: "ro" });
    expect(result.reduce((n, r) => n + r.seconds, 0)).toBe(rows.reduce((n, r) => n + r.seconds, 0));
    expect(result.find(r => r.activityId === "ro")?.sourceIds).toEqual(["1", "2"]);
    expect(rows[0].activityId).toBe("measuring");
    expect(result.find(r => r.activityId === "unknown")?.seconds).toBe(60);
  });
  it("rejects cycles even in mappings without current labor", () => {
    expect(() => rollupActivities(rows, { unused: "loop", loop: "unused" })).toThrow(/cycle/);
    expect(() => rollupActivities(rows, { ro: "ro" })).toThrow(/cycle/);
  });
});
