// First-run micro-tips: tiny, dismissible, per-route hints anchored above the
// bottom nav. "Don't show again" persists per tip in localStorage so a tip
// never nags a returning user.

import { roleRank, type CrewRole } from "./install/types";

export interface FeatureTipDef {
  /** Stable key (also the localStorage id). */
  key: string;
  title: string;
  steps: string[];
}

export const FEATURE_TIPS: Record<string, FeatureTipDef> = {
  // Managers land on the day Home and have the center Capture (+) button.
  home: {
    key: "home",
    title: "Your day at a glance",
    steps: [
      "Your jobs and urgent items live here",
      "Tap Capture (+) to add a photo or log",
      "Tap Clock to start your shift",
    ],
  },
  // Installers land on My Work and have no Capture (+) — Scan and Ask instead.
  home_installer: {
    key: "home_installer",
    title: "Your day at a glance",
    steps: [
      "Your ready-now work lives here",
      "Tap Scan to check parts in and out",
      "Tap Ask for specs, how-tos & answers",
      "Tap Clock to start your shift",
    ],
  },
  my_work: {
    key: "my_work",
    title: "My Work",
    steps: [
      "See the openings assigned to you",
      "Tap one to open its install details",
      "Mark progress right from the field",
    ],
  },
  projects: {
    key: "projects",
    title: "Jobs",
    steps: [
      "Browse every active job here",
      "Tap a job for plans, photos & details",
      "Use Directions to navigate to site",
    ],
  },
  photos: {
    key: "photos",
    title: "Photos & receipts",
    steps: [
      "Capture photos and receipts on site",
      "Assign each one to the right job",
      "Everything stays with the project",
    ],
  },
  chat: {
    key: "chat",
    title: "Job chat",
    steps: [
      "Message the whole crew on this job",
      "@mention someone to ping them directly",
      "Photos and updates stay with the job",
    ],
  },
  schedule: {
    key: "schedule",
    title: "My Schedule",
    steps: [
      "See where you're booked, day by day",
      "Tap a day for crew and job details",
      "Check for changes before you head out",
    ],
  },
  travel: {
    key: "travel",
    title: "Travel",
    steps: [
      "Flights, hotels and drive plans for out-of-town jobs",
      "Tap a trip for times, addresses and who's going",
      "Directions and details stay in one place",
    ],
  },
};

/**
 * The tip key to consider for a route, or null if none. The landing "/" tip is
 * role-aware: installers (no Capture button) get the Scan + Ask variant.
 */
export function tipKeyForRoute(
  pathname: string,
  role?: CrewRole | string | null,
): string | null {
  if (pathname === "/") return roleRank(role) === 0 ? "home_installer" : "home";
  if (pathname.startsWith("/my-work")) return "my_work";
  if (pathname.startsWith("/projects")) return "projects";
  if (pathname.startsWith("/photos")) return "photos";
  if (pathname.startsWith("/chat")) return "chat";
  if (pathname.startsWith("/my-schedule")) return "schedule";
  if (pathname.startsWith("/travel")) return "travel";
  return null;
}

const STORAGE_KEY = "infinity:dismissed-tips";

/**
 * Session-scoped memory of hidden tips. This is what makes dismissal reliable:
 * "Skip" lives only here (gone next launch, quiet for the rest of today), and
 * "Don't show again" writes here FIRST so that a phone whose localStorage is
 * broken or evicted (iOS private mode, storage pressure) still stays quiet for
 * the whole session instead of nagging on every route change.
 */
const sessionHidden = new Set<string>();

/**
 * A tip is one idea even when it has role variants: dismissing the landing tip
 * as an owner must also silence the installer variant, or anyone who uses
 * "view as role" sees the same-looking tip come back forever.
 */
const TIP_ALIASES: Record<string, string[]> = {
  home: ["home", "home_installer"],
  home_installer: ["home", "home_installer"],
};

function variantsOf(key: string): string[] {
  return TIP_ALIASES[key] ?? [key];
}

function readDismissed(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as unknown;
    return Array.isArray(arr) ? new Set(arr.filter((x): x is string => typeof x === "string")) : new Set();
  } catch {
    return new Set();
  }
}

export function isTipDismissed(key: string): boolean {
  if (sessionHidden.has(key)) return true;
  return readDismissed().has(key);
}

/** "Skip": quiet for the rest of this session, back next launch. */
export function skipTip(key: string): void {
  for (const k of variantsOf(key)) sessionHidden.add(k);
}

export function dismissTip(key: string): void {
  for (const k of variantsOf(key)) sessionHidden.add(k);
  try {
    const set = readDismissed();
    for (const k of variantsOf(key)) set.add(k);
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...set]));
  } catch {
    /* Storage failures (private mode etc.): sessionHidden above still keeps
       this session quiet, which is the best a client can do. */
  }
}

/** Test hook: forget session-scoped hides. */
export function resetSessionTips(): void {
  sessionHidden.clear();
}
