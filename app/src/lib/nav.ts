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
  | "/costing";

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
