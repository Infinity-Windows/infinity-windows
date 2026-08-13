// The Studio list must show one row per authoring surface: standalone
// projects, plus job models — except a job already represented by a LINKED
// standalone row, which would otherwise read as two models.

import { describe, expect, it } from "vitest";
import { buildWorkspaces, type StudioProjectRow } from "./projects";

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
