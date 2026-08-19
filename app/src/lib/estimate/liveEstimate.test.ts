// The live cohort estimate for a drafted/catalog UnitConfig — no opening,
// no stored sig_key, just "if I built this right now, what would it cost."
// #21 (builder's live line) and #26 (catalog badges) both go through
// estimateForUnitConfig; these tests pin its two facts choices (story is
// always null; insetOutset comes off the config) and confirm weight never
// moves the cohort — the same rule signature.test.ts pins at the
// computeSignature layer, exercised here through the helper the UI calls.

import { describe, expect, it } from "vitest";
import { estimateForUnitConfig } from "./liveEstimate";
import { computeSignature } from "./signature";
import type { CohortEvidence } from "./cohorts";
import type { UnitConfig } from "../modelstudio/units";

const fixedWindow = (panels: number, over: Partial<UnitConfig> = {}): UnitConfig => ({
  kind: "window",
  heightMm: 1500,
  panels: Array.from({ length: panels }, () => ({
    widthMm: 900,
    mechanism: "fixed" as const,
  })),
  ...over,
});

function evidenceAt(
  config: UnitConfig,
  minutes: number,
  facts: { story: number | null; insetOutset: "inset" | "outset" | null },
): CohortEvidence {
  const { signature, sigKey } = computeSignature(config, facts);
  return { sigKey, signature, minutes };
}

describe("estimateForUnitConfig", () => {
  it("resolves against story: null — the honest 'untraced' cohort, same as a real job before it's traced", () => {
    const cfg = fixedWindow(3);
    const pool = [30, 35, 40, 45, 50].map((m) =>
      evidenceAt(cfg, m, { story: null, insetOutset: null }),
    );
    const est = estimateForUnitConfig(cfg, pool);
    expect(est.rung).toBe("exact");
    expect(est.minutes).toBe(40);
  });

  it("story-specific evidence doesn't satisfy the exact rung for a drafted unit, but kind+panels still answers", () => {
    const cfg = fixedWindow(3);
    const pool = [30, 35, 40, 45, 50].map((m) =>
      evidenceAt(cfg, m, { story: 1, insetOutset: null }),
    );
    // kind+panels ignores story entirely, so it still resolves — one rung down.
    const est = estimateForUnitConfig(cfg, pool);
    expect(est.rung).toBe("kind+panels");
    expect(est.minutes).toBe(40);
  });

  it("the 3-way control's value (config.insetOutset) is what the ladder matches on", () => {
    const cfg = fixedWindow(2, { insetOutset: "inset" });
    const insetPool = [10, 20, 30, 40, 50].map((m) =>
      evidenceAt(cfg, m, { story: null, insetOutset: "inset" }),
    );
    const nullPool = [10, 20, 30, 40, 50].map((m) =>
      evidenceAt(fixedWindow(2), m, { story: null, insetOutset: null }),
    );
    expect(estimateForUnitConfig(cfg, insetPool).rung).toBe("exact");
    // The null-insetOutset pool is a DIFFERENT cohort — falls back a rung.
    expect(estimateForUnitConfig(cfg, nullPool).rung).toBe("kind+panels");
  });

  it("a config with no insetOutset set matches the null cohort, same as before #23", () => {
    const cfg = fixedWindow(2);
    const pool = [10, 20, 30, 40, 50].map((m) =>
      evidenceAt(cfg, m, { story: null, insetOutset: null }),
    );
    expect(estimateForUnitConfig(cfg, pool).rung).toBe("exact");
  });

  it("weight never moves the cohort — #25's stored-not-signed rule, end to end", () => {
    const light = fixedWindow(3, { weightLb: 40 });
    const heavy = fixedWindow(3, { weightLb: 400 });
    const pool = [30, 35, 40, 45, 50].map((m) =>
      evidenceAt(fixedWindow(3), m, { story: null, insetOutset: null }),
    );
    expect(estimateForUnitConfig(light, pool)).toEqual(estimateForUnitConfig(heavy, pool));
  });

  it("no evidence at all: the honest 'no estimate yet', never a guess", () => {
    const est = estimateForUnitConfig(fixedWindow(3), []);
    expect(est.rung).toBe("none");
    expect(est.minutes).toBeNull();
    expect(est.label).toBe("no estimate yet · 0 installs recorded");
  });
});
