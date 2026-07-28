import { describe, expect, it } from "vitest";
import {
  bboxToPixelRect,
  invertLineArt,
  isDrawingStale,
  padBbox,
  validateBbox,
  type Bbox,
} from "./markDrawing";

// Real Claude VISION output for page 1 of the STRATA shop drawing for
// Smith / PV Townhomes Bldg 14 — the elevation drawing of each mark, as
// normalized [x0,y0,x1,y1] with a top-left origin. Ground truth for the crop.
const PAGE_1_BOXES: Record<string, Bbox> = {
  "1": [0.217, 0.128, 0.3, 0.29],
  "2": [0.635, 0.055, 0.758, 0.253],
  "3": [0.11, 0.485, 0.256, 0.69],
  "4A": [0.59, 0.462, 0.672, 0.622],
  "4B": [0.805, 0.462, 0.89, 0.622],
};

describe("validateBbox", () => {
  it("accepts every real page-1 box unchanged", () => {
    for (const [mark, box] of Object.entries(PAGE_1_BOXES)) {
      expect(validateBbox(box), `mark ${mark}`).toEqual(box);
    }
  });

  it("accepts numeric strings (jsonb / LLM output can be loose)", () => {
    expect(validateBbox(["0.217", "0.128", "0.3", "0.29"])).toEqual([
      0.217, 0.128, 0.3, 0.29,
    ]);
  });

  it("rejects the wrong arity", () => {
    expect(validateBbox([0.1, 0.2, 0.3])).toBeNull();
    expect(validateBbox([0.1, 0.2, 0.3, 0.4, 0.5])).toBeNull();
    expect(validateBbox([])).toBeNull();
  });

  it("rejects non-arrays and junk", () => {
    expect(validateBbox(null)).toBeNull();
    expect(validateBbox(undefined)).toBeNull();
    expect(validateBbox("0.1,0.2,0.3,0.4")).toBeNull();
    expect(validateBbox({ x0: 0.1, y0: 0.2, x1: 0.3, y1: 0.4 })).toBeNull();
  });

  it("rejects non-finite numbers", () => {
    expect(validateBbox([0.1, 0.2, Number.NaN, 0.4])).toBeNull();
    expect(validateBbox([0.1, 0.2, Number.POSITIVE_INFINITY, 0.4])).toBeNull();
    expect(validateBbox([0.1, "wide", 0.3, 0.4])).toBeNull();
  });

  it("rejects coordinates outside 0..1", () => {
    expect(validateBbox([-0.01, 0.2, 0.3, 0.4])).toBeNull();
    expect(validateBbox([0.1, 0.2, 1.01, 0.4])).toBeNull();
  });

  it("rejects a reversed or degenerate box", () => {
    expect(validateBbox([0.3, 0.2, 0.1, 0.4])).toBeNull();
    expect(validateBbox([0.1, 0.4, 0.3, 0.2])).toBeNull();
    expect(validateBbox([0.2, 0.2, 0.2, 0.5])).toBeNull();
    expect(validateBbox([0.2, 0.5, 0.5, 0.5])).toBeNull();
  });

  it("rejects a box that swallows the page", () => {
    // 0.95 × 0.95 = 0.9025 of the sheet — the model shrugging, not a drawing.
    expect(validateBbox([0.02, 0.02, 0.97, 0.97])).toBeNull();
  });

  it("rejects a speck smaller than 0.2% of the page", () => {
    // 0.04 × 0.04 = 0.0016 — a tick mark, not an elevation.
    expect(validateBbox([0.5, 0.5, 0.54, 0.54])).toBeNull();
    // Just over the floor is kept.
    expect(validateBbox([0.5, 0.5, 0.55, 0.55])).toEqual([0.5, 0.5, 0.55, 0.55]);
  });
});

describe("isDrawingStale", () => {
  const BOX = PAGE_1_BOXES["4A"];
  const CURRENT = "planset-current";

  it("is fine when the box came from the planset we're cropping", () => {
    expect(isDrawingStale({ image_bbox: BOX, planset_id: CURRENT }, CURRENT)).toBe(
      false,
    );
  });

  it("is stale when the specs planset has been replaced", () => {
    expect(
      isDrawingStale({ image_bbox: BOX, planset_id: "planset-old" }, CURRENT),
    ).toBe(true);
  });

  it("keeps legacy rows with no recorded planset — the live Smith drawings", () => {
    expect(isDrawingStale({ image_bbox: BOX, planset_id: null }, CURRENT)).toBe(
      false,
    );
    expect(isDrawingStale({ image_bbox: BOX }, CURRENT)).toBe(false);
  });

  it("is never stale when there are no coordinates to be stale", () => {
    expect(isDrawingStale({ image_bbox: null, planset_id: "planset-old" }, CURRENT)).toBe(
      false,
    );
    expect(isDrawingStale({ planset_id: "planset-old" }, CURRENT)).toBe(false);
  });

  it("treats an unusable box as no box at all", () => {
    // Fails validateBbox (reversed), so there is nothing to mis-crop.
    expect(
      isDrawingStale({ image_bbox: [0.9, 0.9, 0.1, 0.1], planset_id: "old" }, CURRENT),
    ).toBe(false);
  });

  it("does not claim staleness when the current planset is unknown", () => {
    expect(isDrawingStale({ image_bbox: BOX, planset_id: "planset-old" }, null)).toBe(
      false,
    );
    expect(
      isDrawingStale({ image_bbox: BOX, planset_id: "planset-old" }, undefined),
    ).toBe(false);
    expect(isDrawingStale({ image_bbox: BOX, planset_id: "planset-old" }, "")).toBe(
      false,
    );
  });

  it("compares ids exactly — a near-miss uuid is a different file", () => {
    expect(
      isDrawingStale({ image_bbox: BOX, planset_id: `${CURRENT} ` }, CURRENT),
    ).toBe(true);
  });
});

describe("padBbox", () => {
  it("grows the real mark #1 box by the default 3.2% on every side", () => {
    const [x0, y0, x1, y1] = padBbox(PAGE_1_BOXES["1"]);
    expect(x0).toBeCloseTo(0.185, 6);
    expect(y0).toBeCloseTo(0.096, 6);
    expect(x1).toBeCloseTo(0.332, 6);
    expect(y1).toBeCloseTo(0.322, 6);
  });

  it("clamps at the page edges instead of going negative or past 1", () => {
    expect(padBbox([0.0, 0.01, 0.99, 1.0], 0.05)).toEqual([0, 0, 1, 1]);
  });

  it("honours a custom pad, including no padding at all", () => {
    expect(padBbox(PAGE_1_BOXES["4A"], 0)).toEqual(PAGE_1_BOXES["4A"]);
    const wide = padBbox(PAGE_1_BOXES["4A"], 0.1);
    expect(wide[0]).toBeCloseTo(0.49, 6);
    expect(wide[2]).toBeCloseTo(0.772, 6);
  });
});

describe("bboxToPixelRect", () => {
  it("maps a real box onto a rendered page", () => {
    // Mark #2 on a 2000 × 1500 render.
    expect(bboxToPixelRect(PAGE_1_BOXES["2"], 2000, 1500)).toEqual({
      x: 1270,
      y: 83,
      width: 246,
      height: 297,
    });
  });

  it("rounds to whole pixels", () => {
    // 0.3335 × 999 = 333.16 → 333; width 0.3 × 999 = 299.7 → 300.
    expect(bboxToPixelRect([0.3335, 0, 0.6335, 0.5], 999, 999)).toEqual({
      x: 333,
      y: 0,
      width: 300,
      height: 500,
    });
  });

  it("never returns a zero-sized rect", () => {
    const tiny = bboxToPixelRect([0.5, 0.5, 0.5001, 0.5001], 100, 100);
    expect(tiny.width).toBe(1);
    expect(tiny.height).toBe(1);
  });

  it("keeps the rect inside the page", () => {
    const full = bboxToPixelRect([0, 0, 1, 1], 640, 480);
    expect(full).toEqual({ x: 0, y: 0, width: 640, height: 480 });

    const edge = bboxToPixelRect([0.999, 0.999, 1, 1], 640, 480);
    expect(edge.x + edge.width).toBeLessThanOrEqual(640);
    expect(edge.y + edge.height).toBeLessThanOrEqual(480);
    expect(edge.width).toBeGreaterThanOrEqual(1);
    expect(edge.height).toBeGreaterThanOrEqual(1);
  });

  it("survives a degenerate page size", () => {
    const rect = bboxToPixelRect(PAGE_1_BOXES["3"], 0, 0);
    expect(rect).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });
});

/** Build RGBA data from a list of gray levels (alpha ramps so we can watch it). */
function grays(levels: number[]): Uint8ClampedArray {
  const data = new Uint8ClampedArray(levels.length * 4);
  levels.forEach((g, i) => {
    data[i * 4] = g;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = g;
    data[i * 4 + 3] = 200 + i;
  });
  return data;
}

describe("invertLineArt", () => {
  it("turns the white paper background pure black", () => {
    const data = grays([255]);
    invertLineArt(data);
    expect([data[0], data[1], data[2]]).toEqual([0, 0, 0]);
  });

  it("turns black ink pure white", () => {
    const data = grays([0]);
    invertLineArt(data);
    expect([data[0], data[1], data[2]]).toEqual([255, 255, 255]);
  });

  it("crushes the faint watermark band to black", () => {
    // Gray 235 inverts to 20 — under the floor, so it must vanish rather than
    // smear a colored blob across the drawing.
    const data = grays([235, 240, 250]);
    invertLineArt(data);
    expect([data[0], data[4], data[8]]).toEqual([0, 0, 0]);
  });

  it("brightens genuine faint line-work instead of erasing it", () => {
    // Gray 210 inverts to 45 — above the floor, so the gain lifts it to 135.
    const data = grays([210]);
    invertLineArt(data);
    expect(data[0]).toBe(135);

    // A thin anti-aliased edge at gray 220 → inverted 35 → 105: still visible,
    // which a plain threshold at the watermark level would have wiped out.
    const edge = grays([220]);
    invertLineArt(edge);
    expect(edge[0]).toBe(105);
  });

  it("clamps the gain at 255", () => {
    const data = grays([100]);
    invertLineArt(data);
    expect(data[0]).toBe(255);
  });

  it("leaves alpha untouched", () => {
    const data = grays([255, 0, 210]);
    invertLineArt(data);
    expect([data[3], data[7], data[11]]).toEqual([200, 201, 202]);
  });

  it("collapses color to one gray via weighted luma", () => {
    // Pure red: luma 0.299×255 = 76.2 → inverted 178.8 → gain clamps to 255.
    const data = new Uint8ClampedArray([255, 0, 0, 255]);
    invertLineArt(data);
    expect([data[0], data[1], data[2]]).toEqual([255, 255, 255]);
  });

  it("honours custom floor and gain", () => {
    // Floor 60 now swallows the gray-210 line (inverted 45).
    const crushed = grays([210]);
    invertLineArt(crushed, 60, 3);
    expect(crushed[0]).toBe(0);

    // Gain 1 leaves the inverted value alone.
    const flat = grays([210]);
    invertLineArt(flat, 25, 1);
    expect(flat[0]).toBe(45);
  });

  it("handles an empty buffer", () => {
    const data = new Uint8ClampedArray(0);
    expect(() => invertLineArt(data)).not.toThrow();
  });
});
