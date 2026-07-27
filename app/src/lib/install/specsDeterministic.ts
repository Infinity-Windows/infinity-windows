// Deterministic (no-network, no-AI) per-mark spec extraction for STRATA-style
// shop-drawing plansets.
//
// Some manufacturer shop drawings (e.g. the STRATA Windows & Doors sheets for
// the PV Townhomes job) have a text layer that is sparse and scrambled — the
// AI extractor (`extract-specs`) returns 0 confident marks on them. But a few
// things ARE reliably present as literal tokens and can be pulled out with
// deterministic rules:
//
//   • Size codes:      3060, 6080, 8080, 6060, 3070, 5070, 6020, …
//   • Operation tokens: XO / OX (horizontal sliders), F / Fixed, FROSTED
//   • Egress:           "Egress Hinges" → an egress-hinged (casement) unit
//   • Hardware notes:   "Both side straight handle (Black)", locks, 3-track door
//   • Dimensions:       901(35 1 2") → 901 mm = 35½" (the fraction is split by
//                       the PDF text extractor across whitespace/newlines)
//
// The rich descriptors (glass makeup, color, U-factor/SHGC, thermal-break
// style) are NOT in this file's text, so we deliberately leave those blank —
// never invent them. Because the scrambled text makes the mark↔unit
// association unreliable, every row is emitted as an unconfirmed draft
// (source 'deterministic') so the existing foreman review/confirm flow still
// applies. Nothing here touches the network or the DB.

import { decodeSizeCode, mergeSpecsByMark, type MarkSpecDraft } from "./specs";

export interface PlanPageText {
  pageNumber: number;
  text: string;
}

/**
 * A 4-digit manufacturer call size optionally followed (on the same line) by an
 * operation/glass token. The negative lookahead `(?![(-])` rejects:
 *   • millimetre dimensions like `1816(71 1 2")` — always followed by "("
 *   • dates like `2024-12-22` — the year is followed by "-"
 * while still splitting concatenated codes such as `30703060` → 3070 + 3060
 * and `6080 OX3060` → (6080, OX) + 3060 (the digit-after-digit case is allowed
 * on purpose so glued codes are recovered).
 */
const UNIT_RE = /(\d{4})(?![(\-])[ \t]*(XO|OX|FROSTED|FIXED|F)?/gi;

const EGRESS_RE = /egress\s+hinges/i;
const HANDLE_RE = /both\s+side\s+straight\s+handle[^\n]*/i;
const LOCK_RE = /lock\s+interior\s+and\s+with\s+key\s+exterior/i;
const TRACK_RE = /(\d+)\s*track/i;

export interface OperationInfo {
  /** Normalized operation string for the `operation` field, or null. */
  operation: string | null;
  /** The unit's glass is frosted (obscure) — a glass note, not a makeup. */
  frosted: boolean;
}

/**
 * Interpret an operation/glass token that trails a size code.
 *   XO / OX → horizontal slider (the token itself preserves which side
 *             operates: X = operable leaf, O = fixed leaf, read left→right).
 *   F / Fixed → a fixed (non-operable) lite.
 *   FROSTED  → frosted/obscure glass (a glass note); operation is left null.
 */
export function interpretOperation(token: string | null | undefined): OperationInfo {
  const t = (token ?? "").trim().toUpperCase();
  if (t === "XO" || t === "OX") return { operation: t, frosted: false };
  if (t === "F" || t === "FIXED") return { operation: "Fixed", frosted: false };
  if (t === "FROSTED") return { operation: null, frosted: true };
  return { operation: null, frosted: false };
}

/**
 * Parse a split-fraction dimension into inches. Manufacturer shop drawings list
 * a millimetre value and the inch equivalent in parentheses, and the PDF text
 * extractor scrambles the fraction across whitespace/newlines:
 *
 *   "35 1 2"   → 35 + 1/2  = 35.5
 *   "35 3 4"   → 35 + 3/4  = 35.75
 *   "71"       → 71
 *   "95 1 2"   → 95.5
 *
 * Accepts either a bare inch string (`35 1 2`) or the full parenthesised form
 * (`(35 1 2")`). Returns null when there's no leading whole-inch number.
 * PURE — no side effects.
 */
export function parseSplitFractionInches(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  // Keep only digits and whitespace so `(35 1 2")`, `35 1 2"`, and a
  // newline-split `35\n1\n2` all reduce to the same token stream.
  const cleaned = String(raw).replace(/[^\d\s]/g, " ").trim();
  if (!cleaned) return null;
  const parts = cleaned.split(/\s+/).map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return null;

  const [whole, numerator, denominator] = parts;
  if (whole == null) return null;
  if (numerator != null && denominator != null && denominator !== 0) {
    return whole + numerator / denominator;
  }
  return whole;
}

/**
 * Collect every parenthesised inch dimension on a page, in document order.
 * Handles the newline-split fraction because `\s` matches newlines. These are
 * surfaced for validation/review only — the scrambled layout makes tying a
 * specific millimetre reading to a specific size code unreliable, so we do NOT
 * force them onto individual specs (the size-code decode is the dim source).
 */
export function collectDimensionsInInches(text: string): number[] {
  const re = /\(\s*(\d+)(?:\s+(\d+)\s+(\d+))?\s*"\s*\)/g;
  const out: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const value = parseSplitFractionInches(
      m[2] != null ? `${m[1]} ${m[2]} ${m[3]}` : m[1],
    );
    if (value != null) out.push(value);
  }
  return out;
}

/** A raw (pre-normalization) deterministic spec keyed by a synthetic mark. */
interface RawDeterministicSpec {
  mark_code: string;
  size_code: string;
  width_in: number | null;
  height_in: number | null;
  operation: string | null;
  tempered: boolean | null;
  egress: boolean | null;
  extra: Record<string, unknown> | null;
  source: "deterministic";
}

/** Everything we can read off a single scrambled shop-drawing page. */
function parsePage(page: PlanPageText): RawDeterministicSpec[] {
  const text = page.text ?? "";
  const hasEgress = EGRESS_RE.test(text);

  const handle = text.match(HANDLE_RE)?.[0]?.trim() ?? null;
  const hasLock = LOCK_RE.test(text);
  const trackMatch = text.match(TRACK_RE);
  const track = trackMatch ? `${trackMatch[1]}-track sliding door` : null;

  const specs: RawDeterministicSpec[] = [];
  UNIT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = UNIT_RE.exec(text)) !== null) {
    const code = m[1];
    const { operation, frosted } = interpretOperation(m[2]);
    const decoded = decodeSizeCode(code);
    const isSlider = operation === "XO" || operation === "OX";

    // Frosted marks come from a directly-attached FROSTED token; a page-level
    // "Frosted glass" note alone is not tied to a code (kept off individual
    // rows to avoid inventing which lite is obscure).
    const isFrosted = frosted;

    // Egress hinges belong to a hinged (casement) unit — never to a horizontal
    // slider or a frosted fixed lite. It's a page-level fact, so it lands on the
    // non-slider candidates as an unconfirmed flag for the foreman to prune.
    const egress = hasEgress && !isSlider && !isFrosted ? true : null;

    const extra: Record<string, unknown> = {};
    if (isFrosted) extra.glass_note = "Frosted glass";
    if (egress) {
      extra.egress_note = "Egress hinges noted on sheet — confirm which unit";
    }
    if (isSlider) {
      if (handle) extra.handle = handle;
      if (hasLock) extra.lock = "Lock interior, key exterior";
      if (track) extra.track = track;
    }

    // Distinguish mirror/operation variants (6080 OX vs 6080 XO) and the frosted
    // variant so the merge keeps them apart rather than collapsing them.
    const suffix = operation ?? (isFrosted ? "Frosted" : null);
    const mark_code = suffix ? `${code} ${suffix}` : code;

    specs.push({
      mark_code,
      size_code: code,
      width_in: decoded?.widthIn ?? null,
      height_in: decoded?.heightIn ?? null,
      operation,
      tempered: isFrosted ? true : null,
      egress,
      extra: Object.keys(extra).length > 0 ? extra : null,
      source: "deterministic",
    });
  }

  return specs;
}

/**
 * Extract partial per-mark specs deterministically from planset page text.
 *
 * Returns normalized {@link MarkSpecDraft}s (via {@link mergeSpecsByMark}) that
 * are compatible with the AI extractor's output and the persisted
 * `project_mark_specs` shape: size_code, decoded width/height, operation,
 * tempered/frosted flag, egress flag, and hardware notes in `extra`. Glass
 * makeup, color, and energy numbers are intentionally left blank — they are not
 * present in this class of shop drawing and must never be invented. Every row
 * is `source: 'deterministic'` and unconfirmed, so the foreman review/confirm
 * step is retained. PURE — no network, no DB.
 */
export function extractSpecsDeterministic(
  pages: PlanPageText[],
): MarkSpecDraft[] {
  const raws = pages.flatMap(parsePage);
  return mergeSpecsByMark(raws, "deterministic");
}
