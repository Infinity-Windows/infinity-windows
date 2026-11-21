import { workAttribution } from "./workAttribution";
import { reportingActivity } from "./activityLabels";
import type { ActivityRow } from "./activityRows";

export const dimensionLabels = { job: "Job", floor: "Floor", unit: "Unit", activity: "Activity", scope: "Work attribution", person: "Person", category: "Unit category", subtype: "Operation", configuration: "Configuration", system: "System", material: "Material" };
export type Dimension = keyof typeof dimensionLabels;
export function dimensionValue(row: ActivityRow, dimension: Dimension) {
  if (dimension === "activity") { const label = reportingActivity(row.activity); return { key: label, label }; }
  if (dimension === "scope") { const label = workAttribution(row); return { key: label, label }; }
  if (dimension === "category" || dimension === "subtype" || dimension === "configuration" || dimension === "system" || dimension === "material") {
    const value = row.scope === "General" ? "Not allocated" : row[dimension]?.trim() || "Unknown";
    return { key: value, label: value };
  }
  const key = dimension === "job" ? row.jobId ?? "no-job" : dimension === "unit" ? row.unitId ?? "no-unit" : dimension === "person" ? row.personId : row[dimension];
  const label = dimension === "job" ? row.job ?? key : dimension === "unit" ? `${row.job ?? row.jobId ?? ""} · Unit ${row.unit}` : dimension === "person" ? row.person : row[dimension];
  return { key, label };
}
