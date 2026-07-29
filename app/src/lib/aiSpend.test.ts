import { describe, expect, it } from "vitest";
import {
  budgetHeadline,
  budgetPct,
  formatCents,
  formatMicros,
  worstCasePerUserPerDay,
} from "./aiSpend";

describe("formatMicros", () => {
  it("shows real dollars for real money", () => {
    expect(formatMicros(1_370_000)).toBe("$1.37");
    expect(formatMicros(46_000_000)).toBe("$46.00");
  });

  it("never renders a real cost as $0.00", () => {
    // Synthesising tips for one window type costs $0.0009. Printing "$0.00"
    // would make it look free, which is how a bill sneaks up on someone.
    expect(formatMicros(900)).toBe("under 1¢");
  });

  it("shows nothing as nothing", () => {
    expect(formatMicros(0)).toBe("$0.00");
  });

  it("treats nonsense as nothing rather than NaN", () => {
    expect(formatMicros(Number.NaN)).toBe("$0.00");
    expect(formatMicros(-500)).toBe("$0.00");
  });
});

describe("formatCents", () => {
  it("keeps a round ceiling round", () => {
    expect(formatCents(15000)).toBe("$150");
    expect(formatCents(5000)).toBe("$50");
  });

  it("shows the pennies when there are pennies", () => {
    expect(formatCents(12345)).toBe("$123.45");
  });
});

describe("budgetPct", () => {
  it("measures against money already booked, not money already spent", () => {
    expect(budgetPct({ reserved_micros: 75_000_000, cap_micros: 150_000_000 })).toBe(50);
  });

  it("does not divide by a ceiling of zero", () => {
    expect(budgetPct({ reserved_micros: 1_000, cap_micros: 0 })).toBe(0);
  });

  it("can read over 100 so an owner sees an overshoot rather than a flat 100", () => {
    expect(budgetPct({ reserved_micros: 200_000_000, cap_micros: 150_000_000 })).toBe(133);
  });
});

describe("budgetHeadline", () => {
  const cap = 150_000_000;

  it("leads with reassurance when nothing is blocked", () => {
    const line = budgetHeadline(
      { reserved_micros: 20_000_000, spent_micros: 20_000_000, cap_micros: cap },
      true,
    );
    expect(line).toContain("$20.00");
    expect(line).toContain("Nothing is being blocked");
  });

  it("says plainly that crew are still getting answers when the ceiling is hit", () => {
    const line = budgetHeadline(
      { reserved_micros: cap, spent_micros: cap, cap_micros: cap },
      true,
    );
    expect(line).toContain("ceiling is reached");
    expect(line).toContain("company brain");
  });

  it("warns before the ceiling rather than at it", () => {
    const line = budgetHeadline(
      { reserved_micros: 130_000_000, spent_micros: 130_000_000, cap_micros: cap },
      true,
    );
    expect(line).toContain("most of the way");
  });

  it("says the brake is off when the owner has switched it off", () => {
    const line = budgetHeadline(
      { reserved_micros: cap * 2, spent_micros: cap * 2, cap_micros: cap },
      false,
    );
    expect(line).toContain("switched off");
  });
});

describe("worstCasePerUserPerDay", () => {
  it("puts the default daily limit at about a dollar", () => {
    expect(worstCasePerUserPerDay(40)).toBe(40 * 27_000);
    expect(formatMicros(worstCasePerUserPerDay(40))).toBe("$1.08");
  });

  it("is the number that makes a leaked login boring", () => {
    // 2,880 calls is the investigation's runaway (one every ten seconds for an
    // eight-hour day). The daily limit turns $78 into $1.08.
    expect(worstCasePerUserPerDay(2_880) / worstCasePerUserPerDay(40)).toBe(72);
  });

  it("refuses to make a negative limit look like credit", () => {
    expect(worstCasePerUserPerDay(-10)).toBe(0);
  });
});
