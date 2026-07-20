import { useQuery } from "@tanstack/react-query";
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { Camera, Clock as ClockIcon, Coffee, LayoutGrid, Menu as MenuIcon, Plus } from "lucide-react";
import { countMyOpenOpenings, getMyProfile } from "../lib/install/api";
import { ROLE_LABELS, type CrewRole } from "../lib/install/types";
import { menuForRole, roleRank, type MenuAction } from "../lib/nav";
import { useClock } from "../lib/clockContext";
import { elapsedWorkSeconds, formatClock } from "../lib/timeclock";
import { effectiveRole, useViewAsRole } from "../lib/viewAsRoleContext";
import { useRealtimeMyOpenings } from "../lib/useRealtimeOpenings";
import { supabase } from "../lib/supabase";
import { ToastHost } from "./ToastHost";
import { InfinityLogo } from "./brand/InfinityLogo";
import { AppMenu } from "./nav/AppMenu";
import { AppMenuDrawer } from "./nav/AppMenuDrawer";
import { CaptureSheet } from "./nav/CaptureSheet";
import { FeatureTip } from "./assistant/FeatureTip";
import { SyncStatusPill } from "./offline/SyncStatusPill";
import { OnboardingWizard } from "./permissions/OnboardingWizard";
import {
  closeOnboardingWizard,
  getWizardOpen,
  maybeAutoOpenWizard,
  subscribeWizard,
} from "../lib/permissions/wizardBus";

const PREVIEW_ROLES: CrewRole[] = ["installer", "foreman", "supervisor", "owner"];

/**
 * Infinity Windows app shell — reskinned to the "Horizon Windows Hub" visual
 * system. Desktop (>=860px) shows the grouped left sidebar; phone shows a fixed
 * bottom bar (Menu / Jobs / Capture(+) / Clock / Photos) where "Menu" opens the
 * full grouped slide-out drawer and the center Capture is an overhanging coral
 * FAB. The menu content + role gating flow from the shared NAV registry.
 */
export function Layout() {
  const me = useQuery({ queryKey: ["myProfile"], queryFn: getMyProfile });
  const view = useViewAsRole();
  const role = effectiveRole(me.data?.role, view);
  const isInstaller = roleRank(role) === 0;
  const location = useLocation();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const [captureOpen, setCaptureOpen] = useState(false);

  // First-run permissions onboarding: auto-open once when warranted; also
  // re-openable from Settings via the shared wizard bus.
  const wizardOpen = useSyncExternalStore(subscribeWizard, getWizardOpen, getWizardOpen);
  useEffect(() => {
    void maybeAutoOpenWizard();
  }, []);

  const clock = useClock();
  const shift = clock.shift;
  const onBreak = Boolean(shift?.break_started_at);
  const [clockNow, setClockNow] = useState(Date.now());
  useEffect(() => {
    if (!shift) return;
    const t = setInterval(() => setClockNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [shift?.id]);
  const clockLabel = shift ? formatClock(elapsedWorkSeconds(shift, clockNow)) : "Clock";

  useRealtimeMyOpenings(isInstaller ? me.data?.id : undefined);
  const openCount = useQuery({
    queryKey: ["myReadyCount", me.data?.id],
    queryFn: () => countMyOpenOpenings(me.data!.id),
    enabled: Boolean(me.data?.id) && isInstaller,
  });
  const readyBadge = isInstaller ? openCount.data ?? 0 : 0;

  // Close overlays whenever the route changes.
  useEffect(() => {
    setMenuOpen(false);
    setCaptureOpen(false);
  }, [location.pathname]);

  const applyPreview = (nextRole: CrewRole | null) => {
    view.setPreviewRole(nextRole);
    navigate("/");
  };

  const handleSignOut = async () => {
    await supabase.auth.signOut();
  };

  const sections = menuForRole(role);
  const isActionActive = (action: MenuAction) => (action === "open-clock" ? clock.isOpen : false);
  const onMenuAction = (action: MenuAction) => {
    if (action === "open-clock") {
      setMenuOpen(false);
      setCaptureOpen(false);
      clock.openClock();
    }
  };

  const openMenu = () => {
    setCaptureOpen(false);
    setMenuOpen((o) => !o);
  };
  const openCapture = () => {
    setMenuOpen(false);
    setCaptureOpen((o) => !o);
  };
  const openClockSheet = () => {
    setMenuOpen(false);
    setCaptureOpen(false);
    clock.openClock();
  };

  if (me.isLoading) {
    return (
      <div className="app-shell">
        <ToastHost />
        <div className="app-frame">
          <aside className="app-rail" aria-label="Primary">
            <span className="rail-brand" aria-label="Infinity Windows home">
              <InfinityLogo variant="full" size={22} />
            </span>
          </aside>
          <main className="app-main">
            <Outlet />
          </main>
        </div>
        <nav className="tabbar" aria-label="Main" aria-busy="true" />
      </div>
    );
  }

  const previewing = view.canPreview && view.previewRole;

  const viewAsPicker = view.canPreview ? (
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
              aria-pressed={active}
              onClick={() => applyPreview(r === me.data?.role ? null : r)}
            >
              {ROLE_LABELS[r]}
            </button>
          );
        })}
      </div>
      {view.previewRole && (
        <button type="button" className="view-as-reset" onClick={() => applyPreview(null)}>
          Reset to my role
        </button>
      )}
    </div>
  ) : null;

  return (
    <div className="app-shell">
      <ToastHost />
      <div className="sync-pill-mobile">
        <SyncStatusPill compact />
      </div>
      <div className="app-frame">
        <aside className="app-rail" aria-label="Primary">
          <Link to="/" className="rail-brand" aria-label="Infinity Windows home">
            <InfinityLogo variant="full" size={22} />
          </Link>
          <div className="rail-sync">
            <SyncStatusPill />
          </div>
          <nav className="rail-scroll" aria-label="Sections">
            <AppMenu
              sections={sections}
              onAction={onMenuAction}
              isActionActive={isActionActive}
              onSignOut={handleSignOut}
            />
          </nav>
          {viewAsPicker && <div className="rail-viewas">{viewAsPicker}</div>}
        </aside>

        <main className="app-main">
          {previewing && (
            <div className="view-as-banner" role="status">
              <span>
                Viewing as{" "}
                <strong>{ROLE_LABELS[view.previewRole as CrewRole] ?? view.previewRole}</strong>{" "}
                (your data)
              </span>
              <button type="button" className="view-as-reset" onClick={() => applyPreview(null)}>
                Reset
              </button>
            </div>
          )}
          <Outlet />
        </main>
      </div>

      {!menuOpen && !captureOpen && !clock.isOpen && <FeatureTip />}

      <nav className="tabbar" aria-label="Main">
        <TabButton
          label="Menu"
          icon={<MenuIcon size={20} />}
          active={menuOpen}
          onClick={openMenu}
          ariaLabel="Open menu"
          ariaExpanded={menuOpen}
        />
        <TabLink label="Jobs" to="/projects" icon={<LayoutGrid size={20} />} badge={readyBadge} />
        <div className="tab tab-capture">
          <button
            type="button"
            className={`capture-fab${captureOpen ? " open" : ""}`}
            aria-label="Quick capture"
            aria-expanded={captureOpen}
            onClick={openCapture}
          >
            <Plus size={24} className="capture-fab-plus" />
          </button>
          <span className={`tab-label${captureOpen ? " active" : ""}`}>Capture</span>
        </div>
        <button
          type="button"
          className={`tab${shift ? " clock-on" : ""}`}
          aria-label={onBreak ? "On break — open time tracking" : shift ? "On the clock" : "Clock in"}
          onClick={openClockSheet}
        >
          <span className="tab-icon">
            {shift ? (
              <span className="clock-tab-live">
                {onBreak ? <Coffee size={20} /> : <ClockIcon size={20} />}
                <span className={onBreak ? "clock-nav-dot break" : "clock-nav-dot work"} />
              </span>
            ) : (
              <ClockIcon size={20} />
            )}
          </span>
          <span className={`tab-label${shift ? " nav-clock-time" : ""}`}>{clockLabel}</span>
        </button>
        <TabLink label="Photos" to="/photos" icon={<Camera size={20} />} />
      </nav>

      <CaptureSheet open={captureOpen} onClose={() => setCaptureOpen(false)} />
      <AppMenuDrawer
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        sections={sections}
        onNavigate={() => setMenuOpen(false)}
        onAction={onMenuAction}
        isActionActive={isActionActive}
        onSignOut={handleSignOut}
        footer={viewAsPicker}
      />
      <OnboardingWizard open={wizardOpen} onClose={closeOnboardingWizard} />
    </div>
  );
}

function TabButton({
  label,
  icon,
  active,
  onClick,
  ariaLabel,
  ariaExpanded,
}: {
  label: string;
  icon: ReactNode;
  active: boolean;
  onClick: () => void;
  ariaLabel?: string;
  ariaExpanded?: boolean;
}) {
  return (
    <button
      type="button"
      className={`tab${active ? " active" : ""}`}
      onClick={onClick}
      aria-label={ariaLabel}
      aria-expanded={ariaExpanded}
    >
      <span className="tab-icon">{icon}</span>
      <span className={`tab-label${active ? " active" : ""}`}>{label}</span>
    </button>
  );
}

function TabLink({
  label,
  to,
  icon,
  badge,
}: {
  label: string;
  to: string;
  icon: ReactNode;
  badge?: number;
}) {
  return (
    <NavLink to={to} className={({ isActive }) => `tab${isActive ? " active" : ""}`}>
      <span className="tab-icon">
        {icon}
        {badge != null && badge > 0 && <span className="tab-badge">{badge > 99 ? "99+" : badge}</span>}
      </span>
      <span className="tab-label">{label}</span>
    </NavLink>
  );
}
