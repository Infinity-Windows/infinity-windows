// Deterministic window/door-schedule extraction from planset text, with an
// optional AI fallback (`ExtractStrategy`) when `parseScheduleRows` finds
// nothing. Specs plansets define what a mark (#14) *is*; qty expands into
// individual openings for install tracking (14-1, 14-2, …).

import {
  mergeScheduleWithDetailRows,
  parseCadDetailScheduleRows,
} from "./planDetails";

export interface ScheduleRow {
  /** Opening mark on the plans, e.g. W1, A-101, #14, 14 */
  openingCode: string;
  /** Raw type/product text from the schedule, e.g. CAS3050 or "CASEMENT" */
  typeText: string;
  qty: number;
  /** Location/remarks text, e.g. "LIVING ROOM" */
  label: string | null;
  pageNumber: number;
  /** Rough opening / unit size in inches when the schedule lists dimensions. */
  widthIn: number | null;
  heightIn: number | null;
  /** Color / finish when present (e.g. WHITE, BRONZE). */
  color: string | null;
  /** Window vs door — from schedule header keywords or row text. */
  kind: "window" | "door";
}

export interface TypeCandidate {
  id: string;
  type_code: string;
  name: string;
  category?: string | null;
  width_in?: number | null;
  height_in?: number | null;
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
  /** Base mark without instance suffix — #14 for openings 14-1, 14-2. */
  mark_code: string;
  width_in: number | null;
  height_in: number | null;
  color: string | null;
  kind: "window" | "door";
  /** Normalized pin on the building plan when taken from a plan callout. */
  pin_x?: number | null;
  pin_y?: number | null;
}

/** AI fallback implements this; deterministic parser is the default. */
export type ExtractStrategy = (
  pages: { pageNumber: number; text: string }[],
) => ScheduleRow[] | Promise<ScheduleRow[]>;

export const deterministicExtract: ExtractStrategy = (pages) =>
  pages.flatMap((p) => parseScheduleRows(p.text, p.pageNumber));

/**
 * Run deterministic schedule extract, then fill missing marks from
 * manufacturer CAD detail sheets (#4A / #4B style). AI only runs when both
 * paths find nothing. Same draft/confirm guardrails apply downstream.
 */
export async function extractScheduleRows(
  pages: { pageNumber: number; text: string }[],
  aiFallback?: ExtractStrategy | null,
): Promise<{
  rows: ScheduleRow[];
  source: "deterministic" | "ai" | "details" | "merged" | "none";
}> {
  const deterministic = await deterministicExtract(pages);
  const detailRows = parseCadDetailScheduleRows(pages);
  const merged = mergeScheduleWithDetailRows(deterministic, detailRows);

  if (merged.length > 0) {
    if (deterministic.length > 0 && detailRows.length > 0) {
      return { rows: merged, source: "merged" };
    }
    if (deterministic.length > 0) {
      return { rows: merged, source: "deterministic" };
    }
    return { rows: merged, source: "details" };
  }

  if (aiFallback) {
    const aiRows = await aiFallback(pages);
    if (aiRows.length > 0) return { rows: aiRows, source: "ai" };
  }
  return { rows: [], source: "none" };
}

// Marks: #14, 14, W1, W-12, A-101, 101A …
const MARK_RE = /^#?(?:[A-Z]{1,3}-?\d{1,4}[A-Z]?|\d{1,4}[A-Z]?)$/;
// Type-code-ish field: letters then digits, e.g. CAS3050, DH2846, SL-6040
const TYPE_RE = /^[A-Z]{2,6}-?\d{3,4}$/;
// Dimension fields like 3'-0" x 5'-0", 36" X 60", 4x5, 48 x 60
const SIZE_RE =
  /(\d+(?:\.\d+)?)\s*(?:'|ft|’)?\s*(?:-\s*(\d+)\s*(?:"|in|”)?)?\s*[x×]\s*(\d+(?:\.\d+)?)\s*(?:'|ft|’)?\s*(?:-\s*(\d+)\s*(?:"|in|”)?)?/i;
const SIZE_IN_RE =
  /(\d+(?:\.\d+)?)\s*(?:"|in|”)?\s*[x×]\s*(\d+(?:\.\d+)?)\s*(?:"|in|”)?/i;
const HEADER_WORDS =
  /\b(MARK|SYMBOL|QTY|QUANTITY|MANUF|SCHEDULE|REMARKS|R\.O\.|ROUGH|WIDTH|HEIGHT|COLOR|FINISH)\b/i;
const DOOR_WORDS = /\b(DOOR|DOORS|ENTRY|SLIDING\s*DOOR|FRENCH\s*DOOR)\b/i;
const WINDOW_WORDS = /\b(WINDOW|WINDOWS|CASEMENT|DOUBLE[\s-]?HUNG|SLIDER|PICTURE)\b/i;
const COLOR_WORDS =
  /^(WHITE|BLACK|BRONZE|ALMOND|BEIGE|GRAY|GREY|CLAD|ANODIZED|CLEAR|PAINTED)$/i;

function splitFields(line: string): string[] {
  const byDelim = line.split(/\s*\|\s*|\t+|\s{2,}/).map((f) => f.trim());
  return byDelim.filter(Boolean);
}

function feetInchesToInches(
  feet: number,
  inches: number | undefined,
): number {
  return feet * 12 + (inches ?? 0);
}

/** Parse a size token into width/height inches. */
export function parseSizeInches(
  text: string,
): { widthIn: number; heightIn: number } | null {
  const m = text.match(SIZE_RE);
  if (m) {
    const wFeet = Number(m[1]);
    const wIn = m[2] !== undefined ? Number(m[2]) : undefined;
    const hFeet = Number(m[3]);
    const hIn = m[4] !== undefined ? Number(m[4]) : undefined;
    // Bare "4x5" without units → treat as feet (common on residential marks).
    const hasFeetMark = /['′’ft]/i.test(text);
    const hasInchMark = /["″in]/i.test(text);
    if (!hasFeetMark && !hasInchMark && wIn === undefined && hIn === undefined) {
      // Ambiguous 4x5 — prefer feet for building schedules (4'×5').
      return { widthIn: wFeet * 12, heightIn: hFeet * 12 };
    }
    if (hasInchMark && !hasFeetMark && wIn === undefined && hIn === undefined) {
      return { widthIn: wFeet, heightIn: hFeet };
    }
    return {
      widthIn: feetInchesToInches(wFeet, wIn),
      heightIn: feetInchesToInches(hFeet, hIn),
    };
  }
  const inch = text.match(SIZE_IN_RE);
  if (inch) {
    return { widthIn: Number(inch[1]), heightIn: Number(inch[2]) };
  }
  return null;
}

function normalizeMark(raw: string): string {
  return raw.trim().replace(/^#/, "").toUpperCase();
}

/** Base mark without instance suffix (14-1 → 14). */
export function markBase(code: string): string {
  const n = normalizeMark(code);
  return n.replace(/-\d+$/, "") || n;
}

function detectKind(
  line: string,
  pageContext: string,
  defaultKind: "window" | "door",
): "window" | "door" {
  if (DOOR_WORDS.test(line)) return "door";
  if (WINDOW_WORDS.test(line)) return "window";
  if (DOOR_WORDS.test(pageContext) && !WINDOW_WORDS.test(pageContext)) {
    return "door";
  }
  return defaultKind;
}

export function parseScheduleRows(
  text: string,
  pageNumber = 1,
): ScheduleRow[] {
  const rows: ScheduleRow[] = [];
  const pageContext = text.slice(0, 400);
  const defaultKind: "window" | "door" = DOOR_WORDS.test(pageContext)
    ? "door"
    : "window";

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || HEADER_WORDS.test(line)) continue;

    let fields = splitFields(line);
    if (fields.length < 2) fields = line.split(/\s+/);
    if (fields.length < 2) continue;

    const markUpper = fields[0].toUpperCase();
    if (!MARK_RE.test(markUpper)) continue;
    const mark = normalizeMark(markUpper);

    // Bare 4-digit product codes (6080 XO / 3060 FIXED) are manufacturer
    // catalog sizes, not schedule marks — skip those lines.
    const rest = fields.slice(1).map((f) => f.trim()).filter(Boolean);
    if (
      /^\d{4}$/.test(mark) &&
      (rest.length === 0 ||
        rest.every((f) => /^(XO|OX|FX|SC|FIXED|FROSTED)$/i.test(f)))
    ) {
      continue;
    }

    let typeText: string | null = null;
    let qty = 1;
    let qtySeen = false;
    let widthIn: number | null = null;
    let heightIn: number | null = null;
    let color: string | null = null;
    const labelParts: string[] = [];

    for (const field of fields.slice(1)) {
      const f = field.trim();
      if (!f) continue;

      const size = parseSizeInches(f);
      if (size) {
        widthIn = size.widthIn;
        heightIn = size.heightIn;
        continue;
      }
      // SIZE_RE-ish leftovers that aren't parseable as full size — skip.
      if (/\d\s*['"x×]/i.test(f) && /[x×]/i.test(f)) continue;

      if (!qtySeen && /^\d{1,3}$/.test(f)) {
        qty = Number(f);
        qtySeen = true;
        continue;
      }
      if (COLOR_WORDS.test(f)) {
        color = f.toUpperCase();
        continue;
      }
      if (!typeText && TYPE_RE.test(f.toUpperCase())) {
        typeText = f.toUpperCase();
        continue;
      }
      if (/[A-Za-z]/.test(f)) labelParts.push(f);
    }

    if (!typeText && labelParts.length > 0) {
      typeText = labelParts.shift()!.toUpperCase();
    }
    // Numeric-only marks (#14) often list product in type column; if still
    // empty, use the mark itself as the type key (specs define what #14 is).
    if (!typeText) typeText = mark;

    rows.push({
      openingCode: mark,
      typeText,
      qty: qty >= 1 && qty <= 500 ? qty : 1,
      label: labelParts.length ? labelParts.join(" ") : null,
      pageNumber,
      widthIn,
      heightIn,
      color,
      kind: detectKind(line, pageContext, defaultKind),
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
 * Also tries the mark itself (#14 → type_code 14). Returns null below the
 * confidence threshold — a human picks instead.
 */
export function matchWindowType(
  typeText: string,
  types: TypeCandidate[],
  threshold = 0.6,
  markCode?: string,
): TypeMatch {
  const target = normalize(typeText);
  const markNorm = markCode ? normalize(markCode) : "";
  let best: TypeCandidate | null = null;
  let bestScore = 0;
  for (const t of types) {
    const code = normalize(t.type_code);
    let score = Math.max(
      similarity(target, code),
      similarity(target, normalize(t.name)) * 0.9,
    );
    if (markNorm) {
      score = Math.max(score, similarity(markNorm, code));
    }
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
 * best type match. Mark #14 ×3 becomes 14-1, 14-2, 14-3 (type mark stays 14).
 */
export function rowsToDraftOpenings(
  rows: ScheduleRow[],
  types: TypeCandidate[],
): DraftOpening[] {
  const drafts: DraftOpening[] = [];
  for (const row of rows) {
    const mark = markBase(row.openingCode);
    const match = matchWindowType(row.typeText, types, 0.6, mark);
    const codes =
      row.qty === 1
        ? [mark]
        : Array.from({ length: row.qty }, (_, i) => `${mark}-${i + 1}`);
    for (const code of codes) {
      drafts.push({
        opening_code: code,
        window_type_id: match.type?.id ?? null,
        type_text: row.typeText,
        match_score: match.score,
        label: row.label,
        page_number: row.pageNumber,
        mark_code: mark,
        width_in: row.widthIn,
        height_in: row.heightIn,
        color: row.color,
        kind: row.kind,
        pin_x: null,
        pin_y: null,
      });
    }
  }
  return drafts;
}

/**
 * One draft per building-plan callout (pinned). Spec/detail rows enrich
 * product, size, and kind when the same mark appears there — so #6 ×12 on
 * the marked plan becomes twelve openings even when CAD text has no QTY.
 */
export function calloutsToDraftOpenings(
  callouts: {
    mark: string;
    pageNumber: number;
    x: number;
    y: number;
  }[],
  enrichRows: ScheduleRow[],
  types: TypeCandidate[],
): DraftOpening[] {
  const byMark = new Map<string, typeof callouts>();
  for (const callout of callouts) {
    const list = byMark.get(callout.mark) ?? [];
    list.push(callout);
    byMark.set(callout.mark, list);
  }

  const enrichByMark = new Map<string, ScheduleRow>();
  for (const row of enrichRows) {
    const key = markBase(row.openingCode);
    const existing = enrichByMark.get(key);
    if (!existing) enrichByMark.set(key, row);
  }

  const drafts: DraftOpening[] = [];
  const marks = [...byMark.keys()].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true }),
  );

  for (const mark of marks) {
    const list = byMark.get(mark)!;
    const enrich = enrichByMark.get(mark);
    const typeText = enrich?.typeText ?? mark;
    const match = matchWindowType(typeText, types, 0.6, mark);
    const codes =
      list.length === 1
        ? [mark]
        : list.map((_, index) => `${mark}-${index + 1}`);

    list.forEach((callout, index) => {
      drafts.push({
        opening_code: codes[index],
        window_type_id: match.type?.id ?? null,
        type_text: typeText,
        match_score: match.score,
        label: enrich?.label ?? null,
        page_number: callout.pageNumber,
        mark_code: mark,
        width_in: enrich?.widthIn ?? null,
        height_in: enrich?.heightIn ?? null,
        color: enrich?.color ?? null,
        kind: enrich?.kind ?? "window",
        pin_x: callout.x,
        pin_y: callout.y,
      });
    });
  }

  return drafts;
}

/** Summarize drafts for the review screen: "12× #14 windows". */
export function summarizeDraftMarks(
  drafts: DraftOpening[],
): { mark: string; count: number; kind: "window" | "door" }[] {
  const map = new Map<string, { mark: string; count: number; kind: "window" | "door" }>();
  for (const d of drafts) {
    const key = `${d.kind}:${d.mark_code}`;
    const cur = map.get(key);
    if (cur) cur.count += 1;
    else map.set(key, { mark: d.mark_code, count: 1, kind: d.kind });
  }
  return [...map.values()].sort((a, b) => a.mark.localeCompare(b.mark));
}
