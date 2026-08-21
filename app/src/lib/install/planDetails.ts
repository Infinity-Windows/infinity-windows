import type { ScheduleRow } from "./extract";

export interface PdfTextPage {
  pageNumber: number;
  text: string;
}

export interface CadDetailPage {
  pageNumber: number;
  marks: string[];
  productCodes: string[];
  notes: string[];
}

/** Opening mark callouts as they appear on floor drawings and detail sheets. */
const MARK_CALLOUT_RE = /#\s*([A-Z]{0,3}-?\d{1,4}[A-Z]?)\b/gi;
/** Any run of letters long enough to be an English word rather than a suffix. */
const PROSE_WORD_RE = /[A-Za-z]{2,}/;
const DOOR_HINT =
  /\b(DOOR|DOORS|SLIDING\s+DOOR|ENTRY|FRENCH\s+DOOR|PATIO)\b/i;
const WINDOW_HINT =
  /\b(WINDOW|WINDOWS|CASEMENT|FIXED|FROSTED|AWNING|PICTURE)\b/i;

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

/** The whole line of `text` that contains `index`. */
function lineAround(text: string, index: number): string {
  const start = text.lastIndexOf("\n", index - 1) + 1;
  const end = text.indexOf("\n", index);
  return text.slice(start, end === -1 ? text.length : end);
}

/**
 * Is the `#…` at `index` a real opening mark, or just prose that happens to
 * contain a hash?
 *
 * Black Desert's spec sheet says "Obscure Glass #3" and "#17 Glass Obscure" —
 * glass notes, not marks. Reading those as marks manufactured two phantom
 * openings on a job that has none. Two shapes are genuine, and both were
 * measured against the real Smith and Black Desert PDFs:
 *
 *  1. Hyphen-attached to a job code — "PV Townhomes Bldg 14-#4A". All six of
 *     Smith's real text marks take this form.
 *  2. A bare callout line that is nothing BUT marks — "#4A #4B #13A" or a lone
 *     "#13B". Strip the marks out and only punctuation is left.
 *
 * Anything with an English word loose on the line is prose and ignored. That
 * single test drops all eight of Black Desert's false positives while keeping
 * every genuine Smith mark.
 */
export function isMarkCallout(text: string, index: number): boolean {
  if (text[index - 1] === "-") return true;
  const line = lineAround(text, index);
  const withoutMarks = line.replace(MARK_CALLOUT_RE, " ");
  return !PROSE_WORD_RE.test(withoutMarks);
}

/** Mark-callout matches in `text`, with prose hashes filtered out. */
export function markCalloutMatches(text: string): RegExpMatchArray[] {
  return [...text.matchAll(MARK_CALLOUT_RE)].filter((match) =>
    isMarkCallout(text, match.index ?? 0),
  );
}

/** Count #mark-style callouts — used to prefer the numbered floor sheet. */
export function countPlanMarkCallouts(text: string): number {
  return markCalloutMatches(text).length;
}

/**
 * Phrases that only ever appear in the title block, legend, or general notes of
 * an elevation or section sheet — never on a floor plan.
 *
 * Measured against Black Desert's real plan set: page 1 is A.102 MAIN LvL FLOOR
 * PLAN, and pages 2–4 are A.201/A.202/A.203 EXTERIOR ELEVATIONS. Each elevation
 * sheet scores 110+ on these; the floor plan scores 0 even though its keyed
 * notes say "VERIFY W/ THE EXTERIOR ELEVATION FOR THE SILL HEIGHT". That is why
 * the test is a set of whole phrases and not the word "elevation".
 */
const ELEVATION_SHEET_PHRASES: { re: RegExp; weight: number }[] = [
  { re: /ELEVATION\s+MATERIAL\s+LEGEND/i, weight: 40 },
  { re: /EXTERIOR\s+ELEVATION\s+GENERAL\s+NOTES/i, weight: 40 },
  { re: /ELEVATION\s+(?:HEIGHT|KEYNOTE|KEYED)\s+NOTES/i, weight: 30 },
  { re: /\bBUILDING\s+SECTIONS?\b/i, weight: 40 },
  { re: /\bOVERALL\s+HEIGHT\b/i, weight: 10 },
];

const COMPASS_OR_FACE = "FRONT|REAR|LEFT|RIGHT|SIDE|NORTH|SOUTH|EAST|WEST|COURTYARD|PROPERTY";
/**
 * A drawing title naming a face of the building — "FRONT ELEVATION - SOUTH",
 * "REAR PROPERTY ELEVATION". Every word before ELEVATION must itself be a face
 * word, so the floor plan's "VERIFY W/ THE EXTERIOR ELEVATION" and its
 * "FOUNDATION ELEVATION ARE RELATIVE TO…" note do not match.
 */
const ELEVATION_VIEW_TITLE_RE = new RegExp(
  `\\b(?:${COMPASS_OR_FACE})(?:\\s+(?:${COMPASS_OR_FACE}))*\\s+ELEVATION\\b`,
  "gi",
);

/** A floor drawing always names itself, in the title block and the keyed notes. */
const FLOOR_PLAN_RE = /\bFLOOR\s+PLAN\b/i;

/**
 * Is this page an elevation or section sheet rather than a floor drawing?
 *
 * It matters for counting. An elevation draws the SAME windows the floor plan
 * already numbers, seen from outside, and the draughtsman numbers them again on
 * every view they appear in. Black Desert's four-page set numbers 42 openings on
 * its one floor plan and then re-numbers 57 of them across three elevation
 * sheets — two of which draw the same façade twice. Counting every callout gave
 * 99 openings for a 42-opening house.
 *
 * Deliberately one-sided: a page is only rejected on positive evidence that it
 * is an elevation AND the absence of any floor-plan evidence. Smith's plan set
 * has no extractable text at all, so it is never rejected.
 */
export function isElevationSheet(text: string): boolean {
  if (FLOOR_PLAN_RE.test(text)) return false;
  let score = 0;
  for (const { re, weight } of ELEVATION_SHEET_PHRASES) {
    if (re.test(text)) score += weight;
  }
  const titles = new Set(
    [...text.matchAll(ELEVATION_VIEW_TITLE_RE)].map((m) =>
      m[0].replace(/\s+/g, " ").toUpperCase(),
    ),
  );
  score += Math.min(40, titles.size * 20);
  return score >= 40;
}

/** The two sides of one decision: what counts, and what is only drawn again. */
export interface CalloutSplit<T> {
  /** Callouts on floor drawings — these, and only these, become openings. */
  planCallouts: T[];
  /** The same windows re-numbered on elevation views. Reference material only. */
  repeatViewCallouts: T[];
}

/**
 * Split callouts into the ones that decide the opening count and the ones that
 * are the same windows drawn again on an elevation view.
 *
 * ONE decision, two outputs, deliberately: the elevation reference is built from
 * `repeatViewCallouts` and the openings from `planCallouts`, so no callout can
 * ever be both, and their union is always every callout that came in.
 *
 * `planCallouts` is never empty: if every page reads as an elevation the set is
 * kept whole (and nothing is treated as a repeat), because losing the job's
 * openings is far worse than counting one twice.
 */
export function splitCalloutsByFloorPlan<T extends { pageNumber: number }>(
  callouts: T[],
  pages: PdfTextPage[],
): CalloutSplit<T> {
  const elevationPages = new Set(
    pages.filter((page) => isElevationSheet(page.text)).map((p) => p.pageNumber),
  );
  if (elevationPages.size === 0) {
    return { planCallouts: callouts, repeatViewCallouts: [] };
  }
  const planCallouts = callouts.filter((c) => !elevationPages.has(c.pageNumber));
  if (planCallouts.length === 0) {
    return { planCallouts: callouts, repeatViewCallouts: [] };
  }
  return {
    planCallouts,
    repeatViewCallouts: callouts.filter((c) =>
      elevationPages.has(c.pageNumber),
    ),
  };
}

/**
 * Drop the callouts that sit on elevation or section sheets, so one physical
 * window becomes one opening however many views it is drawn in.
 */
export function calloutsOnFloorPlanSheets<T extends { pageNumber: number }>(
  callouts: T[],
  pages: PdfTextPage[],
): T[] {
  return splitCalloutsByFloorPlan(callouts, pages).planCallouts;
}

/**
 * Pages that are actual floor drawings, preferring sheets that already have
 * opening numbers around the building (the “numbered” plan).
 *
 * `callouts` are the marks read from PDF annotations (see
 * `extractPlanMarkCallouts`). They matter because a marked-up plan usually
 * carries its numbers as FreeText annotations, not page text — `getTextContent`
 * never sees them. Scoring on text alone made Black Desert, whose 96 callouts
 * are all annotations, look like it had a single numbered drawing when all four
 * of its pages are marked. Marked elevation sheets are excluded outright: they
 * are covered in numbers but they are not floor drawings.
 */
export function findFloorPlanPages(
  pages: PdfTextPage[],
  callouts: { pageNumber: number }[] = [],
): number[] {
  const annotationMarks = new Map<number, number>();
  for (const callout of callouts) {
    annotationMarks.set(
      callout.pageNumber,
      (annotationMarks.get(callout.pageNumber) ?? 0) + 1,
    );
  }

  const scored = pages
    .filter((page) => !isElevationSheet(page.text))
    .map((page) => {
      const titleHit = /SHEET\s+TITLE\s*:\s*[\s\S]{0,80}\bFLOOR\s+PLAN\b/i.test(
        page.text,
      )
        ? 40
        : 0;
      const floorHits = (page.text.match(/\bFLOOR\s+PLAN\b/gi) ?? []).length;
      const floorScore = floorHits >= 2 ? 25 : floorHits === 1 ? 10 : 0;
      const marks =
        countPlanMarkCallouts(page.text) +
        (annotationMarks.get(page.pageNumber) ?? 0);
      const markScore = Math.min(40, marks * 4);
      const levelHit = /\b(LEVEL|FIRST|SECOND|THIRD)\s+FLOOR\b/i.test(page.text)
        ? 8
        : 0;
      return {
        pageNumber: page.pageNumber,
        score: titleHit + floorScore + markScore + levelHit,
        marks,
      };
    });

  const candidates = scored
    .filter((page) => page.score >= 15)
    .sort((a, b) => b.score - a.score || a.pageNumber - b.pageNumber);

  if (candidates.length > 0) {
    return unique(candidates.map((page) => page.pageNumber));
  }

  // Fallback: any page with several mark callouts, even without a FLOOR PLAN title.
  const byMarks = scored
    .filter((page) => page.marks >= 3)
    .sort((a, b) => b.marks - a.marks || a.pageNumber - b.pageNumber);
  return unique(byMarks.map((page) => page.pageNumber));
}

/**
 * Which sheets a drawing view should let you page through: the ones detected as
 * floor plans, plus every sheet that actually carries a mark.
 *
 * Oakridge's marks live on page 1 while its detected floor sheets are 3 and 4,
 * so the outline view drew an empty building and offered no way to reach the
 * marks at all. Detection being wrong is a separate problem; a view that hides
 * the job's own marks is a dead end either way.
 */
export function mergePageLists(
  detected: number[],
  pagesWithMarks: number[],
  pageCount: number,
): number[] {
  const merged = unique([...detected, ...pagesWithMarks]).sort((a, b) => a - b);
  if (merged.length > 0) return merged;
  return Array.from({ length: Math.max(0, pageCount) }, (_, i) => i + 1);
}

function detailMarks(text: string): string[] {
  return unique(markCalloutMatches(text).map((match) => match[1].toUpperCase()));
}

function productCodes(text: string): string[] {
  const codes: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim().toUpperCase();
    const direct = trimmed.match(/^(\d{4})(?:\s+(XO|OX|FX|SC|FROSTED|FIXED))?$/);
    if (direct) {
      codes.push(`${direct[1]}${direct[2] ? ` ${direct[2]}` : ""}`);
      continue;
    }
    for (const match of trimmed.matchAll(
      /\b(\d{4})\s+(XO|OX|FX|SC|FROSTED|FIXED)\b/g,
    )) {
      codes.push(`${match[1]} ${match[2]}`);
    }
    for (const match of trimmed.matchAll(/\bFIXED\s+(\d{4})\b/g)) {
      codes.push(`${match[1]} FIXED`);
    }
  }
  return unique(codes);
}

function detailNotes(text: string): string[] {
  const notes: string[] = [];
  if (/EGRESS\s+HINGES/i.test(text)) notes.push("Egress hinges");
  if (/FROSTED\s+GLASS/i.test(text)) notes.push("Frosted glass");
  if (/LOCK\s+INTERIOR[\s\S]{0,80}KEY\s+EXTERIOR/i.test(text)) {
    notes.push("Interior lock with keyed exterior");
  }
  if (/STRAIGHT\s+HANDLE\s*\(BLACK\)/i.test(text)) {
    notes.push("Black straight handles");
  }
  if (/SLIDING\s+DOOR\s+TRACK/i.test(text)) notes.push("Sliding door track detail");
  return notes;
}

/** A spec we already read off a page — the page's own proof it holds a window. */
export interface ExtractedSpecPage {
  mark_code: string;
  image_page: number | null;
}

/**
 * Pull a compact, source-faithful index from manufacturer CAD detail sheets.
 * It intentionally does not infer geometry or invent marks absent from the PDF.
 *
 * `extractedSpecs` are the specs already read off this planset
 * (`project_mark_specs.image_page` says which page each mark came from). They
 * are the strongest evidence a page carries window or door information, and
 * they work for any supplier: the text rules below only recognise the `#mark`
 * habit and five phrases from Smith's sheets, so Black Desert showed 3 of its 14
 * spec pages even though 37 specs had been read off 11 of them.
 */
export function extractCadDetailPages(
  pages: PdfTextPage[],
  extractedSpecs: ExtractedSpecPage[] = [],
): CadDetailPage[] {
  const specMarksByPage = new Map<number, string[]>();
  for (const spec of extractedSpecs) {
    if (spec.image_page == null) continue;
    const marks = specMarksByPage.get(spec.image_page) ?? [];
    marks.push(spec.mark_code.toUpperCase().replace(/^#/, ""));
    specMarksByPage.set(spec.image_page, marks);
  }

  return pages
    .map((page) => ({
      pageNumber: page.pageNumber,
      marks: unique([
        ...detailMarks(page.text),
        ...(specMarksByPage.get(page.pageNumber) ?? []),
      ]).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
      productCodes: productCodes(page.text),
      notes: detailNotes(page.text),
    }))
    .filter(
      (page) =>
        page.marks.length > 0 ||
        page.productCodes.length > 0 ||
        page.notes.length > 0,
    );
}

function firstProductCode(text: string): string | null {
  const codes = productCodes(text);
  return codes[0] ?? null;
}

function inferKind(slice: string, product: string | null): "window" | "door" {
  if (DOOR_HINT.test(slice) || /SLIDING\s+DOOR/i.test(slice)) return "door";
  // Prefer product geometry before loose "FIXED" words that often appear on
  // the same sheet as patio doors.
  if (product) {
    const upper = product.toUpperCase();
    if (/\b\d{2}(70|80)\b/.test(upper) && /\b(XO|OX|SC)\b/.test(upper)) {
      return "door";
    }
    if (/\b(FROSTED|FIXED|FX)\b/.test(upper)) return "window";
    // Detail tables often say "Fixed Window" next to a bare size like 3070.
    if (WINDOW_HINT.test(slice)) return "window";
    // Bare size codes: xx80 / xx70 are typically doors; shorter units windows.
    if (/^\d{2}(70|80)\b/.test(upper)) return "door";
    if (/^\d{4}\b/.test(upper)) return "window";
  }
  if (WINDOW_HINT.test(slice)) return "window";
  return "window";
}

function parseSizeFromProduct(
  product: string | null,
): { widthIn: number; heightIn: number } | null {
  if (!product) return null;
  // Quaker-style 6080 = 6'0" × 8'0" (digit pairs are feet/inches).
  const m = product.match(/^(\d)(\d)(\d)(\d)\b/);
  if (!m) return null;
  return {
    widthIn: Number(m[1]) * 12 + Number(m[2]),
    heightIn: Number(m[3]) * 12 + Number(m[4]),
  };
}

/**
 * Manufacturer detail sheets list how many times a mark appears on the
 * building (e.g. "NO: …-#6" with "QTY: 12" → twelve #6 openings).
 */
export function parseDetailQty(slice: string): number {
  const labeled = slice.match(
    /\b(?:QTY|QUANTITY)\b\s*[:=]?\s*(\d{1,3})\b/i,
  );
  if (labeled) {
    const n = Number(labeled[1]);
    if (n >= 1 && n <= 500) return n;
  }
  // PDF text sometimes puts the count on the next line after QTY.
  const split = slice.match(/\b(?:QTY|QUANTITY)\b\s*[:=]?\s*[\r\n]+\s*(\d{1,3})\b/i);
  if (split) {
    const n = Number(split[1]);
    if (n >= 1 && n <= 500) return n;
  }
  return 1;
}

/**
 * Turn manufacturer detail sheets into schedule-like rows — one per #mark,
 * with quantity from the detail table (QTY) so #6 ×12 becomes twelve openings.
 * Example page text:
 *   PV Townhomes Bldg 14-#4A
 *   6080 XO
 *   PV Townhomes Bldg 14-#6
 *   QTY: 12
 *   3070
 */
export function parseCadDetailScheduleRows(
  pages: PdfTextPage[],
): ScheduleRow[] {
  const byMark = new Map<string, ScheduleRow>();

  for (const page of pages) {
    const matches = markCalloutMatches(page.text);
    if (matches.length === 0) continue;

    for (let i = 0; i < matches.length; i++) {
      const match = matches[i];
      const mark = match[1].toUpperCase();

      const start = (match.index ?? 0) + match[0].length;
      const end =
        i + 1 < matches.length
          ? (matches[i + 1].index ?? page.text.length)
          : page.text.length;
      const slice = page.text.slice(start, end);
      const qty = parseDetailQty(slice);
      const existing = byMark.get(mark);
      if (existing) {
        // Later slices may carry the QTY table; keep the highest count.
        if (qty > existing.qty) existing.qty = qty;
        if (
          existing.typeText === mark &&
          firstProductCode(slice)
        ) {
          const product = firstProductCode(slice)!;
          const size = parseSizeFromProduct(product);
          existing.typeText = product;
          existing.widthIn = size?.widthIn ?? existing.widthIn;
          existing.heightIn = size?.heightIn ?? existing.heightIn;
          existing.kind = inferKind(slice, product);
        }
        continue;
      }

      const product = firstProductCode(slice);
      const size = parseSizeFromProduct(product);
      const kind = inferKind(slice, product);

      byMark.set(mark, {
        openingCode: mark,
        typeText: product ?? mark,
        qty,
        label: null,
        pageNumber: page.pageNumber,
        widthIn: size?.widthIn ?? null,
        heightIn: size?.heightIn ?? null,
        color: null,
        kind,
      });
    }
  }

  return [...byMark.values()];
}

/**
 * Prefer schedule-table rows; fill any missing marks from CAD detail sheets
 * so manufacturer PDFs without a formal schedule still populate openings.
 * Weak numeric schedule hits (bare "2"/"3" with no product code) are dropped
 * when real detail-sheet marks exist — they are almost always sheet noise.
 * When both sources list the same mark, the SCHEDULE row's quantity stands
 * (the RAC-OAK-5 / ESH-18 lesson: an explicit QTY field is authoritative;
 * "how often a number appears on other pages" is noise, and letting the
 * larger number win re-imported exactly that noise). Detail rows only ADD
 * marks the schedule doesn't list.
 */
export function mergeScheduleWithDetailRows(
  scheduleRows: ScheduleRow[],
  detailRows: ScheduleRow[],
): ScheduleRow[] {
  const hasDetailMarks = detailRows.length > 0;
  const byMark = new Map<string, ScheduleRow>();
  for (const row of scheduleRows) {
    const key = row.openingCode.toUpperCase().replace(/^#/, "");
    const weakNumeric =
      /^\d{1,2}$/.test(key) && !/^[A-Z]{2,6}-?\d{3,4}$/i.test(row.typeText);
    if (hasDetailMarks && weakNumeric) continue;
    byMark.set(key, row);
  }
  for (const row of detailRows) {
    const key = row.openingCode.toUpperCase().replace(/^#/, "");
    const existing = byMark.get(key);
    if (!existing) {
      byMark.set(key, row);
      continue;
    }
    // Schedule QTY stands — see the header comment.
  }
  return [...byMark.values()].sort((a, b) =>
    a.openingCode.localeCompare(b.openingCode, undefined, { numeric: true }),
  );
}
