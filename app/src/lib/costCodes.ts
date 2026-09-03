// Management API for the global cost-code library. The clock-in / timecard
// read path lives in timeclock.ts (listCostCodes → active codes only); this
// module is the write/admin side used by the Cost codes management screen.
//
// Model: cost codes are GLOBAL — one company-wide library that applies to every
// job. There is no per-project assignment; a code is either active (pickable
// everywhere) or inactive. sort_order controls the order codes appear in the
// picker and the library list.
import { supabase } from "./supabase";
import { planCostCodeSwap } from "./costCodeOrder";
import { isMissingTable } from "./schemaErrors";
import { listCostCodes, type CostCode } from "./timeclock";
import { resolveClockCostCodes, sortClockCostCodes } from "./clockCostCodes";

export type { CostCode };

// Explicit column list for cost_codes reads through the embed (no select *):
// the same fields the CostCode type carries, so the per-job subset joins back
// exactly what listCostCodes returns.
const COST_CODE_COLS = "id, code, label, description, active, sort_order, is_general";

export interface CostCodeInput {
  code: string;
  label: string;
  description?: string | null;
}

/** All cost codes (active + inactive) in library order, for management. */
export async function listAllCostCodes(): Promise<CostCode[]> {
  const { data, error } = await supabase
    .from("cost_codes")
    .select("*")
    .order("sort_order")
    .order("code");
  if (error) throw error;
  return (data ?? []) as CostCode[];
}

/** Create a new code at the end of the library (highest sort_order + 10). */
export async function createCostCode(input: CostCodeInput): Promise<CostCode> {
  const code = input.code.trim();
  const label = input.label.trim();
  if (!code) throw new Error("A short code is required (e.g. 100).");
  if (!label) throw new Error("A name is required (e.g. Install — windows).");

  const { data: last } = await supabase
    .from("cost_codes")
    .select("sort_order")
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle();
  const nextSort = ((last?.sort_order as number | undefined) ?? 0) + 10;

  const { data, error } = await supabase
    .from("cost_codes")
    .insert({
      code,
      label,
      description: input.description?.trim() || null,
      sort_order: nextSort,
    })
    .select("*")
    .single();
  if (error) throw error;
  return data as CostCode;
}

/** Patch code / name / description on an existing cost code. */
export async function updateCostCode(
  id: string,
  patch: Partial<CostCodeInput>,
): Promise<CostCode> {
  const next: Record<string, unknown> = {};
  if (patch.code !== undefined) {
    const code = patch.code.trim();
    if (!code) throw new Error("A short code is required.");
    next.code = code;
  }
  if (patch.label !== undefined) {
    const label = patch.label.trim();
    if (!label) throw new Error("A name is required.");
    next.label = label;
  }
  if (patch.description !== undefined) {
    next.description = patch.description?.trim() || null;
  }
  const { data, error } = await supabase
    .from("cost_codes")
    .update(next)
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw error;
  return data as CostCode;
}

/** Activate / deactivate a code. Inactive codes drop out of every picker. */
export async function setCostCodeActive(
  id: string,
  active: boolean,
): Promise<void> {
  const { error } = await supabase
    .from("cost_codes")
    .update({ active })
    .eq("id", id);
  if (error) throw error;
}

/**
 * Move a code one slot up or down by swapping sort_order with its neighbour in
 * the current library order. `codes` must be the full library in display order.
 */
export async function moveCostCode(
  codes: CostCode[],
  id: string,
  direction: "up" | "down",
): Promise<void> {
  const { updates } = planCostCodeSwap(codes, id, direction);
  if (updates.length === 0) return;
  const results = await Promise.all(
    updates.map((u) =>
      supabase.from("cost_codes").update({ sort_order: u.sort_order }).eq("id", u.id),
    ),
  );
  for (const r of results) if (r.error) throw r.error;
}

// ---------------------------------------------------------------------------
// Per-job cost codes (standard-tracking-jobs slice 3): a job's OPTIONAL pickable
// subset of the library. project_cost_codes + the foreman+ RPCs live in
// migration 20260973000000. Writes go only through the RPCs (the table's direct
// write grants are revoked); reads degrade to empty on a database that hasn't
// applied the migration, the house rule for a feature that ships ahead of it.
// ---------------------------------------------------------------------------

interface ProjectCostCodeRow {
  // Supabase types an embedded relation as an array; normalize below.
  cost_codes: CostCode | CostCode[] | null;
}

/** The active cost codes assigned to a job (its subset), or [] if none / not migrated. */
export async function listProjectCostCodes(projectId: string): Promise<CostCode[]> {
  const { data, error } = await supabase
    .from("project_cost_codes")
    .select(`cost_codes(${COST_CODE_COLS})`)
    .eq("project_id", projectId);
  if (isMissingTable(error, "project_cost_codes")) return [];
  if (error) throw error;
  const rows = (data ?? []) as unknown as ProjectCostCodeRow[];
  const codes: CostCode[] = [];
  for (const r of rows) {
    const cc = Array.isArray(r.cost_codes) ? r.cost_codes[0] : r.cost_codes;
    if (cc && cc.active) codes.push(cc);
  }
  return sortClockCostCodes(codes);
}

/**
 * The cost codes a worker may pick when clocking into this job — the job's
 * subset if it has one, else the whole active library, always including the
 * general fallback, common codes first (Horizon getClockCostCodesForProject).
 * A null project (clocking in with no job yet) is the whole active library.
 */
export async function getClockCostCodesForProject(
  projectId: string | null,
): Promise<CostCode[]> {
  const allActive = await listCostCodes();
  if (!projectId) return sortClockCostCodes(allActive);
  const jobCodes = await listProjectCostCodes(projectId);
  return resolveClockCostCodes(jobCodes, allActive);
}

/** Replace a job's whole subset (foreman+). An empty list clears it. */
export async function setProjectCostCodes(
  projectId: string,
  costCodeIds: string[],
): Promise<void> {
  const { error } = await supabase.rpc("set_project_cost_codes", {
    p_project_id: projectId,
    p_cost_code_ids: costCodeIds,
  });
  if (error) throw error;
}

/** Add one code to a job's subset (foreman+). */
export async function addProjectCostCode(
  projectId: string,
  costCodeId: string,
): Promise<void> {
  const { error } = await supabase.rpc("add_project_cost_code", {
    p_project_id: projectId,
    p_cost_code_id: costCodeId,
  });
  if (error) throw error;
}

/** Remove one code from a job's subset (foreman+). */
export async function removeProjectCostCode(
  projectId: string,
  costCodeId: string,
): Promise<void> {
  const { error } = await supabase.rpc("remove_project_cost_code", {
    p_project_id: projectId,
    p_cost_code_id: costCodeId,
  });
  if (error) throw error;
}
