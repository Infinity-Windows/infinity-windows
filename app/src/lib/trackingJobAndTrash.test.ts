// createTrackingJob makes a tracking-ONLY job (reusing createProject then
// flipping modes), and restore_project brings one back inside 30 days
// (standard-tracking-jobs slice 5).

import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  inserts: [] as Record<string, unknown>[],
  rpc: [] as { fn: string; args: Record<string, unknown> }[],
}));

vi.mock("./supabase", () => {
  const builder: Record<string, unknown> = {};
  builder.insert = (row: Record<string, unknown>) => {
    db.inserts.push(row);
    return builder;
  };
  builder.select = () => builder;
  builder.single = () =>
    Promise.resolve({
      // Echo the last insert back as the created row, allowed_modes at its
      // column default so we can prove createTrackingJob overrides it.
      data: {
        id: "newp",
        ...db.inserts[db.inserts.length - 1],
        allowed_modes: ["data"],
      },
      error: null,
    });
  return {
    supabase: {
      from: () => builder,
      rpc: (fn: string, args: Record<string, unknown>) => {
        db.rpc.push({ fn, args });
        return Promise.resolve({ data: { id: "newp" }, error: null });
      },
    },
    supabaseConfigured: true,
  };
});

import { createTrackingJob, restoreProject } from "./api";
import { daysLeftInTrash } from "./projectTrash";

describe("createTrackingJob", () => {
  beforeEach(() => {
    db.inserts = [];
    db.rpc = [];
  });

  it("inserts a job and then sets its modes to tracking only", async () => {
    const project = await createTrackingJob({ name: "Warranty callback", address: "123 Main" });

    // One project insert, with a sanitised job_code and the given name/address.
    expect(db.inserts).toHaveLength(1);
    const insert = db.inserts[0];
    expect(insert.name).toBe("Warranty callback");
    expect(insert.address).toBe("123 Main");
    expect(String(insert.job_code)).toMatch(/^[A-Z0-9-]+$/);

    // Then the ONE legal writer of allowed_modes flips it to tracking.
    expect(db.rpc).toHaveLength(1);
    expect(db.rpc[0].fn).toBe("set_project_modes");
    expect(db.rpc[0].args).toEqual({ p_project_id: "newp", p_modes: ["tracking"] });

    // The returned row reads as tracking without a re-fetch.
    expect(project.allowed_modes).toEqual(["tracking"]);
  });

  it("auto-names from the address when the name is left blank", async () => {
    await createTrackingJob({ name: "  ", address: "456 Oak Ave" });
    expect(db.inserts[0].name).toBe("456 Oak Ave");
  });
});

describe("restoreProject within 30 days", () => {
  beforeEach(() => {
    db.rpc = [];
  });

  it("calls restore_project by id", async () => {
    await restoreProject("p1");
    expect(db.rpc).toEqual([{ fn: "restore_project", args: { p_project_id: "p1" } }]);
  });

  it("has undo time left for the whole window and none at the deadline", () => {
    const now = Date.parse("2026-09-30T12:00:00Z");
    const threeDaysAgo = "2026-09-27T12:00:00Z";
    const thirtyDaysAgo = "2026-08-31T12:00:00Z";
    expect(daysLeftInTrash(threeDaysAgo, now)).toBe(27);
    expect(daysLeftInTrash(thirtyDaysAgo, now)).toBe(0);
  });
});
