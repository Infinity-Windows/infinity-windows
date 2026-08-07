// @vitest-environment happy-dom
//
// Smoke tests for the vendored plan tracer: mount with the traced Black
// Desert fixture and a bare job, drive the staged-save seam.
import { describe, expect, it } from "vitest";
import { mountTracePlan } from "./traceRenderer";
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
