/** Dimension input for the upcoming builder/capture adapter. This module is
 * dormant: it does not save facts, authorize a reviewer or mark them verified.
 * Preserve the original measurement beside its normalized geometry. */
export type DimensionUnits = "in" | "ft" | "mm" | "cm";
export type DimensionSource = "measured" | "plans" | "estimated";
export interface DimensionInput {
  width: number;
  height: number;
  units: DimensionUnits;
  source: DimensionSource;
  sourceReference: string | null;
}
export interface NormalizedDimensions {
  original: Readonly<DimensionInput>;
  widthIn: number;
  heightIn: number;
  areaSqFt: number;
  estimated: boolean;
}

const FACTORS: Record<DimensionUnits, number> = { in: 1, ft: 12, mm: 1 / 25.4, cm: 1 / 2.54 };
const SOURCES = new Set<DimensionSource>(["measured", "plans", "estimated"]);
const KEYS = new Set(["width", "height", "units", "source", "sourceReference"]);

export class DimensionInputError extends Error {
  constructor(message: string) { super(message); this.name = "DimensionInputError"; }
}

/** Runtime validation is required for drafts recovered from disk as well as
 * form input. No coercion: zero, blank, numeric strings and guessed units fail. */
export function normalizeDimensions(raw: unknown): NormalizedDimensions {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(raw)))
    throw new DimensionInputError("Enter the unit's width, height, units and measurement source.");
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  if (Reflect.ownKeys(raw).some(key => typeof key !== "string" || !KEYS.has(key)) ||
      [...KEYS].some(key => !Object.hasOwn(descriptors, key) || !("value" in descriptors[key]) || !descriptors[key].enumerable))
    throw new DimensionInputError("The saved dimensions have an unsupported or missing field. Re-enter them.");
  const input = raw as DimensionInput;
  if (typeof input.width !== "number" || typeof input.height !== "number" ||
      !Number.isFinite(input.width) || !Number.isFinite(input.height) || input.width <= 0 || input.height <= 0)
    throw new DimensionInputError("Width and height must both be positive numbers.");
  if (typeof input.units !== "string" || !Object.hasOwn(FACTORS, input.units))
    throw new DimensionInputError("Choose inches, feet, millimeters or centimeters.");
  if (!SOURCES.has(input.source))
    throw new DimensionInputError("Choose measured, plans or estimated as the measurement source.");
  if (input.sourceReference !== null && (typeof input.sourceReference !== "string" ||
      input.sourceReference.length > 256 || input.sourceReference.trim().length === 0))
    throw new DimensionInputError("Use a short source reference, or leave it empty.");
  const widthIn = input.width * FACTORS[input.units];
  const heightIn = input.height * FACTORS[input.units];
  const areaSqFt = widthIn * heightIn / 144;
  if (![widthIn, heightIn, areaSqFt].every(value => Number.isFinite(value) && value > 0))
    throw new DimensionInputError("These dimensions cannot produce a valid area. Check the numbers and units.");
  // Freeze a fresh object; later caller edits cannot change the fact snapshot.
  const original = Object.freeze({ width: input.width, height: input.height, units: input.units,
    source: input.source, sourceReference: input.sourceReference });
  return { original, widthIn, heightIn, areaSqFt, estimated: input.source === "estimated" };
}
