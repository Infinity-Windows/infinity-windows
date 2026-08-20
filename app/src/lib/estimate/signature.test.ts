// The signature is a GROUPING key: mirrors share a cohort, sizes never
// enter, and the canonical encoding is deterministic down to the byte —
// the spec's worked window-16 example is pinned verbatim.

import { describe, expect, it } from "vitest";
import { computeSignature, canonicalJson, sumMixes } from "./signature";
import { configFromTiers, type UnitConfig } from "../modelstudio/units";

const facts = { story: 1, insetOutset: null } as const;

/** Window 16 (BLACK22): five fixed panels, 90° corner after panel 1. */
const WINDOW_16: UnitConfig = {
  kind: "window",
  heightMm: 4559,
  panels: [768, 2248, 2286, 2229, 432].map((widthMm) => ({
    widthMm,
    mechanism: "fixed" as const,
  })),
  cornerAfterPanel: 0,
};

describe("computeSignature", () => {
  it("reproduces the spec's worked window-16 key verbatim", () => {
    const { sigKey } = computeSignature(WINDOW_16, facts);
    expect(sigKey).toBe(
      '{"corner":"corner","insetOutset":null,"kind":"window","movingCount":0,"panelCount":5,"tiers":[{"mix":{"fixed":5},"story":1}],"v":1}',
    );
  });

  it("XO and OX are mirror images — one cohort", () => {
    const xo: UnitConfig = {
      kind: "window",
      heightMm: 1500,
      panels: [
        { widthMm: 900, mechanism: "slider", direction: "right" },
        { widthMm: 900, mechanism: "fixed" },
      ],
    };
    const ox: UnitConfig = {
      ...xo,
      panels: [
        { widthMm: 900, mechanism: "fixed" },
        { widthMm: 900, mechanism: "slider", direction: "left" },
      ],
    };
    expect(computeSignature(xo, facts).sigKey).toBe(computeSignature(ox, facts).sigKey);
  });

  it("left and right corners are mirror images — one cohort", () => {
    const left = computeSignature({ ...WINDOW_16, cornerAfterPanel: 0 }, facts);
    const right = computeSignature({ ...WINDOW_16, cornerAfterPanel: 3 }, facts);
    expect(left.sigKey).toBe(right.sigKey);
    expect(left.signature.corner).toBe("corner");
    // An out-of-range corner index is no corner — same rule as the geometry.
    expect(
      computeSignature({ ...WINDOW_16, cornerAfterPanel: 4 }, facts).signature.corner,
    ).toBe("none");
  });

  it("widths never enter — a 2ft and 9ft version share a cohort", () => {
    const small = computeSignature(WINDOW_16, facts);
    const big = computeSignature(
      { ...WINDOW_16, panels: WINDOW_16.panels.map((p) => ({ ...p, widthMm: 2743 })) },
      facts,
    );
    expect(small.sigKey).toBe(big.sigKey);
  });

  it("slide counts split the tally; direction still doesn't", () => {
    const cfg: UnitConfig = {
      kind: "window",
      heightMm: 1800,
      panels: [
        { widthMm: 900, mechanism: "fixed" },
        { widthMm: 900, mechanism: "slider", direction: "left" },
        { widthMm: 900, mechanism: "slider", direction: "right", slideCount: 2 },
      ],
    };
    const { signature } = computeSignature(cfg, facts);
    expect(signature.tiers[0].mix).toEqual({ fixed: 1, slider: 1, sliderx2: 1 });
    expect(signature.movingCount).toBe(2);
  });

  it("null story and null insetOutset serialize as null — their own cohort", () => {
    const { sigKey, signature } = computeSignature(WINDOW_16, {
      story: null,
      insetOutset: null,
    });
    expect(signature.tiers[0].story).toBeNull();
    expect(sigKey).toContain('"story":null');
    expect(sigKey).toContain('"insetOutset":null');
    // Untraced ≠ story 1: different cohorts, honestly.
    expect(sigKey).not.toBe(computeSignature(WINDOW_16, facts).sigKey);
  });

  it("doors carry their kind", () => {
    const door: UnitConfig = {
      kind: "door",
      heightMm: 2400,
      panels: [
        { widthMm: 900, mechanism: "casement", direction: "left" },
        { widthMm: 900, mechanism: "casement", direction: "right" },
      ],
    };
    const { signature } = computeSignature(door, { story: 1, insetOutset: "outset" });
    expect(signature.kind).toBe("door");
    expect(signature.insetOutset).toBe("outset");
    expect(signature.tiers[0].mix).toEqual({ casement: 2 });
  });

  // #23: UnitConfig.insetOutset is the builder's 3-way control writing to
  // the catalog config-of-record. computeSignature must never read that
  // field itself — only the resolved UnitFacts a caller hands it — so
  // adding the field can't fracture a single existing cohort key.
  it("a config's OWN insetOutset never reaches computeSignature directly — #23's null-neutrality pin", () => {
    // Set on the CONFIG, but facts (what the caller actually resolved)
    // still says null — proves the config-level value is inert on its
    // own, byte for byte against the pinned window-16 key above.
    const withConfigField: UnitConfig = { ...WINDOW_16, insetOutset: "inset" };
    expect(computeSignature(withConfigField, facts).sigKey).toBe(
      '{"corner":"corner","insetOutset":null,"kind":"window","movingCount":0,"panelCount":5,"tiers":[{"mix":{"fixed":5},"story":1}],"v":1}',
    );
  });

  it("a config with no insetOutset key at all reproduces the exact pre-#23 key", () => {
    const bare: UnitConfig = { ...WINDOW_16 };
    expect("insetOutset" in bare).toBe(false);
    expect(computeSignature(bare, facts).sigKey).toBe(computeSignature(WINDOW_16, facts).sigKey);
  });
});

// Studio 100x #22: multi-tier units. SignatureV1.tiers has held an array
// since v1 shipped — a multi-tier unit just emits more than the one entry
// it always has, same v:1, no version bump (see UnitConfig.tiers,
// unitTiers, computeSignature's own doc comment).
describe("computeSignature — multi-tier (Studio 100x #22)", () => {
  /** Two tiers: 2 fixed panels at the base, 1 slider one floor up —
   * authored story 1 and 2, offset +1 from the base. */
  const TWO_TIER: UnitConfig = configFromTiers(
    { kind: "window" },
    [
      {
        panels: [
          { widthMm: 900, mechanism: "fixed" },
          { widthMm: 900, mechanism: "fixed" },
        ],
        heightMm: 1200,
        cornerAfterPanel: null,
        story: 1,
      },
      {
        panels: [{ widthMm: 900, mechanism: "slider", direction: "left" }],
        heightMm: 1000,
        cornerAfterPanel: null,
        story: 2,
      },
    ],
  );

  it("pins the exact multi-tier key — base story + offset per tier, panelCount/movingCount summed", () => {
    const { sigKey } = computeSignature(TWO_TIER, { story: 1, insetOutset: null });
    expect(sigKey).toBe(
      '{"corner":"none","insetOutset":null,"kind":"window","movingCount":1,"panelCount":3,"tiers":[{"mix":{"fixed":2},"story":1},{"mix":{"slider":1},"story":2}],"v":1}',
    );
  });

  it("an untraced opening (story: null) propagates null to EVERY tier, never a guess", () => {
    const { signature, sigKey } = computeSignature(TWO_TIER, { story: null, insetOutset: null });
    expect(signature.tiers.map((t) => t.story)).toEqual([null, null]);
    expect(sigKey).toBe(
      '{"corner":"none","insetOutset":null,"kind":"window","movingCount":1,"panelCount":3,"tiers":[{"mix":{"fixed":2},"story":null},{"mix":{"slider":1},"story":null}],"v":1}',
    );
  });

  it("a real base story of 5 carries every tier's offset forward (5, 6)", () => {
    const { signature } = computeSignature(TWO_TIER, { story: 5, insetOutset: null });
    expect(signature.tiers.map((t) => t.story)).toEqual([5, 6]);
  });

  it("tiers authored out of order still emit in ascending REAL story order, and a corner on a non-base tier still sets corner", () => {
    // Authored base(story1,+0) -> top(story3,+2) -> middle(story2,+1,
    // corner) — deliberately out of physical order.
    const THREE_TIER: UnitConfig = configFromTiers(
      { kind: "window", insetOutset: "outset" },
      [
        { panels: [{ widthMm: 900, mechanism: "fixed" }], heightMm: 1200, cornerAfterPanel: null, story: 1 },
        { panels: [{ widthMm: 900, mechanism: "fixed" }], heightMm: 1200, cornerAfterPanel: null, story: 3 },
        {
          panels: [
            { widthMm: 300, mechanism: "fixed" },
            { widthMm: 900, mechanism: "fixed" },
          ],
          heightMm: 1200,
          cornerAfterPanel: 0,
          story: 2,
        },
      ],
    );
    const { signature, sigKey } = computeSignature(THREE_TIER, { story: 5, insetOutset: "outset" });
    expect(signature.tiers.map((t) => t.story)).toEqual([5, 6, 7]); // ascending, not authored order
    expect(signature.corner).toBe("corner"); // the middle tier's corner counts for the whole unit
    expect(signature.panelCount).toBe(4);
    expect(sigKey).toBe(
      '{"corner":"corner","insetOutset":"outset","kind":"window","movingCount":0,"panelCount":4,"tiers":[{"mix":{"fixed":1},"story":5},{"mix":{"fixed":2},"story":6},{"mix":{"fixed":1},"story":7}],"v":1}',
    );
  });

  it("a config with a single-entry tiers array signs identically to the flat shape it collapses to", () => {
    const singleTierConfig = configFromTiers(
      { kind: "window" },
      [{ panels: WINDOW_16.panels, heightMm: WINDOW_16.heightMm, cornerAfterPanel: 0, story: 1 }],
    );
    expect("tiers" in singleTierConfig).toBe(false); // configFromTiers collapses it
    expect(computeSignature(singleTierConfig, facts).sigKey).toBe(
      computeSignature(WINDOW_16, facts).sigKey,
    );
  });
});

describe("sumMixes", () => {
  it("folds several tiers' mixes into one combined tally", () => {
    expect(sumMixes([{ fixed: 2 }, { slider: 1 }, { fixed: 1, casement: 3 }])).toEqual({
      fixed: 3,
      slider: 1,
      casement: 3,
    });
  });

  it("a single mix round-trips byte for byte — same keys, same order, same values", () => {
    const mix = { fixed: 2, sliderx2: 1 };
    expect(sumMixes([mix])).toEqual(mix);
    expect(Object.keys(sumMixes([mix]))).toEqual(Object.keys(mix));
  });

  it("an empty list sums to an empty mix", () => {
    expect(sumMixes([])).toEqual({});
  });
});

describe("canonicalJson", () => {
  it("sorts keys at every level and keeps array order", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } })).toBe(
      '{"a":{"c":[3,{"e":5,"f":4}],"d":2},"b":1}',
    );
  });
});
