import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { getDashboardCounts, listProjects, searchUnits } from "../lib/api";
import { STATUS_LABELS } from "../lib/types";
import { getMyProfile } from "../lib/install/api";
import { isForemanPlus } from "../lib/install/types";

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
];

export function Warehouse() {
  const me = useQuery({ queryKey: ["myProfile"], queryFn: getMyProfile });
  const lead = isForemanPlus(me.data?.role);
  const counts = useQuery({ queryKey: ["dashboard"], queryFn: getDashboardCounts });
  const projects = useQuery({ queryKey: ["projects"], queryFn: listProjects });

  const [query, setQuery] = useState("");
  const results = useQuery({
    queryKey: ["search", query],
    queryFn: () => searchUnits(query),
    enabled: query.trim().length >= 2,
  });

  const links = LINKS.filter((l) => !l.lead || lead);

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="home-greeting">Warehouse</p>
          <h1>Inventory hub</h1>
        </div>
      </header>

      <div className="locate-search">
        <input
          placeholder="Locate: window ID or type code…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <Link to="/scan" className="locate-go" aria-label="Scan">
          ▣
        </Link>
      </div>

      {query.trim().length >= 2 && (
        <ul className="unit-list work-list" style={{ marginTop: 4 }}>
          {(results.data ?? []).slice(0, 8).map((u) => (
            <li key={u.id} className="find-row">
              <span className="unit-badge" aria-hidden>
                {(u.window_types?.type_code ?? "?").slice(0, 3)}
              </span>
              <div style={{ minWidth: 0, flex: 1 }}>
                <Link to={`/w/${encodeURIComponent(u.window_id)}`}>
                  <strong>{u.window_id}</strong>
                </Link>
                <div className="muted" style={{ fontSize: 12 }}>
                  {u.window_types?.name ?? u.window_types?.type_code}
                </div>
              </div>
              <span className="big-address">
                {u.locations?.address ?? STATUS_LABELS[u.status]}
              </span>
            </li>
          ))}
          {results.data?.length === 0 && <p className="muted">Nothing found.</p>}
        </ul>
      )}

      <div className="stat-grid">
        <Link to="/search" className="stat-card">
          <span className="stat-num">{counts.data?.total ?? "-"}</span>
          <span>on hand</span>
        </Link>
        <Link to="/scan" className="stat-card warn">
          <span className="stat-num">{counts.data?.inbound ?? "-"}</span>
          <span>need putaway</span>
        </Link>
        <div className="stat-card">
          <span className="stat-num">{counts.data?.staged ?? "-"}</span>
          <span>staged</span>
        </div>
        <Link to="/search" className="stat-card danger">
          <span className="stat-num">{counts.data?.damaged ?? "-"}</span>
          <span>damaged</span>
        </Link>
      </div>

      <h2>Jobs</h2>
      <div className="home-projects">
        {(projects.data ?? []).slice(0, 8).map((p) => (
          <Link key={p.id} to={`/projects/${p.id}`} className="project-card home-project">
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

      <h2>Tools</h2>
      <div className="warehouse-grid">
        {links.map((l) => (
          <Link key={l.to} to={l.to} className="warehouse-tile">
            <strong>{l.label}</strong>
            <span className="muted">{l.desc}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
