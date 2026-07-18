import type { CostCode } from "./timeclock";

export interface CostCodeSwap {
  /** id → new sort_order, for the two codes that trade places. */
  updates: { id: string; sort_order: number }[];
}

/**
 * Pure planner for a one-slot reorder: given the full library in display order,
 * figure out the sort_order swap needed to move `id` up or down by one. Returns
 * an empty plan when the move isn't possible (edge of list / unknown id) so the
 * caller can no-op. Kept free of Supabase so it's trivially unit-testable.
 */
export function planCostCodeSwap(
  codes: CostCode[],
  id: string,
  direction: "up" | "down",
): CostCodeSwap {
  const idx = codes.findIndex((c) => c.id === id);
  if (idx === -1) return { updates: [] };
  const swapIdx = direction === "up" ? idx - 1 : idx + 1;
  if (swapIdx < 0 || swapIdx >= codes.length) return { updates: [] };

  const a = codes[idx];
  const b = codes[swapIdx];
  const orderA = a.sort_order ?? idx * 10;
  const orderB = b.sort_order ?? swapIdx * 10;
  return {
    updates: [
      { id: a.id, sort_order: orderB },
      { id: b.id, sort_order: orderA },
    ],
  };
}
