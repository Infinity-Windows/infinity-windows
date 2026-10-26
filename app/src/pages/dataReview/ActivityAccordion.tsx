import { workAttribution } from "./workAttribution";
import type { WorkUnit } from "../../lib/customWork/model";
import { selectedRecordIds } from "./chartSelection";
import { isGroupRowControl } from "./groupRowInteraction";
import { Columns3 } from "lucide-react";
import { useCharts } from "./chartContext";
import { createContext, useContext, useId, useState, type CSSProperties } from "react";
import { TableSelection } from "./TableSelection";
import { UnitDetails } from "./UnitDetails";
import type { ActivityRow } from "./activityRows";
import { dimensionLabels, dimensionValue, type Dimension } from "./dataDimensions";
import { laborMetricContext, formatMetric, metricLabels, metricUnits, type LaborMetric } from "./laborMetrics";

type Context = ReturnType<typeof laborMetricContext>;
const AreaContext = createContext<Context | null>(null);
const hours = (seconds: number) => seconds > 0 && seconds < 36 ? "<0.01" : (seconds / 3600).toFixed(2);
const activityKey = (row: ActivityRow) => `${workAttribution(row)} · ${row.activity}`;
const mixPalette = ["#ff743d", "#55b9d2", "#b29aed", "#e5bb55", "#79c39b", "#e887aa"];
type ActivityColors = Map<string, string>;

function ActivityMix({ rows, total, colors }: { rows: ActivityRow[]; total: number; colors: ActivityColors }) {
  const id = useId();
  const anchor = `--activity-${id.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const mix = new Map<string, number>();
  for (const row of rows) mix.set(activityKey(row), (mix.get(activityKey(row)) ?? 0) + row.seconds);
  const segments = [...mix].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (total <= 0) return null;
  let start = 0;
  const stops = segments.map(([label, seconds]) => {
    const end = start + seconds / total * 100;
    const stop = `${colors.get(label)} ${start}% ${end}%`; start = end; return stop;
  });
  const description = segments.map(([label, seconds]) => `${label} · ${hours(seconds)} h · ${seconds / total * 100 < .1 ? "<0.1" : (seconds / total * 100).toFixed(1)}%`).join("; ");
  return <span className="accordion-pie-slot" style={{ "--activity-anchor": anchor } as CSSProperties}>
    <button type="button" className="accordion-activity-mix" popoverTarget={id} onClick={event => event.stopPropagation()} aria-label={`Show activity breakdown. Activity shares of this group's recorded hours: ${description}`} style={{ background: `conic-gradient(${stops.join(", ")})` }} />
    <span id={id} popover="auto" role="dialog" aria-label="Activity breakdown" className="accordion-mix-popover" onClick={event => event.stopPropagation()}>
      {segments.map(([label, seconds]) => <span className="accordion-mix-detail" key={label}><i aria-hidden="true" style={{ background: colors.get(label) }} /><span>{label.slice(label.indexOf(" · ") + 3)}</span><span>{hours(seconds)} h · {seconds / total * 100 < .1 ? "<0.1" : (seconds / total * 100).toFixed(1)}%</span></span>)}
    </span>
  </span>;
}

function RecordedAreaRate({ rows }: { rows: ActivityRow[] }) {
  const units = [...new Map(rows.filter(row => row.unitRecord).map(row => [row.unitRecord!.id, row.unitRecord!])).values()];
  const shared = useContext(AreaContext);
  const areaContext = shared ?? laborMetricContext(rows, units, "area");
  const measured = areaContext.measure(rows);
  const partial = measured.seconds < rows.reduce((total, row) => total + row.seconds, 0);
  if (rows.every(row => row.scope !== "Specific")) return null;
  return <small className="record-area-rate" title={measured.value === null ? "Missing, conflicting or unlinked opening area" : `${(measured.seconds / 60).toFixed(2)} recorded min ÷ ${measured.area.toFixed(2)} stored ft²${partial ? "; excludes records without usable area" : ""}. Partial activity capture; dimensions may be unverified. No outlier classification.`}>({measured.value === null ? "—" : formatMetric(measured.value, "area")} min/ft²{partial && measured.value !== null ? " · partial" : ""})</small>;
}

function RecordTable({ rows, grouped = [] }: { rows: ActivityRow[]; grouped?: Dimension[] }) {
  const charts = useCharts();
  const scopes = rows.map(row => ({ key: JSON.stringify([row.id]), label: `${row.unit ?? row.activity} · ${row.person ?? "Unknown"}`, ids: [row.id] }));
  const selectedIds = selectedRecordIds(charts?.scopes ?? []);
  const checkboxInset = grouped.length * 6;
  const checkboxStyle: CSSProperties = { width: 30 + checkboxInset, minWidth: 30 + checkboxInset, paddingLeft: 7 + checkboxInset, textAlign: "left" };
  const [opening, setOpening] = useState<ActivityRow | null>(null);
  const [moreColumns, setMoreColumns] = useState(false);
  const [sort, setSort] = useState<{ key: keyof ActivityRow; ascending: boolean }>({ key: "seconds", ascending: false });
  const columns: { key: keyof ActivityRow; label: string }[] = [
    { key: "unit", label: "Unit" }, { key: "activity", label: "Activity" }, { key: "person", label: "Person" }, { key: "seconds", label: "Hours" }, { key: "job", label: "Job" },
    ...(moreColumns ? [
      { key: "floor", label: "Floor" }, { key: "category", label: "Category" }, { key: "subtype", label: "Operation" }, { key: "configuration", label: "Configuration" }, { key: "system", label: "System" },
      { key: "material", label: "Material" }, { key: "area", label: "Area (ft²)" },
    ] as { key: keyof ActivityRow; label: string }[] : []),
  ];
  const visibleColumns = columns.filter(column => !grouped.includes(column.key as Dimension));
  const sorted = [...rows].sort((a, b) => {
    const left = a[sort.key] ?? "", right = b[sort.key] ?? "";
    return (typeof left === "number" && typeof right === "number" ? left - right : String(left).localeCompare(String(right), undefined, { numeric: true })) * (sort.ascending ? 1 : -1);
  });
  return <div className="activity-record-table"><div className="activity-table"><table><caption className="activity-sr-only">Individual activity records, recorded hours</caption>
    <thead><tr>{charts && <th className="report-check-cell" style={checkboxStyle}><span className="activity-sr-only">Selection</span></th>}{visibleColumns.map(column => <th key={column.key} scope="col" aria-sort={sort.key === column.key ? sort.ascending ? "ascending" : "descending" : "none"}><div className="activity-record-heading"><button type="button" onClick={() => setSort(old => ({ key: column.key, ascending: old.key === column.key ? !old.ascending : true }))}>{column.label} {sort.key === column.key ? sort.ascending ? "↑" : "↓" : "↕"}</button></div></th>)}<th key="columns-toggle" className="activity-column-action" scope="col"><button type="button" className="activity-table-columns" aria-label={moreColumns ? "Show fewer columns" : "Show more columns"} title={moreColumns ? "Show fewer columns" : "Show more columns"} aria-pressed={moreColumns} onClick={() => setMoreColumns(value => !value)}><Columns3 size={15} aria-hidden="true" /></button></th></tr></thead>
    <tbody>{sorted.map(row => <tr key={row.id} data-selected={selectedIds.has(row.id) || undefined}>{charts && <td className="report-check-cell" style={checkboxStyle}><TableSelection label={`Select record ${row.id}`} checked={selectedIds.has(row.id)} onChange={() => charts.toggle(scopes.find(scope => scope.ids[0] === row.id)!)} /></td>}{visibleColumns.map(column => <td key={column.key} className={column.key === "seconds" ? "activity-record-hours" : undefined}>{column.key === "seconds" ? <>{hours(row.seconds)}<RecordedAreaRate rows={[row]} /></> : column.key === "unit" && (row.unitRecord || row.openingId) ? <><button type="button" className="report-unit-link" onClick={() => setOpening(row)}>{row.unit}</button>{row.unitFacts?.warnings.length ? <small className="unit-fact-warning">{row.unitFacts.warnings.join(" · ")}</small> : null}</> : column.key === "material" ? row.scope === "General" ? "—" : row.material ?? "Unknown" : column.key === "area" ? row.scope === "General" ? "—" : row.unitFacts?.dimensionConflict ? "Conflict" : row.area == null ? "Unknown" : <span title={row.unitFacts?.dimensionSource ?? "Unverified dimensions"}>{row.area.toFixed(2)}<small className="unit-fact-source">{row.unitFacts?.dimensionsStatus}</small></span> : column.key === "category" || column.key === "subtype" || column.key === "configuration" || column.key === "system" ? row.scope === "General" ? "—" : row[column.key] || "Unknown" : String(row[column.key] ?? "")}</td>)}<td className="activity-column-action" aria-hidden="true" /></tr>)}</tbody>
  </table></div>{opening && <UnitDetails record={opening} unit={opening.unitRecord} facts={opening.unitFacts} opening={{ id: opening.openingId ?? "Unlinked", code: opening.openingCode ?? opening.unit, job: opening.job ?? opening.jobId ?? "Unknown" }} onClose={() => setOpening(null)} />}</div>;
}

type GroupProps = { parentLabel?: string; showJobs: boolean; rows: ActivityRow[]; order: Dimension[]; depth: number; metric: LaborMetric; context: Context; colors: ActivityColors };
function groupsFor(rows: ActivityRow[], dimension: Dimension) {
  const groups = new Map<string, { label: string; rows: ActivityRow[] }>();
  for (const row of rows) {
    const value = dimensionValue(row, dimension);
    const group = groups.get(value.key) ?? { label: `${dimensionLabels[dimension]} · ${value.label}`, rows: [] };
    group.rows.push(row); groups.set(value.key, group);
  }
  return [...groups].sort((a, b) => a[1].label.localeCompare(b[1].label, undefined, { numeric: true }));
}
const scopeFor = (rows: ActivityRow[], label: string) => ({ key: `${label}/${JSON.stringify(rows.map(row => row.id).sort())}`, label, ids: rows.map(row => row.id) });
function Branch(props: GroupProps) {
  return <>{groupsFor(props.rows, props.order[props.depth]).map(([key, group]) => <Group key={key} {...props} parentSeconds={props.rows.reduce((sum, row) => sum + row.seconds, 0)} label={group.label} rows={group.rows} />)}</>;
}
function Group({ label, rows, order, depth, metric, context, colors, showJobs, parentSeconds, parentLabel = "Filtered activity work" }: GroupProps & { label: string; parentSeconds: number }) {
  const charts = useCharts();
  const [open, setOpen] = useState(false);
  const scope = scopeFor(rows, label);
  const selectedIds = selectedRecordIds(charts?.scopes ?? []);
  const selected = rows.every(row => selectedIds.has(row.id));
  const mixed = !selected && rows.some(row => selectedIds.has(row.id));
  const activityGrouped = order.includes("activity");
  const isActivityRow = order[depth] === "activity";
  const showPeople = !order.includes("person");
  const seconds = rows.reduce((sum, row) => sum + row.seconds, 0);
  const share = parentSeconds > 0 ? seconds / parentSeconds * 100 : null;
  const shareText = share === null ? "—" : share > 0 && share < .1 ? "<0.1%" : `${share.toFixed(1)}%`;
  const people = new Set(rows.map(row => row.personId?.trim()).filter(Boolean)).size;
  const unattributed = rows.filter(row => !row.personId?.trim()).length;
  const jobs = [...new Map(rows.map(row => [row.jobId ?? "no-job", row.job ?? "Unknown job"])).values()];
  const subtotal = context.measure(rows);
  const displayLabel = label.slice(`${dimensionLabels[order[depth]]} · `.length);
  return <>
    <tr className="report-group-row" onClick={event => { if (!isGroupRowControl(event.target)) setOpen(value => !value); }} data-depth={depth} data-selected={selected || undefined} style={{ "--report-row-bg": `rgba(155,175,195,${Math.min(depth, 4) * .035})` } as CSSProperties}>
      {charts && <td className="report-check-cell"><span className="report-group-check" style={{ transform: `translateX(${depth * 10}px)` }}><TableSelection label={`Select ${label}`} checked={selected} mixed={mixed} onChange={() => charts.toggle(scope)} /></span></td>}
      <th scope="row" style={{ paddingLeft: `${6 + depth * 10}px` }}><button type="button" className="report-expand" aria-label={`${open ? "Collapse" : "Expand"} ${label}`} aria-expanded={open} onClick={() => setOpen(value => !value)}><span aria-hidden="true">{open ? "▾" : "▸"}</span>{displayLabel}</button></th>
      {showJobs && <td className="report-job-cell" title={jobs.join(", ")}>{jobs.length === 1 ? jobs[0] : `${jobs.length} jobs`}</td>}
      <td className="report-number">{rows.length}</td>
      <td className="report-mix-cell">{!activityGrouped ? <ActivityMix rows={rows} total={seconds} colors={colors} /> : isActivityRow ? <div className="report-activity-share" title={`${shareText} · ${hours(seconds)} of ${hours(parentSeconds)} recorded activity hours · ${parentLabel} · partial evidence`}>
        <span role="progressbar" aria-label={`${label} share of ${parentLabel} recorded activity hours`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={share ?? undefined} aria-valuetext={`${shareText} · ${hours(seconds)} of ${hours(parentSeconds)} recorded activity hours; partial evidence`}><i style={{ width: `${share ?? 0}%` }} /></span><span>{shareText}</span>
      </div> : <span className="report-muted">—</span>}</td>
      {showPeople && <td className="report-number accordion-people" aria-label={`${people} unique ${people === 1 ? "person" : "people"}${unattributed ? `; ${unattributed} records without a person` : ""}`}>{people}{unattributed ? "*" : ""}</td>}
      <td className="report-number accordion-recorded-hours">{hours(seconds)}<RecordedAreaRate rows={rows} />{metric === "opening" && <small>{formatMetric(subtotal.value, metric)} {metricUnits[metric]}</small>}</td>
    </tr>
    {open && (order[depth + 1] ? <Branch parentLabel={label} showJobs={showJobs} rows={rows} order={order} depth={depth + 1} metric={metric} context={context} colors={colors} /> : <tr className="report-leaf-row" style={{ "--report-row-bg": `rgba(155,175,195,${Math.min(depth + 1, 4) * .035})` } as CSSProperties}><td colSpan={(charts ? 4 : 3) + (showJobs ? 1 : 0) + 1 + Number(showPeople)}><RecordTable rows={rows} grouped={order} /></td></tr>)}
  </>;
}

export function ActivityAccordion({ units = [], rows, order, metric, context, showJobs = new Set(rows.map(row => row.jobId)).size > 1 }: { units?: WorkUnit[]; showJobs?: boolean; rows: ActivityRow[]; order: Dimension[]; metric: LaborMetric; context: Context }) {
  showJobs = showJobs && !order.includes("job");
  const charts = useCharts();
  const scopes = order.length ? groupsFor(rows, order[0]).map(([, group]) => scopeFor(group.rows, group.label)) : [];
  const selectedIds = selectedRecordIds(charts?.scopes ?? []);
  const all = rows.length > 0 && rows.every(row => selectedIds.has(row.id));
  const total = context.measure(rows);
  const colors = new Map([...new Set(rows.map(activityKey))].sort().map((key, index) => [key, mixPalette[index % mixPalette.length]]));
  return <AreaContext.Provider value={metric === "area" ? context : laborMetricContext(rows, units, "area")}><div className="activity-accordion" aria-label="Grouped activity records">
    <div className="activity-accordion-total"><span>Filtered total · {metricLabels[metric]}</span><strong>{formatMetric(total.value, metric)} {metricUnits[metric]}</strong></div>
    {!rows.length ? <p>No matching records.</p> : !order.length ? <RecordTable rows={rows} /> : <div className="activity-table report-standard-table"><table style={{ minWidth: 270 + (charts ? 38 : 0) + (showJobs ? 110 : 0) + (order.includes("activity") ? 120 : 50) + (!order.includes("person") ? 56 : 0) }}><caption className="activity-sr-only">Grouped activity records</caption><thead><tr>{charts && <th className="report-check-cell"><TableSelection label="Select all activity groups" checked={all} mixed={rows.some(row => selectedIds.has(row.id))} onChange={() => charts.setScopes(all ? [] : scopes)} /></th>}<th scope="col">Group</th>{showJobs && <th scope="col">Job</th>}<th scope="col" className="report-number">Records</th><th scope="col" title={order.includes("activity") ? "Share of the parent group’s recorded activity hours; partial evidence" : undefined}>{order.includes("activity") ? "Activity share" : "Activity"}</th>{!order.includes("person") && <th scope="col" className="report-number">People</th>}<th scope="col" className="report-number">Hours</th></tr></thead><tbody><Branch showJobs={showJobs} rows={rows} order={order} depth={0} metric={metric} context={context} colors={colors} /></tbody></table></div>}
  </div></AreaContext.Provider>;
}
