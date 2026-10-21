import { useMemo, useState } from "react";
import type { UnitLabor } from "../../lib/workData/cohorts";
import type { EvidenceClaim, ShiftCoverage } from "../../lib/workData/reconcile";
import { facetValues, filterUnits, groupUnitMetrics, summarizeUnits, unitActivityRows, type Facet, type UnitFilters } from "../../lib/workData/exploration";
import { useT } from "../../lib/i18n";
import "../../lib/i18n/workDataCatalog";
import type { WorkDataKey } from "../../lib/i18n/workDataCatalog";

const hours = (seconds: number) => `${(seconds / 3600).toFixed(2)} h`;
const area = (value: number) => `${value.toFixed(2)} ft²`;
const facets: Facet[] = ["category", "subtype", "material", "floor"];

/** No fetches or durable state. The private report's sign-in/job boundary owns
 * this component and discards its supplied evidence on logout/offline/preview. */
export function WorkDataExplorer({ rows, claims, coverage, issue }: {
  rows: readonly UnitLabor[]; claims: readonly EvidenceClaim[]; coverage: readonly ShiftCoverage[];
  issue: (reason: string) => string;
}) {
  const t = useT();
  const [filters, setFilters] = useState<UnitFilters>({});
  const [min, setMin] = useState("");
  const [max, setMax] = useState("");
  const minArea = min.trim() ? Number(min) : null;
  const maxArea = max.trim() ? Number(max) : null;
  const valid = (minArea === null || (Number.isFinite(minArea) && minArea >= 0)) &&
    (maxArea === null || (Number.isFinite(maxArea) && maxArea >= 0)) &&
    (minArea === null || maxArea === null || maxArea >= minArea);
  const selected = useMemo(() => valid ? filterUnits(rows, { ...filters, minArea, maxArea }) : [],
    [rows, filters, minArea, maxArea, valid]);
  const summary = useMemo(() => summarizeUnits(selected), [selected]);
  const floors = useMemo(() => groupUnitMetrics(selected, "floor"), [selected]);
  const stages = useMemo(() => unitActivityRows(selected, claims, coverage), [selected, claims, coverage]);
  const subtypeRows = useMemo(() => filterUnits(rows, { category: filters.category }), [rows, filters.category]);
  const setFacet = (field: Facet, value: string) => {
    const chosen: string | null | undefined = value === "" ? undefined : JSON.parse(value);
    setFilters(old => ({ ...old, [field]: chosen, ...(field === "category" ? { subtype: undefined } : {}) }));
  };
  return <section className="work-data-explorer" aria-labelledby="work-data-unit-heading">
    <h2 id="work-data-unit-heading">{t("wdata.units")}</h2>
    <p>{t("wdata.unitHelp")}</p>
    <p className="muted">{t("wdata.mappingBasis")}</p>
    <p className="muted">{t("wdata.recordedFilters")}</p>
    <div className="work-data-unit-filters">
      {facets.map(field => <label key={field}>{t(`wdata.${field}` as WorkDataKey)}
        <select value={filters[field] === undefined ? "" : JSON.stringify(filters[field])} onChange={e => setFacet(field, e.target.value)}>
          <option value="">{t("wdata.allValues")}</option>
          {facetValues(field === "subtype" ? subtypeRows : rows, field).map(value =>
            <option key={JSON.stringify(value)} value={JSON.stringify(value)}>{value ?? t("wdata.unknown")}</option>)}
        </select>
      </label>)}
      <label>{t("wdata.minArea")}<input type="number" min="0" step="any" value={min} onChange={e => setMin(e.target.value)} /></label>
      <label>{t("wdata.maxArea")}<input type="number" min="0" step="any" value={max} onChange={e => setMax(e.target.value)} /></label>
      <label className="work-data-search">{t("wdata.filter")}<input type="search" value={filters.text ?? ""} onChange={e => setFilters(old => ({ ...old, text: e.target.value }))} /></label>
      <button type="button" onClick={() => { setFilters({}); setMin(""); setMax(""); }}>{t("wdata.resetFilters")}</button>
    </div>
    {!valid && <p role="alert">{t("wdata.invalidArea")}</p>}
    {valid && <>
      <div className="work-data-stats" aria-label={t("wdata.selectionTotals")}>
        <div><span>{t("wdata.selectedUnits")}</span><strong>{summary.count} / {rows.length}</strong></div>
        <div><span>{t("wdata.unitLabor")}</span><strong>{hours(summary.paidSeconds)}</strong></div>
        <div><span>{t("wdata.knownArea")}</span><strong>{area(summary.knownAreaSqFt)}</strong></div>
        <div><span>{t("wdata.trusted")}</span><strong>{summary.hoursPerSqFt === null ? t("wdata.noCohort") : summary.hoursPerSqFt.toFixed(3)}</strong>
          <small>{t("wdata.trustedBasis", { count: summary.eligibleCount, hours: hours(summary.trustedSeconds), area: area(summary.trustedAreaSqFt) })}</small></div>
        <div><span>{t("wdata.excluded")}</span><strong>{hours(summary.excludedSeconds)}</strong><small>{t("wdata.excludedUnits", { count: summary.excludedCount })}</small></div>
      </div>
      <p className="muted">{t("wdata.overheadSeparate")}</p>
      <details className="work-data-card"><summary>{t("wdata.exclusionReasons")}</summary>
        <p>{t("wdata.reasonsOverlap")}</p>
        {summary.reasons.length ? <ul>{summary.reasons.map(row => <li key={row.reason}>{issue(row.reason)} · {t("wdata.unitCount", { count: row.count })} · {hours(row.seconds)}</li>)}</ul> : <p>{t("wdata.noExclusions")}</p>}
      </details>
      <details className="work-data-card"><summary>{t("wdata.floors")}</summary>
        <p className="muted">{t("wdata.floorBasis")}</p>
        {floors.map(floor => <div className="work-data-floor" key={JSON.stringify(floor.value)}>
          <h3>{floor.value ?? t("wdata.unknown")}: {area(floor.knownAreaSqFt)}</h3>
          <dl className="work-data-metrics">
            <div><dt>{t("wdata.selectedUnits")}</dt><dd>{floor.count}</dd></div>
            <div><dt>{t("wdata.unitLabor")}</dt><dd>{hours(floor.paidSeconds)}</dd></div>
            <div><dt>{t("wdata.trusted")}</dt><dd>{floor.hoursPerSqFt === null ? t("wdata.noCohort") : floor.hoursPerSqFt.toFixed(3)}</dd></div>
            <div><dt>{t("wdata.excluded")}</dt><dd>{hours(floor.excludedSeconds)}</dd></div>
          </dl>
        </div>)}
      </details>
      {!selected.length && <p role="status">{t("wdata.noMatchingUnits")}</p>}
      {selected.map(row => <details key={row.unit.id} className="work-data-card work-data-unit">
        <summary>{row.unit.label} · {hours(row.paidSeconds)} · {row.areaSqFt === null ? "—" : area(row.areaSqFt)}</summary>
        <dl className="work-data-metrics">
          {facets.map(field => <div key={field}><dt>{t(`wdata.${field}` as WorkDataKey)}</dt><dd>{row.unit[field]?.trim() ? row.unit[field] : t("wdata.unknown")}</dd></div>)}
          <div><dt>{t("wdata.area")}</dt><dd>{row.areaSqFt === null ? "—" : area(row.areaSqFt)}</dd></div>
          <div><dt>{t("wdata.dimensionSource")}</dt><dd>{row.unit.dimensionSource?.trim() ? row.unit.dimensionSource : t("wdata.unknown")}</dd></div>
        </dl>
        <ul>{row.exclusions.map(reason => <li key={reason}>{issue(reason)}</li>)}</ul>
        {row.eligible && <p>{t("wdata.eligible")}</p>}
        <h3>{t("wdata.unitActivities")}</h3><p className="muted">{t("wdata.unitActivityBasis")}</p>
        {(stages.get(row.unit.id) ?? []).map(stage => <div className="work-data-stage" key={JSON.stringify([stage.activityId, stage.label])}>
          <p><strong>{stage.label}</strong><span>{hours(stage.seconds)}</span></p>
          <small>{t("wdata.sourceRecords")}</small><code>{stage.sourceIds.join(" · ")}</code>
        </div>)}
        {!stages.get(row.unit.id)?.length && <p>{t("wdata.noAttributedStages")}</p>}
        <small>{t("wdata.unitRecord")}</small><code>{row.unit.id}</code>
      </details>)}
    </>}
  </section>;
}
