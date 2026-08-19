import { describe, expect, it } from "vitest";
import { unitTapInfo } from "./JobModelViewer";
import { fmtInchesFromMm } from "../../lib/modelstudio/dims";
import type { UnitConfig } from "../../lib/modelstudio/units";

describe("unitTapInfo (Studio 100x #27: the tap info line)", () => {
  it("reads mark + size from a configured unit — window 16's own numbers", () => {
    const cfg: UnitConfig = {
      kind: "window",
      heightMm: 2286, // fmtInchesFromMm(2286) === '90"' (dims.test.ts)
      panels: [{ widthMm: 768, mechanism: "fixed" }], // -> '30¼"'
    };
    expect(unitTapInfo({ itemName: "16", unitConfig: cfg }, 0, 0)).toEqual({
      mark: "16",
      dims: '30¼" × 90"',
    });
  });

  it("sums every panel's width before formatting, not just the first", () => {
    const cfg: UnitConfig = {
      kind: "window",
      heightMm: 900,
      panels: [
        { widthMm: 768, mechanism: "fixed" },
        { widthMm: 432, mechanism: "slider" },
      ],
    };
    const { dims } = unitTapInfo({ itemName: "4A", unitConfig: cfg }, 0, 0);
    expect(dims).toBe(`${fmtInchesFromMm(768 + 432)} × ${fmtInchesFromMm(900)}`);
  });

  it("falls back to the item's measured box (cm -> mm) with no panel config", () => {
    // An unresolved seeded window: itemName set, no spec matched yet.
    expect(unitTapInfo({ itemName: "22" }, 76.8, 228.6)).toEqual({
      mark: "22",
      dims: '30¼" × 90"',
    });
  });

  it("falls back to 'Unit' when the mark is missing or blank", () => {
    expect(unitTapInfo(undefined, 76.8, 228.6).mark).toBe("Unit");
    expect(unitTapInfo(null, 76.8, 228.6).mark).toBe("Unit");
    expect(unitTapInfo({ itemName: "" }, 76.8, 228.6).mark).toBe("Unit");
    expect(unitTapInfo({ itemName: "   " }, 76.8, 228.6).mark).toBe("Unit");
  });

  it("trims surrounding whitespace off a real mark", () => {
    expect(unitTapInfo({ itemName: "  16  " }, 76.8, 228.6).mark).toBe("16");
  });

  it("treats an empty panels array the same as no config at all", () => {
    const cfg: UnitConfig = { kind: "window", heightMm: 2286, panels: [] };
    expect(unitTapInfo({ itemName: "9", unitConfig: cfg }, 76.8, 228.6)).toEqual({
      mark: "9",
      dims: '30¼" × 90"',
    });
  });
});
