import { describe, expect, it } from "vitest";
import {
  clampPercent,
  emptyProgressFields,
  isWorkStageKey,
  latestUnitSnapshot,
  previousStageValue,
  stageProgressCaption,
  WORK_STAGE_KEYS,
} from "./dailyLogStages";

describe("clampPercent", () => {
  it("rounds and clamps to 0-100", () => {
    expect(clampPercent(50.4)).toBe(50);
    expect(clampPercent(50.6)).toBe(51);
    expect(clampPercent(-5)).toBe(0);
    expect(clampPercent(140)).toBe(100);
    expect(clampPercent(Number.NaN)).toBe(0);
  });
});

describe("isWorkStageKey", () => {
  it("accepts every real stage and rejects a non-stage chip", () => {
    for (const k of WORK_STAGE_KEYS) expect(isWorkStageKey(k)).toBe(true);
    expect(isWorkStageKey("material_run")).toBe(false);
    expect(isWorkStageKey("made_up")).toBe(false);
  });
});

describe("stageProgressCaption", () => {
  it("reports was/delta against the previous value", () => {
    expect(stageProgressCaption(40, 65)).toEqual({ was: 40, deltaToday: 25 });
  });
  it("shows a SIGNED negative delta when corrected downward — Horizon shows -15/-11 today, never clamps to 'no change'", () => {
    expect(stageProgressCaption(60, 40)).toEqual({ was: 60, deltaToday: -20 });
  });
  it("reads an exact repeat as zero, not hidden", () => {
    expect(stageProgressCaption(40, 40)).toEqual({ was: 40, deltaToday: 0 });
  });
  it("never invents a 0 baseline for a stage with no prior reading at all — a first reading, not '+10 today'", () => {
    expect(stageProgressCaption(null, 10)).toEqual({ was: null, deltaToday: null });
  });
});

describe("previousStageValue", () => {
  it("skips days that didn't touch the stage, in either direction", () => {
    const logs = [
      { logDate: "2026-09-28", stageProgress: { frames: 20 } },
      { logDate: "2026-09-29", stageProgress: { glass: 10 } }, // frames untouched
      { logDate: "2026-09-30", stageProgress: { frames: 55 } },
    ];
    expect(previousStageValue(logs, "frames")).toBe(55);
  });
  it("reads null (not 0) when the stage was never reported — a confirmed 0 must stay distinct", () => {
    expect(previousStageValue([{ logDate: "2026-09-28", stageProgress: { glass: 10 } }], "frames")).toBeNull();
    expect(previousStageValue([], "frames")).toBeNull();
  });
  it("reads a confirmed 0 as 0, not as 'never reported'", () => {
    expect(previousStageValue([{ logDate: "2026-09-28", stageProgress: { frames: 0 } }], "frames")).toBe(0);
  });
});

describe("latestUnitSnapshot", () => {
  const today = "2026-10-01";

  it("returns null when no log in range ever reported a count", () => {
    const logs = [{ logDate: "2026-09-30", unitsToday: null, unitsToDate: null, unitsRemaining: null, unitsRemainingDetail: null }];
    expect(latestUnitSnapshot(logs, today)).toBeNull();
  });

  it("prefers today's snapshot when today reported one", () => {
    const logs = [
      { logDate: "2026-09-29", unitsToday: 2, unitsToDate: 10, unitsRemaining: 5, unitsRemainingDetail: "W-11, W-12" },
      { logDate: today, unitsToday: 3, unitsToDate: 13, unitsRemaining: 2, unitsRemainingDetail: "W-12" },
    ];
    const result = latestUnitSnapshot(logs, today);
    expect(result).toMatchObject({ isToday: true, snapshot: { logDate: today, unitsRemaining: 2 } });
  });

  it("falls back to the most recent earlier reported day — never averaged or summed", () => {
    const logs = [
      { logDate: "2026-09-25", unitsToday: 1, unitsToDate: 4, unitsRemaining: 9, unitsRemainingDetail: null },
      { logDate: "2026-09-29", unitsToday: 2, unitsToDate: 6, unitsRemaining: 7, unitsRemainingDetail: "W-9, W-10" },
      { logDate: "2026-09-30", unitsToday: null, unitsToDate: null, unitsRemaining: null, unitsRemainingDetail: null }, // not reported that day
    ];
    const result = latestUnitSnapshot(logs, today);
    expect(result).toMatchObject({ isToday: false, snapshot: { logDate: "2026-09-29", unitsRemaining: 7 } });
  });

  it("treats a reported zero as a real snapshot, distinct from not-reported", () => {
    const logs = [{ logDate: today, unitsToday: 0, unitsToDate: 20, unitsRemaining: 0, unitsRemainingDetail: null }];
    expect(latestUnitSnapshot(logs, today)).toMatchObject({ snapshot: { unitsRemaining: 0 } });
  });
});

describe("emptyProgressFields", () => {
  it("starts every count as not-reported, not zero", () => {
    const f = emptyProgressFields();
    expect(f.unitsToday).toBeNull();
    expect(f.unitsToDate).toBeNull();
    expect(f.unitsRemaining).toBeNull();
    expect(f.workStages).toEqual([]);
    expect(f.stageProgress).toEqual({});
  });
});
