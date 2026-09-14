import { shiftHours, type TimeShift } from "./timeclock";

export interface LaborBucket {
  id: string;
  label: string;
  hours: number;
  days: Set<string>;
}

export interface WorkerLabor extends LaborBucket {
  costCodes: LaborBucket[];
  jobs: LaborBucket[];
  openShifts: number;
  needsReview: number;
}

/** Calendar days belong to Forge's operating timezone, including older shifts. */
const dayFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Denver", year: "numeric", month: "2-digit", day: "2-digit",
});

function add(map: Map<string, LaborBucket>, id: string, label: string, hours: number, day: string) {
  const bucket = map.get(id) ?? { id, label, hours: 0, days: new Set<string>() };
  bucket.hours += hours;
  if (hours > 0) bucket.days.add(day);
  map.set(id, bucket);
}

function sorted(map: Map<string, LaborBucket>) {
  return [...map.values()].sort((a, b) => b.hours - a.hours || a.label.localeCompare(b.label));
}

/** Clocked labor only. Unit timers and daily-log allocations are not extra hours. */
export function summarizeLabor(shifts: TimeShift[], roster: { id: string; display_name: string }[] = []) {
  const people = new Map<string, WorkerLabor>();
  const codes = new Map<string, Map<string, LaborBucket>>();
  const jobs = new Map<string, Map<string, LaborBucket>>();
  const allJobs = new Map<string, LaborBucket>();
  const seen = new Set<string>();
  let totalHours = 0;
  let codedHours = 0;
  const person = (id: string, name: string) => {
    if (!people.has(id)) {
      people.set(id, { id, label: name, hours: 0, days: new Set(), costCodes: [], jobs: [], openShifts: 0, needsReview: 0 });
      codes.set(id, new Map());
      jobs.set(id, new Map());
    }
    return people.get(id)!;
  };
  for (const row of roster) person(row.id, row.display_name);
  for (const shift of shifts) {
    if (seen.has(shift.id) || shift.status === "voided") continue;
    seen.add(shift.id);
    const worker = person(shift.profile_id, shift.profiles?.display_name ?? "Unknown worker");
    if (shift.status === "open") { worker.openShifts++; continue; }
    if (shift.status === "needs_finish" || shift.status === "rejected") { worker.needsReview++; continue; }
    if (!shift.clock_out_at) { worker.needsReview++; continue; }
    const hours = shiftHours(shift);
    if (!Number.isFinite(hours) || hours <= 0) continue;
    const day = dayFormatter.format(new Date(shift.clock_in_at));
    worker.hours += hours;
    worker.days.add(day);
    totalHours += hours;
    if (shift.cost_code_id) codedHours += hours;
    add(codes.get(worker.id)!, shift.cost_code_id ?? "unassigned", shift.cost_codes
      ? `${shift.cost_codes.code} — ${shift.cost_codes.label}`
      : shift.cost_code_id ? "Unavailable cost code" : "No cost code", hours, day);
    const jobId = shift.project_id ?? "unassigned";
    const jobName = shift.projects ? `${shift.projects.job_code} · ${shift.projects.name}`
      : shift.project_id ? "Unavailable job" : "No job";
    add(jobs.get(worker.id)!, jobId, jobName, hours, day);
    add(allJobs, jobId, jobName, hours, day);
  }
  for (const worker of people.values()) {
    worker.costCodes = sorted(codes.get(worker.id)!);
    worker.jobs = sorted(jobs.get(worker.id)!);
  }
  return {
    workers: [...people.values()].sort((a, b) => b.hours - a.hours || a.label.localeCompare(b.label)),
    jobs: sorted(allJobs), totalHours, codedHours,
  };
}
