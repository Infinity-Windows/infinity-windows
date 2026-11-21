import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useLanguage } from "../../lib/i18n";
import "./dataComparison.css";
import { ActivityExplorer } from "./ActivityExplorer";
import { useQueryClient } from "@tanstack/react-query";
import { reportOwner } from "./reportQueries";

const ExistingReport = lazy(() => import("../DataHub").then(m => ({ default: m.DataHub })));
const views = ["existing", "proposed"] as const;
type View = typeof views[number];

/** Report tabs keep their selection in this session. */
export function DataComparison() {
  const es = useLanguage().lang === "es";
  const [view, setView] = useState<View>("existing");
  const client = useQueryClient();
  const owner = reportOwner();
  const queryKey = ["dataReview", owner];
  useEffect(() => () => {
    const key = ["dataReview", owner];
    void client.cancelQueries({ queryKey: key });
    // Keep session snapshots when leaving this page; auth changes purge them.
  }, [client, owner]);
  const [visited, setVisited] = useState<Set<View>>(() => new Set(["existing"]));
  function choose(next: View) {
    if (next !== view) void client.cancelQueries({ queryKey });
    setVisited(old => new Set([...old, next]));
    setView(next);
  }
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const labels = es
    ? ["Rendimiento de obras", "Panel de trabajo"]
    : ["Job Performance", "Work Dashboard"];
  function move(index: number, key: string) {
    const next = key === "Home" ? 0 : key === "End" ? views.length - 1
      : key === "ArrowRight" ? (index + 1) % views.length
      : key === "ArrowLeft" ? (index + views.length - 1) % views.length : null;
    if (next === null) return false;
    choose(views[next]); buttons.current[next]?.focus(); return true;
  }
  return <div className="data-comparison">
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
        {id === "existing" && <Suspense fallback={<p role="status">{es ? "Cargando informe…" : "Loading report…"}</p>}><ExistingReport reporting active={view === id} /></Suspense>}
        {id === "proposed" && <ActivityExplorer active={view === id} />}
      </>}
    </section>)}
  </div>;
}
