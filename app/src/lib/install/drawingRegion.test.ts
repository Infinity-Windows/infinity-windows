import { describe, expect, it } from "vitest";
import {
  cellFor,
  drawingCropBox,
  inkCoverage,
  inkMaskFromPixels,
  pageRules,
  resolveDrawingRegion,
  type InkMask,
} from "./drawingRegion";
import type { Bbox } from "./markDrawing";

// A miniature specs sheet, drawn the way the real ones are: a black border, a
// pale divider down the middle, two panels side by side, and under each panel a
// pale-ruled spec table. 200x200 keeps the tests readable while staying big
// enough that a 2% gutter is several samples wide.
//
// Coordinates are chosen to mirror the Black Desert layout: border at 4% and
// 96%, divider at 50%, drawings in the top two thirds, tables under them.
const W = 200;
const H = 200;
const BLACK = 20;
const PALE = 208;
const PAPER = 255;

function blankPage(): Uint8ClampedArray {
  const px = new Uint8ClampedArray(W * H * 4);
  px.fill(255);
  return px;
}

function put(px: Uint8ClampedArray, x: number, y: number, v: number): void {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 4;
  px[i] = v;
  px[i + 1] = v;
  px[i + 2] = v;
  px[i + 3] = 255;
}

function hLine(px: Uint8ClampedArray, y: number, x0: number, x1: number, v: number) {
  for (let x = x0; x <= x1; x++) put(px, x, y, v);
}

function vLine(px: Uint8ClampedArray, x: number, y0: number, y1: number, v: number) {
  for (let y = y0; y <= y1; y++) put(px, x, y, v);
}

function box(px: Uint8ClampedArray, x0: number, y0: number, x1: number, y1: number) {
  hLine(px, y0, x0, x1, BLACK);
  hLine(px, y1, x0, x1, BLACK);
  vLine(px, x0, y0, y1, BLACK);
  vLine(px, x1, y0, y1, BLACK);
}

/** Scribble, so a "drawing" has ink in the middle and not just an outline. */
function fillHatch(px: Uint8ClampedArray, x0: number, y0: number, x1: number, y1: number) {
  for (let y = y0 + 2; y < y1 - 1; y += 2) hLine(px, y, x0 + 2, x1 - 2, BLACK);
}

interface Sheet {
  mask: InkMask;
  /** Where each drawing really is, as a normalized box. */
  left: Bbox;
  right: Bbox;
}

function sheet(options: { rightPanelBlank?: boolean } = {}): Sheet {
  const px = blankPage();
  // Sheet border, drawn black like the real one.
  box(px, 8, 8, 191, 191);
  // Panel divider, pale, running the full height between the borders.
  vLine(px, 100, 8, 191, PALE);
  // The rule above and below each spec table — a four-rung ladder per panel.
  for (const x0 of [10, 102]) {
    const x1 = x0 === 10 ? 98 : 189;
    for (const y of [130, 138, 146, 154]) hLine(px, y, x0, x1, PALE);
  }

  // Left panel: a tall narrow window with a dimension line beside it.
  box(px, 30, 30, 55, 110);
  fillHatch(px, 30, 30, 55, 110);
  vLine(px, 59, 30, 110, BLACK);
  // Right panel: a wide unit, unless we're testing an empty panel.
  if (!options.rightPanelBlank) {
    box(px, 120, 40, 165, 100);
    fillHatch(px, 120, 40, 165, 100);
  }

  return {
    mask: inkMaskFromPixels(px, W, H, 1),
    left: [30 / W, 30 / H, 59 / W, 110 / H],
    right: [120 / W, 40 / H, 165 / W, 100 / H],
  };
}

/** Does `outer` contain `inner`, give or take the region's own margin? */
function contains(outer: Bbox, inner: Bbox, slack = 0.02): boolean {
  return (
    outer[0] <= inner[0] + slack &&
    outer[1] <= inner[1] + slack &&
    outer[2] >= inner[2] - slack &&
    outer[3] >= inner[3] - slack
  );
}

describe("inkMaskFromPixels", () => {
  it("keeps a one-pixel rule when the page is shrunk tenfold", () => {
    const px = blankPage();
    hLine(px, 50, 0, W - 1, PALE);
    const shrunk = inkMaskFromPixels(px, W, H, 10);
    const row = Math.floor(50 / 10);
    const found = Array.from(
      { length: shrunk.width },
      (_, x) => shrunk.data[row * shrunk.width + x],
    );
    // Averaging would have washed this line out completely.
    expect(found.every((v) => v > 0)).toBe(true);
  });

  it("separates near-black line-work from the pale printed furniture", () => {
    const px = blankPage();
    put(px, 5, 5, BLACK);
    put(px, 6, 5, PALE);
    put(px, 7, 5, PAPER);
    const m = inkMaskFromPixels(px, W, H, 1);
    expect(m.data[5 * W + 5]).toBe(2);
    expect(m.data[5 * W + 6]).toBe(1);
    expect(m.data[5 * W + 7]).toBe(0);
  });
});

describe("pageRules", () => {
  it("finds the sheet border and the divider, and nothing from the drawings", () => {
    const { mask } = sheet();
    const { rows, cols } = pageRules(mask);
    // The divider at x=100 and the two border verticals.
    expect(cols.some((c) => Math.abs(c - 0.5) < 0.02)).toBe(true);
    expect(cols.filter((c) => c > 0.15 && c < 0.85)).toHaveLength(1);
    // The border top and bottom, plus the two table ladders.
    expect(rows.some((r) => Math.abs(r - 0.04) < 0.02)).toBe(true);
    expect(rows.filter((r) => r > 0.6 && r < 0.8).length).toBeGreaterThanOrEqual(3);
  });

  it("does not mistake a wide drawing's own edge for a rule", () => {
    const px = blankPage();
    box(px, 8, 8, 191, 191);
    // A unit spanning half the sheet: as long as a table rule, and darker.
    hLine(px, 60, 20, 120, BLACK);
    const { rows } = pageRules(inkMaskFromPixels(px, W, H, 1));
    expect(rows.some((r) => Math.abs(r - 0.3) < 0.02)).toBe(false);
  });
});

describe("cellFor", () => {
  it("takes the box's centre, not its edges", () => {
    const rules = { rows: [0.1, 0.9], cols: [0.05, 0.5, 0.95] };
    // A box that overhangs the divider still belongs to the panel it's mostly in.
    expect(cellFor([0.1, 0.2, 0.55, 0.6], rules)).toEqual([0.05, 0.1, 0.5, 0.9]);
    expect(cellFor([0.45, 0.2, 0.9, 0.6], rules)).toEqual([0.5, 0.1, 0.95, 0.9]);
  });
});

describe("resolveDrawingRegion", () => {
  it("grows a sliver of a panel out to the whole drawing", () => {
    const { mask, left } = sheet();
    // A tenth of the window's width, the way the broken boxes look.
    const sliver: Bbox = [0.16, 0.2, 0.2, 0.4];
    const region = resolveDrawingRegion(mask, sliver);
    expect(region).not.toBeNull();
    expect(contains(region!, left)).toBe(true);
  });

  it("recovers a box that missed the drawing and landed beside it", () => {
    const { mask, left } = sheet();
    // Mark #2's failure: the box is on the dimension line, off the window.
    const offset: Bbox = [0.29, 0.2, 0.31, 0.45];
    const region = resolveDrawingRegion(mask, offset);
    expect(region).not.toBeNull();
    expect(contains(region!, left)).toBe(true);
  });

  it("leaves a box that was already right alone", () => {
    const { mask, right } = sheet();
    const region = resolveDrawingRegion(mask, right);
    expect(region).not.toBeNull();
    expect(contains(region!, right)).toBe(true);
  });

  it("never reaches across the divider into the neighbour's panel", () => {
    const { mask, left, right } = sheet();
    for (const start of [left, right, [0.16, 0.2, 0.2, 0.4] as Bbox]) {
      const region = resolveDrawingRegion(mask, start);
      expect(region).not.toBeNull();
      const crossesDivider = region![0] < 0.48 && region![2] > 0.52;
      expect(crossesDivider, `from ${start.join(",")}`).toBe(false);
    }
  });

  it("stops above the spec table rather than cropping the paperwork in", () => {
    const { mask, left } = sheet();
    const region = resolveDrawingRegion(mask, left);
    expect(region![3]).toBeLessThan(130 / H);
  });
});

describe("drawingCropBox", () => {
  it("shows nothing for a panel the supplier left blank", () => {
    const { mask, right } = sheet({ rightPanelBlank: true });
    expect(drawingCropBox(mask, right)).toBeNull();
  });

  it("shows the drawing for a panel that has one", () => {
    const { mask, right } = sheet();
    expect(drawingCropBox(mask, right)).not.toBeNull();
  });
});

describe("inkCoverage", () => {
  it("is near zero on blank paper and substantial on a drawing", () => {
    const { mask, right } = sheet();
    expect(inkCoverage(mask, [0.05, 0.85, 0.45, 0.95])).toBeLessThan(0.008);
    expect(inkCoverage(mask, right)).toBeGreaterThan(0.05);
  });
});
