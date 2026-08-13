import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { listInventory, listProjects } from "../lib/api";
import { formatApiError } from "../lib/errors";
import { INVENTORY_VIEWS, inventoryCounts } from "../lib/inventoryViews";
import { isForemanPlus } from "../lib/install/types";
import { useEffectiveRole } from "../lib/useEffectiveRole";
import { UnitSearch } from "../components/UnitSearch";

interface WarehouseLink {
  to: string;
  label: string;
  desc: string;
  lead?: boolean;
}

const LINKS: WarehouseLink[] = [
  { to: "/storage", label: "Storage", desc: "Conex & package tracking" },
  { to: "/scan", label: "Scan", desc: "QR a window or a slot" },
  { to: "/count", label: "Cycle count", desc: "Count a slot, flag gaps" },
  { to: "/receive", label: "Receive", desc: "Log arriving units", lead: true },
  { to: "/labels", label: "Slot labels", desc: "Print rack/slot QR labels", lead: true },
  { to: "/catalog", label: "Catalog", desc: "Import window types", lead: true },
  { to: "/supplies", label: "Supplies", desc: "Track consumables & reorder", lead: true },
];

export function Warehouse() {
  const { effectiveRole } = useEffectiveRole();
  const lead = isForemanPlus(effectiveRole);
  const inventory = useQuery({ queryKey: ["inventory"], queryFn: listInventory });
  const projects = useQuery({ queryKey: ["projects"], queryFn: listProjects });
  const counts = inventoryCounts(inventory.data?.units ?? []);

  const links = LINKS.filter((l) => !l.lead || lead);

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="home-greeting">Warehouse</p>
          <h1>Inventory hub</h1>
        </div>
      </header>

      <h2>Locate</h2>
      <UnitSearch limit={8} />

      <div className="stat-grid">
        {INVENTORY_VIEWS.map((v) => (
          <Link
            key={v.id}
            to={`/warehouse/${v.id}`}
            className={v.tone ? `stat-card ${v.tone}` : "stat-card"}
          >
            <span className="stat-num">
              {inventory.isSuccess ? counts[v.id] : "-"}
            </span>
            <span>{v.label}</span>
          </Link>
        ))}
      </div>
      {inventory.isError && (
        <p className="error">{formatApiError(inventory.error)}</p>
      )}

      <h2>Operations</h2>
      <div className="warehouse-grid">
        {links.map((l) => (
          <Link key={l.to} to={l.to} className="warehouse-tile">
            <strong>{l.label}</strong>
            <span className="muted">{l.desc}</span>
          </Link>
        ))}
      </div>

      <h2>By job</h2>
      <div className="home-projects">
        {(projects.data ?? []).slice(0, 8).map((p) => (
          <Link
            key={p.id}
            to={`/projects/${p.id}?tab=warehouse`}
            className="project-card home-project"
          >
            <div className="home-project-head">
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 15 }}>{p.name || p.job_code}</div>
                <div className="muted" style={{ fontSize: 12 }}>
                  {p.job_code}
                  {p.address ? ` · ${p.address}` : ""}
                </div>
              </div>
              <span className="muted">›</span>
            </div>
          </Link>
        ))}
        {projects.data?.length === 0 && <p className="muted">No active jobs.</p>}
      </div>
    </div>
  );
}
