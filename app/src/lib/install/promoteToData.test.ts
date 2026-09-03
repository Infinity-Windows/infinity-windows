// promoteProjectToData is the one door for "Build this out" (standard-tracking-
// jobs slice 6). Two things must hold: it calls the promote RPC with NOTHING but
// the project id — so it structurally cannot touch a job's logged time, photos,
// daily logs, cost codes or summons — and a server refusal (e.g. an installer,
// whom _is_lead turns away) surfaces as a clean install-formatted sentence, not
// raw PostgREST.

import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  rpc: [] as { fn: string; args: Record<string, unknown> }[],
  next: { data: null as unknown, error: null as unknown },
}));

vi.mock("../supabase", () => ({
  supabase: {
    rpc: (fn: string, args: Record<string, unknown>) => {
      db.rpc.push({ fn, args });
      return Promise.resolve(db.next);
    },
  },
  supabaseConfigured: true,
}));

import { promoteProjectToData } from "./api";

describe("promoteProjectToData", () => {
  beforeEach(() => {
    db.rpc = [];
    db.next = { data: null, error: null };
  });

  it("calls promote_project_to_data with only the project id and returns the promoted row", async () => {
    db.next = {
      data: { id: "p1", job_code: "TRACK01", allowed_modes: ["data", "tracking"] },
      error: null,
    };

    const project = await promoteProjectToData("p1");

    // The RPC carries the project id and nothing else — it cannot delete or hide
    // any project-scoped record, which is why the job's history is safe.
    expect(db.rpc).toEqual([
      { fn: "promote_project_to_data", args: { p_project_id: "p1" } },
    ]);
    // The returned row already reads as data-capable, so the caller need not
    // re-fetch to flip the tabs.
    expect(project.allowed_modes).toEqual(["data", "tracking"]);
  });

  it("surfaces a foreman-only refusal as a clean sentence, not raw PostgREST", async () => {
    db.next = {
      data: null,
      error: {
        message: "only a foreman or above can build a job out into a data job",
        code: "P0001",
      },
    };

    await expect(promoteProjectToData("p1")).rejects.toThrow(
      /only a foreman or above can build a job out/i,
    );
    // Never the literal "[object Object]" the crew used to see.
    await expect(promoteProjectToData("p1")).rejects.not.toThrow(/\[object Object\]/);
  });
});
