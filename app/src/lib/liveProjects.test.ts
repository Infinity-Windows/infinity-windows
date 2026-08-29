import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
vi.mock("./supabase", () => ({
  supabase: { rpc: (...args: unknown[]) => rpc(...args) },
}));

import { filterToLiveProjects } from "./liveProjects";

describe("filterToLiveProjects", () => {
  beforeEach(() => {
    rpc.mockReset();
  });

  it("returns immediately with no RPC call when the list is empty", async () => {
    const result = await filterToLiveProjects([]);
    expect(result).toEqual([]);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("calls live_project_ids once with the distinct project ids, never per row", async () => {
    rpc.mockResolvedValue({ data: ["a", "b"], error: null });
    const rows = [
      { id: 1, project_id: "a" },
      { id: 2, project_id: "a" },
      { id: 3, project_id: "b" },
    ];
    await filterToLiveProjects(rows);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("live_project_ids", { p_ids: ["a", "b"] });
  });

  it("drops rows whose project is not in the live set", async () => {
    rpc.mockResolvedValue({ data: ["a"], error: null });
    const rows = [
      { id: 1, project_id: "a" },
      { id: 2, project_id: "b" },
    ];
    const result = await filterToLiveProjects(rows);
    expect(result).toEqual([{ id: 1, project_id: "a" }]);
  });

  it("keeps a row with no project at all — nothing to be trashed", async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    const rows = [{ id: 1, project_id: null }];
    const result = await filterToLiveProjects(rows);
    expect(result).toEqual(rows);
  });

  it("throws the raw error on an RPC failure — formatApiError handles it upstream", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "boom" } });
    await expect(filterToLiveProjects([{ id: 1, project_id: "a" }])).rejects.toEqual({ message: "boom" });
  });
});
