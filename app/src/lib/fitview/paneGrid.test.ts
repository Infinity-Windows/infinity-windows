import { describe, expect, it } from "vitest";
import {
  madMooseMark7Grid,
  normalizePaneGrid,
  parsePaneGrid,
  resolvePaneGrid,
  type PaneGrid,
} from "./paneGrid";
import fixture from "./fixtures/madmoose-mm2.json";

describe("madMooseMark7Grid: the canonical shared fixture", () => {
  it("resolves to 8 F cells + 2 door leaves at exact positions", () => {
    const g = resolvePaneGrid(madMooseMark7Grid);
    expect(g.widthIn).toBeCloseTo(167.5, 6);
    expect(g.heightIn).toBeCloseTo(143.5, 6);
    expect(g.cells).toHaveLength(10);

    const fCells = g.cells.filter((c) => c.op === "F");
    const doorCells = g.cells.filter((c) => c.op === "door");
    expect(fCells).toHaveLength(8);
    expect(doorCells).toHaveLength(2);

    // Column edges: 45.75 | 38 | 38 | 45.75, left to right.
    expect(g.columns).toEqual([
      { x: 0, w: 45.75 },
      { x: 45.75, w: 38 },
      { x: 83.75, w: 38 },
      { x: 121.75, w: 45.75 },
    ]);

    // Left column: three F cells stacked at y = 0, 47.5, 95.5.
    const left = g.cells.filter((c) => c.col === 0);
    expect(left.map((c) => ({ y: c.y, h: c.h, op: c.op }))).toEqual([
      { y: 0, h: 47.5, op: "F" },
      { y: 47.5, h: 48, op: "F" },
      { y: 95.5, h: 48, op: "F" },
    ]);

    // Center-left door column: F transom then a left-hinged leaf.
    const doorL = g.cells.find((c) => c.col === 1 && c.op === "door")!;
    expect(doorL).toMatchObject({ x: 45.75, y: 47.5, w: 38, h: 96, leaf: "L" });
    const doorR = g.cells.find((c) => c.col === 2 && c.op === "door")!;
    expect(doorR).toMatchObject({ x: 83.75, y: 47.5, w: 38, h: 96, leaf: "R" });

    // Right column mirrors the left exactly.
    const right = g.cells.filter((c) => c.col === 3);
    expect(right.map((c) => ({ x: c.x, y: c.y, h: c.h, op: c.op }))).toEqual([
      { x: 121.75, y: 0, h: 47.5, op: "F" },
      { x: 121.75, y: 47.5, h: 48, op: "F" },
      { x: 121.75, y: 95.5, h: 48, op: "F" },
    ]);
  });

  it("normalizePaneGrid on the raw literal matches resolvePaneGrid on the typed one", () => {
    const raw = JSON.parse(JSON.stringify(madMooseMark7Grid));
    expect(normalizePaneGrid(raw)).toEqual(resolvePaneGrid(madMooseMark7Grid));
  });
});

describe("parsePaneGrid: shape validation, never throws", () => {
  it("returns null for absent, non-object, or empty-columns input", () => {
    expect(parsePaneGrid(undefined)).toBeNull();
    expect(parsePaneGrid(null)).toBeNull();
    expect(parsePaneGrid("nope")).toBeNull();
    expect(parsePaneGrid({})).toBeNull();
    expect(parsePaneGrid({ columns: [] })).toBeNull();
    expect(parsePaneGrid({ columns: "not an array" })).toBeNull();
  });

  it("returns null when a column has no segments", () => {
    expect(parsePaneGrid({ columns: [{ width_in: 30, segments: [] }] })).toBeNull();
    expect(parsePaneGrid({ columns: [{ width_in: 30 }] })).toBeNull();
  });

  it("returns null when a segment carries no usable op", () => {
    expect(
      parsePaneGrid({ columns: [{ segments: [{ height_in: 40 }] }] }),
    ).toBeNull();
    expect(
      parsePaneGrid({ columns: [{ segments: [{ op: "" }] }] }),
    ).toBeNull();
    expect(
      parsePaneGrid({ columns: [{ segments: [{ op: 7 }] }] }),
    ).toBeNull();
  });

  it("canonicalizes op casing: F/X uppercase, door lowercase, others uppercase", () => {
    const g = parsePaneGrid({
      columns: [
        { segments: [{ op: "f" }, { op: "x" }, { op: "Door", leaf: "l" }, { op: "o" }] },
      ],
    })!;
    expect(g.columns[0].segments.map((s) => s.op)).toEqual(["F", "X", "door", "O"]);
    expect(g.columns[0].segments[2].leaf).toBe("L");
  });

  it("drops a garbage leaf rather than rejecting the whole grid", () => {
    const g = parsePaneGrid({
      columns: [{ segments: [{ op: "door", leaf: "middle" }] }],
    })!;
    expect(g.columns[0].segments[0].leaf).toBeUndefined();
  });

  it("rejects a non-positive width_in/height_in as if it were never given — never a zero/negative cell", () => {
    const g = parsePaneGrid({
      columns: [{ width_in: -5, segments: [{ op: "F", height_in: 0 }] }],
    })!;
    expect(g.columns[0].width_in).toBeUndefined();
    expect(g.columns[0].segments[0].height_in).toBeUndefined();
  });
});

describe("resolvePaneGrid: omitted dims divide remaining space equally", () => {
  it("splits a column's missing width across a known total (the hint)", () => {
    const grid: PaneGrid = {
      columns: [
        { width_in: 40, segments: [{ op: "F", height_in: 96 }] },
        { segments: [{ op: "F", height_in: 96 }] },
        { segments: [{ op: "F", height_in: 96 }] },
      ],
    };
    // Total 100in, 40 known, 60 left over 2 missing columns -> 30 each.
    const g = resolvePaneGrid(grid, { widthIn: 100 });
    expect(g.columns).toEqual([
      { x: 0, w: 40 },
      { x: 40, w: 30 },
      { x: 70, w: 30 },
    ]);
    expect(g.widthIn).toBe(100);
  });

  it("splits a column's own missing segment heights against a height hint", () => {
    const grid: PaneGrid = {
      columns: [
        {
          width_in: 36,
          segments: [{ op: "F", height_in: 40 }, { op: "F" }, { op: "F" }],
        },
      ],
    };
    // Total 100in tall, 40 known, 60 left over 2 missing segments -> 30 each.
    const g = resolvePaneGrid(grid, { heightIn: 100 });
    const rows = g.cells.map((c) => ({ y: c.y, h: c.h }));
    expect(rows).toEqual([
      { y: 0, h: 40 },
      { y: 40, h: 30 },
      { y: 70, h: 30 },
    ]);
    expect(g.heightIn).toBe(100);
  });

  it("without a hint, falls back to the average of known siblings rather than zero", () => {
    const grid: PaneGrid = {
      columns: [
        { width_in: 30, segments: [{ op: "F", height_in: 50 }] },
        { width_in: 50, segments: [{ op: "F", height_in: 50 }] },
        { segments: [{ op: "F", height_in: 50 }] }, // omitted width_in
      ],
    };
    const g = resolvePaneGrid(grid); // no hint at all
    // Average of 30 and 50 is 40 — a usable guess, never a zero-width cell.
    expect(g.columns[2].w).toBe(40);
  });

  it("a grid with nothing known anywhere still resolves to positive, non-crashing cells", () => {
    const grid: PaneGrid = { columns: [{ segments: [{ op: "F" }] }] };
    const g = resolvePaneGrid(grid);
    expect(g.widthIn).toBeGreaterThan(0);
    expect(g.heightIn).toBeGreaterThan(0);
  });
});

describe("normalizePaneGrid: the fallback trigger renderers gate on", () => {
  it("returns null for garbage or absent pane_grid — never throws", () => {
    expect(normalizePaneGrid(undefined)).toBeNull();
    expect(normalizePaneGrid(null)).toBeNull();
    expect(normalizePaneGrid({ columns: [] })).toBeNull();
    expect(normalizePaneGrid("not even an object")).toBeNull();
  });

  it("returns a resolved grid for a valid raw jsonb value", () => {
    const g = normalizePaneGrid({ columns: [{ width_in: 36, segments: [{ op: "F", height_in: 60 }] }] });
    expect(g).not.toBeNull();
    expect(g!.cells).toHaveLength(1);
  });
});

// BONUS (landed on master after the spec was written, PR #470): ten marks'
// worth of real hand-read pane_grids from the actual Mad Moose CADs — every
// one of them must parse, and every one's own resolved total should read
// back within a hair of the mark's real order size (fixture window w/h, mm).
describe("madmoose-mm2.json fixture: the parser handles every real grid", () => {
  const paneGrids = (fixture as { paneGrids: Record<string, unknown> }).paneGrids;
  const windows = (fixture as { windows: { id: string; w: number; h: number }[] }).windows;
  const IN_TO_MM = 25.4;

  for (const [mark, grid] of Object.entries(paneGrids)) {
    it(`mark ${mark} parses and totals close to its real order size`, () => {
      const g = normalizePaneGrid(grid);
      expect(g).not.toBeNull();
      const win = windows.find((w) => w.id === mark)!;
      expect(g!.widthIn * IN_TO_MM).toBeCloseTo(win.w, -1); // within ~a few mm
      expect(g!.heightIn * IN_TO_MM).toBeCloseTo(win.h, -1);
    });
  }

  it("marks 1 and 7 are identical storefronts (the spec's own callout)", () => {
    expect(paneGrids["1"]).toEqual(paneGrids["7"]);
    expect(normalizePaneGrid(paneGrids["1"])!.cells).toEqual(
      normalizePaneGrid(paneGrids["7"])!.cells,
    );
  });

  it("mark 8 is a 4x3 twelve-lite wall, all fixed", () => {
    const g = normalizePaneGrid(paneGrids["8"])!;
    expect(g.columns).toHaveLength(4);
    expect(g.cells).toHaveLength(12);
    expect(g.cells.every((c) => c.op === "F")).toBe(true);
  });
});
