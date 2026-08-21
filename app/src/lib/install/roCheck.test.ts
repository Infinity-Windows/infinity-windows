import { describe, expect, it } from "vitest";
import {
  framingIssueNote,
  requiredMidHeightCount,
  roFailures,
  roVerdicts,
  type RoJudgment,
  type RoCheckId,
} from "./roCheck";

const judged = (over: Partial<Record<RoCheckId, RoJudgment>>) => ({
  square: null,
  width: null,
  height: null,
  ...over,
});

describe("roVerdicts (the numbers judge, against the window)", () => {
  it("square: diagonals within 1/4 inch pass, beyond fail", () => {
    const base = { widths: [], heights: [], unitWidthIn: null, unitHeightIn: null };
    expect(roVerdicts({ ...base, diagonals: [96.25, 96.05] })[0]).toMatchObject({
      check: "square",
      measured: "good",
    });
    expect(roVerdicts({ ...base, diagonals: [96.5, 95.75] })[0]).toMatchObject({
      check: "square",
      measured: "bad",
    });
    // One diagonal is not enough to judge.
    expect(roVerdicts({ ...base, diagonals: [96.5, null] })[0].measured).toBeNull();
  });

  it("width/height: the gap must sit between 1/8 and 1/2 inch over the unit", () => {
    const base = { diagonals: [], unitWidthIn: 23.5, unitHeightIn: 89.5 };
    // 23.875 - 23.5 = 3/8" gap: within range.
    const good = roVerdicts({ ...base, widths: [24, 23.875], heights: [89.75] });
    expect(good[1]).toMatchObject({ check: "width", measured: "good" });
    expect(good[2]).toMatchObject({ check: "height", measured: "good" });
    // Too tight (1/16") and smaller-than-unit both fail.
    expect(
      roVerdicts({ ...base, widths: [23.5625], heights: [] })[1].measured,
    ).toBe("bad");
    expect(roVerdicts({ ...base, widths: [23.25], heights: [] })[1].detail).toMatch(
      /smaller than the unit/,
    );
    // Too loose (3/4" over) fails the other way.
    expect(
      roVerdicts({ ...base, widths: [24.25], heights: [] })[1].detail,
    ).toMatch(/oversized/);
  });

  it("smallest point binds - one tight point fails the axis", () => {
    const v = roVerdicts({
      diagonals: [],
      widths: [24, 23.55, 24.1],
      heights: [],
      unitWidthIn: 23.5,
      unitHeightIn: null,
    });
    expect(v[1].measured).toBe("bad");
  });

  it("no unit size on file: numbers recorded, judgment withheld", () => {
    const v = roVerdicts({
      diagonals: [],
      widths: [24],
      heights: [],
      unitWidthIn: null,
      unitHeightIn: null,
    });
    expect(v[1].measured).toBeNull();
    expect(v[1].detail).toMatch(/no unit size/);
  });
});

describe("mid-span height requirement on wide openings (owner rule, 2026-08-21)", () => {
  it("requiredMidHeightCount: 60 and under need none, past 60 need one, past 120 need two", () => {
    expect(requiredMidHeightCount(null)).toBe(0);
    expect(requiredMidHeightCount(59)).toBe(0);
    expect(requiredMidHeightCount(60)).toBe(0); // exactly 60 is not OVER 60
    expect(requiredMidHeightCount(61)).toBe(1);
    expect(requiredMidHeightCount(120)).toBe(1); // exactly 120 is not OVER 120
    expect(requiredMidHeightCount(121)).toBe(2);
  });

  // unitHeightIn fixed at 89.5 throughout; only unitWidthIn (the nominal
  // that gates the requirement) and the height points vary.
  const heightVerdict = (unitWidthIn: number | null, heights: (number | null)[]) =>
    roVerdicts({
      diagonals: [],
      widths: [],
      heights,
      unitWidthIn,
      unitHeightIn: 89.5,
    })[2];

  it("59in nominal: no mid required — [left, right] judges exactly as before", () => {
    const v = heightVerdict(59, [89.75, 89.8]);
    expect(v.measured).toBe("good");
  });

  it("61in nominal: one mid required — missing reads as not finished", () => {
    const v = heightVerdict(61, [89.75, 89.8]);
    expect(v.measured).toBeNull();
    expect(v.detail).toMatch(/mid-span height not entered yet/);
    expect(v.detail).toMatch(/wide opening/);
  });

  it("61in nominal, mid present: smallest of all three wins, even when the ends alone would pass", () => {
    // Left and right alone would both read comfortably (1/4" and 3/16"
    // over) - it's the mid-span reading, low from a bowed header, that
    // fails the check.
    const v = heightVerdict(61, [89.75, 89.55, 89.8]);
    expect(v.measured).toBe("bad");
    expect(v.detail).not.toMatch(/not entered/);
    expect(v.detail).toMatch(/needs.*minimum to shim/);
  });

  it("121in nominal: both third-points required — one alone still isn't finished", () => {
    const none = heightVerdict(121, [89.75, 89.8]);
    expect(none.measured).toBeNull();
    expect(none.detail).toMatch(/both third-point heights not entered yet/);

    const oneOfTwo = heightVerdict(121, [89.75, 89.7, 89.8]);
    expect(oneOfTwo.measured).toBeNull();
    expect(oneOfTwo.detail).toMatch(/both third-point heights not entered yet/);

    const both = heightVerdict(121, [89.75, 89.7, 89.72, 89.8]);
    expect(both.measured).toBe("good");
  });

  it("no nominal width on file: never gate on a number we don't have", () => {
    const v = heightVerdict(null, [89.75, 89.8]);
    expect(v.measured).toBe("good");
  });
});

describe("roFailures + the issue note", () => {
  it("a Good tap never overrides bad numbers; a Bad tap files without numbers", () => {
    const verdicts = roVerdicts({
      diagonals: [96.5, 95.75],
      widths: [],
      heights: [],
      unitWidthIn: null,
      unitHeightIn: null,
    });
    // Installer tapped Good on square - numbers still fail it.
    expect(roFailures(verdicts, judged({ square: "good" }))).toHaveLength(1);
    // Bad tap on height with no measurements files too.
    expect(roFailures(verdicts, judged({ square: "good", height: "bad" }))).toHaveLength(2);
  });

  it("the note reads like a punch list a framer can work from", () => {
    const verdicts = roVerdicts({
      diagonals: [96.5, 95.75],
      widths: [],
      heights: [],
      unitWidthIn: null,
      unitHeightIn: null,
    });
    const note = framingIssueNote(
      "12-1",
      roFailures(verdicts, judged({ height: "bad" })),
      judged({ height: "bad" }),
    );
    expect(note).toMatch(/^Square: diagonals/);
    expect(note).toMatch(/out of square/);
    expect(note).toMatch(/Height marked Bad by the installer/);
    // Trade fractions, not decimals.
    expect(note).toMatch(/1\/2"/);
    expect(note).not.toMatch(/0\.5/);
  });
});
