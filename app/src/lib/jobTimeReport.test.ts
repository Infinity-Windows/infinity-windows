import { describe, expect, it, vi } from "vitest";
vi.mock("./supabase", () => ({ supabase: {}, supabaseConfigured: true }));
import { jobTimeReport } from "./jobTimeReport";
import type { TimeShift } from "./timeclock";
const now = Date.parse("2026-09-16T18:00:00Z");
const shift = (id: string, fields: Partial<TimeShift> = {}) => ({
  id, profile_id: id, project_id: "job", cost_code_id: "install",
  clock_in_at: "2026-09-16T14:00:00Z", clock_out_at: "2026-09-16T18:00:00Z",
  status: "submitted", break_seconds: 0, break_started_at: null,
  ...fields,
} as TimeShift);

describe("job totals reconcile finished and running crew clocks", () => {
  it("includes every person's recorded and live time once, subtracting both stored and running breaks", () => {
    const done = shift("a", { break_seconds: 1800 });
    const report = jobTimeReport([done, done, shift("b", {
      status: "open", clock_out_at: null, break_seconds: 1800, break_started_at: "2026-09-16T17:30:00Z",
    }), shift("c", { project_id: null, cost_code_id: null, status: "approved" })], now);
    expect(report.recordedHours).toBe(7.5);
    expect(report.runningHours).toBe(3);
    expect(report.totalHours).toBe(10.5);
    expect(report.peopleCount).toBe(3);
    expect(report.runningCount).toBe(1);
    expect(report.jobs.find((j) => j.jobKey === "job")?.hours).toBe(6.5);
    expect(report.jobs.flatMap((j) => j.costCodes).reduce((sum, c) => sum + c.hours, 0)).toBe(report.totalHours);
  });
  it("keeps unknown finish times visible without guessing or accumulating runaway hours", () => {
    const report = jobTimeReport([
      shift("a", { status: "open", clock_out_at: null, clock_in_at: "2026-09-14T14:00:00Z" }),
      shift("b", { status: "needs_finish", clock_out_at: null }),
      shift("c", { status: "voided" }),
      shift("d", { status: "rejected" }),
    ], now);
    expect(report.totalHours).toBe(4);
    expect(report.unresolvedCount).toBe(2);
    expect(report.jobs[0].unresolvedCount).toBe(2);
    expect(report.runningCount).toBe(0);
    expect(report.peopleCount).toBe(3);
  });
});
