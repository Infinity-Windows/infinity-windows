// Job modes — the pure rules behind "is this a data job or a lighter tracking
// job", and which hub tabs each one shows (standard-tracking-jobs slice 2).
//
// Kept free of React and Supabase so the tab/route decision can be unit-tested
// directly (jobModes.test.ts) rather than only through a heavy ProjectDetail
// render. ProjectDetail and the route guards read their answers from here, so a
// tracking job hides the same features whether you reach one by tapping a tab or
// by pasting a URL.

import type { JobMode } from "./types";

export type { JobMode } from "./types";

/** Every job that existed before this feature reads as data-only. */
export const DEFAULT_MODES: JobMode[] = ["data"];

const KNOWN: readonly JobMode[] = ["data", "tracking"] as const;

function isJobMode(v: unknown): v is JobMode {
  return v === "data" || v === "tracking";
}

/**
 * Any raw allowed_modes value → a clean, de-duplicated set of known modes.
 * Absent, empty, or all-unknown input reads as data-only, so a row written
 * before the migration (or a garbled one) degrades to today's behaviour rather
 * than to a job with no modes at all.
 */
export function normalizeModes(
  allowed: readonly string[] | null | undefined,
): JobMode[] {
  const set = new Set<JobMode>();
  for (const m of allowed ?? []) if (isJobMode(m)) set.add(m);
  const out = KNOWN.filter((m) => set.has(m)); // stable order: data, tracking
  return out.length > 0 ? [...out] : [...DEFAULT_MODES];
}

/** A subset of {data,tracking}, or null when the caller sent nothing usable —
 * the client-side mirror of set_project_modes's own validation, for the
 * create-job form. */
export function validateModes(
  modes: readonly string[] | null | undefined,
): JobMode[] | null {
  const set = new Set<JobMode>();
  for (const m of modes ?? []) if (isJobMode(m)) set.add(m);
  const out = KNOWN.filter((m) => set.has(m));
  return out.length > 0 ? [...out] : null;
}

export function allowsData(allowed: readonly string[] | null | undefined): boolean {
  return normalizeModes(allowed).includes("data");
}

export function allowsTracking(
  allowed: readonly string[] | null | undefined,
): boolean {
  return normalizeModes(allowed).includes("tracking");
}

/**
 * A tracking-ONLY job: it allows tracking and NOT data. This is the one that
 * gets the lighter tab set and the route guards. A both-mode job still allows
 * data work, so it keeps the full data tabs.
 */
export function isTrackingOnly(
  allowed: readonly string[] | null | undefined,
): boolean {
  const m = normalizeModes(allowed);
  return m.includes("tracking") && !m.includes("data");
}

/**
 * The effective mode for a clock-in: a both-mode job uses the worker's pick; a
 * single-mode job uses its one mode silently; an unknown job records nothing
 * (null) and lets the server default stand.
 */
export function effectiveClockInMode(
  allowed: readonly string[] | null | undefined,
  picked: JobMode | null,
): JobMode | null {
  const m = normalizeModes(allowed);
  if (m.length >= 2) return picked; // both → the pick (may be null until chosen)
  if (m.length === 1) return m[0];
  return null;
}

/** Which catalog key labels a job's mode badge. */
export function modeBadgeKey(
  allowed: readonly string[] | null | undefined,
): "jobmode.badge.data" | "jobmode.badge.tracking" | "jobmode.badge.both" {
  const m = normalizeModes(allowed);
  if (m.includes("data") && m.includes("tracking")) return "jobmode.badge.both";
  if (m.includes("tracking")) return "jobmode.badge.tracking";
  return "jobmode.badge.data";
}

// ---------------------------------------------------------------------------
// Hub tabs
// ---------------------------------------------------------------------------

/** Every tab id the project hub can show. `map` and `model-studio` are
 * transient values a legacy ?tab= link carries before it is redirected; the
 * rest are real tabs. `specs` and `time` are the tracking-only additions. */
export type HubTabId =
  | "overview"
  | "warehouse"
  | "map"
  | "model-studio"
  | "maps-interactive"
  | "brain"
  | "dispatch"
  | "exceptions"
  | "photos"
  | "chat"
  | "logs"
  | "specs"
  | "time";

export interface HubTabOpts {
  trackingOnly: boolean;
  isLead: boolean;
  /** A tracking job shows Warehouse ONLY when it actually has material staged. */
  warehouseStaged: boolean;
}

/**
 * The ordered list of visible tab buttons for a job.
 *
 * A DATA (or both-mode) job's list is EXACTLY what it was before this feature —
 * overview, dispatch, logs, warehouse, chat, photos, maps-interactive,
 * exceptions, brain — so every existing job renders identically.
 *
 * A TRACKING-only job drops the data-heavy tabs (the map, Maps Interactive,
 * Model Studio's entry via brain, dispatch, exceptions) and shows the lighter
 * set: overview, plans & specs, the daily log, photos, chat, time — plus
 * warehouse only when the job actually has packages staged.
 */
export function hubTabsFor(opts: HubTabOpts): HubTabId[] {
  const { trackingOnly, isLead, warehouseStaged } = opts;
  if (trackingOnly) {
    return [
      "overview",
      "specs",
      ...(isLead ? (["logs"] as HubTabId[]) : []),
      "photos",
      "chat",
      "time",
      ...(warehouseStaged ? (["warehouse"] as HubTabId[]) : []),
    ];
  }
  return [
    "overview",
    ...(isLead ? (["dispatch", "logs"] as HubTabId[]) : []),
    "warehouse",
    "chat",
    "photos",
    "maps-interactive",
    ...(isLead ? (["exceptions"] as HubTabId[]) : []),
    "brain",
  ];
}

/**
 * Resolve a `?tab=` value to the tab actually shown. The single choke point for
 * both the tab buttons and the URL guards: a hidden or unknown tab falls back
 * to Overview, so a bookmarked ?tab=maps-interactive (or a lead-only tab a
 * non-lead opened) can never render a feature the job doesn't have.
 *
 * For a DATA job this reproduces the original acceptance list exactly, INCLUDING
 * the transient `map` / `model-studio` values that ProjectDetail's redirect
 * effect turns into real destinations. For a TRACKING job only its own lighter
 * set passes; everything else — the map, the studio, dispatch, the brain — lands
 * on Overview.
 */
export function resolveHubTab(
  tabParam: string | null | undefined,
  opts: HubTabOpts,
): HubTabId {
  const t = tabParam ?? "";
  if (opts.trackingOnly) {
    const visible = hubTabsFor(opts);
    return visible.includes(t as HubTabId) ? (t as HubTabId) : "overview";
  }
  const accept: string[] = [
    "warehouse",
    "map",
    "model-studio",
    "maps-interactive",
    "brain",
    "photos",
    "chat",
    ...(opts.isLead ? ["dispatch", "exceptions", "logs"] : []),
  ];
  return accept.includes(t) ? (t as HubTabId) : "overview";
}
