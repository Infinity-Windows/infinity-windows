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

import {
  parsePrintedInches,
  resolveSpecSize,
  sizeMismatchRecord,
} from "./printedSize";
import {
  decodeSizeCode,
  mergeSpecsByMark,
  type MarkSpecDraft,
  type PaneGrid,
  type PaneGridColumn,
  type PaneGridOp,
  type PaneGridSegment,
} from "./specs";

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
  /**
   * The overall dimensions PRINTED beside the mark's elevation, transcribed
   * verbatim — `"901(35 1/2\")"`, `"1816(71 1/2\")"`. They're what lets us catch
   * a call size decoded under the wrong convention. Null when none is visible.
   */
  printed_width?: unknown;
  printed_height?: unknown;
  /** Normalized `[x0,y0,x1,y1]` of this mark's elevation drawing on the page. */
  bbox?: unknown;
  /** One box per piece when the model merged adjacent marks into one entry. */
  bboxes?: unknown;
  /** 1-based specs-planset page the drawing was found on. */
  image_page?: unknown;
  page?: unknown;  panel_widths?: unknown;
  panel_ops?: unknown;
  corner?: unknown;
  inset_outset?: unknown;
  /** THE GRID CONTRACT (wave G) — the pictured cell's real mullion-column
   * design, when the drawing shows one (see {@link PaneGrid}). Null/absent
   * for the ordinary flat-row case, which `panel_widths` above still covers. */
  pane_grid?: unknown;
}

function str(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
}

/** "ADD" / "add" / "Add" -> "Add" — deterministic regardless of how a PDF
 * text layer or vision transcription happened to capitalize a word, so the
 * SAME addendum mark normalizes the SAME way every re-extraction. */
function titleCase(word: string): string {
  return word[0].toUpperCase() + word.slice(1).toLowerCase();
}

/**
 * The word directly hyphen-attached before a captured mark's suffix — "Add"
 * in "Mad Moose Add-#1" or "Mad Moose Add-4A" — kept as the mark's OWN
 * identity, unlike a purely numeric job/building code ("14" in "Bldg
 * 14-#4A"), which is legitimately dropped because the same mark repeats
 * across buildings. Only a prefix made of LETTERS survives, title-cased for
 * a deterministic result regardless of source capitalization; `before` is
 * everything in the original string up to (not including) the dash.
 *
 * The Mad Moose incident (2026-09-01): an addendum cut sheet's own marks
 * read "Mad Moose Add-#1/#2/#3" — exactly the spelling ("Add-1" etc) the
 * owner's confirmed production data already carries (seeded #474/#477).
 * Reading this the same as Smith's numeric job-code shape dropped "Add"
 * entirely, colliding the addendum's #1/#2/#3 with the job's REAL marks
 * 1/2/3.
 */
function attachedWordPrefix(before: string): string | null {
  const m = /([A-Za-z]+)$/.exec(before);
  return m ? titleCase(m[1]) : null;
}

/**
 * Strip a manufacturer/project prefix off a printed mark label, leaving the
 * bare mark:
 *   "PV Townhomes Bldg 14-#4A" → "4A"
 *   "#1"                        → "1"
 *   "1"                         → "1"
 *   "PV Townhomes Bldg 14-13B"  → "13B"
 *   "Mad Moose Add-#1"          → "Add-1"
 * When a '#' is present the text after the LAST '#' is the mark, with any
 * LETTER prefix directly hyphen-attached to that '#' kept (see
 * `attachedWordPrefix`) — a numeric job code like "14-" is still dropped.
 * Otherwise a bare "…prefix-<mark>" (with whitespace before the dash group)
 * has its numeric prefix dropped the same way, while a lone code like
 * "A-101" (no whitespace) is kept intact. Returns null when there's nothing
 * usable. PURE — no side effects.
 */
export function normalizeMarkLabel(raw: unknown): string | null {
  const s = str(raw);
  if (!s) return null;
  const hashes = [...s.matchAll(/#\s*([A-Za-z0-9]+)/g)];
  if (hashes.length > 0) {
    const last = hashes[hashes.length - 1];
    const base = last[1].toUpperCase();
    let i = last.index ?? 0;
    while (i > 0 && /\s/.test(s[i - 1])) i--;
    const prefix = s[i - 1] === "-" ? attachedWordPrefix(s.slice(0, i - 1)) : null;
    return prefix ? `${prefix}-${base}` : base;
  }
  if (/\s/.test(s)) {
    const dash = s.match(/-\s*([A-Za-z]{0,3}\d{1,4}[A-Za-z]?)\s*$/);
    if (dash) {
      const base = dash[1].toUpperCase();
      const prefix = attachedWordPrefix(s.slice(0, dash.index ?? 0));
      return prefix ? `${prefix}-${base}` : base;
    }
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

// --- pane_grid (THE GRID CONTRACT, wave G) ---
//
// The edge function already validates its own pane_grid read before it ever
// reaches this module (same shape rules, mirrored server-side in
// supabase/functions/extract-specs). This re-validates client-side anyway —
// the same defense-in-depth `corner` and `bbox` already get here, because
// nothing downstream should have to trust a network payload's shape.

/** op vocabulary law: docs/window-vendor-conventions.md — F fixed, X
 * operable/slider, "door" a swing leaf. Case-insensitive on the wire,
 * canonicalized here. */
function cleanPaneGridOp(raw: unknown): PaneGridOp | null {
  const s = typeof raw === "string" ? raw.trim().toUpperCase() : "";
  if (s === "F" || s === "X") return s;
  if (s === "DOOR") return "door";
  return null;
}

function cleanPaneGridLeaf(raw: unknown): "L" | "R" | undefined {
  const s = typeof raw === "string" ? raw.trim().toUpperCase() : "";
  return s === "L" || s === "R" ? (s as "L" | "R") : undefined;
}

/** A dimension in inches: finite, positive, and under a size no real unit
 * reaches (50 ft is generous headroom against the model echoing a
 * whole-building dimension by mistake). Omitted/unusable → undefined, never
 * a stored 0 — the contract reads a missing key as "divide evenly". */
function cleanPaneGridInches(raw: unknown): number | undefined {
  if (raw == null || raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n <= 600 ? n : undefined;
}

function cleanPaneGridSegment(raw: unknown): PaneGridSegment | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const op = cleanPaneGridOp(o.op);
  if (!op) return null;
  const segment: PaneGridSegment = { op };
  const height = cleanPaneGridInches(o.height_in ?? o.heightIn);
  if (height != null) segment.height_in = height;
  const leaf = cleanPaneGridLeaf(o.leaf);
  if (leaf) segment.leaf = leaf;
  return segment;
}

function cleanPaneGridColumn(raw: unknown): PaneGridColumn | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const rawSegments = Array.isArray(o.segments) ? o.segments : null;
  // 12 segments is already beyond any real unit — same smell test panel_widths
  // uses for a transcribed dimension chain that isn't panel widths.
  if (!rawSegments || rawSegments.length === 0 || rawSegments.length > 12) {
    return null;
  }
  const segments = rawSegments.map(cleanPaneGridSegment);
  if (segments.some((s) => s === null)) return null;
  const column: PaneGridColumn = { segments: segments as PaneGridSegment[] };
  const width = cleanPaneGridInches(o.width_in ?? o.widthIn);
  if (width != null) column.width_in = width;
  return column;
}

/**
 * Validate the vision model's pane_grid read into a typed {@link PaneGrid},
 * or null when it doesn't hold up. ALL-OR-NOTHING, same as `cleanBbox`/
 * `corner` — one garbled column is worth zero trust, not a half-drawn grid,
 * and dropping it costs nothing else: the mark's other fields (and
 * `extra.panels`, the flat fallback) are unaffected either way. PURE.
 */
export function cleanPaneGrid(raw: unknown): PaneGrid | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const rawColumns = Array.isArray(o.columns) ? o.columns : null;
  if (!rawColumns || rawColumns.length === 0 || rawColumns.length > 12) {
    return null;
  }
  const columns = rawColumns.map(cleanPaneGridColumn);
  if (columns.some((c) => c === null)) return null;
  return { columns: columns as PaneGridColumn[] };
}

/**
 * Turn one verbatim vision mark into a loose object shaped for `normalizeSpec`:
 * normalized mark, split size/operation, derived tempered/egress, verbatim
 * style/glass/color, and qty tucked into `extra`.
 *
 * It also CROSS-CHECKS the call size against the dimensions printed on the
 * drawing (see `printedSize.ts`). The decode assumes a feet+inches convention
 * this supplier happens to use; a supplier using inch-based codes would have
 * "3672" silently become 42" × 86" instead of 36" × 72". So when the two
 * disagree beyond tolerance the PRINTED dimensions are what we store as
 * `width_in`/`height_in` — they're drawn on the sheet in the installer's hand —
 * the raw `size_code` is still kept verbatim, and the disagreement is recorded
 * in `extra.size_mismatch` for the foreman's review screen. When they agree, or
 * when the sheet printed no dimensions, nothing changes from before.
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

  const printedWidth = str(raw.printed_width);
  const printedHeight = str(raw.printed_height);
  const printedWidthIn = parsePrintedInches(printedWidth);
  const printedHeightIn = parsePrintedInches(printedHeight);
  const decoded = decodeSizeCode(size_code);
  const size = resolveSpecSize({
    decodedWidthIn: decoded?.widthIn ?? null,
    decodedHeightIn: decoded?.heightIn ?? null,
    printedWidthIn,
    printedHeightIn,
  });

  const extra: Record<string, unknown> = {};
  if (qty) extra.qty = qty;
  // Verbatim first, parsed inches alongside — the strings are the evidence, the
  // numbers save every reader re-parsing them.
  if (printedWidth) extra.printed_width = printedWidth;
  if (printedHeight) extra.printed_height = printedHeight;
  if (printedWidthIn != null) extra.printed_width_in = printedWidthIn;
  if (printedHeightIn != null) extra.printed_height_in = printedHeightIn;
  const mismatch = sizeMismatchRecord(size_code, printedWidthIn, printedHeightIn);
  if (mismatch) extra.size_mismatch = mismatch;

  // Per-panel widths + corner read off the elevation drawing (owner ask:
  // pulls arrive pre-split and pre-cornered). Verbatim strings kept as
  // evidence; parsed inches ride alongside for every consumer.
  const panelWidths = Array.isArray(raw.panel_widths)
    ? (raw.panel_widths as unknown[]).map((v) => str(v)).filter((v): v is string => Boolean(v))
    : [];
  const panelOps = Array.isArray(raw.panel_ops)
    ? (raw.panel_ops as unknown[]).map((v) => str(v)?.toUpperCase() ?? "")
    : [];
  if (panelWidths.length >= 2) {
    const panels = panelWidths.map((printed, i) => ({
      printed,
      width_in: parsePrintedInches(printed),
      op: panelOps[i] && /^[XOF]/.test(panelOps[i]) ? panelOps[i][0] : null,
    }));
    // Only keep a set the drawing actually dimensioned: every panel parsed.
    if (panels.every((pp) => pp.width_in != null && pp.width_in > 2)) {
      extra.panels = panels;
    }
  }
  const corner = raw.corner as
    | { after_panel?: unknown; side?: unknown }
    | null
    | undefined;
  if (corner && typeof corner === "object") {
    const after = Number(corner.after_panel);
    const side = corner.side === "right" ? "right" : corner.side === "left" ? "left" : null;
    if (Number.isInteger(after) && after >= 0 && after <= 10 && side) {
      extra.corner = { after_panel: after, side };
    }
  }
  // Inset vs outset mounting (signature field, spec .scratch/signature):
  // stored only when the sheet actually said — a blank is an honest blank,
  // never a default.
  const io = typeof raw.inset_outset === "string" ? raw.inset_outset.trim().toLowerCase() : null;
  if (io === "inset" || io === "outset") extra.inset_outset = io;

  // THE GRID CONTRACT (wave G): ADDITIONAL description of the same pictured
  // cell, never a new source of marks/counts (vision-first law holds — this
  // never runs without a mark_code already established above). Only stored
  // when the cell actually reads as mullion columns; the ordinary flat-row
  // case keeps using extra.panels above, untouched.
  const paneGrid = cleanPaneGrid(raw.pane_grid);
  if (paneGrid) extra.pane_grid = paneGrid;

  return {
    mark_code,
    style,
    glass,
    color: str(raw.color),
    size_code,
    width_in: size.widthIn,
    height_in: size.heightIn,
    operation,
    tempered: deriveTempered(glass),
    egress: deriveEgress(style, operation),
    extra: Object.keys(extra).length > 0 ? extra : null,
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
