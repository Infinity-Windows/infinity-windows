import { describe, expect, it } from "vitest";
import {
  DATA_OFF_CHOICES,
  DATA_OFF_LABEL_KEYS,
  dataOffIds,
  dataOffKind,
  dataOffRate,
  isDataOff,
} from "./dataOff";

describe("dataOffKind", () => {
  it("reads the recorded reason", () => {
    expect(dataOffKind({ flag_kind: "mirrored", flag_note: null })).toBe("mirrored");
  });

  it("reads a flag raised before reasons existed as 'other'", () => {
    // The whole back catalogue: a note, no kind. Nobody was ever asked which
    // kind it was, so guessing one would invent history.
    expect(dataOffKind({ flag_kind: null, flag_note: "wrong unit delivered" })).toBe("other");
  });

  it("ignores a blank note", () => {
    expect(dataOffKind({ flag_kind: null, flag_note: "   " })).toBeNull();
    expect(isDataOff({ flag_kind: null, flag_note: null })).toBe(false);
  });

  it("falls back to 'other' for a reason this build has never heard of", () => {
    expect(dataOffKind({ flag_kind: "some_future_reason" })).toBe("other");
  });
});

describe("dataOffIds", () => {
  it("collects only the flagged ones", () => {
    const ids = dataOffIds([
      { id: "a", flag_kind: "wrong_size" },
      { id: "b", flag_kind: null, flag_note: null },
      { id: "c", flag_kind: null, flag_note: "sill is rotten" },
    ]);
    expect([...ids].sort()).toEqual(["a", "c"]);
  });
});

describe("dataOffRate", () => {
  it("is null with nothing to divide by", () => {
    expect(dataOffRate(0, 0)).toBeNull();
  });

  it("is the share of units flagged", () => {
    expect(dataOffRate(3, 12)).toBeCloseTo(0.25);
  });
});

describe("the reasons offered on the sheet", () => {
  it("never offers 'not on plans' — that is the missed-unit button", () => {
    expect(DATA_OFF_CHOICES).not.toContain("not_on_plans");
  });

  it("names every reason in the catalog", () => {
    for (const kind of DATA_OFF_CHOICES) {
      expect(DATA_OFF_LABEL_KEYS[kind]).toBeTruthy();
    }
  });
});
