import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { getDashboardCounts, listProjects } from "../lib/api";
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
  const counts = useQuery({ queryKey: ["dashboard"], queryFn: getDashboardCounts });
  const projects = useQuery({ queryKey: ["projects"], queryFn: listProjects });

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
        <div className="stat-card">
          <span className="stat-num">{counts.data?.total ?? "-"}</span>
          <span>on hand</span>
        </div>
        <Link to="/scan" className="stat-card warn">
          <span className="stat-num">{counts.data?.inbound ?? "-"}</span>
          <span>need putaway</span>
        </Link>
        <div className="stat-card">
          <span className="stat-num">{counts.data?.staged ?? "-"}</span>
          <span>staged</span>
        </div>
        <div className="stat-card danger">
          <span className="stat-num">{counts.data?.damaged ?? "-"}</span>
          <span>damaged</span>
        </div>
      </div>

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
