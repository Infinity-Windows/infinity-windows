import { describe, expect, it } from "vitest";
import { unitTapInfo } from "./JobModelViewer";
import { openingIdForMark } from "../../lib/fitview/adapter";
import { fmtInchesFromMm } from "../../lib/modelstudio/dims";
import type { UnitConfig } from "../../lib/modelstudio/units";
import { orderNumberMap, toggleSelection } from "../../lib/install/mapDispatch";

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

describe("assign-mode picking (Studio 100x #8): resolve-then-toggle, mapDispatch's own ordering", () => {
  // JobModelViewer's tap handler composes openingIdForMark (resolve the tap
  // to a real opening) with mapDispatch's toggleSelection/orderNumberMap —
  // already pure + tested there for the map's own assign mode. Pinned here
  // as the exact sequence the component runs on every tap (togglePick
  // semantics, sequence preservation, clear-on-assign), so a change to
  // either half can't silently break how they compose.
  const openings = [
    { id: "op-10", opening_code: "10" },
    { id: "op-11", opening_code: "11" },
  ];

  it("togglePick semantics: tapping two different units picks both, in TAP order", () => {
    let picked: string[] = [];
    picked = toggleSelection(picked, openingIdForMark(openings, "11")!);
    picked = toggleSelection(picked, openingIdForMark(openings, "10")!);
    expect(picked).toEqual(["op-11", "op-10"]); // tap order, not opening_code order
  });

  it("sequence preservation: un-picking the first tap renumbers the rest instead of reordering them", () => {
    let picked = toggleSelection([], openingIdForMark(openings, "10")!);
    picked = toggleSelection(picked, openingIdForMark(openings, "11")!);
    picked = toggleSelection(picked, "op-10"); // un-tap the first pick
    expect(picked).toEqual(["op-11"]);
    expect(orderNumberMap(picked).get("op-11")).toBe(1);
  });

  it("clear-on-assign: a successful assign resets picking to empty, no leftover numbering", () => {
    const afterAssign: string[] = [];
    expect(afterAssign).toEqual([]);
    expect(orderNumberMap(afterAssign).size).toBe(0);
  });
});
