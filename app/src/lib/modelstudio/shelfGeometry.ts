// The shelf — Studio's first free-standing object (ticket 22, slice 2).
//
// A rack drawn as a rack: four posts and evenly spaced boards, built from
// composed boxes exactly the way unitGeometry builds windows — no CDN
// models, nothing fetched. Dimensions are real centimeters, because the
// whole point of the warehouse map is that the drawing tells the truth
// about what fits where.
//
// The vendored engine has carried the machinery for this since day one
// (OnFloorItem, itemType 8: floor placement, drag, serialization) with zero
// product wiring — the upstream demo pointed it at furniture GLBs on a CDN.
// This file is the wiring.

import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

export interface ShelfConfig {
  lengthCm: number;
  depthCm: number;
  heightCm: number;
  /** Board levels including the top; posts run full height. */
  levels: number;
}

/** A sensible pallet-rack bay to start from; every number is editable. */
export const SHELF_DEFAULT: ShelfConfig = {
  lengthCm: 240,
  depthCm: 60,
  heightCm: 200,
  levels: 4,
};

export function normalizeShelfConfig(raw: unknown): ShelfConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
  const lengthCm = n(r.lengthCm);
  const depthCm = n(r.depthCm);
  const heightCm = n(r.heightCm);
  if (!lengthCm || !depthCm || !heightCm) return null;
  const rawLevels =
    typeof r.levels === "number" && Number.isFinite(r.levels) ? Math.trunc(r.levels) : 4;
  const levels = Math.min(8, Math.max(1, rawLevels));
  return { lengthCm, depthCm, heightCm, levels };
}

const POST = 5; // cm square uprights
const BOARD = 4; // cm board thickness

/**
 * Geometry centered the way the engine expects an OnFloorItem: x/z centered
 * on the origin, y running 0..height (the floor is y=0 under the item's own
 * placement math).
 */
export function buildShelfGeometry(config: ShelfConfig): {
  geometry: THREE.BufferGeometry;
  materials: THREE.Material[];
} {
  const { lengthCm: L, depthCm: D, heightCm: H, levels } = config;
  const parts: THREE.BufferGeometry[] = [];

  const box = (w: number, h: number, d: number, x: number, y: number, z: number) => {
    const g = new THREE.BoxGeometry(w, h, d);
    g.translate(x, y, z);
    parts.push(g);
  };

  // Four posts, full height, inset to the corners.
  const px = L / 2 - POST / 2;
  const pz = D / 2 - POST / 2;
  for (const [x, z] of [
    [-px, -pz],
    [px, -pz],
    [px, pz],
    [-px, pz],
  ]) {
    box(POST, H, POST, x, H / 2, z);
  }

  // Boards: bottom board sits just off the floor, top board at the top,
  // the rest evenly between.
  for (let i = 0; i < levels; i++) {
    const y =
      levels === 1 ? BOARD / 2 : BOARD / 2 + (i * (H - BOARD)) / (levels - 1);
    box(L, BOARD, D, 0, y, 0);
  }

  const geometry = mergeGeometries(parts, false) ?? new THREE.BoxGeometry(L, H, D);
  for (const p of parts) p.dispose();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  const material = new THREE.MeshStandardMaterial({
    color: 0x8a6d3b, // plain lumber; reads as "rack" instantly
    roughness: 0.9,
    metalness: 0.05,
    side: THREE.DoubleSide,
  });
  return { geometry, materials: [material] };
}
