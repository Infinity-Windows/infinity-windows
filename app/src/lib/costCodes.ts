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
import type { CostCode } from "./timeclock";

export type { CostCode };

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
