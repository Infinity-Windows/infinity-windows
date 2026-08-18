import { describe, expect, it, vi } from "vitest";

/**
 * The pre-load has to warm the SAME queries the warehouse page reads — all of
 * them, not most of them (F6).
 *
 * The staged-for-a-job label ("staged for BLACK22" instead of "on a shelf")
 * needs the racks-and-bays list. The page reads it under ["locations"]. The
 * pack warmed packages, containers, projects, issues and marks, and skipped
 * that one — so with no signal every staged package went back to reading "on a
 * shelf", in the conex the pack exists for. A pack that covers four of five
 * queries looks like it works right up until the moment it matters.
 *
 * This asserts on the cache, not on the source text: what matters is that the
 * key the page reads is populated, however the pack chooses to fill it.
 */

const LOCATIONS = [{ id: "bay-1", address: "J-BLACK22-A" }];

vi.mock("./api", () => ({
  listProjects: async () => [],
  listLocations: async () => LOCATIONS,
  getProjectUnits: async () => [],
  getProjectWindows: async () => [],
}));
vi.mock("./storage", () => ({
  listActivePackages: async () => [],
  listContainers: async () => [],
}));
vi.mock("./issues", () => ({ listIssues: async () => [] }));
vi.mock("./warehouse/warehouseCards", () => ({ listScheduledMarks: async () => [] }));
vi.mock("./install/api", () => ({
  getTypeBrainStats: async () => ({}),
  listOpenings: async () => [],
  listPlansets: async () => [],
}));

const { prefetchWarehousePack, queryClient } = await import("./queryClient");

describe("the warehouse pre-load", () => {
  it("warms every query the page needs to say where something is", async () => {
    await prefetchWarehousePack();

    // The four it always had.
    for (const key of ["projects", "storagePackages", "storageContainers", "issues"]) {
      expect(queryClient.getQueryData([key]), `${key} was not warmed`).toBeDefined();
    }
    // The one it was missing, and the reason this test exists.
    expect(
      queryClient.getQueryData(["locations"]),
      "no locations in the cache — a staged package reads 'on a shelf' offline",
    ).toEqual(LOCATIONS);
  });
});
