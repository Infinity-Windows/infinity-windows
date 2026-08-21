// Deterministic window/door-schedule extraction from planset text, with an
// optional AI fallback (`ExtractStrategy`) when `parseScheduleRows` finds
// nothing. Specs plansets define what a mark (#14) *is*; qty expands into
// individual openings for install tracking (14-1, 14-2, …).

import {
  isElevationSheet,
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
  /**
   * Where the callout actually is on the plan, kept separate from `pin_x`
   * because a re-extract deliberately carries a manually placed pin across.
   * Without this the preserved pin would be saved as the mark's origin, and
   * "put it back where the plan put it" would put it back to the nudge.
   */
  origin_pin_x?: number | null;
  origin_pin_y?: number | null;
}

/** AI fallback implements this; deterministic parser is the default. */
export type ExtractStrategy = (
  pages: { pageNumber: number; text: string }[],
) => ScheduleRow[] | Promise<ScheduleRow[]>;

export const deterministicExtract: ExtractStrategy = (pages) =>
  pages.flatMap((p) => parseScheduleRows(p.text, p.pageNumber));

export interface ExtractOptions {
  /**
   * Also run the AI fallback (and reconcile it with the deterministic result)
   * when the deterministic + detail merge produced this many rows or fewer.
   * Defaults to 0, i.e. AI only runs when nothing was found. Raise it so a
   * suspiciously small deterministic result no longer suppresses AI.
   */
  aiWhenBelow?: number;
}

/**
 * Union two schedule-row sets by base mark, never dropping a mark either
 * source found. When both list the same mark we keep the larger quantity and
 * fill in any missing product/size/color/kind — so a partial deterministic
 * parse and the AI result reinforce each other instead of one clobbering the
 * other.
 */
export function unionScheduleRows(
  primary: ScheduleRow[],
  secondary: ScheduleRow[],
): ScheduleRow[] {
  const byMark = new Map<string, ScheduleRow>();
  const key = (row: ScheduleRow) => markBase(row.openingCode).toUpperCase();
  for (const row of primary) byMark.set(key(row), { ...row });
  for (const row of secondary) {
    const k = key(row);
    const existing = byMark.get(k);
    if (!existing) {
      byMark.set(k, { ...row });
      continue;
    }
    existing.qty = Math.max(existing.qty, row.qty);
    if (
      (!existing.typeText || existing.typeText === existing.openingCode) &&
      row.typeText &&
      row.typeText !== row.openingCode
    ) {
      existing.typeText = row.typeText;
    }
    existing.widthIn ??= row.widthIn;
    existing.heightIn ??= row.heightIn;
    existing.color ??= row.color;
    existing.label ??= row.label;
  }
  return [...byMark.values()].sort((a, b) =>
    a.openingCode.localeCompare(b.openingCode, undefined, { numeric: true }),
  );
}

/**
 * Run deterministic schedule extract, then fill missing marks from
 * manufacturer CAD detail sheets (#4A / #4B style). AI runs when both paths
 * find nothing, or when the deterministic result is implausibly small
 * (`options.aiWhenBelow`) — in which case AI is reconciled with, not
 * substituted for, the deterministic rows. Same draft/confirm guardrails
 * apply downstream.
 */
export async function extractScheduleRows(
  pages: { pageNumber: number; text: string }[],
  aiFallback?: ExtractStrategy | null,
  options?: ExtractOptions,
): Promise<{
  rows: ScheduleRow[];
  source: "deterministic" | "ai" | "details" | "merged" | "none";
}> {
  // Elevation sheets re-label the same windows the schedule already counts
  // (the RAC-OAK-5 and ESH-18 lesson): their text is quantity NOISE, never
  // quantity truth, so the deterministic and detail parses skip them. The
  // classifier only flags sheets with positive elevation evidence, so real
  // schedule-table pages are never dropped. The AI fallback still sees every
  // page — its prompt carries the same rule.
  const readable = pages.filter((p) => !isElevationSheet(p.text));
  const deterministic = await deterministicExtract(readable);
  const detailRows = parseCadDetailScheduleRows(readable);
  const merged = mergeScheduleWithDetailRows(deterministic, detailRows);

  const baseSource: "deterministic" | "details" | "merged" =
    deterministic.length > 0 && detailRows.length > 0
      ? "merged"
      : deterministic.length > 0
        ? "deterministic"
        : "details";

  const aiWhenBelow = options?.aiWhenBelow ?? 0;
  const wantAi = !!aiFallback && merged.length <= aiWhenBelow;

  if (merged.length > 0 && !wantAi) {
    return { rows: merged, source: baseSource };
  }

  if (aiFallback && wantAi) {
    const aiRows = await aiFallback(pages);
    if (aiRows.length > 0) {
      if (merged.length === 0) return { rows: aiRows, source: "ai" };
      // Reconcile: keep every deterministic mark and let AI add the rest.
      return { rows: unionScheduleRows(merged, aiRows), source: "merged" };
    }
  }

  if (merged.length > 0) return { rows: merged, source: baseSource };
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
  /\b(MARK|SYMBOL|QTY|QUANTITY|MANUF|SCHEDULE|REMARKS|R\.O\.|ROUGH|WIDTH|HEIGHT|COLOR|FINISH)\b/gi;
// A single field that is purely a column header word (e.g. "QTY") — dropped so
// it never lands in the label and so "… QTY 3 …" reads the 3 as the quantity.
const HEADER_WORD_TOKEN_RE =
  /^(MARK|SYMBOL|QTY|QUANTITY|QTY\.|MANUF|MFR|SCHEDULE|REMARKS|ROUGH|WIDTH|HEIGHT|COLOR|COLOUR|FINISH|SIZE|TYPE|UNIT|NO|NO\.|COUNT|EA|PCS|EACH)$/i;
// Explicit quantity tokens, checked before the bare-number heuristic so a
// labelled count always wins: "QTY:3", "QTY 3" (two fields), "(3)", "3 EA",
// "x3", "×12". Bare integers are only used when nothing explicit is present.
const QTY_LABELLED_RE = /^(?:QTY|QTY\.|QUANTITY|COUNT|NO|NO\.)[:=]?\s*(\d{1,3})$/i;
const QTY_PAREN_RE = /^\((\d{1,3})\)$/;
const QTY_SUFFIX_RE = /^(\d{1,3})\s*(?:EA|PCS?|PC|PLCS|UNITS?|X)$/i;
const QTY_MULT_RE = /^[x×](\d{1,3})$/i;
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
    if (!line) continue;

    let fields = splitFields(line);
    if (fields.length < 2) fields = line.split(/\s+/);
    if (fields.length < 2) continue;

    const markUpper = fields[0].toUpperCase();
    if (!MARK_RE.test(markUpper)) continue;
    const mark = normalizeMark(markUpper);

    // The row starts with a real mark. Only reject it as a header when it is
    // dense with column-header words (e.g. "MARK TYPE SIZE QTY LOCATION"); a
    // data row such as "#14 CAS3050 QTY 3 LIVING" must survive even though it
    // mentions QTY. (An upfront HEADER_WORDS skip used to drop those rows.)
    HEADER_WORDS.lastIndex = 0;
    const headerHits = (line.match(HEADER_WORDS) ?? []).length;
    if (headerHits >= 2) continue;

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
    let explicitQty: number | null = null;
    let bareQty: number | null = null;
    let widthIn: number | null = null;
    let heightIn: number | null = null;
    let color: string | null = null;
    const labelParts: string[] = [];

    const takeQty = (raw: string): number | null => {
      const n = Number(raw);
      return Number.isFinite(n) && n >= 1 && n <= 500 ? n : null;
    };

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

      // Labelled/explicit quantity always wins over a stray bare integer.
      const labelled =
        f.match(QTY_LABELLED_RE) ??
        f.match(QTY_PAREN_RE) ??
        f.match(QTY_SUFFIX_RE) ??
        f.match(QTY_MULT_RE);
      if (labelled) {
        const n = takeQty(labelled[1]);
        if (n != null) explicitQty = n;
        continue;
      }
      // Drop bare column-header words ("QTY", "TYPE", …) so they neither
      // pollute the label nor hide the quantity number that follows them.
      if (HEADER_WORD_TOKEN_RE.test(f)) continue;

      if (bareQty === null && /^\d{1,3}$/.test(f)) {
        bareQty = takeQty(f);
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

    const qty = explicitQty ?? bareQty ?? 1;

    if (!typeText && labelParts.length > 0) {
      typeText = labelParts.shift()!.toUpperCase();
    }
    // Numeric-only marks (#14) often list product in type column; if still
    // empty, use the mark itself as the type key (specs define what #14 is).
    if (!typeText) typeText = mark;

    rows.push({
      openingCode: mark,
      typeText,
      qty,
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

/**
 * One mark's tally, in words that can only mean one thing.
 *
 * "3× #9 windows" was read on site as one window made of three pieces, and the
 * count was queried because of it. A mark is a TYPE — the number written on the
 * plan next to every opening of that type — so say how many openings use it.
 */
export function describeMarkCount(summary: {
  mark: string;
  count: number;
  kind: "window" | "door";
}): string {
  const noun = summary.kind === "door" ? "door" : "window";
  return summary.count === 1
    ? `1 ${noun} uses mark #${summary.mark}`
    : `${summary.count} ${noun}s use mark #${summary.mark}`;
}

/** Summarize drafts for the review screen: "12 windows use mark #14". */
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

export interface MarkTally {
  mark: string;
  count: number;
  kind: "window" | "door";
}

export interface ExtractOutcomeSummary {
  /** One sentence with the numbers that matter. Always safe to show alone. */
  headline: string;
  /** Short supporting sentences: repeats ignored, references saved, source. */
  notes: string[];
  /** Mark-by-mark lines, for a disclosure — never in the headline. */
  breakdown: string[];
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * The message shown after "Load marks from plans".
 *
 * Black Desert has 38 marks, and spelling every one of them out ran to six
 * lines on a phone — the opening count, the ignored repeats and the saved
 * elevation references were all below the fold. The totals lead; the per-mark
 * wording from #129 is kept verbatim and moved into the breakdown.
 */
export function summarizeExtractOutcome(input: {
  marks: MarkTally[];
  inserted: number;
  skipped: number;
  repeatViewCallouts: number;
  elevationViews: number;
  source: "none" | "schedule" | "details" | "merged" | string;
}): ExtractOutcomeSummary {
  const marks = [...input.marks].sort((a, b) =>
    a.mark.localeCompare(b.mark, undefined, { numeric: true }),
  );
  const openings = marks.reduce((sum, m) => sum + m.count, 0);
  const windows = marks
    .filter((m) => m.kind === "window")
    .reduce((sum, m) => sum + m.count, 0);
  const doors = openings - windows;
  // A mark can be tallied twice (a window and a door share the number), so
  // count the distinct numbers, not the tallies.
  const markCount = new Set(marks.map((m) => m.mark)).size;

  const mix = [
    windows > 0 ? plural(windows, "window") : null,
    doors > 0 ? plural(doors, "door") : null,
  ].filter(Boolean) as string[];

  let headline: string;
  if (marks.length === 0) {
    headline = "No marks found.";
  } else if (marks.length === 1) {
    headline = `Loaded ${plural(openings, "opening")} — ${describeMarkCount(marks[0])}.`;
  } else {
    headline = `Loaded ${plural(openings, "opening")} across ${plural(
      markCount,
      "mark",
    )} — ${mix.join(" and ")}.`;
  }

  const notes = [
    // Not only confirmed ones: anything already assigned, started or installed
    // is kept too, so don't promise the reader it was purely "confirmed".
    input.skipped > 0
      ? `Left ${input.skipped} alone — already confirmed or already being worked on.`
      : null,
    input.repeatViewCallouts > 0
      ? `Ignored ${plural(input.repeatViewCallouts, "repeat number")} on the elevation sheets — those draw the same openings again.`
      : null,
    input.elevationViews > 0
      ? `Saved ${input.elevationViews} of them as a reference, so the crew can see where each window sits on the outside.`
      : null,
    input.source === "details"
      ? "Source: manufacturer detail sheets / plan callouts."
      : input.source === "merged"
        ? "Source: plan callouts + detail sheets."
        : null,
  ].filter(Boolean) as string[];

  return { headline, notes, breakdown: marks.map(describeMarkCount) };
}

export type PlansetKindLike = "building" | "specs";

/** Existing opening as seen by the draft-persistence planner. */
export interface ExistingOpeningLite {
  id: string;
  opening_code: string;
  confirmed: boolean;
  status: string;
  pin_x: number | null;
  pin_y: number | null;
  page_number: number;
  /** Kind of the planset this opening came from. */
  planset_kind: PlansetKindLike;
  /** Dispatched to an installer (`assign_opening_to_installer`). */
  assigned_to?: string | null;
  /** Installer tapped "start" on this one (`start_opening_work`). */
  work_started_at?: string | null;
  /** Rough-opening measurements (`set_opening_rough_opening`). */
  ro_width_in?: number | null;
  ro_height_in?: number | null;
  /** Arrival condition once someone has actually looked (`set_opening_condition`). */
  condition?: string | null;
  /**
   * Another table points at this opening: an install event, a QC check, an
   * issue, a task session or a service case.
   */
  referenced?: boolean;
}

/**
 * Has anyone in the field touched this opening?
 *
 * `confirmed || status !== 'planned'` was the only guard, and it is not enough.
 * Measuring, condition-checking, dispatching and starting work all record real
 * effort WITHOUT moving either flag. Worse, `undo_install` deliberately resets
 * an opening to planned/unconfirmed while KEEPING (voiding, not deleting) the
 * install event — and `install_events` and `qc_checks` are ON DELETE CASCADE,
 * so deleting that row would destroy the install record it was preserving.
 */
export function hasFieldWork(o: ExistingOpeningLite): boolean {
  return Boolean(
    o.assigned_to ||
      o.work_started_at ||
      o.ro_width_in != null ||
      o.ro_height_in != null ||
      (o.condition != null && o.condition !== "unknown") ||
      o.referenced,
  );
}

export interface DraftPersistencePlan {
  /** Opening ids to delete (stale same-kind drafts + superseded marks). */
  deleteIds: string[];
  /** Drafts to insert, with preserved manual pins merged back in. */
  inserts: DraftOpening[];
  /** How many incoming drafts were skipped (protected or owned elsewhere). */
  skipped: number;
  /** Building-plan marks with no CAD window behind them (only set when a specs
   *  planset owns the job): surfaced so a plans-side label mismatch is SAID,
   *  never silently dropped. */
  unmatchedPlanMarks: string[];
}

/**
 * Decide what a re-extract should delete and insert, WITHOUT wiping openings
 * that belong to the other planset slot.
 *
 * The old behaviour deleted every unconfirmed opening on the whole project, so
 * uploading the specs sheet after the marked building plan destroyed all the
 * building-plan openings (105 → 6 on Smith Residence). This planner instead:
 *
 *  1. Replaces only unconfirmed drafts from a planset of the SAME kind (each
 *     upload creates a new planset row, so we scope by kind, not planset id).
 *  2. CAD WINS (owner rule, settled 2026-08-21, proven on ESH-18): the signed
 *     CAD/specs planset owns unit counts. A specs save supersedes unconfirmed
 *     building-callout openings that share its marks, never the reverse — and
 *     while any specs-kind opening exists, a building plan creates NOTHING
 *     (its callouts are placement hints; labels with no CAD mark are returned
 *     in unmatchedPlanMarks for the person to see). On a plans-only job the
 *     building plan keeps its old authority: callout counting stands.
 *  3. Never creates a second opening for a mark that already exists in the
 *     other slot, and never touches confirmed / in-progress openings.
 *  4. Preserves manually placed pins across a same-kind re-extract.
 *  5. Never deletes an opening that carries field work — see `hasFieldWork`.
 */
export function planDraftPersistence(
  existing: ExistingOpeningLite[],
  drafts: DraftOpening[],
  incomingKind: PlansetKindLike,
  // True only when the specs read carried EXPLICIT quantities (the vision
  // cut-sheet read, or a real schedule table). A weak detail-page read with
  // guessed qty=1 rows must never supersede building counts.
  specsAuthoritative = false,
): DraftPersistencePlan {
  const isProtected = (o: ExistingOpeningLite) =>
    o.confirmed || o.status !== "planned" || hasFieldWork(o);

  const sameKindStale = existing.filter(
    (o) => !isProtected(o) && o.planset_kind === incomingKind,
  );

  const incomingMarks = new Set(drafts.map((d) => markBase(d.opening_code)));
  // ESH-18 went 31 -> 79 openings because this arrow used to point the other
  // way: hand-labeled plan callouts deleted the signed CAD's correct counts
  // and replaced them with appearance counting. CAD wins now.
  const superseded =
    incomingKind === "specs" && specsAuthoritative
      ? existing.filter(
          (o) =>
            !isProtected(o) &&
            o.planset_kind === "building" &&
            incomingMarks.has(markBase(o.opening_code)),
        )
      : [];

  const deleteSet = new Set<string>(
    [...sameKindStale, ...superseded].map((o) => o.id),
  );
  const survivors = existing.filter((o) => !deleteSet.has(o.id));

  // Manual pins from replaced same-kind drafts, restored by opening code.
  const preservedPins = new Map<
    string,
    { pin_x: number; pin_y: number; page_number: number }
  >();
  for (const o of sameKindStale) {
    if (o.pin_x == null || o.pin_y == null) continue;
    preservedPins.set(o.opening_code, {
      pin_x: o.pin_x,
      pin_y: o.pin_y,
      page_number: o.page_number,
    });
  }

  const protectedCodes = new Set(
    survivors.filter(isProtected).map((o) => o.opening_code),
  );
  // Base marks already owned by a surviving opening from the OTHER slot — we
  // won't duplicate the same physical opening across both plansets.
  const otherKindMarks = new Set(
    survivors
      .filter((o) => o.planset_kind !== incomingKind)
      .map((o) => markBase(o.opening_code)),
  );

  const specsOwnsJob =
    incomingKind === "building" &&
    survivors.some((o) => o.planset_kind === "specs");

  const inserts: DraftOpening[] = [];
  const unmatchedPlanMarks: string[] = [];
  let skipped = 0;
  for (const d of drafts) {
    if (specsOwnsJob) {
      // The CAD sheet decides what exists. A callout matching a CAD mark is
      // already counted; one matching nothing is a plans-side label to check.
      if (otherKindMarks.has(markBase(d.opening_code))) skipped += 1;
      else unmatchedPlanMarks.push(markBase(d.opening_code));
      continue;
    }
    if (
      protectedCodes.has(d.opening_code) ||
      otherKindMarks.has(markBase(d.opening_code))
    ) {
      skipped += 1;
      continue;
    }
    const kept = preservedPins.get(d.opening_code);
    inserts.push({
      ...d,
      page_number: kept?.page_number ?? d.page_number,
      pin_x: kept?.pin_x ?? d.pin_x ?? null,
      pin_y: kept?.pin_y ?? d.pin_y ?? null,
      origin_pin_x: d.pin_x ?? kept?.pin_x ?? null,
      origin_pin_y: d.pin_y ?? kept?.pin_y ?? null,
    });
  }

  return {
    deleteIds: [...deleteSet],
    inserts,
    skipped,
    unmatchedPlanMarks: [...new Set(unmatchedPlanMarks)],
  };
}
