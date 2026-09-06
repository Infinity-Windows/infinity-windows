import { describe, expect, it } from "vitest";
import type { StoragePackage } from "../storage";
import type { JobTally } from "./jobTally";
import { boxesForJob, jobChips } from "./jobStrip";

const tally = (over: Partial<JobTally>): JobTally => ({
  projectId: "j1", label: "ESH-18", totalUnits: 27, loggedUnits: 27, remainingUnits: 0, ...over,
});
const pkg = (id: string, container: string | null, project: string | null, status = "stored", pending: string | null = null): StoragePackage => ({
  id, serial: `PKG-${id}`, short_code: null, status: status as StoragePackage["status"], project_id: project,
  pending_job_name: pending, category: null, note: null, delivery_id: null, container_id: container,
  bound_at: null, bound_by: null, created_at: "2026-08-10T00:00:00Z",
});

describe("a job's chip", () => {
  it("reads all-here as a full bar and a plain fraction", () => {
    const [c] = jobChips([tally({})]);
    expect(c.ready).toBe(true);
    expect(c.line).toBe("27/27");
    expect(c.hue).toBe(jobChips([tally({})])[0].hue); // stable per label
  });
  it("says how many units are still to come", () => {
    const [c] = jobChips([tally({ loggedUnits: 20, remainingUnits: 7 })]);
    expect(c.ready).toBe(false);
    expect(c.line).toBe("20/27 · 7 to come");
  });
  it("keeps a waiting job by its typed name", () => {
    const [c] = jobChips([tally({ projectId: null, label: "Sunset Ridge 4" })]);
    expect(c.pendingName).toBe("Sunset Ridge 4");
    expect(c.key).toBe("pending:Sunset Ridge 4");
  });
});

describe("what a tapped job lights up", () => {
  const packages = [
    pkg("a", "c7", "j1"),
    pkg("b", "c3", "j1"),
    pkg("c", "c7", "j2"),
    pkg("d", null, "j1", "received"),
    pkg("e", "c9", null, "stored", "Sunset Ridge 4"),
  ];
  it("the boxes holding that job's stored material, and nothing else's", () => {
    expect([...boxesForJob({ projectId: "j1", pendingName: null }, packages)].sort()).toEqual(["c3", "c7"]);
  });
  it("a waiting job by name", () => {
    expect([...boxesForJob({ projectId: null, pendingName: "Sunset Ridge 4" }, packages)]).toEqual(["c9"]);
  });
});
