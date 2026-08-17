// The supplies count's one hard rule (warehouse ticket 07): the estimate
// NEVER appears without the date it was corrected. A bare number reads as
// exact, and this number is deliberately not.

import { describe, expect, it } from "vitest";
import { onHandLabel } from "./ops";

describe("onHandLabel", () => {
  it("pairs the estimate with its count date, in plain words", () => {
    expect(
      onHandLabel({ on_hand: 140, last_counted_at: "2026-08-03T15:00:00Z" }),
    ).toBe("about 140 on hand · last counted Aug 3");
  });

  it("zero is a real count, not a missing one", () => {
    expect(
      onHandLabel({ on_hand: 0, last_counted_at: "2026-08-03T15:00:00Z" }),
    ).toBe("about 0 on hand · last counted Aug 3");
  });

  it("never shows a number without a date — either missing means not counted", () => {
    expect(onHandLabel({ on_hand: 140, last_counted_at: null })).toBe("not counted yet");
    expect(onHandLabel({ on_hand: null, last_counted_at: "2026-08-03T15:00:00Z" })).toBe(
      "not counted yet",
    );
    expect(onHandLabel({})).toBe("not counted yet");
  });
});
