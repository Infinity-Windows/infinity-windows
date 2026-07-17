import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { getDashboardCounts } from "../lib/api";
import { getMyProfile } from "../lib/install/api";
import { isAdmin, isBigBoss, isLeadLike, ROLE_LABELS, type CrewRole } from "../lib/install/types";
import { supabase } from "../lib/supabase";

interface Tile {
  to: string;
  label: string;
  show: boolean;
}

export function Home() {
  const counts = useQuery({ queryKey: ["dashboard"], queryFn: getDashboardCounts });
  const me = useQuery({ queryKey: ["myProfile"], queryFn: getMyProfile });
  const role = me.data?.role;
  const lead = isLeadLike(role);
  const admin = isAdmin(role);
  const boss = isBigBoss(role);

  const groups: { title: string; tiles: Tile[] }[] = [
    {
      title: "Work",
      tiles: [
        { to: "/my-work", label: "My work", show: true },
        { to: "/clock", label: "Time clock", show: true },
        { to: "/projects", label: "Jobs", show: true },
        { to: "/scan", label: "Scan", show: true },
        { to: "/receive", label: "Receive", show: true },
        { to: "/search", label: "Find a unit", show: true },
        { to: "/locate", label: "Locate", show: true },
      ],
    },
    {
      title: "Learn & grow",
      tiles: [
        { to: "/learn", label: "Education", show: true },
        { to: "/training", label: "Training & clearance", show: true },
        { to: "/points", label: "My points", show: true },
        { to: "/safety", label: "Safety", show: true },
      ],
    },
    {
      title: "Run the crew",
      tiles: [
        { to: "/", label: "Warehouse", show: lead },
        { to: "/count", label: "Cycle count", show: lead },
        { to: "/labels", label: "Print labels", show: lead },
        { to: "/tools", label: "Tools", show: lead },
        { to: "/supplies", label: "Supplies", show: lead },
        { to: "/analytics", label: "Analytics", show: lead },
        { to: "/catalog", label: "Catalog import", show: lead },
        { to: "/crew", label: "Crew", show: lead },
        { to: "/admin", label: "Admin & approvals", show: admin },
        { to: "/costing", label: "Job costing", show: boss },
      ],
    },
  ];

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Infinity</h1>
          <p className="muted" style={{ margin: 0 }}>
            {me.data?.display_name ?? "Windows & Doors"}
            {role && role !== "installer" ? ` · ${ROLE_LABELS[role as CrewRole] ?? role}` : ""}
          </p>
        </div>
        <button className="link" onClick={() => supabase.auth.signOut()}>
          Sign out
        </button>
      </header>

      {lead && (
        <div className="stat-grid">
          <Link to="/search" className="stat-card">
            <span className="stat-num">{counts.data?.total ?? "-"}</span>
            <span>windows on hand</span>
          </Link>
          <Link to="/scan" className="stat-card warn">
            <span className="stat-num">{counts.data?.inbound ?? "-"}</span>
            <span>need putaway</span>
          </Link>
          <Link to="/projects" className="stat-card">
            <span className="stat-num">{counts.data?.staged ?? "-"}</span>
            <span>staged for jobs</span>
          </Link>
          <Link to="/search?status=damaged" className="stat-card danger">
            <span className="stat-num">{counts.data?.damaged ?? "-"}</span>
            <span>damaged / hold</span>
          </Link>
        </div>
      )}

      {groups.map((g) => {
        const tiles = g.tiles.filter((t) => t.show);
        if (tiles.length === 0) return null;
        return (
          <div key={g.title}>
            <h2>{g.title}</h2>
            <div className="tile-grid">
              {tiles.map((t) => (
                <Link key={t.label} to={t.to} className="tile">
                  {t.label}
                </Link>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
