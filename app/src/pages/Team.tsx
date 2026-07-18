import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { listProfiles } from "../lib/install/api";
import { listInstalledForQc } from "../lib/ops";
import { listShiftsToApprove } from "../lib/timeclock";
import { isOwner, isForemanPlus, ROLE_LABELS, type CrewRole } from "../lib/install/types";
import { useEffectiveRole } from "../lib/useEffectiveRole";

interface TeamLink {
  to: string;
  label: string;
  desc: string;
  count?: number;
  boss?: boolean;
}

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

  const links: TeamLink[] = [
    { to: "/crew", label: "Roster", desc: "Crew, skill levels, roles & PINs", count: activeCrew },
    {
      to: "/clock",
      label: "Timecards",
      desc: "Approve submitted shifts",
      count: shifts.data?.length ?? 0,
    },
    {
      to: "/qc",
      label: "Quality sign-off",
      desc: "Pass installs or log callbacks",
      count: pendingQc,
    },
    { to: "/analytics", label: "Bids & analytics", desc: "Leaderboard + job estimate variance" },
    { to: "/costing", label: "Job costing", desc: "Margin, costs, change orders", boss: true },
  ];

  const visible = links.filter((l) => !l.boss || boss);

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="home-greeting">Team</p>
          <h1>Crew command</h1>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            {effectiveRole ? ROLE_LABELS[effectiveRole as CrewRole] ?? effectiveRole : ""} view
          </p>
        </div>
      </header>

      <div className="warehouse-grid">
        {visible.map((l) => (
          <Link key={l.to} to={l.to} className="warehouse-tile team-tile">
            <div className="team-tile-head">
              <strong>{l.label}</strong>
              {(l.count ?? 0) > 0 && <span className="team-count">{l.count}</span>}
            </div>
            <span className="muted">{l.desc}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
