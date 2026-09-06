// Warehouse history (owner ask 2026-09-06): the jobs whose material story
// is closed. Hidden from the warehouse page, kept here — every package,
// window and ledger line is still there to read, and a foreman can reopen
// a job from its own page if something comes back.
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { BackChip } from "../../components/BackChip";
import { EmptyState } from "../../components/ui/States";
import { listProjectsAnyStatus } from "../../lib/api";
import { listActivePackages } from "../../lib/storage";
import { scopeHref } from "../../lib/warehouse/materialsScope";
import { historyRows } from "../../lib/warehouse/sendToSite";

export function WarehouseHistory() {
  const projects = useQuery({ queryKey: ["projectsAll"], queryFn: listProjectsAnyStatus });
  const packages = useQuery({ queryKey: ["storagePackages"], queryFn: listActivePackages });
  const rows = historyRows(projects.data ?? [], packages.data ?? []);
  const ready = projects.isSuccess && packages.isSuccess;

  return (
    <div className="page">
      <BackChip />
      <header className="page-header">
        <div>
          <p className="home-greeting">Warehouse</p>
          <h1>History</h1>
        </div>
      </header>
      <p className="muted">
        Jobs whose unit movement was finalized. Off the warehouse page, kept here to read; a foreman can reopen one.
      </p>
      {!ready ? (
        <p className="muted">Loading…</p>
      ) : rows.length === 0 ? (
        <EmptyState
          title="No finalized jobs yet"
          message="When a job's material has all gone out, a foreman taps Unit Movement Finalized on its page and it lands here."
        />
      ) : (
        <ul className="history-list" aria-label="Finalized jobs">
          {rows.map((r) => (
            <li key={r.projectId} className="detail-card wh-card history-row">
              <div className="wh-row">
                <div className="wh-row-main">
                  <span className="wh-row-title">
                    {r.jobCode}
                    {r.name && r.name !== r.jobCode ? <span className="muted"> · {r.name}</span> : null}
                  </span>
                  <span className="wh-row-sub">
                    Finalized {r.finalizedAt.slice(0, 10)} · {r.units} unit{r.units === 1 ? "" : "s"} · {r.onSite} piece{r.onSite === 1 ? "" : "s"} on the job site
                  </span>
                </div>
                <div className="wh-actions">
                  <Link className="button-like" to={scopeHref({ projectId: r.projectId, pendingName: null })}>
                    Materials
                  </Link>
                  <Link className="button-like" to={`/warehouse/send/${r.projectId}`}>
                    Open
                  </Link>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
