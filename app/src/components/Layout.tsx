import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { countMyOpenOpenings, getMyProfile } from "../lib/install/api";
import { ROLE_LABELS, type CrewRole } from "../lib/install/types";
import { activeNavForRole, roleRank } from "../lib/nav";
import { useClock } from "../lib/clockContext";
import { elapsedWorkSeconds, formatClock } from "../lib/timeclock";
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
  const navigate = useNavigate();
  const [moreOpen, setMoreOpen] = useState(false);

  // Switching the previewed role: update the preview and land on "/" so
  // RoleLanding drops us on that role's correct home. This prevents an
  // owner/supervisor from being stranded on the "Restricted" screen when they
  // preview a lower role while sitting on a page that role can't access.
  // Real authorization (canAccess / RLS) is untouched — this is preview nav only.
  const applyPreview = (nextRole: CrewRole | null) => {
    view.setPreviewRole(nextRole);
    navigate("/");
  };

  const clock = useClock();
  const shift = clock.shift;
  const onBreak = Boolean(shift?.break_started_at);
  const [clockNow, setClockNow] = useState(Date.now());
  useEffect(() => {
    if (!shift) return;
    const t = setInterval(() => setClockNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [shift?.id]);
  const clockLabel = shift ? formatClock(elapsedWorkSeconds(shift, clockNow)) : "Time";

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
            <span className="rail-brand" aria-label="Infinity home">
              <span className="rail-brand-mark" aria-hidden>
                ∞
              </span>
              <span className="rail-brand-word">Infinity</span>
            </span>
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
          <Link to="/" className="rail-brand" aria-label="Infinity home">
            <span className="rail-brand-mark" aria-hidden>
              ∞
            </span>
            <span className="rail-brand-word">Infinity</span>
          </Link>
          <p className="rail-eyebrow" aria-hidden>
            Menu
          </p>
          <nav className="rail-tabs" aria-label="Sections">
            {nav.rail.map((tab) =>
              tab.id === "clock" ? (
                <button
                  key={tab.id}
                  type="button"
                  className={shift ? "rail-tab clock-on" : "rail-tab"}
                  onClick={clock.openClock}
                >
                  <span className="rail-icon" aria-hidden>
                    {shift ? (
                      <span
                        className={onBreak ? "clock-nav-dot break" : "clock-nav-dot work"}
                      />
                    ) : (
                      tab.icon
                    )}
                  </span>
                  <span className="rail-label">{shift ? clockLabel : tab.label}</span>
                </button>
              ) : (
                <NavLink
                  key={tab.id}
                  to={tab.to}
                  end={tab.to === "/"}
                  className={({ isActive }) =>
                    isActive ? "rail-tab active" : "rail-tab"
                  }
                >
                  <span className="rail-icon" aria-hidden>
                    {tab.icon}
                  </span>
                  <span className="rail-label">{tab.label}</span>
                  {badgeFor(tab.to) > 0 && (
                    <span className="rail-badge">{badgeFor(tab.to)}</span>
                  )}
                </NavLink>
              ),
            )}
          </nav>

          {view.canPreview && (
            <div className="rail-viewas">
              <p className="rail-eyebrow" aria-hidden>
                View as
              </p>
              <div className="rail-viewas-options">
                {PREVIEW_ROLES.map((r) => {
                  const active = (view.previewRole ?? me.data?.role) === r;
                  return (
                    <button
                      key={r}
                      type="button"
                      className={active ? "rail-viewas-chip active" : "rail-viewas-chip"}
                      aria-pressed={active}
                      onClick={() =>
                        applyPreview(r === me.data?.role ? null : r)
                      }
                    >
                      {ROLE_LABELS[r]}
                    </button>
                  );
                })}
              </div>
              {view.previewRole && (
                <button
                  type="button"
                  className="rail-viewas-reset"
                  onClick={() => applyPreview(null)}
                >
                  Reset to my role
                </button>
              )}
            </div>
          )}
        </aside>

        <main className="app-main">
          {previewing && (
            <div className="view-as-banner" role="status">
              <span>
                Viewing as{" "}
                <strong>{ROLE_LABELS[view.previewRole as CrewRole] ?? view.previewRole}</strong>{" "}
                (your data)
              </span>
              <button
                type="button"
                className="view-as-reset"
                onClick={() => applyPreview(null)}
              >
                Reset
              </button>
            </div>
          )}
          <Outlet />
        </main>
      </div>

      <nav className="bottom-nav" aria-label="Main">
        {nav.phone.map((tab) =>
          tab.id === "clock" ? (
            <button
              key={tab.id}
              type="button"
              className={shift ? "nav-tab clock-on" : "nav-tab"}
              onClick={clock.openClock}
            >
              <span className="nav-icon">
                {shift ? (
                  <span
                    className={onBreak ? "clock-nav-dot break" : "clock-nav-dot work"}
                  />
                ) : (
                  tab.icon
                )}
              </span>
              <span className={shift ? "nav-clock-time" : undefined}>
                {shift ? clockLabel : tab.label}
              </span>
            </button>
          ) : (
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
          ),
        )}
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
                          applyPreview(r === me.data?.role ? null : r);
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
                      applyPreview(null);
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
