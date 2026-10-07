import { cloneJson, iso, uuid, validate } from "../workConfiguration/model";

export class UnitObservationUnavailableError extends Error {
  constructor() { super("The current unit measurement is unavailable. Refresh before changing it."); this.name = "UnitObservationUnavailableError"; }
}
export type MeasurementUnit = "in" | "ft" | "mm" | "cm";
export type MeasurementSource = "measured" | "plans" | "estimated";
export interface DimensionObservation {
  width: number;
  height: number;
  unit: MeasurementUnit;
  source: MeasurementSource;
  sourceReference?: string | null;
}
type EventKind = "observation" | "legacy_observation" | "incomplete" | "cleared" | "relink";
export interface UnitFactSnapshot {
  unitId: string;
  revision: number;
  eventKind: EventKind | null;
  observation: (DimensionObservation & { estimated: boolean }) | null;
  widthIn: number | null;
  heightIn: number | null;
  observationActorId: string | null;
  recordedAt: string | null;
}
const fail = (): never => { throw new UnitObservationUnavailableError(); };
const inches = (value: number, unit: MeasurementUnit) => unit === "in" ? value : unit === "ft" ? value * 12 : value / (unit === "mm" ? 25.4 : 2.54);
function positive(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fail();
  return value;
}
function parseObservation(value: unknown): DimensionObservation {
  const o = validate.object(cloneJson(value), ["width", "height", "unit", "source"], ["sourceReference"]);
  const width = positive(o.width), height = positive(o.height);
  if (!["in", "ft", "mm", "cm"].includes(o.unit as string) || !["measured", "plans", "estimated"].includes(o.source as string)) return fail();
  const unit = o.unit as MeasurementUnit, source = o.source as MeasurementSource;
  for (const number of [inches(width, unit), inches(height, unit)]) if (!Number.isFinite(number) || number <= 0 || number > 100000) return fail();
  const result: DimensionObservation = { width, height, unit, source };
  if (Object.hasOwn(o, "sourceReference")) {
    if (o.sourceReference === null) result.sourceReference = null;
    else {
      if (typeof o.sourceReference !== "string") return fail();
      const reference = o.sourceReference.trim();
      const characters = Array.from(reference);
      if (characters.length < 1 || characters.length > 500 || reference.includes("\u0000") || characters.some(c => (c.codePointAt(0)! >= 0xd800 && c.codePointAt(0)! <= 0xdfff))) return fail();
      result.sourceReference = reference;
    }
  }
  return result;
}
/** Validated original values; inch conversion belongs to the server writer. */
export function dimensionObservation(value: unknown): DimensionObservation {
  try { return parseObservation(value); } catch { return fail(); }
}
export interface DimensionDraft { width: string; height: string; unit: MeasurementUnit; source: MeasurementSource | ""; reference: string }
export function observationFromDraft(draft: DimensionDraft): DimensionObservation {
  const decimal = /^(?:\d+(?:\.\d*)?|\.\d+)$/;
  if (!decimal.test(draft.width.trim()) || !decimal.test(draft.height.trim())) return fail();
  return dimensionObservation({ width: Number(draft.width), height: Number(draft.height), unit: draft.unit, source: draft.source, ...(draft.reference.trim() ? { sourceReference: draft.reference } : {}) });
}
function nullableDimension(value: unknown): number | null {
  if (value === null) return null;
  const number = positive(value);
  if (number > 100000) return fail();
  return number;
}
export function parseUnitFactSnapshot(value: unknown, expectedUnitId: string): UnitFactSnapshot {
  try {
    uuid(expectedUnitId);
    const copy = cloneJson(value);
    const base = validate.object(copy, ["protocolVersion", "unitId", "revision", "observation"], ["eventKind", "widthIn", "heightIn", "observationActorId", "recordedAt"]);
    if (base.protocolVersion !== 1 || uuid(base.unitId) !== expectedUnitId) return fail();
    const revision = validate.integer(base.revision, 0, Number.MAX_SAFE_INTEGER);
    if (revision === 0) {
      validate.object(copy, ["protocolVersion", "unitId", "revision", "observation"]);
      if (base.observation !== null) return fail();
      return { unitId: expectedUnitId, revision, eventKind: null, observation: null, widthIn: null, heightIn: null, observationActorId: null, recordedAt: null };
    }
    const o = validate.object(copy, ["protocolVersion", "unitId", "revision", "eventKind", "observation", "widthIn", "heightIn", "observationActorId", "recordedAt"]);
    if (!["observation", "legacy_observation", "incomplete", "cleared", "relink"].includes(o.eventKind as string)) return fail();
    const eventKind = o.eventKind as EventKind;
    const widthIn = nullableDimension(o.widthIn), heightIn = nullableDimension(o.heightIn);
    const observationActorId = o.observationActorId === null ? null : uuid(o.observationActorId);
    let observation: UnitFactSnapshot["observation"] = null;
    if (o.observation !== null) {
      const raw = validate.object(o.observation, ["width", "height", "unit", "source", "sourceReference", "estimated"]);
      const original = parseObservation({ width: raw.width, height: raw.height, unit: raw.unit, source: raw.source, sourceReference: raw.sourceReference });
      if (raw.estimated !== (original.source === "estimated") || observationActorId === null || widthIn === null || heightIn === null) return fail();
      for (const [actual, calculated] of [[widthIn, inches(original.width, original.unit)], [heightIn, inches(original.height, original.unit)]]) {
        if (Math.abs(actual - calculated) > Math.max(actual, calculated) * 1e-12) return fail();
      }
      observation = { ...original, estimated: raw.estimated as boolean };
    } else if (observationActorId !== null) return fail();
    if ((eventKind === "observation" && observation === null) || (["legacy_observation", "incomplete", "cleared"].includes(eventKind) && observation !== null)) return fail();
    if (eventKind === "cleared" && (widthIn !== null || heightIn !== null)) return fail();
    if (eventKind === "legacy_observation" && (widthIn === null || heightIn === null)) return fail();
    if (eventKind === "incomplete" && widthIn !== null && heightIn !== null) return fail();
    return { unitId: expectedUnitId, revision, eventKind, observation, widthIn, heightIn, observationActorId, recordedAt: iso(o.recordedAt) };
  } catch { return fail(); }
}
