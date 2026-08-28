// Wave M: the ledger's scope-union filter (a real job by id, or a waiting
// job by its typed name) and the mark derivation waiting material falls
// back to — same fallback the packageTitle/unitParts precedent already uses.

import { describe, expect, it } from "vitest";
import type { StoragePackage } from "../storage";
import { markOf } from "./jobMaterials";
import {
  distinctPendingJobNames,
  hasScope,
  matchesScope,
  scopeFromParams,
  scopeHref,
  scopeKey,
  type MaterialsScope,
} from "./materialsScope";

let seq = 0;
function pkg(over: Partial<StoragePackage> = {}): StoragePackage {
  seq += 1;
  return {
    id: `pkg-${seq}`,
    serial: `PKG-${String(seq).padStart(6, "0")}`,
    short_code: null,
    status: "stored",
    project_id: "job-1",
    category: null,
    note: null,
    delivery_id: null,
    container_id: null,
    bound_at: "2026-08-25T12:00:00Z",
    bound_by: "e2e",
    created_at: "2026-08-25T12:00:00Z",
    package_marks: [],
    ...over,
  };
}

describe("scopeFromParams", () => {
  it("reads ?job= as a real-job scope", () => {
    expect(scopeFromParams(new URLSearchParams("job=job-1"))).toEqual({
      projectId: "job-1",
      pendingName: null,
    });
  });

  it("reads ?pending= as a waiting-job scope", () => {
    expect(scopeFromParams(new URLSearchParams("pending=Sunset%20Ridge%204"))).toEqual({
      projectId: null,
      pendingName: "Sunset Ridge 4",
    });
  });

  it("job wins when both are somehow present", () => {
    expect(scopeFromParams(new URLSearchParams("job=job-1&pending=Sunset"))).toEqual({
      projectId: "job-1",
      pendingName: null,
    });
  });

  it("neither present reads as no scope", () => {
    const scope = scopeFromParams(new URLSearchParams(""));
    expect(hasScope(scope)).toBe(false);
  });
});

describe("matchesScope", () => {
  const jobScope: MaterialsScope = { projectId: "job-1", pendingName: null };
  const pendingScope: MaterialsScope = { projectId: null, pendingName: "Sunset Ridge 4" };

  it("a real-job scope matches only that job's own packages", () => {
    expect(matchesScope(pkg({ project_id: "job-1" }), jobScope)).toBe(true);
    expect(matchesScope(pkg({ project_id: "job-2" }), jobScope)).toBe(false);
    expect(
      matchesScope(pkg({ project_id: null, pending_job_name: "job-1" }), jobScope),
    ).toBe(false);
  });

  it("a waiting-job scope matches only unfiled material typed against that exact name", () => {
    expect(
      matchesScope(
        pkg({ project_id: null, pending_job_name: "Sunset Ridge 4" }),
        pendingScope,
      ),
    ).toBe(true);
    expect(
      matchesScope(
        pkg({ project_id: null, pending_job_name: "Sunset Ridge 5" }),
        pendingScope,
      ),
    ).toBe(false);
    // Filed onto a real job since — it belongs to that job now, not the name.
    expect(
      matchesScope(
        pkg({ project_id: "job-9", pending_job_name: "Sunset Ridge 4" }),
        pendingScope,
      ),
    ).toBe(false);
  });

  it("no scope matches nothing", () => {
    expect(matchesScope(pkg(), { projectId: null, pendingName: null })).toBe(false);
  });
});

describe("scopeKey / scopeHref", () => {
  it("a real job keys and links by id", () => {
    const scope: MaterialsScope = { projectId: "job-1", pendingName: null };
    expect(scopeKey(scope)).toBe("job-1");
    expect(scopeHref(scope)).toBe("/warehouse/materials?job=job-1");
  });

  it("a waiting job keys and links by its URL-encoded name, namespaced", () => {
    const scope: MaterialsScope = { projectId: null, pendingName: "Sunset Ridge 4" };
    expect(scopeKey(scope)).toBe("pending:Sunset Ridge 4");
    expect(scopeHref(scope)).toBe("/warehouse/materials?pending=Sunset%20Ridge%204");
  });
});

describe("distinctPendingJobNames", () => {
  it("collects every unfiled waiting-job name, deduped and sorted", () => {
    const names = distinctPendingJobNames([
      pkg({ project_id: null, pending_job_name: "Sunset Ridge 4" }),
      pkg({ project_id: null, pending_job_name: "Mad Moose" }),
      pkg({ project_id: null, pending_job_name: "Sunset Ridge 4" }),
      pkg({ project_id: "job-1", pending_job_name: null }),
      pkg({ project_id: null, pending_job_name: null }),
    ]);
    expect(names).toEqual(["Mad Moose", "Sunset Ridge 4"]);
  });
});

describe("markOf falls back for waiting material (packageTitle/unitParts precedent)", () => {
  it("uses mfr_mark when there is no scheduled package_marks join", () => {
    const p = pkg({
      project_id: null,
      pending_job_name: "Sunset Ridge 4",
      package_marks: [],
      mfr_mark: "5050",
    });
    expect(markOf(p)).toBe("5050");
  });
});
