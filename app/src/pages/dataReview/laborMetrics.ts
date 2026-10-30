import {formatHours} from "./formatHours";
import type { WorkUnit } from "../../lib/customWork/model";
import type { ActivityRow } from "./activityRows";

export type LaborMetric = "hours" | "area" | "opening";
export const metricLabels: Record<LaborMetric, string> = { hours: "Total hours", area: "Minutes / ft²", opening: "Minutes / opening" };
export const metricUnits: Record<LaborMetric, string> = { hours: "h", area: "min/ft²", opening: "min/opening" };
export function formatMetric(value: number | null, metric: LaborMetric) {
  if (value === null) return "—";
  if(metric==="hours"&&Math.abs(value)>=1000)return formatHours(value);
  const precision = metric === "area" ? 3 : 2;
  const threshold = 10 ** -precision;
  return value > 0 && value < threshold ? `<${threshold.toFixed(precision)}` : value.toFixed(precision);
}

/** One denominator per physical opening, shared by all segments in its parent bar. */
export function laborMetricContext(rows: ActivityRow[], units: WorkUnit[], metric: LaborMetric) {
  const byUnit = new Map(units.map(unit => [unit.id, unit]));
  const openingFor = (row: ActivityRow) => {
    const unit = row.unitId ? byUnit.get(row.unitId) : undefined;
    if (row.unitFacts?.linkConflict || row.scope !== "Specific" || (unit && row.jobId && row.jobId !== unit.project_id)) return null;
    return unit?.opening_id ?? row.openingId ?? null;
  };
  const linked = new Set(rows.map(openingFor).filter((id): id is string => !!id));
  const areas = new Map<string, number>();
  const conflicts = new Set<string>();
  for (const unit of units) {
    if (!unit.opening_id || !linked.has(unit.opening_id)) continue;
    const w = unit.facts.width_in, h = unit.facts.height_in;
    if (typeof w !== "number" || typeof h !== "number" || !Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0 || !Number.isFinite(w * h)) continue;
    const area = w * h / 144;
    const previous = areas.get(unit.opening_id);
    if (previous !== undefined && Math.abs(previous - area) > .000001) conflicts.add(unit.opening_id);
    areas.set(unit.opening_id, area);
  }
  const resolved = new Map<string, number>();
  const enrichedOpenings = new Set<string>();
  for (const row of rows) {
    const id = openingFor(row), facts = row.unitFacts;
    if (!id || !facts) continue;
    enrichedOpenings.add(id);
    if (facts.dimensionConflict) conflicts.add(id);
    if (facts.area !== null) {
      if (resolved.has(id) && Math.abs(resolved.get(id)! - facts.area) > .000001) conflicts.add(id);
      resolved.set(id, facts.area);
    }
  }
  for (const id of enrichedOpenings) areas.delete(id);
  for (const [id, area] of resolved) areas.set(id, area);
  for (const id of conflicts) areas.delete(id);
  const eligible = (row: ActivityRow) => metric === "hours" || !!(openingFor(row) && (metric === "opening" || areas.has(openingFor(row)!)));
  const eligibleRows = rows.filter(eligible);
  const measure = (numerator: ActivityRow[], denominator = numerator) => {
    const eligibleNumerator = numerator.filter(eligible);
    const seconds = eligibleNumerator.reduce((sum, row) => sum + row.seconds, 0);
    const ids = new Set(denominator.filter(eligible).map(openingFor).filter((id): id is string => !!id));
    const area = [...ids].reduce((sum, id) => sum + (areas.get(id) ?? 0), 0);
    return { seconds, openings: ids.size, area,
      value: metric === "hours" ? seconds / 3600 : !eligibleNumerator.length ? null : metric === "opening" ? ids.size ? seconds / 60 / ids.size : null : area > 0 ? seconds / 60 / area : null };
  };
  return { eligibleRows, measure, linkedOpenings: linked.size, dimensionedOpenings: areas.size,
    missingDimensions: linked.size - areas.size, dimensionConflicts: conflicts.size,
    unlinkedRecords: rows.filter(row => row.scope === "Specific" && !openingFor(row)).length,
    generalRecords: rows.filter(row => row.scope === "General").length,
    excludedSeconds: rows.filter(row => !eligible(row)).reduce((sum, row) => sum + row.seconds, 0) };
}
