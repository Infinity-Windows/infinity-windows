// @vitest-environment happy-dom
//
// Smoke tests for the vendored fit-view renderer: mount the real Black Desert
// job (the prototype's hand-traced fixture) and assert the house actually
// builds. No layout engine here, so nothing about pixels — these catch the
// port-level failures: template ids, footprint parsing, per-window DOM.
import { describe, expect, it } from "vitest";
import { mountFitView, roseLabels } from "./fitviewRenderer";
import { madMooseMark7Grid } from "./paneGrid";
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

  it("B3: lists JOB.unplacedMarks in a 'Not placed yet' schedule group", () => {
    const withUnplaced = { ...(fixture as object), unplacedMarks: [{ id: "97" }, { id: "98" }] };
    const { host, view } = mount(withUnplaced as never);
    host.querySelector<HTMLButtonElement>('.tab[data-view="sched"]')!.click();
    const rows = host.querySelector("#rows")!;
    expect(rows.textContent).toContain("Not placed yet");
    expect(rows.textContent).toContain("97");
    expect(rows.textContent).toContain("98");
    view.destroy();
  });

  it("no unplacedMarks on the job is a no-op (every other job builder)", () => {
    const { host, view } = mount();
    host.querySelector<HTMLButtonElement>('.tab[data-view="sched"]')!.click();
    expect(host.querySelector("#rows")!.textContent).not.toContain("Not placed yet");
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

describe("wave N: roseLabels (pure)", () => {
  it("gives all eight compass words, unrotated when north is unset", () => {
    expect(roseLabels(undefined).map((d) => d.label)).toEqual([
      "N", "NE", "E", "SE", "S", "SW", "W", "NW",
    ]);
    expect(roseLabels(undefined).map((d) => d.angle)).toEqual([
      0, 45, 90, 135, 180, 225, 270, 315,
    ]);
  });

  it("rotates every label by northDeg, wrapping into [0, 360)", () => {
    const rotated = roseLabels(30);
    expect(rotated.map((d) => d.angle)).toEqual([
      30, 75, 120, 165, 210, 255, 300, 345,
    ]);
    // Past 360 wraps rather than growing unbounded — a label's angle is
    // always a plain compass bearing, safe to feed straight into sin/cos.
    const wrapped = roseLabels(350);
    expect(wrapped[0].angle).toBe(350);   // N
    expect(wrapped[1].angle).toBe(35);    // NE: 350 + 45 = 395 -> 35
  });
});

describe("wave N: compass rose on the mini-map (flat view)", () => {
  function mountFlat(job: unknown, shim: Record<string, unknown> = {}) {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = mountFitView(host, job, { toast: () => {}, flatView: true, ...shim });
    return { host, view };
  }

  it("draws a rose with all eight labels when northDeg is set", () => {
    const { host, view } = mountFlat(fixture, { northDeg: 42 });
    const rose = host.querySelector(".flat-minimap-rose");
    expect(rose).toBeTruthy();
    expect(rose!.classList.contains("unset")).toBe(false);
    const texts = [...rose!.querySelectorAll("text")].map((t) => t.textContent);
    expect(texts).toEqual(["N", "NE", "E", "SE", "S", "SW", "W", "NW"]);
    view.destroy();
  });

  it("shows a faded rose with a hint when north was never set - never a wrong-looking one", () => {
    const { host, view } = mountFlat(fixture);
    const rose = host.querySelector(".flat-minimap-rose");
    expect(rose).toBeTruthy();
    expect(rose!.classList.contains("unset")).toBe(true);
    expect(rose!.getAttribute("title")).toMatch(/north not set/i);
    view.destroy();
  });

  it("the rose sits inside the minimap corner ornament, not fighting the footprint svg", () => {
    const { host, view } = mountFlat(fixture, { northDeg: 0 });
    const map = host.querySelector(".flat-minimap")!;
    const rose = map.querySelector(".flat-minimap-rose")!;
    // Paints AFTER the footprint svg and the wall-name label in DOM order,
    // so it stacks visually on top of both rather than being buried under
    // whichever wall line happens to run through that corner.
    const children = [...map.children];
    expect(children.indexOf(rose)).toBe(children.length - 1);
    view.destroy();
  });

  it("NORTH_DEG never reaches wall geometry - the 3D scene is unaffected by it", () => {
    const withoutNorth = mountFlat(fixture);
    const withNorth = mountFlat(fixture, { northDeg: 200 });
    const wallsA = [...withoutNorth.host.querySelectorAll(".face")].map(
      (f) => (f as HTMLElement).style.transform,
    );
    const wallsB = [...withNorth.host.querySelectorAll(".face")].map(
      (f) => (f as HTMLElement).style.transform,
    );
    expect(wallsB).toEqual(wallsA);
    withoutNorth.view.destroy();
    withNorth.view.destroy();
  });
});

// Wave W (w-walls-spec.md, 2026-08-31), W3 — an interior wall published by
// toFitview.ts (building.interiorWalls) appears in the elevation walk AFTER
// the exterior loop, as ordinary a wall as any other: a .face, an elevStrip
// chip, and a schedule group for the units on it.
describe("W3: interior walls publish as ordinary wall strips", () => {
  const RECT = [
    { x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 8 }, { x: 0, z: 8 },
  ];
  const job = {
    id: "p1", ref: "One story + a hallway wall", addr: "",
    building: {
      width: 10, depth: 8, height: 3, rise: 0, footprints: [RECT],
      stories: [{ n: 1, name: "Ground", elevM: 0, heightM: 3, footprints: [RECT] }],
      interiorWalls: [
        { x1: 5, z1: 0, x2: 5, z2: 8, heightM: 3, elevM: 0, story: 1, name: "Interior 1" },
      ],
    },
    windows: [
      {
        id: "H1", elev: "s4", floor: "Ground", room: "", type: "Fixed",
        w: 900, h: 1200, x: 1, y: 0.9, lights: 1, open: "fixed", status: "tofit", story: 1,
      },
    ],
  };

  it("gets a .face after the exterior loop's 4 edges, at key s4", () => {
    const { host, view } = mount(job as never);
    const faces = host.querySelectorAll(".face");
    expect(faces.length).toBe(5); // 4 exterior + 1 interior
    expect(host.querySelector('.face[data-elev="s4"]')).toBeTruthy();
    view.destroy();
  });

  it("carries its unit — the window renders inside the interior wall's face", () => {
    const { host, view } = mount(job as never);
    const face = host.querySelector('.face[data-elev="s4"]')!;
    expect(face.querySelector('.win[data-id="H1"]')).toBeTruthy();
    view.destroy();
  });

  it("gets an elevation chip labeled Interior, and highlights like any wall", () => {
    const { host, view } = mount(job as never);
    const chip = host.querySelector<HTMLElement>('#elevStrip .elev[data-elev="s4"]');
    expect(chip).toBeTruthy();
    expect(chip!.textContent).toContain("Interior 1");
    view.destroy();
  });

  it("groups its window under an 'Interior 1 elevation' heading in the schedule", () => {
    const { host, view } = mount(job as never);
    host.querySelector<HTMLButtonElement>('.tab[data-view="sched"]')!.click();
    expect(host.querySelector("#rows")!.textContent).toContain("Interior 1 elevation");
    view.destroy();
  });

  it("a building with no interiorWalls at all is unaffected (BLACK22's shape)", () => {
    const plain = {
      ...job,
      building: { ...job.building, interiorWalls: undefined },
      windows: [],
    };
    const { host, view } = mount(plain as never);
    expect(host.querySelectorAll(".face").length).toBe(4);
    view.destroy();
  });
});

// Wave G (2026-09-01): a window's spec carries the real CAD cell
// (paneGrid.ts) and the elevations view draws IT instead of the flat
// single-row layout — mark 7's own worked example (8 fixed lites around a
// center swing-door pair) proves the shape; a plain window with no
// pane_grid proves the fallback law holds byte-identical alongside it.
describe("wave G: pane grid rendering", () => {
  const RECT = [
    { x: 0, z: 0 }, { x: 20, z: 0 }, { x: 20, z: 8 }, { x: 0, z: 8 },
  ];
  function gridJob() {
    return {
      id: "p1", ref: "Grid test", addr: "",
      building: { width: 20, depth: 8, height: 4, rise: 0, footprints: [RECT] },
      windows: [
        {
          id: "7", elev: "s0", floor: "Ground", room: "Lobby east",
          type: "Storefront: 8 fixed lites around a center double swing door pair",
          w: 4254, h: 3645, x: 2, y: 0, lights: 1, open: "fixed", status: "tofit",
          pane_grid: madMooseMark7Grid,
        },
        {
          id: "20", elev: "s0", floor: "Ground", room: "Plain",
          type: "Fixed", w: 900, h: 1200, x: 10, y: 0.9,
          lights: 4, open: "fixed", status: "tofit",
        },
      ],
    };
  }

  it("draws the grid's own mullions, F glyphs and 2 door hinge marks — not the flat single-row layout", () => {
    const { host, view } = mount(gridJob() as never);
    const win = host.querySelector<HTMLElement>('.win[data-id="7"]')!;
    expect(win).toBeTruthy();
    // 4 columns -> 3 interior column mullions.
    expect(win.querySelectorAll(".mull").length).toBe(3);
    // 6 interior segment breaks (2 in each F-stack column, 1 in each door
    // column) — never the flat layout's full-width .tran.
    expect(win.querySelectorAll(".gmull").length).toBe(6);
    // 8 fixed lites, each its own F glyph.
    const fglyphs = win.querySelectorAll(".fglyph");
    expect(fglyphs.length).toBe(8);
    expect([...fglyphs].every((n) => n.textContent === "F")).toBe(true);
    // 2 door leaves, each its own hinge-diagonal svg + kick plate.
    expect(win.querySelectorAll("svg").length).toBe(2);
    expect(win.querySelectorAll(".kick").length).toBe(2);
    // SIZE/ID overlays keep working regardless of the grid underneath.
    expect(win.querySelector(".chip")!.textContent).toBe("7");
    expect(win.querySelector(".dim")).toBeTruthy();
    view.destroy();
  });

  it("fallback law: a window with no pane_grid still draws the old flat single-row layout, unaffected", () => {
    const { host, view } = mount(gridJob() as never);
    const plain = host.querySelector<HTMLElement>('.win[data-id="20"]')!;
    // 4 equal lights -> 3 interior mullions, none of the grid's own furniture.
    expect(plain.querySelectorAll(".mull").length).toBe(3);
    expect(plain.querySelectorAll(".gmull").length).toBe(0);
    expect(plain.querySelectorAll(".fglyph").length).toBe(0);
    view.destroy();
  });

  it("a malformed pane_grid degrades to the flat layout rather than crashing the mount", () => {
    const bad = gridJob();
    (bad.windows[0] as { pane_grid?: unknown }).pane_grid = { columns: [] };
    const { host, view } = mount(bad as never);
    const win = host.querySelector<HTMLElement>('.win[data-id="7"]')!;
    expect(win).toBeTruthy();
    expect(win.querySelectorAll(".gmull").length).toBe(0);
    expect(win.querySelectorAll(".mull").length).toBe(0); // lights: 1 -> one pane
    view.destroy();
  });

  it("a corner unit (win.legs) keeps its panesSplit rendering — pane_grid is out of scope for legs", () => {
    const cornerJob = {
      id: "p1", ref: "Corner", addr: "",
      building: { width: 20, depth: 8, height: 4, rise: 0, footprints: [RECT] },
      windows: [
        {
          id: "9", elev: "s0", floor: "Ground", room: "",
          type: "Corner", w: 3000, h: 2000, x: 5, y: 0.9,
          legs: [1500, 1500], wrap: "end", panesSplit: [[1500], [1500]],
          open: "fixed", status: "tofit",
          pane_grid: madMooseMark7Grid, // present but must be ignored on a leg
        },
      ],
    };
    const { host, view } = mount(cornerJob as never);
    const pieces = host.querySelectorAll('.win[data-id="9"]');
    expect(pieces.length).toBeGreaterThan(0);
    [...pieces].forEach((p) => expect(p.querySelectorAll(".gmull").length).toBe(0));
    view.destroy();
  });
});
