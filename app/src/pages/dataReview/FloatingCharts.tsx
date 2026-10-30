import { toggleChartScope } from "./chartSelection";
import { Charts, useCharts, type ChartScope, type ChartView } from "./chartContext";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

const views = { records: "Record scatter", clockCompare: "Clocked labor by job" };

export function FloatingCharts({ children, active = true }: { children: ReactNode; active?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<ChartView>("clockCompare");
  const [scopes, setScopes] = useState<ChartScope[]>([]);
  const [clockedJobs, setClockedJobs] = useState<string[]>([]);
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const close = () => { setOpen(false); opener.current?.focus({ preventScroll: true }); };
  useEffect(() => { if (!active) setOpen(false); }, [active]);
  const show = (next: ChartView, scope?: ChartScope) => {
    opener.current = document.activeElement as HTMLElement;
    if (scope) setScopes([scope]);
    setView(next); setOpen(true);
  };
  return <Charts.Provider value={{ open: open && active, view, target, scopes, setScopes, clockedJobs, setClockedJobs, show, close, clear: () => setScopes([]),
    toggle: scope => setScopes(old => toggleChartScope(old, scope)) }}>
    {children}
    {!open && active && (scopes.length > 0 || clockedJobs.length > 0) && <div className="report-selection-bar" aria-label="Selected report rows">
      {clockedJobs.length > 0 && <button type="button" onClick={() => show("clockCompare")}>View charts · {clockedJobs.length} {clockedJobs.length === 1 ? "job" : "jobs"}</button>}
      {scopes.length > 0 && <button type="button" onClick={() => show("records")}>View charts · {scopes.length} activity {scopes.length === 1 ? "row" : "rows"}</button>}
      <button type="button" onClick={() => { setScopes([]); setClockedJobs([]); }}>Deselect all</button>
    </div>}
    {open && active && <section role="dialog" aria-label="Report charts" aria-modal="false" className={`report-floating-charts${expanded ? " report-charts-expanded" : ""}`} onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); close(); } }}>
      <header><label>Chart<select aria-label="Chart view" value={view} onChange={event => { const next=event.target.value as ChartView; if(next==="clockCompare") { setScopes([]); } setView(next); }}>{Object.entries(views).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><div className="report-chart-window-controls"><button type="button" aria-label={expanded ? "Restore chart size" : "Expand charts"} aria-pressed={expanded} onClick={() => setExpanded(old => !old)}>{expanded ? "↙" : "↗"}</button><button autoFocus type="button" aria-label="Close charts" onClick={close}>✕</button></div></header>
      <div className="report-chart-content" ref={setTarget} />
    </section>}
  </Charts.Provider>;
}

export function ChartSlot({ view, children }: { view: ChartView; children: ReactNode }) {
  const charts = useCharts();
  // Standalone consumers retain their existing inline rendering.
  if (!charts) return <>{children}</>;
  const matches = charts.view === view;
  return charts.open && matches && charts.target ? createPortal(children, charts.target) : null;
}
