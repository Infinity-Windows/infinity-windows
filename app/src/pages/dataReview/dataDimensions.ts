import { workAttribution } from "./workAttribution";
import type { ActivityRow } from "./activityRows";

export const dimensionLabels = { job: "Job", floor: "Floor", unit: "Unit", activity: "Activity", scope: "Work attribution", person: "Person", category: "Unit category", subtype: "Operation", configuration: "Configuration", system: "System", material: "Material" };
export type Dimension = keyof typeof dimensionLabels;
export type Facet = { include: string[]; exclude: string[] };
export type Facets = Record<Dimension, Facet>;
export const dimensions = Object.keys(dimensionLabels) as Dimension[];
export const emptyFacets = (): Facets => ({ job: { include: [], exclude: [] }, floor: { include: [], exclude: [] }, unit: { include: [], exclude: [] }, activity: { include: [], exclude: [] }, scope: { include: [], exclude: [] }, person: { include: [], exclude: [] }, category: { include: [], exclude: [] }, subtype: { include: [], exclude: [] }, configuration: { include: [], exclude: [] }, system: { include: [], exclude: [] }, material: { include: [], exclude: [] } });
export function dimensionValue(row: ActivityRow, dimension: Dimension) {
  if (dimension === "scope") { const label = workAttribution(row); return { key: label, label }; }
  if (dimension === "category" || dimension === "subtype" || dimension === "configuration" || dimension === "system" || dimension === "material") {
    const value = row.scope === "General" ? "Not allocated" : row[dimension]?.trim() || "Unknown";
    return { key: value, label: value };
  }
  const key = dimension === "job" ? row.jobId ?? "no-job" : dimension === "unit" ? row.unitId ?? "no-unit" : dimension === "person" ? row.personId : row[dimension];
  const label = dimension === "job" ? row.job ?? key : dimension === "unit" ? `${row.job ?? row.jobId ?? ""} · Unit ${row.unit}` : dimension === "person" ? row.person : row[dimension];
  return { key, label };
}
export function matchesFacets(row: ActivityRow, facets: Facets, except?: Dimension) {
  return dimensions.every(dimension => {
    if (dimension === except) return true;
    const key = dimensionValue(row, dimension).key;
    const facet = facets[dimension];
    return !facet.exclude.includes(key) && (!facet.include.length || facet.include.includes(key));
  });
}
export function groupPaths(rows: ActivityRow[], order: Dimension[]) {
  const groups = new Map<string, { key: string; label: string; path: string[]; rows: ActivityRow[]; records: number }>();
  for (const row of rows) {
    const values = order.map(dimension => { const value = dimensionValue(row, dimension); return dimension === "unit" && order.includes("job") ? { ...value, label: `Unit ${row.unit}` } : value; });
    const key = JSON.stringify(values.map(value => value.key));
    const path = values.map(value => value.label);
    const group = groups.get(key) ?? { key, label: path.join(" › ") || "Total", path, rows: [], records: 0 };
    group.rows.push(row); group.records++; groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
}
