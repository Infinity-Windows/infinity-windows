import type { Project, WindowType, WindowUnit } from "../types";

export type PlansetFormat = "pdf" | "dwg" | "dxf";
/** Building = floor drawings for the map; specs = schedule (mark → size/type). */
export type PlansetKind = "building" | "specs";
export type PlansetStatus =
  | "uploaded"
  | "converting"
  | "extracting"
  | "ready"
  | "failed";

export interface Planset {
  id: string;
  project_id: string;
  storage_path: string;
  source_format: PlansetFormat;
  converted_pdf_path: string | null;
  page_count: number | null;
  status: PlansetStatus;
  kind: PlansetKind;
  created_at: string;
}

/** Hand-traced building outline for one planset page (normalized 0–1 coords). */
export interface PlanOutline {
  id: string;
  project_id: string;
  planset_id: string;
  page_number: number;
  points: { x: number; y: number }[];
  page_aspect: number;
  /** CAD-lite extras: divider lines + wall openings (see lib/install/cad.ts). */
  features: unknown;
  created_at: string;
  updated_at: string;
}

/**
 * Where one mark is drawn on an exterior elevation sheet — a REFERENCE, never
 * an opening. See supabase/migrations/…_mark_elevation_views.sql: an elevation
 * re-draws windows the floor plan already numbered, so these rows exist to show
 * a crew where a window sits on the building and are counted by nothing.
 */
export interface MarkElevationView {
  id: string;
  project_id: string;
  /** Building planset the coordinates were measured against. */
  planset_id: string | null;
  mark_code: string;
  page_number: number;
  /** Which captioned drawing on that page, 0-based top to bottom. */
  region_index: number;
  /** The sheet's own caption, verbatim, or null when it never named the view. */
  view_name: string | null;
  pin_x: number;
  pin_y: number;
  label_w: number | null;
  label_h: number | null;
  /** Normalized [x0,y0,x1,y1] of the drawing region to crop. */
  crop_bbox: unknown;
}

/**
 * Map pin identity color: window vs door (status is a separate ring/badge).
 * Reads index.css's --kind-window/--kind-door (wave I-1, pick 2) — every
 * consumer sets these as a DOM style/custom-property value (MapPinLayer,
 * OpeningDetailCard, ProjectMap, PlanModelEditor; none paints to canvas), so
 * a CSS variable string works everywhere a literal hex used to.
 */
export const OPENING_KIND_COLORS = {
  window: "var(--kind-window)",
  door: "var(--kind-door)",
} as const;

export type OpeningStatus = "planned" | "assigned" | "installed";
export type OpeningCondition = "unknown" | "ok" | "damaged";
export type CrewRole = "installer" | "foreman" | "supervisor" | "owner";

export const ROLE_LABELS: Record<CrewRole, string> = {
  installer: "Installer",
  foreman: "Foreman",
  supervisor: "Supervisor",
  owner: "Owner",
};

/**
 * The role WORD one person is allowed to see on another (owner ask,
 * 2026-08-26): owners are visible as owners only to other owners — everyone
 * below sees "supervisor" instead. Display-layer disguise; the server-side
 * half (only owners CHANGE owners) lives in set_profile_role and the
 * profiles role trigger. A viewer's own-role greeting never routes through
 * this — you always know what you are.
 */
export function visibleRole<T extends CrewRole | string | null | undefined>(
  target: T,
  viewer: CrewRole | string | null | undefined,
): T | "supervisor" {
  if (target === "owner" && !isOwner(viewer)) return "supervisor";
  return target;
}

/**
 * ONE role-rank source of truth. Rank roles so access is a single `>=`
 * comparison. Unknown/null defaults to installer-min (0) so a missing/legacy
 * profile can never over-expose. Legacy names are mapped: lead -> foreman(1),
 * admin -> supervisor(2), big_boss -> owner(3). nav.ts imports this so nav,
 * route guards, and page-level gating can never disagree on unknown/legacy roles.
 */
export function roleRank(role?: CrewRole | string | null): number {
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
 * Foreman-level privileges: anyone above a plain installer. Derived from
 * roleRank so an unknown/legacy role can never disagree with the nav/guards.
 */
export function isForemanPlus(role?: CrewRole | string | null): boolean {
  return roleRank(role) >= 1;
}
/** Supervisor-level: manage accounts/approvals (was admin). */
export function isSupervisorPlus(role?: CrewRole | string | null): boolean {
  return roleRank(role) >= 2;
}
/** Owner: full data / costing / margin visibility (was big_boss). */
export function isOwner(role?: CrewRole | string | null): boolean {
  return roleRank(role) >= 3;
}

export interface Profile {
  id: string;
  display_name: string;
  skill_level: number;
  role: CrewRole;
  active: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface ProjectOpening {
  id: string;
  project_id: string;
  planset_id: string | null;
  opening_code: string;
  window_type_id: string | null;
  label: string | null;
  page_number: number;
  pin_x: number | null;
  pin_y: number | null;
  /**
   * Where the planset extraction put this mark. Seeded once and then immutable
   * in the database, so dragging the dot can always be walked back.
   * Null on rows created before 20260730130000 on a job with no pin.
   */
  origin_pin_x?: number | null;
  origin_pin_y?: number | null;
  origin_page_number?: number | null;
  /**
   * Vision placement's guess (wave V-A): a suggested pin, twin-shaped to
   * pin_x/pin_y/page_number but never read by the live map — only a
   * foreman confirming it in the trace tool promotes it to a real pin.
   * Cleared once confirmed or dismissed. Null on rows from before
   * 20260961000000, and on any job that has never run Find placements.
   */
  suggested_pin_x?: number | null;
  suggested_pin_y?: number | null;
  suggested_page_number?: number | null;
  suggested_at?: string | null;
  suggested_confidence?: number | null;
  assigned_window_id: string | null;
  status: OpeningStatus;
  confirmed: boolean;
  created_at: string;
  ro_width_in: number | null;
  ro_height_in: number | null;
  ro_measured_by: string | null;
  ro_measured_at: string | null;
  /**
   * The saved rough-opening checklist (taps + every measured point), so a
   * revisit shows exactly what was judged and a fixer can flip Bad back to
   * Good. Optional: arrives with 20260811040000.
   */
  ro_check?: {
    judgments?: Record<string, "good" | "bad" | null>;
    diagonals?: (string | number | null)[];
    widths?: (string | number | null)[];
    heights?: (string | number | null)[];
  } | null;
  /**
   * "Quick check: all good" — one tap saying somebody looked at the opening,
   * held the unit to it, and it goes in, with no tape numbers written down
   * (owner, 2026-09-02). Weaker than a measurement on purpose: only read when
   * ro_width_in / ro_height_in are null, and cleared by the server the moment
   * real numbers are saved. Optional: the column arrives with 20260966000000,
   * so an older row reads as absent, which is the same as "no quick check".
   */
  ro_quick_ok?: boolean | null;
  condition: OpeningCondition;
  condition_note: string | null;
  condition_checked_by: string | null;
  condition_checked_at: string | null;
  assigned_to: string | null;
  assigned_by: string | null;
  assigned_at: string | null;
  sequence: number | null;
  /**
   * Envelope prep gate: true (the default — "yes is the default, no is the
   * change") means a submitted flashing phase must exist before the install
   * may start. Optional because the column arrives with 20260811000000;
   * absent reads as "no gate" so an unmigrated database changes nothing.
   */
  needs_flashing?: boolean | null;
  /** Stored cohort signature key (spec .scratch/signature) — server-written
   * via set_unit_signature only. */
  sig_key?: string | null;
  signature?: unknown;
  work_started_at: string | null;
  work_ended_at: string | null;
  flag_note: string | null;
  flagged_by: string | null;
  flagged_at: string | null;
  /**
   * Set when a foreman removes this window or door. Rows carrying it are hidden
   * by row level security, so anything reached from a browser only ever sees
   * null here — the field exists for the removed list, which reads them through
   * a `security definer` function on purpose.
   */
  removed_at?: string | null;
  window_types?: WindowType | null;
  windows?: WindowUnit | null;
  projects?: Project | null;
  assignee?: Profile | null;
}

/**
 * One window or door a foreman has taken off a job. Nothing about it was
 * deleted — this is what `list_removed_openings` hands back so it can be put
 * back again.
 */
export interface RemovedOpening {
  id: string;
  opening_code: string;
  label: string | null;
  window_type_id: string | null;
  status: OpeningStatus;
  removed_at: string;
  removed_by: string | null;
  removed_by_name: string | null;
  removed_reason: string | null;
  /** Its code has since been taken by a live mark, so it cannot come back yet. */
  code_taken: boolean;
}

/** Topic fields match vault/_schemas/install-memo-topics.md, in order. */
export interface MemoTopics {
  difficulty: string | null;
  went_well: string | null;
  went_poorly: string | null;
  obstacles: string | null;
  tools_helped: string | null;
  time_vs_estimate: string | null;
  safety_notes: string | null;
  do_again: string | null;
}

export interface InstallEvent extends MemoTopics {
  id: string;
  project_opening_id: string;
  window_id: string | null;
  window_type_id: string | null;
  installer: string | null;
  started_at: string | null;
  minutes: number | null;
  quality_grade: number | null;
  transcript_raw: string | null;
  created_at: string;
  voided_at: string | null;
  void_reason: string | null;
  voided_by: string | null;
}

export const MEMO_TOPICS: { key: keyof MemoTopics; prompt: string }[] = [
  { key: "difficulty", prompt: "Difficulty / how it felt" },
  { key: "went_well", prompt: "What went well" },
  { key: "went_poorly", prompt: "What didn't go well" },
  { key: "obstacles", prompt: "Obstacles" },
  { key: "tools_helped", prompt: "Tools / materials that helped" },
  { key: "time_vs_estimate", prompt: "Time estimate vs actual" },
  { key: "safety_notes", prompt: "Safety notes" },
  { key: "do_again", prompt: "What we'd do again next time" },
];

/** Reads index.css's --st-planned/--st-assigned/--st-installed (wave I-1,
 * pick 2) — same DOM-style-only consumers as OPENING_KIND_COLORS above. */
export const OPENING_STATUS_COLORS: Record<OpeningStatus, string> = {
  planned: "var(--st-planned)",
  assigned: "var(--st-assigned)",
  installed: "var(--st-installed)",
};

/**
 * One label layer for an opening's status (wave I-1, pick 4): every place
 * that used to print the raw enum (`o.status`) reads this instead, so a
 * database value change never leaks straight to a screen. `status` takes a
 * plain `string` rather than `OpeningStatus` on purpose — a legacy/unknown
 * value falls back to itself (never `undefined`) instead of refusing to
 * compile or blanking the word out.
 */
export function openingStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    planned: "Planned",
    assigned: "Assigned",
    installed: "Installed",
  };
  return labels[status] ?? status;
}

/**
 * Same idea for a ready-to-install verdict (lib/install/fit.ts's
 * ReadyStatus) — "Not ready yet" is what used to leak as the raw
 * "incomplete" on a dispatch row.
 */
export function readyStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    ready: "Ready",
    blocked: "Blocked",
    incomplete: "Not ready yet",
  };
  return labels[status] ?? status;
}

/** Base mark for display: W1-2 → W1, #14-1 → 14. */
export function openingMarkCode(openingCode: string): string {
  const raw = openingCode.trim().replace(/^#/, "").toUpperCase();
  return raw.replace(/-\d+$/, "") || raw;
}

/** Map label: (#14) — type mark only; details live on tap. */
export function openingMarkLabel(openingCode: string): string {
  return `(#${openingMarkCode(openingCode)})`;
}
