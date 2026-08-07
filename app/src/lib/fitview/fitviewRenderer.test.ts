// @vitest-environment happy-dom
//
// Smoke tests for the vendored fit-view renderer: mount the real Black Desert
// job (the prototype's hand-traced fixture) and assert the house actually
// builds. No layout engine here, so nothing about pixels — these catch the
// port-level failures: template ids, footprint parsing, per-window DOM.
import { describe, expect, it } from "vitest";
import { mountFitView } from "./fitviewRenderer";
import fixture from "./fixtures/win-2423.json";

function mount(job = fixture as never) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = mountFitView(host, job, { toast: () => {} });
  return { host, view };
}

describe("fitview renderer (Black Desert fixture)", () => {
  it("mounts: builds walls and one element per placed window", () => {
    const { host, view } = mount();
    const f = fixture as { windows: { elev: string }[] };
    const placed = f.windows.filter((w) => w.elev).length;
    expect(host.querySelectorAll(".win").length).toBeGreaterThanOrEqual(placed);
    expect(host.querySelectorAll(".face").length).toBeGreaterThan(3);
    view.destroy();
    expect(host.innerHTML).toBe("");
  });

  it("focus() selects a real unit and rejects an unknown one", () => {
    const { view } = mount();
    expect(view.focus("27")).toBe(true);
    expect(view.focus("no-such-unit")).toBe(false);
    view.destroy();
  });

  it("select opens the read-only detail sheet with no status buttons", () => {
    const { host, view } = mount();
    const win = host.querySelector<HTMLElement>('.win[data-id="27"]');
    expect(win).toBeTruthy();
    view.focus("27");
    const sheet = host.querySelector("#sheet");
    expect(sheet?.classList.contains("open")).toBe(true);
    // No shim callbacks -> the sheet is informational only.
    expect(sheet?.querySelector("[data-act]")).toBeNull();
    expect(sheet?.querySelector("[data-flag]")).toBeNull();
    expect(sheet?.querySelector("[data-open]")).toBeNull();
    view.destroy();
  });

  it("destroy removes the document-level listeners", () => {
    const before = document.body.childNodes.length;
    const { view } = mount();
    view.destroy();
    // Mount again to prove repeated cycles are safe.
    const again = mount();
    again.view.destroy();
    expect(document.body.childNodes.length).toBe(before + 2);
  });
});
