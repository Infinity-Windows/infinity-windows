import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import {
  Camera,
  Clock as ClockIcon,
  Coffee,
  Hammer,
  LayoutGrid,
  Menu as MenuIcon,
  Plus,
  ScanLine,
  Sparkles,
} from "lucide-react";
import { getMyProfile, getRealProfile, listMyOpeningsAllJobs, listProfiles } from "../lib/install/api";
import { openingReadiness } from "../lib/install/fit";
import { ROLE_LABELS, type CrewRole } from "../lib/install/types";
import { CoreValuesStrip } from "./CoreValuesStrip";
import { bottomBarForRole, menuForRole, roleRank, type MenuAction } from "../lib/nav";
import { useClock } from "../lib/clockContext";
import { useT } from "../lib/i18n";
import { formatClock } from "../lib/timeclock";
import { shiftGuard } from "../lib/shiftGuard";
import { effectiveRole, previewableRoles, useViewAsRole } from "../lib/viewAsRoleContext";
import { useRealtimeMyOpenings } from "../lib/useRealtimeOpenings";
import { supabase } from "../lib/supabase";
import { ToastHost } from "./ToastHost";
import { UndoToast } from "./UndoToast";
import { SummonBell } from "./SummonBell";
import { InfinityLogo } from "./brand/InfinityLogo";
import { AppMenu } from "./nav/AppMenu";
import { AppMenuDrawer } from "./nav/AppMenuDrawer";
import { CaptureSheet } from "./nav/CaptureSheet";
import { DailyLogNudge } from "./dailyLogs/DailyLogNudge";
import { GlobalAskFab } from "./nav/GlobalAskFab";
import { FeatureTip } from "./assistant/FeatureTip";
import { SyncStatusPill } from "./offline/SyncStatusPill";
import { OnboardingWizard } from "./permissions/OnboardingWizard";
import {
  closeOnboardingWizard,
  getWizardOpen,
  maybeAutoOpenWizard,
  subscribeWizard,
} from "../lib/permissions/wizardBus";

/** Icons for the registry-driven bottom-bar link tabs (see `bottomBarForRole`). */
const TAB_ICONS: Record<string, ReactNode> = {
  today: <Hammer size={20} />,
  scan: <ScanLine size={20} />,
  ask: <Sparkles size={20} />,
  jobs: <LayoutGrid size={20} />,
  photos: <Camera size={20} />,
};

/**
 * Infinity Windows app shell — reskinned to the "Horizon Windows Hub" visual
 * system. Desktop (>=860px) shows the grouped left sidebar; phone shows a fixed
 * bottom bar (Menu / Jobs / Capture(+) / Clock / Photos) where "Menu" opens the
 * full grouped slide-out drawer and the center Capture is an overhanging coral
 * FAB. The menu content + role gating flow from the shared NAV registry.
 */
export function Layout() {
  const t = useT();
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: ["myProfile"], queryFn: getMyProfile });
  const realMe = useQuery({ queryKey: ["myRealProfile"], queryFn: getRealProfile });
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
    // Named `tick`, not `t`: `t` is the translator now and a shadow here would
    // read as one at a glance.
    const tick = setInterval(() => setClockNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [shift?.id]);
  // Past the believable maximum the nav tab stops showing a running total and
  // says what it actually needs, so a runaway shift reads as a job to do rather
  // than a number to trust.
  const clockGuard = shift ? shiftGuard(shift, clockNow) : null;
  const clockLabel = !shift
    ? "Clock"
    : clockGuard!.workedSeconds == null
      ? "Finish time?"
      : formatClock(clockGuard!.workedSeconds);

  useRealtimeMyOpenings(isInstaller ? me.data?.id : undefined);
  // The badge means what it says (grilled Q5): TRULY ready windows — the
  // "how much can I actually do right now" number — not merely assigned.
  const openCount = useQuery({
    queryKey: ["myReadyCount", me.data?.id],
    queryFn: async () => {
      const rows = await listMyOpeningsAllJobs(me.data!.id);
      return rows.filter(
        (o) => o.status !== "installed" && openingReadiness(o).status === "ready",
      ).length;
    },
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
    view.setPreviewPerson(null);
    navigate("/");
  };
  // Owner-only person preview: every "my …" query keys off getMyProfile, so
  // switching person must drop the whole query cache and start clean.
  const crew = useQuery({
    queryKey: ["profiles"],
    queryFn: listProfiles,
    enabled: view.canPreviewPerson,
  });
  const applyPersonPreview = (personId: string) => {
    if (!personId) {
      view.setPreviewPerson(null);
    } else {
      const p = (crew.data ?? []).find((c) => c.id === personId);
      if (!p) return;
      view.setPreviewPerson({ id: p.id, name: p.display_name, role: p.role });
    }
    void queryClient.invalidateQueries();
    navigate("/");
  };

  const handleSignOut = async () => {
    await supabase.auth.signOut();
  };

  // Wave Z: the money grants come off the REAL profile and are dropped while
  // previewing another role, so the drawer a preview draws is the one that
  // role really gets — same rule useEffectiveRole applies to the route guard.
  const sections = menuForRole(
    role,
    role === realMe.data?.role
      ? { costs: realMe.data?.can_see_costs === true, pay: realMe.data?.can_see_pay === true }
      : {},
  );
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
        <UndoToast />
        <div className="app-frame">
          <aside className="app-rail" aria-label="Primary">
            <span className="rail-brand" aria-label="Forge Windows home">
              <InfinityLogo variant="full" size={22} />
            </span>
          </aside>
          <main className="app-main">
            <CoreValuesStrip pathname={location.pathname} />
            <Outlet />
          </main>
        </div>
        <nav className="tabbar" aria-label="Main" aria-busy="true" />
      </div>
    );
  }

  const previewingPerson = view.canPreviewPerson ? view.previewPerson : null;
  // `role` (above) already went through effectiveRole's clamp, so this is
  // true only for a preview that actually took effect — not for a stale or
  // forged previewRole above the real user's rank, which `role` fell back
  // past (the view-as ceiling, 2026-09-01). Person preview wins the render
  // when both are somehow set, so it's excluded here.
  const previewing =
    !previewingPerson && view.canPreview && view.previewRole != null && role === view.previewRole;

  const clockTab = (
    <button
      key="clock"
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
  );

  const viewAsPicker = view.canPreview ? (
    <div className="view-as-picker">
      <p className="view-as-title">View as role (preview)</p>
      <div className="view-as-options">
        {previewableRoles(realMe.data?.role).map((r) => {
          // Only trust view.previewRole for the active chip when it's a
          // legitimate (non-clamped) preview — a stale/forged value above
          // rank never lights up a chip that isn't even offered.
          const active = (previewing ? view.previewRole : realMe.data?.role) === r;
          return (
            <button
              key={r}
              type="button"
              className={active ? "view-as-chip active" : "view-as-chip"}
              aria-pressed={active}
              onClick={() => applyPreview(r === realMe.data?.role ? null : r)}
            >
              {ROLE_LABELS[r]}
            </button>
          );
        })}
      </div>
      {view.canPreviewPerson && (
        <select
          className="view-as-person"
          aria-label="View as a specific person"
          value={view.previewPerson?.id ?? ""}
          onChange={(e) => applyPersonPreview(e.target.value)}
        >
          <option value="">— view as a person —</option>
          {(crew.data ?? [])
            .filter((c) => c.active && c.id !== realMe.data?.id)
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.display_name} ({c.role})
              </option>
            ))}
        </select>
      )}
      {(view.previewRole || view.previewPerson) && (
        <button
          type="button"
          className="view-as-reset"
          onClick={() => {
            view.setPreviewPerson(null);
            applyPreview(null);
            void queryClient.invalidateQueries();
          }}
        >
          Reset to my view
        </button>
      )}
    </div>
  ) : null;

  return (
    <div className="app-shell">
      <ToastHost />
      <UndoToast />
      <SummonBell />
      <div className="app-frame">
        <aside className="app-rail" aria-label="Primary">
          <Link to="/" className="rail-brand" aria-label="Forge Windows home">
            <InfinityLogo variant="full" size={22} />
          </Link>
          {/* Desktop's only door to Capture. The bottom bar — and with it the
              centre (+) FAB — is display:none from 860px up, so without this
              the button the owner asked to be "on every tab and view" simply
              did not exist on a laptop. Primary weight, directly under the
              brand and above the menu, because it is an action and the rows
              below it are destinations. */}
          <button
            type="button"
            className={`rail-capture${captureOpen ? " open" : ""}`}
            aria-label={t("capture.a11y.open")}
            aria-expanded={captureOpen}
            onClick={openCapture}
          >
            <Plus size={18} aria-hidden />
            <span>{t("capture.tab")}</span>
          </button>
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
          <CoreValuesStrip pathname={location.pathname} />
          {/* Phones only (hidden from 860px up, where the rail carries it).
              In the page flow rather than floating over it, so it can never
              land on top of a job title. */}
          <div className="sync-strip">
            <SyncStatusPill />
          </div>
          {previewingPerson ? (
            <div className="view-as-banner" role="status">
              <span>
                Viewing as <strong>{previewingPerson.name}</strong> (their data) —
                anything you tap still acts as <strong>you</strong>
              </span>
              <button
                type="button"
                className="view-as-reset"
                onClick={() => applyPersonPreview("")}
              >
                Reset
              </button>
            </div>
          ) : previewing ? (
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
          ) : null}
          <Outlet />
        </main>
      </div>

      <GlobalAskFab />

      {!menuOpen && !captureOpen && !clock.isOpen && <FeatureTip />}

      <nav className="tabbar" aria-label="Main">
        {bottomBarForRole(role).map((tab) => {
          if (tab.kind === "menu") {
            return (
              <TabButton
                key="menu"
                label="Menu"
                icon={<MenuIcon size={20} />}
                active={menuOpen}
                onClick={openMenu}
                ariaLabel="Open menu"
                ariaExpanded={menuOpen}
              />
            );
          }
          if (tab.kind === "capture") {
            return (
              <div className="tab tab-capture" key="capture">
                <button
                  type="button"
                  className={`capture-fab${captureOpen ? " open" : ""}`}
                  aria-label={t("capture.a11y.open")}
                  aria-expanded={captureOpen}
                  onClick={openCapture}
                >
                  <Plus size={24} className="capture-fab-plus" />
                </button>
                <span className={`tab-label${captureOpen ? " active" : ""}`}>
                  {t("capture.tab")}
                </span>
              </div>
            );
          }
          if (tab.kind === "clock") {
            return clockTab;
          }
          return (
            <TabLink
              key={tab.id}
              label={tab.label}
              to={tab.to}
              end={tab.end}
              icon={TAB_ICONS[tab.id] ?? <LayoutGrid size={20} />}
              badge={tab.readyBadge ? readyBadge : undefined}
            />
          );
        })}
      </nav>

      {/* `role` is the effective one (view-as included), so an owner previewing
          installer sees the installer's tiles. Every write underneath is still
          keyed to the real signed-in user and gated by RLS. */}
      <CaptureSheet open={captureOpen} onClose={() => setCaptureOpen(false)} role={role} />
      {/* Rides every screen the same way the clock sheet does, for the same
          reason: whoever clocks out is looking at whatever they happened to be
          looking at, and that is where the day's log has to be offered.
          Renders nothing until there is something to ask. */}
      <DailyLogNudge role={role} />
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
  end,
}: {
  label: string;
  to: string;
  icon: ReactNode;
  badge?: number;
  end?: boolean;
}) {
  return (
    <NavLink to={to} end={end} className={({ isActive }) => `tab${isActive ? " active" : ""}`}>
      <span className="tab-icon">
        {icon}
        {badge != null && badge > 0 && <span className="tab-badge">{badge > 99 ? "99+" : badge}</span>}
      </span>
      <span className="tab-label">{label}</span>
    </NavLink>
  );
}
