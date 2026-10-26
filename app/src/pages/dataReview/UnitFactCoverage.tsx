import { unitFactCoverage } from "./unitFactCoverageData";
import type { ActivityRow } from "./activityRows";

export function UnitFactCoverage({ rows }: { rows: ActivityRow[] }) {
  const coverage = unitFactCoverage(rows);
  return <details className="activity-quality"><summary>Unit fact coverage · {coverage.units} recorded units</summary><p className="activity-unit-note">Selected jobs and dates, before table filters. Unique opening/unit identities with activity records, not the entire job inventory. Before = former signature/custom-material sources; recovered = newly mapped without a conflicting source. Drawing reviewed counts may overlap source conflicts. Document and text-derived classifications are not field verification.</p><div className="activity-table"><table aria-label="Unit classification coverage"><thead><tr><th>Field</th><th>Before</th><th>Now known</th><th>Recovered</th><th>Drawing reviewed</th><th>Source conflicts</th><th>Unknown</th></tr></thead><tbody>{coverage.fields.map(field => <tr key={field.field}><th>{field.field}</th><td>{field.before}</td><td>{field.known}</td><td>{field.recovered}</td><td>{field.reviewed}</td><td>{field.conflict}</td><td>{field.unknown}</td></tr>)}</tbody></table></div></details>;
}
