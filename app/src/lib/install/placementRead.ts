// Vision placement (wave V-A): read WHERE each still-unplaced schedule mark
// sits on the building planset's floor-plan pages. Mirrors scheduleRead.ts —
// every schedule read in the app goes through that module, and every
// placement read goes through this one, so the two laws below can't drift
// between call sites:
//
//   CAD-WINS. This reads POSITIONS for marks the schedule already knows
//   about; it never creates an opening and never changes a count. A mark it
//   can't find on the plan simply stays unplaced.
//
//   FLOOR-PLAN PAGES ONLY. Elevation sheets redraw the same windows the
//   floor plan already numbers (planDetails.ts's isElevationSheet), so a
//   position read off one would be a position on the wrong drawing. Reuses
//   findFloorPlanPages exactly as ProjectMap's "Load marks" already does —
//   which excludes elevation sheets internally.

import type { PDFDocumentProxy } from "pdfjs-dist";
import { extractAllText, extractPlanMarkCallouts } from "./pdf";
import { findFloorPlanPages } from "./planDetails";
import { renderSpecPageImages } from "./renderSpecImages";
import { aiExtractPlacement, type KnownMarkLike } from "./api";
import {
  resolvePlacements,
  type ResolvedPlacement,
} from "../fitview/placementSuggestions";
import type { ProjectOpening } from "./types";

export type PlacementSuggestion = ResolvedPlacement;

export interface PlacementReadResult {
  /** Marks the vision read located, resolved to a real opening id. */
  suggestions: PlacementSuggestion[];
  /** Known marks (still unplaced) the read never located on any floor-plan page. */
  notFoundMarks: string[];
  /** Plan callouts that matched no known mark — never turned into an opening. */
  unknownCallouts: { mark: string; page: number }[];
  /** Floor-plan pages the vision call could not read even after a retry. */
  failedPages: number[];
  /** Which pages were sent, for the "reading pages 2, 3" progress line. */
  floorPlanPages: number[];
  limited?: boolean;
  note?: string | null;
}

const EMPTY: PlacementReadResult = {
  suggestions: [],
  notFoundMarks: [],
  unknownCallouts: [],
  failedPages: [],
  floorPlanPages: [],
};

/**
 * Find placements for every opening in `openings` that has no real pin yet.
 * Renders only the detected floor-plan pages of `doc` (the building planset)
 * and sends them, plus the exact list of still-unplaced mark codes, to
 * extract-placement. Openings that already carry a real pin are left out of
 * the request entirely — there is nothing to ask the model to find for them.
 */
export async function readPlacementsFromDoc(
  doc: PDFDocumentProxy,
  openings: Pick<ProjectOpening, "id" | "opening_code" | "pin_x">[],
  /** Fires as soon as the floor-plan pages are known, before the (slower)
   * vision call — lets the caller show "reading pages 2, 4…" right away
   * instead of only after the whole read finishes. */
  onFloorPlanPages?: (pages: number[]) => void,
): Promise<PlacementReadResult> {
  const unplaced = openings.filter((o) => o.pin_x == null);
  if (unplaced.length === 0) return EMPTY;

  const textPages = await extractAllText(doc);
  const callouts = await extractPlanMarkCallouts(doc);
  const floorPlanPages = findFloorPlanPages(textPages, callouts);
  onFloorPlanPages?.(floorPlanPages);

  // No detected floor-plan page is an honest "nothing to read", not a reason
  // to fall back to every page — that fallback is exactly how an elevation
  // sheet would sneak into a vision-placement read (renderSpecPageImages
  // treats an EMPTY pages[] the same as "no filter" and renders page 1..N).
  if (floorPlanPages.length === 0) {
    return { ...EMPTY, notFoundMarks: unplaced.map((o) => o.opening_code) };
  }

  const pageImages = await renderSpecPageImages(doc, {
    maxPages: 24,
    pages: floorPlanPages,
  });
  if (pageImages.length === 0) {
    return {
      ...EMPTY,
      floorPlanPages,
      notFoundMarks: unplaced.map((o) => o.opening_code),
    };
  }

  const marks: KnownMarkLike[] = unplaced.map((o) => ({ code: o.opening_code }));
  const result = await aiExtractPlacement(
    pageImages.map((p) => ({ pageNumber: p.pageNumber, dataUrl: p.dataUrl })),
    marks,
  );

  const { suggestions, notFoundMarks } = resolvePlacements(
    unplaced.map((o) => ({ id: o.id, code: o.opening_code })),
    result.placements,
  );

  return {
    suggestions,
    notFoundMarks,
    unknownCallouts: result.unknownMarks,
    failedPages: result.failedPages,
    floorPlanPages,
    limited: result.limited,
    note: result.note,
  };
}
