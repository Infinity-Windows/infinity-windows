import { lazy, Suspense, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useLanguage } from "../../lib/i18n";
import reference from "./data-designer-reference.html?raw";
import "./dataComparison.css";
import { ActivityExplorer } from "./ActivityExplorer";

const ExistingReport = lazy(() => import("../DataHub").then(m => ({ default: m.DataHub })));
const views = ["existing", "proposed", "pilot", "evidence"] as const;
type View = typeof views[number];

/** Mounted only after WorkData's real-owner and non-preview checks.
 * Review selection is ephemeral: it never changes profile/company settings. */
export function DataComparison({ evidence }: { evidence: ReactNode }) {
  const es = useLanguage().lang === "es";
  const [view, setView] = useState<View>("existing");
  const [visited, setVisited] = useState<Set<View>>(() => new Set(["existing"]));
  function choose(next: View) {
    setVisited(old => new Set([...old, next]));
    setView(next);
  }
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const labels = es
    ? ["Informe existente", "Propuesta", "Piloto · ejemplo", "Evidencia"]
    : ["Existing report", "Proposed", "Pilot · sample", "Evidence"];
  function move(index: number, key: string) {
    const next = key === "Home" ? 0 : key === "End" ? views.length - 1
      : key === "ArrowRight" ? (index + 1) % views.length
      : key === "ArrowLeft" ? (index + views.length - 1) % views.length : null;
    if (next === null) return false;
    choose(views[next]); buttons.current[next]?.focus(); return true;
  }
  return <div className="data-comparison">
    <header className="data-review-heading">
      <div><p className="data-review-eyebrow">{es ? "REVISIÓN DE PROPIETARIOS" : "OWNER DESIGN REVIEW"}</p>
        <h1>{es ? "Comparar Data" : "Compare Data"}</h1>
        <p>{es ? "Solo cambia tu vista. No activa un diseño para el equipo." : "Only changes your view. Nothing is activated for the team."}</p>
        <p>{es ? "Cada informe conserva sus propios filtros al cambiar de pestaña." : "Each report keeps its own filters as you switch tabs."}</p>
      </div>
      <Link to="/summary">Summary →</Link>
    </header>
    <div className="data-review-tabs" role="tablist" aria-label={es ? "Vistas de Data" : "Data comparison views"}>
      {views.map((id, i) => <button key={id} ref={el => { buttons.current[i] = el; }}
        type="button" role="tab" id={`data-tab-${id}`} aria-controls={`data-panel-${id}`}
        aria-selected={view === id} tabIndex={view === id ? 0 : -1}
        onClick={() => choose(id)} onKeyDown={e => { if (move(i, e.key)) e.preventDefault(); }}>
        {labels[i]}
      </button>)}
    </div>
    {views.map(id => <section key={id} id={`data-panel-${id}`} role="tabpanel" aria-labelledby={`data-tab-${id}`} hidden={view !== id} tabIndex={0}>
      {visited.has(id) && <>
        <p className="data-review-basis">{id === "existing"
          ? (es ? "Informe de DataHub en esta versión de synthesis; no es una conexión al sitio de producción. Sus filtros y cálculos originales se conservan." : "DataHub report from this synthesis checkout—not a connection to the production website. Its original filters and calculations are preserved.")
          : id === "pilot"
          ? (es ? "Referencia del handoff de octubre 10. Datos inventados; no consulta ni modifica Forge. Los filtros del ejemplo no se aplican a datos reales." : "October 10 handoff reference. Fabricated sample data; cannot read or write Forge. Sample filters do not apply to real records.")
          : id === "evidence"
          ? (es ? "Informe actual de conciliación: evidencia real autorizada. No es el diseño propuesto de análisis de actividades." : "Current reconciliation report: authorized live evidence. This is not the proposed activity-analysis dashboard.")
          : (es ? "Propuesta de diseño, aún sin gráficos conectados. No hay totales de ejemplo presentados como datos reales." : "Experimental activity explorer using authorized recorded work. Chart and table share one selection; this is not payroll reconciliation.")}</p>
        {id === "existing" && <Suspense fallback={<p role="status">{es ? "Cargando informe…" : "Loading report…"}</p>}><ExistingReport /></Suspense>}
        {id === "evidence" && evidence}
        {id === "pilot" && <iframe className="data-review-pilot" title="Data Designer pilot — fabricated sample data"
          sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={reference} />}
        {id === "proposed" && <ActivityExplorer />}
      </>}
    </section>)}
  </div>;
}
