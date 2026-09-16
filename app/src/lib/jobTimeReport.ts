import { shiftGuard } from "./shiftGuard";
import { shiftHours, summarizeByJobCostCode, type TimeShift } from "./timeclock";

/** Job clocks are the total; custom/unit timers partition them, never add to them. */
export function jobTimeReport(shifts: TimeShift[], now: number) {
  const seen = new Set<string>();
  const rows = shifts.filter((s) => {
    if (s.status === "voided" || seen.has(s.id)) return false;
    seen.add(s.id);
    return true;
  });
  const recorded: TimeShift[] = [];
  const running: TimeShift[] = [];
  const unresolved: TimeShift[] = [];
  for (const s of rows) {
    if (s.clock_out_at && Number.isFinite(shiftHours(s))) recorded.push(s);
    else if (s.status === "open") {
      const seconds = shiftGuard(s, now).workedSeconds;
      if (seconds !== null && Number.isFinite(seconds)) {
        // A display-only duration passed through the same job/cost-code grouping.
        running.push({ ...s, clock_out_at: new Date(Date.parse(s.clock_in_at) + seconds * 1000).toISOString(), break_seconds: 0 });
      } else unresolved.push(s);
    } else unresolved.push(s);
  }
  const closed = summarizeByJobCostCode(recorded);
  const live = summarizeByJobCostCode(running);
  const combined = summarizeByJobCostCode([...recorded, ...running]);
  return {
    ...combined,
    recordedHours: closed.totalHours,
    runningHours: live.totalHours,
    runningCount: running.length,
    unresolvedCount: unresolved.length,
    peopleCount: new Set(rows.map((s) => s.profile_id)).size,
    recordedCount: recorded.length,
    jobs: summarizeByJobCostCode(rows).jobs.map((job) => ({
      ...job,
      hours: combined.jobs.find((j) => j.jobKey === job.jobKey)?.hours ?? 0,
      recordedHours: closed.jobs.find((j) => j.jobKey === job.jobKey)?.hours ?? 0,
      runningHours: live.jobs.find((j) => j.jobKey === job.jobKey)?.hours ?? 0,
      unresolvedCount: unresolved.filter((s) => (s.project_id ?? "unassigned") === job.jobKey).length,
      costCodes: job.costCodes.map((code) => ({
        ...code,
        hours: combined.jobs.find((j) => j.jobKey === job.jobKey)?.costCodes.find((c) => c.costCodeKey === code.costCodeKey)?.hours ?? 0,
      })),
    })).sort((a, b) => b.hours - a.hours || a.jobCode.localeCompare(b.jobCode)),
  };
}
