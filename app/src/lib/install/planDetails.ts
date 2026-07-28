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
 * Pages that are actual floor drawings, preferring sheets that already have
 * opening numbers around the building (the “numbered” plan).
 */
export function findFloorPlanPages(pages: PdfTextPage[]): number[] {
  const scored = pages.map((page) => {
    const titleHit = /SHEET\s+TITLE\s*:\s*[\s\S]{0,80}\bFLOOR\s+PLAN\b/i.test(
      page.text,
    )
      ? 40
      : 0;
    const floorHits = (page.text.match(/\bFLOOR\s+PLAN\b/gi) ?? []).length;
    const floorScore = floorHits >= 2 ? 25 : floorHits === 1 ? 10 : 0;
    const markScore = Math.min(40, countPlanMarkCallouts(page.text) * 4);
    const levelHit = /\b(LEVEL|FIRST|SECOND|THIRD)\s+FLOOR\b/i.test(page.text)
      ? 8
      : 0;
    return {
      pageNumber: page.pageNumber,
      score: titleHit + floorScore + markScore + levelHit,
      marks: countPlanMarkCallouts(page.text),
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

/**
 * Pull a compact, source-faithful index from manufacturer CAD detail sheets.
 * It intentionally does not infer geometry or invent marks absent from the PDF.
 */
export function extractCadDetailPages(pages: PdfTextPage[]): CadDetailPage[] {
  return pages
    .map((page) => ({
      pageNumber: page.pageNumber,
      marks: detailMarks(page.text),
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
 * When both sources list the same mark, keep the larger quantity (detail
 * sheets often carry the true building count).
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
    if (row.qty > existing.qty) {
      byMark.set(key, { ...existing, qty: row.qty });
    }
  }
  return [...byMark.values()].sort((a, b) =>
    a.openingCode.localeCompare(b.openingCode, undefined, { numeric: true }),
  );
}
