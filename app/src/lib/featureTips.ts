// First-run micro-tips: tiny, dismissible, per-route hints anchored above the
// bottom nav. "Don't show again" persists per tip in localStorage so a tip
// never nags a returning user.

export interface FeatureTipDef {
  /** Stable key (also the localStorage id). */
  key: string;
  title: string;
  steps: string[];
}

export const FEATURE_TIPS: Record<string, FeatureTipDef> = {
  home: {
    key: "home",
    title: "Your day at a glance",
    steps: [
      "Your jobs and urgent items live here",
      "Tap Capture (+) to add a photo or log",
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
};

/** The tip key to consider for a route, or null if none. */
export function tipKeyForRoute(pathname: string): string | null {
  if (pathname === "/") return "home";
  if (pathname.startsWith("/my-work")) return "my_work";
  if (pathname.startsWith("/projects")) return "projects";
  if (pathname.startsWith("/photos")) return "photos";
  return null;
}

const STORAGE_KEY = "infinity:dismissed-tips";

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
  return readDismissed().has(key);
}

export function dismissTip(key: string): void {
  try {
    const set = readDismissed();
    set.add(key);
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...set]));
  } catch {
    /* ignore storage failures (private mode etc.) */
  }
}
