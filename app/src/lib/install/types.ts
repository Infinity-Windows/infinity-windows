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

/** Map pin identity color: window vs door (status is a separate ring/badge). */
export const OPENING_KIND_COLORS = {
  window: "#4A9DFF",
  door: "#3ECF6E",
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
  assigned_window_id: string | null;
  status: OpeningStatus;
  confirmed: boolean;
  created_at: string;
  ro_width_in: number | null;
  ro_height_in: number | null;
  ro_measured_by: string | null;
  ro_measured_at: string | null;
  condition: OpeningCondition;
  condition_note: string | null;
  condition_checked_by: string | null;
  condition_checked_at: string | null;
  assigned_to: string | null;
  assigned_by: string | null;
  assigned_at: string | null;
  sequence: number | null;
  work_started_at: string | null;
  flag_note: string | null;
  flagged_by: string | null;
  flagged_at: string | null;
  window_types?: WindowType | null;
  windows?: WindowUnit | null;
  projects?: Project | null;
  assignee?: Profile | null;
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

export const OPENING_STATUS_COLORS: Record<OpeningStatus, string> = {
  planned: "#fbbf24",
  assigned: "#94a3b8",
  installed: "#34d399",
};

/** Base mark for display: W1-2 → W1, #14-1 → 14. */
export function openingMarkCode(openingCode: string): string {
  const raw = openingCode.trim().replace(/^#/, "").toUpperCase();
  return raw.replace(/-\d+$/, "") || raw;
}

/** Map label: (#14) — type mark only; details live on tap. */
export function openingMarkLabel(openingCode: string): string {
  return `(#${openingMarkCode(openingCode)})`;
}
