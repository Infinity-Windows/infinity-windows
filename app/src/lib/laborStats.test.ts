import { describe, expect, it, vi } from "vitest";
vi.mock("./supabase", () => ({ supabase: {}, supabaseConfigured: true }));
import { summarizeLabor } from "./laborStats";
import type { TimeShift } from "./timeclock";

function shift(patch: Partial<TimeShift> = {}): TimeShift {
  return { id: "s1", profile_id: "p1", project_id: "j1", cost_code_id: "c1",
    clock_in_at: "2026-09-01T14:00:00Z", clock_out_at: "2026-09-01T22:00:00Z",
    break_seconds: 1800, break_started_at: null, injured: false, time_confirmed: true,
    status: "approved", created_at: "2026-09-01T14:00:00Z",
    profiles: { display_name: "Test worker" }, projects: { job_code: "A", name: "Job A" },
    cost_codes: { code: "100", label: "Install" }, ...patch };
}

describe("cost-code labor stats", () => {
  it("reconciles employee, job, and code totals after breaks", () => {
    const report = summarizeLabor([shift(), shift({ id: "s2", cost_code_id: null, cost_codes: null })]);
    expect(report.totalHours).toBe(15);
    expect(report.codedHours).toBe(7.5);
    expect(report.workers[0].costCodes.reduce((n, c) => n + c.hours, 0)).toBe(15);
    expect(report.jobs[0].hours).toBe(15);
    expect(report.workers[0].days.size).toBe(1);
    expect(report.workers[0].costCodes.some((c) => c.label === "No cost code")).toBe(true);
  });
  it("counts submitted time but separates open and disputed time", () => {
    const report = summarizeLabor([
      shift({ status: "submitted" }), shift({ id: "s2", status: "open", clock_out_at: null }),
      shift({ id: "s3", status: "rejected" }), shift({ id: "s4", status: "needs_finish" }),
      shift({ id: "s5", status: "voided" }),
    ]);
    expect(report.totalHours).toBe(7.5);
    expect(report.workers[0].openShifts).toBe(1);
    expect(report.workers[0].needsReview).toBe(2);
  });
  it("does not double-count repeated shifts or merge workers with matching names", () => {
    const a = shift();
    const report = summarizeLabor([a, a, shift({ id: "s2", profile_id: "p2" })]);
    expect(report.totalHours).toBe(15);
    expect(report.workers).toHaveLength(2);
  });
  it("retains workers with zero time and historical workers outside the active roster", () => {
    const report = summarizeLabor([shift()], [{ id: "new", display_name: "New worker" }]);
    expect(report.workers.map((p) => p.hours)).toEqual([7.5, 0]);
  });
  it("uses Mountain calendar days and one day per worker per job", () => {
    const report = summarizeLabor([shift({ clock_in_at: "2026-09-02T01:00:00Z", clock_out_at: "2026-09-02T02:00:00Z", break_seconds: 0 }), shift()]);
    expect(report.workers[0].days.size).toBe(1);
    expect(report.jobs[0].days.size).toBe(1);
  });
  it("keeps no-job time visible and ignores corrupt or negative durations", () => {
    const report = summarizeLabor([shift({ project_id: null, projects: null }), shift({ id: "bad", clock_in_at: "bad" }), shift({ id: "negative", break_seconds: 999999 })]);
    expect(report.totalHours).toBe(7.5);
    expect(report.jobs[0].label).toBe("No job");
  });
});
