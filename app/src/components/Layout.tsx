import { useQuery } from "@tanstack/react-query";
import { NavLink, Outlet } from "react-router-dom";
import { countMyOpenOpenings, getMyProfile } from "../lib/install/api";
import { isLeadLike } from "../lib/install/types";
import { useRealtimeMyOpenings } from "../lib/useRealtimeOpenings";
import { ToastHost } from "./ToastHost";

// Leads run the warehouse; installers get an install-first bar.
const leadTabs = [
  { to: "/", label: "Home", icon: "⌂", badge: 0 },
  { to: "/scan", label: "Scan", icon: "▣", badge: 0 },
  { to: "/projects", label: "Jobs", icon: "▦", badge: 0 },
  { to: "/search", label: "Find", icon: "⌕", badge: 0 },
  { to: "/crew", label: "Crew", icon: "⚑", badge: 0 },
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
        { to: "/my-work", label: "Work", icon: "⚒", badge: openCount.data ?? 0 },
        { to: "/clock", label: "Time", icon: "⏱", badge: 0 },
        { to: "/learn", label: "Learn", icon: "★", badge: 0 },
        { to: "/points", label: "Points", icon: "✦", badge: 0 },
        { to: "/search", label: "Find", icon: "⌕", badge: 0 },
      ];

  return (
    <div className="app-shell">
      <ToastHost />
      <main className="app-main">
        <Outlet />
      </main>
      <nav className="bottom-nav" aria-label="Main">
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
