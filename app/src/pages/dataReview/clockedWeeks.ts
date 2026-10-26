import { shiftHours, type TimeShift } from "../../lib/timeclock";
import { midnight, workDate, type GeneralBucket } from "./generalLabor";

const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
const daysBetween = (start: string, end: string) => (Date.parse(`${end}T12:00:00Z`) - Date.parse(`${start}T12:00:00Z`)) / 86400000;
export function clockedWeeks(shifts: TimeShift[], periodStart?: (date: string) => string, periodDays = 7) {
  const weeks = new Map<string, GeneralBucket & { percent: number | null }>();
  const seen = new Set<string>();
  for (const shift of shifts) {
    if (seen.has(shift.id) || shift.status === "voided" || !shift.clock_out_at || !Number.isFinite(Date.parse(shift.clock_in_at))) continue;
    seen.add(shift.id);
    const seconds = shiftHours(shift) * 3600;
    if (!Number.isFinite(seconds)) continue;
    const date = new Date(`${workDate(Date.parse(shift.clock_in_at))}T12:00:00Z`);
    date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
    const key = periodStart ? periodStart(workDate(Date.parse(shift.clock_in_at))) : date.toISOString().slice(0, 10);
    const week = weeks.get(key) ?? { key, seconds: 0, totalSeconds: 0, ids: [], segments: [], partial: false, percent: 100 };
    const activity = shift.cost_codes ? `${shift.cost_codes.code} · ${shift.cost_codes.label}` : "No cost code";
    let segment = week.segments.find(item => item.activity === activity);
    if (!segment) { segment = { activity, seconds: 0, ids: [] }; week.segments.push(segment); }
    segment.seconds += seconds; segment.ids.push(shift.id);
    week.seconds += seconds; week.totalSeconds += seconds; week.ids.push(shift.id);
    weeks.set(key, week);
  }
  const keys = [...weeks.keys()].sort();
  if (keys.length) for (let time = Date.parse(`${keys[0]}T12:00:00Z`); time <= Date.parse(`${keys.at(-1)}T12:00:00Z`); time += periodDays * 86400000) {
    const key = new Date(time).toISOString().slice(0, 10);
    if (!weeks.has(key)) weeks.set(key, { key, seconds: 0, totalSeconds: 0, percent: null, ids: [], segments: [], partial: false });
  }
  return [...weeks.values()].sort((a, b) => a.key.localeCompare(b.key)).map(week => ({ ...week, segments: [...week.segments].sort((a, b) => a.activity.localeCompare(b.activity)), partial: midnight(addDays(week.key, periodDays)) > Date.now() }));
}

/** Daily net shift allocations use the same clock-in-date basis as weeks.
 * Calendar arithmetic keeps Denver days correct across daylight saving. */
export function clockedDays(shifts: TimeShift[], from: number, until: number, jobLabels?: Map<string, string>, now = Date.now()) {
  const buckets = clockedWeeks(shifts, date => date, 1);
  const first = Number.isFinite(from) ? workDate(from) : buckets[0]?.key;
  const last = Number.isFinite(until) ? workDate(until - 1) : buckets.at(-1)?.key;
  if (!first || !last || first > last) return [];
  const jobs = jobLabels ? [...jobLabels.keys()].sort() : [""];
  const series = jobs.map(id => ({ id, days: id ? clockedWeeks(shifts.filter(shift => (shift.project_id ?? "unassigned") === id), date => date, 1) : buckets }));
  const result = [];
  for (let date = first; date <= last; date = addDays(date, 1)) {
    for (const job of series) {
      const day = job.days.find(bucket => bucket.key === date);
      result.push({ ...(day ?? { key: date, seconds: 0, totalSeconds: 0, percent: null, ids: [], segments: [], partial: false }), partial: midnight(date) < now && midnight(addDays(date, 1)) > now, unavailable: midnight(date) > now,
        ...(jobLabels ? { seriesKey: job.id, seriesLabel: jobLabels.get(job.id) ?? job.id } : {}) });
    }
  }
  return result;
}

/** Consecutive seven-day Denver periods anchored to the first finished shift,
 * using full history so date/activity filters never renumber a job's weeks. */
export function clockedRelativeJobWeeks(shifts: TimeShift[], history: TimeShift[], count?: number, anchors?: Map<string, string>) {
  const jobs = [...new Set(shifts.map(shift => shift.project_id ?? "unassigned"))].sort();
  const series = jobs.flatMap(id => {
    const records = history.filter(shift => (shift.project_id ?? "unassigned") === id && shift.status !== "voided" && shift.clock_out_at && Number.isFinite(Date.parse(shift.clock_in_at)) && Number.isFinite(shiftHours(shift)));
    const anchor = anchors ? anchors.get(id) : records.map(shift => workDate(Date.parse(shift.clock_in_at))).sort()[0];
    if (!anchor) return [];
    const weeks = clockedWeeks(shifts.filter(shift => (shift.project_id ?? "unassigned") === id), date => addDays(anchor, Math.floor(daysBetween(anchor, date) / 7) * 7));
    return [{ id, label: records[0]?.projects?.job_code ?? shifts.find(shift => shift.project_id === id)?.projects?.job_code ?? "No job", anchor, weeks }];
  });
  const indices = series.flatMap(job => job.weeks.map(week => Math.round(daysBetween(job.anchor, week.key) / 7)));
  if (!indices.length) return [];
  const result = [];
  for (let index = count ? 0 : Math.min(...indices); index <= (count ? count - 1 : Math.max(...indices)); index++) {
    for (const job of series) {
      const key = addDays(job.anchor, index * 7);
      const week = job.weeks.find(item => item.key === key);
      result.push({ ...(week ?? { key, seconds: 0, totalSeconds: 0, percent: null, ids: [], segments: [], partial: false }), unavailable: !week, future: midnight(key) > Date.now(), seriesKey: job.id, seriesLabel: job.label, groupKey: `relative:${index}`, groupLabel: `Week ${index + 1}` });
    }
  }
  return result;
}

/** One bar per job/week, with a shared calendar and distinct shift membership. */
export function clockedJobWeeks(shifts: TimeShift[]) {
  const calendar = clockedWeeks(shifts);
  const jobs = [...new Set(shifts.map(shift => shift.project_id ?? "unassigned"))].sort();
  const series = jobs.map(id => {
    const records = shifts.filter(shift => (shift.project_id ?? "unassigned") === id);
    return { id, label: records[0]?.projects?.job_code ?? "No job", weeks: clockedWeeks(records) };
  });
  return calendar.flatMap(week => series.map(job => ({
    ...(job.weeks.find(item => item.key === week.key) ?? { ...week, seconds: 0, totalSeconds: 0, percent: null, ids: [], segments: [] }),
    seriesKey: job.id, seriesLabel: job.label,
  })));
}

/** Small, per-job history windows; never substitute a shared calendar range. */
export function relativeClockWindows(origins: TimeShift[], count: number) {
  const weeks = Math.max(1, Math.min(52, Math.floor(count)));
  return origins.filter(shift => shift.project_id && shift.clock_out_at && shift.status !== "voided").map(shift => {
    const anchor = workDate(Date.parse(shift.clock_in_at));
    return { jobId: shift.project_id!, from: midnight(anchor), until: midnight(addDays(anchor, weeks * 7)) };
  });
}
