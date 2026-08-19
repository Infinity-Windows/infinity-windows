import { describe, expect, it } from "vitest";
import {
  framingIssueNote,
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
