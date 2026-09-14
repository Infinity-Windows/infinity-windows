import { beforeEach, describe, expect, it, vi } from "vitest";
const rpc = vi.hoisted(() => vi.fn());
vi.mock("./supabase", () => ({ supabase: { rpc } }));
import { stgCalendar, stgDay, stgJobList } from "./stg";

describe("partner projection availability", () => {
  beforeEach(() => rpc.mockReset());
  it("distinguishes an undeployed portal from a login with no grants", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "PGRST202" } });
    await expect(stgJobList()).rejects.toThrow("finish the portal setup");
    await expect(stgCalendar("2026-09-01", "2026-09-30")).rejects.toThrow("finish the portal setup");
    await expect(stgDay("job", "2026-09-14")).rejects.toThrow("finish the portal setup");
    rpc.mockResolvedValue({ data: [], error: null });
    await expect(stgJobList()).resolves.toEqual([]);
  });
  it("preserves server permission rejections", async () => {
    const error = { code: "42501", message: "not granted" };
    rpc.mockResolvedValue({ data: null, error });
    await expect(stgDay("foreign-job", "2026-09-14")).rejects.toEqual(error);
  });
});
