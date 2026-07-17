import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { getDashboardCounts } from "../lib/api";
import { getMyProfile } from "../lib/install/api";
import { isLeadLike } from "../lib/install/types";

interface WarehouseLink {
  to: string;
  label: string;
  desc: string;
  lead?: boolean;
}

const LINKS: WarehouseLink[] = [
  { to: "/search", label: "Locate", desc: "Find any unit by ID or type" },
  { to: "/scan", label: "Scan", desc: "QR a window or a slot" },
  { to: "/projects", label: "Jobs", desc: "Pick lists & load-out per job" },
  { to: "/count", label: "Cycle count", desc: "Count a slot, flag gaps" },
  { to: "/receive", label: "Receive", desc: "Log arriving units", lead: true },
  { to: "/labels", label: "Slot labels", desc: "Print rack/slot QR labels", lead: true },
  { to: "/catalog", label: "Catalog", desc: "Import window types", lead: true },
];

export function Warehouse() {
  const me = useQuery({ queryKey: ["myProfile"], queryFn: getMyProfile });
  const lead = isLeadLike(me.data?.role);
  const counts = useQuery({ queryKey: ["dashboard"], queryFn: getDashboardCounts });
  const links = LINKS.filter((l) => !l.lead || lead);

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="home-greeting">Warehouse</p>
          <h1>Inventory hub</h1>
        </div>
      </header>

      <div className="stat-grid">
        <Link to="/search" className="stat-card">
          <span className="stat-num">{counts.data?.total ?? "-"}</span>
          <span>on hand</span>
        </Link>
        <Link to="/scan" className="stat-card warn">
          <span className="stat-num">{counts.data?.inbound ?? "-"}</span>
          <span>need putaway</span>
        </Link>
        <Link to="/projects" className="stat-card">
          <span className="stat-num">{counts.data?.staged ?? "-"}</span>
          <span>staged</span>
        </Link>
        <Link to="/search?status=damaged" className="stat-card danger">
          <span className="stat-num">{counts.data?.damaged ?? "-"}</span>
          <span>damaged</span>
        </Link>
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
