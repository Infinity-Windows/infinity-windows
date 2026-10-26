import type { ActivityRow } from "./activityRows";

function quantile(sorted: number[], fraction: number) {
  const index = (sorted.length - 1) * fraction;
  const lower = Math.floor(index);
  return sorted[lower] + (sorted[Math.ceil(index)] - sorted[lower]) * (index - lower);
}

export function visitStats(rows: ActivityRow[]) {
  const groups = new Map<string, ActivityRow[]>();
  for (const row of rows) {
    const label = `${row.scope} · ${row.activity}`;
    groups.set(label, [...(groups.get(label) ?? []), row]);
  }
  return [...groups].map(([label, records]) => {
    const values = records.map(r => r.seconds).sort((a, b) => a - b);
    const q1 = quantile(values, .25), q3 = quantile(values, .75);
    const iqr = q3 - q1;
    // A descriptive flag, not a determination that a record is incorrect.
    const flagged = records.length >= 5 ? records.filter(r => r.seconds < q1 - 1.5 * iqr || r.seconds > q3 + 1.5 * iqr) : [];
    return { label, records, min: values[0], max: values[values.length - 1], q1, q3,
      median: quantile(values, .5), mean: values.reduce((sum, value) => sum + value, 0) / values.length,
      flaggedIds: flagged.map(r => r.id), shortIds: records.filter(r => r.seconds < 60).map(r => r.id) };
  }).sort((a, b) => b.max - a.max || a.label.localeCompare(b.label));
}
