// The order the clock-in picker offers cost codes in (standard-tracking-jobs
// slice 3, 2026-09-03; the per-job subset was removed 2026-09-07).
//
// Every job offers the whole active company library — the owner's call: a
// job does not get its own list of cost codes, the picker at clock-in shows
// them all. "Common codes first" means the general catch-all on top, then the
// company's own sort_order (the order the management screen's up/down arrows
// set) — this repo already encodes common order in sort_order rather than a
// hard-coded phase list.
//
// Kept free of Supabase so the rule is unit-tested directly (clockCostCodes
// .test.ts); the data fetch that feeds it lives in costCodes.ts.

import type { CostCode } from "./timeclock";

/** General fallback first, then company sort_order, then code. */
export function sortClockCostCodes(codes: CostCode[]): CostCode[] {
  return [...codes].sort((a, b) => {
    const ga = a.is_general ? 0 : 1;
    const gb = b.is_general ? 0 : 1;
    if (ga !== gb) return ga - gb;
    const sa = a.sort_order ?? Number.MAX_SAFE_INTEGER;
    const sb = b.sort_order ?? Number.MAX_SAFE_INTEGER;
    if (sa !== sb) return sa - sb;
    return a.code.localeCompare(b.code);
  });
}
