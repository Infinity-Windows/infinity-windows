// True-dimension shells (ticket 22, first slice).
//
// A conex or the warehouse building, drawn as the box it is: four corners,
// four walls at the container's real measurements, in the exact serialized
// format Studio's own save button writes — so the generated shell opens in
// the editor indistinguishable from one a supervisor drew by hand, and the
// shelf work (next slice) lands inside it with nothing special-cased.
//
// The world is centimeters (vendor/core/configuration.ts). The DOOR END of a
// conex is the +x end, and everything downstream leans on that: areas say
// "front = door end" (ADR-0006), so the viewer's front zone is the +x third.

import type { StorageContainer } from "../storage";
import { containerKind } from "../storage";

/** Standard boxes, for a conex nobody has measured yet: 20ft × 8ft × 8'6". */
export const CONEX_DEFAULT = { lengthCm: 606, widthCm: 244, heightCm: 259 };

export interface ShellDims {
  lengthCm: number;
  widthCm: number;
  heightCm: number;
}

/** The dims a shell would use for this container, or null when somebody has
 * to be asked first (the building has no standard size). */
export function shellDims(c: StorageContainer): ShellDims | null {
  const measured =
    c.length_cm != null && c.width_cm != null && c.height_cm != null
      ? { lengthCm: c.length_cm, widthCm: c.width_cm, heightCm: c.height_cm }
      : null;
  if (measured) return measured;
  return containerKind(c) === "conex" ? CONEX_DEFAULT : null;
}

/**
 * The serialized model: Studio's own on-disk shape (model.exportSerialized),
 * one floor, no items yet. Corner ids are stable and readable on purpose —
 * a generated file somebody has to debug should say which corner is which.
 */
export function buildShellSerialized(dims: ShellDims): string {
  const { lengthCm: L, widthCm: W, heightCm: H } = dims;
  const corners: Record<string, { x: number; y: number }> = {
    "shell-back-left": { x: 0, y: 0 },
    "shell-front-left": { x: L, y: 0 },
    "shell-front-right": { x: L, y: W },
    "shell-back-right": { x: 0, y: W },
  };
  const wall = (a: string, b: string) => ({
    corner1: a,
    corner2: b,
    frontTexture: undefined,
    backTexture: undefined,
    height: H,
  });
  return JSON.stringify({
    floorplan: {
      corners,
      walls: [
        wall("shell-back-left", "shell-front-left"),
        wall("shell-front-left", "shell-front-right"),
        wall("shell-front-right", "shell-back-right"),
        wall("shell-back-right", "shell-back-left"),
      ],
      wallTextures: [],
      floorTextures: {},
      newFloorTextures: {},
    },
    items: [],
  });
}

/** What the generated Studio project is called: "Conex 1 — shell". */
export function shellName(c: Pick<StorageContainer, "name">): string {
  return `${c.name} — shell`;
}
