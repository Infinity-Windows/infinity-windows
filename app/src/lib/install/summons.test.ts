// Summon pure bits: the man-minutes the breakdown shows, and the 4040
// two-man-lift rule that drives the declinable install-start prompt.

import { describe, expect, it } from "vitest";
import { sizeSuggestsSummon, summonHelperMinutes, summonStripLine } from "./summons";

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

// The landing strip's line (owner ask, 2026-08-18): a live summon reads as
// one plain sentence — who, how many hands, where — wherever it appears.

describe("summonStripLine", () => {
  const base = {
    needed: 3,
    status: "open" as const,
    requester: { display_name: "Marcus" },
    project: { job_code: "BLACK22" },
    opening: { opening_code: "14" },
  };

  it("someone else's call: name, hands, job and window", () => {
    expect(summonStripLine(base, false)).toBe(
      "Marcus needs 3 hands — BLACK22 · #14",
    );
  });

  it("your own call reads as confirmation, not an emergency", () => {
    expect(summonStripLine(base, true)).toBe(
      "You called for 3 hands — BLACK22 · #14",
    );
  });

  it("one helper is a hand, not hands", () => {
    expect(summonStripLine({ ...base, needed: 1 }, false)).toBe(
      "Marcus needs 1 hand — BLACK22 · #14",
    );
  });

  it("covered says so — the call is answered but still live", () => {
    expect(summonStripLine({ ...base, status: "covered" }, false)).toBe(
      "Marcus needs 3 hands — BLACK22 · #14 (covered)",
    );
  });

  it("missing joins degrade to the plain sentence, never to 'null'", () => {
    expect(
      summonStripLine(
        { needed: 2, status: "open", requester: null, project: null, opening: null },
        false,
      ),
    ).toBe("Someone needs 2 hands");
  });
});
