// Static context for the floors you are NOT editing: their walls extruded
// from the frozen serialized plan, plus the flat ceiling lid that "going up
// a floor" promises (owner spec — the lid of the floor below is the ground
// you build on). The active floor stays fully live in the vendor; these are
// just meshes.

import * as THREE from "three";
import { outerPolygons } from "./toFitview";
import type { LiteWall } from "./floors";

const M_TO_CM = 100;

const SHELL_WALL = new THREE.MeshLambertMaterial({
  color: 0xdcd7d0,
  side: THREE.DoubleSide,
});
const SHELL_LID = new THREE.MeshLambertMaterial({
  color: 0xcfc9c1,
  side: THREE.DoubleSide,
});

/**
 * One frozen floor: walls as vertical quads, optionally capped by its lid.
 * `baseY` is RELATIVE to the active floor (the vendor edits at y=0), so
 * floors below sit at negative elevations — you stand on their ceiling.
 */
export function buildFloorShell(
  walls: LiteWall[],
  baseY: number,
  withLid: boolean,
): THREE.Group {
  const group = new THREE.Group();
  group.name = "studio-floor-shell";

  for (const w of walls) {
    const len = Math.hypot(w.x2 - w.x1, w.y2 - w.y1);
    if (len < 1) continue;
    const geo = new THREE.PlaneGeometry(len, w.height);
    const mesh = new THREE.Mesh(geo, SHELL_WALL);
    mesh.position.set(
      (w.x1 + w.x2) / 2,
      baseY + w.height / 2,
      (w.y1 + w.y2) / 2,
    );
    mesh.rotation.y = -Math.atan2(w.y2 - w.y1, w.x2 - w.x1);
    group.add(mesh);
  }

  if (withLid && walls.length >= 3) {
    // The lid covers the floor's outer footprint(s) at its top.
    const like = walls.map((w) => ({
      height: w.height,
      getStartX: () => w.x1,
      getStartY: () => w.y1,
      getEndX: () => w.x2,
      getEndY: () => w.y2,
    }));
    const topY =
      baseY + walls.reduce((h, w) => Math.max(h, w.height), 0);
    for (const mass of outerPolygons(like)) {
      const shape = new THREE.Shape(
        mass.poly.map((p) => new THREE.Vector2(p.x * M_TO_CM, p.z * M_TO_CM)),
      );
      const geo = new THREE.ShapeGeometry(shape);
      const lid = new THREE.Mesh(geo, SHELL_LID);
      lid.rotation.x = Math.PI / 2;
      lid.position.y = topY;
      group.add(lid);
    }
  }

  return group;
}
