import { describe, expect, it } from "vitest";
import {
  boundingFootprint,
  coarsen,
  isPlausibleBuildingTrace,
  MAX_FOOTPRINT_VERTICES,
  polygonArea,
  resolveFootprint,
  type FootprintPin,
} from "./footprint";
import { isValidOutlinePolygon, type OutlinePoint } from "./outline";

/** A handful of pins inside a rectangle — enough to build a box around. */
function samplePins(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): FootprintPin[] {
  return [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
    { x: (x0 + x1) / 2, y: (y0 + y1) / 2 },
  ];
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

describe("boundingFootprint", () => {
  it("is a four-corner rectangle around the marks", () => {
    const pins = [
      { x: 0.2, y: 0.3 },
      { x: 0.8, y: 0.3 },
      { x: 0.5, y: 0.7 },
    ];
    const result = boundingFootprint(pins, 0.7);
    expect(result!.points).toHaveLength(4);
    expect(isValidOutlinePolygon(result!.points)).toBe(true);
    const box = bbox(result!.points);
    expect(box.minX).toBeLessThan(0.2);
    expect(box.maxX).toBeGreaterThan(0.8);
    expect(box.minY).toBeLessThan(0.3);
    expect(box.maxY).toBeGreaterThan(0.7);
  });

  it("encloses every mark it was built from", () => {
    const pins = [
      { x: 0.15, y: 0.2 },
      { x: 0.85, y: 0.25 },
      { x: 0.4, y: 0.8 },
      { x: 0.6, y: 0.55 },
    ];
    const result = boundingFootprint(pins, 0.8);
    for (const p of pins) expect(contains(result!.points, p)).toBe(true);
  });

  it("keeps the shape inside the page", () => {
    const result = boundingFootprint(
      [
        { x: 0.02, y: 0.02 },
        { x: 0.98, y: 0.98 },
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

  it("is deterministic and ignores pin order", () => {
    const pins = [
      { x: 0.2, y: 0.25 },
      { x: 0.85, y: 0.75 },
      { x: 0.4, y: 0.5 },
    ];
    expect(boundingFootprint(pins, 0.7)).toEqual(
      boundingFootprint([...pins].reverse(), 0.7),
    );
  });

  it("returns null with no usable pins", () => {
    expect(boundingFootprint([], 0.7)).toBeNull();
    expect(boundingFootprint([{ x: Number.NaN, y: 0.5 }], 0.7)).toBeNull();
  });

  it("handles a job whose pins all sit on one wall", () => {
    const pins = Array.from({ length: 10 }, (_, i) => ({
      x: 0.15 + i * 0.07,
      y: 0.5,
    }));
    const result = boundingFootprint(pins, 0.7);
    expect(result).not.toBeNull();
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
  const pins = samplePins(0.2, 0.2, 0.8, 0.8);
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
      traced: {
        points: samplePins(0.3, 0.3, 0.6, 0.6),
        pageAspect: 0.7,
      },
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

  it("ignores a PDF trace and draws a box around the marks instead", () => {
    // Traces looked clever and were wrong often enough that the openings never
    // got a fair wall to sit in. A rectangle is what the map promises now.
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
    expect(result!.source).toBe("pins");
    expect(result!.outline.points).toHaveLength(4);
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

  it("rejects a trace of the sheet border and uses the pins instead", () => {
    // What BLACK22's PDF actually traces to: the drawing frame and title
    // block, 0.91 × 0.90 of the page, with a notch cut out of one corner.
    const sheetBorder = {
      points: [
        { x: 0.04, y: 0.05 },
        { x: 0.95, y: 0.05 },
        { x: 0.95, y: 0.9 },
        { x: 0.9, y: 0.9 },
        { x: 0.9, y: 0.95 },
        { x: 0.04, y: 0.95 },
      ],
      pageAspect: 0.7,
    };
    expect(isPlausibleBuildingTrace(sheetBorder.points, 0.7)).toBe(false);
    const result = resolveFootprint({
      traced: sheetBorder,
      pins,
      aspect: 0.7,
    });
    // Saving the page frame as the building would be permanent and wrong.
    expect(result!.source).toBe("pins");
  });

  it("still recognises a real footprint as plausible, but does not draw it", () => {
    // The plausibility gate remains for anything that still inspects a trace
    // (saved-origin labelling, future tooling). The map itself no longer uses
    // the trace as a building shape.
    const realFootprint = {
      points: [
        { x: 0.14, y: 0.09 },
        { x: 0.82, y: 0.09 },
        { x: 0.82, y: 0.6 },
        { x: 0.45, y: 0.6 },
        { x: 0.45, y: 0.92 },
        { x: 0.14, y: 0.92 },
      ],
      pageAspect: 0.7,
    };
    expect(isPlausibleBuildingTrace(realFootprint.points, 0.7)).toBe(true);
    expect(
      resolveFootprint({ traced: realFootprint, pins, aspect: 0.7 })!.source,
    ).toBe("pins");
  });

  it("rejects a trace that swallows most of its own page", () => {
    // Not border-shaped, but far too big to be a building on a plan sheet.
    const bloated = {
      points: [
        { x: 0.02, y: 0.02 },
        { x: 0.84, y: 0.02 },
        { x: 0.84, y: 0.98 },
        { x: 0.02, y: 0.98 },
      ],
      pageAspect: 0.7,
    };
    expect(isPlausibleBuildingTrace(bloated.points, 0.7)).toBe(false);
    expect(resolveFootprint({ traced: bloated, pins, aspect: 0.7 })!.source).toBe(
      "pins",
    );
  });

  it("never rejects a shape a person drew by hand", () => {
    // A lead who traces the whole sheet meant to. Only the machine is doubted.
    const hugeButHuman = {
      points: [
        { x: 0.02, y: 0.02 },
        { x: 0.98, y: 0.02 },
        { x: 0.98, y: 0.98 },
        { x: 0.02, y: 0.98 },
      ],
      pageAspect: 0.7,
    };
    const result = resolveFootprint({ saved: hugeButHuman, pins, aspect: 0.7 });
    expect(result!.source).toBe("saved");
  });

  it("returns null only when there is genuinely nothing to draw", () => {
    expect(resolveFootprint({ pins: [], aspect: 0.7 })).toBeNull();
  });

  it("uses the page aspect for the box, not a leftover trace aspect", () => {
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
    expect(result!.outline.pageAspect).toBe(0.7);
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
