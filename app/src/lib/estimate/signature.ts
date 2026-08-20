// The SIGNATURE (CONTEXT.md): the structured, computed key a unit is
// grouped by. Cohorts of shared signatures are the estimating model's
// evidence pools. Spec: .scratch/signature/spec.md; ADR-0002 records why
// dimensions and handedness never enter it (sizes are continuous
// evidence; mirror images share a cohort).
//
// (The sibling file lib/estimate.ts is the older job-estimating
// heuristics; this directory is the per-unit cohort model.)

import {
  cornerLegs,
  slideCountOf,
  unitTiers,
  type UnitConfig,
  type UnitPanel,
} from "../modelstudio/units";

export interface SignatureTierV1 {
  /** Story the tier sits on; null when the job is untraced — null is its
   * own honest value, never defaulted. */
  story: number | null;
  /** Unordered panel tally by mechanism, multi-track sliders suffixed
   * `x{slideCount}` ("sliderx2"). Direction NEVER appears. */
  mix: Record<string, number>;
}

export interface SignatureV1 {
  v: 1;
  kind: "window" | "door";
  /** One entry per tier (CONTEXT.md), base story first. Almost every
   * unit has exactly one. Multi-tier units (Studio 100x #22 — a 9-pane
   * storefront across three floors) emit one entry per tier under this
   * SAME v:1: the array shape has held every unit since v1 shipped —
   * only ever one entry, until now — so there was never a version to
   * bump, just an unused slot finally getting used. */
  tiers: SignatureTierV1[];
  panelCount: number;
  movingCount: number;
  /** Corner PRESENCE only — the side is recorded on the unit, never
   * grouped (mirror images share a cohort). */
  corner: "none" | "corner";
  insetOutset: "inset" | "outset" | null;
}

export interface UnitFacts {
  story: number | null;
  /**
   * Resolved by the CALLER — this function never reads UnitConfig's own
   * `insetOutset` field. `signatureSync.insetOutsetOf` (catalog config,
   * else spec.extra) and `liveEstimate.estimateForUnitConfig` (config
   * only — a draft has no spec) are today's two resolvers. Keeping that
   * resolution outside computeSignature is what makes it safe for
   * UnitConfig to carry its own `insetOutset`: a config that never sets
   * it still computes the exact signature it always has, byte for byte.
   */
  insetOutset: "inset" | "outset" | null;
}

/**
 * Canonical encoding: JSON with keys sorted at every level, no
 * whitespace. Deterministic and human-readable — the string IS the
 * group-by key, no hash. Arrays keep their order (tiers are ordered).
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const body = keys
    .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
    .join(",");
  return `{${body}}`;
}

/**
 * The signature's own mechanism category for one panel: the mechanism,
 * or `mechanismxN` for a multi-track slider (N ≥ 2, CONTEXT.md's "slide
 * count"). Exported so panelFormula.ts's per-mechanism costs are always
 * exactly the signature's own mix keys — one definition of "what
 * mechanism category is this panel," never a second one that could
 * drift from this one.
 */
export function panelMechanismKey(p: UnitPanel): string {
  const count = slideCountOf(p);
  return count > 1 ? `${p.mechanism}x${count}` : p.mechanism;
}

/** Unordered panel tally by mechanism category — the same shape as a
 * SignatureTierV1's `mix`, built off the same key function
 * computeSignature uses below, so the two can never disagree about what
 * counts as a match. */
export function panelMixOf(panels: readonly UnitPanel[]): Record<string, number> {
  const mix: Record<string, number> = {};
  for (const p of panels) {
    const key = panelMechanismKey(p);
    mix[key] = (mix[key] ?? 0) + 1;
  }
  return mix;
}

/**
 * Fold several tiers' mixes into one combined tally — every panel of a
 * multi-tier unit counted once. Key order follows first-seen mechanism
 * across the input mixes, so a single-tier call (`sumMixes([mix])`)
 * reproduces `mix` byte for byte — same key order, same values — which
 * is what keeps every pinned single-tier signature.test.ts key exact.
 * Used wherever a caller wants "one number per mechanism, across the
 * WHOLE unit," never just its base tier: describeSignature's row label
 * (cohorts.ts), panelFormula.ts's per-panel walk.
 */
export function sumMixes(mixes: readonly Record<string, number>[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const mix of mixes) {
    for (const [key, count] of Object.entries(mix)) {
      out[key] = (out[key] ?? 0) + count;
    }
  }
  return out;
}

/**
 * PURE: a unit's signature from its UnitConfig-of-record plus the two
 * unit facts (story, inset/outset of the BASE tier's real opening). Same
 * widths, either corner side, XO or OX — one cohort.
 *
 * Multi-tier (Studio 100x #22): reads every tier via `unitTiers`, base
 * first. Each tier's REAL story is `facts.story` (the opening's own
 * base-tier story, resolved exactly as before) plus that tier's OFFSET
 * from the base — the tier's own authored `story` minus the base tier's.
 * A single-tier config has offset 0 for its one tier by construction, so
 * this reproduces today's exact single-tier signature, byte for byte.
 * `facts.story == null` (untraced) propagates to every tier as null,
 * never a guess — the honest value CONTEXT.md's SignatureTierV1 already
 * documents for the single-tier case, unchanged here.
 */
export function computeSignature(
  config: UnitConfig,
  facts: UnitFacts,
): { signature: SignatureV1; sigKey: string } {
  const tierList = unitTiers(config);
  const baseStory = tierList[0].story ?? 1;

  let panelCount = 0;
  let movingCount = 0;
  let anyCorner = false;
  const tiers: SignatureTierV1[] = tierList.map((tier) => {
    panelCount += tier.panels.length;
    for (const p of tier.panels) {
      if (p.mechanism !== "fixed") movingCount += 1;
    }
    // Same validity rule the geometry uses: an out-of-range corner index
    // is no corner anywhere in the app. Each tier judges its OWN split —
    // cornerLegs takes any CornerSource, a tier included.
    if (cornerLegs(tier)) anyCorner = true;
    const offset = (tier.story ?? 1) - baseStory;
    return {
      story: facts.story == null ? null : facts.story + offset,
      mix: panelMixOf(tier.panels),
    };
  });
  // Ascending story order (CONTEXT.md's Tier, and the settled #22 design):
  // a multi-tier unit authored — or later edited — out of story order
  // still hashes to the one cohort its physical stack belongs to. Every
  // entry shares the same null-ness (facts.story alone decides it, see
  // above), so this only ever reorders real numbers; the `?? 0` fallback
  // just keeps a from-null comparison stable (always 0) rather than
  // inventing an order for untraced tiers.
  tiers.sort((a, b) => (a.story ?? 0) - (b.story ?? 0));

  const signature: SignatureV1 = {
    v: 1,
    kind: config.kind,
    tiers,
    panelCount,
    movingCount,
    corner: anyCorner ? "corner" : "none",
    insetOutset: facts.insetOutset,
  };

  return { signature, sigKey: canonicalJson(signature) };
}
