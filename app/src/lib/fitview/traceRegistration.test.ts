import { describe, expect, it } from "vitest";
import {
  applySimilarity,
  fitSimilarity,
  registerTrace,
  rmsResidual,
} from "./traceRegistration";

// A known transform: scale 2, rotate 90°, translate (10, 5).
// x' = -2y + 10 ; y' = 2x + 5  →  a = 0, b = 2.
const T = { a: 0, b: 2, tx: 10, ty: 5 };
const move = (p: { x: number; y: number }) => applySimilarity(T, p);

describe("fitSimilarity", () => {
  it("recovers an exact similarity from clean pairs", () => {
    const pts = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 30, y: 80 }];
    const pairs = pts.map((p) => ({ from: p, to: move(p) }));
    const t = fitSimilarity(pairs)!;
    expect(t.a).toBeCloseTo(0, 6);
    expect(t.b).toBeCloseTo(2, 6);
    expect(t.tx).toBeCloseTo(10, 6);
    expect(t.ty).toBeCloseTo(5, 6);
    expect(rmsResidual(pairs, t)).toBeCloseTo(0, 6);
  });

  it("refuses degenerate input", () => {
    expect(fitSimilarity([])).toBeNull();
    expect(fitSimilarity([{ from: { x: 1, y: 1 }, to: { x: 2, y: 2 } }])).toBeNull();
    // All source points coincident: no spread to solve against.
    expect(
      fitSimilarity([
        { from: { x: 5, y: 5 }, to: { x: 1, y: 1 } },
        { from: { x: 5, y: 5 }, to: { x: 9, y: 9 } },
      ]),
    ).toBeNull();
  });

  it("averages through noise rather than chasing it", () => {
    const pts = Array.from({ length: 10 }, (_, i) => ({
      x: (i % 5) * 50,
      y: Math.floor(i / 5) * 120,
    }));
    const pairs = pts.map((p, i) => {
      const q = move(p);
      return { from: p, to: { x: q.x + (i % 2 ? 1.5 : -1.5), y: q.y + (i % 3 ? 1 : -2) } };
    });
    const t = fitSimilarity(pairs)!;
    expect(t.b).toBeCloseTo(2, 1);
    expect(rmsResidual(pairs, t)).toBeLessThan(3);
  });
});

describe("registerTrace", () => {
  const trace = {
    cal: { ax: 0, ay: 0, bx: 100, by: 0, value: 5.5, unit: "ft" },
    polys: [[{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 60 }, { x: 0, y: 60 }]],
    dots: {
      "1": { x: 10, y: 0 },
      "2": { x: 90, y: 0 },
      "3": { x: 100, y: 30 },
      "4": { x: 50, y: 60 },
    },
  };

  it("moves polys, dots and the calibration line together", () => {
    const targets = Object.fromEntries(
      Object.entries(trace.dots).map(([id, p]) => [id, move(p)]),
    );
    const out = registerTrace(trace, targets, 2000)!;
    expect(out).not.toBeNull();
    expect(out.polys![0][1].x).toBeCloseTo(move({ x: 100, y: 0 }).x, 0);
    expect(out.dots!["4"].y).toBeCloseTo(move({ x: 50, y: 60 }).y, 0);
    expect(out.cal!.bx).toBeCloseTo(move({ x: 100, y: 0 }).x, 0);
    // The measured real-world value must survive untouched.
    expect(out.cal!.value).toBe(5.5);
    // Input untouched (pure).
    expect(trace.dots["1"].x).toBe(10);
  });

  it("needs at least 3 matched marks", () => {
    const targets = { "1": move(trace.dots["1"]), "2": move(trace.dots["2"]) };
    expect(registerTrace(trace, targets, 2000)).toBeNull();
  });

  it("rejects a fit the pairs themselves contradict", () => {
    // Three points that describe no single rigid move of this dot cloud.
    const targets = {
      "1": { x: 500, y: 500 },
      "2": { x: 0, y: 900 },
      "3": { x: 900, y: 0 },
      "4": { x: 20, y: 20 },
    };
    expect(registerTrace(trace, targets, 1000)).toBeNull();
  });
});
