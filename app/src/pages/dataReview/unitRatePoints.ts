import type { WorkUnit } from "../../lib/customWork/model";
import type { ActivityRow } from "./activityRows";
import { laborMetricContext, type LaborMetric } from "./laborMetrics";

/** One point per physical opening; repeated timers never repeat its area. */
export function unitRatePoints(rows: ActivityRow[], units: WorkUnit[], metric: LaborMetric = "area") {
  const byUnit = new Map(units.map(unit => [unit.id, unit]));
  const groups = new Map<string, ActivityRow[]>();
  let unlinked = 0;
  for (const row of rows) {
    if (row.scope !== "Specific") continue;
    const opening = byUnit.get(row.unitId ?? "")?.opening_id ?? row.openingId;
    if (!opening || row.unitFacts?.linkConflict) { unlinked++; continue; }
    const key = JSON.stringify([row.jobId, opening]);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const context = laborMetricContext(rows, units, metric);
  let excluded = 0;
  const points = [...groups].flatMap(([key, records]) => {
    const measurement = context.measure(records);
    // Never show a subset of an opening's selected labor as its complete rate.
    if (measurement.value === null || (metric === "area" && measurement.area <= 0) || context.eligibleRows.filter(row => records.includes(row)).length !== records.length) { excluded++; return []; }
    return [{ key, records, jobId: records[0].jobId ?? "", job: records[0].job ?? "Unknown job", unit: records[0].openingCode ?? records[0].unit, ...measurement }];
  }).sort((a, b) => a.job.localeCompare(b.job) || a.unit.localeCompare(b.unit, undefined, { numeric: true }) || a.key.localeCompare(b.key));
  return { points, excluded, unlinked };
}
