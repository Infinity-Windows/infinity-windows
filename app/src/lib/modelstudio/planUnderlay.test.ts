import { describe, expect, it } from "vitest";
import {
  applyAffine,
  canonicalRing,
  fitAffine,
  storyUnderlayTransform,
  tracePolysForStory,
  type Pt,
} from "./planUnderlay";

// A known affine: scale ×3 on x, ×2 on y, a mild shear, translate (40,-15).
// x' = 3x + 0.5y + 40 ; y' = -0.2x + 2y - 15
const T = { a: 3, b: 0.5, c: -0.2, d: 2, tx: 40, ty: -15 };
const move = (p: Pt) => applyAffine(T, p);

describe("fitAffine", () => {
  it("maps a known square's corners exactly", () => {
    const square: Pt[] = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    const pairs = square.map((p) => ({ from: p, to: move(p) }));
    const fit = fitAffine(pairs)!;
    expect(fit).not.toBeNull();
    for (const p of square) {
      const got = applyAffine(fit, p);
      const want = move(p);
      expect(got.x).toBeCloseTo(want.x, 6);
      expect(got.y).toBeCloseTo(want.y, 6);
    }
  });

  it("recovers the exact coefficients from clean pairs", () => {
    const pts: Pt[] = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 30, y: 80 }, { x: -20, y: 40 }];
    const fit = fitAffine(pts.map((p) => ({ from: p, to: move(p) })))!;
    expect(fit.a).toBeCloseTo(T.a, 6);
    expect(fit.b).toBeCloseTo(T.b, 6);
    expect(fit.c).toBeCloseTo(T.c, 6);
    expect(fit.d).toBeCloseTo(T.d, 6);
    expect(fit.tx).toBeCloseTo(T.tx, 6);
    expect(fit.ty).toBeCloseTo(T.ty, 6);
  });

  it("refuses degenerate input", () => {
    expect(fitAffine([])).toBeNull();
    expect(
      fitAffine([
        { from: { x: 0, y: 0 }, to: { x: 0, y: 0 } },
        { from: { x: 1, y: 1 }, to: { x: 1, y: 1 } },
      ]),
    ).toBeNull();
    // Three collinear `from` points: no 2D spread to solve a plane against.
    expect(
      fitAffine([
        { from: { x: 0, y: 0 }, to: { x: 0, y: 0 } },
        { from: { x: 1, y: 1 }, to: { x: 1, y: 1 } },
        { from: { x: 2, y: 2 }, to: { x: 4, y: 4 } },
      ]),
    ).toBeNull();
    // Coincident `from` points: zero spread either way.
    expect(
      fitAffine([
        { from: { x: 5, y: 5 }, to: { x: 1, y: 1 } },
        { from: { x: 5, y: 5 }, to: { x: 9, y: 2 } },
        { from: { x: 5, y: 5 }, to: { x: 3, y: 7 } },
      ]),
    ).toBeNull();
  });
});

describe("canonicalRing", () => {
  const ring: Pt[] = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];

  it("is stable regardless of starting index", () => {
    const rotated = [ring[2], ring[3], ring[0], ring[1]];
    expect(canonicalRing(rotated)).toEqual(canonicalRing(ring));
  });

  it("is stable regardless of winding direction", () => {
    const reversed = [...ring].reverse();
    expect(canonicalRing(reversed)).toEqual(canonicalRing(ring));
  });

  it("leaves short input alone", () => {
    expect(canonicalRing([{ x: 1, y: 1 }, { x: 2, y: 2 }])).toEqual([
      { x: 1, y: 1 },
      { x: 2, y: 2 },
    ]);
  });
});

describe("storyUnderlayTransform", () => {
  // The trace poly (sheet pixels), drawn by a surveyor starting at an
  // arbitrary corner, in an arbitrary direction — exactly what a real trace
  // looks like (nobody starts clicking at the "lowest" corner on purpose).
  const tracePoly: Pt[] = [
    { x: 500, y: 300 }, // top-right-ish, drawn first
    { x: 500, y: 700 },
    { x: 100, y: 700 },
    { x: 100, y: 300 },
  ];
  // The SAME building's footprint in the Studio model, produced by
  // outerPolygons' own lowest-x/lowest-y walk — a DIFFERENT starting
  // corner and, since it walks the opposite way here, opposite winding —
  // exactly the "seam" canonicalRing exists to close. Model cm = (px-300,
  // py-500)*0.6, i.e. a real (non-identity) affine relates the two spaces.
  const toModel = (p: Pt): Pt => ({ x: (p.x - 300) * 0.6, y: (p.y - 500) * 0.6 });
  const modelPoly: Pt[] = [tracePoly[2], tracePoly[1], tracePoly[0], tracePoly[3]].map(toModel);

  it("fits a working transform even when the two rings start and wind differently", () => {
    const fit = storyUnderlayTransform([tracePoly], [modelPoly])!;
    expect(fit).not.toBeNull();
    for (const p of tracePoly) {
      const got = applyAffine(fit, p);
      const want = toModel(p);
      expect(got.x).toBeCloseTo(want.x, 4);
      expect(got.y).toBeCloseTo(want.y, 4);
    }
  });

  it("fails without canonicalizing first (proves the seam is real)", () => {
    // The naive pairing this fixes: zip the two arrays by raw index. Two of
    // these four corners land on the wrong partner, so the "fit" recovered
    // is not the real 0.6 scale toModel actually uses.
    const naive = fitAffineNaive(tracePoly, modelPoly);
    expect(naive.a).not.toBeCloseTo(0.6, 1);
  });

  it("returns null when the MODEL has more masses than the trace", () => {
    // The model can't have grown a building the trace never saw — no
    // reading exists for this direction, unlike the trace-has-more case
    // below (a traced interior partition the model never modeled).
    expect(storyUnderlayTransform([tracePoly], [modelPoly, modelPoly])).toBeNull();
  });

  it("drops an interior partition when the trace has one more mass than the model (Mad Moose)", () => {
    // Real bug (Mad Moose, 2026-09-01): a traced story can carry an
    // interior partition as its own closed ring — the tracer lets a
    // surveyor draw whatever they see — while outerPolygons NEVER emits
    // one for the model side ("interior walls never leak into the
    // silhouette"). A thin sliver traced well inside the exterior
    // rectangle must be dropped, not treated as a second real mass.
    const partition: Pt[] = [
      { x: 250, y: 400 },
      { x: 250, y: 600 },
      { x: 260, y: 600 },
      { x: 260, y: 400 },
    ];
    const fit = storyUnderlayTransform([tracePoly, partition], [modelPoly])!;
    expect(fit).not.toBeNull();
    for (const p of tracePoly) {
      const got = applyAffine(fit, p);
      const want = toModel(p);
      expect(got.x).toBeCloseTo(want.x, 4);
      expect(got.y).toBeCloseTo(want.y, 4);
    }
  });

  it("drops a 5-point interior partition the same way (Mad Moose's actual shape)", () => {
    // Mad Moose's real Ground story: a 4-point exterior rect plus a
    // 5-point partition (an L-shaped interior wall run, not a simple
    // rectangle) — corner count alone can't be the filter, only area.
    const fivePointPartition: Pt[] = [
      { x: 200, y: 350 },
      { x: 200, y: 650 },
      { x: 300, y: 650 },
      { x: 300, y: 500 },
      { x: 350, y: 500 },
    ];
    const fit = storyUnderlayTransform([tracePoly, fivePointPartition], [modelPoly]);
    expect(fit).not.toBeNull(); // the larger 4-pt exterior still wins and pairs fine
  });

  it("returns null when a mass's corner count changed since the seed", () => {
    const extraCorner = [...modelPoly, { x: 0, y: 0 }];
    expect(storyUnderlayTransform([tracePoly], [extraCorner])).toBeNull();
  });

  it("returns null with no masses", () => {
    expect(storyUnderlayTransform([], [])).toBeNull();
    expect(storyUnderlayTransform([[{ x: 0, y: 0 }, { x: 1, y: 1 }]], [])).toBeNull();
  });
});

function fitAffineNaive(trace: Pt[], model: Pt[]) {
  return fitAffine(trace.map((p, i) => ({ from: p, to: model[i] })))!;
}

describe("tracePolysForStory", () => {
  it("reads the matching story's polys", () => {
    const trace = {
      stories: [
        { polys: [[{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }]] },
        { polys: [[{ x: 9, y: 9 }, { x: 8, y: 9 }, { x: 8, y: 8 }]] },
      ],
    };
    expect(tracePolysForStory(trace, 1)).toEqual(trace.stories[1].polys);
  });

  it("falls back to the legacy top-level polys for floor 0 only", () => {
    const trace = { polys: [[{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }]] };
    expect(tracePolysForStory(trace, 0)).toEqual(trace.polys);
    expect(tracePolysForStory(trace, 1)).toBeNull();
  });

  it("degrades to null rather than crashing on a missing or malformed trace", () => {
    expect(tracePolysForStory(undefined, 0)).toBeNull();
    expect(tracePolysForStory(null, 0)).toBeNull();
    expect(tracePolysForStory({}, 0)).toBeNull();
    expect(tracePolysForStory({ stories: [] }, 0)).toBeNull();
    expect(tracePolysForStory("not an object", 0)).toBeNull();
  });
});
