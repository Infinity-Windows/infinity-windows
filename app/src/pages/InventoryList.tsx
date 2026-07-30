import { useQuery } from "@tanstack/react-query";
import { Link, Navigate, useParams } from "react-router-dom";
import { listInventory } from "../lib/api";
import { formatApiError } from "../lib/errors";
import {
  filterInventory,
  INVENTORY_VIEWS,
  inventoryCounts,
  parseInventoryView,
  sortInventory,
  unitsWithOpenDamage,
} from "../lib/inventoryViews";
import { listIssues } from "../lib/issues";
import { isForemanPlus } from "../lib/install/types";
import { STATUS_LABELS, type WindowUnit } from "../lib/types";
import { useEffectiveRole } from "../lib/useEffectiveRole";

/**
 * The list behind one of the Inventory hub's four numbers — "tap 11 on hand and
 * see the 11". Every view reads the same inventory snapshot the hub counts
 * from, filtered by the same definition, so the number on the card and the
 * number of rows here are the same fact told twice.
 */
export function InventoryList() {
  const { view: raw } = useParams();
  const { effectiveRole } = useEffectiveRole();
  const isLead = isForemanPlus(effectiveRole);
  const def = parseInventoryView(raw);

  const inventory = useQuery({ queryKey: ["inventory"], queryFn: listInventory });

  // Damage reports are a foreman+ surface, so only ask for them when the
  // viewer could open one anyway.
  const issues = useQuery({
    queryKey: ["issues"],
    queryFn: listIssues,
    enabled: isLead && def?.id === "damaged",
  });

  if (!def) return <Navigate to="/warehouse" replace />;

  const units = inventory.data?.units ?? [];
  const counts = inventoryCounts(units);
  const rows = sortInventory(filterInventory(units, def.id));
  const damaged = unitsWithOpenDamage(issues.data ?? []);

  return (
    <div className="page">
      <header className="page-header">
        <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
          <Link to="/warehouse" className="back-chip" aria-label="Back to the inventory hub">
            ‹
          </Link>
          <div style={{ minWidth: 0 }}>
            <p className="home-greeting">Inventory</p>
            <h1>
              {def.title}
              {inventory.isSuccess ? ` (${rows.length})` : ""}
            </h1>
          </div>
        </div>
      </header>

      {/* The same four cards as the hub, so you can cross to another list
          without going back first — and so every count stays on screen. */}
      <div className="stat-grid">
        {INVENTORY_VIEWS.map((v) => (
          <Link
            key={v.id}
            to={`/warehouse/${v.id}`}
            className={v.tone ? `stat-card ${v.tone}` : "stat-card"}
            aria-current={v.id === def.id ? "page" : undefined}
            style={v.id === def.id ? { borderColor: "var(--accent)" } : undefined}
          >
            <span className="stat-num">
              {inventory.isSuccess ? counts[v.id] : "-"}
            </span>
            <span>{v.label}</span>
          </Link>
        ))}
      </div>

      <p className="muted">{def.blurb}</p>

      {inventory.isLoading && <p className="muted">Loading…</p>}

      {inventory.isError && (
        <div className="detail-card" role="alert">
          <p className="error" style={{ marginTop: 0 }}>
            {formatApiError(inventory.error)}
          </p>
          <button className="action-btn" onClick={() => inventory.refetch()}>
            Try again
          </button>
        </div>
      )}

      {inventory.data?.truncated && (
        <p className="warn-text">
          Showing the first {units.length} of {inventory.data.serverTotal} windows
          — ask for this list to be split by job.
        </p>
      )}

      {inventory.isSuccess && rows.length === 0 && (
        <p className="muted">{def.empty}</p>
      )}

      <ul className="unit-list work-list">
        {rows.map((u) => (
          <li key={u.id} className="find-row">
            <span className="unit-badge" aria-hidden>
              {(u.window_types?.type_code ?? "?").slice(0, 3)}
            </span>
            <div style={{ minWidth: 0, flex: 1 }}>
              <Link to={`/w/${encodeURIComponent(u.window_id)}`}>
                <strong>{u.window_id}</strong>
              </Link>
              <div className="muted" style={{ fontSize: 12 }}>
                {u.window_types?.name ?? u.window_types?.type_code ?? "Unknown type"}
              </div>
              <div className="muted" style={{ fontSize: 12 }}>
                {u.projects ? `${u.projects.job_code} — ${u.projects.name}` : "No job yet"}
              </div>
            </div>
            <Whereabouts unit={u} />
            {def.id === "putaway" && (
              <Link
                to={`/w/${encodeURIComponent(u.window_id)}`}
                className="action-btn"
                style={{ width: "100%" }}
              >
                Put it away →
              </Link>
            )}
            {def.id === "damaged" && isLead && damaged.has(u.id) && u.project_id && (
              <Link
                to={`/projects/${u.project_id}?tab=exceptions`}
                className="action-btn"
                style={{ width: "100%" }}
              >
                See the damage report →
              </Link>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Where the window actually is. A slot address is the answer a warehouse person
 * came for, so anything else has to say plainly that there isn't one — a unit
 * with no slot is a unit somebody has to go and hunt for.
 */
function Whereabouts({ unit }: { unit: WindowUnit }) {
  const address = unit.locations?.address;

  // Inbound means nobody has put it away yet, even when it is sitting
  // somewhere known like the receiving dock — the dock is not storage.
  if (unit.status === "inbound") {
    return (
      <span className="warn-text">
        {address ? `Needs a slot — on ${address}` : "Needs a slot — nowhere yet"}
      </span>
    );
  }

  if (address) return <span className="big-address">{address}</span>;

  // Worse than inbound: the app believes this one is put away, and still
  // cannot say where it is.
  return (
    <span className="warn-text">
      {STATUS_LABELS[unit.status]} — no slot recorded
    </span>
  );
}
