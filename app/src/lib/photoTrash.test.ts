import { beforeEach, describe, expect, it, vi } from "vitest";

// deleteJobPhoto / restoreJobPhoto call supabase.rpc; the rest of photos.ts is
// pure or storage-bound. Mock the client the same indirected way timeclock.test
// does, so the factory closes over the spy safely.
const rpc = vi.fn();
vi.mock("./supabase", () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpc(...args),
    from: () => ({}),
    storage: { from: () => ({}) },
  },
  supabaseConfigured: true,
}));

import { deleteJobPhoto, restoreJobPhoto } from "./photos";

beforeEach(() => rpc.mockReset());

describe("job-photo trash (slice 3)", () => {
  it("deleteJobPhoto calls soft_delete_job_photo with the id", async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    await deleteJobPhoto("photo-1");
    expect(rpc).toHaveBeenCalledWith("soft_delete_job_photo", { p_id: "photo-1" });
  });

  it("restoreJobPhoto calls restore_job_photo with the id", async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    await restoreJobPhoto("photo-1");
    expect(rpc).toHaveBeenCalledWith("restore_job_photo", { p_id: "photo-1" });
  });

  it("surfaces the server error rather than swallowing it", async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { message: "the 30 days are up — this photo is gone for good" },
    });
    await expect(restoreJobPhoto("photo-1")).rejects.toMatchObject({
      message: expect.stringContaining("30 days are up"),
    });
  });
});
