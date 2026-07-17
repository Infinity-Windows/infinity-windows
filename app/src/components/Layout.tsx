import { useQuery } from "@tanstack/react-query";
import { NavLink, Outlet } from "react-router-dom";
import { countMyOpenOpenings, getMyProfile } from "../lib/install/api";
import { isLeadLike } from "../lib/install/types";
import { useRealtimeMyOpenings } from "../lib/useRealtimeOpenings";
import { ToastHost } from "./ToastHost";

// Leads run the warehouse; installers get an install-first bar.
const leadTabs = [
  { to: "/", label: "Home", icon: "\u2302", badge: 0 },
  { to: "/scan", label: "Scan", icon: "\u25A3", badge: 0 },
  { to: "/projects", label: "Jobs", icon: "\u25A6", badge: 0 },
  { to: "/search", label: "Find", icon: "\u2315", badge: 0 },
  { to: "/crew", label: "Crew", icon: "\u2691", badge: 0 },
];

export function Layout() {
  const me = useQuery({ queryKey: ["myProfile"], queryFn: getMyProfile });
  const isLead = isLeadLike(me.data?.role);

  // Keep the badge count live across devices when a lead (re)assigns work.
  useRealtimeMyOpenings(!isLead ? me.data?.id : undefined);
  const openCount = useQuery({
    queryKey: ["myReadyCount", me.data?.id],
    queryFn: () => countMyOpenOpenings(me.data!.id),
    enabled: Boolean(me.data?.id) && !isLead,
  });

  const tabs = isLead
    ? leadTabs
    : [
        { to: "/my-work", label: "My work", icon: "\u2692", badge: openCount.data ?? 0 },
        { to: "/clock", label: "Clock", icon: "\u23F1", badge: 0 },
        { to: "/learn", label: "Learn", icon: "\u2605", badge: 0 },
        { to: "/points", label: "Points", icon: "\u2726", badge: 0 },
        { to: "/search", label: "Find", icon: "\u2315", badge: 0 },
      ];

  return (
    <div className="app-shell">
      <ToastHost />
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
