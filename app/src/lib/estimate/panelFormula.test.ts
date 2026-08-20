// Studio 100x #24 — the panel-level formula's own rules: exact recovery
// on clean synthetic evidence, the two gates (unit count, mechanism
// spread), the sanity bounds that make a degenerate fit decline instead
// of showing nonsense, and the "1.0 unless both sides of the split have
// evidence" rule for the two multipliers. cohorts.test.ts pins the
// ladder-integration side (rung ordering, the regression guard for when
// the gate is closed).

import { describe, expect, it } from "vitest";
import { computeSignature } from "./signature";
import {
  FORMULA_MIN_MECHANISMS,
  FORMULA_MIN_UNITS,
  MAX_MECHANISM_MIN,
  MAX_MULTIPLIER,
  MIN_MULTIPLIER,
  estimateForSignatureViaFormula,
  estimateViaFormula,
  fitPanelFormula,
  type PanelFormulaFit,
} from "./panelFormula";
import type { CohortEvidence } from "./cohorts";
import type { UnitConfig } from "../modelstudio/units";

// ------------------------------------------------------------- fixtures

type Mix = { fixed?: number; slider?: number; casement?: number };

function unitConfig(mix: Mix): UnitConfig {
  const panels: UnitConfig["panels"] = [];
  for (let i = 0; i < (mix.fixed ?? 0); i++) panels.push({ widthMm: 900, mechanism: "fixed" });
  for (let i = 0; i < (mix.slider ?? 0); i++)
    panels.push({ widthMm: 900, mechanism: "slider", direction: "left" });
  for (let i = 0; i < (mix.casement ?? 0); i++)
    panels.push({ widthMm: 900, mechanism: "casement", direction: "left" });
  return { kind: "window", heightMm: 1500, panels };
}

/** Ground truth the "clean" pools below are generated from — never read
 * by panelFormula.ts itself, only by this file's own trueMinutes, so
 * recovering it back out of fitPanelFormula is a real check, not a
 * tautology. */
const TRUTH = {
  setupMin: 12,
  mech: { fixed: 8, slider: 15, casement: 20 } as Record<string, number>,
  storyFactor: 1.3,
  insetFactor: 1.15,
  outsetFactor: 0.9,
};

function panelSum(mix: Mix, mech: Record<string, number> = TRUTH.mech): number {
  return (mix.fixed ?? 0) * mech.fixed + (mix.slider ?? 0) * mech.slider + (mix.casement ?? 0) * mech.casement;
}

function trueMinutes(mix: Mix, story: number | null, io: "inset" | "outset" | null): number {
  const storyMul = story != null && story > 1 ? TRUTH.storyFactor : 1;
  const ioMul = io === "inset" ? TRUTH.insetFactor : io === "outset" ? TRUTH.outsetFactor : 1;
  return TRUTH.setupMin + storyMul * ioMul * panelSum(mix);
}

let idCounter = 0;

function evidenceRow(
  mix: Mix,
  story: number | null,
  io: "inset" | "outset" | null,
  minutes: number = trueMinutes(mix, story, io),
): CohortEvidence {
  const { signature, sigKey } = computeSignature(unitConfig(mix), { story, insetOutset: io });
  return { sigKey, signature, minutes, unitId: `u${idCounter++}` };
}

// 16 "purely baseline" shapes (story 1, insetOutset null) — varied enough
// that the 4-unknown system (setup + 3 mechanisms) is well-conditioned,
// and past MIN_SPLIT_N (15) since baseline is also the "isBaseline" side
// of every story/inset/outset split below.
const BASELINE_MIXES: Mix[] = [
  { fixed: 3 },
  { slider: 2 },
  { casement: 1 },
  { fixed: 1, slider: 1 },
  { fixed: 1, casement: 1 },
  { slider: 1, casement: 1 },
  { fixed: 2, slider: 1, casement: 1 },
  { fixed: 4 },
  { slider: 3 },
  { casement: 2 },
  { fixed: 5 },
  { fixed: 1, slider: 2 },
  { fixed: 2, casement: 2 },
  { fixed: 1, slider: 1, casement: 1 },
  { slider: 4 },
  { casement: 3 },
];
/** Cycle a small set of template mixes up to `count` rows. The upper /
 * inset / outset categories only need enough POINTS to clear
 * panelFormula.ts's MIN_SPLIT_N (15) for their median-ratio fit — unlike
 * baseline, they don't need to independently solve their own linear
 * system, so repeats are fine. */
function cycle(templates: readonly Mix[], count: number): Mix[] {
  return Array.from({ length: count }, (_, i) => templates[i % templates.length]);
}

const MIX_TEMPLATES: Mix[] = [
  { fixed: 3 },
  { slider: 2 },
  { casement: 1 },
  { fixed: 1, slider: 1 },
  { fixed: 2, casement: 1 },
  { fixed: 1, casement: 2 },
];

// 16 each — past MIN_SPLIT_N (15, panelFormula.ts) so the "clean" pool
// below actually fits all three multipliers, not just 1.0 fallbacks.
const UPPER_MIXES: Mix[] = cycle(MIX_TEMPLATES, 16);
const INSET_MIXES: Mix[] = cycle(MIX_TEMPLATES, 16);
const OUTSET_MIXES: Mix[] = cycle(MIX_TEMPLATES, 16);

/** 16 + 16 + 16 + 16 = 64 units, 3 mechanisms — comfortably past every
 * gate (FORMULA_MIN_UNITS/FORMULA_MIN_MECHANISMS, and MIN_SPLIT_N on
 * every split). */
function cleanPool(): CohortEvidence[] {
  idCounter = 0;
  return [
    ...BASELINE_MIXES.map((m) => evidenceRow(m, 1, null)),
    ...UPPER_MIXES.map((m) => evidenceRow(m, 2, null)),
    ...INSET_MIXES.map((m) => evidenceRow(m, 1, "inset")),
    ...OUTSET_MIXES.map((m) => evidenceRow(m, 1, "outset")),
  ];
}

// ------------------------------------------------------- exact recovery

describe("fitPanelFormula — exact recovery on clean synthetic evidence", () => {
  it("recovers setup, every mechanism cost, and all three multipliers exactly", () => {
    const fit = fitPanelFormula(cleanPool());
    expect(fit).not.toBeNull();
    expect(fit!.fittedFrom).toBe(64);
    expect(fit!.setupMin).toBeCloseTo(TRUTH.setupMin, 4);
    expect(fit!.mechanismMinPerPanel.fixed).toBeCloseTo(TRUTH.mech.fixed, 4);
    expect(fit!.mechanismMinPerPanel.slider).toBeCloseTo(TRUTH.mech.slider, 4);
    expect(fit!.mechanismMinPerPanel.casement).toBeCloseTo(TRUTH.mech.casement, 4);
    expect(fit!.storyFactor).toBeCloseTo(TRUTH.storyFactor, 4);
    expect(fit!.insetFactor).toBeCloseTo(TRUTH.insetFactor, 4);
    expect(fit!.outsetFactor).toBeCloseTo(TRUTH.outsetFactor, 4);
  });

  it("is deterministic and order-independent (pure function of the evidence set)", () => {
    const pool = cleanPool();
    const reversed = [...pool].reverse();
    expect(fitPanelFormula(pool)).toEqual(fitPanelFormula(reversed));
  });
});

describe("fitPanelFormula — configsByUnit", () => {
  it("prefers a resolved UnitConfig's panels over a stale stored signature mix", () => {
    idCounter = 0;
    const configsByUnit = new Map<string, UnitConfig>();
    const pool: CohortEvidence[] = [];
    const addRow = (mix: Mix, story: number | null, io: "inset" | "outset" | null) => {
      // Every stored signature deliberately says "1 fixed panel" — as if
      // the config changed since signatureSync last ran — while minutes
      // and configsByUnit both carry the TRUE, varied mix.
      const stale = computeSignature(unitConfig({ fixed: 1 }), { story, insetOutset: io });
      const unitId = `u${idCounter++}`;
      configsByUnit.set(unitId, unitConfig(mix));
      pool.push({
        sigKey: stale.sigKey,
        signature: stale.signature,
        minutes: trueMinutes(mix, story, io),
        unitId,
      });
    };
    BASELINE_MIXES.forEach((m) => addRow(m, 1, null));
    UPPER_MIXES.forEach((m) => addRow(m, 2, null));
    INSET_MIXES.forEach((m) => addRow(m, 1, "inset"));
    OUTSET_MIXES.forEach((m) => addRow(m, 1, "outset"));

    // Without configsByUnit: every row's mix reads as the stale "1
    // fixed panel" — only one mechanism ever appears, so the
    // ≥3-distinct-mechanisms gate itself fails outright.
    expect(fitPanelFormula(pool)).toBeNull();

    // With configsByUnit supplying the real, varied panels, the fit
    // recovers ground truth exactly — proving the join prefers the
    // resolved config over the (possibly stale) stored signature.
    const fit = fitPanelFormula(pool, configsByUnit);
    expect(fit).not.toBeNull();
    expect(fit!.setupMin).toBeCloseTo(TRUTH.setupMin, 4);
    expect(fit!.mechanismMinPerPanel.slider).toBeCloseTo(TRUTH.mech.slider, 4);
    expect(fit!.mechanismMinPerPanel.casement).toBeCloseTo(TRUTH.mech.casement, 4);
  });
});

// -------------------------------------------------------------- the gate

describe("fitPanelFormula — gate refusals", () => {
  it(`declines below FORMULA_MIN_UNITS (${FORMULA_MIN_UNITS}) even with 3 mechanisms present`, () => {
    idCounter = 0;
    const pool = [
      ...BASELINE_MIXES.map((m) => evidenceRow(m, 1, null)), // 16
      ...UPPER_MIXES.slice(0, 6).map((m) => evidenceRow(m, 2, null)), // 6 -> 22 total
    ];
    expect(pool.length).toBeLessThan(FORMULA_MIN_UNITS);
    expect(fitPanelFormula(pool)).toBeNull();
  });

  it(`declines below FORMULA_MIN_MECHANISMS (${FORMULA_MIN_MECHANISMS}) even with 30+ units`, () => {
    idCounter = 0;
    const twoMechMixes: Mix[] = [
      { fixed: 1 },
      { fixed: 2 },
      { slider: 1 },
      { slider: 2 },
      { fixed: 1, slider: 1 },
    ];
    const pool: CohortEvidence[] = [];
    for (let i = 0; i < 32; i++) pool.push(evidenceRow(twoMechMixes[i % twoMechMixes.length], 1, null));
    expect(pool.length).toBeGreaterThanOrEqual(FORMULA_MIN_UNITS);
    expect(fitPanelFormula(pool)).toBeNull();
  });

  it("a version-2 (or otherwise non-v1) signature is not evidence — never counted toward the gate", () => {
    idCounter = 0;
    const pool = cleanPool().map((e) => ({
      ...e,
      signature: e.signature ? { ...e.signature, v: 2 as never } : null,
    }));
    expect(fitPanelFormula(pool)).toBeNull();
  });

  it("a unit repeated across two evidence rows (e.g. sessions + legacy) is never double-counted", () => {
    idCounter = 0;
    const pool = cleanPool();
    // Duplicate the first 10 rows under the SAME unitId with different
    // minutes — trainingRowsFrom must keep only the first.
    const dupes = pool.slice(0, 10).map((e) => ({ ...e, minutes: e.minutes + 999 }));
    const fit = fitPanelFormula([...pool, ...dupes]);
    expect(fit).not.toBeNull();
    expect(fit!.fittedFrom).toBe(64); // not 74
  });
});

// --------------------------------------------------------- degenerate declines

describe("fitPanelFormula — degenerate declines", () => {
  it("declines when the baseline system is singular (collinear panel counts)", () => {
    idCounter = 0;
    const pool: CohortEvidence[] = [];
    for (let n = 1; n <= 14; n++) {
      // fixed, slider and casement always move together — the three
      // mechanism columns are linearly dependent, so their individual
      // costs can't be separated from each other.
      pool.push(evidenceRow({ fixed: n, slider: n, casement: n }, 1, null));
    }
    pool.push(...UPPER_MIXES.map((m) => evidenceRow(m, 2, null)));
    pool.push(...INSET_MIXES.map((m) => evidenceRow(m, 1, "inset")));
    pool.push(...OUTSET_MIXES.map((m) => evidenceRow(m, 1, "outset")));
    expect(pool.length).toBe(62);
    expect(fitPanelFormula(pool)).toBeNull();
  });

  it("declines when too few baseline rows exist to solve for the mechanisms observed there", () => {
    idCounter = 0;
    // Only 2 purely-baseline rows but 3 mechanisms appear there — fewer
    // rows than unknowns (setup + 3 mechanisms = 4).
    const pool: CohortEvidence[] = [
      evidenceRow({ fixed: 1, slider: 1, casement: 1 }, 1, null),
      evidenceRow({ fixed: 2, slider: 1, casement: 1 }, 1, null),
      ...UPPER_MIXES.map((m) => evidenceRow(m, 2, null)),
      ...INSET_MIXES.map((m) => evidenceRow(m, 1, "inset")),
    ];
    expect(pool.length).toBeGreaterThanOrEqual(FORMULA_MIN_UNITS);
    expect(fitPanelFormula(pool)).toBeNull();
  });

  it("declines when the fit implies a negative setup", () => {
    idCounter = 0;
    // A perfect line y = 3*count - 10 (intercept -10) over "fixed"-only
    // baseline rows, all positive minutes despite the negative intercept.
    const pool: CohortEvidence[] = [];
    for (let count = 4; count <= 17; count++) {
      pool.push(evidenceRow({ fixed: count }, 1, null, 3 * count - 10));
    }
    pool.push(...UPPER_MIXES.map((m) => evidenceRow(m, 2, null)));
    pool.push(...INSET_MIXES.map((m) => evidenceRow(m, 1, "inset")));
    pool.push(...OUTSET_MIXES.map((m) => evidenceRow(m, 1, "outset")));
    expect(pool.every((e) => e.minutes > 0)).toBe(true);
    expect(fitPanelFormula(pool)).toBeNull();
  });

  it("declines when a mechanism's per-panel cost exceeds the sanity bound", () => {
    idCounter = 0;
    const absurdSlope = MAX_MECHANISM_MIN + 120;
    const pool: CohortEvidence[] = [];
    for (let count = 1; count <= 14; count++) {
      pool.push(evidenceRow({ fixed: count }, 1, null, 5 + absurdSlope * count));
    }
    pool.push(...UPPER_MIXES.map((m) => evidenceRow(m, 2, null)));
    pool.push(...INSET_MIXES.map((m) => evidenceRow(m, 1, "inset")));
    pool.push(...OUTSET_MIXES.map((m) => evidenceRow(m, 1, "outset")));
    expect(fitPanelFormula(pool)).toBeNull();
  });

  it("declines when a modifier's implied multiplier is absurdly high", () => {
    idCounter = 0;
    const absurdRatio = MAX_MULTIPLIER + 15;
    const pool: CohortEvidence[] = [
      ...BASELINE_MIXES.map((m) => evidenceRow(m, 1, null)),
      ...UPPER_MIXES.map((m) => evidenceRow(m, 2, null, TRUTH.setupMin + panelSum(m) * absurdRatio)),
      ...INSET_MIXES.map((m) => evidenceRow(m, 1, "inset")), // otherwise fine
      ...OUTSET_MIXES.map((m) => evidenceRow(m, 1, "outset")), // otherwise fine
    ];
    // The WHOLE fit declines — a bad story factor isn't quarantined
    // while everything else ships.
    expect(fitPanelFormula(pool)).toBeNull();
  });

  it("declines when a modifier's implied multiplier is absurdly low", () => {
    idCounter = 0;
    const pool: CohortEvidence[] = [
      ...BASELINE_MIXES.map((m) => evidenceRow(m, 1, null)),
      ...UPPER_MIXES.map((m) => evidenceRow(m, 2, null)),
      ...INSET_MIXES.map((m) => evidenceRow(m, 1, "inset")),
      // A claimed speedup well under MIN_MULTIPLIER.
      ...OUTSET_MIXES.map((m) =>
        evidenceRow(m, 1, "outset", TRUTH.setupMin + panelSum(m) * (MIN_MULTIPLIER / 20)),
      ),
    ];
    expect(fitPanelFormula(pool)).toBeNull();
  });
});

// --------------------------------------------------- multiplier 1.0 fallbacks

describe("fitPanelFormula — multiplier 1.0 fallbacks", () => {
  it("storyFactor is exactly 1.0 with zero upper-story evidence, rest of the fit unaffected", () => {
    idCounter = 0;
    const pool = [
      ...BASELINE_MIXES.map((m) => evidenceRow(m, 1, null)), // 16
      ...INSET_MIXES.map((m) => evidenceRow(m, 1, "inset")), // 16
      ...OUTSET_MIXES.map((m) => evidenceRow(m, 1, "outset")), // 16 -> 48 total
    ];
    expect(pool.length).toBeGreaterThanOrEqual(FORMULA_MIN_UNITS);
    const fit = fitPanelFormula(pool);
    expect(fit).not.toBeNull();
    expect(fit!.storyFactor).toBe(1);
    expect(fit!.insetFactor).toBeCloseTo(TRUTH.insetFactor, 4);
    expect(fit!.outsetFactor).toBeCloseTo(TRUTH.outsetFactor, 4);
  });

  it("insetFactor and outsetFactor are exactly 1.0 with zero inset/outset evidence", () => {
    idCounter = 0;
    const pool = [
      ...BASELINE_MIXES.map((m) => evidenceRow(m, 1, null)), // 16
      ...UPPER_MIXES.map((m) => evidenceRow(m, 2, null)), // 16
      ...UPPER_MIXES.map((m) => evidenceRow(m, 3, null)), // 16 more (story 3 is "upper" too)
    ];
    expect(pool.length).toBeGreaterThanOrEqual(FORMULA_MIN_UNITS);
    const fit = fitPanelFormula(pool);
    expect(fit).not.toBeNull();
    expect(fit!.insetFactor).toBe(1);
    expect(fit!.outsetFactor).toBe(1);
    expect(fit!.storyFactor).toBeCloseTo(TRUTH.storyFactor, 4);
  });

  it("a split below MIN_SPLIT_N (15) still falls back to 1.0 rather than a noisy few-point estimate", () => {
    idCounter = 0;
    const sparseUpper = UPPER_MIXES.slice(0, 11); // 11 < 15
    const pool = [
      ...BASELINE_MIXES.map((m) => evidenceRow(m, 1, null)), // 16
      ...sparseUpper.map((m) => evidenceRow(m, 2, null)), // 11
      ...INSET_MIXES.map((m) => evidenceRow(m, 1, "inset")), // 16
      ...OUTSET_MIXES.map((m) => evidenceRow(m, 1, "outset")), // 16 -> 59 total
    ];
    expect(pool.length).toBeGreaterThanOrEqual(FORMULA_MIN_UNITS);
    const fit = fitPanelFormula(pool);
    expect(fit).not.toBeNull();
    expect(fit!.storyFactor).toBe(1);
    // inset/outset still have 16 each — comfortably fit.
    expect(fit!.insetFactor).toBeCloseTo(TRUTH.insetFactor, 4);
    expect(fit!.outsetFactor).toBeCloseTo(TRUTH.outsetFactor, 4);
  });
});

// ---------------------------------------------------------- pure estimating

describe("estimateViaFormula (config-level, e.g. the Studio builder's live line)", () => {
  const fit: PanelFormulaFit = {
    setupMin: 10,
    mechanismMinPerPanel: { fixed: 5, slider: 12 },
    storyFactor: 1.4,
    insetFactor: 1.2,
    outsetFactor: 0.8,
    fittedFrom: 40,
  };

  it("sums setup + mechanism costs for a plain config (no insetOutset — factor 1.0)", () => {
    const config = unitConfig({ fixed: 2, slider: 1 });
    expect(estimateViaFormula(config, fit)).toBeCloseTo(10 + 2 * 5 + 1 * 12, 6); // 32
  });

  it("applies insetFactor / outsetFactor off config.insetOutset", () => {
    const inset: UnitConfig = { ...unitConfig({ fixed: 2 }), insetOutset: "inset" };
    const outset: UnitConfig = { ...unitConfig({ fixed: 2 }), insetOutset: "outset" };
    expect(estimateViaFormula(inset, fit)).toBeCloseTo(10 + 1.2 * 10, 6); // 22
    expect(estimateViaFormula(outset, fit)).toBeCloseTo(10 + 0.8 * 10, 6); // 18
  });

  it("never applies storyFactor — a drafted config has no traced story", () => {
    // Same math with or without insetOutset unset: baseline (1.0) both axes.
    const config = unitConfig({ fixed: 3 });
    expect(estimateViaFormula(config, fit)).toBeCloseTo(10 + 3 * 5, 6); // 25
  });

  it("returns null when the config uses a mechanism the fit never saw", () => {
    const withBifold: UnitConfig = {
      kind: "window",
      heightMm: 1500,
      panels: [{ widthMm: 900, mechanism: "bifold", direction: "left" }],
    };
    expect(estimateViaFormula(withBifold, fit)).toBeNull();
  });
});

describe("estimateForSignatureViaFormula (signature-level, e.g. the ladder's own call)", () => {
  const fit: PanelFormulaFit = {
    setupMin: 10,
    mechanismMinPerPanel: { fixed: 5, slider: 12 },
    storyFactor: 1.4,
    insetFactor: 1.2,
    outsetFactor: 0.8,
    fittedFrom: 40,
  };

  it("applies storyFactor for a traced story > 1", () => {
    const { signature } = computeSignature(unitConfig({ fixed: 2 }), { story: 3, insetOutset: null });
    expect(estimateForSignatureViaFormula(signature, fit)).toBeCloseTo(10 + 1.4 * 10, 6); // 24
  });

  it("story 1 and untraced (null) both resolve to the 1.0 baseline", () => {
    const { signature: ground } = computeSignature(unitConfig({ fixed: 2 }), {
      story: 1,
      insetOutset: null,
    });
    const { signature: untraced } = computeSignature(unitConfig({ fixed: 2 }), {
      story: null,
      insetOutset: null,
    });
    expect(estimateForSignatureViaFormula(ground, fit)).toBeCloseTo(20, 6);
    expect(estimateForSignatureViaFormula(untraced, fit)).toBeCloseTo(20, 6);
  });

  it("returns null for a mechanism the fit never saw", () => {
    const { signature } = computeSignature(
      { kind: "window", heightMm: 1500, panels: [{ widthMm: 900, mechanism: "hung" }] },
      { story: 1, insetOutset: null },
    );
    expect(estimateForSignatureViaFormula(signature, fit)).toBeNull();
  });
});
