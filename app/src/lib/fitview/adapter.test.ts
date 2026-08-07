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
