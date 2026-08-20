// Studio 100x #46: the LEAN material picker's catalog. Every entry is a
// local file under app/public/modelstudio/textures (generated, not
// downloaded — see the sibling vendor CDN fix, #45) so a finish choice
// never depends on the network. Deliberately small: 4 wall finishes, 2
// floor finishes, no custom-color input (owner call).
//
// Shape rides the vendor's own texture format verbatim (StudioTexture in
// core.d.ts / WallTexture+FloorTexture in vendor/model/floorplan.ts) so a
// choice here is just a value the vendor already knows how to persist and
// render — no new serialization to build or test.

export interface Finish {
  id: string;
  label: string;
  url: string;
  /** true = tile the swatch to fit (flat colors); false = repeat every
   * `scale` cm (real textures). Same convention as the vendor's built-in
   * texture lists (vendor/constants.ts). */
  stretch: boolean;
  scale: number;
}

const TEX = "/modelstudio/textures";

export const WALL_FINISHES: Finish[] = [
  { id: "white", label: "White", url: `${TEX}/wall-white.png`, stretch: true, scale: 0 },
  { id: "brick", label: "Brick red", url: `${TEX}/wall-brick.png`, stretch: true, scale: 0 },
  { id: "siding", label: "Siding gray", url: `${TEX}/wall-siding.png`, stretch: true, scale: 0 },
  { id: "stucco", label: "Stucco tan", url: `${TEX}/wall-stucco.png`, stretch: true, scale: 0 },
];

export const FLOOR_FINISHES: Finish[] = [
  { id: "wood", label: "Wood", url: `${TEX}/wood.png`, stretch: false, scale: 300 },
  { id: "concrete", label: "Concrete", url: `${TEX}/concrete.png`, stretch: false, scale: 300 },
];

/** Match a saved texture back to its catalog entry (to highlight the
 * active button) — url is the only field worth comparing, since it's the
 * one thing that uniquely identifies a finish. */
export function finishForUrl(
  finishes: Finish[],
  url: string | null | undefined,
): Finish | null {
  if (!url) return null;
  return finishes.find((f) => f.url === url) ?? null;
}
