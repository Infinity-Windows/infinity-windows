import { durationMicros } from "../workActivityTotals/format";

/** Presentation-domain limits, not a settled server protocol or permission proof. */
export const MAX_CONTRIBUTION_PEOPLE = 500;
export const MAX_CONTRIBUTION_AMOUNT_DIGITS = 40;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const AMOUNT = /^(?:0|[1-9][0-9]{0,39})$/;

export interface ContributionPerson {
  readonly profileId: string;
  readonly knownMicros: string;
  readonly complete: boolean;
}
export interface ContributionInput {
  readonly unitKnownMicros: string;
  readonly unitComplete: boolean;
  readonly people: readonly ContributionPerson[];
}
export interface ContributionDisplayPerson extends ContributionPerson {
  readonly duration: string;
  /** Null is unavailable; 0.00% is a proven zero in a complete positive scope. */
  readonly percentage: string | null;
}
export type ContributionDisplay = { state: "held"; reason: "invalid_input" }
  | {
    state: "available";
    unitKnownMicros: string;
    unitComplete: boolean;
    duration: string;
    people: ContributionDisplayPerson[];
    percentages: "available" | "partial" | "zero_total";
    roundingPolicy: "largest_remainder_uuid_tiebreak";
  };

// Avoid inherited values/getters, extra fields and prototype-key surprises in
// the small domain adapter. A future wire parser still owns actual authorization.
function record(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== keys.length
    || keys.some(key => !Object.hasOwn(descriptors, key)
      || !Object.hasOwn(descriptors[key], "value") || !descriptors[key].enumerable)) return null;
  return value as Record<string, unknown>;
}
function amount(value: unknown): value is string {
  // JavaScript's $ can also match before a final newline; require the whole match.
  return typeof value === "string" && value.length <= MAX_CONTRIBUTION_AMOUNT_DIGITS && AMOUNT.exec(value)?.[0] === value;
}
function list(value: unknown): unknown[] | null {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || value.length > MAX_CONTRIBUTION_PEOPLE) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value), rows: unknown[] = [];
  if (Reflect.ownKeys(descriptors).length !== value.length + 1) return null;
  for (let index = 0; index < value.length; index++) {
    const descriptor = descriptors[index];
    if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) return null;
    rows.push(descriptor.value);
  }
  return rows;
}

/** A single coherent, already-authorized unit snapshot must supply every row.
 * Exact sums precede display; neither partial time nor a visible subset becomes
 * a complete denominator. There are no clocks, names, transport or UI effects. */
export function formatUnitContributions(input: unknown): ContributionDisplay {
  const held: ContributionDisplay = { state: "held", reason: "invalid_input" };
  try {
    const unit = record(input, ["unitKnownMicros", "unitComplete", "people"]);
    if (!unit || !amount(unit.unitKnownMicros) || typeof unit.unitComplete !== "boolean") return held;
    const rows = list(unit.people);
    if (!rows) return held;
    const denominator = BigInt(unit.unitKnownMicros), seen = new Set<string>();
    const people: ContributionDisplayPerson[] = [];
    let sum = 0n;
    for (const raw of rows) {
      const person = record(raw, ["profileId", "knownMicros", "complete"]);
      if (!person || typeof person.profileId !== "string" || UUID.exec(person.profileId)?.[0] !== person.profileId
        || seen.has(person.profileId) || !amount(person.knownMicros)
        || typeof person.complete !== "boolean") return held;
      seen.add(person.profileId); sum += BigInt(person.knownMicros);
      people.push({ profileId: person.profileId, knownMicros: person.knownMicros,
        complete: person.complete, duration: durationMicros(person.knownMicros), percentage: null });
    }
    if (sum !== denominator) return held;
    const result: Extract<ContributionDisplay, { state: "available" }> = {
      state: "available", unitKnownMicros: unit.unitKnownMicros, unitComplete: unit.unitComplete,
      duration: durationMicros(unit.unitKnownMicros), people,
      percentages: !unit.unitComplete || people.some(person => !person.complete) ? "partial"
        : denominator === 0n ? "zero_total" : "available",
      roundingPolicy: "largest_remainder_uuid_tiebreak"
    };
    if (result.percentages !== "available") return result;

    // Allocate the display's last hundredth-percent by exact remainder, never by
    // rounded hours. UUID ties make the same person's share independent of order.
    const shares = people.map((person, index) => {
      const numerator = BigInt(person.knownMicros) * 10000n;
      return { index, profileId: person.profileId, basisPoints: numerator / denominator,
        remainder: numerator % denominator };
    });
    let remaining = 10000n - shares.reduce((total, share) => total + share.basisPoints, 0n);
    const ranked = [...shares].sort((a, b) => a.remainder === b.remainder
      ? a.profileId < b.profileId ? -1 : a.profileId > b.profileId ? 1 : 0
      : a.remainder > b.remainder ? -1 : 1);
    for (const share of ranked) {
      if (remaining === 0n) break;
      share.basisPoints++; remaining--;
    }
    for (const share of shares) {
      people[share.index] = { ...people[share.index],
        percentage: `${share.basisPoints / 100n}.${String(share.basisPoints % 100n).padStart(2, "0")}%` };
    }
    return result;
  } catch { return held; }
}
