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
