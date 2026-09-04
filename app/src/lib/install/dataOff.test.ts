import { describe, expect, it } from "vitest";
import {
  DATA_OFF_CHOICES,
  DATA_OFF_LABEL_KEYS,
  dataOffIds,
  dataOffKind,
  dataOffRate,
  dataOffReasonKey,
  dataOffUnits,
  holdsOffDispatch,
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

describe("dataOffUnits", () => {
  it("lists the flagged ones newest first, with reason and who", () => {
    const out = dataOffUnits([
      {
        id: "a",
        opening_code: "7-1",
        flag_kind: "wrong_size",
        flag_note: " ordered 3060 ",
        flagged_by: "ben",
        flagged_at: "2026-09-01T10:00:00Z",
      },
      { id: "b", opening_code: "8-1", flag_kind: null, flag_note: null },
      {
        id: "c",
        opening_code: "9-1",
        flag_kind: "mirrored",
        flag_note: null,
        flagged_by: null,
        flagged_at: "2026-09-03T10:00:00Z",
      },
    ]);
    expect(out.map((u) => u.code)).toEqual(["9-1", "7-1"]);
    expect(out[1]).toEqual({
      openingId: "a",
      code: "7-1",
      reason: "wrong_size",
      note: "ordered 3060",
      flaggedBy: "ben",
    });
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

describe("dataOffReasonKey", () => {
  // The reason is on the OPENING. The database used to write it into the
  // issue's note when nobody typed one, which put the string `wrong_size` in
  // front of a foreman; the screens read it from here instead and translate it.
  it("names the reason so an issue with no note still says something", () => {
    expect(dataOffReasonKey({ flag_kind: "wrong_size", flag_note: null })).toBe(
      "dataoff.reason.wrongSize",
    );
  });

  it("is null when the record is not in doubt", () => {
    expect(dataOffReasonKey({ flag_kind: null, flag_note: null })).toBeNull();
    expect(dataOffReasonKey(null)).toBeNull();
  });
});

describe("holdsOffDispatch", () => {
  it("keeps a unit whose record is in doubt out of the assignable columns", () => {
    expect(holdsOffDispatch({ flag_kind: "wrong_size", flag_note: null })).toBe(true);
  });

  it("lets an unflagged unit through", () => {
    expect(holdsOffDispatch({ flag_kind: null, flag_note: null })).toBe(false);
  });

  // THE REGRESSION. add_field_unit stamps `not_on_plans` on every missed unit
  // and never takes it off, so reading the skip straight off isDataOff hid the
  // window the crew added from every assignable column on the board — and the
  // only way out was clearing the flag, which erases the one stored fact
  // saying why the unit exists. The sheet that adds one promises it will be
  // "ordered and installed".
  it("still dispatches a missed unit, which is flagged from birth", () => {
    expect(
      holdsOffDispatch({
        flag_kind: "not_on_plans",
        flag_note: null,
        field_added: true,
      }),
    ).toBe(false);
  });

  it("still dispatches a missed unit a foreman has since flagged for something else", () => {
    expect(
      holdsOffDispatch({
        flag_kind: "wrong_size",
        flag_note: "ordered 3060, opening is 3050",
        field_added: true,
      }),
    ).toBe(false);
  });
});
