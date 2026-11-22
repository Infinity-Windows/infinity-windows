import { parseFtIn } from "../modelstudio/dims";

export const MM_PER_INCH = 25.4;
export type DimensionMode = "imperial" | "metric";

export function inchFraction(sixteenths: number) {
  if (!sixteenths) return "";
  let numerator = sixteenths;
  let denominator = 16;
  while (numerator % 2 === 0) { numerator /= 2; denominator /= 2; }
  return `${numerator}/${denominator}`;
}

export function formatDimensionMm(mm: number | null | undefined, mode: DimensionMode) {
  if (mm == null || !Number.isFinite(mm) || mm < 0) return "";
  if (mode === "metric") return String(Number(mm.toFixed(2)));
  const ticks = Math.round(mm / MM_PER_INCH * 16 + 1e-9);
  const whole = Math.floor(ticks / 16);
  const fraction = inchFraction(ticks % 16);
  return `${Math.floor(whole / 12)}'${whole % 12}${fraction ? " " + fraction : ""}"`;
}

/** A length the way the drawings print it: whole inches and a fraction, no feet (109 1/2"). */
export function formatInchesMm(mm: number | null | undefined) {
  if (mm == null || !Number.isFinite(mm) || mm < 0) return "";
  const ticks = Math.round(mm / MM_PER_INCH * 16 + 1e-9);
  const fraction = inchFraction(ticks % 16);
  return `${Math.floor(ticks / 16)}${fraction ? " " + fraction : ""}"`;
}

export function readDimensionMm(raw: string, mode: DimensionMode) {
  const text = raw.trim();
  if (!text) return null;
  if (mode === "metric") {
    const number = /^(?:\d+(?:[.,]\d+)?|[.,]\d+)(?:\s*mm)?$/i.exec(text);
    const mm = number ? Number(text.replace(/\s*mm$/i, "").replace(",", ".")) : NaN;
    return Number.isFinite(mm) && mm > 0 ? mm : undefined;
  }
  const normalized = text.replace(/[‘’′]/g, "'").replace(/[“”″]/g, '"').replace(/'\s*-\s*/, "'");
  // A bare number in this field denotes inches. Feet always carry a prime.
  const entry = /^\d+(?:\.\d+)?$/.test(normalized) ? normalized + '"'
    : /^\d+\s*\/\s*\d+"?$/.test(normalized) ? "0 " + normalized : normalized;
  const cm = parseFtIn(entry);
  return cm !== null && cm > 0 && Number.isFinite(cm * 10) ? cm * 10 : undefined;
}
