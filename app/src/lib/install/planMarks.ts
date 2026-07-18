/** One physical opening callout as placed on a marked building plan. */
export interface PlanMarkCallout {
  mark: string;
  pageNumber: number;
  /** Normalized 0–1 pin on the PDF page. */
  x: number;
  y: number;
}

const MARK_TOKEN_RE = /^#?([A-Z]{0,3}-?\d{1,4}[A-Z]?)$/i;

/**
 * Parse FreeText annotation bodies that are plan mark callouts.
 * "6  6  6" → ["6","6","6"]; "13A 13B" → ["13A","13B"].
 * Notes like "#18A 1 of 2 not used" return null so they are not counted.
 */
export function parsePlanMarkAnnotation(text: string): string[] | null {
  const cleaned = text.replace(/^\uFEFF/, "").trim();
  if (!cleaned) return null;
  if (/not\s*used|unused|n\/a|see\s+sheet|do\s+not/i.test(cleaned)) {
    return null;
  }

  const parts = cleaned.split(/[\s,;/|]+/).filter(Boolean);
  if (parts.length === 0) return null;

  const marks: string[] = [];
  for (const part of parts) {
    const match = part.match(MARK_TOKEN_RE);
    if (!match) return null;
    marks.push(match[1].toUpperCase());
  }
  return marks;
}

/** Count callouts per mark (e.g. #6 → 12). */
export function countCalloutsByMark(
  callouts: PlanMarkCallout[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const callout of callouts) {
    counts.set(callout.mark, (counts.get(callout.mark) ?? 0) + 1);
  }
  return counts;
}
