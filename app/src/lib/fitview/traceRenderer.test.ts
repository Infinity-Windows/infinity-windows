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
