import { describe, expect, it } from "vitest";
import {
  filterInventory,
  INVENTORY_VIEWS,
  inventoryCounts,
  NOT_IN_INVENTORY,
  parseInventoryView,
  sortInventory,
  unitsWithOpenDamage,
} from "./inventoryViews";
import type { WindowStatus } from "./types";

const unit = (status: WindowStatus) => ({ status });

// One of every status the app knows about, so a new status can never quietly
// fall out of "on hand" without a test noticing.
const EVERY_STATUS: WindowStatus[] = [
  "pre_issued",
  "inbound",
  "in_warehouse",
  "staged",
  "loaded",
  "installed",
  "damaged",
  "on_site",
];

describe("inventory view definitions", () => {
  it("counts on hand as everything not installed and not on a truck", () => {
    const units = EVERY_STATUS.map(unit);
    const onHand = filterInventory(units, "on-hand").map((u) => u.status);
    expect(onHand).toEqual(
      EVERY_STATUS.filter((s) => !NOT_IN_INVENTORY.includes(s)),
    );
    expect(onHand).not.toContain("installed");
    expect(onHand).not.toContain("loaded");
  });

  it("puts each status in the right list", () => {
    const units = EVERY_STATUS.map(unit);
    expect(filterInventory(units, "putaway").map((u) => u.status)).toEqual([
      "inbound",
    ]);
    expect(filterInventory(units, "staged").map((u) => u.status)).toEqual([
      "staged",
    ]);
    expect(filterInventory(units, "damaged").map((u) => u.status)).toEqual([
      "damaged",
    ]);
  });

  it("keeps every card's number equal to the length of its own list", () => {
    const units = [
      ...EVERY_STATUS.map(unit),
      unit("inbound"),
      unit("staged"),
      unit("damaged"),
      unit("in_warehouse"),
    ];
    const counts = inventoryCounts(units);
    for (const view of INVENTORY_VIEWS) {
      expect(counts[view.id], view.id).toBe(filterInventory(units, view.id).length);
    }
  });

  it("keeps the three sub-lists inside on hand", () => {
    const counts = inventoryCounts(EVERY_STATUS.map(unit));
    expect(counts["on-hand"]).toBeGreaterThanOrEqual(
      counts.putaway + counts.staged + counts.damaged,
    );
  });

  it("reports zero rather than blowing up on an empty warehouse", () => {
    expect(inventoryCounts([])).toEqual({
      "on-hand": 0,
      putaway: 0,
      staged: 0,
      damaged: 0,
    });
  });
});

describe("parseInventoryView", () => {
  it("resolves each of the four URL segments", () => {
    for (const view of INVENTORY_VIEWS) {
      expect(parseInventoryView(view.id)?.id).toBe(view.id);
    }
  });

  it("rejects anything else so a bad deep link can be redirected", () => {
    expect(parseInventoryView("everything")).toBeNull();
    expect(parseInventoryView("")).toBeNull();
    expect(parseInventoryView(undefined)).toBeNull();
  });
});

describe("sortInventory", () => {
  const u = (window_id: string, address?: string) => ({
    window_id,
    locations: address ? { address } : null,
  });

  it("walks the racks in address order", () => {
    const rows = sortInventory([u("W-3", "R-02-A"), u("W-1", "R-01-B"), u("W-2", "R-01-A")]);
    expect(rows.map((r) => r.window_id)).toEqual(["W-2", "W-1", "W-3"]);
  });

  it("drops units with no slot to the bottom, where somebody must hunt for them", () => {
    const rows = sortInventory([u("W-9"), u("W-4", "R-01-A"), u("W-2")]);
    expect(rows.map((r) => r.window_id)).toEqual(["W-4", "W-2", "W-9"]);
  });

  it("does not mutate the list it was given", () => {
    const input = [u("W-2", "R-02"), u("W-1", "R-01")];
    sortInventory(input);
    expect(input.map((r) => r.window_id)).toEqual(["W-2", "W-1"]);
  });
});

describe("unitsWithOpenDamage", () => {
  it("picks out only open damage issues that point at a unit", () => {
    const ids = unitsWithOpenDamage([
      { window_id: "u1", kind: "damage", status: "open" },
      { window_id: "u2", kind: "damage", status: "resolved" },
      { window_id: "u3", kind: "missing", status: "open" },
      { window_id: null, kind: "damage", status: "open" },
    ]);
    expect([...ids]).toEqual(["u1"]);
  });

  it("is empty when there are no issues at all", () => {
    expect(unitsWithOpenDamage([]).size).toBe(0);
  });
});
