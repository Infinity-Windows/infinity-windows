// The Studio list must show one row per authoring surface: standalone
// projects, plus every active job (B1, wave V-B) — except a job already
// represented by a LINKED standalone row, which would otherwise read as two
// models.

import { describe, expect, it } from "vitest";
import {
  buildWorkspaces,
  deriveJobModelState,
  jobModelFromFeatures,
  type JobModelState,
  type StudioProjectRow,
  type WorkspaceProject,
} from "./projects";

const ACTIVE_PROJECTS: WorkspaceProject[] = [
  { id: "p-black", job_code: "BLACK22", name: "Black Desert" },
  { id: "p-pecan", job_code: "PECAN14", name: "Pecan Ridge" },
];

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
      [ACTIVE_PROJECTS[0]],
      new Map(),
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
      ACTIVE_PROJECTS,
      new Map(),
    );
    expect(ws.map((w) => w.key)).toEqual(["s1", "j-p-pecan"]);
    expect(ws[0].jobCode).toBe("BLACK22");
  });

  it("names an unknown job's model without crashing", () => {
    const ws = buildWorkspaces(
      [],
      [{ project_id: "p-gone", savedAt: null }],
      [],
      new Map(),
    );
    expect(ws[0].name).toBe("Job model");
    expect(ws[0].jobCode).toBeNull();
  });

  it("B1: lists an active job with no model at all as 'not_started'", () => {
    const ws = buildWorkspaces([], [], ACTIVE_PROJECTS, new Map());
    expect(ws.map((w) => w.key).sort()).toEqual(["j-p-black", "j-p-pecan"]);
    expect(ws.every((w) => w.state === "not_started")).toBe(true);
    expect(ws.every((w) => w.savedAt === null)).toBe(true);
  });

  it("B1: an active job's chip reads the derived state map, not just model presence", () => {
    const states = new Map<string, JobModelState>([
      ["p-black", "published"],
      ["p-pecan", "seeded"],
    ]);
    const ws = buildWorkspaces([], [], ACTIVE_PROJECTS, states);
    const byKey = new Map(ws.map((w) => [w.key, w]));
    expect(byKey.get("j-p-black")?.state).toBe("published");
    expect(byKey.get("j-p-pecan")?.state).toBe("seeded");
  });

  it("B1: a linked standalone row carries the same state map", () => {
    const ws = buildWorkspaces(
      [row({ id: "s1", project_id: "p-black" })],
      [],
      ACTIVE_PROJECTS,
      new Map([["p-black", "published" as JobModelState]]),
    );
    expect(ws[0].state).toBe("published");
  });

  it("B1: an unlinked standalone project carries no state chip", () => {
    const ws = buildWorkspaces([row({ id: "s1", project_id: null })], [], [], new Map());
    expect(ws[0].state).toBeUndefined();
  });
});

describe("deriveJobModelState (B1, wave V-B)", () => {
  it("is not_started with no outline rows at all", () => {
    expect(deriveJobModelState([])).toBe("not_started");
  });

  it("is not_started when an outline exists but carries neither a trace nor a Studio model", () => {
    expect(deriveJobModelState([{}])).toBe("not_started");
    expect(deriveJobModelState([{ fitview: {} }])).toBe("not_started");
  });

  it("is seeded when a Studio model was saved but never Submitted", () => {
    expect(
      deriveJobModelState([{ modelstudio: { serialized: '{"floorplan":{}}' } }]),
    ).toBe("seeded");
  });

  it("is seeded when the tracer's Submit wrote a human trace", () => {
    expect(
      deriveJobModelState([
        {
          fitview: {
            model: {
              building: { footprints: [[{ x: 0, z: 0 }]], trace: { calibrated: true } },
              windows: [],
            },
          },
        },
      ]),
    ).toBe("seeded");
  });

  it("is published when Studio's own output sits in fitview.model (no trace)", () => {
    expect(
      deriveJobModelState([
        {
          fitview: {
            model: { building: { footprints: [[{ x: 0, z: 0 }]] }, windows: [] },
          },
        },
      ]),
    ).toBe("published");
  });

  it("published wins over a seeded row on a different outline page", () => {
    const tracedRow = {
      fitview: {
        model: {
          building: { footprints: [[{ x: 0, z: 0 }]], trace: {} },
          windows: [],
        },
      },
    };
    const publishedRow = {
      fitview: {
        model: { building: { footprints: [[{ x: 1, z: 1 }]] }, windows: [] },
      },
    };
    expect(deriveJobModelState([tracedRow, publishedRow])).toBe("published");
    expect(deriveJobModelState([publishedRow, tracedRow])).toBe("published");
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
