import { supabase } from "./supabase";

/**
 * Unified tiered issues model. The three scattered "problem" surfaces
 * (ProjectDetail Exceptions tab, Dispatch Blockers, ProjectMap voided rings)
 * plus the foreman Issues list all read this one table. `urgency` renders as
 * blank / `!` / `!!!`.
 */

export type IssueKind =
  | "failed_install"
  | "flag"
  | "damage"
  | "blocker"
  | "complication"
  | "missing"
  /**
   * The rough opening failed its checklist (out of square, or the gap to the
   * unit is outside the 1/8"-1/2" range) — a framer's fix, filed from the
   * opening sheet with the window named in the note.
   */
  | "framing"
  /**
   * The supplier's paperwork disagrees with the plans — a mark with no spec
   * sheet, or a spec for a window nobody asked for. Kept separate from
   * `missing`, which means an undelivered physical unit and is wired into
   * receiving and reorder counts; this one is chased with the supplier's
   * office, not the warehouse.
   */
  | "spec_gap";
export type IssueUrgency = "normal" | "urgent" | "emergency";
export type IssueStatus = "open" | "resolved";

export interface Issue {
  id: string;
  project_id: string;
  opening_id: string | null;
  /** Physical unit this issue is about (damage/missing), if unit-level. */
  window_id: string | null;
  kind: IssueKind;
  urgency: IssueUrgency;
  status: IssueStatus;
  note: string | null;
  created_by: string | null;
  created_at: string;
  resolved_by: string | null;
  resolved_at: string | null;
  /**
   * Who is responsible for fixing this problem (the assignee). Optional: the
   * column ships in 20260723060000_issue_assignee_fault.sql, so it may be absent
   * (undefined) until that migration is applied — treat as null when missing.
   */
  assigned_to?: string | null;
  /** Whose fault it was, if determined (fault attribution). See note above. */
  fault_by?: string | null;
  /** The TRADE at fault (owner call 2026-08-13) — people stay on Assign. */
  fault_trade?: string | null;
}

/** Higher rank sorts first: emergency > urgent > normal. */
export const URGENCY_RANK: Record<IssueUrgency, number> = {
  emergency: 3,
  urgent: 2,
  normal: 1,
};

/** How each tier renders next to an issue. */
export const URGENCY_MARK: Record<IssueUrgency, string> = {
  emergency: "!!!",
  urgent: "!",
  normal: "",
};

export const KIND_LABELS: Record<IssueKind, string> = {
  failed_install: "Failed install",
  framing: "Framing fix needed",
  flag: "Flag",
  damage: "Damage",
  blocker: "Blocker",
  complication: "Complication",
  missing: "Missing delivery",
  spec_gap: "Spec sheet gap",
};

/**
 * Display order for issue kinds (used by the Issues page filter dropdown).
 * Written as a Record<IssueKind, number> so TypeScript fails the build if a
 * new IssueKind is ever added without a rank here — a hand-copied array
 * (the old approach) can silently drift out of sync with IssueKind, which is
 * exactly what happened: "framing" and "missing" were added to IssueKind but
 * never added to the dropdown's list, so foremen couldn't filter to them.
 */
const KIND_ORDER_RANK: Record<IssueKind, number> = {
  failed_install: 0,
  framing: 1,
  damage: 2,
  missing: 3,
  flag: 4,
  blocker: 5,
  complication: 6,
  spec_gap: 7,
};

/** All issue kinds, in display order, derived from KIND_ORDER_RANK above. */
export const KIND_ORDER: IssueKind[] = (
  Object.keys(KIND_ORDER_RANK) as IssueKind[]
).sort((a, b) => KIND_ORDER_RANK[a] - KIND_ORDER_RANK[b]);

/**
 * Tier-sort comparator: urgency tier first (emergency > urgent > normal), then
 * chronological (oldest-first) within a tier so the longest-waiting problem in
 * each tier rises to the top.
 */
export function compareIssues(a: Issue, b: Issue): number {
  const tier = URGENCY_RANK[b.urgency] - URGENCY_RANK[a.urgency];
  if (tier !== 0) return tier;
  return a.created_at.localeCompare(b.created_at);
}

/** Cross-project issue feed (foreman+; guarded server-side in list_issues). */
export async function listIssues(): Promise<Issue[]> {
  const { data, error } = await supabase.rpc("list_issues");
  if (error) throw error;
  return (data ?? []) as Issue[];
}

/** All issues on one project (used by the Exceptions tab + Dispatch Blockers). */
export async function listProjectIssues(projectId: string): Promise<Issue[]> {
  const { data, error } = await supabase
    .from("issues")
    .select("*")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as Issue[];
}

export async function createIssue(params: {
  projectId: string;
  openingId?: string | null;
  kind: IssueKind;
  urgency?: IssueUrgency;
  note?: string | null;
}): Promise<Issue> {
  const { data, error } = await supabase.rpc("create_issue", {
    p_project: params.projectId,
    p_opening: params.openingId ?? null,
    p_kind: params.kind,
    p_urgency: params.urgency ?? "normal",
    p_note: params.note ?? null,
  });
  if (error) throw error;
  return data as Issue;
}

export async function resolveIssue(id: string): Promise<Issue> {
  const { data, error } = await supabase.rpc("resolve_issue", { p_id: id });
  if (error) throw error;
  return data as Issue;
}

/**
 * Assign an issue to someone (or clear it with null). Foreman+ (guarded by the
 * RPC). Ships in 20260723060000_issue_assignee_fault.sql — before that migration
 * lands the RPC won't exist and this throws, so callers show a friendly error
 * rather than crashing.
 */
export async function assignIssue(
  id: string,
  assignee: string | null,
): Promise<Issue> {
  const { data, error } = await supabase.rpc("assign_issue", {
    p_id: id,
    p_assignee: assignee,
  });
  if (error) throw error;
  return data as Issue;
}

/** Attribute (or clear) whose fault an issue was. Foreman+ (guarded by the RPC). */
export async function setIssueFault(
  id: string,
  faultBy: string | null,
): Promise<Issue> {
  const { data, error } = await supabase.rpc("set_issue_fault", {
    p_id: id,
    p_fault_by: faultBy,
  });
  if (error) throw error;
  return data as Issue;
}

/** The trades an issue's fault can land on (owner list, extendable). */
export const FAULT_TRADES = [
  "Carpentry",
  "Framing",
  "Concrete",
  "Plumbing",
  "Electrical",
  "HVAC",
  "Roofing",
  "Sheetrock",
  "Insulation",
  "Siding",
  "Stucco",
  "Windows",
  "Doors",
  "Flashing",
  "Painting",
  "Landscaping",
  "Other",
] as const;

/** Attribute (or clear) the TRADE at fault. Foreman+ (guarded by the RPC). */
export async function setIssueFaultTrade(
  id: string,
  trade: string | null,
): Promise<Issue> {
  const { data, error } = await supabase.rpc("set_issue_fault_trade", {
    p_id: id,
    p_trade: trade,
  });
  if (error) throw error;
  return data as Issue;
}
