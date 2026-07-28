// Client-side normalization for VISION-extracted per-mark specs.
//
// The specs planset for jobs like Smith / PV Townhomes is a manufacturer
// shop-drawing PDF whose rich per-mark details (style, glass makeup, color) are
// drawn into the page as an IMAGE — the selectable text layer is empty and
// scrambled, so a text parser can never recover them. The `extract-specs` edge
// function renders each page and runs it through Claude VISION, which returns
// the spec table verbatim as `{ mark, style, glass, color, size_code,
// operation, qty }` objects (mode: "vision").
//
// This module turns those verbatim objects into the app's `MarkSpecDraft`
// shape, reusing the pure `mergeSpecsByMark` / `normalizeSpec` helpers so size
// codes are decoded and marks reinforce each other. It only does light,
// deterministic clean-up the vision model shouldn't have to: strip the project
// prefix off the mark label, split a trailing operation token off the size
// code, and derive the tempered/egress booleans from the transcribed text. It
// never invents fields — anything the sheet didn't show stays blank.

import { mergeSpecsByMark, type MarkSpecDraft } from "./specs";

/** One verbatim mark object as returned by the vision edge function. */
export interface RawVisionMark {
  mark?: unknown;
  mark_code?: unknown;
  style?: unknown;
  glass?: unknown;
  color?: unknown;
  size_code?: unknown;
  size?: unknown;
  operation?: unknown;
  qty?: unknown;
  /** Normalized `[x0,y0,x1,y1]` of this mark's elevation drawing on the page. */
  bbox?: unknown;
  /** One box per piece when the model merged adjacent marks into one entry. */
  bboxes?: unknown;
  /** 1-based specs-planset page the drawing was found on. */
  image_page?: unknown;
  page?: unknown;
}

function str(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
}

/**
 * Strip a manufacturer/project prefix off a printed mark label, leaving the
 * bare mark:
 *   "PV Townhomes Bldg 14-#4A" → "4A"
 *   "#1"                        → "1"
 *   "1"                         → "1"
 *   "PV Townhomes Bldg 14-13B"  → "13B"
 * When a '#' is present the text after the LAST '#' is the mark. Otherwise a
 * bare "…prefix-<mark>" (with whitespace before the dash group) has its prefix
 * dropped, while a lone code like "A-101" (no whitespace) is kept intact.
 * Returns null when there's nothing usable. PURE — no side effects.
 */
export function normalizeMarkLabel(raw: unknown): string | null {
  const s = str(raw);
  if (!s) return null;
  const hashes = [...s.matchAll(/#\s*([A-Za-z0-9]+)/g)];
  if (hashes.length > 0) {
    return hashes[hashes.length - 1][1].toUpperCase();
  }
  if (/\s/.test(s)) {
    const dash = s.match(/-\s*([A-Za-z]{0,3}\d{1,4}[A-Za-z]?)\s*$/);
    if (dash) return dash[1].toUpperCase();
  }
  return s.toUpperCase();
}

/**
 * A plausible bare mark code once the project prefix and '#' are stripped:
 * a run of digits with an optional single trailing letter, e.g. "4A", "13B",
 * "18", "7". We only ever SPLIT a combined mark into pieces that all look like
 * this, so we never accidentally tear apart a legitimate single mark that just
 * happens to contain a separator character.
 */
const BARE_MARK_CODE = /^[0-9]+[A-Z]?$/;

/**
 * Separators the vision model uses when it collapses two adjacent paired marks
 * into one string: an ampersand, a slash, or the word "and" — each optionally
 * padded with whitespace. Splitting on this turns
 *   "PV Townhomes Bldg 14-#4A& PV Townhomes Bldg 14-#4B" → two pieces,
 *   "#4A & #4B" → two pieces, "4A&4B" → two pieces, "4A / 4B and 4C" → three.
 */
const MARK_SEPARATORS = /\s*&\s*|\s*\/\s*|\s+and\s+/i;

/**
 * Detect a combined mark object — where Claude vision merged two (or more)
 * adjacent paired marks into ONE entry, e.g.
 *   { mark: "PV Townhomes Bldg 14-#4A& PV Townhomes Bldg 14-#4B", qty: "1&1" }
 * — and expand it into one raw mark per piece, each carrying the SAME
 * style/glass/color/size/operation and its own bare mark. When the qty is in
 * the matching "a&b" form ("1&1", "3&2") it's split per mark; otherwise the
 * original qty rides along on every piece unchanged.
 *
 * To avoid false positives we only split when the mark actually contains a
 * separator AND every resulting piece normalizes (via {@link normalizeMarkLabel})
 * to a plausible short mark code like "4A"/"13B". A legitimate single mark that
 * merely contains a separator (or doesn't yield clean codes on both sides) is
 * returned untouched as a one-element list. PURE — no side effects.
 */
export function splitCombinedMark(raw: RawVisionMark): RawVisionMark[] {
  const markStr = str(raw.mark ?? raw.mark_code);
  if (!markStr || !MARK_SEPARATORS.test(markStr)) return [raw];

  const pieces = markStr
    .split(MARK_SEPARATORS)
    .map((p) => p.trim())
    .filter(Boolean);
  if (pieces.length < 2) return [raw];

  // Every piece must reduce to a plausible bare mark code, else this "&" is
  // part of a single legitimate mark and we must not tear it apart.
  const codes = pieces.map((p) => normalizeMarkLabel(p));
  if (!codes.every((c) => c != null && BARE_MARK_CODE.test(c))) return [raw];

  // Split the qty only when it's in the same "a&b" shape with a matching count
  // (e.g. "1&1" → ["1","1"]); otherwise keep the original qty on every piece.
  const qtyStr = str(raw.qty);
  let qtyPieces: string[] | null = null;
  if (qtyStr) {
    const qs = qtyStr
      .split(MARK_SEPARATORS)
      .map((q) => q.trim())
      .filter(Boolean);
    if (qs.length === pieces.length) qtyPieces = qs;
  }

  const boxes = drawingBoxesForPieces(raw, pieces.length);

  return pieces.map((piece, i) => ({
    ...raw,
    mark: piece,
    mark_code: undefined,
    qty: qtyPieces ? qtyPieces[i] : raw.qty,
    bbox: boxes[i],
    bboxes: undefined,
  }));
}

/**
 * Work out one elevation-drawing box per piece of a combined mark. Paired marks
 * like #4A / #4B are drawn as two separate elevations side by side, so when the
 * model returned a box for each (`bboxes`, or a `bbox` that is itself a list of
 * boxes) they're handed out in order. When it only gave one box for the whole
 * combined entry, both pieces share it — the same drawing on both cards beats
 * no drawing at all. Every piece keeps the entry's page either way. PURE.
 */
function drawingBoxesForPieces(raw: RawVisionMark, count: number): unknown[] {
  const listed = Array.isArray(raw.bboxes) ? raw.bboxes : null;
  if (listed && listed.length === count) return listed;

  const bbox = raw.bbox;
  if (
    Array.isArray(bbox) &&
    bbox.length === count &&
    bbox.every((b) => Array.isArray(b))
  ) {
    return bbox;
  }

  return Array.from({ length: count }, () => bbox);
}

/**
 * Split a size string into a 4-digit call size and (when present) its trailing
 * operation token:
 *   ("6080 XO", null)      → { size_code: "6080", operation: "XO" }
 *   ("3060", "Fixed")      → { size_code: "3060", operation: "Fixed" }
 *   ("6080 XO", "Sliding") → { size_code: "6080", operation: "Sliding" }
 * An explicit operation always wins over the trailing token. A size with no
 * 4-digit code is kept verbatim (the review step catches oddballs). PURE.
 */
export function splitSizeCodeOperation(
  rawSize: unknown,
  rawOp: unknown,
): { size_code: string | null; operation: string | null } {
  const sizeStr = str(rawSize) ?? "";
  const explicitOp = str(rawOp);

  let sizeCode: string | null = null;
  let tokenOp: string | null = null;

  const m = sizeStr.match(/\b(\d{4})\b/);
  if (m) {
    sizeCode = m[1];
    const rest = sizeStr.replace(m[1], " ").replace(/[()]/g, " ").trim();
    if (rest) tokenOp = rest.split(/\s+/)[0].toUpperCase();
  } else if (sizeStr) {
    sizeCode = sizeStr;
  }

  return { size_code: sizeCode, operation: explicitOp ?? tokenOp };
}

/** Tempered when the transcribed glass makeup literally says so. */
export function deriveTempered(glass: unknown): boolean | null {
  const g = str(glass);
  if (!g) return null;
  return /tempered/i.test(g) ? true : null;
}

/**
 * Egress when the style or operation literally mentions egress. We do NOT infer
 * egress from "casement" alone — not every casement is an egress unit — so an
 * unstated egress stays null for the foreman to decide.
 */
export function deriveEgress(style: unknown, operation: unknown): boolean | null {
  const hay = `${str(style) ?? ""} ${str(operation) ?? ""}`;
  return /egress/i.test(hay) ? true : null;
}

/**
 * Turn one verbatim vision mark into a loose object shaped for `normalizeSpec`:
 * normalized mark, split size/operation, derived tempered/egress, verbatim
 * style/glass/color, and qty tucked into `extra`.
 */
export function prepVisionSpec(raw: RawVisionMark): Record<string, unknown> {
  const mark_code = normalizeMarkLabel(raw.mark ?? raw.mark_code);
  const { size_code, operation } = splitSizeCodeOperation(
    raw.size_code ?? raw.size,
    raw.operation,
  );
  const glass = str(raw.glass);
  const style = str(raw.style);
  const qty = str(raw.qty);

  return {
    mark_code,
    style,
    glass,
    color: str(raw.color),
    size_code,
    operation,
    tempered: deriveTempered(glass),
    egress: deriveEgress(style, operation),
    extra: qty ? { qty } : null,
    // Where the mark's elevation drawing sits on the specs planset. Both are
    // validated downstream by normalizeSpec (page must be a positive integer,
    // box must survive validateBbox) and go null when they don't hold up.
    image_page: raw.image_page ?? raw.page,
    image_bbox: raw.bbox,
    source: "ai",
  };
}

/**
 * Normalize + merge verbatim vision marks into deduped {@link MarkSpecDraft}s.
 * Reuses {@link mergeSpecsByMark} so size codes are decoded to width/height and
 * marks split across pages reinforce each other. `source: 'ai'` (vision),
 * unconfirmed — the foreman review/confirm step still applies.
 */
export function visionMarksToDrafts(raws: RawVisionMark[]): MarkSpecDraft[] {
  const expanded = raws.flatMap(splitCombinedMark);
  return mergeSpecsByMark(expanded.map(prepVisionSpec), "ai");
}
