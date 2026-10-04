import { describe, expect, it } from "vitest";
import { formatUnitContributions, MAX_CONTRIBUTION_PEOPLE, type ContributionInput,
  type ContributionDisplay } from "./format";

const A = "00000000-0000-4000-8000-000000000001";
const B = "00000000-0000-4000-8000-000000000002";
const C = "00000000-0000-4000-8000-000000000003";
const HOUR = 3600000000n;
function fixture(amounts: readonly bigint[], ids = [A, B, C]): ContributionInput {
  return { unitKnownMicros: String(amounts.reduce((sum, time) => sum + time, 0n)), unitComplete: true,
    people: amounts.map((time, index) => ({ profileId: ids[index], knownMicros: String(time), complete: true })) };
}
function available(input: unknown) {
  const result = formatUnitContributions(input);
  expect(result.state).toBe("available");
  if (result.state !== "available") throw Error("Expected available presentation");
  return result;
}
function totalBasisPoints(result: Extract<ContributionDisplay, { state: "available" }>) {
  return result.people.reduce((sum, person) => sum + BigInt(person.percentage!.replace(/[.%]/g, "")), 0n);
}

describe("unit contribution presentation from one coherent domain snapshot", () => {
  it("counts two overlapping helpers as two labor hours, with half from each", () => {
    const result = available(fixture([HOUR, HOUR]));
    expect(result.duration).toBe("2:00:00");
    expect(result.people.map(person => [person.duration, person.percentage]))
      .toEqual([["1:00:00", "50.00%"], ["1:00:00", "50.00%"]]);
  });
  it("reconciles 3+2+1 hours and displays 50/33.33/16.67", () => {
    const result = available(fixture([3n * HOUR, 2n * HOUR, HOUR]));
    expect(result.duration).toBe("6:00:00");
    expect(result.people.map(person => person.percentage)).toEqual(["50.00%", "33.33%", "16.67%"]);
    expect(totalBasisPoints(result)).toBe(10000n);
    expect(result.roundingPolicy).toBe("largest_remainder_uuid_tiebreak");
  });
  it("gives equal-third display remainder to the smallest UUID, not first input row", () => {
    const result = available(fixture([HOUR, HOUR, HOUR], [C, A, B]));
    expect(result.people.map(person => [person.profileId, person.percentage]))
      .toEqual([[C, "33.33%"], [A, "33.34%"], [B, "33.33%"]]);
    expect(totalBasisPoints(result)).toBe(10000n);
    const other = available(fixture([HOUR, HOUR, HOUR], [B, C, A]));
    for (const person of result.people) {
      expect(other.people.find(row => row.profileId === person.profileId)?.percentage).toBe(person.percentage);
    }
  });
  it("allocates by exact remainder rather than UUID or rounded hours", () => {
    const result = available(fixture([1n, 1n, 4n]));
    expect(result.people.map(person => person.percentage)).toEqual(["16.67%", "16.67%", "66.66%"]);
    expect(totalBasisPoints(result)).toBe(10000n);
  });
  it("retains a huge exact numerator and a one-microsecond difference", () => {
    const large = 9007199254740993000000n;
    const result = available(fixture([large, large + 1n]));
    expect(result.unitKnownMicros).toBe("18014398509481986000001");
    expect(result.people[1].knownMicros).toBe("9007199254740993000001");
    expect(result.people[0].duration).toBe("2501999792983:36:33");
    expect(result.people.map(person => person.percentage)).toEqual(["50.00%", "50.00%"]);
  });
  it("keeps a proven timed zero distinct from unavailable or untimed people", () => {
    const result = available(fixture([0n, HOUR]));
    expect(result.people[0]).toEqual({ profileId: A, knownMicros: "0", complete: true,
      duration: "0:00:00", percentage: "0.00%" });
    expect(result.people[1].percentage).toBe("100.00%");
  });
  it("allows tiny positive labor to display 0.00% without turning it into zero time", () => {
    const result = available(fixture([1n, HOUR]));
    expect(result.people[0].knownMicros).toBe("1");
    expect(result.people[0].duration).toBe("0:00:00");
    expect(result.people[0].percentage).toBe("0.00%");
    expect(result.people[1].percentage).toBe("100.00%");
    expect(totalBasisPoints(result)).toBe(10000n);
  });
  it("shows 200 equal shares as 0.50% each, without order-dependent drift", () => {
    const ids = Array.from({ length: 200 }, (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`);
    const result = available(fixture(ids.map(() => HOUR), ids));
    expect(result.people).toHaveLength(200);
    expect(result.people.every(person => person.percentage === "0.50%" && person.knownMicros === String(HOUR))).toBe(true);
    expect(totalBasisPoints(result)).toBe(10000n);
  });
  it.each([fixture([]), fixture([0n]), fixture([0n, 0n])])("withholds every zero-total percentage", input => {
    const result = available(input);
    expect(result.percentages).toBe("zero_total");
    expect(result.people.every(person => person.percentage === null)).toBe(true);
  });
  it.each(["unit", "person", "both"])("keeps reconciled known time but withholds partial %s percentages", scope => {
    const input = fixture([HOUR, HOUR]);
    const result = available({ ...input, unitComplete: scope === "person",
      people: input.people.map((person, index) => ({ ...person, complete: index !== 0 || scope === "unit" })) });
    expect(result.percentages).toBe("partial");
    expect(result.duration).toBe("2:00:00");
    expect(result.people.map(person => person.percentage)).toEqual([null, null]);
  });
  it("prioritizes partial over zero when zero is only a known subtotal", () => {
    const result = available({ ...fixture([0n]), unitComplete: false });
    expect(result.percentages).toBe("partial");
  });
  it("never normalizes a visible subset or a mismatched total", () => {
    for (const unitComplete of [true, false]) {
      expect(formatUnitContributions({ ...fixture([HOUR]), unitKnownMicros: String(2n * HOUR), unitComplete }))
        .toEqual({ state: "held", reason: "invalid_input" });
    }
  });
  it("preserves order and never mutates or retains the supplied objects", () => {
    const input = fixture([HOUR, 2n * HOUR], [B, A]);
    input.people.forEach(Object.freeze); Object.freeze(input.people); Object.freeze(input);
    const original = JSON.stringify(input), result = available(input);
    expect(JSON.stringify(input)).toBe(original);
    expect(result.people.map(person => person.profileId)).toEqual([B, A]);
    expect(result.people[0]).not.toBe(input.people[0]);
    expect(formatUnitContributions(input)).toEqual(result);
  });
  it("takes no names, so distinct stable identities cannot merge by a shared name", () => {
    const result = available(fixture([HOUR, HOUR]));
    expect(result.people.map(person => person.profileId)).toEqual([A, B]);
    expect(formatUnitContributions({ ...fixture([HOUR]), people: [{ profileId: A, knownMicros: String(HOUR), complete: true, name: "Employee" }] }).state).toBe("held");
  });
  it.each(["", "01", "+1", "-1", "1.0", "1e3", " 1", "1 ", "1\n", "0.0", "9".repeat(41), 1, 1n, null, undefined])
    ("refuses noncanonical/missing unit amounts %s", value => {
      expect(formatUnitContributions({ ...fixture([HOUR]), unitKnownMicros: value })).toEqual({ state: "held", reason: "invalid_input" });
    });
  it.each(["-1", "01", "9".repeat(41), null, undefined, 0])("refuses bad or missing employee amounts %s", value => {
    expect(formatUnitContributions({ ...fixture([HOUR]), people: [{ profileId: A, knownMicros: value, complete: true }] }).state).toBe("held");
  });
  it("retains canonical legacy PostgreSQL employee UUIDs without inventing another identity", () => {
    const legacy = "00000000-0000-0000-0000-000000000001";
    const result = available(fixture([HOUR], [legacy]));
    expect(result.people[0]).toMatchObject({ profileId: legacy, percentage: "100.00%" });
  });
  it.each(["", "constructor", "toString", "__proto__", "not-a-uuid", A.toUpperCase().replace("0001", "000A"), "00000000-0000-4000-0000-00000000001"])
    ("refuses noncanonical employee identity %s", profileId => {
      expect(formatUnitContributions(fixture([HOUR], [profileId])).state).toBe("held");
    });
  it("refuses duplicate identities instead of silently combining double-counted rows", () => {
    expect(formatUnitContributions(fixture([HOUR, HOUR], [A, A])).state).toBe("held");
  });
  it.each([null, [], {}, Object.create({ unitKnownMicros: "0", unitComplete: true, people: [] }),
    { ...fixture([HOUR]), unitComplete: "true" }, { ...fixture([HOUR]), people: null },
    { ...fixture([HOUR]), extra: true }, JSON.parse('{"unitKnownMicros":"0","unitComplete":true,"people":[],"__proto__":{}}')])
    ("holds malformed or prototype-based input", input => {
      expect(formatUnitContributions(input)).toEqual({ state: "held", reason: "invalid_input" });
    });
  it("does not invoke a getter while validating an input object", () => {
    let reads = 0;
    const input = { ...fixture([HOUR]), get unitKnownMicros() { reads++; return String(HOUR); } };
    expect(formatUnitContributions(input).state).toBe("held"); expect(reads).toBe(0);
  });
  it("refuses final-newline amounts and UUIDs even when their numeric sum would reconcile", () => {
    expect(formatUnitContributions({ ...fixture([HOUR]), unitKnownMicros: `${HOUR}\n` }).state).toBe("held");
    expect(formatUnitContributions({ ...fixture([HOUR]), people: [{ profileId: A, knownMicros: `${HOUR}\n`, complete: true }] }).state).toBe("held");
    expect(formatUnitContributions(fixture([HOUR], [`${A}\n`])).state).toBe("held");
  });
  it("does not invoke array getters or custom iterators, and refuses extra array properties", () => {
    let reads = 0;
    const getterRows = new Array(1);
    Object.defineProperty(getterRows, "0", { enumerable: true, get() { reads++; return fixture([HOUR]).people[0]; } });
    const iteratorRows = [...fixture([HOUR]).people];
    Object.defineProperty(iteratorRows, Symbol.iterator, { value: () => { reads++; throw Error("Do not call"); } });
    const customRows = [...fixture([HOUR]).people];
    Object.setPrototypeOf(customRows, Object.create(Array.prototype));
    for (const people of [getterRows, iteratorRows, customRows]) {
      expect(formatUnitContributions({ ...fixture([HOUR]), people }).state).toBe("held");
    }
    expect(reads).toBe(0);
  });
  it("holds inherited person fields, missing completeness and sparse arrays", () => {
    for (const people of [[Object.create({ profileId: A, knownMicros: "0", complete: true })],
      [{ profileId: A, knownMicros: "0" }], new Array(1)]) {
      expect(formatUnitContributions({ unitKnownMicros: "0", unitComplete: true, people }).state).toBe("held");
    }
  });
  it("honors the explicit people cap without truncating", () => {
    const ids = Array.from({ length: MAX_CONTRIBUTION_PEOPLE + 1 }, (_, i) =>
      `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`);
    const within = available(fixture(ids.slice(0, -1).map(() => 1n), ids));
    expect(within.people).toHaveLength(MAX_CONTRIBUTION_PEOPLE);
    expect(totalBasisPoints(within)).toBe(10000n);
    expect(formatUnitContributions(fixture(ids.map(() => 1n), ids)).state).toBe("held");
  });
  it("accepts the maximum canonical amount without Number conversion", () => {
    const value = BigInt("9".repeat(40));
    const result = available(fixture([value]));
    expect(result.people[0].knownMicros).toBe(String(value));
    expect(result.people[0].percentage).toBe("100.00%");
  });
  it("reconciles deterministic allocations over diverse bounded positive amounts", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const times = [BigInt(seed), BigInt(seed * 17), BigInt(seed % 7)];
      const result = available(fixture(times));
      expect(totalBasisPoints(result)).toBe(10000n);
      if (times[2] === 0n) expect(result.people[2].percentage).toBe("0.00%");
    }
  });
});
