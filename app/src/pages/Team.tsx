import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { listProfiles } from "../lib/install/api";
import { listInstalledForQc } from "../lib/ops";
import { listShiftsToApprove } from "../lib/timeclock";
import {
  isForemanPlus,
  isOwner,
  isSupervisorPlus,
  ROLE_LABELS,
  type CrewRole,
} from "../lib/install/types";
import { useEffectiveRole } from "../lib/useEffectiveRole";

interface TeamLink {
  to: string;
  label: string;
  desc: string;
  boss?: boolean;
  /** Supervisor-or-above only (adding and removing logins). */
  admin?: boolean;
}

// People hub tiles, mirroring the Warehouse "Inventory hub" layout: a stat
// strip up top, then a grid of tiles into each People area.
const LINKS: TeamLink[] = [
  { to: "/crew", label: "Roster", desc: "Crew, skill levels, roles & PINs" },
  {
    to: "/access",
    label: "Crew access",
    desc: "Add someone & text them a login",
    admin: true,
  },
  { to: "/qc", label: "Quality sign-off", desc: "Pass installs or log callbacks" },
  { to: "/clock", label: "Timecards", desc: "Approve submitted shifts" },
  { to: "/analytics", label: "Bids & analytics", desc: "Leaderboard + job estimate variance" },
  { to: "/costing", label: "Job costing", desc: "Margin, costs, change orders", boss: true },
];

export function Team() {
  const { effectiveRole } = useEffectiveRole();
  const lead = isForemanPlus(effectiveRole);
  const boss = isOwner(effectiveRole);

  const crew = useQuery({ queryKey: ["profiles"], queryFn: listProfiles });
  const shifts = useQuery({
    queryKey: ["shiftsToApprove"],
    queryFn: listShiftsToApprove,
    enabled: lead,
  });
  const qc = useQuery({
    queryKey: ["qcInstalled"],
    queryFn: listInstalledForQc,
    enabled: lead,
  });

  const pendingQc = (qc.data ?? []).filter((r) => !r.qc || r.qc.status !== "passed").length;
  const activeCrew = (crew.data ?? []).filter((p) => p.active).length;
  const shiftsToApprove = shifts.data?.length ?? 0;

  const links = LINKS.filter(
    (l) => (!l.boss || boss) && (!l.admin || isSupervisorPlus(effectiveRole)),
  );

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="home-greeting">People</p>
          <h1>People hub</h1>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            {effectiveRole ? ROLE_LABELS[effectiveRole as CrewRole] ?? effectiveRole : ""} view
          </p>
        </div>
      </header>

      {lead && (
        <div className="stat-grid">
          <div className="stat-card">
            <span className="stat-num">{activeCrew}</span>
            <span>active crew</span>
          </div>
          <Link to="/clock" className={shiftsToApprove > 0 ? "stat-card warn" : "stat-card"}>
            <span className="stat-num">{shiftsToApprove}</span>
            <span>timecards to approve</span>
          </Link>
          <Link to="/qc" className={pendingQc > 0 ? "stat-card warn" : "stat-card"}>
            <span className="stat-num">{pendingQc}</span>
            <span>installs to QC</span>
          </Link>
        </div>
      )}

      <h2>Manage</h2>
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
