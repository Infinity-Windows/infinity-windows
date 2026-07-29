import { describe, expect, it } from "vitest";
import {
  boundingFootprint,
  coarsen,
  footprintFromPins,
  MAX_FOOTPRINT_VERTICES,
  polygonArea,
  resolveFootprint,
  type FootprintPin,
} from "./footprint";
import { isValidOutlinePolygon, type OutlinePoint } from "./outline";

/** Pins evenly spaced around a rectangle's perimeter, as marks on walls are. */
function ringPins(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  perSide: number,
): FootprintPin[] {
  const pins: FootprintPin[] = [];
  for (let i = 0; i < perSide; i++) {
    const t = i / perSide;
    pins.push({ x: x0 + (x1 - x0) * t, y: y0 });
    pins.push({ x: x1, y: y0 + (y1 - y0) * t });
    pins.push({ x: x1 - (x1 - x0) * t, y: y1 });
    pins.push({ x: x0, y: y1 - (y1 - y0) * t });
  }
  return pins;
}

function bbox(points: OutlinePoint[]) {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
  };
}

/** Ray casting, so "is this pin inside the shape" is answered honestly. */
function contains(points: OutlinePoint[], p: FootprintPin): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i];
    const b = points[j];
    const straddles = a.y > p.y !== b.y > p.y;
    if (!straddles) continue;
    const xAt = a.x + ((p.y - a.y) / (b.y - a.y)) * (b.x - a.x);
    if (p.x < xAt) inside = !inside;
  }
  return inside;
}

describe("footprintFromPins", () => {
  it("traces a rectangular building from marks on its walls", () => {
    const pins = ringPins(0.2, 0.2, 0.8, 0.8, 6);
    const result = footprintFromPins(pins, 0.7);
    expect(result).not.toBeNull();
    expect(isValidOutlinePolygon(result!.points)).toBe(true);
    const box = bbox(result!.points);
    // The traced shape should sit around the pins, not inside them.
    expect(box.minX).toBeLessThanOrEqual(0.25);
    expect(box.maxX).toBeGreaterThanOrEqual(0.75);
    expect(box.minY).toBeLessThanOrEqual(0.25);
    expect(box.maxY).toBeGreaterThanOrEqual(0.75);
  });

  it("keeps the shape inside the page", () => {
    const result = footprintFromPins(ringPins(0.02, 0.02, 0.98, 0.98, 8), 0.7);
    for (const p of result!.points) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(1);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(1);
    }
  });

  it("stays within the vertex budget so it reads as a building", () => {
    // A deliberately ragged ring: without coarsening this traces dozens of steps.
    const pins: FootprintPin[] = [];
    for (let i = 0; i < 60; i++) {
      const angle = (i / 60) * Math.PI * 2;
      const wobble = i % 2 === 0 ? 0.02 : -0.02;
      pins.push({
        x: 0.5 + (0.3 + wobble) * Math.cos(angle),
        y: 0.5 + (0.3 + wobble) * Math.sin(angle),
      });
    }
    const result = footprintFromPins(pins, 1);
    expect(result!.points.length).toBeLessThanOrEqual(MAX_FOOTPRINT_VERTICES);
    expect(result!.points.length).toBeGreaterThanOrEqual(3);
  });

  it("encloses the pins it was built from", () => {
    const pins = ringPins(0.25, 0.3, 0.75, 0.7, 5);
    const result = footprintFromPins(pins, 0.8);
    const enclosed = pins.filter((p) => contains(result!.points, p)).length;
    // Marks sit on the wall, so a few may land exactly on the boundary; the
    // shape is wrong if it excludes most of them.
    expect(enclosed).toBeGreaterThan(pins.length * 0.7);
  });

  it("falls back to a padded box when there are too few pins to enclose", () => {
    const pins = [
      { x: 0.4, y: 0.4 },
      { x: 0.6, y: 0.4 },
      { x: 0.5, y: 0.6 },
    ];
    const result = footprintFromPins(pins, 0.7);
    expect(result!.points).toHaveLength(4);
    const box = bbox(result!.points);
    expect(box.minX).toBeLessThan(0.4);
    expect(box.maxX).toBeGreaterThan(0.6);
  });

  it("is deterministic — the same job always draws the same shape", () => {
    const pins = ringPins(0.2, 0.25, 0.85, 0.75, 7);
    const a = footprintFromPins(pins, 0.7);
    const b = footprintFromPins(pins, 0.7);
    expect(a).toEqual(b);
  });

  it("ignores pin order", () => {
    const pins = ringPins(0.2, 0.2, 0.8, 0.8, 6);
    const forward = footprintFromPins(pins, 0.7);
    const backward = footprintFromPins([...pins].reverse(), 0.7);
    expect(backward).toEqual(forward);
  });

  it("shrugs off a stray pin far from the building", () => {
    const pins = ringPins(0.3, 0.3, 0.7, 0.7, 6);
    const withStray = footprintFromPins(
      [...pins, { x: 0.99, y: 0.02 }],
      0.7,
    );
    const clean = footprintFromPins(pins, 0.7);
    // The largest mass wins, so one loose mark must not stretch the building.
    expect(bbox(withStray!.points).maxX).toBeLessThan(
      bbox(clean!.points).maxX + 0.15,
    );
  });

  it("returns null with no usable pins", () => {
    expect(footprintFromPins([], 0.7)).toBeNull();
    expect(
      footprintFromPins([{ x: Number.NaN, y: 0.5 }], 0.7),
    ).toBeNull();
  });

  it("survives a nonsense aspect rather than dividing by zero", () => {
    const result = footprintFromPins(ringPins(0.2, 0.2, 0.8, 0.8, 6), 0);
    expect(result).not.toBeNull();
    expect(Number.isFinite(result!.pageAspect)).toBe(true);
    for (const p of result!.points) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
  });

  it("handles a job whose pins all sit on one wall", () => {
    const pins = Array.from({ length: 10 }, (_, i) => ({
      x: 0.15 + i * 0.07,
      y: 0.5,
    }));
    const result = footprintFromPins(pins, 0.7);
    expect(result).not.toBeNull();
    expect(isValidOutlinePolygon(result!.points)).toBe(true);
    // A line encloses nothing, so this must not come back as a sliver.
    expect(polygonArea(result!.points, 0.7)).toBeGreaterThan(0);
  });
});

describe("coarsen", () => {
  it("meets the vertex budget", () => {
    const many: OutlinePoint[] = Array.from({ length: 90 }, (_, i) => {
      const angle = (i / 90) * Math.PI * 2;
      return {
        x: 0.5 + 0.35 * Math.cos(angle),
        y: 0.5 + 0.35 * Math.sin(angle),
      };
    });
    expect(coarsen(many, 8, 1).length).toBeLessThanOrEqual(8);
  });

  it("leaves a clean rectangle alone", () => {
    const rect: OutlinePoint[] = [
      { x: 0.2, y: 0.2 },
      { x: 0.8, y: 0.2 },
      { x: 0.8, y: 0.8 },
      { x: 0.2, y: 0.8 },
    ];
    const result = coarsen(rect, MAX_FOOTPRINT_VERTICES, 1);
    expect(result.length).toBeLessThanOrEqual(4);
    const box = bbox(result);
    expect(box.minX).toBeCloseTo(0.2, 1);
    expect(box.maxX).toBeCloseTo(0.8, 1);
  });

  it("squares up edges that are nearly axis-aligned", () => {
    const wonky: OutlinePoint[] = [
      { x: 0.2, y: 0.2 },
      { x: 0.8, y: 0.208 },
      { x: 0.805, y: 0.8 },
      { x: 0.2, y: 0.79 },
    ];
    const result = coarsen(wonky, MAX_FOOTPRINT_VERTICES, 1);
    // At least one pair of consecutive points should now share an exact axis.
    const squared = result.some((p, i) => {
      const next = result[(i + 1) % result.length];
      return p.x === next.x || p.y === next.y;
    });
    expect(squared).toBe(true);
  });

  it("never returns something unrenderable", () => {
    expect(coarsen([], 12, 1)).toEqual([]);
    const twoPoints: OutlinePoint[] = [
      { x: 0.3, y: 0.3 },
      { x: 0.7, y: 0.7 },
    ];
    // Too few points to be a polygon: hand back the input, not a broken shape.
    expect(coarsen(twoPoints, 12, 1)).toEqual(twoPoints);
  });

  it("keeps an L-shaped building recognisably L-shaped", () => {
    const ell: OutlinePoint[] = [
      { x: 0.2, y: 0.2 },
      { x: 0.8, y: 0.2 },
      { x: 0.8, y: 0.5 },
      { x: 0.5, y: 0.5 },
      { x: 0.5, y: 0.8 },
      { x: 0.2, y: 0.8 },
    ];
    const result = coarsen(ell, MAX_FOOTPRINT_VERTICES, 1);
    // Six corners is already within budget; the notch must not be flattened
    // into a rectangle, or every L-shaped building would look wrong.
    expect(result.length).toBeGreaterThanOrEqual(5);
  });
});

describe("resolveFootprint", () => {
  const pins = ringPins(0.2, 0.2, 0.8, 0.8, 6);
  const savedShape = {
    points: [
      { x: 0.1, y: 0.1 },
      { x: 0.9, y: 0.1 },
      { x: 0.9, y: 0.9 },
      { x: 0.1, y: 0.9 },
    ],
    pageAspect: 0.7,
  };

  it("prefers a saved outline over everything else", () => {
    const result = resolveFootprint({
      saved: savedShape,
      traced: { points: ringPins(0.3, 0.3, 0.6, 0.6, 4), pageAspect: 0.7 },
      pins,
      aspect: 0.7,
    });
    expect(result!.source).toBe("saved");
    expect(result!.outline.points).toEqual(savedShape.points);
  });

  it("does not coarsen a saved outline — a person drew that", () => {
    const detailed = {
      points: Array.from({ length: 40 }, (_, i) => {
        const angle = (i / 40) * Math.PI * 2;
        return {
          x: 0.5 + 0.3 * Math.cos(angle),
          y: 0.5 + 0.3 * Math.sin(angle),
        };
      }),
      pageAspect: 0.7,
    };
    const result = resolveFootprint({ saved: detailed, pins, aspect: 0.7 });
    expect(result!.outline.points).toHaveLength(40);
  });

  it("falls to the trace when nothing is saved, and coarsens it", () => {
    const jagged = {
      points: Array.from({ length: 60 }, (_, i) => {
        const angle = (i / 60) * Math.PI * 2;
        const wobble = i % 2 === 0 ? 0.015 : -0.015;
        return {
          x: 0.5 + (0.3 + wobble) * Math.cos(angle),
          y: 0.5 + (0.3 + wobble) * Math.sin(angle),
        };
      }),
      pageAspect: 0.7,
    };
    const result = resolveFootprint({ traced: jagged, pins, aspect: 0.7 });
    expect(result!.source).toBe("traced");
    expect(result!.outline.points.length).toBeLessThanOrEqual(
      MAX_FOOTPRINT_VERTICES,
    );
  });

  it("falls to the pins when there is no saved outline and no trace", () => {
    const result = resolveFootprint({ pins, aspect: 0.7 });
    expect(result!.source).toBe("pins");
    expect(isValidOutlinePolygon(result!.outline.points)).toBe(true);
  });

  it("ignores an empty trace, which is what a failed trace returns", () => {
    const result = resolveFootprint({
      saved: null,
      traced: { points: [], pageAspect: 0.7 },
      pins,
      aspect: 0.7,
    });
    expect(result!.source).toBe("pins");
  });

  it("ignores a degenerate saved outline rather than drawing nothing", () => {
    const result = resolveFootprint({
      saved: { points: [{ x: 0.5, y: 0.5 }], pageAspect: 0.7 },
      pins,
      aspect: 0.7,
    });
    expect(result!.source).toBe("pins");
  });

  it("returns null only when there is genuinely nothing to draw", () => {
    expect(resolveFootprint({ pins: [], aspect: 0.7 })).toBeNull();
  });

  it("keeps the trace's own aspect when it differs from the page default", () => {
    const traced = {
      points: [
        { x: 0.2, y: 0.2 },
        { x: 0.8, y: 0.2 },
        { x: 0.8, y: 0.8 },
        { x: 0.2, y: 0.8 },
      ],
      pageAspect: 1.4,
    };
    const result = resolveFootprint({ traced, pins, aspect: 0.7 });
    expect(result!.outline.pageAspect).toBe(1.4);
  });
});

describe("boundingFootprint", () => {
  it("pads outward so pins land on the wall", () => {
    const result = boundingFootprint(
      [
        { x: 0.4, y: 0.45 },
        { x: 0.6, y: 0.55 },
      ],
      0.7,
    );
    const box = bbox(result!.points);
    expect(box.minX).toBeLessThan(0.4);
    expect(box.maxX).toBeGreaterThan(0.6);
    expect(box.minY).toBeLessThan(0.45);
    expect(box.maxY).toBeGreaterThan(0.55);
  });

  it("clamps to the page for pins already at the edge", () => {
    const result = boundingFootprint(
      [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ],
      0.7,
    );
    for (const p of result!.points) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(1);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(1);
    }
  });

  it("returns null when there is nothing to bound", () => {
    expect(boundingFootprint([], 0.7)).toBeNull();
  });
});
