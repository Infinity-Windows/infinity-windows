// Deterministic window-schedule extraction from planset text, with an optional
// AI fallback (`ExtractStrategy`) when `parseScheduleRows` finds nothing.
// The rest of the pipeline (match, expand, draft save with confirm guardrails)
// is shared — confirmed openings are never overwritten.

export interface ScheduleRow {
  /** Opening mark on the plans, e.g. W1, A-101 */
  openingCode: string;
  /** Raw type text from the schedule, e.g. CAS3050 or "CASEMENT 3050" */
  typeText: string;
  qty: number;
  /** Location/remarks text, e.g. "LIVING ROOM" */
  label: string | null;
  pageNumber: number;
}

export interface TypeCandidate {
  id: string;
  type_code: string;
  name: string;
}

export interface TypeMatch {
  type: TypeCandidate | null;
  score: number;
}

export interface DraftOpening {
  opening_code: string;
  window_type_id: string | null;
  type_text: string;
  match_score: number;
  label: string | null;
  page_number: number;
}

/** AI fallback implements this; deterministic parser is the default. */
export type ExtractStrategy = (
  pages: { pageNumber: number; text: string }[],
) => ScheduleRow[] | Promise<ScheduleRow[]>;

export const deterministicExtract: ExtractStrategy = (pages) =>
  pages.flatMap((p) => parseScheduleRows(p.text, p.pageNumber));

/**
 * Run deterministic extract first; if empty and an AI fallback is provided,
 * use that. Same draft/confirm guardrails apply downstream either way.
 */
export async function extractScheduleRows(
  pages: { pageNumber: number; text: string }[],
  aiFallback?: ExtractStrategy | null,
): Promise<{ rows: ScheduleRow[]; source: "deterministic" | "ai" | "none" }> {
  const deterministic = await deterministicExtract(pages);
  if (deterministic.length > 0) {
    return { rows: deterministic, source: "deterministic" };
  }
  if (aiFallback) {
    const aiRows = await aiFallback(pages);
    if (aiRows.length > 0) return { rows: aiRows, source: "ai" };
  }
  return { rows: [], source: "none" };
}
// Opening marks: W1, W-12, W12A, A-101, 101, 101A, WIN-3 ...
const MARK_RE = /^(?:[A-Z]{1,3}-?\d{1,4}[A-Z]?|\d{2,4}[A-Z]?)$/;
// Type-code-ish field: letters then digits, e.g. CAS3050, DH2846, SL-6040
const TYPE_RE = /^[A-Z]{2,6}-?\d{3,4}$/;
// Dimension fields like 3'-0" x 5'-0" or 36" X 60" — never a type or label.
const SIZE_RE = /\d\s*['"x×]/i;
const HEADER_WORDS = /\b(MARK|SYMBOL|QTY|QUANTITY|MANUF|SCHEDULE|REMARKS|R\.O\.|ROUGH)\b/i;

function splitFields(line: string): string[] {
  // Schedules come across as pipe/tab tables or column-aligned text.
  const byDelim = line.split(/\s*\|\s*|\t+|\s{2,}/).map((f) => f.trim());
  return byDelim.filter(Boolean);
}

export function parseScheduleRows(
  text: string,
  pageNumber = 1,
): ScheduleRow[] {
  const rows: ScheduleRow[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || HEADER_WORDS.test(line)) continue;

    let fields = splitFields(line);
    if (fields.length < 2) fields = line.split(/\s+/);
    if (fields.length < 2) continue;

    const mark = fields[0].toUpperCase();
    if (!MARK_RE.test(mark)) continue;

    let typeText: string | null = null;
    let qty = 1;
    let qtySeen = false;
    const labelParts: string[] = [];

    for (const field of fields.slice(1)) {
      const f = field.trim();
      if (!f || SIZE_RE.test(f)) continue;
      if (!qtySeen && /^\d{1,3}$/.test(f)) {
        qty = Number(f);
        qtySeen = true;
        continue;
      }
      if (!typeText && TYPE_RE.test(f.toUpperCase())) {
        typeText = f.toUpperCase();
        continue;
      }
      if (/[A-Za-z]/.test(f)) labelParts.push(f);
    }

    // Fall back to the field right after the mark (worded types like
    // "CASEMENT 3050" land in labelParts).
    if (!typeText && labelParts.length > 0) {
      typeText = labelParts.shift()!.toUpperCase();
    }
    if (!typeText) continue;

    rows.push({
      openingCode: mark,
      typeText,
      qty: qty >= 1 && qty <= 500 ? qty : 1,
      label: labelParts.length ? labelParts.join(" ") : null,
      pageNumber,
    });
  }
  return rows;
}

function normalize(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => i);
  for (let j = 1; j <= b.length; j++) {
    let prev = dp[0];
    dp[0] = j;
    for (let i = 1; i <= a.length; i++) {
      const tmp = dp[i];
      dp[i] = Math.min(
        dp[i] + 1,
        dp[i - 1] + 1,
        prev + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      prev = tmp;
    }
  }
  return dp[a.length];
}

function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) {
    return 0.8 + 0.2 * (Math.min(a.length, b.length) / Math.max(a.length, b.length));
  }
  const dist = editDistance(a, b);
  return 1 - dist / Math.max(a.length, b.length);
}

/**
 * Fuzzy-match raw schedule type text against the window_types catalog.
 * Returns null type below the confidence threshold — a human picks instead.
 */
export function matchWindowType(
  typeText: string,
  types: TypeCandidate[],
  threshold = 0.6,
): TypeMatch {
  const target = normalize(typeText);
  let best: TypeCandidate | null = null;
  let bestScore = 0;
  for (const t of types) {
    const score = Math.max(
      similarity(target, normalize(t.type_code)),
      similarity(target, normalize(t.name)) * 0.9,
    );
    if (score > bestScore) {
      best = t;
      bestScore = score;
    }
  }
  if (bestScore < threshold) return { type: null, score: bestScore };
  return { type: best, score: bestScore };
}

/**
 * Expand schedule rows (qty N) into individual draft openings and attach the
 * best type match. W1 x3 becomes W1-1, W1-2, W1-3.
 */
export function rowsToDraftOpenings(
  rows: ScheduleRow[],
  types: TypeCandidate[],
): DraftOpening[] {
  const drafts: DraftOpening[] = [];
  for (const row of rows) {
    const match = matchWindowType(row.typeText, types);
    const codes =
      row.qty === 1
        ? [row.openingCode]
        : Array.from({ length: row.qty }, (_, i) => `${row.openingCode}-${i + 1}`);
    for (const code of codes) {
      drafts.push({
        opening_code: code,
        window_type_id: match.type?.id ?? null,
        type_text: row.typeText,
        match_score: match.score,
        label: row.label,
        page_number: row.pageNumber,
      });
    }
  }
  return drafts;
}
