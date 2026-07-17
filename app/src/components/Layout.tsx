import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { countMyOpenOpenings, getMyProfile } from "../lib/install/api";
import { isAdmin, isBigBoss, isLeadLike } from "../lib/install/types";
import { useRealtimeMyOpenings } from "../lib/useRealtimeOpenings";
import { ToastHost } from "./ToastHost";

interface Tab {
  to: string;
  label: string;
  icon: string;
  badge?: number;
  show: boolean;
  /** Also appears in the phone bottom bar (top-level). */
  phone?: boolean;
}

/**
 * One nav model for both viewports (Infinity IA):
 * - Desktop (>=860px): full left rail.
 * - Phone: slim bottom bar of the `phone` tabs + a More sheet for the rest.
 */
export function Layout() {
  const me = useQuery({ queryKey: ["myProfile"], queryFn: getMyProfile });
  const role = me.data?.role;
  const lead = isLeadLike(role);
  const admin = isAdmin(role);
  const boss = isBigBoss(role);
  const location = useLocation();
  const [moreOpen, setMoreOpen] = useState(false);

  useRealtimeMyOpenings(!lead ? me.data?.id : undefined);
  const openCount = useQuery({
    queryKey: ["myReadyCount", me.data?.id],
    queryFn: () => countMyOpenOpenings(me.data!.id),
    enabled: Boolean(me.data?.id) && !lead,
  });

  const tabs: Tab[] = [
    { to: "/", label: "Home", icon: "⌂", show: true, phone: true },
    {
      to: "/my-work",
      label: "Work",
      icon: "⚒",
      badge: openCount.data ?? 0,
      show: true,
      phone: true,
    },
    { to: "/warehouse", label: "Warehouse", icon: "▦", show: true, phone: true },
    { to: "/clock", label: "Time", icon: "⏱", show: true, phone: true },
    { to: "/points", label: "Points", icon: "✦", show: true },
    { to: "/learn", label: "Learn", icon: "★", show: true },
    { to: "/qc", label: "Quality", icon: "✓", show: true },
    { to: "/safety", label: "Safety", icon: "⛑", show: true },
    { to: "/tools", label: "Tools", icon: "⚙", show: true },
    { to: "/team", label: "Team", icon: "⚑", show: lead },
    { to: "/admin", label: "Admin", icon: "◈", show: admin },
    { to: "/costing", label: "Cost", icon: "$", show: boss },
  ].filter((t) => t.show);

  const phoneTabs = tabs.filter((t) => t.phone);
  const moreTabs = tabs.filter((t) => !t.phone);
  const hideFab = location.pathname === "/ask";

  return (
    <div className="app-shell">
      <ToastHost />
      <div className="app-frame">
        <aside className="app-rail" aria-label="Primary">
          <Link to="/" className="rail-brand" aria-label="Home">
            ∞
          </Link>
          <div className="rail-tabs">
            {tabs.map((tab) => (
              <NavLink
                key={tab.to}
                to={tab.to}
                end={tab.to === "/"}
                className={({ isActive }) =>
                  isActive ? "rail-tab active" : "rail-tab"
                }
              >
                <span className="rail-bar" aria-hidden />
                <span className="rail-label">{tab.label}</span>
                {(tab.badge ?? 0) > 0 && (
                  <span className="rail-badge">{tab.badge}</span>
                )}
              </NavLink>
            ))}
          </div>
        </aside>

        <main className="app-main">
          <Outlet />
        </main>
      </div>

      <nav className="bottom-nav" aria-label="Main">
        {phoneTabs.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            end={tab.to === "/"}
            className={({ isActive }) => (isActive ? "nav-tab active" : "nav-tab")}
          >
            <span className="nav-icon">
              {tab.icon}
              {(tab.badge ?? 0) > 0 && <span className="nav-badge">{tab.badge}</span>}
            </span>
            <span>{tab.label}</span>
          </NavLink>
        ))}
        <button
          type="button"
          className="nav-tab"
          onClick={() => setMoreOpen(true)}
          aria-label="More"
        >
          <span className="nav-icon">⋯</span>
          <span>More</span>
        </button>
      </nav>

      {!hideFab && (
        <Link to="/ask" className="ask-fab" aria-label="Ask Infinity">
          <span className="ask-fab-diamond" aria-hidden />
        </Link>
      )}

      {moreOpen && (
        <div className="more-sheet-backdrop" onClick={() => setMoreOpen(false)}>
          <div
            className="more-sheet"
            role="dialog"
            aria-label="More"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="more-sheet-grip" aria-hidden />
            <div className="more-sheet-grid">
              {moreTabs.map((tab) => (
                <NavLink
                  key={tab.to}
                  to={tab.to}
                  onClick={() => setMoreOpen(false)}
                  className="more-sheet-item"
                >
                  <span className="more-sheet-icon">{tab.icon}</span>
                  {tab.label}
                </NavLink>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
