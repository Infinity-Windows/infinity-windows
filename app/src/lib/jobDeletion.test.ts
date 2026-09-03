// Delete a job: supervisor+, reason required, every supervisor told
// (standard-tracking-jobs slice 5).

import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ rpc: [] as { fn: string; args: Record<string, unknown> }[] }));
const profilesHolder = vi.hoisted(() => ({ rows: [] as { id: string; role: string }[] }));
const meHolder = vi.hoisted(() => ({ row: null as { id: string; display_name: string; role: string } | null }));
const push = vi.hoisted(() => ({ calls: [] as Record<string, unknown>[], returns: true }));

vi.mock("./supabase", () => ({
  supabase: {
    rpc: (fn: string, args: Record<string, unknown>) => {
      db.rpc.push({ fn, args });
      return Promise.resolve({
        data: { id: "p1", job_code: "PECAN14", name: "Pecan Valley" },
        error: null,
      });
    },
  },
  supabaseConfigured: true,
}));
vi.mock("./install/api", () => ({
  listProfiles: () => Promise.resolve(profilesHolder.rows),
  getRealProfile: () => Promise.resolve(meHolder.row),
}));
vi.mock("./permissions/pushServer", () => ({
  sendPush: (input: Record<string, unknown>) => {
    push.calls.push(input);
    return Promise.resolve(push.returns);
  },
}));

import { deleteJob, notifyJobDeleted, supervisorIds } from "./jobDeletion";

const ALL = [
  { id: "i1", role: "installer" },
  { id: "f1", role: "foreman" },
  { id: "s1", role: "supervisor" },
  { id: "o1", role: "owner" },
];

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("supervisorIds", () => {
  it("is exactly the supervisor+ profiles", () => {
    expect(supervisorIds(ALL).sort()).toEqual(["o1", "s1"]);
  });
  it("is empty when nobody outranks a foreman", () => {
    expect(supervisorIds([{ id: "i1", role: "installer" }, { id: "f1", role: "foreman" }])).toEqual([]);
  });
});

describe("notifyJobDeleted", () => {
  beforeEach(() => {
    push.calls = [];
    push.returns = true;
    profilesHolder.rows = ALL;
    meHolder.row = { id: "s1", display_name: "Sam", role: "supervisor" };
  });

  it("pushes to every supervisor with who, what, and why", async () => {
    const ok = await notifyJobDeleted(
      { id: "p1", job_code: "PECAN14", name: "Pecan Valley" },
      "duplicate callback",
    );
    expect(ok).toBe(true);
    expect(push.calls).toHaveLength(1);
    expect((push.calls[0].profileIds as string[]).sort()).toEqual(["o1", "s1"]);
    const body = String(push.calls[0].body);
    expect(body).toContain("Sam"); // who
    expect(body).toContain("PECAN14"); // what
    expect(body).toContain("Pecan Valley"); // what
    expect(body).toContain("duplicate callback"); // why
  });

  it("rings no one, and does not throw, when there are no supervisors", async () => {
    profilesHolder.rows = [{ id: "i1", role: "installer" }];
    expect(await notifyJobDeleted({ id: "p1", job_code: "X", name: "X" }, "why")).toBe(false);
    expect(push.calls).toHaveLength(0);
  });
});

describe("deleteJob", () => {
  beforeEach(() => {
    db.rpc = [];
    push.calls = [];
    profilesHolder.rows = ALL;
    meHolder.row = { id: "s1", display_name: "Sam", role: "supervisor" };
  });

  it("trashes through trash_project with the trimmed reason", async () => {
    await deleteJob("p1", "  duplicate  ");
    expect(db.rpc).toHaveLength(1);
    expect(db.rpc[0].fn).toBe("trash_project");
    expect(db.rpc[0].args).toEqual({ p_project_id: "p1", p_reason: "duplicate" });
  });

  it("refuses a blank reason before it ever writes", async () => {
    await expect(deleteJob("p1", "   ")).rejects.toThrow(/reason/i);
    expect(db.rpc).toHaveLength(0);
  });

  it("notifies every supervisor after the delete", async () => {
    await deleteJob("p1", "duplicate");
    await flush(); // the notice is fire-and-forget
    expect(push.calls).toHaveLength(1);
    expect((push.calls[0].profileIds as string[]).sort()).toEqual(["o1", "s1"]);
  });
});
