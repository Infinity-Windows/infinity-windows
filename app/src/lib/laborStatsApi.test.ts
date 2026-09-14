import { beforeEach, describe, expect, it, vi } from "vitest";
const range = vi.hoisted(() => vi.fn());
vi.mock("./supabase", () => {
  const chain: Record<string, unknown> = {};
  for (const name of ["select", "neq", "order"]) chain[name] = () => chain;
  chain.range = range;
  return { supabase: { from: () => chain } };
});
import { listLaborStatsShifts } from "./laborStatsApi";
beforeEach(() => range.mockReset());

describe("complete labor history", () => {
  it("continues past a server row cap smaller than the requested page", async () => {
    range.mockResolvedValueOnce({ data: [{ id: "1" }], count: 2 }).mockResolvedValueOnce({ data: [{ id: "2" }], count: 2 });
    expect(await listLaborStatsShifts()).toHaveLength(2);
    expect(range).toHaveBeenNthCalledWith(2, 1, 500);
  });
  it("accepts a confirmed empty result", async () => {
    range.mockResolvedValue({ data: [], count: 0 });
    expect(await listLaborStatsShifts()).toEqual([]);
  });
  it.each([
    [{ data: [{ id: "1" }], count: 2 }, { data: [], count: 2 }],
    [{ data: [{ id: "1" }], count: 2 }, { data: [{ id: "1" }], count: 2 }],
    [{ data: [{ id: "1" }], count: 2 }, { data: [{ id: "2" }], count: 3 }],
  ])("refuses partial or changing page results", async (first, second) => {
    range.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    await expect(listLaborStatsShifts()).rejects.toThrow();
  });
  it("does not disguise a failed read as zero hours", async () => {
    range.mockResolvedValue({ error: { code: "42501" } });
    await expect(listLaborStatsShifts()).rejects.toEqual({ code: "42501" });
  });
});
