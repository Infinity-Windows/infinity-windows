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
  return mergeSpecsByMark(raws.map(prepVisionSpec), "ai");
}
