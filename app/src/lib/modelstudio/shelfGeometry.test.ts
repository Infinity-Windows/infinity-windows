import { describe, expect, it } from "vitest";
import {
  buildShelfGeometry,
  normalizeShelfConfig,
  SHELF_DEFAULT,
} from "./shelfGeometry";

describe("the shelf config", () => {
  it("junk is refused, not guessed at", () => {
    expect(normalizeShelfConfig(null)).toBeNull();
    expect(normalizeShelfConfig({ lengthCm: 0, depthCm: 60, heightCm: 200 })).toBeNull();
    expect(normalizeShelfConfig({ lengthCm: -5, depthCm: 60, heightCm: 200 })).toBeNull();
  });

  it("levels clamp to something buildable", () => {
    const c = normalizeShelfConfig({ lengthCm: 100, depthCm: 50, heightCm: 200, levels: 99 })!;
    expect(c.levels).toBe(8);
    const one = normalizeShelfConfig({ lengthCm: 100, depthCm: 50, heightCm: 200, levels: 0 })!;
    expect(one.levels).toBe(1);
  });
});

describe("the built rack", () => {
  it("spans exactly its declared dimensions", () => {
    const { geometry } = buildShelfGeometry(SHELF_DEFAULT);
    const bb = geometry.boundingBox!;
    expect(bb.max.x - bb.min.x).toBeCloseTo(SHELF_DEFAULT.lengthCm, 3);
    expect(bb.max.z - bb.min.z).toBeCloseTo(SHELF_DEFAULT.depthCm, 3);
    expect(bb.max.y - bb.min.y).toBeCloseTo(SHELF_DEFAULT.heightCm, 3);
  });

  it("stands ON the floor: y runs 0..height, never below", () => {
    // The engine places OnFloorItems by their own y; a rack centered on the
    // origin would be half-buried in the slab.
    const { geometry } = buildShelfGeometry(SHELF_DEFAULT);
    const bb = geometry.boundingBox!;
    expect(bb.min.y).toBeCloseTo(0, 3);
  });
});
