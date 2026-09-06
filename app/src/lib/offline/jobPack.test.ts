import { describe, expect, it } from "vitest";
import {
  readSavedJob,
  readSavedJobs,
  recordSavedJob,
  saveJobOffline,
  type JobPackDeps,
  type JobPackProgress,
  type JobPackResult,
  type PackPlanset,
} from "./jobPack";

/**
 * The runner is proven against fakes: what it asks for, in what order, what it
 * counts, and — the rule that matters in the field — that one failed picture
 * costs one picture, not the job.
 */

type Sheet = PackPlanset & { path: string };

function deps(over: Partial<JobPackDeps<Sheet>> = {}, log: string[] = []): JobPackDeps<Sheet> {
  const base: JobPackDeps<Sheet> = {
    projects: async () => { log.push("projects"); },
    openings: async () => { log.push("openings"); return [{ window_type_id: "t1" }, { window_type_id: "t2" }, { window_type_id: "t1" }, { window_type_id: null }]; },
    markSpecs: async () => { log.push("markSpecs"); return [
      { mark_code: "1A", image_page: 2, image_bbox: [0, 0, 0.5, 0.5] },
      { mark_code: "2A", image_page: null, image_bbox: null },
      { mark_code: "3A", image_page: 3, image_bbox: [0, 0, 0.5, 0.5] },
    ]; },
    plansets: async () => { log.push("plansets"); return [{ id: "p-building", path: "b.pdf" }, { id: "p-specs", path: "s.pdf" }]; },
    projectWindows: async () => { log.push("projectWindows"); },
    elevationViews: async () => { log.push("elevationViews"); },
    planOutlines: async () => { log.push("planOutlines"); },
    typeBrain: async (id) => { log.push(`typeBrain:${id}`); },
    planset: async (p) => { log.push(`planset:${p.id}`); },
    drawing: async (_sheets, spec) => { log.push(`drawing:${spec.mark_code}`); return spec.image_page == null ? "none" : "saved"; },
  };
  return { ...base, ...over };
}

describe("saveJobOffline", () => {
  it("reads the job, then keeps every sheet and every picture, and counts what landed", async () => {
    const log: string[] = [];
    const progress: JobPackProgress[] = [];
    const result = await saveJobOffline("job-1", deps({}, log), (p) => progress.push(p), () => 1234);

    expect(result).toEqual<JobPackResult>({
      projectId: "job-1",
      at: 1234,
      specs: 3,
      types: 2,
      plansets: 2,
      drawings: 2,
      failed: [],
    });
    // Base reads first (any order), then brains, then sheets, then pictures.
    const base = log.slice(0, 7).sort();
    expect(base).toEqual(["elevationViews", "markSpecs", "openings", "planOutlines", "plansets", "projectWindows", "projects"]);
    expect(log.slice(7)).toEqual([
      "typeBrain:t1", "typeBrain:t2",
      "planset:p-building", "planset:p-specs",
      "drawing:1A", "drawing:2A", "drawing:3A",
    ]);
    // Progress ends at done === total, and total grew once the counts were known.
    const last = progress[progress.length - 1];
    expect(last.done).toBe(last.total);
    expect(last.total).toBe(7 + 2 + 2 + 3);
  });

  it("keeps going when a picture fails, and says which one", async () => {
    const result = await saveJobOffline("job-1", deps({
      drawing: async (_s, spec) => {
        if (spec.mark_code === "3A") throw new Error("no canvas");
        return spec.image_page == null ? "none" : "saved";
      },
    }));
    expect(result.drawings).toBe(1);
    expect(result.failed).toEqual(["drawing:3A"]);
  });

  it("keeps going when a sheet cannot be downloaded", async () => {
    const result = await saveJobOffline("job-1", deps({
      planset: async (p) => { if (p.id === "p-specs") throw new Error("offline"); },
    }));
    expect(result.plansets).toBe(1);
    expect(result.failed).toEqual(["planset:p-specs"]);
    // Pictures still attempted — a cached crop may not need the sheet.
    expect(result.drawings).toBe(2);
  });

  it("a failed base read is one failure, not a crash, and the rest still saves", async () => {
    const result = await saveJobOffline("job-1", deps({
      openings: async () => { throw new Error("timeout"); },
    }));
    expect(result.failed).toEqual(["openings"]);
    expect(result.types).toBe(0); // no openings, no type ids
    expect(result.plansets).toBe(2);
    expect(result.drawings).toBe(2);
  });

  it("never throws, whatever the deps do", async () => {
    const boom = async () => { throw new Error("boom"); };
    const result = await saveJobOffline("job-1", deps({
      projects: boom, openings: boom, markSpecs: boom, plansets: boom,
      projectWindows: boom, elevationViews: boom, planOutlines: boom,
    }));
    expect(result.failed.length).toBe(7);
    expect(result.specs).toBe(0);
  });
});

describe("the saved-jobs record", () => {
  function memory() {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } };
  }

  it("remembers a save and reads it back by job", () => {
    const s = memory();
    recordSavedJob({ projectId: "a", at: 10, specs: 3, types: 1, plansets: 2, drawings: 2, failed: [] }, s);
    recordSavedJob({ projectId: "b", at: 20, specs: 0, types: 0, plansets: 1, drawings: 0, failed: ["planset:x"] }, s);
    expect(readSavedJob("a", s)).toEqual({ at: 10, specs: 3, plansets: 2, drawings: 2, failed: 0 });
    expect(readSavedJob("b", s)?.failed).toBe(1);
    expect(Object.keys(readSavedJobs(s)).sort()).toEqual(["a", "b"]);
    expect(readSavedJob("c", s)).toBeNull();
  });

  it("a newer save replaces the older record", () => {
    const s = memory();
    recordSavedJob({ projectId: "a", at: 10, specs: 3, types: 1, plansets: 2, drawings: 2, failed: [] }, s);
    recordSavedJob({ projectId: "a", at: 99, specs: 4, types: 1, plansets: 2, drawings: 4, failed: [] }, s);
    expect(readSavedJob("a", s)?.at).toBe(99);
  });

  it("garbage in storage reads as nothing saved", () => {
    const s = memory();
    s.setItem("wops-offline-saved", "{not json");
    expect(readSavedJobs(s)).toEqual({});
    s.setItem("wops-offline-saved", JSON.stringify({ a: { at: "yesterday" }, b: { at: 5, specs: 1, plansets: 1, drawings: 1, failed: 0 } }));
    expect(Object.keys(readSavedJobs(s))).toEqual(["b"]);
  });

  it("no storage at all is fine", () => {
    expect(readSavedJobs(null)).toEqual({});
    expect(() => recordSavedJob({ projectId: "a", at: 1, specs: 0, types: 0, plansets: 0, drawings: 0, failed: [] }, null)).not.toThrow();
  });
});
