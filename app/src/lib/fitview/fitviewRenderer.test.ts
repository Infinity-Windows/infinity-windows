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

describe("stories: stacked rendering", () => {
  const S = 56; // px per metre, the renderer's scale
  const RECT = [
    { x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 8 }, { x: 0, z: 8 },
  ];
  const SMALL = [
    { x: 2, z: 2 }, { x: 6, z: 2 }, { x: 6, z: 6 }, { x: 2, z: 6 },
  ];
  const job = {
    id: "p1", ref: "Two story", addr: "",
    building: {
      width: 0, depth: 0, height: 3, rise: 0, footprints: [],
      stories: [
        { n: 1, name: "Ground", elevM: 0, heightM: 3, footprints: [RECT] },
        { n: 2, name: "Great room", elevM: 3, heightM: 1.5, footprints: [SMALL], partial: true },
      ],
    },
    // Renderer contract: absolute sill heights (the adapter converts).
    windows: [
      { id: "G1", elev: "s0", floor: "Ground", room: "", type: "Fixed",
        w: 900, h: 1200, x: 2, y: 0.9, lights: 1, open: "fixed", status: "tofit", story: 1 },
      { id: "C1", elev: "s4", floor: "Upper", room: "", type: "Clerestory fixed",
        w: 900, h: 800, x: 1, y: 3.4, lights: 1, open: "fixed", status: "tofit", story: 2 },
    ],
  };

  it("builds one wall per story edge, each spanning its own band", () => {
    const { host, view } = mount(job as never);
    const faces = host.querySelectorAll(".face");
    expect(faces.length).toBe(8); // 4 ground + 4 partial upper
    const ground = host.querySelector<HTMLElement>('.face[data-elev="s0"]')!;
    const upper = host.querySelector<HTMLElement>('.face[data-elev="s4"]')!;
    expect(ground.dataset.story).toBe("1");
    expect(upper.dataset.story).toBe("2");
    expect(parseFloat(ground.style.height)).toBeCloseTo(3 * S, 1);
    expect(parseFloat(upper.style.height)).toBeCloseTo(1.5 * S, 1);
    view.destroy();
  });

  it("story chips focus one story and drop the rest to an x-ray", () => {
    const { host, view } = mount(job as never);
    const strip = host.querySelector<HTMLElement>("#storyStrip")!;
    expect(strip.hidden).toBe(false);
    const chips = strip.querySelectorAll("button");
    expect(chips.length).toBe(3); // All floors + Ground + Great room
    expect(chips[2].textContent).toContain("Great room");

    chips[2].click();
    const dimmed = host.querySelectorAll(".face.story-dim");
    expect(dimmed.length).toBe(4); // the four ground-story walls
    expect(
      host.querySelector('.face[data-elev="s4"]')!.classList.contains("story-dim"),
    ).toBe(false);
    // Wall chips shrink to the focused story's walls (+ the 3D chip).
    const wallChips = host.querySelectorAll("#elevStrip .elev");
    expect(wallChips.length).toBeLessThanOrEqual(5);

    chips[0].click(); // All floors
    expect(host.querySelectorAll(".face.story-dim").length).toBe(0);
    view.destroy();
  });

  it("single-story models hide the strip entirely", () => {
    const { host, view } = mount();
    expect(host.querySelector<HTMLElement>("#storyStrip")!.hidden).toBe(true);
    view.destroy();
  });

  it("a story-2 window sits at its absolute height within its story's face", () => {
    const { host, view } = mount(job as never);
    const win = host.querySelector<HTMLElement>('.win[data-id="C1"]')!;
    // top within face = (plate 4.5 - sill 3.4 - 0.8m tall) * S
    expect(parseFloat(win.style.top)).toBeCloseTo((4.5 - 3.4 - 0.8) * S, 1);
    const g1 = host.querySelector<HTMLElement>('.win[data-id="G1"]')!;
    expect(parseFloat(g1.style.top)).toBeCloseTo((3 - 0.9 - 1.2) * S, 1);
    view.destroy();
  });
});

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
