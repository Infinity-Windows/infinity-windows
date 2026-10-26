import { ChartFormatToggle } from "./ChartTimeControls";
import type { LaborMetric } from "./laborMetrics";
import { toggleChartScope } from "./chartSelection";
import { Charts, useCharts, type ChartScope, type ChartView } from "./chartContext";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

const views = { clocked: "Labor over time", mix: "Activity mix · partial", general: "Job-level work · partial", units: "Unit comparisons · partial", compare: "Grouped comparisons · partial" };

export function FloatingCharts({ children, active = true }: { children: ReactNode; active?: boolean }) {
  const [laborSource, updateLaborSource] = useState<"clocked" | "timers">("clocked");
  const [laborMeasure, updateLaborMeasure] = useState<LaborMetric>("hours");
  const [laborFormat, setLaborFormat] = useState("hours");
  const [laborStart, setLaborStart] = useState<"clocked" | "unit">("clocked");
  const [laborAxis, setLaborAxis] = useState("calendar");
  const [laborWeeks, setLaborWeeks] = useState(8);
  const setLaborSource = (source: "clocked" | "timers") => { updateLaborSource(source); if (source === "clocked") updateLaborMeasure("hours"); };
  const setLaborMeasure = (measure: LaborMetric) => { if (laborSource === "timers" || measure === "hours") updateLaborMeasure(measure); };
  const [expanded, setExpanded] = useState(false);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<ChartView>("clocked");
  useEffect(() => { if (view === "weeklyUnitRates") { setView("clocked"); updateLaborSource("timers"); updateLaborMeasure("area"); } }, [view]);
  const [scopes, setScopes] = useState<ChartScope[]>([]);
  const [clockedJobs, setClockedJobs] = useState<string[]>([]);
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const close = () => { setOpen(false); opener.current?.focus({ preventScroll: true }); };
  useEffect(() => { if (!active) setOpen(false); }, [active]);
  const show = (next: ChartView, scope?: ChartScope) => {
    opener.current = document.activeElement as HTMLElement;
    if (scope) setScopes([scope]);
    if (next === "clocked") { updateLaborSource("clocked"); updateLaborMeasure("hours"); }
    if (next === "weeklyUnitRates") { updateLaborSource("timers"); updateLaborMeasure("area"); }
    setView(next === "weeklyUnitRates" ? "clocked" : next); setOpen(true);
  };
  return <Charts.Provider value={{ laborStart, setLaborStart, laborSource, setLaborSource, laborMeasure, setLaborMeasure, laborFormat, setLaborFormat, laborAxis, setLaborAxis, laborWeeks, setLaborWeeks, open: open && active, view, target, scopes, setScopes, clockedJobs, setClockedJobs, show, close, clear: () => setScopes([]),
    toggle: scope => setScopes(old => toggleChartScope(old, scope)) }}>
    {children}
    {!open && active && (scopes.length > 0 || clockedJobs.length > 0) && <div className="report-selection-bar" aria-label="Selected report rows">
      {clockedJobs.length > 0 && <button type="button" onClick={() => show("clocked")}>View charts · {clockedJobs.length} {clockedJobs.length === 1 ? "job" : "jobs"}</button>}
      {scopes.length > 0 && <button type="button" onClick={() => show("mix")}>View charts · {scopes.length} activity {scopes.length === 1 ? "row" : "rows"}</button>}
      <button type="button" onClick={() => { setScopes([]); setClockedJobs([]); }}>Deselect all</button>
    </div>}
    {open && active && <section role="dialog" aria-label="Report charts" aria-modal="false" className={`report-floating-charts${expanded ? " report-charts-expanded" : ""}`} onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); close(); } }}>
      <header><label>Chart<select aria-label="Chart view" value={view} onChange={event => setView(event.target.value as ChartView)}>{Object.entries(views).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><div className="report-chart-window-controls"><button type="button" aria-label={expanded ? "Restore chart size" : "Expand charts"} aria-pressed={expanded} onClick={() => setExpanded(old => !old)}>{expanded ? "↙" : "↗"}</button><button autoFocus type="button" aria-label="Close charts" onClick={close}>✕</button></div></header>
      {view === "clocked" && <><div className="labor-time-controls">
        <label>Source<select aria-label="Labor source" value={laborSource} onChange={event => setLaborSource(event.target.value as "clocked" | "timers")}><option value="clocked">Clocked shifts</option><option value="timers">Unit-linked timers · partial</option></select></label>
        <label>Measure<select aria-label="Labor measure" value={laborMeasure} onChange={event => setLaborMeasure(event.target.value as LaborMetric)}><option value="hours">Total time</option><option value="opening" disabled={laborSource === "clocked"}>Minutes / opening</option><option value="area" disabled={laborSource === "clocked"}>Minutes / ft²</option></select></label>
        {laborAxis === "relative" && <label>Align from<select aria-label="Relative start basis" value={laborStart} onChange={event => setLaborStart(event.target.value as "clocked" | "unit")}><option value="clocked">Project work start</option><option value="unit">Unit work start</option></select></label>}
        {laborMeasure === "hours" && <ChartFormatToggle value={laborFormat} onChange={setLaborFormat} />}
      </div><div className="report-chart-scopes">{laborSource === "clocked" ? "Clocked shifts · rates require unit-linked timers" : "Unit-linked timers · partial capture · not allocated clocked hours"}</div></>}
      {view === "clocked" && laborAxis === "relative" && <div className="report-chart-scopes">{laborStart === "unit" ? "Week 1 = first linked unit timer. Earlier clocked work is outside this window." : "Week 1 = first finished clocked shift. Unit capture may start later."}</div>}
      {view === "clocked" && laborSource === "timers" && scopes.length > 0 && <div className="report-chart-scopes"><span>{scopes.map(scope => scope.label).join(" + ")}</span><button type="button" onClick={() => setScopes([])}>Clear row selection</button><small>Selected activity records only</small></div>}
      {view !== "clocked" && (view !== "weeklyUnitRates" || scopes.length > 0) && <div className="report-chart-scopes">{scopes.length ? <><span>{scopes.map(scope => scope.label).join(" + ")}</span><button type="button" onClick={() => setScopes([])}>Clear row selection</button><small>Combined records · overlaps counted once</small></> : <span>All filtered activity records · partial evidence</span>}</div>}
      <div className="report-chart-content" ref={setTarget} />
    </section>}
  </Charts.Provider>;
}

export function ChartSlot({ view, children }: { view: ChartView; children: ReactNode }) {
  const charts = useCharts();
  // Standalone consumers retain their existing inline rendering.
  if (!charts) return <>{children}</>;
  const matches = charts.view === "clocked" && (view === "clocked" || view === "weeklyUnitRates") ? view === (charts.laborSource === "timers" ? "weeklyUnitRates" : "clocked") : charts.view === view;
  return charts.open && matches && charts.target ? createPortal(children, charts.target) : null;
}
