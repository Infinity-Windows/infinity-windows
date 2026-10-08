import { describe, expect, it } from "vitest";
import {
  SCHEDULE_START_WORK_KEY,
  classicDesignSettled,
  hasScheduleStartWorkIntent,
  makeScheduleStartWorkState,
  readScheduleStartWorkIntent,
  withoutScheduleStartWorkIntent,
} from "./scheduleStartWorkIntent";

const mark = { userId: "u-1", generation: 3 };

describe("schedule start-work intent in history state", () => {
  it("names the assignment, the real login and generation, and the day — never a project", () => {
    const state = makeScheduleStartWorkState("asg-b", "2026-10-05", mark);
    const intent = state[SCHEDULE_START_WORK_KEY];
    expect(intent).toEqual({ v: 1, assignmentId: "asg-b", ownerId: "u-1", generation: 3, day: "2026-10-05" });
    expect(Object.keys(intent)).not.toContain("projectId");
  });

  it("a tap with nobody signed in still carries an intent, with an empty owner, so it fails closed", () => {
    const read = readScheduleStartWorkIntent(makeScheduleStartWorkState("asg-b", "2026-10-05", { userId: null, generation: 0 }));
    expect(read).toEqual({ kind: "intent", intent: expect.objectContaining({ ownerId: "" }) });
  });

  it("round-trips a well-formed intent", () => {
    const read = readScheduleStartWorkIntent(makeScheduleStartWorkState("asg-b", "2026-10-05", mark));
    expect(read.kind).toBe("intent");
  });

  it("reads nothing from plain or empty state", () => {
    expect(readScheduleStartWorkIntent(null)).toEqual({ kind: "none" });
    expect(readScheduleStartWorkIntent(undefined)).toEqual({ kind: "none" });
    expect(readScheduleStartWorkIntent({ other: 1 })).toEqual({ kind: "none" });
    expect(readScheduleStartWorkIntent("x")).toEqual({ kind: "none" });
  });

  it.each([
    ["not an object", "asg"],
    ["wrong version", { v: 2, assignmentId: "a", ownerId: "u", generation: 1, day: "2026-10-05" }],
    ["empty assignment", { v: 1, assignmentId: "", ownerId: "u", generation: 1, day: "2026-10-05" }],
    ["generation not a number", { v: 1, assignmentId: "a", ownerId: "u", generation: "1", day: "2026-10-05" }],
    ["bad day", { v: 1, assignmentId: "a", ownerId: "u", generation: 1, day: "today" }],
    ["owner missing", { v: 1, assignmentId: "a", generation: 1, day: "2026-10-05" }],
  ])("anything else under the key is malformed (%s)", (_label, raw) => {
    expect(readScheduleStartWorkIntent({ [SCHEDULE_START_WORK_KEY]: raw })).toEqual({ kind: "malformed" });
    expect(hasScheduleStartWorkIntent({ [SCHEDULE_START_WORK_KEY]: raw })).toBe(true);
  });

  it("removing it keeps every other field and is a no-op without it", () => {
    const state = { ...makeScheduleStartWorkState("asg-b", "2026-10-05", mark), keep: { a: 1 } };
    expect(withoutScheduleStartWorkIntent(state)).toEqual({ keep: { a: 1 } });
    expect(withoutScheduleStartWorkIntent(makeScheduleStartWorkState("asg-b", "2026-10-05", mark))).toBeNull();
    const plain = { keep: 1 };
    expect(withoutScheduleStartWorkIntent(plain)).toBe(plain);
    expect(hasScheduleStartWorkIntent(withoutScheduleStartWorkIntent(state))).toBe(false);
  });
});

describe("classicDesignSettled — when App's landing may drop an intent", () => {
  it.each([
    ["owner switch off, choice unknown", { masterOn: false, choice: null }, true],
    ["owner switch off, person chose new", { masterOn: false, choice: "new" }, true],
    ["person chose classic, switch unknown", { masterOn: null, choice: "classic" }, true],
    ["person chose classic, switch on", { masterOn: true, choice: "classic" }, true],
    ["both unknown (provisional classic)", { masterOn: null, choice: null }, false],
    ["switch on, choice unknown", { masterOn: true, choice: null }, false],
    ["switch unknown, person chose new", { masterOn: null, choice: "new" }, false],
    ["switch on, person chose new", { masterOn: true, choice: "new" }, false],
    ["undefined fields", { masterOn: undefined, choice: undefined }, false],
  ] as const)("%s", (_label, d, expected) => {
    expect(classicDesignSettled(d)).toBe(expected);
  });
});
