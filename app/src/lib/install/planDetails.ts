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

/** Pages that are actual floor drawings, excluding the cover-sheet index. */
export function findFloorPlanPages(pages: PdfTextPage[]): number[] {
  const titleMatches = pages
    .filter((page) => /SHEET\s+TITLE\s*:\s*[\s\S]{0,80}\bFLOOR\s+PLAN\b/i.test(page.text))
    .map((page) => page.pageNumber);
  const repeatedMatches = pages
    .filter((page) => (page.text.match(/\bFLOOR\s+PLAN\b/gi) ?? []).length >= 2)
    .map((page) => page.pageNumber);
  return unique([...titleMatches, ...repeatedMatches]).sort((a, b) => a - b);
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function detailMarks(text: string): string[] {
  return unique(
    [...text.matchAll(/#\s*([A-Z0-9]+)\b/gi)].map((match) =>
      match[1].toUpperCase(),
    ),
  );
}

function productCodes(text: string): string[] {
  const codes: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim().toUpperCase();
    const direct = trimmed.match(/^(\d{4})(?:\s+(XO|OX|FX|SC|FROSTED))?$/);
    if (direct) {
      codes.push(`${direct[1]}${direct[2] ? ` ${direct[2]}` : ""}`);
      continue;
    }
    for (const match of trimmed.matchAll(/\b(\d{4})\s+(XO|OX|FX|SC|FROSTED)\b/g)) {
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
