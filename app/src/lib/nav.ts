import type { ComponentType } from "react";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Bell,
  BookOpen,
  Boxes,
  CalendarClock,
  CheckCircle2,
  ClipboardList,
  Clock,
  Contact,
  DollarSign,
  Globe,
  GraduationCap,
  Hash,
  Images,
  LayoutGrid,
  ListChecks,
  NotebookPen,
  PackageCheck,
  ScanLine,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Sunrise,
  Trophy,
  User,
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
  | "/tools"
  | "/scan"
  | "/count"
  | "/ask"
  | "/notifications"
  | "/search"
  | "/review"
  | "/team"
  | "/timecard"
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
  { id: "my-work", to: "/my-work", label: "Work", icon: "⚒", minRole: "installer" },
  { id: "clock", to: "/clock", label: "Time", icon: "⏱", minRole: "installer" },
  { id: "learn", to: "/learn", label: "Learn", icon: "★", minRole: "installer" },
  { id: "points", to: "/points", label: "Points", icon: "✦", minRole: "installer" },
  { id: "safety", to: "/safety", label: "Safety", icon: "⛑", minRole: "installer" },
  { id: "tools", to: "/tools", label: "Tools", icon: "⚙", minRole: "installer" },
  { id: "scan", to: "/scan", label: "Scan", icon: "▣", minRole: "installer" },
  { id: "count", to: "/count", label: "Cycle count", icon: "#", minRole: "installer" },
  { id: "warehouse", to: "/warehouse", label: "Warehouse", icon: "▦", minRole: "installer" },
  { id: "projects", to: "/projects", label: "Projects", icon: "▤", minRole: "installer" },
  { id: "ask", to: "/ask", label: "Ask", icon: "?", minRole: "installer" },
  { id: "notifications", to: "/notifications", label: "Notifications", icon: "◔", minRole: "installer" },
  { id: "search", to: "/search", label: "Search", icon: "⌕", minRole: "installer" },
  { id: "review", to: "/review", label: "Memo review", icon: "✍", minRole: "installer" },

  // Foreman+ (managers): coordination + warehouse ops + quality.
  { id: "team", to: "/team", label: "Team", icon: "⚑", minRole: "foreman" },
  { id: "timecard", to: "/timecard", label: "Timecard", icon: "▥", minRole: "foreman" },
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
  { id: "heartbeat", to: "/heartbeat", label: "Heartbeat", icon: "❤", minRole: "supervisor" },
  { id: "admin", to: "/admin", label: "Admin", icon: "◈", minRole: "supervisor" },
  { id: "cost-codes", to: "/cost-codes", label: "Cost codes", icon: "☷", minRole: "supervisor" },

  // Owner only.
  { id: "costing", to: "/costing", label: "Cost", icon: "$", minRole: "owner" },

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

const NAV_BY_ID = new Map(NAV.map((d) => [d.id, d]));
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

interface LayoutItem {
  id: string;
  /** Appears in the phone bottom bar (otherwise it lives in the More sheet). */
  phone?: boolean;
  /** Per-role label override (e.g. installer Home reads "My Work"). */
  label?: string;
}

/**
 * Per-role ordered menus (existing routes only). navForRole composes these from
 * NAV, so presentation varies by role while access still flows from one registry.
 * Installer "/" is their My Work landing; managers land on Home.
 */
const INSTALLER_LAYOUT: LayoutItem[] = [
  { id: "home", phone: true, label: "My Work" },
  { id: "clock", phone: true },
  { id: "learn", phone: true },
  { id: "safety", phone: true },
  { id: "points" },
  { id: "scan" },
  { id: "tools" },
];

const MANAGER_LAYOUT: LayoutItem[] = [
  { id: "home", phone: true },
  { id: "projects", phone: true },
  { id: "warehouse", phone: true },
  { id: "clock", phone: true },
  { id: "issues" },
  { id: "service" },
  { id: "team" },
  { id: "timecard" },
  { id: "qc" },
  { id: "safety" },
  { id: "learn" },
  { id: "points" },
  { id: "tools" },
];

// Supervisor: the Heartbeat is their home base — it leads the phone bar.
const SUPERVISOR_LAYOUT: LayoutItem[] = [
  { id: "heartbeat", phone: true },
  { id: "home", phone: true },
  { id: "projects", phone: true },
  { id: "clock", phone: true },
  { id: "warehouse" },
  { id: "issues" },
  { id: "service" },
  { id: "team" },
  { id: "timecard" },
  { id: "qc" },
  { id: "safety" },
  { id: "learn" },
  { id: "points" },
  { id: "tools" },
  { id: "cost-codes" },
  { id: "admin" },
];

// Owner: Cost joins the phone bar; Warehouse steps back to More.
const OWNER_LAYOUT: LayoutItem[] = [
  { id: "heartbeat", phone: true },
  { id: "home", phone: true },
  { id: "projects", phone: true },
  { id: "costing", phone: true },
  { id: "clock" },
  { id: "warehouse" },
  { id: "issues" },
  { id: "service" },
  { id: "team" },
  { id: "timecard" },
  { id: "qc" },
  { id: "safety" },
  { id: "learn" },
  { id: "points" },
  { id: "tools" },
  { id: "cost-codes" },
  { id: "admin" },
];

function layoutForRole(role: CrewRole | string | null | undefined): LayoutItem[] {
  const rank = roleRank(role);
  if (rank >= 3) return OWNER_LAYOUT;
  if (rank >= 2) return SUPERVISOR_LAYOUT;
  if (rank >= 1) return MANAGER_LAYOUT;
  return INSTALLER_LAYOUT;
}

export interface NavItem {
  id: string;
  to: RoutePath;
  label: string;
  icon: string;
  minRole: CrewRole;
  phone: boolean;
}

export interface RoleNav {
  /** All visible destinations in order (used for the desktop rail). */
  rail: NavItem[];
  /** Phone bottom-bar destinations. */
  phone: NavItem[];
  /** More-sheet destinations. */
  more: NavItem[];
}

/** Visible destinations for a role, split into rail / phone bar / More. */
export function navForRole(role: CrewRole | string | null | undefined): RoleNav {
  const items: NavItem[] = layoutForRole(role)
    .map((li) => {
      const dest = NAV_BY_ID.get(li.id);
      if (!dest || !canAccess(role, dest.to)) return null;
      return {
        id: dest.id,
        to: dest.to,
        icon: dest.icon,
        minRole: dest.minRole,
        label: li.label ?? dest.label,
        phone: !!li.phone,
      } satisfies NavItem;
    })
    .filter((i): i is NavItem => i !== null);
  return {
    rail: items,
    phone: items.filter((i) => i.phone),
    more: items.filter((i) => !i.phone),
  };
}

/** A titled group of destinations for the desktop/tablet left sidebar. */
export interface RailSection {
  title: string;
  items: NavItem[];
}

/**
 * Desktop/tablet sidebar grouping (Horizon-style sections). On wide screens the
 * left sidebar IS the full menu — every destination the role can reach appears
 * here, grouped, with NO separate "More" overflow bucket. Order defines display
 * order; empty sections (nothing the role can access) are dropped. The phone
 * bottom bar + More sheet still come from navForRole (small-screen behavior).
 */
const RAIL_SECTIONS: { title: string; ids: string[] }[] = [
  { title: "Work", ids: ["home", "my-work", "projects", "warehouse"] },
  { title: "Time", ids: ["clock", "timecard"] },
  { title: "Field", ids: ["scan", "count", "receive", "labels", "supplies", "catalog", "tools"] },
  { title: "Quality & safety", ids: ["qc", "safety", "issues", "service"] },
  { title: "Team", ids: ["team", "crew", "training"] },
  { title: "Insights", ids: ["heartbeat", "analytics", "cost-codes", "costing"] },
  { title: "Learn", ids: ["learn", "points", "review"] },
  { title: "System", ids: ["notifications", "search", "admin"] },
];

/** Installer "/" already lands on My Work; managers read it as Home. */
function railLabel(
  id: string,
  role: CrewRole | string | null | undefined,
  fallback: string,
): string {
  if (id === "home") return roleRank(role) === 0 ? "My Work" : "Home";
  return fallback;
}

/**
 * Grouped destinations for the desktop/tablet left sidebar. Includes every
 * registry destination the role can access (route guards still enforce real
 * authorization), so nothing is hidden behind a desktop overflow menu.
 */
export function railSectionsForRole(
  role: CrewRole | string | null | undefined,
): RailSection[] {
  const installer = roleRank(role) === 0;
  const sections: RailSection[] = [];
  for (const sec of RAIL_SECTIONS) {
    const items: NavItem[] = [];
    for (const id of sec.ids) {
      // Installer Home already IS "My Work" — skip the duplicate entry.
      if (id === "my-work" && installer) continue;
      const dest = NAV_BY_ID.get(id);
      if (!dest || !canAccess(role, dest.to)) continue;
      items.push({
        id: dest.id,
        to: dest.to,
        icon: dest.icon,
        minRole: dest.minRole,
        label: railLabel(id, role, dest.label),
        phone: false,
      });
    }
    if (items.length > 0) sections.push({ title: sec.title, items });
  }
  return sections;
}

// --- Legacy fallback (ROLE_NAV_V2 === false) ---------------------------------

interface LegacyTab {
  id: string;
  to: RoutePath;
  label: string;
  icon: string;
  minRank: number;
  phone?: boolean;
}

const LEGACY_TABS: LegacyTab[] = [
  { id: "home", to: "/", label: "Home", icon: "⌂", minRank: 0, phone: true },
  { id: "my-work", to: "/my-work", label: "Work", icon: "⚒", minRank: 0, phone: true },
  { id: "warehouse", to: "/warehouse", label: "Warehouse", icon: "▦", minRank: 0, phone: true },
  { id: "clock", to: "/clock", label: "Time", icon: "⏱", minRank: 0, phone: true },
  { id: "points", to: "/points", label: "Points", icon: "✦", minRank: 0 },
  { id: "learn", to: "/learn", label: "Learn", icon: "★", minRank: 0 },
  { id: "qc", to: "/qc", label: "Quality", icon: "✓", minRank: 0 },
  { id: "safety", to: "/safety", label: "Safety", icon: "⛑", minRank: 0 },
  { id: "tools", to: "/tools", label: "Tools", icon: "⚙", minRank: 0 },
  { id: "team", to: "/team", label: "Team", icon: "⚑", minRank: 1 },
  { id: "admin", to: "/admin", label: "Admin", icon: "◈", minRank: 2 },
  { id: "costing", to: "/costing", label: "Cost", icon: "$", minRank: 3 },
];

/** Previous flat nav, kept functional for an instant rollback via ROLE_NAV_V2. */
export function legacyNavForRole(role: CrewRole | string | null | undefined): RoleNav {
  const rank = roleRank(role);
  const items: NavItem[] = LEGACY_TABS.filter((t) => rank >= t.minRank).map((t) => ({
    id: t.id,
    to: t.to,
    label: t.label,
    icon: t.icon,
    minRole: "installer" as CrewRole,
    phone: !!t.phone,
  }));
  return {
    rail: items,
    phone: items.filter((i) => i.phone),
    more: items.filter((i) => !i.phone),
  };
}

/** Nav for the active rollout mode. */
export function activeNavForRole(role: CrewRole | string | null | undefined): RoleNav {
  return ROLE_NAV_V2 ? navForRole(role) : legacyNavForRole(role);
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

/** Raw (unfiltered) menu definition — the Horizon Hub structure. */
const MENU_DEF: MenuSection[] = [
  {
    // Flush top group — no header.
    items: [
      { to: "/", label: "Home", Icon: LayoutGrid },
      { to: "/projects", label: "Jobs", Icon: LayoutGrid },
      { to: "/photos", label: "Photos & receipts", Icon: Images },
      { to: "/daily-logs", label: "Daily logs", Icon: NotebookPen },
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
      { to: "/issues", label: "Issues", Icon: AlertTriangle },
      { to: "/service", label: "Service", Icon: Wrench },
      { to: "/qc", label: "Quality", Icon: CheckCircle2 },
    ],
  },
  {
    title: "Company",
    items: [
      { to: "/completed-installs", label: "Completed installs", Icon: CheckCircle2 },
      { to: "/training", label: "Training", Icon: GraduationCap },
      { to: "/milestones", label: "Milestones", Icon: Trophy },
      { to: "/first-pane", label: "First Pane", Icon: Sunrise },
      { to: "/toolbox-history", label: "Toolbox talk history", Icon: ShieldCheck },
      { to: "/team", label: "Team", Icon: Users },
      { to: "/crew", label: "Roster", Icon: Users },
    ],
  },
  {
    title: "Tools",
    items: [
      { to: "/supplies", label: "Materials", Icon: Boxes },
      { to: "/conditions", label: "Conditions", Icon: ClipboardList },
      { to: "/ask", label: "Infinity AI", Icon: Sparkles },
      { to: "/contacts", label: "Contacts", Icon: Contact },
      { to: "/warehouse", label: "Warehouse", Icon: WarehouseIcon },
      { to: "/scan", label: "Scan", Icon: ScanLine },
      { to: "/count", label: "Cycle count", Icon: ListChecks },
      { to: "/catalog", label: "Catalog", Icon: BookOpen },
      { to: "/receive", label: "Receive", Icon: PackageCheck },
      { to: "/labels", label: "Slot labels", Icon: Hash },
      { to: "/search", label: "Search", Icon: Search },
      { to: "/learn", label: "Learn", Icon: BookOpen },
      { to: "/points", label: "Points", Icon: Trophy },
      { to: "/review", label: "Memo review", Icon: ClipboardList },
      { to: "/safety", label: "Safety", Icon: ShieldCheck },
      { to: "/tools", label: "Toolkit", Icon: Wrench },
    ],
  },
  {
    title: "Account",
    items: [
      { to: "/profile", label: "Profile", Icon: User },
      { to: "/notifications", label: "Notifications", Icon: Bell },
      { to: "/settings", label: "Notifications & location", Icon: SlidersHorizontal },
      { to: "/admin", label: "Admin", Icon: ShieldCheck },
      { to: "/public-site", label: "View public site", Icon: Globe, external: false },
    ],
  },
];

/**
 * The grouped Horizon-style menu for a role. Route items are filtered through
 * `canAccess` (same registry the route guards use); action items always show.
 * Empty sections/pills are dropped. Installer "/" reads "My Work"; others
 * "Home".
 */
export function menuForRole(role: CrewRole | string | null | undefined): MenuSection[] {
  const installer = roleRank(role) === 0;
  const out: MenuSection[] = [];
  for (const section of MENU_DEF) {
    const items = section.items
      .filter((it) => (it.to ? canAccess(role, it.to) : true))
      .map((it) =>
        it.to === "/" ? { ...it, label: installer ? "My Work" : "Home" } : it,
      );
    if (items.length === 0) continue;
    out.push({ ...section, items });
  }
  return out;
}
