import type { LaborMetric } from "./laborMetrics";
import type { ActivityRow } from "./activityRows";
import type { WorkUnit } from "../../lib/customWork/model";
import { midnight, workDate } from "./generalLabor";
import { unitRatePoints } from "./unitRatePoints";

export const nextWeekDate = (date: string, days = 7) => new Date(Date.parse(`${date}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
export function unitRateWeek(time: number) {
  const date = workDate(time);
  return nextWeekDate(date, -(new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7);
}
/** Split captured seconds proportionately across Denver calendar weeks. The
 * same opening can appear in multiple weeks; these are weekly contributions,
 * never an assertion that installation completed that week. */
export function weeklyUnitRates(rows: ActivityRow[], units: WorkUnit[], from: number, until: number, now = Date.now(), anchor?: string, metric: LaborMetric = "area") {
  const weekAt = (time: number) => anchor ? nextWeekDate(anchor, Math.floor((Date.parse(`${workDate(time)}T12:00:00Z`) - Date.parse(`${anchor}T12:00:00Z`)) / 86400000 / 7) * 7) : unitRateWeek(time);
  const buckets = new Map<string, ActivityRow[]>();
  let invalid = 0;
  for (const row of rows) {
    if (row.scope !== "Specific") continue;
    const originalStart = Date.parse(row.started), originalEnd = Date.parse(row.ended);
    const start = Math.max(originalStart, from), end = Math.min(originalEnd, until, now);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !Number.isFinite(row.seconds) || row.seconds <= 0) { invalid++; continue; }
    // Input seconds already clipped to page dates, while timestamps are original.
    const scopedDuration = Math.min(originalEnd, until) - Math.max(originalStart, from);
    for (let cursor = start; cursor < end;) {
      const week = weekAt(cursor), stop = Math.min(end, midnight(nextWeekDate(week)));
      const part = { ...row, seconds: row.seconds * (stop - cursor) / scopedDuration };
      buckets.set(week, [...(buckets.get(week) ?? []), part]); cursor = stop;
    }
  }
  const keys = [...buckets.keys()].sort();
  const first = Number.isFinite(from) ? weekAt(from) : keys[0];
  const lastTime = Math.min(until, now);
  const last = Number.isFinite(lastTime) ? weekAt(lastTime - 1) : keys.at(-1);
  const weeks: string[] = [];
  if (first && last) for (let week = first; week <= last; week = nextWeekDate(week)) weeks.push(week);
  let excluded = 0, unlinked = 0;
  const points = weeks.flatMap(week => {
    const result = unitRatePoints(buckets.get(week) ?? [], units, metric);
    excluded += result.excluded; unlinked += result.unlinked;
    return result.points.map(point => ({ ...point, key: `${week}/${point.key}`, week, actualWeek: week }));
  });
  const medians = weeks.flatMap(week => [...new Set(points.filter(point => point.week === week).map(point => point.jobId))].map(jobId => {
    const samples = points.filter(point => point.week === week && point.jobId === jobId);
    const values = samples.map(point => point.value!).sort((a, b) => a - b);
    const middle = Math.floor(values.length / 2);
    return { week, jobId, job: samples[0].job, count: values.length, value: values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2 };
  }));
  return { weeks, points, medians, excluded, unlinked, invalid, partialWeeks: weeks.filter(week => midnight(week) < from || midnight(nextWeekDate(week)) > Math.min(until, now)) };
}

export function relativeWeeklyUnitRates(rows: ActivityRow[], units: WorkUnit[], anchors: Map<string, string>, count: number, now = Date.now(), metric: LaborMetric = "area") {
  const weeks = Array.from({ length: count }, (_, index) => `Week ${index + 1}`);
  const reports = [...anchors].map(([job, anchor]) => ({ anchor, report: weeklyUnitRates(rows.filter(row => row.jobId === job).flatMap(row => {
    const start = Date.parse(row.started), end = Date.parse(row.ended);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [row];
    const overlap = Math.max(0, Math.min(end, midnight(nextWeekDate(anchor, count * 7))) - Math.max(start, midnight(anchor)));
    return overlap ? [{ ...row, seconds: row.seconds * overlap / (end - start) }] : [];
  }), units, midnight(anchor), midnight(nextWeekDate(anchor, count * 7)), now, anchor, metric) }));
  return { weeks, points: reports.flatMap(({ anchor, report }) => report.points.map(point => ({ ...point, week: `Week ${Math.round((Date.parse(`${point.week}T12:00:00Z`) - Date.parse(`${anchor}T12:00:00Z`)) / 86400000 / 7) + 1}` }))), medians: [],
    excluded: reports.reduce((sum, item) => sum + item.report.excluded, 0), unlinked: reports.reduce((sum, item) => sum + item.report.unlinked, 0), invalid: reports.reduce((sum, item) => sum + item.report.invalid, 0),
    partialWeeks: weeks.filter((_, index) => reports.some(({ anchor }) => midnight(nextWeekDate(anchor, (index + 1) * 7)) > now)) };
}
