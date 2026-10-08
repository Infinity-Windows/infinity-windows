import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  rows: [] as { project_id: string; planset_id: string; mark_code: string }[],
  rpc: vi.fn(),
}));

vi.mock("../supabase", () => ({
  supabase: {
    rpc: db.rpc,
    from: () => {
      throw new Error("Drawing references must use the scoped replacement RPC");
    },
  },
}));

import { saveElevationViews } from "./api";

beforeEach(() => {
  db.rows = [
    { project_id: "pv40", planset_id: "vinyl", mark_code: "V1" },
    { project_id: "pv40", planset_id: "aluminum", mark_code: "A1" },
    { project_id: "other-job", planset_id: "vinyl", mark_code: "X1" },
  ];
  db.rpc.mockReset();
  db.rpc.mockImplementation(async (name, args) => {
    expect(name).toBe("replace_planset_elevation_views");
    db.rows = db.rows.filter(
      (row) => row.project_id !== args.p_project_id || row.planset_id !== args.p_planset_id,
    );
    db.rows.push(...args.p_rows.map((row: { mark_code: string }) => ({
      project_id: args.p_project_id,
      planset_id: args.p_planset_id,
      mark_code: row.mark_code,
    })));
    return { data: args.p_rows.length, error: null };
  });
});

describe("re-reading one drawing set's elevation references", () => {
  it("keeps the other drawing set and other jobs when this set has no references", async () => {
    expect(await saveElevationViews("pv40", "vinyl", [])).toEqual({ saved: 0 });
    expect(db.rpc).toHaveBeenCalledWith("replace_planset_elevation_views", {
      p_project_id: "pv40",
      p_planset_id: "vinyl",
      p_rows: [],
    });
    expect(db.rows).toEqual([
      { project_id: "pv40", planset_id: "aluminum", mark_code: "A1" },
      { project_id: "other-job", planset_id: "vinyl", mark_code: "X1" },
    ]);
  });
});
