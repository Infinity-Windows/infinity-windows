// Reading the exterior ELEVATION sheets as a reference for the crew.
//
// A floor plan says a window is in the north wall of bedroom 2. An elevation
// says which hole in that wall it is — third from the left, above the stone,
// under the low roof. That is the question an installer standing outside with a
// unit on his shoulder is actually asking, and PR #127 was already throwing the
// answer away: it identifies the elevation sheets so their repeated numbers stop
// inflating the opening count, then drops those callouts on the floor.
//
// This module turns the dropped callouts into a reference:
//   • each elevation sheet holds two or three separate drawings, each captioned
//     underneath ("FRONT ELEVATION - SOUTH"), so a page is not a view — the
//     caption positions cut the page into regions and a callout belongs to the
//     region it falls in;
//   • the caption is also the only honest source for a name, so the plain
//     English the crew reads ("Front of the house (south)") is derived from it
//     and nothing is shown for a drawing the sheet never named;
//   • a mark drawn twice in the SAME drawing is one appearance, and the same
//     façade drawn twice on one sheet (Black Desert draws the front as both
//     "FRONT ELEVATION - SOUTH" and "FRONT PROPERTY VIEW") collapses to one
//     entry, on the evidence of the two captions naming the same face.
//
// Everything here is PURE — no DOM, no pdf.js, no network. `pdf.ts` supplies the
// positioned text lines and callouts; `elevationCrops` turns an appearance into
// a picture.

import { bboxToPixelRect, type Bbox } from "./markDrawing";
import { isElevationSheet, type PdfTextPage } from "./planDetails";

/** One line of page text with its position, normalized 0..1 from the top-left. */
export interface SheetTextLine {
  pageNumber: number;
  text: string;
  x: number;
  y: number;
}

/** A mark callout as read off the plan, with the label's own size when known. */
export interface CalloutLike {
  mark: string;
  pageNumber: number;
  x: number;
  y: number;
  /** Normalized width/height of the drawn number itself, when the PDF said. */
  labelW?: number | null;
  labelH?: number | null;
}

const FACE_WORDS = ["FRONT", "REAR", "BACK", "LEFT", "RIGHT", "SIDE", "COURTYARD"];
const COMPASS_WORDS = ["NORTH", "SOUTH", "EAST", "WEST"];
/**
 * Words a drawing title may contain that carry no meaning for us. Anything
 * outside this vocabulary means the line is prose, not a title — the same
 * "is there a loose English word here?" test `isMarkCallout` uses.
 */
const FILLER_WORDS = [
  "PROPERTY",
  "EXTERIOR",
  "OVERALL",
  "OF",
  "THE",
  "HOUSE",
  "BUILDING",
  "AND",
  "SCALE",
];
/**
 * The head noun of a drawing title. Deliberately tolerant of the draughtsman's
 * spelling: Black Desert's own courtyard sheet says "ELEVETAION", twice, and a
 * typo is no reason to leave a crew without a picture. Plural "ELEVATIONS" is
 * NOT matched — that is the sheet-level title block ("EXTERIOR ELEVATIONS"),
 * which names the whole page rather than one drawing on it.
 */
const ELEVATION_HEAD_RE = /^ELEV[AEIOU]{1,2}T[AEIOU]{1,3}O?N$/;
const VIEW_HEAD_RE = /^VIEW$/;

export interface ParsedViewTitle {
  /** The caption exactly as the sheet wrote it. */
  raw: string;
  /** Face words in the order the title used them, e.g. ["REAR","RIGHT","COURTYARD"]. */
  faces: string[];
  /** Compass bearing when the title gave one, e.g. "SOUTH". */
  compass: string | null;
  kind: "elevation" | "view";
}

/**
 * Parse a drawing caption, or null when the line isn't one.
 *
 * Accepts "FRONT ELEVATION - SOUTH", "REAR PROPERTY ELEVATION",
 * "FRONT PROPERTY VIEW", "REAR RIGHT COURTYARD ELEVETAION". Rejects the
 * sheet-level "EXTERIOR ELEVATIONS", the floor plan's
 * "VERIFY W/ THE EXTERIOR ELEVATION FOR THE SILL HEIGHT", and anything else
 * with a word in it we don't recognise. PURE.
 */
export function parseViewTitle(raw: string): ParsedViewTitle | null {
  const tokens = raw.toUpperCase().split(/[^A-Z]+/).filter(Boolean);
  if (tokens.length === 0 || tokens.length > 6) return null;

  let kind: "elevation" | "view" | null = null;
  const faces: string[] = [];
  let compass: string | null = null;

  for (const token of tokens) {
    if (ELEVATION_HEAD_RE.test(token)) {
      kind ??= "elevation";
      continue;
    }
    if (VIEW_HEAD_RE.test(token)) {
      kind ??= "view";
      continue;
    }
    if (FACE_WORDS.includes(token)) {
      if (!faces.includes(token)) faces.push(token);
      continue;
    }
    if (COMPASS_WORDS.includes(token)) {
      compass ??= token;
      continue;
    }
    if (FILLER_WORDS.includes(token)) continue;
    return null;
  }

  if (!kind) return null;
  if (faces.length === 0 && !compass) return null;
  return { raw: raw.replace(/\s+/g, " ").trim(), faces, compass, kind };
}

/**
 * Which face of the building a caption is describing, as a comparable key.
 *
 * Compass bearings are deliberately left OUT of the key: Black Desert captions
 * the front of the house twice on one sheet, once as "FRONT ELEVATION - SOUTH"
 * and once as "FRONT PROPERTY VIEW", and both say FRONT. The face words are the
 * sheet's own statement that these are the same wall, which is the only evidence
 * we have for collapsing them — so they are the whole key. "FRONT RIGHT
 * COURTYARD" keeps all three words and therefore never collapses into "FRONT".
 * PURE.
 */
export function viewFaceKey(title: ParsedViewTitle): string {
  if (title.faces.length > 0) return [...title.faces].sort().join("+");
  return `COMPASS:${title.compass}`;
}

const FACE_PHRASES: Record<string, string> = {
  FRONT: "Front of the house",
  REAR: "Back of the house",
  BACK: "Back of the house",
  LEFT: "Left side of the house",
  RIGHT: "Right side of the house",
  SIDE: "Side of the house",
};
const FACE_WORDS_PLAIN: Record<string, string> = {
  FRONT: "front",
  REAR: "back",
  BACK: "back",
  LEFT: "left",
  RIGHT: "right",
  SIDE: "side",
};
const COMPASS_PLAIN: Record<string, string> = {
  NORTH: "north",
  SOUTH: "south",
  EAST: "east",
  WEST: "west",
};

/**
 * The caption in words a crew member reads without translating: "Front of the
 * house (south)", "Courtyard (back right)". The compass bearing is kept because
 * that is how a foreman says which side of a house he means on the phone.
 * Returns null when the caption says nothing usable, and the card then shows
 * nothing rather than "page 3". PURE.
 */
export function viewLabel(viewName: string | null | undefined): string | null {
  if (!viewName) return null;
  const title = parseViewTitle(viewName);
  if (!title) return null;

  const compass = title.compass ? COMPASS_PLAIN[title.compass] : null;

  if (title.faces.includes("COURTYARD")) {
    const others = title.faces
      .filter((f) => f !== "COURTYARD")
      .map((f) => FACE_WORDS_PLAIN[f])
      .filter(Boolean);
    const where = others.length > 0 ? others.join(" ") : compass;
    return where ? `Courtyard (${where})` : "Courtyard";
  }

  const face = title.faces.map((f) => FACE_PHRASES[f]).find(Boolean);
  if (face) return compass ? `${face} (${compass})` : face;
  if (compass) {
    return `${compass[0].toUpperCase()}${compass.slice(1)} side of the house`;
  }
  return null;
}

/**
 * How much we'd rather show this caption than another of the same face. A
 * straight elevation with a compass bearing is the drawing the trade means by
 * "the south elevation"; a "property view" of the same wall is the same
 * information with landscaping over it. Both are true, so this only decides
 * which one we lead with. PURE.
 */
export function viewRank(title: ParsedViewTitle): number {
  return (title.compass ? 2 : 0) + (title.kind === "elevation" ? 1 : 0);
}

/** One captioned drawing on a sheet: its caption and the band of page it owns. */
export interface ViewRegion {
  pageNumber: number;
  regionIndex: number;
  viewName: string;
  title: ParsedViewTitle;
  /** Normalized y band of the page this drawing occupies (top-left origin). */
  top: number;
  bottom: number;
  /** Where the caption itself sits, so the crop can include it. */
  titleX: number;
}

/** Keep the caption inside the crop — it is the sheet's own proof of the view. */
const CAPTION_MARGIN = 0.02;

/**
 * Cut one page into its captioned drawings.
 *
 * The caption sits UNDERNEATH its drawing, so drawing `i` runs from the caption
 * above it down to its own caption. Measured against Black Desert's A.201: three
 * captions at y 0.343 / 0.650 / 0.900 split the sheet's 28 callouts into 8 / 13 /
 * 7 — exactly the three drawings on the page. PURE.
 */
export function pageViewRegions(lines: SheetTextLine[]): ViewRegion[] {
  const titled = lines
    .map((line) => ({ line, title: parseViewTitle(line.text) }))
    .filter(
      (entry): entry is { line: SheetTextLine; title: ParsedViewTitle } =>
        entry.title !== null,
    )
    .sort((a, b) => a.line.y - b.line.y);

  return titled.map((entry, index) => ({
    pageNumber: entry.line.pageNumber,
    regionIndex: index,
    viewName: entry.title.raw,
    title: entry.title,
    top: index === 0 ? 0 : titled[index - 1].line.y,
    bottom: Math.min(1, entry.line.y + CAPTION_MARGIN),
    titleX: entry.line.x,
  }));
}

/** Padding around the callouts of a drawing, as a fraction of the page. */
export const CROP_PAD_X = 0.1;
export const CROP_PAD_Y = 0.11;

/**
 * The box to crop for one drawing: every callout in it, padded enough to show
 * the roofline, the ground and the neighbouring window numbers, and clamped to
 * the drawing's own band so a crop can never bleed into the façade above or
 * below it. Locating yourself on a wall is done by the numbers either side, so
 * the padding is generous on purpose. PURE.
 */
export function regionCropBbox(
  region: Pick<ViewRegion, "top" | "bottom" | "titleX">,
  callouts: { x: number; y: number }[],
): Bbox {
  const clamp = (n: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, n));
  const xs = [...callouts.map((c) => c.x), region.titleX];
  const ys = callouts.map((c) => c.y);
  const x0 = clamp(Math.min(...xs) - CROP_PAD_X);
  const x1 = clamp(Math.max(...xs) + CROP_PAD_X);
  const y0 = clamp(Math.min(...ys) - CROP_PAD_Y, region.top, region.bottom);
  const y1 = clamp(Math.max(...ys) + CROP_PAD_Y, region.top, region.bottom);
  return [x0, y0, x1, y1];
}

/** A ring to draw on a crop, in pixels of that crop. */
export interface RingCircle {
  cx: number;
  cy: number;
  r: number;
  lineWidth: number;
}

/**
 * Where to ring the mark on a crop.
 *
 * What the plans give us is the position and size of the NUMBER the draughtsman
 * wrote, not an outline of the window — so the ring goes round the number, at
 * the number's own size. That is a claim we can stand behind in front of a wall:
 * "this number, here, on this elevation". Drawing a rectangle where we think the
 * glass is would be a guess dressed up as a measurement.
 *
 * Falls back to a fraction of the crop when the label size is unknown, and never
 * grows past a fifth of the crop, so a bad number can't cover the drawing. PURE.
 */
export function calloutRingCircle(args: {
  pin: { x: number; y: number };
  label: { w: number | null; h: number | null };
  bbox: Bbox;
  pageWidth: number;
  pageHeight: number;
}): RingCircle {
  const { pin, label, bbox, pageWidth, pageHeight } = args;
  const rect = bboxToPixelRect(bbox, pageWidth, pageHeight);
  const labelPx = Math.max(
    (label.w ?? 0) * pageWidth,
    (label.h ?? 0) * pageHeight,
  );
  const fallback = Math.min(rect.width, rect.height) * 0.05;
  const r = Math.min(
    Math.max(labelPx > 0 ? labelPx * 0.8 : fallback, 10),
    Math.min(rect.width, rect.height) * 0.2,
  );
  return {
    cx: pin.x * Math.floor(pageWidth) - rect.x,
    cy: pin.y * Math.floor(pageHeight) - rect.y,
    r,
    lineWidth: Math.max(2, r * 0.14),
  };
}

/** One mark, drawn once, in one captioned drawing on one elevation sheet. */
export interface ElevationAppearance {
  mark: string;
  pageNumber: number;
  regionIndex: number;
  viewName: string;
  pinX: number;
  pinY: number;
  labelW: number | null;
  labelH: number | null;
  cropBbox: Bbox;
}

/**
 * Turn the callouts an opening extract IGNORED into elevation references.
 *
 * `repeatViewCallouts` are the callouts on elevation sheets — the ones
 * `splitCalloutsByFloorPlan` keeps out of the opening count. Nothing here can
 * create an opening, and nothing an opening was made from can arrive here.
 *
 * A mark repeated inside one drawing (the sheet writes "2 2" over a pair of
 * identical windows) yields ONE appearance, the leftmost, because a second ring
 * on the same façade tells a crew member nothing new. Callouts on a drawing the
 * sheet never captioned are dropped: without a caption we cannot name the wall
 * or tell whether it is the same wall as another drawing, and a picture we
 * can't caption is worse than no picture. PURE.
 */
export function elevationAppearances(args: {
  repeatViewCallouts: CalloutLike[];
  lines: SheetTextLine[];
}): ElevationAppearance[] {
  const { repeatViewCallouts, lines } = args;
  const linesByPage = new Map<number, SheetTextLine[]>();
  for (const line of lines) {
    const list = linesByPage.get(line.pageNumber) ?? [];
    list.push(line);
    linesByPage.set(line.pageNumber, list);
  }

  const out: ElevationAppearance[] = [];
  const pages = [...new Set(repeatViewCallouts.map((c) => c.pageNumber))].sort(
    (a, b) => a - b,
  );

  for (const pageNumber of pages) {
    const regions = pageViewRegions(linesByPage.get(pageNumber) ?? []);
    if (regions.length === 0) continue;
    const pageCallouts = repeatViewCallouts.filter(
      (c) => c.pageNumber === pageNumber,
    );

    for (const region of regions) {
      const inRegion = pageCallouts.filter(
        (c) => c.y >= region.top && c.y <= region.bottom,
      );
      if (inRegion.length === 0) continue;
      const cropBbox = regionCropBbox(region, inRegion);

      const byMark = new Map<string, CalloutLike>();
      for (const callout of inRegion) {
        const existing = byMark.get(callout.mark);
        if (!existing || callout.x < existing.x) byMark.set(callout.mark, callout);
      }

      for (const [mark, callout] of [...byMark.entries()].sort((a, b) =>
        a[0].localeCompare(b[0], undefined, { numeric: true }),
      )) {
        out.push({
          mark,
          pageNumber,
          regionIndex: region.regionIndex,
          viewName: region.viewName,
          pinX: callout.x,
          pinY: callout.y,
          labelW: callout.labelW ?? null,
          labelH: callout.labelH ?? null,
          cropBbox,
        });
      }
    }
  }
  return out;
}

/** True when this page is an elevation sheet — re-exported for the callers. */
export function isElevationPage(page: PdfTextPage): boolean {
  return isElevationSheet(page.text);
}

/** A stored elevation-view row, as the app reads it back. */
export interface ElevationViewLike {
  mark_code: string;
  page_number: number;
  region_index: number;
  view_name: string | null;
  planset_id: string | null;
}

/**
 * The views worth showing for one mark, best first.
 *
 * Two captions naming the same face of the building are one view: Black Desert
 * draws the front twice on A.201 and the back twice on A.202, so mark #9 has
 * three stored appearances and exactly one worth looking at. Anything the sheet
 * left uncaptioned is dropped by the extractor, so a row with an unreadable
 * caption here is treated as its own view rather than guessed at. PURE.
 */
export function pickElevationViews<T extends ElevationViewLike>(rows: T[]): T[] {
  const best = new Map<string, { row: T; rank: number }>();
  for (const row of rows) {
    const title = row.view_name ? parseViewTitle(row.view_name) : null;
    const key = title
      ? viewFaceKey(title)
      : `PAGE:${row.page_number}:${row.region_index}`;
    const rank = title ? viewRank(title) : -1;
    const current = best.get(key);
    if (
      !current ||
      rank > current.rank ||
      (rank === current.rank &&
        (row.page_number < current.row.page_number ||
          (row.page_number === current.row.page_number &&
            row.region_index < current.row.region_index)))
    ) {
      best.set(key, { row, rank });
    }
  }
  return [...best.values()]
    .sort(
      (a, b) =>
        b.rank - a.rank ||
        a.row.page_number - b.row.page_number ||
        a.row.region_index - b.row.region_index,
    )
    .map((entry) => entry.row);
}
