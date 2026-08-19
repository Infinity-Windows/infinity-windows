// The SIGNATURE (CONTEXT.md): the structured, computed key a unit is
// grouped by. Cohorts of shared signatures are the estimating model's
// evidence pools. Spec: .scratch/signature/spec.md; ADR-0002 records why
// dimensions and handedness never enter it (sizes are continuous
// evidence; mirror images share a cohort).
//
// (The sibling file lib/estimate.ts is the older job-estimating
// heuristics; this directory is the per-unit cohort model.)

import { cornerLegs, slideCountOf, type UnitConfig } from "../modelstudio/units";

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
  /** v1: exactly one tier — Studio can't model more yet; the slot exists
   * so v2 recomputes forward instead of fracturing cohort history. */
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
 * PURE: a unit's signature from its UnitConfig-of-record plus the two
 * unit facts (story, inset/outset). Same widths, either corner side,
 * XO or OX — one cohort.
 */
export function computeSignature(
  config: UnitConfig,
  facts: UnitFacts,
): { signature: SignatureV1; sigKey: string } {
  const mix: Record<string, number> = {};
  let movingCount = 0;
  for (const p of config.panels) {
    const count = slideCountOf(p);
    const key = count > 1 ? `${p.mechanism}x${count}` : p.mechanism;
    mix[key] = (mix[key] ?? 0) + 1;
    if (p.mechanism !== "fixed") movingCount += 1;
  }

  const signature: SignatureV1 = {
    v: 1,
    kind: config.kind,
    tiers: [{ story: facts.story, mix }],
    panelCount: config.panels.length,
    movingCount,
    // Same validity rule the geometry uses: an out-of-range corner index
    // is no corner anywhere in the app.
    corner: cornerLegs(config) ? "corner" : "none",
    insetOutset: facts.insetOutset,
  };

  return { signature, sigKey: canonicalJson(signature) };
}
