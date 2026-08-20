// buildLiveOverlay is a straight re-read of five already-tested pure
// functions (glowFor, flashFor, blockedUnits, unitParts/partsHeadline,
// untaggedMarks); these tests cover the ONE thing that's new here — the
// mark-matching (normalizeMarkCode for openings, markKeyOf for packages)
// — and that several signals land on the same unit without one clobbering
// another.

import { describe, expect, it } from "vitest";
import type { OpeningPhase } from "../install/phases";
import type { UnitSession } from "../install/sessions";
import type { ProjectOpening } from "../install/types";
import type { StoragePackage } from "../storage";
import type { ScheduledMark } from "../warehouse/warehouseCards";
import { buildLiveOverlay, type LiveOverlayInput } from "./liveOverlay";
import type { UnitConfig } from "./units";

function opening(over: Partial<ProjectOpening>): ProjectOpening {
  return {
    id: "op-" + (over.opening_code ?? "1"),
    project_id: "job-1",
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
    assigned_to: null,
    needs_flashing: false,
    ...over,
  } as ProjectOpening;
}

let pkgSeq = 0;
function pkg(over: Partial<StoragePackage> & { marks?: string[] }): StoragePackage {
  const { marks, ...rest } = over;
  pkgSeq += 1;
  return {
    id: `pkg-${pkgSeq}`,
    serial: `PKG-${String(pkgSeq).padStart(6, "0")}`,
    short_code: null,
    status: "stored",
    project_id: "job-1",
    category: null,
    part_index: null,
    part_total: null,
    part_type: null,
    mfr_mark: null,
    note: null,
    delivery_id: null,
    container_id: null,
    location_id: null,
    bound_at: null,
    bound_by: null,
    created_at: "2026-08-17T00:00:00Z",
    package_marks: (marks ?? ["16"]).map((mark_code) => ({ mark_code })),
    ...rest,
  };
}

let sessSeq = 0;
function sess(over: Partial<UnitSession>): UnitSession {
  sessSeq += 1;
  return {
    id: `sess-${sessSeq}`,
    opening_id: "op-1",
    profile_id: "ben",
    role: "install",
    is_rework: false,
    started_at: "2026-08-16T09:00:00Z",
    ended_at: null,
    end_reason: null,
    block_reason: null,
    block_issue_id: null,
    created_at: "2026-08-16T09:00:00Z",
    ...over,
  };
}

function phase(over: Partial<OpeningPhase>): OpeningPhase {
  return {
    id: "ph1",
    opening_id: "op-1",
    kind: "flashing",
    status: "active",
    started_at: "2026-08-11T12:00:00Z",
    started_by: "ben",
    submitted_at: null,
    submitted_by: null,
    minutes: null,
    photo_path: null,
    ...over,
  };
}

/** A blank input: no signal anywhere, one job, nobody special looking. */
function baseInput(over: Partial<LiveOverlayInput> = {}): LiveOverlayInput {
  return {
    openings: [],
    packages: [],
    scheduledMarks: [],
    sessions: [],
    phases: [],
    qcPassedOpeningIds: [],
    photoCounts: new Map(),
    viewerId: null,
    managerView: true,
    projectId: "job-1",
    ...over,
  };
}

describe("buildLiveOverlay: matching modeled units to live data", () => {
  it("matches a modeled unit's mark to its opening via normalizeMarkCode, both dialects", () => {
    const input = baseInput({
      openings: [
        opening({ opening_code: "13-1", assigned_to: "ben", status: "assigned" }),
        opening({ opening_code: "13B", assigned_to: "chris", status: "installed" }),
      ],
    });
    // Modeled unit itemNames can carry either dialect; each resolves to
    // its OWN opening — twins never share state.
    const map = buildLiveOverlay(input, ["13-1", "13B"]);
    expect(map.get("13-1")?.glow).toBe("red");
    expect(map.get("13B")?.glow).toBe("yellow");
  });

  it("a mark that matches no opening at all gets no opening-derived signal", () => {
    const map = buildLiveOverlay(baseInput(), ["decorative-panel"]);
    expect(map.get("decorative-panel")).toEqual({});
  });

  it("returns one entry per input code, keyed by the exact string handed in", () => {
    const map = buildLiveOverlay(baseInput(), ["16", "17"]);
    expect([...map.keys()]).toEqual(["16", "17"]);
  });
});

describe("buildLiveOverlay: status glow (#1) and QC (#6)", () => {
  it("reads glowFor's red/yellow/green/none exactly, role-scoped", () => {
    const installer = baseInput({
      viewerId: "ben",
      managerView: false,
      openings: [
        opening({ opening_code: "1", assigned_to: "ben", status: "assigned" }),
        opening({ opening_code: "2", assigned_to: "ben", status: "installed" }),
        opening({ opening_code: "3", assigned_to: "chris", status: "assigned" }),
      ],
    });
    const map = buildLiveOverlay(installer, ["1", "2", "3"]);
    expect(map.get("1")?.glow).toBe("red");
    expect(map.get("2")?.glow).toBe("yellow");
    // Someone else's assignment stays plain for an installer view.
    expect(map.get("3")?.glow).toBe("none");
  });

  it("QC passed is green for every viewer, regardless of assignment", () => {
    const map = buildLiveOverlay(
      baseInput({
        viewerId: "ben",
        managerView: false,
        openings: [opening({ opening_code: "1", assigned_to: "chris", status: "installed" })],
        qcPassedOpeningIds: ["op-1"],
      }),
      ["1"],
    );
    expect(map.get("1")?.glow).toBe("green");
  });
});

describe("buildLiveOverlay: blocked-now markers (#3)", () => {
  it("surfaces the newest session's block reason", () => {
    const map = buildLiveOverlay(
      baseInput({
        openings: [opening({ opening_code: "1" })],
        sessions: [
          // Newest-first, as listProjectSessions returns them.
          sess({
            opening_id: "op-1",
            started_at: "2026-08-16T09:00:00Z",
            ended_at: "2026-08-16T10:00:00Z",
            end_reason: "block",
            block_reason: "Wrong glass",
          }),
        ],
      }),
      ["1"],
    );
    expect(map.get("1")?.blockedReason).toBe("Wrong glass");
  });

  it("a later, non-block session clears it — nothing hides behind stale state", () => {
    const map = buildLiveOverlay(
      baseInput({
        openings: [opening({ opening_code: "1" })],
        sessions: [
          sess({ opening_id: "op-1", started_at: "2026-08-16T11:00:00Z", end_reason: "finish", ended_at: "2026-08-16T11:30:00Z" }),
          sess({
            opening_id: "op-1",
            started_at: "2026-08-16T09:00:00Z",
            ended_at: "2026-08-16T10:00:00Z",
            end_reason: "block",
            block_reason: "Wrong glass",
          }),
        ],
      }),
      ["1"],
    );
    expect(map.get("1")?.blockedReason).toBeUndefined();
  });
});

describe("buildLiveOverlay: package completeness (#4) and loose alarm (#19)", () => {
  it("carries partsHeadline's own sentence when something is tagged", () => {
    const map = buildLiveOverlay(
      baseInput({
        packages: [
          pkg({ marks: ["16"], part_index: 1, part_total: 2 }),
          pkg({ marks: ["16"], part_index: 2, part_total: 2 }),
        ],
      }),
      ["16-1"], // a twin opening code; packages are tagged by the base mark
    );
    expect(map.get("16-1")?.partsLine).toBe("2 of 2 · all here");
  });

  it("flags loose when a HELD package sits in no container and no slot", () => {
    const map = buildLiveOverlay(
      baseInput({
        packages: [pkg({ marks: ["16"], status: "received", container_id: null, location_id: null })],
      }),
      ["16"],
    );
    expect(map.get("16")?.loose).toBe(true);
  });

  it("a minted (not-yet-arrived) placeholder never counts as loose", () => {
    const map = buildLiveOverlay(
      baseInput({
        packages: [pkg({ marks: ["16"], status: "minted", container_id: null, location_id: null })],
      }),
      ["16"],
    );
    expect(map.get("16")?.loose).toBeUndefined();
    // Still reports a parts line — "minted" is informative, not silent.
    expect(map.get("16")?.partsLine).toBeTruthy();
  });

  it("a package in a container, or on a shelf slot, is not loose", () => {
    const map = buildLiveOverlay(
      baseInput({
        packages: [
          pkg({ marks: ["16"], status: "stored", container_id: "conex-1", location_id: null }),
          pkg({ marks: ["17"], status: "stored", container_id: null, location_id: "loc-1" }),
        ],
      }),
      ["16", "17"],
    );
    expect(map.get("16")?.loose).toBeUndefined();
    expect(map.get("17")?.loose).toBeUndefined();
  });
});

describe("buildLiveOverlay: not-tagged dim (#17)", () => {
  it("dims a scheduled mark with nothing tagged against it", () => {
    const map = buildLiveOverlay(
      baseInput({
        scheduledMarks: [{ project_id: "job-1", mark_code: "16" } satisfies ScheduledMark],
        packages: [],
      }),
      ["16"],
    );
    expect(map.get("16")?.dim).toBe(true);
    expect(map.get("16")?.partsLine).toBeUndefined();
  });

  it("a tagged mark is never dim, even though it's also scheduled", () => {
    const map = buildLiveOverlay(
      baseInput({
        scheduledMarks: [{ project_id: "job-1", mark_code: "16" } satisfies ScheduledMark],
        packages: [pkg({ marks: ["16"] })],
      }),
      ["16"],
    );
    expect(map.get("16")?.dim).toBeUndefined();
  });

  it("an unscheduled mark with nothing tagged is not dim (nothing SHOULD be here)", () => {
    const map = buildLiveOverlay(baseInput({ scheduledMarks: [] }), ["16"]);
    expect(map.get("16")?.dim).toBeUndefined();
  });
});

describe("buildLiveOverlay: flashing-owed (#5)", () => {
  it("owed when needed and nothing submitted; clear once a phase submits", () => {
    const owed = buildLiveOverlay(
      baseInput({ openings: [opening({ opening_code: "1", needs_flashing: true })] }),
      ["1"],
    );
    expect(owed.get("1")?.flashingOwed).toBe(true);

    const done = buildLiveOverlay(
      baseInput({
        openings: [opening({ opening_code: "1", needs_flashing: true })],
        phases: [phase({ opening_id: "op-1", status: "submitted" })],
      }),
      ["1"],
    );
    expect(done.get("1")?.flashingOwed).toBeUndefined();
  });

  it("never owed when the opening doesn't need flashing", () => {
    const map = buildLiveOverlay(
      baseInput({ openings: [opening({ opening_code: "1", needs_flashing: false })] }),
      ["1"],
    );
    expect(map.get("1")?.flashingOwed).toBeUndefined();
  });
});

describe("buildLiveOverlay: photo badge (#7)", () => {
  it("carries the opening's photo count", () => {
    const map = buildLiveOverlay(
      baseInput({
        openings: [opening({ opening_code: "1" })],
        photoCounts: new Map([["op-1", 3]]),
      }),
      ["1"],
    );
    expect(map.get("1")?.photoCount).toBe(3);
  });

  it("absent, not zero, when the count map has nothing for this opening", () => {
    const map = buildLiveOverlay(
      baseInput({ openings: [opening({ opening_code: "1" })], photoCounts: new Map() }),
      ["1"],
    );
    expect(map.get("1")?.photoCount).toBeUndefined();
  });

  it("a zero entry in the map is treated the same as absent", () => {
    const map = buildLiveOverlay(
      baseInput({
        openings: [opening({ opening_code: "1" })],
        photoCounts: new Map([["op-1", 0]]),
      }),
      ["1"],
    );
    expect(map.get("1")?.photoCount).toBeUndefined();
  });

  it("twins keep their own counts, matched by opening id like every other signal", () => {
    const map = buildLiveOverlay(
      baseInput({
        openings: [
          opening({ opening_code: "13-1" }),
          opening({ opening_code: "13B" }),
        ],
        photoCounts: new Map([
          ["op-13-1", 1],
          ["op-13B", 5],
        ]),
      }),
      ["13-1", "13B"],
    );
    expect(map.get("13-1")?.photoCount).toBe(1);
    expect(map.get("13B")?.photoCount).toBe(5);
  });

  it("no opening match means no photo count, even with data in the map", () => {
    const map = buildLiveOverlay(
      baseInput({ photoCounts: new Map([["op-1", 4]]) }),
      ["1"],
    );
    expect(map.get("1")?.photoCount).toBeUndefined();
  });
});

describe("buildLiveOverlay: RO-mismatch warning (#14)", () => {
  const flatCfg: UnitConfig = {
    kind: "window",
    heightMm: 72 * 25.4,
    panels: [{ widthMm: 36 * 25.4, mechanism: "fixed" }],
  };

  it("flags a unit whose measured RO won't take its resolved config", () => {
    const map = buildLiveOverlay(
      baseInput({
        openings: [opening({ opening_code: "1", ro_width_in: 35.5, ro_height_in: 72.25 })],
        configByMark: new Map([["1", flatCfg]]),
      }),
      ["1"],
    );
    expect(map.get("1")?.roProblem).toMatch(/width/);
  });

  it("says nothing when the measured RO is within roCheck's range", () => {
    const map = buildLiveOverlay(
      baseInput({
        openings: [opening({ opening_code: "1", ro_width_in: 36.25, ro_height_in: 72.25 })],
        configByMark: new Map([["1", flatCfg]]),
      }),
      ["1"],
    );
    expect(map.get("1")?.roProblem).toBeUndefined();
  });

  it("says nothing without a resolved config for the mark — no input, no check", () => {
    const map = buildLiveOverlay(
      baseInput({
        openings: [opening({ opening_code: "1", ro_width_in: 1, ro_height_in: 1 })],
      }),
      ["1"],
    );
    expect(map.get("1")?.roProblem).toBeUndefined();
  });

  it("matches configs by BASE mark — a twin opening resolves through markKeyOf", () => {
    const map = buildLiveOverlay(
      baseInput({
        openings: [opening({ opening_code: "16-1", ro_width_in: 1, ro_height_in: 1 })],
        configByMark: new Map([["16", flatCfg]]),
      }),
      ["16-1"],
    );
    expect(map.get("16-1")?.roProblem).toBeTruthy();
  });
});

describe("buildLiveOverlay: precedence when several signals apply at once", () => {
  it("blocked + flashing-owed + glow + parts all land on the SAME unit — additive, nothing clobbers", () => {
    const map = buildLiveOverlay(
      baseInput({
        managerView: true,
        openings: [
          opening({ opening_code: "16-1", assigned_to: "ben", status: "assigned", needs_flashing: true }),
        ],
        sessions: [
          sess({
            opening_id: "op-16-1",
            end_reason: "block",
            ended_at: "2026-08-16T10:00:00Z",
            block_reason: "Missing hardware",
          }),
        ],
        // Sitting in a real container on purpose — this test is about the
        // OTHER four signals stacking; loose gets its own tests below.
        packages: [pkg({ marks: ["16"], part_index: 1, part_total: 2, container_id: "conex-1" })],
      }),
      ["16-1"],
    );
    const state = map.get("16-1");
    expect(state).toEqual({
      glow: "red",
      blockedReason: "Missing hardware",
      flashingOwed: true,
      partsLine: "1 of 2 here · no label yet for part 2",
    });
  });

  it("dim and partsLine are structurally exclusive — a mark is never both", () => {
    const dimmed = buildLiveOverlay(
      baseInput({
        scheduledMarks: [{ project_id: "job-1", mark_code: "16" } satisfies ScheduledMark],
      }),
      ["16"],
    );
    const tagged = buildLiveOverlay(
      baseInput({
        scheduledMarks: [{ project_id: "job-1", mark_code: "16" } satisfies ScheduledMark],
        packages: [pkg({ marks: ["16"] })],
      }),
      ["16"],
    );
    expect(dimmed.get("16")?.dim).toBe(true);
    expect(dimmed.get("16")?.partsLine).toBeUndefined();
    expect(tagged.get("16")?.dim).toBeUndefined();
    expect(tagged.get("16")?.partsLine).toBeTruthy();
  });

  it("loose and dim never coexist either — loose requires a tagged package to exist", () => {
    const map = buildLiveOverlay(
      baseInput({
        scheduledMarks: [{ project_id: "job-1", mark_code: "16" } satisfies ScheduledMark],
        packages: [pkg({ marks: ["16"], status: "received", container_id: null, location_id: null })],
      }),
      ["16"],
    );
    expect(map.get("16")?.loose).toBe(true);
    expect(map.get("16")?.dim).toBeUndefined();
  });
});
