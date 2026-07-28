// Cross-check a decoded manufacturer call size against the dimensions PRINTED
// on the shop drawing.
//
// `decodeSizeCode` reads a 4-digit call size as feet+inches ("3060" → 36" × 72"),
// which is right for STRATA / PV Townhomes but is NOT a universal convention. A
// supplier using INCH-based codes prints "3672" meaning 36" × 72"; decoded as
// feet+inches that becomes 42" × 86" — a wrong size on an installer's sheet with
// nothing on screen to say so. Wrong dimensions are expensive.
//
// These shop drawings save us: they print the real dimension beside each
// elevation, in millimetres with the inch equivalent in parentheses —
// `901(35 1/2")`, `1816(71 1/2")`, `2425(95 1/2")`. So we transcribe those too,
// convert them to inches here, and compare. When the two disagree beyond
// tolerance the PRINTED dimension wins and the mark is flagged for a foreman.
//
// Everything here is PURE — no DOM, no network — and never throws: anything
// unparseable returns null so a garbled transcription degrades to today's
// behaviour rather than breaking the extraction.

import { decodeSizeCode } from "./specs";

/** Millimetres per inch — the printed dimensions lead with a mm figure. */
const MM_PER_INCH = 25.4;

/**
 * Nothing on a window/door shop drawing is 50 feet across. A "dimension" past
 * this is a mis-transcription (a part number, a page number, a run-on of two
 * figures), and letting it through would be worse than admitting we can't read
 * it — it could override a perfectly good decoded size.
 */
const MAX_PLAUSIBLE_INCHES = 600;

/**
 * A bare number with no units is only read as millimetres when it's big enough
 * to BE one. Under 100mm (4") it is far likelier an inch figure that lost its
 * mark — and reading "36" as 1.4" would replace a real window with a matchbox
 * and, worse, look like a size-code disagreement while doing it. Below the
 * floor we admit we can't tell, which leaves the decoded size alone.
 */
const MIN_PLAUSIBLE_MM = 100;

/**
 * Denominators we accept when the PDF text layer has dropped the slash out of a
 * fraction (see {@link parseInchesNumber}). Restricting to the fractions a tape
 * measure actually has stops "3 1 2" style noise from being read as a fraction
 * wherever three plain numbers happen to sit together.
 */
const TAPE_DENOMINATORS = new Set([2, 4, 8, 16, 32]);

/** Unicode vulgar fractions a sheet may use instead of "1/2". */
const UNICODE_FRACTIONS: Record<string, string> = {
  "½": " 1/2",
  "¼": " 1/4",
  "¾": " 3/4",
  "⅛": " 1/8",
  "⅜": " 3/8",
  "⅝": " 5/8",
  "⅞": " 7/8",
  "⅓": " 1/3",
  "⅔": " 2/3",
};

/** Round to hundredths so 901mm reads as 35.47", not 35.47244094488189. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Round only far enough to kill floating-point noise. Tape-measure fractions go
 * down to 32nds (0.03125), so hundredths would quietly turn a 3/8" into 0.38".
 */
function roundInches(n: number): number {
  return Math.round(n * 100000) / 100000;
}

/**
 * Collapse a raw transcription into one predictable line: unicode fractions
 * expanded, curly quotes/primes flattened to `"` and `'`, and every run of
 * whitespace (the PDF text layer loves to split a dimension across lines)
 * reduced to a single space.
 */
function normalize(raw: string): string {
  let s = raw;
  for (const [glyph, ascii] of Object.entries(UNICODE_FRACTIONS)) {
    s = s.split(glyph).join(ascii);
  }
  return s
    .replace(/[\u2032\u2018\u2019]/g, "'")
    .replace(/[\u2033\u201C\u201D]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Parse the numeric part of an inch measurement (the units have already been
 * stripped): `71`, `95.5`, `35 1/2`, `1/2`, and the slash-less `35 1 2` the PDF
 * text layer produces when it breaks a fraction across lines. Null when it
 * isn't a number we recognise.
 */
function parseInchesNumber(text: string): number | null {
  const s = text.trim();
  if (!s) return null;

  const mixed = s.match(/^(\d+(?:\.\d+)?)\s+(\d+)\s*\/\s*(\d+)$/);
  if (mixed) {
    const denom = Number(mixed[3]);
    if (denom <= 0) return null;
    return Number(mixed[1]) + Number(mixed[2]) / denom;
  }

  const fraction = s.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (fraction) {
    const denom = Number(fraction[2]);
    if (denom <= 0) return null;
    return Number(fraction[1]) / denom;
  }

  // "35 1 2" — a fraction whose slash the text layer swallowed. Only read it as
  // one when the pieces look like a real tape-measure fraction (1/2, 3/8, …).
  const slashless = s.match(/^(\d+)\s+(\d+)\s+(\d+)$/);
  if (slashless) {
    const numer = Number(slashless[2]);
    const denom = Number(slashless[3]);
    if (TAPE_DENOMINATORS.has(denom) && numer < denom) {
      return Number(slashless[1]) + numer / denom;
    }
    return null;
  }

  const plain = s.match(/^(\d+(?:\.\d+)?)$/);
  return plain ? Number(plain[1]) : null;
}

/**
 * Parse a measurement that carries its own units — feet-and-inches (`3'0"`,
 * `2'8 1/2"`, `3'`) or inches (`71"`, `35 1/2"`). Returns null when there are no
 * units to go on; the caller decides whether a bare number means millimetres.
 */
function parseUnitedMeasurement(text: string): number | null {
  const s = text.trim();
  if (!s) return null;

  const feet = s.match(/^(\d+(?:\.\d+)?)\s*'\s*(.*)$/);
  if (feet) {
    const rest = feet[2].replace(/"\s*$/, "").trim();
    const inches = rest ? parseInchesNumber(rest) : 0;
    if (inches == null) return null;
    return Number(feet[1]) * 12 + inches;
  }

  if (/"\s*$/.test(s)) {
    return parseInchesNumber(s.replace(/"\s*$/, ""));
  }

  const inchWord = s.match(/^(.*?)\s*(?:in|inch|inches)$/i);
  if (inchWord) return parseInchesNumber(inchWord[1]);

  return null;
}

/**
 * A bare number (optionally suffixed "mm") read as millimetres. The conversion
 * is an approximation of a figure the manufacturer would have printed to the
 * nearest fraction anyway, so hundredths of an inch is all the precision it
 * deserves: 901mm → 35.47".
 */
function parseMillimetres(text: string): number | null {
  const bare = text.trim().match(/^(\d+(?:\.\d+)?)$/);
  const suffixed = text.trim().match(/^(\d+(?:\.\d+)?)\s*mm$/i);
  const n = Number((suffixed ?? bare)?.[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  // An explicit "mm" is the sheet telling us; a bare number has to earn it.
  if (!suffixed && n < MIN_PLAUSIBLE_MM) return null;
  return round2(n / MM_PER_INCH);
}

/** Guard a candidate against nonsense before we let it override a size code. */
function plausible(inches: number | null): number | null {
  if (inches == null || !Number.isFinite(inches)) return null;
  if (inches <= 0 || inches > MAX_PLAUSIBLE_INCHES) return null;
  return roundInches(inches);
}

/**
 * Convert a dimension as PRINTED on a shop drawing into INCHES.
 *
 * The sheets lead with millimetres and put the inch equivalent in parentheses,
 * so the parenthesised figure is preferred when it's readable — it's the
 * manufacturer's own conversion, already rounded to the fraction they build to:
 *   `901(35 1/2")`  → 35.5
 *   `1816(71 1/2")` → 71.5
 *   `1802(71")`     → 71
 * Falling back, in order: the string as a united measurement (`35 1/2"`, `3'0"`,
 * `72"`), then a bare number read as millimetres (`901` → 35.47).
 *
 * Never throws — junk returns null.
 */
export function parsePrintedInches(raw: unknown): number | null {
  if (raw == null) return null;
  const s = normalize(String(raw));
  if (!s) return null;

  // The parenthesised inch equivalent, when the sheet gives one.
  for (const group of s.matchAll(/\(([^)]*)\)/g)) {
    const inches = plausible(parseUnitedMeasurement(group[1]));
    if (inches != null) return inches;
  }

  const united = plausible(parseUnitedMeasurement(s));
  if (united != null) return united;

  const millimetres = plausible(parseMillimetres(s));
  if (millimetres != null) return millimetres;

  // "1816(garbled)" — an unreadable parenthetical must not cost us the mm
  // figure printed right next to it.
  const withoutParens = s.replace(/\([^)]*\)/g, " ").trim();
  if (withoutParens && withoutParens !== s) {
    return (
      plausible(parseUnitedMeasurement(withoutParens)) ??
      plausible(parseMillimetres(withoutParens))
    );
  }

  return null;
}

/**
 * How much a decoded size may differ from the printed one and still be the same
 * window.
 *
 * A call size is NOMINAL: it names the rough opening, deliberately a little
 * bigger than the frame the drawing dimensions ("3060" = 36" nominal against a
 * printed 901mm = 35.5" actual, half an inch of slack). Tolerance has to swallow
 * that. What it must still catch is a decoding-convention error, which is never
 * subtle: read "3672" as feet+inches and you get 42" × 86" instead of 36" × 72",
 * six and fourteen inches out.
 *
 * Two inches sits comfortably in that gap — several times the usual nominal
 * slack, a fraction of any convention error.
 */
export const SIZE_TOLERANCE_IN = 2;

/**
 * …except on big units, where nominal slack scales: an 8-foot slider can carry
 * more than 2" of it. Above 40" the tolerance becomes 5% of the printed
 * dimension (96" → 4.8"), still far under the 12"+ a mis-read 6080 would show.
 */
export const SIZE_TOLERANCE_FRACTION = 0.05;

/**
 * Tolerance for one axis: the flat inch allowance or the fraction of the
 * printed dimension, whichever is larger. Both are parameters so a caller can
 * tighten the check (pass `0` as the fraction to use the flat inches alone).
 */
export function sizeToleranceFor(
  printedInches: number,
  tolerance: number = SIZE_TOLERANCE_IN,
  fraction: number = SIZE_TOLERANCE_FRACTION,
): number {
  return Math.max(tolerance, Math.abs(printedInches) * fraction);
}

export interface SizeComparisonInput {
  decodedWidthIn: number | null;
  decodedHeightIn: number | null;
  printedWidthIn: number | null;
  printedHeightIn: number | null;
}

export interface SizeComparison {
  /**
   * `match`    — every axis we could compare agrees within tolerance.
   * `mismatch` — at least one axis is out by more than tolerance.
   * `unknown`  — nothing comparable (no decode, or no printed dimensions).
   */
  status: "match" | "mismatch" | "unknown";
  /** decoded − printed, in inches. Null when that axis isn't comparable. */
  deltaWidthIn: number | null;
  deltaHeightIn: number | null;
}

/**
 * Compare a decoded call size against the dimensions printed on the drawing.
 * Each axis is judged on its own and only when BOTH numbers exist, so a sheet
 * that printed only the height still gets its height checked. PURE.
 */
export function compareSizes(
  input: SizeComparisonInput,
  tolerance: number = SIZE_TOLERANCE_IN,
  fraction: number = SIZE_TOLERANCE_FRACTION,
): SizeComparison {
  const axis = (decoded: number | null, printed: number | null) => {
    if (decoded == null || printed == null) return null;
    if (!Number.isFinite(decoded) || !Number.isFinite(printed)) return null;
    return round2(decoded - printed);
  };

  const deltaWidthIn = axis(input.decodedWidthIn, input.printedWidthIn);
  const deltaHeightIn = axis(input.decodedHeightIn, input.printedHeightIn);
  if (deltaWidthIn == null && deltaHeightIn == null) {
    return { status: "unknown", deltaWidthIn: null, deltaHeightIn: null };
  }

  const out = (delta: number | null, printed: number | null) =>
    delta != null &&
    printed != null &&
    Math.abs(delta) > sizeToleranceFor(printed, tolerance, fraction);

  const mismatch =
    out(deltaWidthIn, input.printedWidthIn) ||
    out(deltaHeightIn, input.printedHeightIn);

  return {
    status: mismatch ? "mismatch" : "match",
    deltaWidthIn,
    deltaHeightIn,
  };
}

export interface ResolvedSize {
  widthIn: number | null;
  heightIn: number | null;
  /** Which numbers `widthIn`/`heightIn` came from. */
  from: "decoded" | "printed" | "none";
  comparison: SizeComparison;
}

/**
 * Decide which dimensions a mark should actually carry.
 *
 * PRECEDENCE — the point of this whole module:
 *   • They disagree beyond tolerance → the PRINTED dimensions win. They are
 *     literally drawn on the sheet the installer is holding; the decode is an
 *     assumption about a convention this supplier may not use.
 *   • They agree → keep the DECODED (nominal) size. It's what the call size
 *     names, what the order and the rough opening are written in, and what the
 *     crew says out loud; swapping in 35.5" for 36" would be noise.
 *   • Only one side exists → use it.
 * PURE.
 */
export function resolveSpecSize(input: SizeComparisonInput): ResolvedSize {
  const comparison = compareSizes(input);
  const hasDecoded =
    input.decodedWidthIn != null || input.decodedHeightIn != null;
  const hasPrinted =
    input.printedWidthIn != null || input.printedHeightIn != null;

  if (comparison.status === "mismatch" || (!hasDecoded && hasPrinted)) {
    return {
      widthIn: input.printedWidthIn ?? input.decodedWidthIn,
      heightIn: input.printedHeightIn ?? input.decodedHeightIn,
      from: "printed",
      comparison,
    };
  }
  if (hasDecoded) {
    return {
      widthIn: input.decodedWidthIn,
      heightIn: input.decodedHeightIn,
      from: "decoded",
      comparison,
    };
  }
  return { widthIn: null, heightIn: null, from: "none", comparison };
}

/**
 * The `extra.size_mismatch` record kept on a flagged spec: what the code
 * decoded to, what the sheet printed, and how far apart they were. Stored so
 * the disagreement is auditable long after the extraction, and rebuilt whenever
 * the size code changes so it can never describe an old code. Null when the two
 * agree (or there's nothing to compare). PURE.
 */
export function sizeMismatchRecord(
  sizeCode: string | null | undefined,
  printedWidthIn: number | null,
  printedHeightIn: number | null,
): Record<string, unknown> | null {
  const decoded = decodeSizeCode(sizeCode);
  if (!decoded) return null;
  const comparison = compareSizes({
    decodedWidthIn: decoded.widthIn,
    decodedHeightIn: decoded.heightIn,
    printedWidthIn,
    printedHeightIn,
  });
  if (comparison.status !== "mismatch") return null;
  return {
    size_code: String(sizeCode).trim(),
    decoded_width_in: decoded.widthIn,
    decoded_height_in: decoded.heightIn,
    printed_width_in: printedWidthIn,
    printed_height_in: printedHeightIn,
    delta_width_in: comparison.deltaWidthIn,
    delta_height_in: comparison.deltaHeightIn,
  };
}

/**
 * The `extra` keys this module owns. They're bookkeeping for the size check,
 * not line-item attributes, so screens that dump `extra` for a human skip them.
 */
export const PRINTED_SIZE_EXTRA_KEYS: readonly string[] = [
  "printed_width",
  "printed_height",
  "printed_width_in",
  "printed_height_in",
  "size_mismatch",
];

/** The printed dimensions as stashed in a spec row's `extra` jsonb. */
export interface PrintedSize {
  /** Verbatim transcription, e.g. `901(35 1/2")`. */
  widthRaw: string | null;
  heightRaw: string | null;
  /** Parsed inches, or null when it couldn't be read. */
  widthIn: number | null;
  heightIn: number | null;
}

function textOrNull(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
}

function finiteOrNull(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Read the printed dimensions back out of a spec's `extra` jsonb. Defensive:
 * `extra` is free-form, may be a legacy row with nothing in it, and the stored
 * inch values are re-derived from the verbatim strings when absent. PURE.
 */
export function readPrintedSize(extra: unknown): PrintedSize {
  const empty: PrintedSize = {
    widthRaw: null,
    heightRaw: null,
    widthIn: null,
    heightIn: null,
  };
  if (!extra || typeof extra !== "object" || Array.isArray(extra)) return empty;
  const o = extra as Record<string, unknown>;
  const widthRaw = textOrNull(o.printed_width);
  const heightRaw = textOrNull(o.printed_height);
  return {
    widthRaw,
    heightRaw,
    widthIn: finiteOrNull(o.printed_width_in) ?? parsePrintedInches(widthRaw),
    heightIn: finiteOrNull(o.printed_height_in) ?? parsePrintedInches(heightRaw),
  };
}

/** The little a size check needs to know about a spec row. */
export interface SizeCheckSpec {
  mark_code: string;
  size_code?: string | null;
  extra?: unknown;
}

export interface SizeMismatch {
  mark: string;
  sizeCode: string;
  decodedWidthIn: number;
  decodedHeightIn: number;
  printedWidthIn: number | null;
  printedHeightIn: number | null;
  /** One plain-English line a non-technical foreman can act on. */
  message: string;
}

/**
 * Re-check one spec row's call size against its printed dimensions.
 *
 * Deliberately RECOMPUTED from `size_code` + the printed values rather than
 * trusting the `extra.size_mismatch` written at extraction time: a foreman can
 * edit the size code in review, and the warning has to follow the edit.
 * Returns null when there's nothing to warn about. PURE.
 */
export function checkSpecSize(spec: SizeCheckSpec): SizeMismatch | null {
  const sizeCode = textOrNull(spec?.size_code);
  const decoded = decodeSizeCode(sizeCode);
  if (!decoded || !sizeCode) return null;

  const printed = readPrintedSize(spec?.extra);
  const comparison = compareSizes({
    decodedWidthIn: decoded.widthIn,
    decodedHeightIn: decoded.heightIn,
    printedWidthIn: printed.widthIn,
    printedHeightIn: printed.heightIn,
  });
  if (comparison.status !== "mismatch") return null;

  const mark = String(spec.mark_code ?? "").trim();
  return {
    mark,
    sizeCode,
    decodedWidthIn: decoded.widthIn,
    decodedHeightIn: decoded.heightIn,
    printedWidthIn: printed.widthIn,
    printedHeightIn: printed.heightIn,
    message:
      `Mark ${mark}: code ${sizeCode} decodes to ` +
      `${describeInches(decoded.widthIn)} x ${describeInches(decoded.heightIn)} ` +
      `but the sheet prints ${describeInches(printed.widthIn)} x ` +
      `${describeInches(printed.heightIn)} — check the size convention.`,
  };
}

/** Short inch form for a message — `36"`, `35.5"`. Unknown reads as `?`. */
function describeInches(inches: number | null): string {
  if (inches == null) return "?";
  return `${round2(inches)}"`;
}

/**
 * Every mark whose call size disagrees with its printed dimensions, in mark
 * order. Empty when everything checks out — the review screen stays quiet. PURE.
 */
export function listSizeMismatches(specs: SizeCheckSpec[]): SizeMismatch[] {
  return (specs ?? [])
    .map((s) => (s ? checkSpecSize(s) : null))
    .filter((m): m is SizeMismatch => m !== null)
    .sort((a, b) =>
      a.mark.localeCompare(b.mark, undefined, { numeric: true, sensitivity: "base" }),
    );
}
