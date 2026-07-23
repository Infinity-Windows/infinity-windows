import { describe, expect, it } from "vitest";
import {
  allIdsSelected,
  clampReceiveCount,
  pruneSelection,
  runBulkSequential,
  toggleAllIds,
  toggleId,
} from "./bulk";

describe("selection helpers", () => {
  it("toggles an id immutably", () => {
    const empty = new Set<string>();
    const withA = toggleId(empty, "a");
    expect(empty.size).toBe(0);
    expect([...withA]).toEqual(["a"]);
    expect([...toggleId(withA, "a")]).toEqual([]);
  });

  it("reports all-selected only when non-empty and fully covered", () => {
    expect(allIdsSelected([], new Set())).toBe(false);
    expect(allIdsSelected(["a", "b"], new Set(["a"]))).toBe(false);
    expect(allIdsSelected(["a", "b"], new Set(["a", "b"]))).toBe(true);
    // Extra selected ids that are not in the list don't matter.
    expect(allIdsSelected(["a"], new Set(["a", "z"]))).toBe(true);
  });

  it("select-all toggles between everything and nothing", () => {
    const ids = ["a", "b", "c"];
    const all = toggleAllIds(ids, new Set());
    expect([...all].sort()).toEqual(["a", "b", "c"]);
    expect([...toggleAllIds(ids, all)]).toEqual([]);
    // Partial selection selects the rest.
    expect([...toggleAllIds(ids, new Set(["a"]))].sort()).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("prunes ids that left the list", () => {
    expect([...pruneSelection(["a", "c"], new Set(["a", "b", "c"]))].sort()).toEqual(
      ["a", "c"],
    );
    expect([...pruneSelection([], new Set(["a"]))]).toEqual([]);
  });
});

describe("clampReceiveCount", () => {
  it("clamps to [1, max] and floors fractions", () => {
    expect(clampReceiveCount(0)).toBe(1);
    expect(clampReceiveCount(-4)).toBe(1);
    expect(clampReceiveCount(3.9)).toBe(3);
    expect(clampReceiveCount(999)).toBe(50);
    expect(clampReceiveCount(999, 10)).toBe(10);
    expect(clampReceiveCount(Number.NaN)).toBe(1);
  });
});

describe("runBulkSequential", () => {
  it("collects every success in order", async () => {
    const res = await runBulkSequential(3, async (i) => i * 2);
    expect(res.successes).toEqual([0, 2, 4]);
    expect(res.failures).toEqual([]);
  });

  it("captures partial failures without aborting the run", async () => {
    const res = await runBulkSequential(4, async (i) => {
      if (i === 1) throw new Error("boom");
      return `ok-${i}`;
    });
    expect(res.successes).toEqual(["ok-0", "ok-2", "ok-3"]);
    expect(res.failures.map((f) => f.index)).toEqual([1]);
    expect(String((res.failures[0].error as Error).message)).toContain("boom");
  });

  it("runs sequentially (never overlapping)", async () => {
    let active = 0;
    let maxActive = 0;
    await runBulkSequential(5, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active -= 1;
    });
    expect(maxActive).toBe(1);
  });

  it("does nothing for a count of zero", async () => {
    const res = await runBulkSequential(0, async () => "x");
    expect(res.successes).toEqual([]);
    expect(res.failures).toEqual([]);
  });
});
