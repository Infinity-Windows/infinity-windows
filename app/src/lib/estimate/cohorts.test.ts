// The ladder's honesty rules: rungs answer only at n ≥ 5, the label
// always carries rung + count, versions never mix, and below the ladder
// the only number allowed is a labelled manual guess.

import { describe, expect, it } from "vitest";
import { computeSignature } from "./signature";
import {
  estimateForSignature,
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
