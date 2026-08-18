// The live (online) half of the supply-take guard — warehouse audit F1.
//
// A phone cannot tell "the server never got it" from "the server got it and
// the answer never came back". Both raise the same network error, and both
// end with the take sitting in the outbox waiting to be sent again. The only
// thing that stops the second send from subtracting a second time is the key
// this call carries, so the key is not optional and never invented late.
//
// The queued half of the same guard is proved in
// ../offline/supplyOutboxHandler.test.ts; that they are the SAME key is
// proved in ./offlineWrites.test.ts.

import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
vi.mock("../supabase", () => ({
  supabase: { rpc: (...args: unknown[]) => rpc(...args) },
  supabaseConfigured: true,
}));

const { takeSupply } = await import("../ops");

beforeEach(() => {
  rpc.mockReset();
});

describe("takeSupply", () => {
  it("sends the key with every take, under the name the function expects", async () => {
    rpc.mockResolvedValue({ data: { id: "supply-1", on_hand: 96 }, error: null });

    await takeSupply({
      supplyId: "supply-1",
      projectId: "job-1",
      qty: 4,
      clientId: "6f1e1b2c-6a4d-4f0e-9c31-2b1d7c0a55aa",
    });

    expect(rpc).toHaveBeenCalledWith("take_supply", {
      p_supply: "supply-1",
      p_project: "job-1",
      p_qty: 4,
      p_client_id: "6f1e1b2c-6a4d-4f0e-9c31-2b1d7c0a55aa",
    });
  });

  it("hands back the row the server answered with", async () => {
    rpc.mockResolvedValue({ data: { id: "supply-1", on_hand: 96 }, error: null });
    const row = await takeSupply({
      supplyId: "supply-1",
      projectId: "job-1",
      qty: 4,
      clientId: "6f1e1b2c-6a4d-4f0e-9c31-2b1d7c0a55aa",
    });
    expect(row).toEqual({ id: "supply-1", on_hand: 96 });
  });

  it("throws what the server said instead of swallowing it", async () => {
    rpc.mockResolvedValue({ data: null, error: new Error("pick the job this is for") });
    await expect(
      takeSupply({
        supplyId: "supply-1",
        projectId: "",
        qty: 4,
        clientId: "6f1e1b2c-6a4d-4f0e-9c31-2b1d7c0a55aa",
      }),
    ).rejects.toThrow("pick the job this is for");
  });
});
