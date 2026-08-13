// The seed must never mint coincident twin walls: adjacent masses trace the
// same boundary, and seeding it once per mass left a solid wall in front of
// every window on the shared line ("window hiding behind the wall").

import { describe, expect, it } from "vitest";
import { buildStudioSeed } from "./fromProject";

interface Plan {
  corners: Record<string, { x: number; y: number }>;
  walls: { corner1: string; corner2: string }[];
}

function planOf(seed: { serialized: string }): Plan {
  return (JSON.parse(seed.serialized) as { floorplan: Plan }).floorplan;
}

function job(footprints: { x: number; z: number }[][]) {
  return { building: { footprints }, windows: [] };
}

const rect = (x0: number, z0: number, x1: number, z1: number) => [
  { x: x0, z: z0 },
  { x: x1, z: z0 },
  { x: x1, z: z1 },
  { x: x0, z: z1 },
];

describe("buildStudioSeed wall dedupe", () => {
  it("keeps a lone mass as 4 corners and 4 walls", () => {
    const plan = planOf(buildStudioSeed(job([rect(0, 0, 10, 6)])));
    expect(Object.keys(plan.corners)).toHaveLength(4);
    expect(plan.walls).toHaveLength(4);
  });

  it("merges the shared boundary of two adjacent masses into one wall", () => {
    // Two rooms side by side sharing the x=10 edge: 6 distinct corners,
    // 7 walls — NOT 8 corners and 8 walls with a twin on the shared line.
    const plan = planOf(
      buildStudioSeed(job([rect(0, 0, 10, 6), rect(10, 0, 18, 6)])),
    );
    expect(Object.keys(plan.corners)).toHaveLength(6);
    expect(plan.walls).toHaveLength(7);
  });

  it("snaps near-identical corners from imprecise traces", () => {
    // The second mass's shared corners are traced 1 cm off — still one wall.
    const plan = planOf(
      buildStudioSeed(
        job([
          rect(0, 0, 10, 6),
          [
            { x: 10.01, z: 0.01 },
            { x: 18, z: 0 },
            { x: 18, z: 6 },
            { x: 10.01, z: 5.99 },
          ],
        ]),
      ),
    );
    expect(Object.keys(plan.corners)).toHaveLength(6);
    expect(plan.walls).toHaveLength(7);
  });

  it("collapses zero-length segments left by the snap", () => {
    // A sliver polygon whose two ends snap to the same corner never emits a
    // zero-length wall (blueprint chokes on those).
    const plan = planOf(
      buildStudioSeed(
        job([
          [
            { x: 0, z: 0 },
            { x: 0.01, z: 0.01 },
            { x: 10, z: 0 },
            { x: 5, z: 6 },
          ],
        ]),
      ),
    );
    for (const w of plan.walls) {
      expect(w.corner1).not.toBe(w.corner2);
    }
  });
});
