// The supplies count's one hard rule (warehouse ticket 07): the estimate
// NEVER appears without the date it was corrected. A bare number reads as
// exact, and this number is deliberately not.

import { describe, expect, it } from "vitest";
import {
  filterSuppliesByName,
  lowStockFirst,
  onHandLabel,
  type Supply,
} from "./ops";

const supply = (name: string, on_hand: number | null): Supply => ({
  id: name,
  name,
  unit: "ea",
  on_hand,
});

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

// The supply drawers' shared ranking and search (owner ask, 2026-08-18):
// the Warehouse fold and the Supplies shelf both lean on these, so the
// behavior is pinned once, here.

describe("lowStockFirst", () => {
  it("puts the lowest counts first", () => {
    const out = lowStockFirst([supply("c", 90), supply("a", 2), supply("b", 40)]);
    expect(out.map((s) => s.name)).toEqual(["a", "b", "c"]);
  });

  it("ranks 'not counted yet' as the average of what IS known — after the truly low, before the comfortable", () => {
    const out = lowStockFirst([
      supply("plenty", 100),
      supply("unknown", null),
      supply("low", 2),
    ]);
    // known average = 51, so: low (2), unknown (51), plenty (100)
    expect(out.map((s) => s.name)).toEqual(["low", "unknown", "plenty"]);
  });

  it("all unknown is fine — nothing to rank by, nothing thrown", () => {
    const out = lowStockFirst([supply("a", null), supply("b", null)]);
    expect(out).toHaveLength(2);
  });

  it("does not mutate the caller's array", () => {
    const input = [supply("b", 9), supply("a", 1)];
    lowStockFirst(input);
    expect(input.map((s) => s.name)).toEqual(["b", "a"]);
  });
});

describe("filterSuppliesByName", () => {
  const shelf = [supply("OSI Quad caulk", 12), supply("Screws #8", 500), supply("Backer rod", 3)];

  it("matches anywhere in the name, any case", () => {
    expect(filterSuppliesByName(shelf, "CAULK").map((s) => s.name)).toEqual([
      "OSI Quad caulk",
    ]);
  });

  it("trims the query — a stray space still finds it", () => {
    expect(filterSuppliesByName(shelf, "  screws ")).toHaveLength(1);
  });

  it("empty query returns everything in the caller's order", () => {
    expect(filterSuppliesByName(shelf, "")).toEqual(shelf);
    expect(filterSuppliesByName(shelf, "   ")).toEqual(shelf);
  });

  it("no match returns empty, not everything", () => {
    expect(filterSuppliesByName(shelf, "flux capacitor")).toEqual([]);
  });
});
