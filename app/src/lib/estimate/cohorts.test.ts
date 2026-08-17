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
import type { UnitConfig } from "../modelstudio/units";

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
