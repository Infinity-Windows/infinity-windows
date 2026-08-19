// The Studio list must show one row per authoring surface: standalone
// projects, plus job models — except a job already represented by a LINKED
// standalone row, which would otherwise read as two models.

import { describe, expect, it } from "vitest";
import { buildWorkspaces, jobModelFromFeatures, type StudioProjectRow } from "./projects";

const PROJECTS = new Map([
  ["p-black", { job_code: "BLACK22", name: "Black Desert" }],
  ["p-pecan", { job_code: "PECAN14", name: "Pecan Ridge" }],
]);

function row(partial: Partial<StudioProjectRow>): StudioProjectRow {
  return {
    id: "s1",
    name: "Untitled",
    project_id: null,
    model: null,
    archived: false,
    created_by: null,
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-01T00:00:00Z",
    ...partial,
  };
}

describe("buildWorkspaces", () => {
  it("unions standalone rows with job models, newest saved first", () => {
    const ws = buildWorkspaces(
      [row({ id: "s1", name: "Spec house", model: { savedAt: "2026-08-13T00:00:00Z" } })],
      [{ project_id: "p-black", savedAt: "2026-08-12T00:00:00Z" }],
      PROJECTS,
    );
    expect(ws.map((w) => w.key)).toEqual(["s1", "j-p-black"]);
    expect(ws[1].name).toBe("BLACK22 — Black Desert");
    expect(ws[1].kind).toBe("job");
  });

  it("hides a job model when a standalone row is LINKED to that job", () => {
    const ws = buildWorkspaces(
      [
        row({
          id: "s1",
          name: "Black rebuild",
          project_id: "p-black",
          updated_at: "2026-08-12T12:00:00Z",
        }),
      ],
      [
        { project_id: "p-black", savedAt: "2026-08-12T00:00:00Z" },
        { project_id: "p-pecan", savedAt: "2026-08-11T00:00:00Z" },
      ],
      PROJECTS,
    );
    expect(ws.map((w) => w.key)).toEqual(["s1", "j-p-pecan"]);
    expect(ws[0].jobCode).toBe("BLACK22");
  });

  it("names an unknown job's model without crashing", () => {
    const ws = buildWorkspaces([], [{ project_id: "p-gone", savedAt: null }], PROJECTS);
    expect(ws[0].name).toBe("Job model");
    expect(ws[0].jobCode).toBeNull();
  });
});

describe("jobModelFromFeatures (Studio 100x #27: model-presence detection)", () => {
  it("reads a one-floor model's serialized string", () => {
    const model = jobModelFromFeatures({
      modelstudio: { serialized: '{"floorplan":{}}', savedAt: "2026-08-19T00:00:00Z" },
    });
    expect(model?.serialized).toBe('{"floorplan":{}}');
    expect(model?.savedAt).toBe("2026-08-19T00:00:00Z");
  });

  it("reads a multi-story model's floors array", () => {
    const model = jobModelFromFeatures({
      modelstudio: { floors: ["floor0", "floor1"] },
    });
    expect(model?.floors).toEqual(["floor0", "floor1"]);
  });

  it("is null when the job has never had a Studio model saved", () => {
    expect(jobModelFromFeatures(null)).toBeNull();
    expect(jobModelFromFeatures(undefined)).toBeNull();
    expect(jobModelFromFeatures({})).toBeNull();
    // The fitview outline model is a DIFFERENT thing (features.fitview.model) —
    // its presence must never read as a Studio model.
    expect(jobModelFromFeatures({ fitview: { model: {} } })).toBeNull();
  });

  it("is null for an empty modelstudio object (no serialized, no floors)", () => {
    expect(jobModelFromFeatures({ modelstudio: {} })).toBeNull();
    expect(jobModelFromFeatures({ modelstudio: { floors: [] } })).toBeNull();
  });

  it("ignores junk shapes rather than throwing", () => {
    expect(jobModelFromFeatures("a string")).toBeNull();
    expect(jobModelFromFeatures(42)).toBeNull();
    expect(jobModelFromFeatures({ modelstudio: "not an object" })).toBeNull();
  });
});
