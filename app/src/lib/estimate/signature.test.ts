// The signature is a GROUPING key: mirrors share a cohort, sizes never
// enter, and the canonical encoding is deterministic down to the byte —
// the spec's worked window-16 example is pinned verbatim.

import { describe, expect, it } from "vitest";
import { computeSignature, canonicalJson } from "./signature";
import type { UnitConfig } from "../modelstudio/units";

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

describe("canonicalJson", () => {
  it("sorts keys at every level and keeps array order", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } })).toBe(
      '{"a":{"c":[3,{"e":5,"f":4}],"d":2},"b":1}',
    );
  });
});
