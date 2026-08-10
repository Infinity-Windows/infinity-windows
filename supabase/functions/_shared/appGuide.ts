// Role-aware "app guide": a plain-English "what it is + how to use it" blurb for
// every tab/destination in the app, plus the minimum role that can reach it.
//
// This mirrors the canonical nav registry in app/src/lib/nav.ts (each NavDest's
// `to` + `minRole`). It is duplicated here — rather than imported — because the
// Edge Functions run under Deno and cannot import the React nav module (it pulls
// in lucide-react/JSX). A vitest guard (app/src/lib/appGuide.test.ts) cross-checks
// this table against the real NAV so the two can never silently drift.
//
// Like _shared/knowledge.ts, this module is intentionally import-free and touches
// no Deno / DOM / Node globals, so it type-checks and runs identically in every
// environment (Deno edge fn, Vite client, vitest) and stays testable.

export type GuideRole = "installer" | "foreman" | "supervisor" | "owner";

export interface AppGuideEntry {
  /** Registry path (matches nav `to`). */
  path: string;
  /** Human label as it appears in the menu/nav. */
  label: string;
  /** Minimum role that may see/reach this destination (matches nav `minRole`). */
  minRole: GuideRole;
  /** Short "what it is + how to use it" blurb for the AI to explain the tab. */
  blurb: string;
}

const RANK: Record<GuideRole, number> = {
  installer: 0,
  foreman: 1,
  supervisor: 2,
  owner: 3,
};

/**
 * Rank a role for a single `>=` access comparison. Mirrors `roleRank` in
 * app/src/lib/install/types.ts EXACTLY — including the legacy aliases
 * (lead→foreman, admin→supervisor, big_boss→owner) — so nav, route guards and
 * this guide can never disagree on an unknown/legacy role. Unknown/null → 0
 * (installer floor) so a missing/legacy profile can never over-expose.
 */
export function guideRank(role?: string | null): number {
  switch (role) {
    case "owner":
    case "big_boss":
      return 3;
    case "supervisor":
    case "admin":
      return 2;
    case "foreman":
    case "lead":
      return 1;
    case "installer":
      return 0;
    default:
      return 0;
  }
}

/**
 * The full app guide, one entry per navigable destination, ordered roughly by
 * how a crew member moves through the app (daily loop first, then manager and
 * office tools). `minRole` mirrors the nav registry so filtering here matches
 * what a role can actually reach in the UI.
 */
export const APP_GUIDE: AppGuideEntry[] = [
  // ---- Open to everyone (installer floor): the daily job loop -------------
  {
    path: "/",
    label: "Home",
    minRole: "installer",
    blurb:
      "Your day at a glance — clock in/out, the term of the day, your active install, points and your jobs. Start here each morning.",
  },
  {
    path: "/my-work",
    label: "My Work",
    minRole: "installer",
    blurb:
      "Your personal install queue — the next ready window/door is at the top. Tap an item to open its sheet, then start the install; finish one and the next moves up.",
  },
  {
    path: "/clock",
    label: "Time",
    minRole: "installer",
    blurb:
      "Clock in and out and pick the cost code you're working under. Use it at the start/end of the day and when you switch tasks so your hours land on the right job.",
  },
  {
    path: "/learn",
    label: "Learn",
    minRole: "installer",
    blurb:
      "The window/door glossary and daily practice drills. Look up a term or a type, or run a quick quiz to sharpen up between jobs.",
  },
  {
    path: "/points",
    label: "Points",
    minRole: "installer",
    blurb:
      "Your score and tier. Points release after QC sign-off on your installs — check here to see where you stand and what's pending.",
  },
  {
    path: "/safety",
    label: "Safety",
    minRole: "installer",
    blurb:
      "Toolbox talks and safety guidance. Read the current talk and acknowledge it; a foreman may ask the crew to review one before starting.",
  },
  {
    path: "/scan",
    label: "Scan",
    minRole: "installer",
    blurb:
      "Scan a window/door QR or slot label to pull up that unit or location. Use it to find a unit, confirm what's in a slot, or move/stage units in the warehouse.",
  },
  {
    path: "/count",
    label: "Cycle count",
    minRole: "installer",
    blurb:
      "Count what's actually in a warehouse slot vs. what the system expects. Scan the slot, count the units, and log any discrepancy so stock stays accurate.",
  },
  {
    path: "/warehouse",
    label: "Warehouse",
    minRole: "installer",
    blurb:
      "The warehouse hub — find/scan/receive units, see slot addresses, and pull per-job pick lists. Use it to locate units and see where stock lives.",
  },
  {
    path: "/projects",
    label: "Jobs",
    minRole: "installer",
    blurb:
      "The job list. Open a job to see its plan and map; tap a unit dot (blue = window, green = door) to open its sheet, then assign it to yourself and start.",
  },
  {
    path: "/ask",
    label: "Ask",
    minRole: "installer",
    blurb:
      "That's me — Infinity AI. Ask about jobs, schedules, a window type, where a unit is, or how to use any part of the app. I answer from company notes and live data you're allowed to see.",
  },
  {
    path: "/notifications",
    label: "Notifications",
    minRole: "installer",
    blurb:
      "Your alerts — schedule changes, mentions in job chat, and assignments. Check it to stay on top of what changed.",
  },
  {
    path: "/search",
    label: "Search",
    minRole: "installer",
    blurb:
      "Search across units, jobs and locations. Type a code or name to jump straight to what you're looking for.",
  },
  {
    path: "/review",
    label: "Memo review",
    minRole: "installer",
    blurb:
      "Review and confirm the voice memo transcribed after your install. Fix anything mis-heard so the install record and tips stay accurate.",
  },
  {
    path: "/my-schedule",
    label: "My Schedule",
    minRole: "installer",
    blurb:
      "Your published schedule — which job you're on which days, your start time, crewmates, and the truck/travel tied to it. Read-only; the office sets it.",
  },
  {
    path: "/travel",
    label: "Travel",
    minRole: "installer",
    blurb:
      "Out-of-town trip details tied to your jobs — destination, dates and who's going. Check it when a job needs travel.",
  },
  {
    path: "/photos",
    label: "Photos & receipts",
    minRole: "installer",
    blurb:
      "Job photos and receipts. Attach proof photos to an install or upload a receipt against a job.",
  },
  {
    path: "/completed-installs",
    label: "Completed installs",
    minRole: "installer",
    blurb: "A history of installs you've finished. Look back at what's done.",
  },
  {
    path: "/milestones",
    label: "Milestones",
    minRole: "installer",
    blurb: "Job progress milestones — see how far along a job is.",
  },
  {
    path: "/first-pane",
    label: "First Pane",
    minRole: "installer",
    blurb: "Onboarding / getting-started guidance for new crew.",
  },
  {
    path: "/toolbox-history",
    label: "Toolbox talk history",
    minRole: "installer",
    blurb: "Past safety toolbox talks and who acknowledged them.",
  },
  {
    path: "/profile",
    label: "Profile",
    minRole: "installer",
    blurb: "Your profile — name, skill level and account details.",
  },
  {
    path: "/settings",
    label: "Settings",
    minRole: "installer",
    blurb: "App settings and preferences for your account and device.",
  },
  {
    path: "/public-site",
    label: "View public site",
    minRole: "installer",
    blurb: "Opens the company's public website.",
  },

  // ---- Foreman+ (managers): coordination, warehouse ops, quality ----------
  {
    path: "/team",
    label: "Team",
    minRole: "foreman",
    blurb:
      "Coordinate the crew on a job — assign openings to installers, set the walk order, and see who's on what. Use it to dispatch work and balance the crew.",
  },
  {
    path: "/timecard",
    label: "Timecard",
    minRole: "installer",
    blurb:
      "Your hours, week by week. Installers see their own timecard read-only; foreman and up also review, adjust, and approve the whole crew's hours by cost code before payroll export.",
  },
  {
    path: "/issues",
    label: "Issues",
    minRole: "foreman",
    blurb:
      "Open problems and blockers across jobs — damage, missing parts, site issues. Triage, assign, and close them as they're resolved.",
  },
  {
    path: "/service",
    label: "Service",
    minRole: "foreman",
    blurb:
      "Post-install service/warranty cases. Log a callback, track it, and close it out when the fix is done.",
  },
  {
    path: "/qc",
    label: "Quality",
    minRole: "foreman",
    blurb:
      "Quality-control sign-off on completed installs. Review the install and photos, then pass or flag it — points release to the installer on a pass.",
  },
  {
    path: "/analytics",
    label: "Analytics",
    minRole: "foreman",
    blurb:
      "Operational dashboards — install throughput, quality and productivity trends. Use it to spot where things are slowing down.",
  },
  {
    path: "/crew",
    label: "Roster",
    minRole: "foreman",
    blurb:
      "The people roster — crew members, roles and skill levels. Use it to see who's available and how skilled they are.",
  },
  {
    path: "/training",
    label: "Training",
    minRole: "foreman",
    blurb:
      "Training modules and how-to content. Assign or review training to bring crew up to speed on a type or technique.",
  },
  {
    path: "/receive",
    label: "Receive",
    minRole: "foreman",
    blurb:
      "Receive an incoming delivery — log the units in, then put them away to a slot. Use it when a truck of windows/doors arrives.",
  },
  {
    path: "/labels",
    label: "Slot labels",
    minRole: "foreman",
    blurb:
      "Print QR labels for warehouse slots. Use it when setting up or relabeling storage locations.",
  },
  {
    path: "/catalog",
    label: "Catalog",
    minRole: "foreman",
    blurb:
      "The window/door type catalog — codes, sizes, difficulty and saved install tips. Browse or edit type details here.",
  },
  {
    path: "/supplies",
    label: "Supplies",
    minRole: "foreman",
    blurb:
      "Consumable supplies (tape, shims, sealant). See what's outstanding, mark items needed, and track orders.",
  },
  {
    path: "/daily-logs",
    label: "Daily logs",
    minRole: "foreman",
    blurb: "Daily job logs — a running record of what happened on site each day.",
  },
  {
    path: "/conditions",
    label: "Conditions",
    minRole: "foreman",
    blurb: "Site/opening condition reports — flag and track field conditions.",
  },
  {
    path: "/contacts",
    label: "Contacts",
    minRole: "foreman",
    blurb: "Job and vendor contacts — phone numbers and points of contact.",
  },

  // ---- Supervisor+ --------------------------------------------------------
  {
    path: "/knowledge",
    label: "AI Knowledge",
    minRole: "supervisor",
    blurb:
      "Manage what Infinity AI knows — upload/refresh the company Obsidian vault notes that ground my answers. PIN-gated.",
  },
  {
    path: "/scheduling",
    label: "Scheduling",
    minRole: "supervisor",
    blurb:
      "Build the crew schedule — assign foremen/installers to jobs over date ranges, then publish to push it to everyone's My Schedule.",
  },
  {
    path: "/vehicles",
    label: "Vehicles",
    minRole: "supervisor",
    blurb:
      "The fleet — trucks and machinery, service due dates, and which vehicle is tied to which schedule. Use it to keep the fleet serviced and assigned.",
  },
  {
    path: "/heartbeat",
    label: "Heartbeat",
    minRole: "supervisor",
    blurb:
      "A company-wide health/status overview. Use it for a quick read on how the whole operation is running.",
  },
  {
    path: "/admin",
    label: "Admin",
    minRole: "supervisor",
    blurb:
      "Account administration — approve users, set roles, and manage access. Use it to onboard crew and control permissions.",
  },
  {
    path: "/access",
    label: "Crew access",
    minRole: "supervisor",
    blurb:
      "Add a new crew member yourself: pick their name and what they can do, then text them a one-time code that sets up their login. Also where you cancel a code, send someone a fresh one if they forget their password, and switch off access for anyone who leaves.",
  },
  {
    path: "/cost-codes",
    label: "Cost codes",
    minRole: "supervisor",
    blurb:
      "The cost-code library that time and costs are booked against. Manage the codes crews clock into.",
  },

  // ---- Owner only ---------------------------------------------------------
  {
    path: "/costing",
    label: "Cost",
    minRole: "owner",
    blurb:
      "Job costing and margin — bids/revenue, the cost ledger, change orders and computed margin per job. Owner-only financial view.",
  },
  {
    path: "/ai-spend",
    label: "AI spend",
    minRole: "owner",
    blurb:
      "What the AI assistant costs, and the limits that stop it running away — spend so far this month, who is using it, the per-person daily allowance and the company ceiling. Owner-editable.",
  },
];

/**
 * How the AI may surface open issues, matching the in-app Issues gate.
 * - "company": the whole open-issues list (foreman+, who can open the Issues tab).
 * - "own-jobs": only issues on jobs the user is on (installers — they can't open
 *   the tab, so they must never receive company-wide issues).
 * - "none": nothing to show (an installer who is on no jobs).
 */
export type IssuesScope = "company" | "own-jobs" | "none";

/** Decide an asking user's issues scope from their role and how many jobs
 * they're on. Foreman+ (rank ≥ 1) → company-wide; installers → own jobs only. */
export function issuesScopeForRole(
  role: string | null | undefined,
  onJobCount: number,
): IssuesScope {
  if (guideRank(role) >= 1) return "company";
  return onJobCount > 0 ? "own-jobs" : "none";
}

/** Filter the guide to the destinations a role can actually reach. */
export function appGuideForRole(role?: string | null): AppGuideEntry[] {
  const rank = guideRank(role);
  return APP_GUIDE.filter((e) => rank >= RANK[e.minRole]);
}

/**
 * Render a role-filtered guide as a compact, clearly-labelled text block for the
 * grounding context. One line per tab: "Label (path): blurb". Returns "" when the
 * list is empty so callers can omit the section entirely.
 */
export function renderAppGuide(entries: AppGuideEntry[]): string {
  if (entries.length === 0) return "";
  return entries.map((e) => `- ${e.label} (${e.path}): ${e.blurb}`).join("\n");
}
