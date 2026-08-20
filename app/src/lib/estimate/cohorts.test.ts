// The ladder's honesty rules: rungs answer only at n ≥ 5, the label
// always carries rung + count, versions never mix, and below the ladder
// the only number allowed is a labelled manual guess.

import { describe, expect, it } from "vitest";
import { computeSignature } from "./signature";
import {
  combineEvidence,
  describeSignature,
  estimateForSignature,
  estimateJobUnits,
  evidenceFromSessions,
  manualEstimate,
  type CohortEvidence,
} from "./cohorts";
import { configFromTiers, type UnitConfig } from "../modelstudio/units";

const fixedWindow = (panels: number): UnitConfig => ({
  kind: "window",
  heightMm: 1500,
  panels: Array.from({ length: panels }, () => ({
    widthMm: 900,
    mechanism: "fixed" as const,
  })),
});

const target = computeSignature(fixedWindow(3), { story: 1, insetOutset: null });

function evidence(
  config: UnitConfig,
  minutes: number,
  facts = { story: 1 as number | null, insetOutset: null },
): CohortEvidence {
  const { signature, sigKey } = computeSignature(config, facts);
  return { sigKey, signature, minutes };
}

describe("estimateForSignature", () => {
  it("answers on the exact rung at n ≥ 5, with the honesty label", () => {
    const pool = [30, 35, 40, 45, 50].map((m) => evidence(fixedWindow(3), m));
    const est = estimateForSignature(target, pool);
    expect(est.rung).toBe("exact");
    expect(est.n).toBe(5);
    expect(est.minutes).toBe(40); // median
    expect(est.label).toBe("this exact unit · n=5");
  });

  it("falls a rung when the exact cohort is thin", () => {
    const pool = [
      // Only 2 exact matches — under the threshold.
      evidence(fixedWindow(3), 40),
      evidence(fixedWindow(3), 44),
      // But plenty of same-kind-same-panel-count with a different story.
      ...[20, 25, 30, 35].map((m) => evidence(fixedWindow(3), m, { story: 2, insetOutset: null })),
    ];
    const est = estimateForSignature(target, pool);
    expect(est.rung).toBe("kind+panels");
    expect(est.n).toBe(6); // exact matches count on the broader rung too
    expect(est.label).toBe("same kind · 3 panels · n=6");
  });

  it("keeps falling: kind, then global", () => {
    const kindPool = [10, 20, 30, 40, 50].map((m) => evidence(fixedWindow(7), m));
    expect(estimateForSignature(target, kindPool).rung).toBe("kind");

    const door: UnitConfig = {
      kind: "door",
      heightMm: 2400,
      panels: [{ widthMm: 900, mechanism: "casement", direction: "left" }],
    };
    const globalPool = [10, 20, 30, 40, 50].map((m) => evidence(door, m));
    const est = estimateForSignature(target, globalPool);
    expect(est.rung).toBe("global");
    expect(est.label).toBe("all units · n=5");
  });

  it('below global n=5: "no estimate yet", never a computed number', () => {
    const est = estimateForSignature(target, [evidence(fixedWindow(3), 40)]);
    expect(est.rung).toBe("none");
    expect(est.minutes).toBeNull();
    expect(est.label).toBe("no estimate yet · 1 install recorded");
  });

  it("signature versions never mix on any rung", () => {
    const v2ish = [10, 20, 30, 40, 50].map((m) => {
      const e = evidence(fixedWindow(3), m);
      return { ...e, signature: { ...e.signature!, v: 2 as never } };
    });
    const est = estimateForSignature(target, v2ish);
    expect(est.rung).toBe("none");
    expect(est.n).toBe(0);
  });

  it("a manual guess wears its label", () => {
    const est = manualEstimate(90);
    expect(est.rung).toBe("manual");
    expect(est.minutes).toBe(90);
    expect(est.label).toBe("manual estimate — not from data");
  });
});

describe("evidenceFromSessions (per-unit samples, finished rounds only)", () => {
  const opening = (id: string) => ({
    id,
    sig_key: computeSignature(fixedWindow(3), { story: 1, insetOutset: null }).sigKey,
    signature: computeSignature(fixedWindow(3), { story: 1, insetOutset: null }).signature,
  });
  const row = (
    o: ReturnType<typeof opening>,
    startMin: number,
    endMin: number,
    over: Partial<{ role: "install" | "helper"; is_rework: boolean; end_reason: string | null }> = {},
  ) => ({
    started_at: new Date(Date.UTC(2026, 7, 17, 8, startMin)).toISOString(),
    ended_at: new Date(Date.UTC(2026, 7, 17, 8, endMin)).toISOString(),
    role: over.role ?? ("install" as const),
    is_rework: over.is_rework ?? false,
    end_reason: over.end_reason ?? null,
    opening: o,
  });

  it("sums install + helper minutes per unit; rework never counts; must be finished", () => {
    const a = opening("a");
    const b = opening("b");
    const out = evidenceFromSessions([
      row(a, 0, 30, { end_reason: "break" }),
      row(a, 35, 55, { end_reason: "finish" }),
      row(a, 10, 25, { role: "helper", end_reason: "complete" }),
      row(a, 60, 90, { is_rework: true, end_reason: "finish" }), // redo round — excluded
      row(b, 0, 40), // never finished — not evidence
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].minutes).toBe(30 + 20 + 15); // both install sessions + helper
  });
});

describe("combineEvidence (sessions win per unit, legacy fills gaps)", () => {
  it("never double-counts a unit and keeps legacy-only units", () => {
    const t = computeSignature(fixedWindow(3), { story: 1, insetOutset: null });
    const mk = (unitId: string, minutes: number): CohortEvidence => ({
      sigKey: t.sigKey,
      signature: t.signature,
      minutes,
      unitId,
    });
    const out = combineEvidence(
      [mk("a", 40)],
      [mk("a", 99), mk("b", 30)], // a's legacy figure must drop
    );
    expect(out.map((e) => [e.unitId, e.minutes])).toEqual([
      ["a", 40],
      ["b", 30],
    ]);
  });
});

describe("describeSignature", () => {
  it("reads like a row label", () => {
    const { signature } = computeSignature(
      {
        kind: "window",
        heightMm: 1500,
        panels: [
          { widthMm: 900, mechanism: "fixed" },
          { widthMm: 900, mechanism: "slider", direction: "left", slideCount: 2 },
        ],
        cornerAfterPanel: 0,
      },
      { story: 2, insetOutset: "outset" },
    );
    expect(describeSignature(signature)).toBe(
      "window · 2 panels (1 fixed + 1 sliderx2) · corner · story 2 · outset",
    );
  });

  // Studio 100x #22: the mix and panel count must fold EVERY tier, and
  // the story bit becomes a range once the tiers span more than one.
  it("folds every tier's mix and shows a story RANGE for a multi-tier unit", () => {
    const { signature } = computeSignature(
      configFromTiers(
        { kind: "window" },
        [
          { panels: [{ widthMm: 900, mechanism: "fixed" }], heightMm: 1500, cornerAfterPanel: null, story: 1 },
          {
            panels: [{ widthMm: 900, mechanism: "slider", direction: "left" }],
            heightMm: 1200,
            cornerAfterPanel: null,
            story: 2,
          },
          {
            panels: [{ widthMm: 900, mechanism: "fixed" }],
            heightMm: 1000,
            cornerAfterPanel: null,
            story: 3,
          },
        ],
      ),
      { story: 1, insetOutset: null },
    );
    expect(describeSignature(signature)).toBe("window · 3 panels (2 fixed + 1 slider) · stories 1-3");
  });

  it("a multi-tier unit whose tiers all resolve to the SAME real story shows a single story, not a range", () => {
    const { signature } = computeSignature(
      configFromTiers(
        { kind: "window" },
        [
          { panels: [{ widthMm: 900, mechanism: "fixed" }], heightMm: 1200, cornerAfterPanel: null, story: 1 },
          { panels: [{ widthMm: 900, mechanism: "hung" }], heightMm: 1200, cornerAfterPanel: null, story: 1 },
        ],
      ),
      { story: 4, insetOutset: null },
    );
    expect(describeSignature(signature)).toBe("window · 2 panels (1 fixed + 1 hung) · story 4");
  });
});

describe("estimateJobUnits (the foreman's job view)", () => {
  it("totals the remaining covered units, counts the honest gaps", () => {
    const t = computeSignature(fixedWindow(3), { story: 1, insetOutset: null });
    const pool = [30, 35, 40, 45, 50].map((m) => evidence(fixedWindow(3), m));
    const job = estimateJobUnits(
      [
        { id: "a", opening_code: "1", status: "assigned", sig_key: t.sigKey, signature: t.signature },
        { id: "b", opening_code: "2", status: "installed", sig_key: t.sigKey, signature: t.signature },
        { id: "c", opening_code: "3", status: "assigned", sig_key: null, signature: null },
      ],
      pool,
    );
    expect(job.rows).toHaveLength(3);
    expect(job.remainingMin).toBe(40); // only "1": median 40; installed "2" excluded
    expect(job.remainingCovered).toBe(1);
    expect(job.remainingUncovered).toBe(0);
    expect(job.unsigned).toBe(1);
    expect(job.rows[2].described).toBeNull();
  });
});

// Studio 100x #24 — the panel formula as the ladder's new TOP rung.
// panelFormula.test.ts owns the fit's own math (exact recovery, gates,
// degenerate declines, multiplier fallbacks); this block only proves the
// LADDER wiring: the rung slots in above "exact", falls through cleanly
// per-target when the fit can't price a mechanism, and — the explicit
// regression guard the task asked for — every rung below is byte-for-byte
// unchanged whenever the formula gate is closed, exactly as it was before
// this rung existed.
describe("estimateForSignature — the formula rung (Studio 100x #24)", () => {
  type Mix = { fixed?: number; slider?: number; casement?: number };
  const mixedWindow = (mix: Mix): UnitConfig => ({
    kind: "window",
    heightMm: 1500,
    panels: [
      ...Array.from({ length: mix.fixed ?? 0 }, () => ({ widthMm: 900, mechanism: "fixed" as const })),
      ...Array.from({ length: mix.slider ?? 0 }, () => ({
        widthMm: 900,
        mechanism: "slider" as const,
        direction: "left" as const,
      })),
      ...Array.from({ length: mix.casement ?? 0 }, () => ({
        widthMm: 900,
        mechanism: "casement" as const,
        direction: "left" as const,
      })),
    ],
  });

  /** 32 units over 3 mechanisms — clears the formula's own gate
   * (FORMULA_MIN_MECHANISMS / FORMULA_MIN_UNITS, panelFormula.ts).
   * Minutes are a clean `10 + 8 × panelCount` — this suite only checks
   * WHICH rung answers, never the fitted number's precision. */
  function formulaPool(): CohortEvidence[] {
    const baseline: Mix[] = [
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
    ];
    const upper: Mix[] = [
      { fixed: 3 },
      { slider: 2 },
      { casement: 1 },
      { fixed: 1, slider: 1 },
      { fixed: 2, casement: 1 },
      { casement: 3 },
    ];
    const insetOutset: Mix[] = [
      { fixed: 3 },
      { slider: 2 },
      { casement: 1 },
      { fixed: 1, slider: 1 },
      { fixed: 2, casement: 1 },
      { fixed: 1, casement: 2 },
    ];
    let id = 0;
    const row = (mix: Mix, story: number | null, io: "inset" | "outset" | null): CohortEvidence => {
      const { signature, sigKey } = computeSignature(mixedWindow(mix), { story, insetOutset: io });
      const panelCount = (mix.fixed ?? 0) + (mix.slider ?? 0) + (mix.casement ?? 0);
      return { sigKey, signature, minutes: 10 + panelCount * 8, unitId: `f${id++}` };
    };
    return [
      ...baseline.map((m) => row(m, 1, null)),
      ...upper.map((m) => row(m, 2, null)),
      ...insetOutset.map((m) => row(m, 1, "inset")),
      ...insetOutset.map((m) => row(m, 1, "outset")),
    ];
  }

  it("answers with the formula rung once its gate opens, honestly labelled", () => {
    const pool = formulaPool();
    expect(pool.length).toBe(32);
    const t = computeSignature(mixedWindow({ fixed: 2, slider: 1 }), { story: 1, insetOutset: null });
    const est = estimateForSignature(t, pool);
    expect(est.rung).toBe("formula");
    expect(est.n).toBe(32);
    expect(est.label).toBe("formula fit from 32 units");
    expect(est.minutes).not.toBeNull();
  });

  it("takes priority over an exact-signature match — the new TOP rung", () => {
    const t = computeSignature(mixedWindow({ fixed: 3 }), { story: 1, insetOutset: null });
    const pool = [
      ...formulaPool(),
      // Four MORE units at this exact signature, minutes consistent
      // with formulaPool()'s own generator — "exact" would clear its
      // own n≥5 (1 already in formulaPool's baseline + these 4) if the
      // formula rung didn't outrank it.
      ...[0, 1, 2, 3].map((i) => ({
        sigKey: t.sigKey,
        signature: t.signature,
        minutes: 10 + 8 * 3,
        unitId: `exact${i}`,
      })),
    ];
    expect(estimateForSignature(t, pool).rung).toBe("formula");
  });

  it("falls through to the existing ladder per-target when the mix needs a mechanism the fit never saw", () => {
    const pool = formulaPool(); // fixed / slider / casement only
    // outset (not the null baseline) so these rows never enter the
    // formula's own mechanism-cost fit — bifold genuinely stays unseen.
    const bifoldTarget = computeSignature(
      { kind: "window", heightMm: 1500, panels: [{ widthMm: 900, mechanism: "bifold", direction: "left" }] },
      { story: 1, insetOutset: "outset" },
    );
    const bifoldEvidence = [30, 32, 34, 36, 38].map((m, i) => ({
      sigKey: bifoldTarget.sigKey,
      signature: bifoldTarget.signature,
      minutes: m,
      unitId: `bifold${i}`,
    }));
    const est = estimateForSignature(bifoldTarget, [...pool, ...bifoldEvidence]);
    expect(est.rung).toBe("exact");
    expect(est.n).toBe(5);
    expect(est.minutes).toBe(34); // median of 30,32,34,36,38
  });

  it("REGRESSION PIN: every rung below is byte-for-byte unchanged when the formula gate is closed", () => {
    // Identical to this file's very first test — n=5 is nowhere near
    // the formula's own gate (FORMULA_MIN_UNITS=30), so it stays
    // silently absent and the ladder must resolve exactly as it always
    // has, down to the label string.
    const pool = [30, 35, 40, 45, 50].map((m) => evidence(fixedWindow(3), m));
    expect(estimateForSignature(target, pool)).toEqual({
      rung: "exact",
      n: 5,
      minutes: 40,
      label: "this exact unit · n=5",
    });
  });
});
