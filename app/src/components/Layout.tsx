import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { countMyOpenOpenings, getMyProfile } from "../lib/install/api";
import { ROLE_LABELS, type CrewRole } from "../lib/install/types";
import { activeNavForRole, roleRank } from "../lib/nav";
import { effectiveRole, useViewAsRole } from "../lib/viewAsRoleContext";
import { useRealtimeMyOpenings } from "../lib/useRealtimeOpenings";
import { ToastHost } from "./ToastHost";

const PREVIEW_ROLES: CrewRole[] = ["installer", "foreman", "supervisor", "owner"];

/**
 * One nav model for both viewports (Infinity IA), now driven by the shared NAV
 * registry via `activeNavForRole`:
 * - Desktop (>=860px): full left rail.
 * - Phone: slim bottom bar of the `phone` tabs + a More sheet for the rest.
 * Renders as the effective (possibly previewed) role; a role-loading skeleton
 * avoids flashing the wrong tab set while the profile query resolves.
 */
export function Layout() {
  const me = useQuery({ queryKey: ["myProfile"], queryFn: getMyProfile });
  const view = useViewAsRole();
  const role = effectiveRole(me.data?.role, view);
  const isInstaller = roleRank(role) === 0;
  const location = useLocation();
  const [moreOpen, setMoreOpen] = useState(false);

  useRealtimeMyOpenings(isInstaller ? me.data?.id : undefined);
  const openCount = useQuery({
    queryKey: ["myReadyCount", me.data?.id],
    queryFn: () => countMyOpenOpenings(me.data!.id),
    enabled: Boolean(me.data?.id) && isInstaller,
  });

  const hideFab = location.pathname === "/ask";
  const readyBadge = isInstaller ? openCount.data ?? 0 : 0;

  // Ready-work badge belongs on the installer's landing tab ("/" = My Work).
  const badgeFor = (to: string) => (to === "/" && isInstaller ? readyBadge : 0);

  // While the role is still loading, render a minimal shell (no tabs) so we
  // never flash the wrong role's navigation.
  if (me.isLoading) {
    return (
      <div className="app-shell">
        <ToastHost />
        <div className="app-frame">
          <aside className="app-rail" aria-label="Primary">
            <span className="rail-brand" aria-label="Home">∞</span>
          </aside>
          <main className="app-main">
            <Outlet />
          </main>
        </div>
        <nav className="bottom-nav" aria-label="Main" aria-busy="true" />
      </div>
    );
  }

  const nav = activeNavForRole(role);
  const previewing = view.canPreview && view.previewRole;

  return (
    <div className="app-shell">
      <ToastHost />
      <div className="app-frame">
        <aside className="app-rail" aria-label="Primary">
          <Link to="/" className="rail-brand" aria-label="Home">
            ∞
          </Link>
          <div className="rail-tabs">
            {nav.rail.map((tab) => (
              <NavLink
                key={tab.id}
                to={tab.to}
                end={tab.to === "/"}
                className={({ isActive }) =>
                  isActive ? "rail-tab active" : "rail-tab"
                }
              >
                <span className="rail-bar" aria-hidden />
                <span className="rail-label">{tab.label}</span>
                {badgeFor(tab.to) > 0 && (
                  <span className="rail-badge">{badgeFor(tab.to)}</span>
                )}
              </NavLink>
            ))}
          </div>
        </aside>

        <main className="app-main">
          {previewing && (
            <div className="view-as-banner" role="status">
              <span>
                Viewing as{" "}
                <strong>{ROLE_LABELS[view.previewRole as CrewRole] ?? view.previewRole}</strong>{" "}
                — preview only
              </span>
              <button
                type="button"
                className="view-as-reset"
                onClick={() => view.setPreviewRole(null)}
              >
                Reset
              </button>
            </div>
          )}
          <Outlet />
        </main>
      </div>

      <nav className="bottom-nav" aria-label="Main">
        {nav.phone.map((tab) => (
          <NavLink
            key={tab.id}
            to={tab.to}
            end={tab.to === "/"}
            className={({ isActive }) => (isActive ? "nav-tab active" : "nav-tab")}
          >
            <span className="nav-icon">
              {tab.icon}
              {badgeFor(tab.to) > 0 && <span className="nav-badge">{badgeFor(tab.to)}</span>}
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
              {nav.more.map((tab) => (
                <NavLink
                  key={tab.id}
                  to={tab.to}
                  onClick={() => setMoreOpen(false)}
                  className="more-sheet-item"
                >
                  <span className="more-sheet-icon">{tab.icon}</span>
                  {tab.label}
                </NavLink>
              ))}
            </div>

            {view.canPreview && (
              <div className="view-as-picker">
                <p className="view-as-title">View as role (preview)</p>
                <div className="view-as-options">
                  {PREVIEW_ROLES.map((r) => {
                    const active = (view.previewRole ?? me.data?.role) === r;
                    return (
                      <button
                        key={r}
                        type="button"
                        className={active ? "view-as-chip active" : "view-as-chip"}
                        onClick={() => {
                          view.setPreviewRole(r === me.data?.role ? null : r);
                          setMoreOpen(false);
                        }}
                      >
                        {ROLE_LABELS[r]}
                      </button>
                    );
                  })}
                </div>
                {view.previewRole && (
                  <button
                    type="button"
                    className="view-as-reset"
                    onClick={() => {
                      view.setPreviewRole(null);
                      setMoreOpen(false);
                    }}
                  >
                    Reset to my role
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
