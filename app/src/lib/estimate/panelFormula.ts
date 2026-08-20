// Studio 100x #24 — the PANEL-LEVEL FORMULA (CONTEXT.md):
//
//   estimate = unit setup + Σ(panel cost × mechanism × story × inset/outset)
//
// A NEW TOP RUNG on the fallback ladder (cohorts.ts), never a
// replacement — every rung below still resolves exactly as before
// whenever this one is unavailable. Rationale straight from CONTEXT.md's
// "Panel-level evidence": unit-level cohorts (even the ladder's "exact"
// rung) are too sparse to trust for a shape we've built three of, but
// panels pool across EVERY unit ever installed, the same way the
// story/inset-outset Modifiers already do ("estimated by pooling across
// all unit types, not per-cohort... trustworthy after ~dozens of units").
// That's why this rung, once it exists, is tried BEFORE "exact" — it is
// the more data-efficient number, not a fallback of last resort.
//
// Fitting is on demand, pure, and memoizable (cohorts.ts caches it on
// the evidence array's own identity) — no new table, no stored
// coefficients, no dependency: a small ridge-regularized least squares
// solved by hand (Gaussian elimination), plus a median-ratio pass for
// the two multipliers. NO new deps, matching the rest of this directory.

import type { CohortEvidence } from "./cohorts";
import { panelMixOf, sumMixes, type SignatureV1 } from "./signature";
import { unitTiers, type UnitConfig } from "../modelstudio/units";

// ------------------------------------------------------------- the gate
//
// Below this, the rung doesn't exist — cohorts.ts falls straight to
// "exact" as if this file were never written. CONTEXT.md's own number
// ("evidence holds ≥30 FINISHED units spanning ≥3 distinct mechanisms").
export const FORMULA_MIN_UNITS = 30;
export const FORMULA_MIN_MECHANISMS = 3;

// A story/inset/outset multiplier only fits when BOTH sides of its split
// clear this bar — otherwise it stays exactly 1.0 (CONTEXT.md). Deliberately
// higher than the ladder's own MIN_COHORT_N (5): CONTEXT.md's Modifier entry
// calls a pooled coefficient trustworthy only "after ~dozens of units,"
// a noticeably higher bar than one cohort's own n≥5 — and unlike a
// cohort's median, a multiplier never gets its own visible "n=" label; it's
// folded silently into the rung's one combined "formula fit from N units"
// line. A thin multiplier would distort that number with nothing in the
// label to warn a reader it happened, which is exactly why it earns the
// more conservative bar. 15 — noticeably into "dozens" territory without
// requiring a company-wide install volume the pooled-across-everything
// story/inset/outset splits could otherwise take years to reach.
const MIN_SPLIT_N = 15;

// ---------------------------------------------------- plain sanity bounds
//
// A fit outside these is declined outright (null) rather than shown —
// "the rung declines to exist rather than show nonsense." Chosen to be
// generous, not tight: they exist to catch a broken join or a mis-signed
// unit poisoning the regression, not to second-guess a genuinely
// expensive panel.
//
// MAX_SETUP_MIN / MAX_MECHANISM_MIN: 480 minutes = one 8-hour day, the
// same cap evidenceFromSessions already applies to a single session
// (cohorts.ts). A unit's setup, or one panel's mechanism cost, that
// regresses out above a full day is not a cost signal — it's a fit that
// found noise instead of a pattern.
export const MAX_SETUP_MIN = 480;
export const MAX_MECHANISM_MIN = 480;

// MIN_MULTIPLIER / MAX_MULTIPLIER: a story or inset/outset modifier
// outside 5x either direction (i.e. more than 5x costlier, or more than
// 5x — implying under a fifth the cost — cheaper) is not a plausible
// physical effect for the same panels; it says the split's two sides
// aren't comparable (e.g. a confound), not that the number is real.
export const MIN_MULTIPLIER = 0.2;
export const MAX_MULTIPLIER = 5;

export interface PanelFormulaFit {
  setupMin: number;
  /** Keyed exactly like a SignatureTierV1's mix — signature.ts's
   * panelMechanismKey is the one place this key is computed. */
  mechanismMinPerPanel: Record<string, number>;
  /** Multiplies the panel-cost sum when the tier's story > 1. Exactly
   * 1.0 when there isn't evidence on both sides of that split. */
  storyFactor: number;
  /** Multiplies the panel-cost sum when insetOutset === "inset". Exactly
   * 1.0 absent both-sided evidence. */
  insetFactor: number;
  /** Multiplies the panel-cost sum when insetOutset === "outset".
   * Exactly 1.0 absent both-sided evidence. */
  outsetFactor: number;
  /** How many units this fit came from — the honesty number the rung's
   * label carries ("formula fit from 42 units"). */
  fittedFrom: number;
}

const EMPTY_CONFIGS: ReadonlyMap<string, UnitConfig> = new Map();

// ----------------------------------------------------------- training rows

type StoryCategory = "base" | "upper";

/** Ground level (1) and untraced (null) are both treated as the
 * baseline — an unknown story is honestly not evidence FOR a penalty,
 * so it can't be assumed to carry one. Only a story confirmed above 1
 * counts as "upper." */
function storyCategory(story: number | null): StoryCategory {
  return story != null && story > 1 ? "upper" : "base";
}

interface TrainingRow {
  mix: Record<string, number>;
  storyCat: StoryCategory;
  io: "inset" | "outset" | null;
  minutes: number;
}

/**
 * PURE: fold evidence into one training row per unit. `configsByUnit`
 * lets a caller hand in freshly-resolved panels for units it has them
 * for (CONTEXT.md: "joined to each unit's resolved UnitConfig panels");
 * for everything else, the evidence row's OWN stored signature mix is
 * exactly that same resolved-panel data, one sync cycle less fresh —
 * not a shortcut, the same join signatureSync already did once. Rows
 * without a usable signature, a v1 mismatch, a non-positive minutes
 * figure, or an empty mix are not evidence and drop out silently, the
 * same discipline evidenceFromSessions already applies upstream.
 *
 * Multi-tier (Studio 100x #22): EVERY tier's panels are evidence, not
 * just the base — CONTEXT.md's own worked example is a 9-pane storefront
 * yielding nine panels of evidence across three stories, not three. A
 * row's `mix` sums every tier via `unitTiers`/`sig.tiers`; its `storyCat`
 * counts as "base" only when EVERY tier does (storyCategory's own "only a
 * story CONFIRMED above 1 counts as upper," promoted from one tier to
 * the whole unit) — one elevated tier means some of this row's panels
 * really did cost the upper rate, so the row can't join the
 * pure-baseline slice (stage 2 below) without confounding it.
 */
function trainingRowsFrom(
  evidence: readonly CohortEvidence[],
  configsByUnit: ReadonlyMap<string, UnitConfig>,
): TrainingRow[] {
  const rows: TrainingRow[] = [];
  const seenUnits = new Set<string>();
  for (const e of evidence) {
    if (e.unitId != null) {
      if (seenUnits.has(e.unitId)) continue; // never double-count a unit
      seenUnits.add(e.unitId);
    }
    const sig = e.signature;
    if (!sig || sig.v !== 1) continue; // versions never mix, same as the ladder
    if (sig.tiers.length === 0) continue;
    if (!(e.minutes > 0)) continue;
    const config = e.unitId != null ? configsByUnit.get(e.unitId) : undefined;
    const mix = config
      ? sumMixes(unitTiers(config).map((t) => panelMixOf(t.panels)))
      : sumMixes(sig.tiers.map((t) => t.mix));
    if (Object.keys(mix).length === 0) continue;
    const storyCat: StoryCategory = sig.tiers.some((t) => storyCategory(t.story) === "upper")
      ? "upper"
      : "base";
    rows.push({ mix, storyCat, io: sig.insetOutset, minutes: e.minutes });
  }
  return rows;
}

function distinctMechanisms(rows: readonly TrainingRow[]): Set<string> {
  const s = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r.mix)) s.add(k);
  return s;
}

// ------------------------------------------------------- least squares

/**
 * Solve (XᵀX + λI)β = Xᵀy by Gaussian elimination with partial pivoting.
 * Ridge (tiny λ) only guards near-singular systems: on clean,
 * well-conditioned data its effect is orders of magnitude below any
 * reasonable comparison tolerance, so exact recovery on noiseless
 * synthetic input still holds. Returns null — never a wrong number — the
 * moment a pivot collapses relative to the matrix's own scale, which is
 * what an exactly (or near-exactly) singular system looks like: not
 * enough independent evidence to separate these coefficients.
 */
function ridgeSolve(X: readonly (readonly number[])[], y: readonly number[], lambda = 1e-6): number[] | null {
  const n = X.length;
  const p = X[0]?.length ?? 0;
  if (n === 0 || p === 0 || n < p) return null;

  const A: number[][] = Array.from({ length: p }, () => new Array(p).fill(0));
  const b: number[] = new Array(p).fill(0);
  for (let i = 0; i < n; i++) {
    const xi = X[i];
    for (let j = 0; j < p; j++) {
      b[j] += xi[j] * y[i];
      for (let k = 0; k < p; k++) A[j][k] += xi[j] * xi[k];
    }
  }
  let scale = 1;
  for (let j = 0; j < p; j++) {
    scale = Math.max(scale, Math.abs(A[j][j]));
    A[j][j] += lambda;
  }
  // A truly (or near-exactly) collinear column — e.g. two mechanisms
  // that only ever appear together in fixed proportion — is "solvable"
  // after ridge only because λ is sitting on its diagonal; its pivot
  // after elimination lands at roughly λ's own scale, not the data's.
  // Comparing purely to the matrix's scale (1e-9 × scale) can land in
  // the same neighborhood as λ itself and miss that case, so the floor
  // is whichever is larger: the usual scale-relative tolerance, or a
  // multiple of λ big enough that a pivot only ridge is holding up
  // reads as singular, not as a thin-but-real signal.
  const singularBelow = Math.max(1e-9 * scale, lambda * 1e3);

  for (let col = 0; col < p; col++) {
    let pivotRow = col;
    let pivotVal = Math.abs(A[col][col]);
    for (let r = col + 1; r < p; r++) {
      if (Math.abs(A[r][col]) > pivotVal) {
        pivotVal = Math.abs(A[r][col]);
        pivotRow = r;
      }
    }
    if (pivotVal < singularBelow) return null;
    if (pivotRow !== col) {
      [A[col], A[pivotRow]] = [A[pivotRow], A[col]];
      [b[col], b[pivotRow]] = [b[pivotRow], b[col]];
    }
    const pivot = A[col][col];
    for (let r = col + 1; r < p; r++) {
      const factor = A[r][col] / pivot;
      if (factor === 0) continue;
      for (let c = col; c < p; c++) A[r][c] -= factor * A[col][c];
      b[r] -= factor * b[col];
    }
  }

  const beta = new Array(p).fill(0);
  for (let row = p - 1; row >= 0; row--) {
    let sum = b[row];
    for (let c = row + 1; c < p; c++) sum -= A[row][c] * beta[c];
    if (Math.abs(A[row][row]) < singularBelow) return null;
    beta[row] = sum / A[row][row];
  }
  return beta;
}

function median(values: readonly number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Panel-cost sum for one mix under a set of per-mechanism costs — null
 * the moment the mix uses a mechanism with no coefficient (the fit never
 * saw it), which callers treat as "can't price this one," not zero. */
function predictPanelSum(
  mix: Record<string, number>,
  mechanismMinPerPanel: Record<string, number>,
): number | null {
  let sum = 0;
  for (const [key, count] of Object.entries(mix)) {
    const cost = mechanismMinPerPanel[key];
    if (cost === undefined) return null;
    sum += cost * count;
  }
  return sum;
}

/**
 * One multiplier from one split: `isTreatment` rows contrasted against
 * `isBaseline` rows drawn from `rows` (already narrowed to hold the
 * OTHER dimension at ITS baseline, so this split isolates one variable).
 * Fits only when both sides clear MIN_SPLIT_N; otherwise exactly 1.0,
 * verbatim CONTEXT.md ("fit ONLY where evidence exists on both sides of
 * that split; otherwise the factor is exactly 1.0"). The ratio itself is
 * a MEDIAN over (actual − setup) / predicted-base-panel-cost — robust,
 * and exact on noiseless synthetic input where every treatment row
 * shares the identical true ratio.
 */
function fitSplitFactor(
  rows: readonly TrainingRow[],
  mechanismMinPerPanel: Record<string, number>,
  setupMin: number,
  isBaseline: (r: TrainingRow) => boolean,
  isTreatment: (r: TrainingRow) => boolean,
): number {
  const baselineN = rows.filter(isBaseline).length;
  const treatmentRows = rows.filter(isTreatment);
  if (baselineN < MIN_SPLIT_N || treatmentRows.length < MIN_SPLIT_N) return 1;

  const ratios: number[] = [];
  for (const r of treatmentRows) {
    const predicted = predictPanelSum(r.mix, mechanismMinPerPanel);
    if (predicted == null || predicted <= 0) continue;
    const ratio = (r.minutes - setupMin) / predicted;
    if (Number.isFinite(ratio)) ratios.push(ratio);
  }
  if (ratios.length < MIN_SPLIT_N) return 1;
  return median(ratios);
}

/**
 * Fit the panel formula over the same evidence pool the ladder consumes.
 * Pure, and cheap enough to memoize on the evidence array's identity
 * (cohorts.ts does this — every estimateForSignature call in one render
 * shares the fit instead of re-solving per row).
 *
 * Stages, in order:
 *  1. Gate: ≥ FORMULA_MIN_UNITS usable rows, spanning ≥ FORMULA_MIN_MECHANISMS
 *     distinct mechanism keys. Below it, the rung simply doesn't exist.
 *  2. setupMin + mechanismMinPerPanel: ridge least squares over the
 *     "purely baseline" rows only (story ≤ 1 or untraced, insetOutset
 *     null) — the one slice where the model has no multiplier confound,
 *     so the linear system is exactly `setup + Σ cost·count`. Sanity
 *     bounds apply; a violation declines the WHOLE fit.
 *  3. storyFactor / insetFactor / outsetFactor: each its own isolated
 *     split against the stage-2 fit's predictions (see fitSplitFactor).
 *     Sanity bounds apply here too.
 *
 * Returns null for: below-gate evidence, an underdetermined or singular
 * baseline system, or any coefficient outside its sanity bounds — always
 * a decline, never a number dressed as one.
 */
export function fitPanelFormula(
  evidence: readonly CohortEvidence[],
  configsByUnit: ReadonlyMap<string, UnitConfig> = EMPTY_CONFIGS,
): PanelFormulaFit | null {
  const rows = trainingRowsFrom(evidence, configsByUnit);
  if (rows.length < FORMULA_MIN_UNITS) return null;
  if (distinctMechanisms(rows).size < FORMULA_MIN_MECHANISMS) return null;

  const baseline = rows.filter((r) => r.storyCat === "base" && r.io === null);
  const mechKeys = [...distinctMechanisms(baseline)].sort();
  if (baseline.length < mechKeys.length + 1) return null; // underdetermined

  const X = baseline.map((r) => [1, ...mechKeys.map((k) => r.mix[k] ?? 0)]);
  const y = baseline.map((r) => r.minutes);
  const beta = ridgeSolve(X, y);
  if (!beta) return null;

  const setupMin = beta[0];
  if (!(setupMin >= 0 && setupMin <= MAX_SETUP_MIN)) return null;

  const mechanismMinPerPanel: Record<string, number> = {};
  for (let i = 0; i < mechKeys.length; i++) {
    const v = beta[i + 1];
    if (!(v >= 0 && v <= MAX_MECHANISM_MIN)) return null;
    mechanismMinPerPanel[mechKeys[i]] = v;
  }

  const storyFactor = fitSplitFactor(
    rows.filter((r) => r.io === null),
    mechanismMinPerPanel,
    setupMin,
    (r) => r.storyCat === "base",
    (r) => r.storyCat === "upper",
  );
  const insetFactor = fitSplitFactor(
    rows.filter((r) => r.storyCat === "base"),
    mechanismMinPerPanel,
    setupMin,
    (r) => r.io === null,
    (r) => r.io === "inset",
  );
  const outsetFactor = fitSplitFactor(
    rows.filter((r) => r.storyCat === "base"),
    mechanismMinPerPanel,
    setupMin,
    (r) => r.io === null,
    (r) => r.io === "outset",
  );
  for (const f of [storyFactor, insetFactor, outsetFactor]) {
    if (!(f >= MIN_MULTIPLIER && f <= MAX_MULTIPLIER)) return null;
  }

  return { setupMin, mechanismMinPerPanel, storyFactor, insetFactor, outsetFactor, fittedFrom: rows.length };
}

// --------------------------------------------------------------- estimate

/** The formula itself (CONTEXT.md): setup + the story/inset-outset-scaled
 * panel-cost sum. Null when the mix needs a mechanism the fit never saw
 * — a per-target decline (the caller falls back a rung), not a broken
 * fit. Takes the ALREADY-CATEGORIZED `storyCat` (not a raw story number)
 * so a multi-tier caller can hand in the same "any tier upper" verdict
 * trainingRowsFrom used while fitting — fitting and predicting must never
 * disagree about what "upper" means for a mixed-story unit. */
function estimateFromMix(
  mix: Record<string, number>,
  storyCat: StoryCategory,
  insetOutset: "inset" | "outset" | null,
  fit: PanelFormulaFit,
): number | null {
  const panelSum = predictPanelSum(mix, fit.mechanismMinPerPanel);
  if (panelSum == null) return null;
  const storyMul = storyCat === "upper" ? fit.storyFactor : 1;
  const ioMul = insetOutset === "inset" ? fit.insetFactor : insetOutset === "outset" ? fit.outsetFactor : 1;
  return fit.setupMin + storyMul * ioMul * panelSum;
}

/**
 * #24: the panel formula for a drafted/catalog UnitConfig — no traced
 * opening, so story is honestly unknown, the same simplification
 * liveEstimate.estimateForUnitConfig already makes for every other rung
 * (story stays null/"base" until a job traces it — true for every tier
 * of a multi-tier draft too, since none of them have a real opening
 * yet). insetOutset comes off the config exactly the way the rest of the
 * ladder reads it. Multi-tier (Studio 100x #22): sums every tier's
 * panels via `unitTiers`, not just the base.
 */
export function estimateViaFormula(config: UnitConfig, fit: PanelFormulaFit): number | null {
  const mix = sumMixes(unitTiers(config).map((t) => panelMixOf(t.panels)));
  return estimateFromMix(mix, "base", config.insetOutset ?? null, fit);
}

/**
 * #24: the panel formula for a resolved signature — cohorts.ts's own
 * call, with the target's REAL story and inset/outset when a job has
 * traced them (unlike the config-level call above, which never has
 * them). Multi-tier (Studio 100x #22): sums every tier's mix, and counts
 * as "upper" the moment ANY tier resolves above story 1 — the same rule
 * trainingRowsFrom applies while fitting.
 */
export function estimateForSignatureViaFormula(
  signature: SignatureV1,
  fit: PanelFormulaFit,
): number | null {
  if (signature.tiers.length === 0) return null;
  const mix = sumMixes(signature.tiers.map((t) => t.mix));
  const storyCat: StoryCategory = signature.tiers.some((t) => storyCategory(t.story) === "upper")
    ? "upper"
    : "base";
  return estimateFromMix(mix, storyCat, signature.insetOutset, fit);
}
