// Wave A, A1/A5: the saved-crews client is a thin call-through — every real
// rule (name length, 2-6 members, active profiles, supervisor+) is enforced
// server-side in save_crew/delete_crew
// (supabase/migrations/20260955000000_saved_crews.sql). What THIS file has
// to get right is the payload shape: the RPC argument names the SQL function
// actually declares (p_id/p_name/p_members/p_note), and that a create
// (no id) sends p_id: null rather than omitting it or sending undefined.

import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
const order = vi.fn();
vi.mock("../supabase", () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpc(...args),
    from: (table: string) => ({
      select: () => ({
        order: (...args: unknown[]) => order(table, ...args),
      }),
    }),
  },
  supabaseConfigured: true,
}));

const { deleteCrew, listSavedCrews, saveCrew } = await import("./savedCrews");

beforeEach(() => {
  rpc.mockReset();
  order.mockReset();
});

describe("saveCrew", () => {
  it("creates with p_id: null, never omitted or undefined", async () => {
    rpc.mockResolvedValue({
      data: { id: "crew-1", name: "Team 1", member_ids: ["a", "b"], note: null },
      error: null,
    });

    await saveCrew({ name: "Team 1", memberIds: ["a", "b"] });

    expect(rpc).toHaveBeenCalledWith("save_crew", {
      p_id: null,
      p_name: "Team 1",
      p_members: ["a", "b"],
      p_note: null,
    });
  });

  it("updates by passing the existing id straight through", async () => {
    rpc.mockResolvedValue({ data: {}, error: null });

    await saveCrew({
      id: "crew-1",
      name: "Team 1 (renamed)",
      memberIds: ["a", "b", "c"],
      note: "Keeps Sand Hollow crews together",
    });

    expect(rpc).toHaveBeenCalledWith("save_crew", {
      p_id: "crew-1",
      p_name: "Team 1 (renamed)",
      p_members: ["a", "b", "c"],
      p_note: "Keeps Sand Hollow crews together",
    });
  });

  it("hands back the row the server returned", async () => {
    const row = { id: "crew-1", name: "Team 1", member_ids: ["a", "b"], note: null };
    rpc.mockResolvedValue({ data: row, error: null });
    await expect(saveCrew({ name: "Team 1", memberIds: ["a", "b"] })).resolves.toEqual(row);
  });

  it("throws the server's own reason rather than swallowing it — e.g. the foreman refusal", async () => {
    rpc.mockResolvedValue({
      data: null,
      error: new Error("only a supervisor or above can manage saved crews"),
    });
    await expect(saveCrew({ name: "Team 1", memberIds: ["a", "b"] })).rejects.toThrow(
      "only a supervisor or above can manage saved crews",
    );
  });
});

describe("deleteCrew", () => {
  it("sends the id under the name the SQL function declares", async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    await deleteCrew("crew-1");
    expect(rpc).toHaveBeenCalledWith("delete_crew", { p_id: "crew-1" });
  });

  it("throws on a server error", async () => {
    rpc.mockResolvedValue({ data: null, error: new Error("nope") });
    await expect(deleteCrew("crew-1")).rejects.toThrow("nope");
  });
});

describe("listSavedCrews", () => {
  it("reads the saved_crews table, ordered by name", async () => {
    const rows = [{ id: "crew-1", name: "Team 1", member_ids: ["a", "b"], note: null }];
    order.mockResolvedValue({ data: rows, error: null });
    await expect(listSavedCrews()).resolves.toEqual(rows);
    expect(order).toHaveBeenCalledWith("saved_crews", "name");
  });

  it("degrades to an empty list rather than null", async () => {
    order.mockResolvedValue({ data: null, error: null });
    await expect(listSavedCrews()).resolves.toEqual([]);
  });
});
