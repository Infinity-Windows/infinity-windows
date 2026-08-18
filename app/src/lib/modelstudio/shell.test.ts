import { describe, expect, it } from "vitest";
import { buildShellSerialized, CONEX_DEFAULT, shellDims } from "./shell";
import type { StorageContainer } from "../storage";

const box = (over: Partial<StorageContainer>): StorageContainer =>
  ({ id: "c1", name: "Conex 1", kind: "conex", ...over }) as StorageContainer;

describe("what dims a shell uses", () => {
  it("measured dims win", () => {
    const c = box({ length_cm: 1219, width_cm: 244, height_cm: 259 });
    expect(shellDims(c)).toEqual({ lengthCm: 1219, widthCm: 244, heightCm: 259 });
  });

  it("an unmeasured conex gets the standard box", () => {
    expect(shellDims(box({}))).toEqual(CONEX_DEFAULT);
  });

  it("the building has no standard size — somebody has to be asked", () => {
    expect(shellDims(box({ kind: "building" }))).toBeNull();
  });

  it("partial measurements do not silently mix with defaults", () => {
    // Length measured, the rest missing: guessing the other two would draw a
    // box that LOOKS measured. Ask instead.
    expect(shellDims(box({ length_cm: 900 }))).toEqual(CONEX_DEFAULT);
  });
});

describe("the generated model", () => {
  it("is Studio's own save format: four corners, four walls, real heights", () => {
    const parsed = JSON.parse(
      buildShellSerialized({ lengthCm: 606, widthCm: 244, heightCm: 259 }),
    ) as {
      floorplan: {
        corners: Record<string, { x: number; y: number }>;
        walls: { corner1: string; corner2: string; height: number }[];
      };
      items: unknown[];
    };
    expect(Object.keys(parsed.floorplan.corners)).toHaveLength(4);
    expect(parsed.floorplan.walls).toHaveLength(4);
    expect(parsed.floorplan.walls.every((w) => w.height === 259)).toBe(true);
    expect(parsed.items).toEqual([]);
    // The door end is +x: the front corners sit at x = length (ADR-0006's
    // "front = door end" is what the viewer's glow will lean on).
    expect(parsed.floorplan.corners["shell-front-left"]).toEqual({ x: 606, y: 0 });
    expect(parsed.floorplan.corners["shell-back-right"]).toEqual({ x: 0, y: 244 });
  });

  it("every wall references a corner that exists", () => {
    const parsed = JSON.parse(
      buildShellSerialized({ lengthCm: 100, widthCm: 50, heightCm: 30 }),
    ) as {
      floorplan: {
        corners: Record<string, unknown>;
        walls: { corner1: string; corner2: string }[];
      };
    };
    for (const w of parsed.floorplan.walls) {
      expect(parsed.floorplan.corners[w.corner1]).toBeDefined();
      expect(parsed.floorplan.corners[w.corner2]).toBeDefined();
    }
  });
});
