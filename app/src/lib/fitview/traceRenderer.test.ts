// @vitest-environment happy-dom
//
// Smoke tests for the vendored plan tracer: mount with the traced Black
// Desert fixture and a bare job, drive the staged-save seam.
import { describe, expect, it } from "vitest";
import { bearingFromAnchor, compassName, mountTracePlan } from "./traceRenderer";
import fixture from "./fixtures/win-2423.json";

function mount(job: unknown, shim: Record<string, unknown> = {}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = mountTracePlan(host, job, { toast: () => {}, ...shim });
  return { host, view };
}

describe("trace renderer", () => {
  it("mounts a bare job: tray empty, no-plan fallback shown", () => {
    const { host, view } = mount({
      id: "p1", ref: "Job", addr: "",
      building: { width: 0, depth: 0, height: 3.6, rise: 0, footprints: [] },
      windows: [],
    });
    expect(host.querySelector("#noplan")?.hasAttribute("hidden")).toBe(false);
    expect(host.querySelectorAll("#tray .chip-dot").length).toBe(0);
    view.destroy();
    expect(host.innerHTML).toBe("");
  });

  // Mad Moose (2026-08-31): 10 saved suggestions, zero confirmed pins. This
  // job has never been traced before, so MapsTrace.tsx builds its job via
  // buildFitViewJob rather than buildAuthoredJob — and buildFitViewJob only
  // geometrizes openings that ALREADY have a confirmed pin_x/pin_y (adapter.ts,
  // "Only openings pinned on the outline's page are placed on the model").
  // A suggestion-only mark therefore never appears in JOB.windows; the
  // vision-placement e2e (vision-placement.spec.ts) never catches this
  // because its fixture pre-seeds an AUTHORED model whose windows[] already
  // lists the mark, sidestepping exactly the gap Mad Moose falls into.
  it("wave V-A: a suggestion still seeds and shows in the tray when the model has no confirmed windows yet (Mad Moose)", () => {
    const job = {
      id: "p1", ref: "Mad Moose", addr: "",
      building: {
        width: 0, depth: 0, height: 3.6, rise: 0, footprints: [],
        trace: {
          cal: { ax: 0, ay: 0, bx: 100, by: 0, value: 10, unit: "m" },
          polys: [[{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 400 }, { x: 0, y: 400 }]],
          dots: {},
        },
      },
      windows: [], // buildFitViewJob's real output for a job with no confirmed pins yet
    };
    const { host, view } = mount(job, {
      suggestedSeed: {
        "1A": { x: 100, y: 6, confidence: 0.92 },
        "1B": { x: 200, y: 6, confidence: 0.9 },
      },
    });
    expect(host.querySelectorAll("#ol [data-sugg]").length).toBe(2);
    expect(host.querySelectorAll("#tray .chip-dot").length).toBe(2);
    view.destroy();
  });

  // The bug's other half: Mad Moose's plan-set titles resolve to more than
  // one story ("MAIN FLR FLOOR PLAN" / "UPPER FLOOR PLAN"). storyPlan.byId
  // is built (MapsTrace.tsx's storyPlan callback) by walking JOB.windows —
  // which, per the test above, is empty for a never-traced job — so byId
  // comes back empty even though the titles DID resolve real stories. The
  // old gate ("titles couldn't say - leave unplaced, not a guess") could not
  // tell that apart from a genuine unresolved mark, and dropped every
  // suggestion silently. A suggestion is reviewed by a human before it
  // becomes anything real, so — unlike Auto-place's confirmed dots — landing
  // it on the wrong story by default costs nothing worse than a drag.
  it("wave V-A: multi-story sheet titles never swallow a suggestion whose mark isn't in the model yet (Mad Moose)", () => {
    const job = {
      id: "p1", ref: "Mad Moose", addr: "",
      building: {
        width: 0, depth: 0, height: 3.6, rise: 0, footprints: [],
        trace: {
          cal: { ax: 0, ay: 0, bx: 100, by: 0, value: 10, unit: "m" },
          polys: [[{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 400 }, { x: 0, y: 400 }]],
          dots: {},
        },
      },
      windows: [],
    };
    const { host, view } = mount(job, {
      suggestedSeed: { "1A": { x: 100, y: 6, confidence: 0.92 } },
      storyPlan: {
        stories: [
          { n: 1, name: "Ground", evidence: "MAIN FLR FLOOR PLAN" },
          { n: 2, name: "Level 2", evidence: "UPPER FLOOR PLAN" },
        ],
        byId: {}, // empty: no window ever reached storyPlan, not "titles said nothing"
        unclear: {},
      },
    });
    expect(host.querySelectorAll("#ol [data-sugg]").length).toBe(1);
    expect(host.querySelectorAll("#tray .chip-dot").length).toBe(1);
    view.destroy();
  });

  it("restores the fixture's stored trace: polys drawn, dots back, tray full", () => {
    const { host, view } = mount(fixture);
    const f = fixture as { windows: unknown[]; building: { trace: { polys: unknown[] } } };
    expect(host.querySelectorAll("#tray .chip-dot").length).toBe(f.windows.length);
    // Every restored polygon renders as a path in the overlay SVG.
    expect(host.querySelectorAll("#ol path").length).toBeGreaterThanOrEqual(
      f.building.trace.polys.length,
    );
    view.destroy();
  });

  it("undoes a whole auto-place in one action", () => {
    // The fixture with its placed dots forgotten: everything sits in the
    // tray, and the seed knows where the dots belong.
    const f = JSON.parse(JSON.stringify(fixture));
    const seed = f.building.trace.dots;
    f.building.trace.dots = {};
    const { host, view } = mount(f, { dotSeed: seed });

    const placed = () => host.querySelectorAll("#tray .chip-dot.placed").length;
    const undoBtn = host.querySelector("#undoAct") as HTMLButtonElement;
    expect(placed()).toBe(0);
    expect(undoBtn.disabled).toBe(true);

    (host.querySelector("#autoBtn") as HTMLButtonElement).click();
    const afterAuto = placed();
    expect(afterAuto).toBeGreaterThan(30);
    expect(undoBtn.disabled).toBe(false);

    undoBtn.click();
    expect(placed()).toBe(0);
    expect(undoBtn.disabled).toBe(true);
    view.destroy();
  });

  it("an auto-place that changes nothing costs no undo step", () => {
    // Every dot already placed (full fixture): auto-place skips them all.
    const f = fixture as { building: { trace: { dots: Record<string, unknown> } } };
    const { host, view } = mount(fixture, { dotSeed: f.building.trace.dots });
    const undoBtn = host.querySelector("#undoAct") as HTMLButtonElement;
    (host.querySelector("#autoBtn") as HTMLButtonElement).click();
    expect(undoBtn.disabled).toBe(true);
    view.destroy();
  });

  it("auto-traces the extracted outline as an editable building, once", () => {
    const seed = [[{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 60 }, { x: 0, y: 60 }]];
    const { host, view } = mount(
      {
        id: "p1", ref: "Job", addr: "",
        building: { width: 0, depth: 0, height: 3.6, rise: 0, footprints: [] },
        windows: [],
      },
      { outlineSeed: seed },
    );
    const autoTrace = host.querySelector("#autoTrace") as HTMLButtonElement;
    const undo = host.querySelector("#undoAct") as HTMLButtonElement;
    const paths = () => host.querySelectorAll("#ol path").length;
    expect(autoTrace.hidden).toBe(false);
    expect(paths()).toBe(0);

    autoTrace.click();
    expect(paths()).toBeGreaterThan(0);
    // Second tap must not stack a duplicate building.
    autoTrace.click();
    expect(paths()).toBe(1);

    undo.click();
    expect(paths()).toBe(0);
    view.destroy();
  });

  it("derives corner legs from the spec + dot position, snapped to panes", () => {
    // A 40m x 40m calibrated square; one corner-by-spec unit whose dot sits
    // NEAR a corner (1m away) but not on it, one plain unit mid-wall.
    const job = {
      id: "p1", ref: "Job", addr: "",
      building: {
        width: 0, depth: 0, height: 4, rise: 0, footprints: [],
        trace: {
          cal: { ax: 0, ay: 0, bx: 100, by: 0, value: 10, unit: "m" },
          polys: [[{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 400 }, { x: 0, y: 400 }]],
          dots: { C1: { x: 390, y: 8 }, P1: { x: 200, y: 6 } },
        },
      },
      windows: [
        {
          id: "C1", type: "Fixed aluminum window, 90-degree corner",
          w: 2000, h: 1200, elev: "", x: 0, y: 0.9, lights: 2, open: "fixed",
          status: "tofit", panes: [1200, 800],
        },
        {
          id: "P1", type: "Fixed aluminum window",
          w: 1000, h: 1200, elev: "", x: 0, y: 0.9, lights: 1, open: "fixed",
          status: "tofit",
        },
      ],
    };
    const ops: { op: string; window?: { id: string } & Record<string, unknown> }[] = [];
    const { host, view } = mount(job, { pushOp: (op: never) => ops.push(op) });
    (host.querySelector("#submitBtn") as HTMLButtonElement).click();

    const up = (id: string) =>
      ops.find((o) => o.op === "upsert" && o.window?.id === id)?.window as Record<string, unknown>;
    const corner = up("C1");
    // The spec said corner and the dot was near one: legs derived and
    // snapped to the real pane boundary, lights split across the corner.
    expect(corner.legs).toEqual([1200, 800]);
    expect(corner.lightsSplit).toEqual([1, 1]);
    expect(corner.wrap === "start" || corner.wrap === "end").toBe(true);
    // The plain unit stays a plain unit.
    const plain = up("P1");
    expect(plain.legs).toBeUndefined();
    expect(plain.wrap).toBeUndefined();
    view.destroy();
  });

  it("story rail: add a story, place a window on it, submit a storied model", () => {
    const job = {
      id: "p1", ref: "Job", addr: "",
      building: {
        width: 0, depth: 0, height: 3, rise: 0, footprints: [],
        trace: {
          cal: { ax: 0, ay: 0, bx: 100, by: 0, value: 10, unit: "m" },
          polys: [[{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 400 }, { x: 0, y: 400 }]],
          dots: {},
        },
      },
      windows: [
        { id: "U1", type: "Fixed", w: 1200, h: 1000, elev: "", x: 0, y: 0, lights: 1, open: "fixed", status: "tofit" },
        { id: "G1", type: "Fixed", w: 1000, h: 1000, elev: "", x: 0, y: 0, lights: 1, open: "fixed", status: "tofit" },
      ],
    };
    const ops: { op: string; building?: Record<string, unknown>; window?: { id: string } & Record<string, unknown> }[] = [];
    const { host, view } = mount(job, {
      pushOp: (op: never) => ops.push(op),
      dotSeed: { U1: { x: 390, y: 200 } },
    });

    const rail = () => [...host.querySelectorAll<HTMLButtonElement>("#storyRail button")];
    expect(rail().map((b) => b.textContent)).toEqual(["Ground 3m", "+ Story"]);

    // Add a story: footprint copies from below, focus moves up, ghost shows.
    (host.querySelector("#addStory") as HTMLButtonElement).click();
    expect(rail().some((b) => b.textContent?.includes("Level 2"))).toBe(true);
    expect(host.querySelector('#ol path[stroke-dasharray]')).toBeTruthy();

    // Auto-place lands the dot on the ACTIVE story — story 2.
    (host.querySelector("#autoBtn") as HTMLButtonElement).click();
    expect(host.querySelectorAll("#tray .chip-dot.placed").length).toBe(1);
    // From the ground story, that same chip reads as placed elsewhere.
    rail()[0].click();
    expect(host.querySelectorAll("#tray .chip-dot.elsewhere").length).toBe(1);

    (host.querySelector("#submitBtn") as HTMLButtonElement).click();
    const bld = ops.find((o) => o.op === "building")!.building as {
      height: number;
      stories: { n: number; elevM: number; heightM: number; footprints: unknown[] }[];
      trace: { stories: unknown[] };
    };
    expect(bld.stories).toHaveLength(2);
    expect(bld.stories[0]).toMatchObject({ n: 1, elevM: 0, heightM: 3 });
    expect(bld.stories[1]).toMatchObject({ n: 2, elevM: 3, heightM: 3 });
    expect(bld.height).toBe(6);
    expect(bld.trace.stories).toHaveLength(2);

    const u1 = ops.find((o) => o.op === "upsert" && o.window?.id === "U1")!.window!;
    expect(u1.story).toBe(2);
    expect(u1.y).toBe(0.9);           // fresh story: sane sill above ITS floor
    expect(u1.elev).toMatch(/^s[4-7]$/); // one of story 2's four walls
    const g1 = ops.find((o) => o.op === "upsert" && o.window?.id === "G1")!.window!;
    expect(g1.elev).toBe("");          // never placed: off the model, no story
    expect(g1.story).toBeUndefined();
    view.destroy();
  });

  it("phase 2: sheet titles drive auto-place across stories, honestly", () => {
    const job = {
      id: "p1", ref: "Job", addr: "",
      building: {
        width: 0, depth: 0, height: 3, rise: 0, footprints: [],
        trace: {
          cal: { ax: 0, ay: 0, bx: 100, by: 0, value: 10, unit: "m" },
          polys: [[{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 400 }, { x: 0, y: 400 }]],
          dots: {},
        },
      },
      windows: [
        { id: "G1", type: "Fixed", w: 1000, h: 1000, elev: "", x: 0, y: 0, lights: 1, open: "fixed", status: "tofit" },
        { id: "U1", type: "Fixed", w: 1200, h: 1000, elev: "", x: 0, y: 0, lights: 1, open: "fixed", status: "tofit" },
        { id: "X1", type: "Fixed", w: 900, h: 900, elev: "", x: 0, y: 0, lights: 1, open: "fixed", status: "tofit" },
      ],
    };
    const ops: { op: string; window?: { id: string } & Record<string, unknown> }[] = [];
    const { host, view } = mount(job, {
      pushOp: (op: never) => ops.push(op),
      dotSeed: { G1: { x: 200, y: 6 }, U1: { x: 200, y: 394 }, X1: { x: 6, y: 200 } },
      storyPlan: {
        stories: [
          { n: 1, name: "Ground", evidence: "MAIN FLR FLOOR PLAN" },
          { n: 2, name: "Level 2", evidence: "UPPER FLOOR PLAN" },
        ],
        byId: {
          G1: { story: 1, evidence: "sheet 2: MAIN FLR FLOOR PLAN" },
          U1: { story: 2, evidence: "sheet 3: UPPER FLOOR PLAN" },
        },
        unclear: { X1: "typical-floor range 2–6 (expanded in a later phase)" },
      },
    });

    (host.querySelector("#autoBtn") as HTMLButtonElement).click();
    // The detected story exists now (footprint copied below) and each dot
    // landed on its own story; the unclear one stayed in the tray, flagged.
    expect([...host.querySelectorAll("#storyRail button")].some(
      (b) => b.textContent?.includes("Level 2"))).toBe(true);
    const unclearChip = host.querySelector<HTMLElement>("#tray .chip-dot.unclear")!;
    expect(unclearChip).toBeTruthy();
    expect(unclearChip.title).toContain("typical-floor range");

    (host.querySelector("#submitBtn") as HTMLButtonElement).click();
    const up = (id: string) =>
      ops.find((o) => o.op === "upsert" && o.window?.id === id)!.window!;
    expect(up("G1")).toMatchObject({ story: 1, storyConfidence: "probable" });
    expect(up("G1").storyEvidence).toContain("MAIN FLR");
    expect(up("U1")).toMatchObject({ story: 2, storyConfidence: "probable" });
    expect(up("X1")).toMatchObject({ elev: "", storyConfidence: "unclear" });
    expect(up("X1").storyEvidence).toContain("typical-floor range");
    view.destroy();
  });

  it("phase 2: a hand-dragged dot submits as the human's word", () => {
    // Reuse the corner-test rig: real pointer drop is exercised elsewhere;
    // here the drop handler path is what stamps byHand.
    const job = {
      id: "p1", ref: "Job", addr: "",
      building: {
        width: 0, depth: 0, height: 3, rise: 0, footprints: [],
        trace: {
          cal: { ax: 0, ay: 0, bx: 100, by: 0, value: 10, unit: "m" },
          polys: [[{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 400 }, { x: 0, y: 400 }]],
          dots: { H1: { x: 200, y: 6 } },
        },
      },
      windows: [
        { id: "H1", type: "Fixed", w: 1000, h: 1000, elev: "s0", x: 1, y: 0.9, lights: 1, open: "fixed", status: "tofit", story: 1 },
      ],
    };
    const ops: { op: string; window?: { id: string } & Record<string, unknown> }[] = [];
    const { host, view } = mount(job, { pushOp: (op: never) => ops.push(op) });
    (host.querySelector("#submitBtn") as HTMLButtonElement).click();
    const h1 = ops.find((o) => o.op === "upsert" && o.window?.id === "H1")!.window!;
    expect(h1.storyConfidence).toBe("confirmed");
    expect(h1.storyEvidence).toBe("placed by hand");
    view.destroy();
  });

  it("phase 3: a typical-floor sheet clones its windows up the range, and the declared scale stands in for calibration", () => {
    const job = {
      id: "p1", ref: "Apartments", addr: "",
      building: {
        width: 0, depth: 0, height: 3, rise: 0, footprints: [],
        trace: {
          // No cal on purpose: the sheet's declared scale must carry submit.
          polys: [[{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 400 }, { x: 0, y: 400 }]],
          dots: {},
        },
      },
      windows: [
        { id: "101", type: "Fixed", w: 1000, h: 1000, elev: "", x: 0, y: 0, lights: 1, open: "fixed", status: "tofit" },
        { id: "201", type: "Fixed", w: 1200, h: 1000, elev: "", x: 0, y: 0, lights: 1, open: "fixed", status: "tofit" },
      ],
    };
    const ops: { op: string; building?: Record<string, unknown>; window?: { id: string } & Record<string, unknown> }[] = [];
    const { host, view } = mount(job, {
      pushOp: (op: never) => ops.push(op),
      dotSeed: { "101": { x: 200, y: 6 }, "201": { x: 100, y: 6 } },
      // 0.025 m/px makes the 400px square a 10m building.
      scaleSuggestion: { metresPerPx: 0.025, evidence: '1/4" = 1\'-0"' },
      storyPlan: {
        stories: [
          { n: 1, name: "Ground", evidence: "LEVEL 1 FLOOR PLAN" },
          { n: 2, name: "Level 2", evidence: "FLOOR PLAN — LEVELS 2-4" },
          { n: 3, name: "Level 3", evidence: "FLOOR PLAN — LEVELS 2-4" },
          { n: 4, name: "Level 4", evidence: "FLOOR PLAN — LEVELS 2-4" },
        ],
        byId: {
          "101": { story: 1, evidence: "sheet 2: LEVEL 1 FLOOR PLAN", confidence: "probable" },
          "201": { story: 2, evidence: "sheet 3: FLOOR PLAN — LEVELS 2-4", confidence: "probable", range: [2, 4] },
        },
        unclear: {},
      },
    });

    (host.querySelector("#autoBtn") as HTMLButtonElement).click();
    // Four stories now exist from the detection.
    expect([...host.querySelectorAll("#storyRail button")]
      .filter((b) => !b.id).length).toBe(4);

    (host.querySelector("#submitBtn") as HTMLButtonElement).click();
    const bld = ops.find((o) => o.op === "building")!.building as {
      stories: { n: number }[];
      trace: { cal: { declaredScale?: number; evidence?: string } };
    };
    // Submit went through WITHOUT manual calibration, on the declared scale.
    expect(bld.stories).toHaveLength(4);
    expect(bld.trace.cal.declaredScale).toBeCloseTo(0.025, 6);
    expect(bld.trace.cal.evidence).toContain('1/4"');

    // The typical-floor window exists once in the schedule, three times in
    // the model: the original on story 2, clones on 3 and 4 — probable, with
    // the cloning spelled out.
    const ups = ops.filter((o) => o.op === "upsert").map((o) => o.window!);
    const w201 = ups.filter((w) => String(w.id).startsWith("201"));
    expect(w201.map((w) => [w.id, w.story])).toEqual([
      ["201", 2], ["201@L3", 3], ["201@L4", 4],
    ]);
    expect(w201[1].storyConfidence).toBe("probable");
    expect(String(w201[1].storyEvidence)).toContain("cloned from typical sheet");
    // Clones sit on the SAME wall of their own story.
    expect(w201[1].elev).not.toBe(w201[0].elev);
    expect(w201[0].x).toBe(w201[1].x);
    view.destroy();
  });

  it("removing the top story frees its windows back to the tray", () => {
    const job = {
      id: "p1", ref: "Job", addr: "",
      building: {
        width: 0, depth: 0, height: 3, rise: 0, footprints: [],
        trace: {
          cal: { ax: 0, ay: 0, bx: 100, by: 0, value: 10, unit: "m" },
          stories: [
            { name: "Ground", heightM: 3,
              polys: [[{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 400 }, { x: 0, y: 400 }]],
              dots: {} },
            { name: "Level 2", heightM: 3,
              polys: [[{ x: 100, y: 100 }, { x: 300, y: 100 }, { x: 300, y: 300 }, { x: 100, y: 300 }]],
              dots: { U1: { x: 200, y: 100 } } },
          ],
        },
      },
      windows: [
        { id: "U1", type: "Fixed", w: 1200, h: 1000, elev: "s4", x: 1, y: 0.9, lights: 1, open: "fixed", status: "tofit", story: 2 },
      ],
    };
    const { host, view } = mount(job);
    expect(host.querySelectorAll("#storyRail button").length).toBe(4); // 2 stories + add + remove
    expect(host.querySelectorAll("#tray .chip-dot.placed").length).toBe(1);

    const rm = host.querySelector("#removeStory") as HTMLButtonElement;
    rm.click();               // arm
    rm.click();               // confirm
    expect([...host.querySelectorAll("#storyRail button")].some((b) => b.textContent?.includes("Level 2"))).toBe(false);
    expect(host.querySelectorAll("#tray .chip-dot.placed").length).toBe(0);

    // And the whole removal is one undo step.
    (host.querySelector("#undoAct") as HTMLButtonElement).click();
    expect(host.querySelectorAll("#tray .chip-dot.placed").length).toBe(1);
    view.destroy();
  });

  it("box erase removes every outline point in the drag, one undo brings them back", () => {
    const job = {
      id: "p1", ref: "Job", addr: "",
      building: {
        width: 0, depth: 0, height: 3, rise: 0, footprints: [],
        trace: {
          cal: { ax: 0, ay: 0, bx: 100, by: 0, value: 10, unit: "m" },
          // A messy 6-point outline: two stray points up in one corner.
          polys: [[
            { x: 0, y: 0 }, { x: 180, y: 20 }, { x: 220, y: 15 },
            { x: 400, y: 0 }, { x: 400, y: 400 }, { x: 0, y: 400 },
          ]],
          dots: {},
        },
      },
      windows: [],
    };
    const { host, view } = mount(job);
    const pts = () => host.querySelectorAll("#ol [data-v]").length;
    expect(pts()).toBe(6);

    // Arm Delete box, drag ONE box over the two stray points.
    const arm = host.querySelector("#boxErase") as HTMLButtonElement;
    arm.click();
    expect(arm.getAttribute("aria-pressed")).toBe("true");
    const st = host.querySelector("#tstage")!;
    const mk = (type: string, x: number, y: number) =>
      st.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, pointerId: 5, isPrimary: true }));
    // toWorld is identity-ish at k=1 with the stage at 0,0 in happy-dom.
    mk("pointerdown", 150, 5);
    mk("pointermove", 260, 40);
    mk("pointerup", 260, 40);
    expect(pts()).toBe(4);   // the two strays gone, the shape still closed
    // One shot: the button disarmed itself, the next drag pans again.
    expect(arm.getAttribute("aria-pressed")).toBe("false");
    mk("pointerdown", 10, 10);
    mk("pointermove", 120, 120);
    mk("pointerup", 120, 120);
    expect(pts()).toBe(4);   // that drag was a pan, not another box

    (host.querySelector("#undoAct") as HTMLButtonElement).click();
    expect(pts()).toBe(6);
    view.destroy();
  });

  it("a box with nothing inside costs no undo step", () => {
    const job = {
      id: "p1", ref: "Job", addr: "",
      building: {
        width: 0, depth: 0, height: 3, rise: 0, footprints: [],
        trace: {
          cal: { ax: 0, ay: 0, bx: 100, by: 0, value: 10, unit: "m" },
          polys: [[{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 400 }, { x: 0, y: 400 }]],
          dots: {},
        },
      },
      windows: [],
    };
    const { host, view } = mount(job);
    (host.querySelector("#boxErase") as HTMLButtonElement).click();
    const st = host.querySelector("#tstage")!;
    const mk = (type: string, x: number, y: number) =>
      st.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, pointerId: 6, isPrimary: true }));
    mk("pointerdown", 150, 100);
    mk("pointermove", 250, 200);
    mk("pointerup", 250, 200);
    expect(host.querySelectorAll("#ol [data-v]").length).toBe(4);
    expect((host.querySelector("#undoAct") as HTMLButtonElement).disabled).toBe(true);
    view.destroy();
  });

  it("submit stages a building and window upserts through the shim", () => {
    const ops: { op: string }[] = [];
    let done = 0;
    const { host, view } = mount(fixture, {
      pushOp: (op: { op: string }) => ops.push(op),
      done: () => { done++; },
    });
    (host.querySelector("#submitBtn") as HTMLButtonElement).click();
    expect(ops.some((o) => o.op === "building")).toBe(true);
    expect(ops.filter((o) => o.op === "upsert").length).toBeGreaterThan(0);
    // done() fires on a delay so the toast is readable.
    return new Promise<void>((res) =>
      setTimeout(() => {
        expect(done).toBe(1);
        view.destroy();
        res();
      }, 1400),
    );
  });
});

describe("wave N: true north math (pure helpers)", () => {
  it("compassName buckets by the FOUR compass words, northDeg subtracted first", () => {
    const used: Record<string, number> = {};
    // With no north set (0), the raw wall angle is trusted as-is - the exact
    // pre-wave-N behavior, so an untraced-for-north job keeps its old names.
    expect(compassName(0, used, 0)).toBe("South");
    expect(compassName(90, {}, 0)).toBe("East");
    expect(compassName(180, {}, 0)).toBe("North");   // wraps past 180 to -180
    expect(compassName(270, {}, 0)).toBe("West");    // wraps to -90
    // Edge: 44° sits just inside the South bucket's (-45, 45] boundary.
    expect(compassName(44, {}, 0)).toBe("South");
    expect(compassName(46, {}, 0)).toBe("East");
    // A wall that would have named "East" under the old plan-up assumption
    // renames "South" once true north is declared 90° clockwise of plan-up -
    // exactly compassName subtracting northDeg before bucketing.
    expect(compassName(90, {}, 90)).toBe("South");
    // A repeat in the same bucket still numbers ("South 2"), unaffected by
    // the north offset - only WHICH bucket a wall lands in changes.
    const used2: Record<string, number> = {};
    expect(compassName(44, used2, 0)).toBe("South");
    expect(compassName(-40, used2, 0)).toBe("South 2");
  });

  it("bearingFromAnchor: clockwise-from-up, matching northDeg's own definition", () => {
    const a = { x: 0, y: 0 };
    expect(bearingFromAnchor(a, { x: 0, y: -10 })).toBeCloseTo(0, 5);    // up
    expect(bearingFromAnchor(a, { x: 10, y: 0 })).toBeCloseTo(90, 5);    // right
    expect(bearingFromAnchor(a, { x: 0, y: 10 })).toBeCloseTo(180, 5);   // down
    expect(bearingFromAnchor(a, { x: -10, y: 0 })).toBeCloseTo(270, 5);  // left
    // No movement at all: a defined, harmless fallback rather than NaN.
    expect(bearingFromAnchor(a, { x: 0, y: 0 })).toBe(0);
  });
});

describe("wave N: \"Set north\" mode in the tracer", () => {
  function tstageDrag(host: HTMLElement, pts: [number, number][], id = 9) {
    const st = host.querySelector("#tstage")!;
    const mk = (type: string, x: number, y: number) =>
      st.dispatchEvent(
        new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, pointerId: id, isPrimary: true }),
      );
    mk("pointerdown", pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) mk("pointermove", pts[i][0], pts[i][1]);
    mk("pointerup", pts[pts.length - 1][0], pts[pts.length - 1][1]);
  }

  it("a new mode button sits beside Calibrate, and dragging rotates the arrow into the submitted northDeg", () => {
    const job = {
      id: "p1", ref: "Job", addr: "",
      building: {
        width: 0, depth: 0, height: 3, rise: 0, footprints: [],
        trace: {
          cal: { ax: 0, ay: 0, bx: 100, by: 0, value: 10, unit: "m" },
          polys: [[{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 400 }, { x: 0, y: 400 }]],
          dots: {},
        },
      },
      windows: [],
    };
    const ops: { op: string; building?: Record<string, unknown> }[] = [];
    const { host, view } = mount(job, { pushOp: (op: never) => ops.push(op) });

    const calBtn = host.querySelector('[data-mode="cal"]')!;
    const northBtn = host.querySelector('[data-mode="north"]') as HTMLButtonElement;
    expect(northBtn).toBeTruthy();
    expect(northBtn.previousElementSibling).toBe(calBtn);
    expect(northBtn.getAttribute("aria-pressed")).toBe("false");

    northBtn.click();
    expect(northBtn.getAttribute("aria-pressed")).toBe("true");
    // The 400x400 square's bbox center is (200,200) — happy-dom's zeroed
    // getBoundingClientRect makes toWorld the identity, same as the box
    // erase test above. Dragging from the anchor straight right sets north
    // to 90 (bearingFromAnchor's own "right = 90" convention).
    tstageDrag(host, [[200, 200], [300, 200]]);
    expect(host.querySelector('#ol [data-north-handle]')).toBeTruthy();

    (host.querySelector("#submitBtn") as HTMLButtonElement).click();
    const bld = ops.find((o) => o.op === "building")!.building as { northDeg?: number };
    expect(bld.northDeg).toBeCloseTo(90, 1);
    view.destroy();
  });

  it("north is absent from the submit when never set - no fabricated 0", () => {
    const job = {
      id: "p1", ref: "Job", addr: "",
      building: {
        width: 0, depth: 0, height: 3, rise: 0, footprints: [],
        trace: {
          cal: { ax: 0, ay: 0, bx: 100, by: 0, value: 10, unit: "m" },
          polys: [[{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 400 }, { x: 0, y: 400 }]],
          dots: {},
        },
      },
      windows: [],
    };
    const ops: { op: string; building?: Record<string, unknown> }[] = [];
    const { host, view } = mount(job, { pushOp: (op: never) => ops.push(op) });
    (host.querySelector("#submitBtn") as HTMLButtonElement).click();
    const bld = ops.find((o) => o.op === "building")!.building as { northDeg?: number };
    expect("northDeg" in bld).toBe(false);
    view.destroy();
  });

  it("restores a previously-set northDeg from the shim, editable again", () => {
    const job = {
      id: "p1", ref: "Job", addr: "",
      building: {
        width: 0, depth: 0, height: 3, rise: 0, footprints: [],
        trace: {
          cal: { ax: 0, ay: 0, bx: 100, by: 0, value: 10, unit: "m" },
          polys: [[{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 400 }, { x: 0, y: 400 }]],
          dots: {},
        },
      },
      windows: [],
    };
    const ops: { op: string; building?: Record<string, unknown> }[] = [];
    const { host, view } = mount(job, { pushOp: (op: never) => ops.push(op), northDeg: 15 });
    // Untouched, it rides through the next submit exactly as it was.
    (host.querySelector("#submitBtn") as HTMLButtonElement).click();
    const bld = ops.find((o) => o.op === "building")!.building as { northDeg?: number };
    expect(bld.northDeg).toBe(15);
    view.destroy();
  });

  it("dragging north on a building that already has named walls warns once", () => {
    const toasts: string[] = [];
    const { host, view } = mount(fixture, { toast: (m: string) => toasts.push(m) });
    (host.querySelector('[data-mode="north"]') as HTMLButtonElement).click();
    tstageDrag(host, [[0, 0], [40, 0], [40, 5]]);
    expect(toasts.filter((m) => m === "Wall names update on the next trace submit")).toHaveLength(1);
    view.destroy();
  });

  it("dragging north on a never-submitted building (no named walls yet) stays quiet", () => {
    const toasts: string[] = [];
    const job = {
      id: "p1", ref: "Job", addr: "",
      building: {
        width: 0, depth: 0, height: 3, rise: 0, footprints: [],
        trace: {
          cal: { ax: 0, ay: 0, bx: 100, by: 0, value: 10, unit: "m" },
          polys: [[{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 400 }, { x: 0, y: 400 }]],
          dots: {},
        },
      },
      windows: [],
    };
    const { host, view } = mount(job, { toast: (m: string) => toasts.push(m) });
    (host.querySelector('[data-mode="north"]') as HTMLButtonElement).click();
    tstageDrag(host, [[200, 200], [250, 200]]);
    expect(toasts).not.toContain("Wall names update on the next trace submit");
    view.destroy();
  });
});
