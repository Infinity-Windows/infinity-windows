import { describe, expect, it } from "vitest";
import {
  buildFitViewJob,
  DEFAULT_LONG_SIDE_M,
  DEFAULT_SILL_M,
  inferHardware,
  isDoorLike,
  type AdapterInput,
} from "./adapter";
import type { ProjectOpening } from "../install/types";

// A 2:1 rectangle drawn on a square page: edges s0 (top), s1 (right),
// s2 (bottom), s3 (left) in outline order.
const RECT = [
  { x: 0.1, y: 0.2 },
  { x: 0.9, y: 0.2 },
  { x: 0.9, y: 0.6 },
  { x: 0.1, y: 0.6 },
];

function opening(over: Partial<ProjectOpening>): ProjectOpening {
  return {
    id: "op-" + (over.opening_code ?? "1"),
    project_id: "p1",
    planset_id: null,
    opening_code: "1",
    window_type_id: null,
    label: null,
    page_number: 1,
    pin_x: null,
    pin_y: null,
    assigned_window_id: null,
    status: "planned",
    confirmed: true,
    created_at: "2026-01-01",
    ro_width_in: null,
    ro_height_in: null,
    ro_measured_by: null,
    ro_measured_at: null,
    condition: "unchecked",
    condition_note: null,
    condition_checked_by: null,
    condition_checked_at: null,
    assigned_to: null,
    ...over,
  } as ProjectOpening;
}

function input(over: Partial<AdapterInput> = {}): AdapterInput {
  return {
    projectId: "p1",
    projectName: "Test Job",
    projectAddress: "1 Test Ln",
    outline: { points: RECT, pageAspect: 1, pageNumber: 1 },
    openings: [],
    specs: [],
    ...over,
  };
}

describe("buildFitViewJob geometry", () => {
  it("returns null without a usable outline", () => {
    expect(
      buildFitViewJob(input({ outline: { points: [], pageAspect: 1, pageNumber: 1 } })),
    ).toBeNull();
  });

  it("pins the footprint's longest side to the default scale", () => {
    const job = buildFitViewJob(input())!;
    expect(job.building.width).toBeCloseTo(DEFAULT_LONG_SIDE_M, 5);
    expect(job.building.depth).toBeCloseTo(DEFAULT_LONG_SIDE_M / 2, 5);
    expect(job.building.footprints[0]).toHaveLength(4);
  });

  it("respects an explicit long-side override", () => {
    const job = buildFitViewJob(input({ longSideM: 12 }))!;
    expect(job.building.width).toBeCloseTo(12, 5);
  });

  it("places a pinned opening on the nearest wall, metres from its start", () => {
    // Pin just above the top edge, 1/4 of the way across it.
    const job = buildFitViewJob(
      input({
        openings: [opening({ opening_code: "7", pin_x: 0.3, pin_y: 0.19 })],
      }),
    )!;
    expect(job.windows).toHaveLength(1);
    const w = job.windows[0];
    expect(w.id).toBe("7");
    expect(w.elev).toBe("s0");
    // t = (0.3 - 0.1) / 0.8 = 0.25 along a 30m wall.
    expect(w.x).toBeCloseTo(7.5, 3);
  });

  it("skips openings on other pages or without pins", () => {
    const job = buildFitViewJob(
      input({
        openings: [
          opening({ opening_code: "1", pin_x: 0.5, pin_y: 0.2, page_number: 2 }),
          opening({ opening_code: "2", page_number: 1 }),
        ],
      }),
    )!;
    expect(job.windows).toHaveLength(0);
  });

  it("marks installed status through and keeps everything else tofit", () => {
    const job = buildFitViewJob(
      input({
        openings: [
          opening({ opening_code: "1", pin_x: 0.3, pin_y: 0.2, status: "installed" }),
          opening({ opening_code: "2", pin_x: 0.5, pin_y: 0.2, status: "assigned" }),
        ],
      }),
    )!;
    expect(job.windows.map((w) => w.status)).toEqual(["installed", "tofit"]);
  });

  it("doors sit on the floor; tall windows never poke through the wall head", () => {
    const door = opening({ opening_code: "D", pin_x: 0.3, pin_y: 0.2 });
    door.window_types = {
      id: "t1", type_code: "FD", name: "French Door", category: "Doors",
      width_in: 60, height_in: 96, difficulty_rating: null, tutorial_url: null,
      notes: null,
    } as ProjectOpening["window_types"];
    const tall = opening({ opening_code: "T", pin_x: 0.6, pin_y: 0.2 });
    tall.window_types = {
      id: "t2", type_code: "TW", name: "Fixed picture window", category: null,
      width_in: 48, height_in: 120, difficulty_rating: null, tutorial_url: null,
      notes: null,
    } as ProjectOpening["window_types"];

    const job = buildFitViewJob(input({ openings: [door, tall] }))!;
    const d = job.windows.find((w) => w.id === "D")!;
    const t = job.windows.find((w) => w.id === "T")!;
    expect(d.door).toBe(true);
    expect(d.y).toBe(0);
    expect(t.door).toBeUndefined();
    // 120in = 3.048m in a 3.6m wall: sill drops below the 0.9 default.
    expect(t.y).toBeLessThan(DEFAULT_SILL_M);
    expect(t.y + t.h / 1000).toBeLessThanOrEqual(3.6);
  });
});

describe("mark code dialects", () => {
  it("normalizes survey letters onto extraction dashes", async () => {
    const { normalizeMarkCode } = await import("./adapter");
    expect(normalizeMarkCode("13A")).toBe("13-1");
    expect(normalizeMarkCode("13b")).toBe("13-2");
    expect(normalizeMarkCode("13-1")).toBe("13-1");
    expect(normalizeMarkCode("29")).toBe("29");
    // A trailing letter is only a twin suffix after a digit — real marks like
    // "W3" or "A-101" pass through untouched.
    expect(normalizeMarkCode("W3")).toBe("W3");
  });
});

describe("authored model", () => {
  const model = {
    building: {
      width: 48.1, depth: 43.6, height: 4.7, rise: 0,
      footprints: [[
        { x: 0, z: 0, name: "West" },
        { x: 10, z: 0 },
        { x: 10, z: 8 },
        { x: 0, z: 8 },
      ]],
    },
    windows: [
      { id: "13A", status: "tofit", elev: "s0", x: 2, y: 0.9, w: 900, h: 1200 },
      { id: "29", status: "tofit", elev: "s1", x: 1, y: 0, w: 7233, h: 3035 },
    ],
  };

  it("is read from features.fitview.model and validated", async () => {
    const { fitviewModel } = await import("./adapter");
    expect(fitviewModel({ fitview: { model } })).toEqual(model);
    expect(fitviewModel({ fitview: { longSideM: 48 } })).toBeNull();
    expect(fitviewModel({ fitview: { model: { building: {} } } })).toBeNull();
    expect(fitviewModel(null)).toBeNull();
  });

  it("keeps survey geometry and merges live status across dialects", async () => {
    const { buildAuthoredJob } = await import("./adapter");
    const live = [
      opening({ opening_code: "13-1", status: "installed" }),
      opening({ opening_code: "29", status: "assigned" }),
    ];
    const job = buildAuthoredJob(
      model,
      { projectId: "p1", projectName: "BD", projectAddress: null },
      live,
    );
    expect(job.building.footprints[0][0].name).toBe("West");
    const w13 = job.windows.find((w) => String(w.id) === "13A")!;
    const w29 = job.windows.find((w) => String(w.id) === "29")!;
    expect(w13.status).toBe("installed");
    // assigned is still waiting to be fitted.
    expect(w29.status).toBe("tofit");
    // Survey placement untouched by the merge.
    expect(w29.x).toBe(1);
  });
});

describe("preferModelOutline", () => {
  it("the model-bearing row beats an older auto-extracted sibling", async () => {
    const { preferModelOutline } = await import("./adapter");
    const model = {
      building: { width: 1, depth: 1, height: 3, rise: 0, footprints: [[{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 1, z: 1 }]] },
      windows: [],
    };
    const autoBox = { id: "old", features: { dividers: [] } };
    const survey = { id: "new", features: { fitview: { model } } };
    // The auto-extracted row sorts first (older created_at) - the exact
    // shape of the bug where a fresh submit rendered as the old box.
    expect(preferModelOutline([autoBox, survey])).toBe(survey);
    expect(preferModelOutline([autoBox])).toBe(autoBox);
    expect(preferModelOutline([])).toBeNull();
    expect(preferModelOutline(undefined)).toBeNull();
  });
});

describe("calibration via outline features", () => {
  it("reads a fitview key and ignores everything else", async () => {
    const { fitviewCalibration } = await import("./adapter");
    expect(fitviewCalibration(null)).toEqual({});
    expect(fitviewCalibration({ dividers: [] })).toEqual({});
    expect(
      fitviewCalibration({ dividers: [], fitview: { longSideM: 48.1, wallHeightM: 4.7 } }),
    ).toEqual({ longSideM: 48.1, wallHeightM: 4.7 });
    expect(fitviewCalibration({ fitview: { longSideM: -3 } })).toEqual({});
  });

  it("wall height override flows into the building and sill clamp", () => {
    const job = buildFitViewJob(input({ wallHeightM: 4.7 }))!;
    expect(job.building.height).toBeCloseTo(4.7, 5);
  });
});

describe("hardware inference", () => {
  it("reads exact panel counts from operation letters", () => {
    expect(inferHardware("XO", "sliding door")).toEqual({ lights: 2, open: "bipart" });
    expect(inferHardware("OXXO", "sliding door")).toEqual({ lights: 4, open: "bipart" });
    expect(inferHardware("XOX", "window")).toEqual({ lights: 3, open: "hinge-l" });
  });

  it("falls back to style text", () => {
    expect(inferHardware(null, "French door, double leaf").open).toBe("hinge-r");
    expect(inferHardware(null, "Casement window").open).toBe("hinge-l");
    expect(inferHardware(null, "Awning window").open).toBe("hinge-t");
    expect(inferHardware("Fixed", "anything")).toEqual({ lights: 1, open: "fixed" });
  });

  it("shows hung windows as two quiet sashes rather than a wrong swing", () => {
    expect(inferHardware(null, "Single hung vinyl")).toEqual({ lights: 2, open: "fixed" });
  });

  it("unknown reads as fixed", () => {
    expect(inferHardware(null, "")).toEqual({ lights: 1, open: "fixed" });
  });
});

describe("door detection", () => {
  it("matches door words without matching windows", () => {
    expect(isDoorLike("French door, double leaf")).toBe(true);
    expect(isDoorLike("Sliding doors")).toBe(true);
    expect(isDoorLike("Double-hung window")).toBe(false);
    expect(isDoorLike("Outdoor-rated fixed unit")).toBe(false);
  });
});
