import { describe, expect, it } from "vitest";
import { canUndo, lineText, undoneIds, UNDO_SELF_WINDOW_MS, type MovementLine } from "./undo";

const NOW = new Date("2026-09-06T12:00:00Z");
const line = (over: Partial<MovementLine> = {}): MovementLine => ({
  id: "m1",
  package_id: "p1",
  event: "stored",
  reason: "stored in Conex 7",
  actor: "ammon",
  created_at: "2026-09-06T11:00:00Z",
  undoes: null,
  ...over,
});
const ask = (over: Partial<Parameters<typeof canUndo>[1]> = {}) => ({
  now: NOW,
  me: "ammon",
  foremanPlus: false,
  undoneIds: new Set<string>(),
  ...over,
});

describe("who may undo a history line (mirrors undo_movement)", () => {
  it("the person who did it, the same day", () => {
    expect(canUndo(line(), ask())).toEqual({ ok: true });
  });

  it("not the person who did it, once a day has passed", () => {
    const old = line({ created_at: new Date(NOW.getTime() - UNDO_SELF_WINDOW_MS - 1).toISOString() });
    const v = canUndo(old, ask());
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.why).toMatch(/foreman/);
  });

  it("a foreman, any line, any time", () => {
    const old = line({ actor: "somebody-else", created_at: "2026-01-01T00:00:00Z" });
    expect(canUndo(old, ask({ foremanPlus: true }))).toEqual({ ok: true });
  });

  it("never somebody else's line for an installer", () => {
    expect(canUndo(line({ actor: "isaac" }), ask()).ok).toBe(false);
  });

  it("never an undo line, and never a line already undone", () => {
    expect(canUndo(line({ undoes: "m0" }), ask({ foremanPlus: true })).ok).toBe(false);
    expect(canUndo(line(), ask({ foremanPlus: true, undoneIds: new Set(["m1"]) })).ok).toBe(false);
  });

  it("only the events the server knows the opposite of", () => {
    for (const event of ["assigned", "stored", "checked_out"]) {
      expect(canUndo(line({ event }), ask({ foremanPlus: true })).ok).toBe(true);
    }
    for (const event of ["bound", "took", "moved", "override"]) {
      expect(canUndo(line({ event }), ask({ foremanPlus: true })).ok).toBe(false);
    }
  });
});

describe("undone lines are found by their link", () => {
  it("collects the ids that an undo points back at", () => {
    const lines = [line(), line({ id: "m2", event: "override", undoes: "m1" })];
    expect([...undoneIds(lines)]).toEqual(["m1"]);
  });
});

describe("a line reads as plain words", () => {
  it("prefers the reason the server wrote", () => {
    expect(lineText(line())).toBe("stored in Conex 7");
  });
  it("falls back to the event in English", () => {
    expect(lineText(line({ reason: null, event: "checked_out" }))).toBe("checked out");
    expect(lineText(line({ reason: null, event: "some_new_thing" }))).toBe("some new thing");
  });
});
