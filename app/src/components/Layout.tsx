import { useQuery } from "@tanstack/react-query";
import { NavLink, Outlet } from "react-router-dom";
import { countMyOpenOpenings, getMyProfile } from "../lib/install/api";
import { useRealtimeMyOpenings } from "../lib/useRealtimeOpenings";

const baseTabs = [
  { to: "/", label: "Home", icon: "\u2302" },
  { to: "/scan", label: "Scan", icon: "\u25A3" },
  { to: "/receive", label: "Receive", icon: "\u2795" },
  { to: "/projects", label: "Jobs", icon: "\u25A6" },
  { to: "/search", label: "Find", icon: "\u2315" },
];

export function Layout() {
  const me = useQuery({ queryKey: ["myProfile"], queryFn: getMyProfile });
  const isLead = me.data?.role === "lead";

  // Keep the badge count live across devices when a lead (re)assigns work.
  useRealtimeMyOpenings(!isLead ? me.data?.id : undefined);
  const openCount = useQuery({
    queryKey: ["myReadyCount", me.data?.id],
    queryFn: () => countMyOpenOpenings(me.data!.id),
    enabled: Boolean(me.data?.id) && !isLead,
  });

  // Installers get a "My work" tab (their assigned list); leads get "Crew".
  const tabs = [
    ...baseTabs,
    isLead
      ? { to: "/crew", label: "Crew", icon: "\u2691", badge: 0 }
      : {
          to: "/my-work",
          label: "My work",
          icon: "\u2692",
          badge: openCount.data ?? 0,
        },
  ];

  return (
    <div className="app-shell">
      <main className="app-main">
        <Outlet />
      </main>
      <nav className="bottom-nav">
        {tabs.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            end={tab.to === "/"}
            className={({ isActive }) => (isActive ? "nav-tab active" : "nav-tab")}
          >
            <span className="nav-icon">
              {tab.icon}
              {"badge" in tab && (tab.badge ?? 0) > 0 && (
                <span className="nav-badge">{tab.badge}</span>
              )}
            </span>
            <span>{tab.label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
