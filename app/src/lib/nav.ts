import type { ComponentType } from "react";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Bell,
  BookOpen,
  Boxes,
  BrainCircuit,
  Camera,
  CalendarClock,
  CalendarDays,
  CheckCircle2,
  ClipboardList,
  Clock,
  DollarSign,
  GraduationCap,
  Hash,
  KeyRound,
  LayoutGrid,
  ListChecks,
  MoreHorizontal,
  PackageCheck,
  Plane,
  ScanLine,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Trophy,
  Truck,
  Users,
  Warehouse as WarehouseIcon,
  Wrench,
} from "lucide-react";
import { roleRank, type CrewRole } from "./install/types";

// Re-exported so existing importers (Layout, tests) keep a single source of
// truth: roleRank now lives in install/types and nav/pages share it.
export { roleRank };

/**
 * ONE registry drives navigation, route guards, the living access doc, and the
 * screenshot suite. Change a role's access in one line here and the nav, the
 * `<RequireRole>` guards in App.tsx, docs/role-access.md, and its snapshot test
 * all move together — nav and guards can never drift.
 */

/** Every navigable app path (nav `to` and route `path` share these literals). */
export type RoutePath =
  | "/"
  | "/my-work"
  | "/projects"
  | "/warehouse"
  | "/clock"
  | "/learn"
  | "/points"
  | "/safety"
  | "/scan"
  | "/count"
  | "/ask"
  | "/knowledge"
  | "/ai-spend"
  | "/notifications"
  | "/search"
  | "/review"
  | "/team"
  | "/timecard"
  | "/team-timecards"
  | "/scheduling"
  | "/vehicles"
  | "/my-schedule"
  | "/travel"
  | "/issues"
  | "/service"
  | "/heartbeat"
  | "/qc"
  | "/analytics"
  | "/crew"
  | "/training"
  | "/receive"
  | "/labels"
  | "/catalog"
  | "/supplies"
  | "/admin"
  | "/access"
  | "/cost-codes"
  | "/costing"
  // Horizon-menu stub destinations (no feature yet → "Coming soon" page).
  | "/photos"
  | "/daily-logs"
  | "/completed-installs"
  | "/milestones"
  | "/first-pane"
  | "/toolbox-history"
  | "/conditions"
  | "/contacts"
  | "/profile"
  | "/settings"
  | "/public-site";

/**
 * Rollout flag. Flip to `false` to instantly revert to the previous flat nav
 * (all tabs by legacy show-flags, no route guards, everyone lands on Home).
 * Keep the fallback path (legacyNavForRole + RequireRole/RoleLanding checks)
 * working so a bad rollout is one constant away from reverted.
 */
export const ROLE_NAV_V2 = true;

export interface NavDest {
  id: string;
  to: RoutePath;
  label: string;
  icon: string;
  /** Minimum role that may see/reach this destination. */
  minRole: CrewRole;
}

/**
 * The canonical destination registry: every guarded or navigable route with the
 * role floor that unlocks it. Open (installer) entries are reachable by URL but
 * only surface as tabs where a role layout places them (see *_LAYOUT below).
 */
export const NAV: NavDest[] = [
  // Open to everyone (installer floor) — execution + shared surfaces.
  { id: "home", to: "/", label: "Home", icon: "⌂", minRole: "installer" },
  { id: "clock", to: "/clock", label: "Time", icon: "⏱", minRole: "installer" },
  { id: "learn", to: "/learn", label: "Learn", icon: "★", minRole: "installer" },
  { id: "points", to: "/points", label: "Points", icon: "✦", minRole: "installer" },
  { id: "safety", to: "/safety", label: "Safety", icon: "⛑", minRole: "installer" },
  { id: "scan", to: "/scan", label: "Scan", icon: "▣", minRole: "installer" },
  { id: "count", to: "/count", label: "Cycle count", icon: "#", minRole: "installer" },
  { id: "warehouse", to: "/warehouse", label: "Warehouse", icon: "▦", minRole: "installer" },
  { id: "projects", to: "/projects", label: "Jobs", icon: "▤", minRole: "installer" },
  { id: "ask", to: "/ask", label: "Ask", icon: "?", minRole: "installer" },
  { id: "notifications", to: "/notifications", label: "Notifications", icon: "◔", minRole: "installer" },
  { id: "search", to: "/search", label: "Search", icon: "⌕", minRole: "installer" },
  { id: "review", to: "/review", label: "Memo review", icon: "✍", minRole: "installer" },
  { id: "my-schedule", to: "/my-schedule", label: "My Schedule", icon: "◷", minRole: "installer" },
  { id: "travel", to: "/travel", label: "Travel", icon: "✈", minRole: "installer" },
  // Everyone sees their own timecard (BusyBusy-style); the page itself scopes
  // by role — installers get only their own week, read-only, while foreman+
  // get the crew grid and editing. The floor here is about the ROUTE, not the
  // data: RLS and the page's isLead branch decide what each role sees.
  { id: "timecard", to: "/timecard", label: "My timecard", icon: "▥", minRole: "installer" },

  // Foreman+ (managers): coordination + warehouse ops + quality.
  { id: "team", to: "/team", label: "Team", icon: "⚑", minRole: "foreman" },
  // The crew-wide roster + edit surface; /timecard stays the personal view.
  { id: "team-timecards", to: "/team-timecards", label: "Team timecards", icon: "▥", minRole: "foreman" },
  { id: "issues", to: "/issues", label: "Issues", icon: "!", minRole: "foreman" },
  { id: "service", to: "/service", label: "Service", icon: "⚕", minRole: "foreman" },
  { id: "qc", to: "/qc", label: "Quality", icon: "✓", minRole: "foreman" },
  { id: "analytics", to: "/analytics", label: "Analytics", icon: "◲", minRole: "foreman" },
  { id: "crew", to: "/crew", label: "Roster", icon: "☰", minRole: "foreman" },
  { id: "training", to: "/training", label: "Training", icon: "✎", minRole: "foreman" },
  { id: "receive", to: "/receive", label: "Receive", icon: "⬇", minRole: "foreman" },
  { id: "labels", to: "/labels", label: "Slot labels", icon: "❏", minRole: "foreman" },
  { id: "catalog", to: "/catalog", label: "Catalog", icon: "❒", minRole: "foreman" },
  { id: "supplies", to: "/supplies", label: "Supplies", icon: "⛃", minRole: "foreman" },

  // Supervisor+.
  { id: "knowledge", to: "/knowledge", label: "AI Knowledge", icon: "◈", minRole: "supervisor" },
  // Foremen can OPEN the board and read the week's plan; moving people is
  // still a supervisor+ action, enforced inside the page (owner, 2026-08-11).
  { id: "scheduling", to: "/scheduling", label: "Scheduling", icon: "🗓", minRole: "foreman" },
  { id: "vehicles", to: "/vehicles", label: "Vehicles", icon: "🚚", minRole: "supervisor" },
  { id: "heartbeat", to: "/heartbeat", label: "Heartbeat", icon: "❤", minRole: "supervisor" },
  { id: "admin", to: "/admin", label: "Admin", icon: "◈", minRole: "supervisor" },
  // Handing out and taking away logins. Supervisor+, deliberately the same floor
  // as set_profile_role() — inviting someone as a foreman and promoting someone
  // to foreman are the same power, so they must not have different doors.
  { id: "access", to: "/access", label: "Crew access", icon: "⚿", minRole: "supervisor" },
  { id: "cost-codes", to: "/cost-codes", label: "Cost codes", icon: "☷", minRole: "supervisor" },

  // Owner only.
  { id: "costing", to: "/costing", label: "Cost", icon: "$", minRole: "owner" },
  { id: "ai-spend", to: "/ai-spend", label: "AI spend", icon: "◍", minRole: "owner" },

  // ---- Horizon-menu stub destinations (render a shared "Coming soon" page) ----
  // Access still flows through this registry so role-gating never drifts.
  { id: "photos", to: "/photos", label: "Photos & receipts", icon: "▨", minRole: "installer" },
  { id: "daily-logs", to: "/daily-logs", label: "Daily logs", icon: "❐", minRole: "foreman" },
  { id: "completed-installs", to: "/completed-installs", label: "Completed installs", icon: "✔", minRole: "installer" },
  { id: "milestones", to: "/milestones", label: "Milestones", icon: "★", minRole: "installer" },
  { id: "first-pane", to: "/first-pane", label: "First Pane", icon: "☀", minRole: "installer" },
  { id: "toolbox-history", to: "/toolbox-history", label: "Toolbox talk history", icon: "⛑", minRole: "installer" },
  { id: "conditions", to: "/conditions", label: "Conditions", icon: "❑", minRole: "foreman" },
  { id: "contacts", to: "/contacts", label: "Contacts", icon: "☏", minRole: "foreman" },
  { id: "profile", to: "/profile", label: "Profile", icon: "◉", minRole: "installer" },
  { id: "public-site", to: "/public-site", label: "View public site", icon: "◎", minRole: "installer" },
];

const NAV_BY_PATH = new Map(NAV.map((d) => [d.to, d]));

/** minRole for a path, or null for detail/legacy routes not in the registry. */
export function minRoleForPath(path: string): CrewRole | null {
  return NAV_BY_PATH.get(path as RoutePath)?.minRole ?? null;
}

/**
 * Access check used by nav visibility and the `<RequireRole>` route guard.
 * Paths not in the registry (detail/legacy like /w/:id, /projects/:id/*) default
 * to allow so deep links keep working.
 */
export function canAccess(role: CrewRole | string | null | undefined, path: string): boolean {
  const dest = NAV_BY_PATH.get(path as RoutePath);
  if (!dest) return true;
  return roleRank(role) >= roleRank(dest.minRole);
}

// =============================================================================
// Phone bottom bar (single source for Layout + the role-access doc)
// =============================================================================
//
// The mobile bottom bar is intentionally tiny. Installers get the whole job
// loop — Today / Scan / Clock / Ask — and nothing else competes for a tap;
// managers keep Jobs / Capture / Clock / Ask (Photos moved into the menu). The
// leading Menu button and
// the Clock/Capture controls are actions, not destinations. Layout renders
// these; roleAccessDoc reads them so the docs can never drift from the UI.

export type BottomTab =
  | { kind: "menu" }
  | { kind: "capture" }
  | { kind: "clock" }
  | {
      kind: "link";
      id: string;
      to: RoutePath;
      label: string;
      /** Match the route exactly (needed for "/"). */
      end?: boolean;
      /** Show the installer "ready now" count. */
      readyBadge?: boolean;
    };

/** The ordered phone bottom-bar tabs for a role. */
export function bottomBarForRole(
  role: CrewRole | string | null | undefined,
): BottomTab[] {
  if (roleRank(role) === 0) {
    return [
      { kind: "menu" },
      { kind: "link", id: "today", to: "/", label: "Today", end: true, readyBadge: true },
      { kind: "link", id: "scan", to: "/scan", label: "Scan" },
      { kind: "clock" },
      { kind: "link", id: "ask", to: "/ask", label: "Ask" },
    ];
  }
  // Managers keep Capture but get one-tap Ask (installers who make foreman
  // still need the assistant in the field). Photos lives in the menu now.
  return [
    { kind: "menu" },
    { kind: "link", id: "jobs", to: "/projects", label: "Jobs", readyBadge: true },
    { kind: "capture" },
    { kind: "clock" },
    { kind: "link", id: "ask", to: "/ask", label: "Ask" },
  ];
}


// =============================================================================
// Horizon-style grouped menu (desktop sidebar + mobile slide-out drawer)
// =============================================================================
//
// This is the single grouped menu shared by the desktop sidebar and the mobile
// Menu drawer, mirroring the "Horizon Windows Hub" layout: a top group (no
// header), two solid coral collapsible pills (TIME TRACKING / BUSINESS), then
// the COMPANY / TOOLS / ACCOUNT sections. Every route item is gated by the same
// `canAccess` registry above, so nav visibility and route guards never drift.

type IconComponent = ComponentType<{ className?: string; size?: number }>;

/** Overlay actions a menu row can trigger instead of navigating. */
export type MenuAction = "open-clock";

export interface MenuItem {
  label: string;
  Icon: IconComponent;
  /** Registry path — gated via canAccess. Omit when `action` is set. */
  to?: RoutePath;
  /** Overlay action (e.g. open the clock sheet). */
  action?: MenuAction;
  /** Opens in a new tab / links out of the SPA. */
  external?: boolean;
}

export interface MenuSection {
  /** Uppercase section label. Omit for the flush top group. */
  title?: string;
  /** Render as a solid coral collapsible pill launcher (TIME TRACKING/BUSINESS). */
  pill?: boolean;
  /** Collapsible section (chevron toggles the item list). */
  collapsible?: boolean;
  defaultOpen?: boolean;
  /** Leading icon for pill / section headers. */
  Icon?: IconComponent;
  items: MenuItem[];
}

/**
 * Raw (unfiltered) menu definition — the Horizon Hub structure. The old sprawling
 * "Company" and "Tools" lists are split into small, scannable hubs (Problems &
 * quality / Fleet / People / Learning / AI) so nothing runs past ~6 rows. Every
 * destination and its role gate are preserved; this is grouping only.
 */
const MENU_DEF: MenuSection[] = [
  {
    // Flush top group — no header. My Work is the personal install queue for
    // foremen who still install (installers reach it via the landing "/").
    items: [
      { to: "/", label: "Home", Icon: LayoutGrid },
      { to: "/my-work", label: "My Work", Icon: ListChecks },
      { to: "/projects", label: "Jobs", Icon: LayoutGrid },
      { to: "/photos", label: "Photos & receipts", Icon: Camera },
    ],
  },
  {
    title: "Time tracking",
    pill: true,
    collapsible: true,
    Icon: Clock,
    items: [
      { action: "open-clock", label: "Clock in / out", Icon: Clock },
      { to: "/timecard", label: "My timecard", Icon: CalendarClock },
      { to: "/team-timecards", label: "Team timecards", Icon: Users },
      { to: "/cost-codes", label: "Cost codes", Icon: Hash },
    ],
  },
  {
    title: "Business",
    pill: true,
    collapsible: true,
    Icon: DollarSign,
    items: [
      { to: "/costing", label: "Cost", Icon: DollarSign },
      { to: "/analytics", label: "Analytics", Icon: BarChart3 },
      { to: "/heartbeat", label: "Heartbeat", Icon: Activity },
    ],
  },
  {
    title: "Warehouse",
    pill: true,
    collapsible: true,
    Icon: WarehouseIcon,
    items: [
      { to: "/warehouse", label: "Hub", Icon: WarehouseIcon },
      { to: "/scan", label: "Scan", Icon: ScanLine },
      { to: "/count", label: "Cycle count", Icon: ListChecks },
      { to: "/receive", label: "Receive", Icon: PackageCheck },
      { to: "/labels", label: "Slot labels", Icon: Hash },
      { to: "/catalog", label: "Catalog", Icon: BookOpen },
      { to: "/supplies", label: "Supplies", Icon: Boxes },
    ],
  },
  {
    title: "Problems & quality",
    items: [
      { to: "/issues", label: "Issues", Icon: AlertTriangle },
      { to: "/service", label: "Service", Icon: Wrench },
      { to: "/qc", label: "Quality", Icon: CheckCircle2 },
    ],
  },
  {
    title: "Fleet",
    items: [
      { to: "/scheduling", label: "Scheduling", Icon: CalendarDays },
      { to: "/vehicles", label: "Vehicles", Icon: Truck },
      { to: "/my-schedule", label: "My Schedule", Icon: CalendarClock },
      { to: "/travel", label: "Travel", Icon: Plane },
    ],
  },
  {
    title: "People",
    items: [
      { to: "/team", label: "Team", Icon: Users },
      { to: "/crew", label: "Roster", Icon: Users },
      { to: "/access", label: "Crew access", Icon: KeyRound },
    ],
  },
  {
    title: "Learning",
    items: [
      { to: "/learn", label: "Learn", Icon: BookOpen },
      { to: "/training", label: "Training", Icon: GraduationCap },
      { to: "/points", label: "Points", Icon: Trophy },
      { to: "/review", label: "Memo review", Icon: ClipboardList },
      { to: "/safety", label: "Safety", Icon: ShieldCheck },
    ],
  },
  {
    title: "AI",
    items: [
      { to: "/ask", label: "Ask", Icon: Sparkles },
      { to: "/knowledge", label: "AI Knowledge", Icon: BrainCircuit },
      { to: "/ai-spend", label: "AI spend", Icon: DollarSign },
    ],
  },
  {
    title: "Account",
    items: [
      { to: "/notifications", label: "Notifications", Icon: Bell },
      { to: "/settings", label: "Settings", Icon: SlidersHorizontal },
      { to: "/admin", label: "Admin", Icon: ShieldCheck },
    ],
  },
];

/** Fast path→item lookup so the installer drawer can reuse labels + icons. */
const MENU_ITEM_BY_PATH = new Map<string, MenuItem>();
for (const section of MENU_DEF) {
  for (const item of section.items) {
    if (item.to) MENU_ITEM_BY_PATH.set(item.to, item);
  }
}

/**
 * Installer-first: the phone bottom bar already carries the whole job loop
 * (Today / Scan / Clock / Ask), so the installer drawer drops the duplicate
 * Scan/Ask rows and shows only the short daily loop up top. Everything else an
 * installer can reach folds under a collapsible "More". Managers keep the full
 * grouped menu. Action items (e.g. clock) always show.
 */
const INSTALLER_LOOP_PATHS: RoutePath[] = ["/", "/warehouse", "/my-schedule"];
const INSTALLER_MORE_PATHS: RoutePath[] = [
  "/travel",
  "/learn",
  "/points",
  "/review",
  "/safety",
  "/supplies",
  "/notifications",
  "/settings",
];

function installerMenu(role: CrewRole | string | null | undefined): MenuSection[] {
  const pick = (paths: RoutePath[]): MenuItem[] =>
    paths
      .map((p) => MENU_ITEM_BY_PATH.get(p))
      .filter((it): it is MenuItem => Boolean(it?.to) && canAccess(role, it!.to!))
      .map((it) => (it.to === "/" ? { ...it, label: "My Work" } : it));

  const out: MenuSection[] = [{ items: pick(INSTALLER_LOOP_PATHS) }];

  // Keep the Time tracking pill (clock in/out) — installers clock in daily.
  const timePill = MENU_DEF.find((s) => s.title === "Time tracking");
  if (timePill) {
    const items = timePill.items.filter((it) => !it.to || canAccess(role, it.to));
    if (items.length) out.push({ ...timePill, items });
  }

  const more = pick(INSTALLER_MORE_PATHS);
  if (more.length) {
    // Reuse the collapsible pill so "More" folds with a chevron and no new CSS.
    out.push({
      title: "More",
      pill: true,
      collapsible: true,
      defaultOpen: false,
      Icon: MoreHorizontal,
      items: more,
    });
  }
  return out;
}

/**
 * The grouped Horizon-style menu for a role. Installers get the trimmed
 * daily-loop drawer (with a "More" fold); everyone else gets the full grouped
 * menu filtered through `canAccess` (the same registry the route guards use),
 * with empty sections dropped. Non-installer "/" reads "Home".
 */
export function menuForRole(role: CrewRole | string | null | undefined): MenuSection[] {
  if (roleRank(role) === 0) return installerMenu(role);
  const out: MenuSection[] = [];
  for (const section of MENU_DEF) {
    const items = section.items.filter((it) => !it.to || canAccess(role, it.to));
    if (items.length === 0) continue;
    out.push({ ...section, items });
  }
  return out;
}
