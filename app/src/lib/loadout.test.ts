import { describe, expect, it } from "vitest";
import {
  computeReorderNeeds,
  isLoadable,
  loadableUnits,
  selectedLoadableIds,
  toggleSelected,
  totalReorder,
  type MissingIssueLike,
  type ReorderUnitLike,
} from "./loadout";
import type { WindowStatus } from "./types";

const u = (id: string, status: WindowStatus) => ({ id, status });

describe("load-out selection", () => {
  it("treats only warehouse-ready units as loadable", () => {
    expect(isLoadable(u("a", "in_warehouse"))).toBe(true);
    expect(isLoadable(u("b", "staged"))).toBe(true);
    expect(isLoadable(u("c", "loaded"))).toBe(false);
    expect(isLoadable(u("d", "installed"))).toBe(false);
    expect(isLoadable(u("e", "pre_issued"))).toBe(false);
    expect(isLoadable(u("f", "damaged"))).toBe(false);
    // On-site units have already left the warehouse — not loadable.
    expect(isLoadable(u("g", "on_site"))).toBe(false);
  });

  it("excludes on_site units from the loadable subset and batch", () => {
    const list = [
      u("a", "in_warehouse"),
      u("b", "on_site"),
      u("c", "staged"),
    ];
    expect(loadableUnits(list).map((x) => x.id)).toEqual(["a", "c"]);
    const selected = new Set(["a", "b", "c"]);
    expect(selectedLoadableIds(list, selected)).toEqual(["a", "c"]);
  });

  it("filters a mixed list down to the loadable units", () => {
    const list = [
      u("a", "in_warehouse"),
      u("b", "loaded"),
      u("c", "staged"),
      u("d", "pre_issued"),
    ];
    expect(loadableUnits(list).map((x) => x.id)).toEqual(["a", "c"]);
  });

  it("toggles a selection immutably", () => {
    const empty = new Set<string>();
    const withA = toggleSelected(empty, "a");
    expect(empty.size).toBe(0);
    expect([...withA]).toEqual(["a"]);
    const withoutA = toggleSelected(withA, "a");
    expect([...withoutA]).toEqual([]);
  });

  it("resolves the batch to only selected + still-loadable ids", () => {
    const list = [
      u("a", "in_warehouse"),
      u("b", "loaded"), // selected but no longer loadable -> dropped
      u("c", "staged"),
    ];
    const selected = new Set(["a", "b"]);
    expect(selectedLoadableIds(list, selected)).toEqual(["a"]);
  });

  it("returns nothing when the selection is empty", () => {
    const list = [u("a", "in_warehouse")];
    expect(selectedLoadableIds(list, new Set())).toEqual([]);
  });
});

describe("computeReorderNeeds", () => {
  const units: ReorderUnitLike[] = [
    { id: "w1", window_type_id: "t-cas", status: "damaged" },
    { id: "w2", window_type_id: "t-cas", status: "installed" },
    { id: "w3", window_type_id: "t-dh", status: "pre_issued" },
    { id: "w4", window_type_id: "t-dh", status: "pre_issued" },
    { id: "w5", window_type_id: "t-slider", status: "in_warehouse" },
  ];
  const issues: MissingIssueLike[] = [
    { window_id: "w3", kind: "missing", status: "open" },
    { window_id: "w4", kind: "missing", status: "open" },
    // resolved / wrong-kind / opening-level issues are ignored:
    { window_id: "w1", kind: "damage", status: "open" },
    { window_id: "w3", kind: "missing", status: "resolved" },
    { window_id: null, kind: "missing", status: "open" },
  ];

  it("rolls damaged units and open missing issues into per-type needs", () => {
    const rows = computeReorderNeeds(units, issues);
    expect(rows).toEqual([
      { window_type_id: "t-cas", missing_count: 0, damaged_count: 1 },
      { window_type_id: "t-dh", missing_count: 2, damaged_count: 0 },
    ]);
  });

  it("omits types with no shortfall", () => {
    const rows = computeReorderNeeds(units, issues);
    expect(rows.some((r) => r.window_type_id === "t-slider")).toBe(false);
  });

  it("counts a type with both a missing delivery and a damaged unit", () => {
    const rows = computeReorderNeeds(
      [
        { id: "w1", window_type_id: "t-x", status: "damaged" },
        { id: "w2", window_type_id: "t-x", status: "pre_issued" },
      ],
      [{ window_id: "w2", kind: "missing", status: "open" }],
    );
    expect(rows).toEqual([
      { window_type_id: "t-x", missing_count: 1, damaged_count: 1 },
    ]);
  });

  it("totals the shortfall across all types", () => {
    expect(totalReorder(computeReorderNeeds(units, issues))).toBe(3);
    expect(totalReorder([])).toBe(0);
  });

  it("is empty when nothing is damaged or missing", () => {
    expect(
      computeReorderNeeds(
        [{ id: "w1", window_type_id: "t", status: "in_warehouse" }],
        [],
      ),
    ).toEqual([]);
  });
});
