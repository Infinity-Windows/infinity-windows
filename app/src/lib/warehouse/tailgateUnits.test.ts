import { describe, expect, it } from "vitest";
import type { JobGroup, SlotRow } from "./deliveryReceiving";
import { looseOnTruck, tailgateUnits, tickOf, truckHeadline } from "./tailgateUnits";

function slot(over: Partial<SlotRow> & { mark: string; allIds: string[]; expectedIds?: string[]; looseIds?: string[] }): SlotRow {
  const expectedIds = over.expectedIds ?? [];
  const looseIds = over.looseIds ?? [];
  const stored = over.allIds.length - expectedIds.length - looseIds.length;
  return {
    key: over.key ?? `${over.mark}|${over.partType ?? ""}`,
    label: over.label ?? `#${over.mark}`,
    mark: over.mark,
    isCrate: over.isCrate ?? false,
    partType: over.partType ?? null,
    expected: expectedIds.length,
    received: looseIds.length,
    stored,
    expectedIds,
    looseIds,
    crateContainerId: null,
    undoableIds: looseIds,
    allIds: over.allIds,
  } as SlotRow;
}
const group = (key: string, projectId: string | null, rows: SlotRow[]): JobGroup => ({
  key, projectId, pendingJobName: projectId ? null : "Sunset Ridge 4", rows, unfiledIds: [],
});
const title = (id: string) => (id === "j1" ? "BLACK22" : null);

describe("one row per unit", () => {
  it("folds a window's part slots into one row with one dot per piece", () => {
    const rows = tailgateUnits(
      [group("j1", "j1", [
        slot({ mark: "16", partType: "frame", allIds: ["a"], looseIds: ["a"] }),
        slot({ mark: "16", partType: "glass", allIds: ["b"], expectedIds: ["b"] }),
        slot({ mark: "16", partType: "hardware", allIds: ["c"] }),
      ])],
      title,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("BLACK22 · #16");
    expect(rows[0].sub).toBe("3 pieces · frame, glass, hardware");
    expect(rows[0].pieces.map((p) => p.state)).toEqual(["arrived", "expected", "stored"]);
    expect(tickOf(rows[0])).toBe("some");
  });
  it("counts identical units as twins on one row", () => {
    const rows = tailgateUnits(
      [group("pending:Sunset Ridge 4", null, [
        slot({ mark: "5050", partType: null, allIds: ["a", "b", "c"], expectedIds: ["a", "b", "c"] }),
      ])],
      title,
    );
    expect(rows[0].twins).toBe(3);
    expect(rows[0].jobLabel).toBe("Sunset Ridge 4");
    expect(rows[0].sub).toBe("1 piece");
    expect(tickOf(rows[0])).toBe("none");
  });
  it("a unit with everything here is ticked", () => {
    const rows = tailgateUnits([group("j1", "j1", [slot({ mark: "2", allIds: ["a"], looseIds: ["a"] })])], title);
    expect(tickOf(rows[0])).toBe("all");
  });
});

describe("the truck as a whole", () => {
  const rows = tailgateUnits(
    [group("j1", "j1", [
      slot({ mark: "16", allIds: ["a", "b"], looseIds: ["a"], expectedIds: ["b"] }),
      slot({ mark: "17", allIds: ["c"] }),
    ])],
    title,
  );
  it("knows what arrived and is not put away", () => {
    expect(looseOnTruck(rows)).toEqual(["a"]);
  });
  it("says how much is here", () => {
    expect(truckHeadline(rows)).toBe("2 of 3 arrived · 1 still missing");
    expect(truckHeadline([])).toMatch(/Nothing expected/);
  });
});
