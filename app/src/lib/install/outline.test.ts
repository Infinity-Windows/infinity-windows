import { describe, expect, it } from "vitest";
import {
  buildFootprintPolygon,
  clampOutlinePoint,
  collapseCollinear,
  cropEdges,
  dedupeClosePoints,
  dilate,
  erode,
  fillHoles,
  isValidOutlinePolygon,
  largestComponent,
  morphClose,
  morphOpen,
  otsuThreshold,
  outlinePathD,
  preferOutline,
  rdp,
  segmentsToOccupancy,
  snapRectilinear,
  traceOuterBoundary,
  type WallSegment,
} from "./outline";

/** Build a rows×cols grid, filling cells for which `fn` returns true. */
function makeGrid(
  rows: number,
  cols: number,
  fn: (r: number, c: number) => boolean,
): Uint8Array {
  const g = new Uint8Array(rows * cols);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) if (fn(r, c)) g[r * cols + c] = 1;
  }
  return g;
}

/** Fill a solid rectangle [r0..r1] × [c0..c1] (inclusive). */
function fillRect(
  g: Uint8Array,
  cols: number,
  r0: number,
  r1: number,
  c0: number,
  c1: number,
): void {
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) g[r * cols + c] = 1;
  }
}

/** True when every edge of a closed polygon is horizontal or vertical. */
function isRectilinear(pts: [number, number][], tol = 1e-6): boolean {
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const dx = Math.abs(a[0] - b[0]);
    const dy = Math.abs(a[1] - b[1]);
    if (dx > tol && dy > tol) return false;
  }
  return true;
}

function bbox(pts: { x: number; y: number }[]) {
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
  };
}

describe("outline helpers", () => {
  it("validates polygons with at least three distinct points", () => {
    expect(isValidOutlinePolygon([])).toBe(false);
    expect(
      isValidOutlinePolygon([
        { x: 0.1, y: 0.1 },
        { x: 0.2, y: 0.1 },
      ]),
    ).toBe(false);
    expect(
      isValidOutlinePolygon([
        { x: 0.1, y: 0.1 },
        { x: 0.9, y: 0.1 },
        { x: 0.9, y: 0.9 },
      ]),
    ).toBe(true);
  });

  it("prefers a manual outline over an extracted one", () => {
    const manual = {
      points: [
        { x: 0.2, y: 0.2 },
        { x: 0.8, y: 0.2 },
        { x: 0.8, y: 0.8 },
        { x: 0.2, y: 0.8 },
      ],
      pageAspect: 0.7,
    };
    const extracted = {
      points: [
        { x: 0.1, y: 0.1 },
        { x: 0.9, y: 0.1 },
        { x: 0.9, y: 0.9 },
      ],
      pageAspect: 0.7,
    };
    expect(preferOutline(manual, extracted)).toBe(manual);
    expect(preferOutline(null, extracted)).toBe(extracted);
    expect(preferOutline({ points: [], pageAspect: 0.7 }, extracted)).toBe(
      extracted,
    );
  });

  it("builds a closed SVG path and clamps points", () => {
    const d = outlinePathD(
      [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: 1 },
      ],
      0.5,
    );
    expect(d).toMatch(/^M/);
    expect(d?.endsWith(" Z")).toBe(true);
    expect(clampOutlinePoint({ x: -1, y: 2 })).toEqual({
      x: 0.005,
      y: 0.995,
    });
  });
});

describe("otsuThreshold", () => {
  it("finds a threshold between two luma clusters", () => {
    const hist = new Uint32Array(256);
    for (let l = 10; l <= 30; l++) hist[l] = 100; // dark ink
    for (let l = 210; l <= 250; l++) hist[l] = 500; // bright paper
    const t = otsuThreshold(hist);
    expect(t).toBeGreaterThanOrEqual(30);
    expect(t).toBeLessThan(210);
  });

  it("falls back to 160 on an empty histogram", () => {
    expect(otsuThreshold(new Uint32Array(256))).toBe(160);
  });
});

describe("morphology", () => {
  it("dilates and erodes are inverse on a padded solid block", () => {
    const rows = 9;
    const cols = 9;
    const g = makeGrid(rows, cols, (r, c) => r >= 3 && r <= 5 && c >= 3 && c <= 5);
    const grown = dilate(g, rows, cols, 1);
    // The 3×3 block grows to 5×5.
    expect(grown[2 * cols + 2]).toBe(1);
    expect(grown[6 * cols + 6]).toBe(1);
    const back = erode(grown, rows, cols, 1);
    expect(Array.from(back)).toEqual(Array.from(g));
  });

  it("morphClose bridges a wall gap without leaving it broken", () => {
    const rows = 5;
    const cols = 20;
    // A horizontal wall with a 3-cell doorway gap in the middle.
    const g = makeGrid(rows, cols, (r, c) =>
      r === 2 && c >= 2 && c <= 17 && !(c >= 9 && c <= 11),
    );
    expect(g[2 * cols + 10]).toBe(0);
    const closed = morphClose(g, rows, cols, 2);
    expect(closed[2 * cols + 10]).toBe(1); // gap bridged
  });

  it("morphOpen removes a thin dimension line but keeps a solid block", () => {
    const rows = 12;
    const cols = 12;
    const g = new Uint8Array(rows * cols);
    fillRect(g, cols, 2, 9, 2, 9); // solid 8×8 block
    for (let c = 0; c < cols; c++) g[c] = 1; // thin 1-cell line on row 0
    const opened = morphOpen(g, rows, cols, 2);
    expect(opened[0]).toBe(0); // thin line gone
    expect(opened[5 * cols + 5]).toBe(1); // block core survives
  });
});

describe("fillHoles", () => {
  it("fills an enclosed interior but leaves the exterior open", () => {
    const rows = 7;
    const cols = 7;
    // A hollow ring (border of a 5×5 region).
    const g = makeGrid(rows, cols, (r, c) => {
      const onRing = r === 1 || r === 5 || c === 1 || c === 5;
      return onRing && r >= 1 && r <= 5 && c >= 1 && c <= 5;
    });
    expect(g[3 * cols + 3]).toBe(0);
    const filled = fillHoles(g, rows, cols);
    expect(filled[3 * cols + 3]).toBe(1); // interior filled
    expect(filled[0]).toBe(0); // corner stays background
  });
});

describe("largestComponent", () => {
  it("keeps the biggest blob and drops smaller ones", () => {
    const rows = 20;
    const cols = 20;
    const g = new Uint8Array(rows * cols);
    fillRect(g, cols, 2, 12, 2, 12); // big blob (11×11)
    fillRect(g, cols, 15, 18, 15, 18); // small blob
    const comp = largestComponent(g, rows, cols)!;
    expect(comp[7 * cols + 7]).toBe(1);
    expect(comp[16 * cols + 16]).toBe(0);
  });
});

describe("snapRectilinear", () => {
  it("snaps a nearly-axis-aligned quad to right angles", () => {
    const pts: [number, number][] = [
      [0, 0],
      [100, 2],
      [98, 50],
      [-1, 48],
    ];
    const snapped = snapRectilinear(pts, 10);
    // Each near-axis edge becomes exactly horizontal/vertical.
    expect(snapped).toEqual([
      [0, 0],
      [100, 0],
      [100, 50],
      [-1, 50],
    ]);
  });

  it("leaves a genuinely diagonal edge alone", () => {
    const pts: [number, number][] = [
      [0, 0],
      [100, 100], // 45° — well beyond tolerance
      [100, 0],
    ];
    const snapped = snapRectilinear(pts, 10);
    expect(snapped[1]).toEqual([100, 100]);
  });
});

describe("cropEdges", () => {
  it("zeroes ink within the edge margin", () => {
    const rows = 100;
    const cols = 100;
    const g = new Uint8Array(rows * cols).fill(1);
    const cropped = cropEdges(g, rows, cols, 0.1);
    expect(cropped[0]).toBe(0); // corner cleared
    expect(cropped[50 * cols + 50]).toBe(1); // center kept
    expect(cropped[5 * cols + 5]).toBe(0); // inside margin
    expect(cropped[15 * cols + 15]).toBe(1); // just past margin
  });
});

describe("dedupeClosePoints", () => {
  it("removes near-duplicate and wrap-around points", () => {
    const pts: [number, number][] = [
      [0, 0],
      [0.2, 0.1],
      [10, 0],
      [10, 10],
      [0.1, 0.1],
    ];
    const out = dedupeClosePoints(pts, 0.5);
    expect(out).toEqual([
      [0, 0],
      [10, 0],
      [10, 10],
    ]);
  });
});

describe("buildFootprintPolygon (raster pipeline)", () => {
  it("resolves a noisy plan with title block + dimension spurs to a clean rectangle", () => {
    const rows = 40;
    const cols = 60;
    const g = new Uint8Array(rows * cols);

    // Building: hollow rectangular wall ring with a doorway gap in the bottom.
    const R0 = 10;
    const R1 = 29;
    const C0 = 15;
    const C1 = 44;
    for (let c = C0; c <= C1; c++) {
      g[R0 * cols + c] = 1; // top wall
      if (!(c >= 28 && c <= 31)) g[R1 * cols + c] = 1; // bottom wall w/ door gap
    }
    for (let r = R0; r <= R1; r++) {
      g[r * cols + C0] = 1; // left wall
      g[r * cols + C1] = 1; // right wall
    }

    // Title block: solid strip in the bottom-right corner (disconnected).
    fillRect(g, cols, 31, 37, 47, 57);

    // Dimension string: thin horizontal line near the top edge, tied to the
    // top wall by a thin leader (one connected blob of noise).
    for (let c = C0; c <= C1; c++) g[2 * cols + c] = 1;
    for (let r = 2; r <= R0; r++) g[r * cols + C0] = 1;

    // Perpendicular dimension/leader spurs sticking out of the top wall.
    for (let r = 6; r <= R0; r++) g[r * cols + 24] = 1;
    for (let r = 6; r <= R0; r++) g[r * cols + 34] = 1;

    // Scattered text specks (room labels / notes).
    g[20 * cols + 5] = 1;
    g[22 * cols + 6] = 1;
    g[8 * cols + 52] = 1;

    const poly = buildFootprintPolygon(g, rows, cols)!;
    expect(poly).not.toBeNull();
    expect(isRectilinear(poly)).toBe(true);

    const norm = poly.map(([c, r]) => ({ x: c / cols, y: r / rows }));
    const box = bbox(norm);
    // Hugs the building walls, ignores the title block and dimension spur.
    expect(box.minX).toBeGreaterThan(0.18);
    expect(box.minX).toBeLessThan(0.32);
    expect(box.maxX).toBeGreaterThan(0.68);
    expect(box.maxX).toBeLessThan(0.82);
    expect(box.minY).toBeGreaterThan(0.18);
    expect(box.minY).toBeLessThan(0.32);
    expect(box.maxY).toBeGreaterThan(0.68);
    expect(box.maxY).toBeLessThan(0.82);
    // A tidy footprint, not a staircased mess.
    expect(poly.length).toBeLessThanOrEqual(6);
  });
});

describe("segmentsToOccupancy + vector pipeline", () => {
  it("rasterizes wall segments and traces a clean rectangle footprint", () => {
    const rows = 40;
    const cols = 60;
    const segs: WallSegment[] = [
      { x1: 0.25, y1: 0.25, x2: 0.75, y2: 0.25 },
      { x1: 0.75, y1: 0.25, x2: 0.75, y2: 0.75 },
      { x1: 0.75, y1: 0.75, x2: 0.25, y2: 0.75 },
      { x1: 0.25, y1: 0.75, x2: 0.25, y2: 0.25 },
    ];
    const occ = segmentsToOccupancy(segs, rows, cols);
    expect(occ[Math.round(0.25 * (rows - 1)) * cols + Math.round(0.5 * (cols - 1))]).toBe(1);

    const poly = buildFootprintPolygon(occ, rows, cols)!;
    expect(poly).not.toBeNull();
    expect(isRectilinear(poly)).toBe(true);
    const box = bbox(poly.map(([c, r]) => ({ x: c / cols, y: r / rows })));
    expect(box.minX).toBeGreaterThan(0.18);
    expect(box.maxX).toBeLessThan(0.82);
    expect(box.minY).toBeGreaterThan(0.18);
    expect(box.maxY).toBeLessThan(0.82);
  });
});

describe("geometry helpers stay stable", () => {
  it("collapseCollinear drops midpoints on straight runs", () => {
    const pts: [number, number][] = [
      [0, 0],
      [5, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ];
    expect(collapseCollinear(pts)).toEqual([
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ]);
  });

  it("rdp keeps corners and drops near-collinear noise", () => {
    const pts: [number, number][] = [
      [0, 0],
      [5, 0.2],
      [10, 0],
      [10, 10],
    ];
    const out = rdp(pts, 1);
    expect(out).toContainEqual([0, 0]);
    expect(out).toContainEqual([10, 10]);
    expect(out).not.toContainEqual([5, 0.2]);
  });

  it("traceOuterBoundary follows a solid block perimeter", () => {
    const rows = 8;
    const cols = 8;
    const g = new Uint8Array(rows * cols);
    fillRect(g, cols, 2, 5, 2, 5);
    const loop = traceOuterBoundary(g, rows, cols);
    expect(loop.length).toBeGreaterThanOrEqual(4);
    // The traced corners span the block's corner grid (2..6).
    const cs = loop.map((p) => p[0]);
    const rsv = loop.map((p) => p[1]);
    expect(Math.min(...cs)).toBe(2);
    expect(Math.max(...cs)).toBe(6);
    expect(Math.min(...rsv)).toBe(2);
    expect(Math.max(...rsv)).toBe(6);
  });
});
