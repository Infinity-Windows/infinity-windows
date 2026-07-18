import { describe, expect, it } from "vitest";
import {
  clampOutlinePoint,
  isValidOutlinePolygon,
  outlinePathD,
  preferOutline,
} from "./outline";

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
