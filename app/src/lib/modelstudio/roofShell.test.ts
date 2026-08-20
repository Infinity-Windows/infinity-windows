// Studio 100x #49: buildRoof is pure (given walls, returns a mesh group),
// so its shape is worth pinning directly rather than only through the
// Studio page's wiring.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { buildRoof } from "./roofShell";
import type { LiteWall } from "./floors";

function rect(x0: number, y0: number, x1: number, y1: number, height = 250): LiteWall[] {
  return [
    { x1: x0, y1: y0, x2: x1, y2: y0, height },
    { x1: x1, y1: y0, x2: x1, y2: y1, height },
    { x1: x1, y1: y1, x2: x0, y2: y1, height },
    { x1: x0, y1: y1, x2: x0, y2: y0, height },
  ];
}

describe("buildRoof", () => {
  it("returns null when there aren't enough walls to cap", () => {
    expect(buildRoof([], 0)).toBeNull();
    expect(buildRoof([{ x1: 0, y1: 0, x2: 500, y2: 0, height: 250 }], 0)).toBeNull();
  });

  it("caps a closed rectangle with a deck + a 4-sided parapet", () => {
    const group = buildRoof(rect(0, 0, 500, 400), 0)!;
    expect(group).not.toBeNull();
    // 1 deck mesh + 4 parapet wall meshes for a simple rectangle.
    expect(group.children).toHaveLength(5);
    const meshes = group.children as THREE.Mesh[];
    expect(meshes.every((m) => m instanceof THREE.Mesh)).toBe(true);
  });

  it("sits the deck above the parapet, which sits at the walls' top", () => {
    const walls = rect(0, 0, 500, 400, 250);
    const group = buildRoof(walls, 100)!; // baseY = 100
    const meshes = group.children as THREE.Mesh[];
    const ys = meshes.map((m) => m.position.y);
    const deckY = Math.max(...ys);
    const parapetYs = ys.filter((y) => y !== deckY);
    // Deck sits above every parapet segment's (mid-height) position.
    expect(parapetYs.every((y) => y < deckY)).toBe(true);
    // Parapet mid-height is between the wall top (100+250=350) and the deck.
    expect(parapetYs[0]).toBeGreaterThan(350);
    expect(deckY).toBeGreaterThan(parapetYs[0]);
  });

  it("caps each mass separately for a multi-mass building", () => {
    const a = rect(0, 0, 400, 400);
    const b = rect(1000, 0, 1400, 400); // disconnected from `a`
    const group = buildRoof([...a, ...b], 0)!;
    // 2 decks + 8 parapet segments (4 per mass).
    expect(group.children).toHaveLength(10);
  });
});
