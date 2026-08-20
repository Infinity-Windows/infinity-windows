// Studio 100x #49: a flat parapet roof — "a clean slab beats a weird hip"
// (owner call). Built the same way floorShell.ts caps a frozen floor's
// ceiling (same outerPolygons() footprint walk, same flat ShapeGeometry
// lid), just sitting on TOP of the building instead of below a floor
// above, plus a short parapet wall traced around its edge so it actually
// reads as a roof rather than a second ceiling.
//
// Deliberately NOT the vendor's buildRoof (vendor/three/floor.ts) — that
// one is commented out for cause ("roofs look weird") and stays that way.

import * as THREE from "three";
import { outerPolygons } from "./toFitview";
import type { LiteWall } from "./floors";

const M_TO_CM = 100;
/** 12" cap wall — enough to read as a parapet lip, not a fence. */
const PARAPET_HEIGHT_CM = 30;

const ROOF_DECK = new THREE.MeshLambertMaterial({ color: 0xc9c2b8, side: THREE.DoubleSide });
const ROOF_PARAPET = new THREE.MeshLambertMaterial({ color: 0xb0a89b, side: THREE.DoubleSide });

/**
 * A flat parapet roof capping `walls`' outer footprint, `baseY` + the
 * walls' own height + the parapet's height up. Multi-mass buildings get one
 * deck + parapet per connected mass, same as floorShell's lid. Returns null
 * when there's nothing to cap (no walls, or none form a closed footprint) —
 * callers should treat that as "draw nothing", not an error.
 */
export function buildRoof(walls: LiteWall[], baseY: number): THREE.Group | null {
  if (walls.length < 3) return null;
  const like = walls.map((w) => ({
    height: w.height,
    getStartX: () => w.x1,
    getStartY: () => w.y1,
    getEndX: () => w.x2,
    getEndY: () => w.y2,
  }));
  const wallTopY = baseY + walls.reduce((h, w) => Math.max(h, w.height), 0);
  const deckY = wallTopY + PARAPET_HEIGHT_CM;

  const group = new THREE.Group();
  group.name = "studio-roof";
  let any = false;

  for (const mass of outerPolygons(like)) {
    if (mass.poly.length < 3) continue;
    any = true;
    const pts = mass.poly.map((p) => new THREE.Vector2(p.x * M_TO_CM, p.z * M_TO_CM));

    const deckGeo = new THREE.ShapeGeometry(new THREE.Shape(pts));
    const deck = new THREE.Mesh(deckGeo, ROOF_DECK);
    deck.rotation.x = Math.PI / 2;
    deck.position.y = deckY;
    group.add(deck);

    // Parapet: a short wall traced around the footprint's outer edge.
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      const len = a.distanceTo(b);
      if (len < 1) continue;
      const geo = new THREE.PlaneGeometry(len, PARAPET_HEIGHT_CM);
      const mesh = new THREE.Mesh(geo, ROOF_PARAPET);
      mesh.position.set((a.x + b.x) / 2, wallTopY + PARAPET_HEIGHT_CM / 2, (a.y + b.y) / 2);
      mesh.rotation.y = -Math.atan2(b.y - a.y, b.x - a.x);
      group.add(mesh);
    }
  }

  return any ? group : null;
}

/** Dispose every mesh's geometry the group owns — materials are shared
 * module-level constants, so only geometries need cleanup on rebuild. */
export function disposeRoof(group: THREE.Group): void {
  group.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    mesh.geometry?.dispose();
  });
}
