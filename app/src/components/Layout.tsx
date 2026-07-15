import { useQuery } from "@tanstack/react-query";
import { NavLink, Outlet } from "react-router-dom";
import { getMyProfile } from "../lib/install/api";

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

  // Installers get a "My work" tab (their assigned list); leads get "Crew".
  const tabs = [
    ...baseTabs,
    isLead
      ? { to: "/crew", label: "Crew", icon: "\u2691" }
      : { to: "/my-work", label: "My work", icon: "\u2692" },
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
            className={({ isActive }) =>
              isActive ? "nav-tab active" : "nav-tab"
            }
          >
            <span className="nav-icon">{tab.icon}</span>
            <span>{tab.label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
