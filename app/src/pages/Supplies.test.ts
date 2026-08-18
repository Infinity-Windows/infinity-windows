import { describe, expect, it } from "vitest";
import {
  SUPPLY_UNIT_PRESETS,
  newSupplyUnitInvalid,
  resolveNewSupplyUnit,
} from "./Supplies";

/**
 * Adding to the catalog used to hardcode "ea", so a foreman who added
 * "Sealant (grey)" gave every installer a Take screen reading "How many (ea)"
 * forever — with no way to fix it afterwards. The unit is the word the crew
 * reads on the shelf, so the form has to ask for it (warehouse ticket D7).
 */
describe("the unit on a new catalog item", () => {
  it("offers the units the catalog was seeded with", () => {
    // Straight out of the seed in 20260717005000_ops_modules.sql (roll, can,
    // bundle, tube, bag) plus the column's own default, "ea". If the seed
    // grows a unit, this list should grow with it.
    expect(SUPPLY_UNIT_PRESETS).toEqual(["ea", "roll", "tube", "bag", "bundle", "can"]);
  });

  it("uses the picked preset as-is", () => {
    expect(resolveNewSupplyUnit("roll", "")).toBe("roll");
    // A stale "other" box must not leak into a preset choice.
    expect(resolveNewSupplyUnit("tube", "spool")).toBe("tube");
  });

  it("takes a typed-in unit when they pick other, trimmed", () => {
    expect(resolveNewSupplyUnit("other", "  spool ")).toBe("spool");
  });

  it("only complains when other is picked and left blank", () => {
    expect(newSupplyUnitInvalid("ea", "")).toBe(false);
    expect(newSupplyUnitInvalid("other", "")).toBe(true);
    expect(newSupplyUnitInvalid("other", "   ")).toBe(true);
    expect(newSupplyUnitInvalid("other", "spool")).toBe(false);
  });
});
