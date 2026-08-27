import type { ComponentType } from "react";
import {
  Activity,
  AlertTriangle,
  Lightbulb,
  BarChart3,
  Bell,
  BookOpen,
  BrainCircuit,
  Camera,
  CalendarClock,
  CalendarDays,
  CheckCircle2,
  ClipboardList,
  Clock,
  Database,
  DollarSign,
  Hash,
  KeyRound,
  LayoutGrid,
  ListChecks,
  MoreHorizontal,
  PenTool,
  Plane,
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
  | "/jobs/history"
  | "/warehouse"
  | "/clock"
  | "/learn"
  | "/points"
  | "/safety"
  | "/scan"
  | "/studio"
  | "/data"
  | "/storage"
  | "/storage/tag"
  | "/storage/out"
  | "/storage/arrive"
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
  | "/receive"
  | "/warehouse/3d"
  | "/projects/:projectId/model"
  | "/takeoffs"
  | "/labels"
  | "/catalog"
  | "/supplies"
  | "/admin"
  | "/access"
  | "/cost-codes"
  | "/costing"
  // Real Horizon-menu destinations. Eight sibling stubs that never got a menu
  // row (daily logs, completed installs, milestones, First Pane, conditions,
  // contacts, profile, public site) rendered nothing but a "Coming soon"
  // placeholder and were cut as dead ends (ticket 24) — re-add a path here
  // if one of them ever ships for real.
  | "/photos"
  | "/toolbox-history"
  | "/stuck"
  | "/suggestions"
  | "/settings";

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
  // /storage moved down to the foreman block (D6) — it is the container hub,
  // not an installer surface. The two truck-side flows below stay open.
  // Reached from the warehouse page's Going out section, never a menu row.
  { id: "storage-arrive", to: "/storage/arrive", label: "Arrival check", icon: "⬇", minRole: "installer" },
  // In the registry so the access doc and the role tests can SEE them. They
  // behaved correctly before only because the default is "allow" — which
  // means the guard built to catch a wrong gate could not see them at all.
  // Reached from the warehouse page's sections, never as menu rows.
  { id: "storage-tag", to: "/storage/tag", label: "Tag packages", icon: "▧", minRole: "installer" },
  { id: "storage-out", to: "/storage/out", label: "Set aside / check out", icon: "▧", minRole: "installer" },
  // The 3D map viewer (ticket 22). Reached from a package's sheet and a
  // container's page, never as a menu row.
  { id: "warehouse-3d", to: "/warehouse/3d", label: "Container in 3D", icon: "▧", minRole: "installer" },
  // The phone-friendly JOB model viewer (Studio 100x #27) — same read-only
  // pattern as the container viewer above, pointed at a job's Studio model.
  // Reached from the Maps Interactive tab's "Walk the 3D model" button,
  // never as a menu row.
  { id: "job-model", to: "/projects/:projectId/model", label: "Walk the 3D model", icon: "▧", minRole: "installer" },
  // Takeoffs: installers see the bundles built FOR them; reached from the
  // warehouse page's Supplies section.
  { id: "takeoffs", to: "/takeoffs", label: "Takeoffs", icon: "▤", minRole: "installer" },
  { id: "warehouse", to: "/warehouse", label: "Warehouse", icon: "▦", minRole: "installer" },
  { id: "projects", to: "/projects", label: "Jobs", icon: "▤", minRole: "installer" },
  // Finished/cancelled jobs with everything they tracked (owner, 2026-08-26).
  { id: "job-history", to: "/jobs/history", label: "Job history", icon: "▤", minRole: "supervisor" },
  { id: "studio", to: "/studio", label: "Studio", icon: "◧", minRole: "supervisor" },
  // The company's ledger of where time goes (grilled 2026-08-17):
  // supervisor+ ONLY — on-tool and per-person time live here.
  { id: "data", to: "/data", label: "Data", icon: "▤", minRole: "supervisor" },
  { id: "ask", to: "/ask", label: "Ask", icon: "?", minRole: "installer" },
  { id: "notifications", to: "/notifications", label: "Notifications", icon: "◔", minRole: "installer" },
  // Installer floor, deliberately — NOT foreman as first recommended. The
  // outbox is IndexedDB, so a phone only ever holds ITS OWN stuck writes.
  // Gating this to leads would leave an installer's stranded clock punch
  // invisible and unfixable on the one device it exists on, which is the
  // exact failure the screen was built to end.
  { id: "stuck", to: "/stuck", label: "Stuck writes", icon: "⚠", minRole: "installer" },
  { id: "suggestions", to: "/suggestions", label: "Suggestions", icon: "💡", minRole: "installer" },
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
  { id: "receive", to: "/receive", label: "Receive", icon: "⬇", minRole: "foreman" },
  // /storage used to be the container hub's own foreman+ address (D6); it
  // merged into /warehouse (ticket 18) and the route is now a bare redirect,
  // same as /search below. Kept in the registry (unchanged minRole) so old
  // links/bookmarks still resolve to a real entry instead of an unknown path,
  // and so this floor stays test-pinned the way it always was.
  { id: "storage", to: "/storage", label: "Storage", icon: "▧", minRole: "foreman" },
  { id: "labels", to: "/labels", label: "Slot labels", icon: "❏", minRole: "foreman" },
  { id: "catalog", to: "/catalog", label: "Catalog", icon: "❒", minRole: "foreman" },
  // Installers, not foreman+: the whole point of ticket 07 is that an
  // installer finds the caulk and logs what they took, three taps, no list.
  // Ticket 08 puts a Supplies section on their warehouse page, and a section
  // whose button lands on "Not available for your role" is worse than no
  // section. The page still scopes ITSELF — setting a home spot is foreman+,
  // and set_supply_home enforces that server-side regardless.
  { id: "supplies", to: "/supplies", label: "Supplies", icon: "⛃", minRole: "installer" },

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

  // Two real Horizon-menu destinations. Access still flows through this
  // registry so role-gating never drifts. Eight sibling stub entries (daily
  // logs, completed installs, milestones, First Pane, conditions, contacts,
  // profile, public site) were cut as dead ends — see the RoutePath comment
  // above (ticket 24).
  { id: "photos", to: "/photos", label: "Photos & receipts", icon: "▨", minRole: "installer" },
  { id: "toolbox-history", to: "/toolbox-history", label: "Toolbox talk history", icon: "⛑", minRole: "installer" },
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
      // canAccess gates this to supervisor+ (owner ask, 2026-08-26).
      { to: "/jobs/history", label: "Job history", Icon: LayoutGrid },
      { to: "/studio", label: "Studio", Icon: PenTool },
      { to: "/data", label: "Data", Icon: Database },
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
  // ONE row (warehouse ticket 08). The eight that lived here were the visible
  // symptom of two location models: no single screen could answer "where is
  // it", so the question was spread across eight. With one model, /warehouse
  // holds the whole job — tagging, storing, checking out, supplies, problems —
  // and its actions open over the page instead of navigating. The old
  // destinations all still exist as routes (deep links, the page's own
  // buttons, the "Other tools" fold); they simply stopped needing menu rows.
  // Catalog moved to Account: importing window types is data admin, not
  // warehouse work.
  {
    title: "Warehouse",
    pill: true,
    collapsible: true,
    Icon: WarehouseIcon,
    items: [{ to: "/warehouse", label: "Warehouse", Icon: WarehouseIcon }],
  },
  {
    title: "Problems & quality",
    pill: true,
    collapsible: true,
    Icon: AlertTriangle,
    items: [
      { to: "/issues", label: "Issues", Icon: AlertTriangle },
      { to: "/service", label: "Service", Icon: Wrench },
      { to: "/qc", label: "Quality", Icon: CheckCircle2 },
    ],
  },
  {
    title: "Fleet",
    pill: true,
    collapsible: true,
    Icon: Truck,
    items: [
      { to: "/scheduling", label: "Scheduling", Icon: CalendarDays },
      { to: "/vehicles", label: "Vehicles", Icon: Truck },
      { to: "/my-schedule", label: "My Schedule", Icon: CalendarClock },
      { to: "/travel", label: "Travel", Icon: Plane },
    ],
  },
  {
    title: "People",
    pill: true,
    collapsible: true,
    Icon: Users,
    items: [
      { to: "/team", label: "Team", Icon: Users },
      { to: "/crew", label: "Roster", Icon: Users },
      { to: "/access", label: "Crew access", Icon: KeyRound },
    ],
  },
  {
    title: "Learning",
    pill: true,
    collapsible: true,
    Icon: BookOpen,
    items: [
      { to: "/learn", label: "Learn", Icon: BookOpen },
      { to: "/points", label: "Points", Icon: Trophy },
      { to: "/review", label: "Memo review", Icon: ClipboardList },
      { to: "/safety", label: "Safety", Icon: ShieldCheck },
    ],
  },
  {
    title: "AI",
    pill: true,
    collapsible: true,
    Icon: Sparkles,
    items: [
      { to: "/ask", label: "Ask", Icon: Sparkles },
      { to: "/knowledge", label: "AI Knowledge", Icon: BrainCircuit },
      { to: "/ai-spend", label: "AI spend", Icon: DollarSign },
    ],
  },
  {
    title: "Account",
    pill: true,
    collapsible: true,
    Icon: SlidersHorizontal,
    items: [
      { to: "/notifications", label: "Notifications", Icon: Bell },
      { to: "/suggestions", label: "Suggestions", Icon: Lightbulb },
      { to: "/stuck", label: "Stuck writes", Icon: AlertTriangle },
      { to: "/settings", label: "Settings", Icon: SlidersHorizontal },
      // Importing window types is data admin, not warehouse work (ticket 08).
      { to: "/catalog", label: "Catalog", Icon: BookOpen },
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
  // An installer's own stranded punch lives on their own phone; the drawer is
  // the only way they would ever reach it.
  "/stuck",
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
