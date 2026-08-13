// Dimension parsing/formatting the way the trade writes them. Shop drawings
// print inches with vulgar fractions — window 16's panels read 30¼", 88½",
// 90", 87¾", 17" — and the office types feet-inches (28'6"). Pure so the
// grammar is unit-tested; the Studio page and the unit builder share it.

/** Vulgar fraction glyphs the way shop drawings print them (30¼", 88½"). */
const VULGAR: Record<string, string> = {
  "⅛": " 1/8", "¼": " 1/4", "⅜": " 3/8", "½": " 1/2",
  "⅝": " 5/8", "¾": " 3/4", "⅞": " 7/8",
};

/** `30 1/4` → 30.25; plain and decimal numbers pass through. */
function mixedNumber(s: string): number {
  const m = s.trim().match(/^(\d+(?:\.\d+)?)(?:\s+(\d+)\s*\/\s*(\d+))?$/);
  if (!m) return NaN;
  const whole = parseFloat(m[1]);
  const frac = m[2] ? parseInt(m[2], 10) / parseInt(m[3], 10) : 0;
  return whole + frac;
}

/**
 * Parse a typed dimension to CENTIMETRES, or null when it isn't one.
 *
 *   28'6"  28' 6 1/2"  → feet-inches (fraction rides on the inches)
 *   30 1/4"  313½"     → inches
 *   28.5               → bare number = feet (28'6")
 *   30 1/4             → bare MIXED number = inches — nobody writes a
 *                        fractional foot that way, the drawing does.
 */
export function parseFtIn(raw: string): number | null {
  let t = raw.trim().replace(/[""]/g, '"').replace(/['']/g, "'");
  for (const [glyph, ascii] of Object.entries(VULGAR)) t = t.split(glyph).join(ascii);
  t = t.replace(/\s+/g, " ").trim();
  if (!t) return null;
  const NUM = String.raw`\d+(?:\.\d+)?(?:\s+\d+\s*/\s*\d+)?`;
  let m = t.match(new RegExp(`^(${NUM})\\s*'\\s*(?:(${NUM})\\s*"?)?$`));
  if (m) {
    const v = (mixedNumber(m[1]) * 12 + (m[2] ? mixedNumber(m[2]) : 0)) * 2.54;
    return Number.isFinite(v) ? v : null;
  }
  m = t.match(new RegExp(`^(${NUM})\\s*"$`));
  if (m) {
    const v = mixedNumber(m[1]) * 2.54;
    return Number.isFinite(v) ? v : null;
  }
  m = t.match(/^(\d+(?:\.\d+)?)$/);
  if (m) return parseFloat(m[1]) * 12 * 2.54; // bare number = feet
  m = t.match(new RegExp(`^(${NUM})$`));
  if (m) {
    const v = mixedNumber(m[1]) * 2.54;
    return Number.isFinite(v) ? v : null;
  }
  return null;
}

/** Centimetres → `28'6"` for display next to inputs. */
export function fmtFtIn(cm: number): string {
  const totalIn = cm / 2.54;
  const ft = Math.floor(totalIn / 12);
  const inch = Math.round(totalIn - ft * 12);
  if (inch === 12) return `${ft + 1}'0"`;
  return `${ft}'${inch}"`;
}

const EIGHTH_GLYPHS = ["", "⅛", "¼", "⅜", "½", "⅝", "¾", "⅞"] as const;

/** Millimetres → the drawing's inch style: 768 mm → `30¼"`. */
export function fmtInchesFromMm(mm: number): string {
  const totalIn = mm / 25.4;
  const eighths = Math.round(totalIn * 8);
  const whole = Math.floor(eighths / 8);
  return `${whole}${EIGHTH_GLYPHS[eighths - whole * 8]}"`;
}
