import { workAttribution, workAttributions } from "./workAttribution";
import { UnitFactCoverage } from "./UnitFactCoverage";
import { WeeklyUnitRatesReport } from "./WeeklyUnitRatesReport";
import { useCharts } from "./chartContext";
import { FloatingCharts, ChartSlot } from "./FloatingCharts";
import { UnitLaborReview } from "./UnitLaborReview";
import { readOpeningContexts } from "./openingReviewContext";
import { enrichActivityRows } from "./reportingFacts";
import { ClockedLabor } from "./ClockedLaborPanel";
import { ActivityOverview } from "./ActivityOverview";
import { historicalRows, readHistoricalLabor, reconcileHistorical } from "./historicalLabor";
import { GeneralLaborChart } from "./GeneralLaborChart";
import { midnight, workDate } from "./generalLabor";
import { UnitReportControls } from "./UnitReportControls";
import { allUnitFilters, unitMatches } from "./unitReporting";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { listWorkSessions, listWorkUnits } from "../../lib/customWork/api";
import { listProfiles } from "../../lib/install/api";

import { ActivityAccordion } from "./ActivityAccordion";
import { ReportingMultiSelect as MultiSelect } from "./ReportingMultiSelect";
import { reportDimensions, groupingDimensions, allReportFilters, facetColors, presetRange, denverToday, type ReportDimension, type RangePreset } from "./reportControls";
import { DimensionControls } from "./DimensionControls";
import { dimensionLabels, dimensionValue, groupPaths } from "./dataDimensions";
import { laborMetricContext, metricLabels, metricUnits, formatMetric, type LaborMetric } from "./laborMetrics";
import { VisitDistribution } from "./VisitDistribution";
import { activityRows, groupActivities, unitLabor } from "./activityRows";
import { reportOwner, reportProjects, reportQueryPolicy } from "./reportQueries";

const minutes = (seconds: number) => seconds > 0 && seconds < 0.6 ? "<0.01" : (seconds / 60).toFixed(2);
const percentage = (seconds: number, total: number) => total <= 0 ? "0%" : seconds / total * 100 < 0.1 ? "<0.1%" : `${(seconds / total * 100).toFixed(1)}%`;
const palette = ["#ff743d", "#55b9d2", "#b29aed", "#e5bb55", "#79c39b", "#e887aa"];
export function ActivityExplorer({ active = true }: { active?: boolean }) {
  return <FloatingCharts active={active}><ActivityWorkspace active={active} /></FloatingCharts>;
}
function ActivityWorkspace({ active }: { active: boolean }) {
  const charts = useCharts();
  const owner = reportOwner();
  const [filters, setFilters] = useState(allReportFilters);
  const [pageJobs, setPageJobs] = useState<string[] | null>(null);
  const [unitFilters, setUnitFilters] = useState(allUnitFilters);
  const [laborSource, setLaborSource] = useState("combined");
  const [breakdown, setBreakdown] = useState<"daily" | "weekly">("weekly");
  const [rangePreset, setRangePreset] = useState<RangePreset>("month");
  const [dimensionOrder, setDimensionOrder] = useState<ReportDimension[]>([...groupingDimensions]);
  const [enabledGroups, setEnabledGroups] = useState<ReportDimension[]>([]);
  const groupingOrder = [...dimensionOrder.filter(dimension => groupingDimensions.includes(dimension)), ...groupingDimensions.filter(dimension => !dimensionOrder.includes(dimension))];
  const activeGroups = groupingOrder.filter(dimension => enabledGroups.includes(dimension));
  const group = activeGroups.length === 1 ? activeGroups[0] : activeGroups.length ? "hierarchy" : "none";
  const [metric, setMetric] = useState<LaborMetric>("hours");
  const [selection, setSelection] = useState<{ floor: string; activity: string | null; unitId?: string; recordIds?: string[]; general?: boolean; interval?: [number, number]; records?: ReturnType<typeof activityRows>["rows"] } | null>(null);
  const tableRef = useRef<HTMLElement>(null);
  const evidenceRef = useRef<HTMLDetailsElement>(null);
  const inspectRecords = () => { charts?.close(); if (evidenceRef.current) evidenceRef.current.open = true; requestAnimationFrame(() => tableRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })); };
  const [initialRange] = useState(() => presetRange("month", denverToday()));
  const [from, setFrom] = useState(initialRange.from); const [until, setUntil] = useState(initialRange.until);

  // Owner-only discovery: the existing paginated reader checks completeness.
  const projects = useQuery(reportProjects(owner, active));
  const selectedJobIds = (projects.data ?? []).map(project => project.id).filter(id => pageJobs === null || pageJobs.includes(id)).sort();
  const selectionBoundary = JSON.stringify([pageJobs, filters, unitFilters, from, until, laborSource]);
  const clearChartScopes = charts?.clear;
  useEffect(() => { clearChartScopes?.(); /* Row selections belong to this filter window. */
    // The provider callback changes with its selection; only the boundary resets it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionBoundary]);
  const rangeFrom = from ? midnight(from) : -Infinity;
  const rangeUntil = until ? midnight(new Date(Date.parse(`${until}T12:00:00Z`) + 86400000).toISOString().slice(0, 10)) : Infinity;
  const scoped = active && !!projects.data && rangeFrom < rangeUntil && selectedJobIds.length > 0;
  const sessions = useQuery({ ...reportQueryPolicy, queryKey: ["dataReview", owner, "workSessions", selectedJobIds, from, until], queryFn: ({ signal }) => listWorkSessions(undefined, undefined, { projectIds: selectedJobIds, from: rangeFrom, until: rangeUntil, signal }), enabled: scoped && laborSource !== "historical" });
  const historical = useQuery({ ...reportQueryPolicy, queryKey: ["dataReview", owner, "historical", selectedJobIds.join(","), from, until], queryFn: ({ signal }) => readHistoricalLabor(selectedJobIds, rangeFrom, rangeUntil, signal), enabled: scoped && laborSource !== "custom", placeholderData: undefined });
  const people = useQuery({ ...reportQueryPolicy, queryKey: ["dataReview", owner, "people"], queryFn: listProfiles, enabled: scoped });
  const candidates = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of sessions.data ?? []) if (s.project_id && s.ended_at) counts.set(s.project_id, (counts.get(s.project_id) ?? 0) + 1);
    for (const session of historical.data ?? []) if (session.opening?.project_id) counts.set(session.opening.project_id, (counts.get(session.opening.project_id) ?? 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1]);
  }, [sessions.data, historical.data]);
  const jobNames = new Map((projects.data ?? []).map(p => [p.id, p.job_code || p.name]));

  const unitJobs = candidates.map(([id]) => id).filter(id => selectedJobIds.includes(id)).sort();
  const units = useQuery({ ...reportQueryPolicy, queryKey: ["dataReview", owner, "units", unitJobs], queryFn: ({ signal }) => listWorkUnits(undefined, signal, unitJobs), enabled: scoped && unitJobs.length > 0 });
  const allUnits = units.data ?? [];
  const timedUnitIds = new Set((sessions.data ?? []).map(session => session.unit_id));
  const openingIds = [...new Set([...allUnits.filter(unit => timedUnitIds.has(unit.id)).map(unit => unit.opening_id), ...(historical.data ?? []).map(session => session.opening_id)].filter((id): id is string => !!id))].sort();
  const openingContext = useQuery({ ...reportQueryPolicy, queryKey: ["dataReview", owner, "openingReview", openingIds.join(","), "taxonomy-v3-drawing-review"], queryFn: ({ signal }) => readOpeningContexts(openingIds, signal), enabled: scoped && !!openingIds.length });
  const enrich = (records: ReturnType<typeof activityRows>["rows"]) => enrichActivityRows(records, allUnits, openingContext.data ?? new Map());
  const unitsById = new Map(allUnits.map(unit => [unit.id, unit]));
  const personNames = useMemo(() => new Map((people.data ?? []).map(p => [p.id, p.display_name])), [people.data]);
  const datesValid = !(from && until && from > until);
  const source = activityRows((sessions.data ?? []).filter(s => !!s.project_id), allUnits, personNames,
    from ? midnight(from) : -Infinity,
    until ? midnight(new Date(Date.parse(`${until}T12:00:00Z`) + 86400000).toISOString().slice(0, 10)) : Infinity);
  const customBaseRows = activityRows((sessions.data ?? []).filter(s => !!s.project_id), allUnits, personNames).rows.map(r => ({ ...r, job: jobNames.get(r.jobId ?? "") ?? r.job }));
  const oldRows = historicalRows(historical.data ?? [], allUnits, personNames, rangeFrom, rangeUntil);
  const reconciliation = reconcileHistorical(source.rows, oldRows);
  const baseRows = enrich(laborSource === "custom" ? customBaseRows : [...customBaseRows, ...oldRows]);
  const reportRows = enrich(laborSource === "custom" ? source.rows : laborSource === "historical" ? oldRows : reconciliation.rows);
  const pageRows = reportRows.map(r => ({ ...r, job: jobNames.get(r.jobId ?? "") ?? r.job })).filter(row => pageJobs === null || pageJobs.includes(row.jobId ?? ""));
  const filteredRows = reportRows.map(r => ({ ...r, job: jobNames.get(r.jobId ?? "") ?? r.job })).filter(row => reportDimensions.every(dimension => {
    const selected = filters[dimension];
    return selected === null || selected.includes(dimensionValue(row, dimension).key);
  })).filter(row => unitMatches(row, unitsById, unitFilters));
  const scopeIds = new Set(charts?.scopes.flatMap(scope => scope.ids) ?? []);
  const rows = charts?.scopes.length ? filteredRows.filter(row => scopeIds.has(row.id)) : filteredRows;
  const selectedJobs = [...new Set(rows.map(r => r.jobId))];
  const jobOptions = [...new Map([...(projects.data ?? []).map(project => [project.id, { key: project.id, label: project.job_code || project.name }] as const), ...candidates.filter(([id]) => !jobNames.has(id)).map(([id]) => [id, { key: id, label: id }] as const)]).values()].sort((a, b) => a.label.localeCompare(b.label));
  const context = laborMetricContext(rows, allUnits, metric);
  const measured = context.measure(rows);
  const valueText = (value: number | null) => `${formatMetric(value, metric)} ${metricUnits[metric]}`;
  const pathGroups = groupPaths(rows, activeGroups);
  const members = (key: string, grouping: string = group) => grouping === "activity-mix" ? rows.filter(r => `${workAttribution(r)} · ${r.activity}` === key) : pathGroups.find(g => g.key === key)?.rows ?? [];
  const groups = pathGroups.map(g => ({ ...g, ...context.measure(g.rows) }));
  const inspectGroup = (key: string, activity: string | null) => {
    const matching = members(key).filter(r => !activity || `${workAttribution(r)} · ${r.activity}` === activity);
    if (group === "floor") setSelection({ floor: matching[0]?.floor ?? "Unknown", activity });
    else { setSelection({ floor: "", activity: null, recordIds: matching.map(r => r.id) }); inspectRecords(); }
  };
  const maxGroup = Math.max(...groups.map(g => g.value ?? 0), .000001);
  const activities = [...new Set(rows.map(r => `${workAttribution(r)} · ${r.activity}`))].sort();
  const stacked = groups.map(g => ({ ...g, segments: activities.map((label, index) => {
    const parentRows = members(g.key);
    const matching = parentRows.filter(r => `${workAttribution(r)} · ${r.activity}` === label);
    return { label, color: palette[index % palette.length], ...context.measure(matching, parentRows) };
  }).filter(x => x.value !== null && x.seconds > 0) }));
  const selectedRows = selection ? (selection.records ?? (selection.general ? pageRows : rows)).filter(r => selection.recordIds ? selection.recordIds.includes(r.id) : (selection.unitId ? r.scope === "Specific" && r.unitId === selection.unitId : r.floor === selection.floor) && (!selection.activity || `${workAttribution(r)} · ${r.activity}` === selection.activity)) : filteredRows;
  const inspectedRows = selection?.interval ? selectedRows.map(row => ({ ...row, seconds: Math.max(0, Math.min(Date.parse(row.ended), selection.interval![1]) - Math.max(Date.parse(row.started), selection.interval![0])) / 1000 })) : selectedRows;
  const selectedSeconds = selectedRows.reduce((n, r) => n + r.seconds, 0);
  const unitsChart = unitLabor(rows).map(unit => ({ ...unit, ...context.measure(rows.filter(r => r.scope === "Specific" && r.unitId === unit.key)) })).sort((a, b) => (b.value ?? -1) - (a.value ?? -1));
  const maxUnit = Math.max(...unitsChart.map(unit => unit.value ?? 0), .000001);
  const scopeGroups = workAttributions.map(label => groups.find(g => g.label === label) ?? { key: label, label, records: 0, ...context.measure([]) });
  const laborMix = groupActivities(rows, "activity").map(activity => ({ ...activity, ...context.measure(members(activity.key, "activity-mix"), rows) })).sort((a, b) => (b.value ?? -1) - (a.value ?? -1));
  const selectedMetric = context.measure(selectedRows, selection?.unitId ? rows.filter(r => r.unitId === selection.unitId && r.scope === "Specific") : selection && !selection.recordIds ? rows.filter(r => r.floor === selection.floor) : selectedRows);
  const pageControls = <>
    <div className="report-top-controls">
      <MultiSelect label="Jobs" options={jobOptions} value={pageJobs} onChange={job => { setPageJobs(job); setFilters(old => ({ ...old, job: null })); setSelection(null); }} color={facetColors.job} />

    </div>
    <label className="report-range">Date range<select value={rangePreset} onChange={event => { const preset = event.target.value as RangePreset; setRangePreset(preset); setBreakdown("weekly"); if (preset !== "custom") { const range = presetRange(preset, denverToday()); setFrom(range.from); setUntil(range.until); } setSelection(null); }}><option value="thisWeek">This week</option><option value="lastWeek">Last week</option><option value="thisMonth">This month</option><option value="lastMonth">Last month</option><option value="all">All time</option><option value="week">Last 7 days</option><option value="month">Past month</option><option value="quarter">3 months</option><option value="year">Year</option><option value="custom">Custom</option></select></label>
    {rangePreset === "custom" && <div className="report-custom-dates"><label>From<input type="date" value={from} onChange={event => { setFrom(event.target.value); setSelection(null); }} /></label><label>Through<input type="date" value={until} onChange={event => { setUntil(event.target.value); setSelection(null); }} /></label></div>}
    {rangePreset !== "all" && <p className="activity-unit-note">{from || "First record"} – {until || "Latest record"} · inclusive local dates</p>}


  </>;
  const error = openingContext.error || (laborSource !== "custom" && historical.error) || (laborSource !== "historical" && sessions.error) || projects.error || people.error || units.error;
  if (error) return <div>{pageControls}<ClockedLabor breakdown={breakdown} onBreakdown={setBreakdown} jobNames={jobNames} active={active} jobs={pageJobs} from={rangeFrom} until={rangeUntil} activityRecords={<p role="alert">Activity evidence could not be loaded. Clocked hours remain separate. {String(error)}</p>} /></div>;
  if ((scoped && openingIds.length > 0 && openingContext.isPending) || (laborSource !== "custom" && scoped && historical.isPending) || (laborSource !== "historical" && scoped && sessions.isPending) || projects.isPending || (scoped && people.isPending) || (scoped && unitJobs.length > 0 && units.isPending)) return <div>{pageControls}<ClockedLabor breakdown={breakdown} onBreakdown={setBreakdown} jobNames={jobNames} active={active} jobs={pageJobs} from={rangeFrom} until={rangeUntil} activityRecords={<p role="status">Tracing recorded activities…</p>} /></div>;
  const groupingControls = <DimensionControls jobOptions={jobOptions.filter(option => selectedJobIds.includes(option.key))} rows={baseRows} order={groupingOrder} enabled={enabledGroups} filters={filters}
          onFilters={next => { setFilters(next); setSelection(null); }}
          onOrder={order => { setDimensionOrder(order); setSelection(null); }}
          onEnabled={enabled => { setEnabledGroups(enabled); setSelection(null); }} />;
  const recordInspector = <>
    <UnitReportControls rows={pageRows} units={allUnits.filter(unit => pageJobs === null || pageJobs.includes(unit.project_id ?? ""))} filters={unitFilters} onChange={next => { setUnitFilters(next); setSelection(null); }} />
    <section ref={tableRef} className="activity-inspection report-records-workspace" aria-label="Activity table">
      <header className="report-records-header">
        {groupingControls}
      </header>
      {selection?.recordIds && <div className="activity-detail-heading"><span role="status">{selection.records ? "Relative chart selection" : "Duration selection"} · {selectedRows.length} records{selection.records && selection.interval ? ` · ${workDate(selection.interval[0])} – ${workDate(selection.interval[1] - 1)} · page dates do not apply` : ""}</span><button type="button" onClick={() => setSelection(null)}>Clear selection</button></div>}
      <div id="activity-record-table">
        <ActivityAccordion units={allUnits} showJobs={selectedJobIds.length > 1} key={activeGroups.join("/")} rows={inspectedRows} order={activeGroups} metric={selection?.general ? "hours" : metric} context={laborMetricContext(inspectedRows, allUnits, selection?.general ? "hours" : metric)} />
      </div>
    </section>
  </>;
  return <div className="activity-explorer">
    {pageControls}
    {!datesValid ? <p role="alert">Start date must not be after the end date.</p> : <>
      <ClockedLabor breakdown={breakdown} onBreakdown={setBreakdown} jobNames={jobNames} active={active} jobs={pageJobs} from={rangeFrom} until={rangeUntil} activityRecords={null} />
    <details ref={evidenceRef} className="activity-partial-evidence"><summary>Unit & activity timers · partial evidence</summary>
    <p role="note" className="activity-unit-note">These timers are incomplete and may reflect app testing, retrospective crew logging, or time outside a matching job shift. They are not a complete allocation of clocked hours or a productivity benchmark. Opening/spec links establish unit facts, not capture quality.</p>
    {recordInspector}
    <UnitFactCoverage rows={pageRows} />
    <label className="report-source">Activity source<select value={laborSource} onChange={event => { setLaborSource(event.target.value); setSelection(null); }}><option value="combined">Custom + historical</option><option value="custom">Custom timers</option><option value="historical">Historical installation</option></select></label>
    {laborSource !== "custom" && <details className="activity-quality"><summary>Historical evidence · {oldRows.length} visits{laborSource === "combined" ? ` · ${reconciliation.held.length} held for overlap review` : ""}</summary><p>Install / Helper are original historical roles, not detailed activity stages. Combined preview retains custom timers and holds out entire historical visits overlapping a custom timer for the same person. This is a conservative comparison, not a certified labor total. Overlap within one source is not reconciled.</p>{!!reconciliation.held.length && <ul>{reconciliation.held.map(row => <li key={row.id}>{jobNames.get(row.jobId ?? "")} · Unit {row.unit} · {row.person} · {minutes(row.seconds)} min held out. Inspect through Historical installation.</li>)}</ul>}<p>Historical openings without linked custom facts remain Unknown for floor/material/area. Other reported aggregates and service/task timers are not included yet.</p></details>}
      <ChartSlot view="mix"><ActivityOverview rows={rows} from={rangeFrom} until={rangeUntil} onInspect={(ids, interval) => { setSelection({ floor: "", activity: null, recordIds: ids, general: true, interval }); inspectRecords(); }} /></ChartSlot>
      <ChartSlot view="weeklyUnitRates"><WeeklyUnitRatesReport jobLabels={jobNames} jobs={pageJobs} source={laborSource} filter={row => (!charts?.scopes.length || scopeIds.has(row.id)) && reportDimensions.every(dimension => dimension === "scope" || filters[dimension] === null || filters[dimension]!.includes(dimensionValue(row, dimension).key)) && unitMatches(row, unitsById, unitFilters)} rows={rows} units={allUnits} people={people.data} from={rangeFrom} until={rangeUntil} onInspect={(ids, interval, records) => { setSelection({ floor: "", activity: null, recordIds: ids, general: true, interval, records }); inspectRecords(); }} /></ChartSlot>
      <ChartSlot view="units"><UnitLaborReview contexts={openingContext.data} rows={rows} units={allUnits} onInspect={ids => { setSelection({ floor: "", activity: null, recordIds: ids, general: true }); inspectRecords(); }} /></ChartSlot>
      <ChartSlot view="activityTime"><GeneralLaborChart scope="all" title="Job labor history" jobStatuses={new Map((projects.data ?? []).map(project => [project.id, project.status]))} rows={rows} from={rangeFrom} until={rangeUntil} onInspect={(ids, interval) => { setSelection({ floor: "", activity: null, recordIds: ids, general: true, interval }); inspectRecords(); }} /></ChartSlot>
      <ChartSlot view="general"><GeneralLaborChart jobStatuses={new Map((projects.data ?? []).map(project => [project.id, project.status]))} rows={rows} from={from ? midnight(from) : -Infinity} until={until ? midnight(new Date(Date.parse(`${until}T12:00:00Z`) + 86400000).toISOString().slice(0, 10)) : Infinity} onInspect={(ids, interval) => { setSelection({ floor: "", activity: null, recordIds: ids, general: true, interval }); inspectRecords(); }} /></ChartSlot>
      <ChartSlot view="compare"><div className="report-chart-grouping">{groupingControls}</div><div className="activity-other-comparisons">
      <label className="activity-metric">Metric<select value={metric} onChange={event => { setMetric(event.target.value as LaborMetric); setSelection(null); }}>{(Object.keys(metricLabels) as LaborMetric[]).map(value => <option key={value} value={value}>{metricLabels[value]}</option>)}</select></label>


      <p className="activity-total"><strong>{formatMetric(measured.value, metric)} <small>{metric === "hours" ? "person-hours" : metricUnits[metric]}</small></strong><span>{rows.length} records</span></p>
      {!!candidates.length && !rows.length && <p>No records match these jobs, dates and filters.</p>}
      {!candidates.length && <p>No closed custom or historical installation activities are available for this selection.</p>}
      <details className="activity-quality"><summary>Data notes · {rows.filter(r => r.seconds < 60).length} short records · {rows.filter(r => r.scope === "Specific" && r.floor === "Unknown").length} missing floors</summary>
        {selectedJobs.length > 1 && <p>With Floor alone, matching floor labels are combined across jobs. Job selection is controlled above; floor totals combine matching labels across selected jobs. Charts show recorded visits, not proven complete installation labor.</p>}
        <p>Short means under one minute. Floors use current custom facts or a known opening-signature story, including for earlier sessions. Unknown or conflicting floors remain unknown. Unit-linked work has a usable opening link; it does not prove complete labor capture. Job-level work has no unit target. Missing attribution means a missing or conflicting job/opening link. Clocked hours are not allocated to units.</p>
        <p>Reported time from closed activity timers, one person per record. Open, invalid and voided records are excluded ({source.excluded}). This is not an approved labor total or complete installation history. Date filters clip intervals at local midnight.</p>
      </details>
      {metric !== "hours" && <div className="activity-metric-coverage" role="status">
        <strong>{measured.value === null ? "Rate unavailable" : `${measured.openings} openings${metric === "area" ? ` · ${measured.area.toFixed(2)} ft²` : ""}`}</strong>
        <p>{context.unlinkedRecords} specific records lack an opening link · {context.generalRecords} general records excluded · {minutes(context.excludedSeconds)} recorded minutes excluded.</p>
        {metric === "area" && <p>{context.missingDimensions} linked openings have missing, invalid or conflicting dimensions ({context.dimensionConflicts} conflicts). Area uses linked job specs or custom dimensions; unverified values remain descriptive. Confirmed specs are not field verification; disagreements are excluded.</p>}
        <details><summary>Calculation basis</summary><p>Each bar uses recorded unit labor divided by distinct linked openings{metric === "area" ? "’ resolved rectangular area (width × height / 144), counted once per opening" : ", counted once regardless of visits or people"}. Activity segments share their parent bar’s denominator. Labor mix shares the full selection’s denominator. Missing values show —, not zero. Job-level work is not allocated to openings. These rates do not establish complete job labor.</p></details>
      </div>}
      <details className="activity-quality"><summary>Inspect timing quality · minutes per visit</summary><VisitDistribution rows={rows} onInspect={ids => { setSelection({ floor: "", activity: null, recordIds: ids }); inspectRecords(); }} /></details>
      <section className="activity-mix" aria-label="Labor mix">
        <h2>Labor mix</h2>
        <div className="activity-mix-bars">{laborMix.map(activity => <div className="activity-mix-row" key={activity.key}>
          <div className="activity-mix-label"><span>{activity.label}</span><strong>{valueText(activity.value)} <small>{activity.value !== null && `· ${percentage(activity.seconds, measured.seconds)}`}</small></strong></div>
          <div className="activity-mix-track" role="img" aria-label={`${activity.label}: ${valueText(activity.value)}${activity.value !== null ? `, ${percentage(activity.seconds, measured.seconds)} of eligible labor` : ", unavailable"}`}><i style={{ width: `${measured.value && activity.value !== null ? activity.value / measured.value * 100 : 0}%`, backgroundColor: palette[activities.indexOf(activity.label) % palette.length] }} /></div>
        </div>)}</div>
        {!laborMix.length && <p>No activities match these filters.</p>}
      </section>
      <h2 className="activity-comparison-title">{activeGroups.length ? activeGroups.map(dimension => dimensionLabels[dimension]).join(" → ") : "Totals"}</h2>
      {group === "none" && <div className="activity-scope-comparison"><article><h3>Units with recorded work</h3><strong>{unitsChart.length}</strong></article><article><h3>People represented</h3><strong>{new Set(rows.map(r => r.personId)).size}</strong></article></div>}
      {group === "scope" && <div className="activity-scope-comparison">{scopeGroups.map(g => <article key={g.key}><h3>{g.label}</h3><strong>{formatMetric(g.value, metric)} <small>{metricUnits[metric]}</small></strong><p>{g.value === null ? "Unavailable" : percentage(g.seconds, measured.seconds)} · {g.records} records</p><div className="activity-mix-track"><i style={{ width: `${measured.value && g.value !== null ? g.value / measured.value * 100 : 0}%`, backgroundColor: g.key === "Unit-linked work" ? palette[1] : g.key === "Job-level work" ? palette[0] : palette[2] }} /></div></article>)}</div>}
      <div className="activity-bars" aria-label={`${metricLabels[metric]} by ${group}`} hidden={group === "scope" || group === "none"}>
        {stacked.map(g => <div className="activity-bar" key={g.key}>{(group === "floor" || group === "hierarchy") ? <button type="button" className="activity-floor-label" aria-label={`Inspect activities for ${g.label}`} onClick={() => inspectGroup(g.key, null)}>{g.label}</button> : <span>{g.label}</span>}<div className="activity-track">
          {(group === "floor" || group === "hierarchy") ? g.segments.map(segment => <button type="button" className="activity-segment" key={segment.label} aria-pressed={!selection?.unitId && selection?.floor === g.label && selection.activity === segment.label} aria-label={`${g.label}, ${segment.label}: ${valueText(segment.value)}; inspect records`} title={`${segment.label}: ${valueText(segment.value)}`} onClick={() => { if (group === "floor" && !selection?.unitId && selection?.floor === g.label && selection.activity === segment.label) setSelection(null); else inspectGroup(g.key, segment.label); }} style={{ width: `${(segment.value ?? 0) / maxGroup * 100}%`, backgroundColor: segment.color }} />) : <i style={{ width: `${(g.value ?? 0) / maxGroup * 100}%` }} />}
        </div><strong>{valueText(g.value)}</strong></div>)}
        {!groups.length && <p>No activities match these filters.</p>}
      </div>
      {(group === "floor" || group === "hierarchy") && <div className="activity-legend">{activities.map((label, index) => <span key={label}><i style={{ background: palette[index % palette.length] }} />{label}</span>)}</div>}
      {selection && !selection.unitId && !selection.recordIds && group === "floor" && <section className="activity-segment-detail" aria-label="Selected floor activity">
        <div className="activity-detail-heading"><strong>{selection.floor}{selection.activity && ` · ${selection.activity}`}</strong><button type="button" onClick={() => setSelection(null)}>Clear</button></div>
        <p role="status"><strong>{minutes(selectedSeconds)} min</strong>{metric !== "hours" && <span> · {valueText(selectedMetric.value)}</span>} · {selectedRows.length} {selectedRows.length === 1 ? "record" : "records"}</p>
        {!selection.activity && <div className="activity-detail-options">{stacked.find(g => g.label === selection.floor)?.segments.map(segment => <button type="button" key={segment.label} onClick={() => setSelection({ floor: selection.floor, activity: segment.label })}>{segment.label}<span>{minutes(segment.seconds)} min · {rows.filter(r => r.floor === selection.floor && `${workAttribution(r)} · ${r.activity}` === segment.label).length} records</span></button>)}</div>}
        <button type="button" className="activity-inspect-records" onClick={inspectRecords}>Inspect {selectedRows.length} {selectedRows.length === 1 ? "record" : "records"} ↓</button>
      </section>}
      <section className="activity-units" aria-label="Unit labor">
        <div className="activity-unit-heading"><h2>Units</h2><span>{unitsChart.length} with recorded work</span></div>
        <p className="activity-unit-note">{metricLabels[metric]} · general work excluded</p>
        <div className="activity-legend activity-unit-legend">{activities.filter(label => label.startsWith("Unit-linked work · ")).map(label => <span key={label}><i style={{ background: palette[activities.indexOf(label) % palette.length] }} />{label.slice("Unit-linked work · ".length)}</span>)}</div>
        <div className="activity-unit-bars">{unitsChart.map(unit => {
          const record = rows.find(r => r.scope === "Specific" && r.unitId === unit.key)!;
          const duplicateLabel = unitsChart.some(other => other.key !== unit.key && rows.find(r => r.unitId === other.key)?.unit === record.unit);
          const label = `${selectedJobs.length > 1 ? `${record.job} · ` : ""}Unit ${record.unit}${duplicateLabel ? ` · ${unit.key.slice(0, 8)}` : ""}`;
          const segments = activities.map((activity, index) => {
            const matching = rows.filter(r => r.unitId === unit.key && r.scope === "Specific" && `${workAttribution(r)} · ${r.activity}` === activity);
            return { activity, color: palette[index % palette.length], records: matching.length, ...context.measure(matching, rows.filter(r => r.unitId === unit.key && r.scope === "Specific")) };
          }).filter(segment => segment.value !== null && segment.seconds > 0);
          const isSelected = selection?.unitId === unit.key;
          return <div className="activity-unit-row" key={unit.key}>
            <div className="activity-mix-label"><button type="button" className="activity-unit-label" aria-label={`Inspect activities for ${label}`} onClick={() => setSelection({ unitId: unit.key, floor: record.floor, activity: null })}>{label} <small>· {record.floor}</small></button><strong>{valueText(unit.value)}</strong></div>
            {record.unitFacts && <small className={record.unitFacts.dimensionConflict ? "unit-fact-warning" : "unit-fact-source"}>{[record.category, record.subtype, record.material, record.unitFacts.dimensionConflict ? "Dimensions conflict · excluded from area rate" : record.area == null ? "Area unknown" : `${record.area.toFixed(2)} ft² · ${record.unitFacts.dimensionsStatus}`].filter(Boolean).join(" · ")}</small>}
            <div className="activity-track activity-unit-track" aria-label={`${label} activities`}>
              {segments.map(segment => <button type="button" className="activity-segment" key={segment.activity} aria-pressed={isSelected && selection.activity === segment.activity} aria-label={`${label}, ${segment.activity}: ${valueText(segment.value)}; inspect records`} title={`${segment.activity}: ${valueText(segment.value)}`} onClick={() => setSelection(old => old?.unitId === unit.key && old.activity === segment.activity ? null : { unitId: unit.key, floor: record.floor, activity: segment.activity })} style={{ width: `${(segment.value ?? 0) / maxUnit * 100}%`, backgroundColor: segment.color }} />)}
            </div>
            <small>{unit.records} {unit.records === 1 ? "record" : "records"}</small>
            {isSelected && <section className="activity-segment-detail activity-unit-detail" aria-label="Selected unit activity">
              <div className="activity-detail-heading"><strong>{label}{selection.activity && ` · ${selection.activity.replace("Unit-linked work · ", "")}`}</strong><button type="button" onClick={() => setSelection(null)}>Clear</button></div>
              <p role="status"><strong>{minutes(selectedSeconds)} min</strong>{metric !== "hours" && <span> · {valueText(selectedMetric.value)}</span>} · {selectedRows.length} {selectedRows.length === 1 ? "record" : "records"}</p>
              {!selection.activity && <div className="activity-detail-options">{segments.map(segment => <button type="button" key={segment.activity} onClick={() => setSelection({ unitId: unit.key, floor: record.floor, activity: segment.activity })}>{segment.activity.replace("Unit-linked work · ", "")}<span>{minutes(segment.seconds)} min · {segment.records} {segment.records === 1 ? "record" : "records"}</span></button>)}</div>}
              <button type="button" className="activity-inspect-records" onClick={inspectRecords}>Inspect {selectedRows.length} {selectedRows.length === 1 ? "record" : "records"} ↓</button>
            </section>}
          </div>;
        })}</div>
        {!unitsChart.length && <p className="activity-unit-note">No unit-linked activity matches these filters.</p>}
      </section>
      </div></ChartSlot>

    </details>
    </>}
  </div>;
}


