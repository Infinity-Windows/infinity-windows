// Which cost codes the clock-in picker offers for a job, and in what order
// (standard-tracking-jobs slice 3, 2026-09-03).
//
// A port of Horizon's getClockCostCodesForProject / COMMON_COST_CODE_ORDER: a
// company-wide library with an OPTIONAL per-job subset. A job with a subset
// shows only those codes; a job without one shows the whole active library; and
// EITHER way the general fallback code is always included, so a worker is never
// left without a valid code to charge to. "Common codes first" here means the
// general catch-all on top, then the company's own sort_order (the order the
// management screen's up/down arrows set) — this repo already encodes common
// order in sort_order rather than a hard-coded phase list.
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

/**
 * The picker list for a job:
 *  - the job's subset when it has one, else the full active library;
 *  - plus the general fallback code (from the active library), if it isn't
 *    already in the list;
 *  - sorted general-first.
 *
 * `jobCodes` are the active codes assigned to the job (empty = no subset).
 * `allActive` is the full active company library — the source of the general
 * fallback, and the list used when the job has no subset.
 */
export function resolveClockCostCodes(
  jobCodes: CostCode[],
  allActive: CostCode[],
): CostCode[] {
  const base = jobCodes.length > 0 ? jobCodes : allActive;
  const general = allActive.find((c) => c.is_general) ?? null;
  const withGeneral =
    general && !base.some((c) => c.id === general.id) ? [...base, general] : base;
  return sortClockCostCodes(withGeneral);
}
