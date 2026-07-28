// WORK IN PROGRESS — see PR description.
//
// The specs planset lays each mark out as one PANEL: an elevation drawing plus
// its spec table, tiled a few to a page. The vision pass returns a box that is
// supposed to locate the drawing, and frequently doesn't — it hugs the glass of
// a tall narrow window and misses the dimension lines entirely, or lands off to
// one side and crops nothing but a leader line.
//
// The fix being built here: stop trusting the box for the CROP, and only trust
// it for WHICH panel the mark is in. Panel bounds come from the page itself.
//
// Everything in this module is PURE.

/** Normalized `[x0,y0,x1,y1]`, 0..1, origin TOP-LEFT of the rendered page. */
export type Bbox = [number, number, number, number];

/** Fraction of a bbox's area that lies inside `panel`. */
export function overlapFraction(bbox: Bbox, panel: Bbox): number {
  const w = Math.max(0, Math.min(bbox[2], panel[2]) - Math.max(bbox[0], panel[0]));
  const h = Math.max(0, Math.min(bbox[3], panel[3]) - Math.max(bbox[1], panel[1]));
  const area = (bbox[2] - bbox[0]) * (bbox[3] - bbox[1]);
  if (area <= 0) return 0;
  return (w * h) / area;
}

/**
 * Pick the panel a box most belongs to, or null when it doesn't meaningfully
 * sit in any of them.
 */
export function panelForBbox(bbox: Bbox, panels: Bbox[]): Bbox | null {
  let best: Bbox | null = null;
  let bestOverlap = 0;
  for (const panel of panels) {
    const overlap = overlapFraction(bbox, panel);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = panel;
    }
  }
  return bestOverlap > 0 ? best : null;
}
