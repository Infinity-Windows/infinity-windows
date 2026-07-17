// Deterministic window-schedule extraction from planset text, with an optional
// AI fallback (`ExtractStrategy`) when `parseScheduleRows` finds nothing.
// Also extracts building-plan mark occurrences (#14) with map pin positions.

export interface ScheduleRow {
  /** Opening mark on the plans, e.g. W1, A-101, #14, 14 */
  openingCode: string;
  /** Raw type text from the schedule, e.g. CAS3050 or "CASEMENT 3050" */
  typeText: string;
  qty: number;
  /** Location/remarks text, e.g. "LIVING ROOM" */
  label: string | null;
  pageNumber: number;
  sizeText?: string | null;
  colorText?: string | null;
  unitKind?: "window" | "door";
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
  pin_x?: number | null;
  pin_y?: number | null;
}

export interface SpecMarkDraft {
  mark: string;
  type_text: string;
  size_text: string | null;
  color_text: string | null;
  unit_kind: "window" | "door";
  window_type_id: string | null;
  match_score: number;
}

export interface BuildingMarkHit {
  mark: string;
  pageNumber: number;
  /** Normalized 0–1, top-left origin (CSS / map space). */
  pin_x: number;
  pin_y: number;
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

/** Normalize mark tokens: "#14" / "14" / "W1" → canonical string without spaces. */
export function normalizeMark(raw: string): string {
  const t = raw.trim().toUpperCase().replace(/\s+/g, "");
  const hashNum = t.match(/^#?(\d{1,3}[A-Z]?)$/);
  if (hashNum) return hashNum[1];
  return t.replace(/^#/, "");
}

/** Display form for map chips. */
export function formatMarkLabel(mark: string): string {
  const n = normalizeMark(mark);
  return /^\d/.test(n) ? `#${n}` : n;
}

// Opening marks: #14, 14, W1, W-12, W12A, A-101, 101, 101A, WIN-3 ...
const MARK_RE = /^(?:#?\d{1,3}[A-Z]?|[A-Z]{1,3}-?\d{1,4}[A-Z]?|\d{2,4}[A-Z]?)$/;
// Type-code-ish field: letters then digits, e.g. CAS3050, DH2846, SL-6040
const TYPE_RE = /^[A-Z]{2,6}-?\d{3,4}$/;
// Dimension fields like 3'-0" x 5'-0" or 36" X 60" or 4x5 — never a type or label.
const SIZE_RE = /\d\s*['"x×]|^\d+\s*[x×]\s*\d+/i;
const COLOR_RE =
  /^(WHITE|BLACK|BRONZE|ALMOND|TAN|GRAY|GREY|BROWN|CLAD|VINYL|PAINTED)$/i;
const DOOR_RE = /\bDOOR|ENTRY|FRENCH|SLIDER\s*DOOR|HINGED\b/i;
const HEADER_WORDS =
  /\b(MARK|SYMBOL|QTY|QUANTITY|MANUF|SCHEDULE|REMARKS|R\.O\.|ROUGH|COLOR|FINISH|WIDTH|HEIGHT)\b/i;
const BUILDING_MARK_RE = /#\s*(\d{1,3}[A-Za-z]?)\b|^(?:W|D|WD)-?(\d{1,3}[A-Za-z]?)$/i;

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

    const markRaw = fields[0].toUpperCase();
    if (!MARK_RE.test(markRaw)) continue;
    const mark = normalizeMark(markRaw);

    let typeText: string | null = null;
    let qty = 1;
    let qtySeen = false;
    let sizeText: string | null = null;
    let colorText: string | null = null;
    const labelParts: string[] = [];

    for (const field of fields.slice(1)) {
      const f = field.trim();
      if (!f) continue;
      if (SIZE_RE.test(f)) {
        if (!sizeText) sizeText = f;
        continue;
      }
      if (COLOR_RE.test(f)) {
        colorText = f.toUpperCase();
        continue;
      }
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
    // Specs sheets sometimes only have mark + size + color — use size as type text.
    if (!typeText && sizeText) {
      typeText = sizeText.toUpperCase();
    }
    if (!typeText) continue;

    const blob = `${typeText} ${labelParts.join(" ")}`;
    const unitKind: "window" | "door" = DOOR_RE.test(blob) ? "door" : "window";

    rows.push({
      openingCode: mark,
      typeText,
      qty: qty >= 1 && qty <= 500 ? qty : 1,
      label: labelParts.length ? labelParts.join(" ") : null,
      pageNumber,
      sizeText,
      colorText,
      unitKind,
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
    return (
      0.8 + 0.2 * (Math.min(a.length, b.length) / Math.max(a.length, b.length))
    );
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

/** Specs rows → one mark definition each (qty is informational, not openings). */
export function rowsToSpecMarks(
  rows: ScheduleRow[],
  types: TypeCandidate[],
): SpecMarkDraft[] {
  const byMark = new Map<string, SpecMarkDraft>();
  for (const row of rows) {
    const mark = normalizeMark(row.openingCode);
    const match = matchWindowType(row.typeText, types);
    byMark.set(mark, {
      mark,
      type_text: row.typeText,
      size_text: row.sizeText ?? null,
      color_text: row.colorText ?? null,
      unit_kind: row.unitKind ?? "window",
      window_type_id: match.type?.id ?? null,
      match_score: match.score,
    });
  }
  return [...byMark.values()];
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
    const mark = normalizeMark(row.openingCode);
    const codes =
      row.qty === 1
        ? [formatMarkLabel(mark)]
        : Array.from(
            { length: row.qty },
            (_, i) => `${formatMarkLabel(mark)}-${i + 1}`,
          );
    for (const code of codes) {
      drafts.push({
        opening_code: code,
        window_type_id: match.type?.id ?? null,
        type_text: row.typeText,
        match_score: match.score,
        label: row.label ?? formatMarkLabel(mark),
        page_number: row.pageNumber,
      });
    }
  }
  return drafts;
}

export interface PageFragments {
  pageNumber: number;
  width: number;
  height: number;
  fragments: { text: string; x: number; y: number; width: number; height: number }[];
}

/**
 * Find #14 / W12 style marks on a building floor plan and return pin positions
 * in top-left normalized coordinates for the project map.
 */
export function extractBuildingMarks(pages: PageFragments[]): BuildingMarkHit[] {
  const hits: BuildingMarkHit[] = [];

  for (const page of pages) {
    const pageHits: BuildingMarkHit[] = [];
    for (const f of page.fragments) {
      const text = f.text.trim();
      if (!text) continue;

      // Prefer explicit #14 tokens; also W12 / D3 style tags common on plans.
      const matches = text.matchAll(/#\s*(\d{1,3}[A-Za-z]?)\b/gi);
      let found = false;
      for (const m of matches) {
        found = true;
        pushHit(pageHits, page, normalizeMark(m[1]), f);
      }
      if (found) continue;

      const lone = text.match(BUILDING_MARK_RE);
      if (lone) {
        const mark = normalizeMark(lone[1] || lone[2] || text);
        if (mark) pushHit(pageHits, page, mark, f);
      }
    }

    // Dedupe near-duplicate labels (same mark within ~2% of page).
    hits.push(...clusterHits(pageHits));
  }

  return hits;
}

function pushHit(
  into: BuildingMarkHit[],
  page: PageFragments,
  mark: string,
  f: { x: number; y: number; width: number; height: number },
) {
  if (!mark) return;
  // PDF origin is bottom-left; map uses top-left.
  const cx = (f.x + f.width / 2) / page.width;
  const cy = 1 - (f.y + f.height / 2) / page.height;
  into.push({
    mark,
    pageNumber: page.pageNumber,
    pin_x: clamp01(cx),
    pin_y: clamp01(cy),
  });
}

function clusterHits(hits: BuildingMarkHit[], radius = 0.035): BuildingMarkHit[] {
  const out: BuildingMarkHit[] = [];
  for (const h of hits) {
    const near = out.find(
      (o) =>
        o.mark === h.mark &&
        o.pageNumber === h.pageNumber &&
        Math.hypot(o.pin_x - h.pin_x, o.pin_y - h.pin_y) < radius,
    );
    if (!near) out.push(h);
  }
  return out;
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0.5;
  return Math.min(1, Math.max(0, n));
}

/** Building mark hits → draft openings `#14-1`, `#14-2`, … with pins. */
export function buildingMarksToDraftOpenings(
  hits: BuildingMarkHit[],
  marks: SpecMarkDraft[],
): DraftOpening[] {
  const byMark = new Map(marks.map((m) => [m.mark, m]));
  const counters = new Map<string, number>();
  const drafts: DraftOpening[] = [];

  for (const hit of hits) {
    const mark = normalizeMark(hit.mark);
    const n = (counters.get(mark) ?? 0) + 1;
    counters.set(mark, n);
    const spec = byMark.get(mark);
    const display = formatMarkLabel(mark);
    drafts.push({
      opening_code: `${display}-${n}`,
      window_type_id: spec?.window_type_id ?? null,
      type_text: spec?.type_text ?? display,
      match_score: spec?.match_score ?? 0,
      label: display,
      page_number: hit.pageNumber,
      pin_x: hit.pin_x,
      pin_y: hit.pin_y,
    });
  }
  return drafts;
}
