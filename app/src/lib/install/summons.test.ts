// Summon pure bits: the man-minutes the breakdown shows, and the 4040
// two-man-lift rule that drives the declinable install-start prompt.

import { describe, expect, it } from "vitest";
import { sizeSuggestsSummon, summonHelperMinutes } from "./summons";

describe("summonHelperMinutes", () => {
  const t0 = Date.parse("2026-08-14T10:00:00Z");
  it("sums stamped minutes and live helpers together", () => {
    const helpers = [
      { joined_at: "2026-08-14T09:00:00Z", completed_at: "2026-08-14T09:25:00Z", minutes: 25 },
      { joined_at: "2026-08-14T09:50:00Z", completed_at: null, minutes: null },
    ];
    // 25 stamped + 10 live.
    expect(summonHelperMinutes(helpers, t0)).toBe(35);
  });

  it("caps a runaway live clock at 480 and never goes negative", () => {
    expect(
      summonHelperMinutes([{ joined_at: "2026-08-10T00:00:00Z", completed_at: null, minutes: null }], t0),
    ).toBe(480);
    expect(
      summonHelperMinutes([{ joined_at: "2026-08-14T11:00:00Z", completed_at: null, minutes: null }], t0),
    ).toBe(0);
  });
});

describe("sizeSuggestsSummon (over 4040 = 2+ man lift)", () => {
  it("fires when EITHER side beats 4'0\"", () => {
    expect(sizeSuggestsSummon(60, 40)).toBe(true);
    expect(sizeSuggestsSummon(36, 72)).toBe(true);
    expect(sizeSuggestsSummon(313.5, 179.5)).toBe(true); // window 16
  });
  it("stays quiet at or under 4040, and on unknown sizes", () => {
    expect(sizeSuggestsSummon(48, 48)).toBe(false);
    expect(sizeSuggestsSummon(36, 40)).toBe(false);
    expect(sizeSuggestsSummon(null, undefined)).toBe(false);
  });
});
