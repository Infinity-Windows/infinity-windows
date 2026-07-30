import { describe, expect, it } from "vitest";
import {
  describeMovedSummary,
  describePinMove,
  describeResetAll,
  isMarkMoved,
  isPinMoveDenied,
  movedAgoLabel,
  movedMarkIds,
  nextUndoableMove,
  PIN_MOVE_DENIED,
  undoableCount,
  type PinMove,
} from "./pinHistory";
import { formatApiError } from "./errors";

const NOW = Date.parse("2026-07-30T18:00:00Z");

function move(over: Partial<PinMove> = {}): PinMove {
  return {
    id: "m1",
    project_id: "p1",
    opening_id: "o1",
    moved_by: "u1",
    moved_at: "2026-07-30T17:00:00Z",
    from_pin_x: 0.4,
    from_pin_y: 0.5,
    from_page_number: 1,
    to_pin_x: 0.6,
    to_pin_y: 0.5,
    to_page_number: 1,
    undone_at: null,
    undone_by: null,
    note: null,
    ...over,
  };
}

describe("isMarkMoved", () => {
  it("is true when the pin sits off its extracted spot", () => {
    expect(
      isMarkMoved({
        id: "a",
        opening_code: "37",
        pin_x: 0.502,
        pin_y: 0.7,
        origin_pin_x: 0.485199100308642,
        origin_pin_y: 0.7016958912037037,
      }),
    ).toBe(true);
  });

  it("is false when the pin is exactly where extraction put it", () => {
    expect(
      isMarkMoved({
        id: "a",
        opening_code: "37",
        pin_x: 0.4852,
        pin_y: 0.7017,
        origin_pin_x: 0.4852,
        origin_pin_y: 0.7017,
      }),
    ).toBe(false);
  });

  it("is false when no origin was ever recorded, so no reset is offered", () => {
    expect(
      isMarkMoved({ id: "a", opening_code: "9", pin_x: 0.2, pin_y: 0.3 }),
    ).toBe(false);
  });

  it("is false for a mark that has no pin at all", () => {
    expect(
      isMarkMoved({
        id: "a",
        opening_code: "9",
        pin_x: null,
        pin_y: null,
        origin_pin_x: 0.2,
        origin_pin_y: 0.3,
      }),
    ).toBe(false);
  });

  it("collects the ids of only the moved marks", () => {
    const ids = movedMarkIds([
      { id: "a", opening_code: "1", pin_x: 0.1, pin_y: 0.1, origin_pin_x: 0.1, origin_pin_y: 0.1 },
      { id: "b", opening_code: "2", pin_x: 0.9, pin_y: 0.1, origin_pin_x: 0.1, origin_pin_y: 0.1 },
      { id: "c", opening_code: "3", pin_x: 0.5, pin_y: 0.5 },
    ]);
    expect([...ids]).toEqual(["b"]);
  });
});

describe("nextUndoableMove", () => {
  it("returns the newest move nobody has undone", () => {
    const picked = nextUndoableMove([
      move({ id: "old", moved_at: "2026-07-30T10:00:00Z" }),
      move({ id: "new", moved_at: "2026-07-30T17:30:00Z" }),
      move({ id: "mid", moved_at: "2026-07-30T15:00:00Z" }),
    ]);
    expect(picked?.id).toBe("new");
  });

  it("skips moves that have already been walked back", () => {
    const picked = nextUndoableMove([
      move({ id: "old", moved_at: "2026-07-30T10:00:00Z" }),
      move({ id: "new", moved_at: "2026-07-30T17:30:00Z", undone_at: NOW.toString() }),
    ]);
    expect(picked?.id).toBe("old");
  });

  it("breaks a same-millisecond tie on the id so the order is fixed", () => {
    const picked = nextUndoableMove([
      move({ id: "aaa" }),
      move({ id: "zzz" }),
    ]);
    expect(picked?.id).toBe("zzz");
  });

  it("returns null once the stack is empty", () => {
    expect(nextUndoableMove([])).toBeNull();
    expect(nextUndoableMove([move({ undone_at: "2026-07-30T17:00:00Z" })])).toBeNull();
  });

  it("counts the presses left", () => {
    expect(
      undoableCount([
        move({ id: "a" }),
        move({ id: "b" }),
        move({ id: "c", undone_at: "2026-07-30T17:00:00Z" }),
      ]),
    ).toBe(2);
  });
});

describe("movedAgoLabel", () => {
  it.each([
    ["2026-07-30T17:59:40Z", "just now"],
    ["2026-07-30T17:45:00Z", "15 min ago"],
    ["2026-07-30T15:00:00Z", "3 hr ago"],
    ["2026-07-29T18:00:00Z", "1 day ago"],
    ["2026-07-27T18:00:00Z", "3 days ago"],
  ])("%s reads as %s", (at, expected) => {
    expect(movedAgoLabel(at, NOW)).toBe(expected);
  });

  it("never throws on a timestamp it cannot read", () => {
    expect(movedAgoLabel("not a date", NOW)).toBe("earlier");
  });
});

describe("describePinMove says who moved it before you press", () => {
  it("names the other person", () => {
    expect(
      describePinMove({
        move: move({ moved_at: "2026-07-30T17:45:00Z" }),
        markLabel: "12",
        movedByName: "Mike",
        nowMs: NOW,
      }),
    ).toBe("Undo moving mark 12 — Mike, 15 min ago");
  });

  it("says 'you' for your own move", () => {
    expect(
      describePinMove({
        move: move({ moved_at: "2026-07-30T17:45:00Z" }),
        markLabel: "37",
        movedByName: "Taylor",
        byCurrentUser: true,
        nowMs: NOW,
      }),
    ).toBe("Undo moving mark 37 — you, 15 min ago");
  });

  it("falls back to 'someone else' rather than a blank or an id", () => {
    expect(
      describePinMove({
        move: move({ moved_at: "2026-07-30T17:45:00Z", moved_by: null }),
        markLabel: "3",
        movedByName: "   ",
        nowMs: NOW,
      }),
    ).toBe("Undo moving mark 3 — someone else, 15 min ago");
  });
});

describe("plain-English copy for the destructive button", () => {
  it("states the count and warns about deliberate moves", () => {
    const text = describeResetAll(6, "Black Desert");
    expect(text).toContain("6 marks");
    expect(text).toContain("Black Desert");
    expect(text).toContain("on purpose");
  });

  it("uses the singular for one mark", () => {
    expect(describeResetAll(1, "Black Desert")).toContain("1 mark on");
  });

  it("says there is nothing to do when nothing has moved", () => {
    expect(describeResetAll(0, "Black Desert")).toContain("already where the plan put it");
  });

  it("summarises how many marks are off the plan", () => {
    expect(describeMovedSummary(0)).toBe("Every mark is where the plan put it.");
    expect(describeMovedSummary(1)).toBe("1 mark has been moved off the plan.");
    expect(describeMovedSummary(4)).toBe("4 marks have been moved off the plan.");
  });
});

describe("isPinMoveDenied", () => {
  // Shape PostgREST returns when the foreman-only guard raises.
  const refusal = {
    message: PIN_MOVE_DENIED,
    code: "42501",
    details: null,
    hint: null,
  };

  it("recognises the guard's refusal", () => {
    expect(isPinMoveDenied(refusal)).toBe(true);
  });

  it("leaves other failures alone", () => {
    expect(isPinMoveDenied({ message: "Failed to fetch" })).toBe(false);
    expect(isPinMoveDenied(new Error("network down"))).toBe(false);
    expect(isPinMoveDenied(null)).toBe(false);
    expect(isPinMoveDenied("nope")).toBe(false);
  });

  it("turns the refusal into a bare sentence, not a Postgres code", () => {
    // What the crew would have seen without the rethrow in updateOpening…
    expect(formatApiError(refusal)).toContain("[42501]");
    // …and what they see with it.
    expect(formatApiError(new Error(PIN_MOVE_DENIED))).toBe(PIN_MOVE_DENIED);
  });
});
