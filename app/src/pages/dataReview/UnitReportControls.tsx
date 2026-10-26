import type { ActivityRow } from "./activityRows";
import type { WorkUnit } from "../../lib/customWork/model";
import { ReportingMultiSelect as MultiSelect } from "./ReportingMultiSelect";
import { areaOptions, unitReporting, type UnitFilters } from "./unitReporting";

export function UnitReportControls({ units, filters, onChange, rows }: { rows?: ActivityRow[]; units: WorkUnit[]; filters: UnitFilters; onChange: (filters: UnitFilters) => void }) {
  const facts = rows ? rows.filter(row => row.scope === "Specific").map(row => row.unitFacts ?? unitReporting(units.find(unit => unit.id === row.unitId))) : units.map(unitReporting);
  const taxonomyOptions = (key: "category" | "subtype" | "configuration" | "system") => [...new Set((rows ?? []).filter(row => row.scope === "Specific").map(row => row[key] || "Unknown"))].map(label => ({ key: label.toLowerCase(), label }));
  const options = (facet: "floor" | "material") => [...new Map([
    ...facts.map(fact => [fact[facet], { key: fact[facet], label: facet === "floor" ? fact.floorLabel : fact.materialLabel }] as const),
    ["unknown", { key: "unknown", label: facet === "floor" ? "Unknown floor" : "Unknown material" }] as const,
  ]).values()].sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  return <details className="unit-report-controls"><summary>Unit filters{Object.values(filters).some(value => value !== null) ? " · filtered" : " · All"}</summary>
    <div className="unit-report-fields">
      <MultiSelect label="Unit floors" options={options("floor")} value={filters.floor} onChange={floor => onChange({ ...filters, floor })} color="#b29aed" />
      <MultiSelect label="Category" options={taxonomyOptions("category")} value={filters.category ?? null} onChange={category => onChange({ ...filters, category })} color="#55b9d2" />
      <MultiSelect label="Operation" options={taxonomyOptions("subtype")} value={filters.subtype ?? null} onChange={subtype => onChange({ ...filters, subtype })} color="#ff743d" />
      {(["configuration", "system"] as const).map(key => <MultiSelect key={key} label={key === "system" ? "System" : "Configuration"} options={taxonomyOptions(key)} value={filters[key] ?? null} onChange={value => onChange({ ...filters, [key]: value })} color="#8b949e" />)}
      <MultiSelect label="Material" options={options("material")} value={filters.material} onChange={material => onChange({ ...filters, material })} color="#79c39b" />
      <MultiSelect label="Unit area" options={areaOptions} value={filters.area} onChange={area => onChange({ ...filters, area })} color="#e5bb55" />
    </div>
    <p className="activity-unit-note">Unit-linked records and charts only; clocked hours and Job-level work stay at job scope. Opening signatures + current custom facts + job specs + explicit catalog links. Classification conflicts remain separate. Conflicting dimensions stay separate; confirmed specs are not field verification.</p>
    {Object.values(filters).some(value => value !== null) && <button type="button" onClick={() => onChange({ floor: null, material: null, area: null, category: null, subtype: null, configuration: null, system: null })}>Clear unit filters</button>}
  </details>;
}
