// A window on a shared boundary must punch through EVERY wall on that line.
//
// Traced multi-mass buildings seed one wall per mass ring, so a boundary two
// masses share used to exist twice — coincident twin walls. A unit attached
// to one twin and cut its hole there while the other rendered solid in front
// of it; from outside, the window was a sliver of glass under a blank wall
// (owner screenshot, 2026-08-13: "the window is still hiding behind the
// wall"). Two fixes, each pinned here:
//
//   1. Edge.makeWall (vendor, marked diff) cuts holes for in-wall items from
//      ANY wall whose rect genuinely lies in the plane — saved models that
//      already carry twin walls heal with no data migration.
//   2. buildStudioSeed dedupes shared corners/segments, so fresh seeds never
//      mint twins at all (unit-tested in fromProject.test.ts; asserted here
//      through the real mount path).
//
// Desktop viewport: the Studio is a laptop tool. The fixture user is a
// supervisor because the tab is supervisor+ — nothing here needs more.

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { jobFixtures, useSupabaseFixtures } from "./support/supabaseFixtures";

const SHOTS = join(
  dirname(fileURLToPath(import.meta.url)),
  "__screenshots__",
  "studio",
);

test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });

const BLACK22 = jobFixtures().find((j) => j.jobCode === "BLACK22")!;

/** Two 10×6 m and 8×6 m masses side by side, sharing the x=10 m boundary. */
const MASS_A = [
  { x: 0, z: 0 },
  { x: 10, z: 0 },
  { x: 10, z: 6 },
  { x: 0, z: 6 },
];
const MASS_B = [
  { x: 10, z: 0 },
  { x: 18, z: 0 },
  { x: 18, z: 6 },
  { x: 10, z: 6 },
];

/** The authored fit-view model the Studio seeds from. */
const FITVIEW_MODEL = {
  building: {
    width: 18,
    depth: 6,
    height: 3,
    rise: 0,
    footprints: [MASS_A, MASS_B],
  },
  windows: [],
};

/**
 * A saved Studio floorplan the way the PRE-dedupe seed wrote it: each mass
 * ring seeded its own corners, so the x=1000 cm boundary exists TWICE.
 * This is what production saves look like today; the vendor hole fix has to
 * handle them as-is.
 */
function twinWallPlan(): string {
  const corners: Record<string, { x: number; y: number }> = {};
  const walls: { corner1: string; corner2: string }[] = [];
  [MASS_A, MASS_B].forEach((ring, pi) => {
    const ids = ring.map((p, i) => {
      const id = `c${pi}-${i}`;
      corners[id] = { x: p.x * 100, y: p.z * 100 };
      return id;
    });
    for (let i = 0; i < ids.length; i++) {
      walls.push({ corner1: ids[i], corner2: ids[(i + 1) % ids.length] });
    }
  });
  return JSON.stringify({
    floorplan: {
      corners,
      walls,
      wallTextures: [],
      floorTextures: {},
      newFloorTextures: {},
    },
    items: [],
  });
}

function outlineRow(
  features: Record<string, unknown>,
  points: { x: number; y: number }[] = [],
) {
  return {
    id: "00000000-0000-4000-8000-00000000531d",
    project_id: BLACK22.projectId,
    planset_id: null,
    page_number: 1,
    points,
    page_aspect: 0.7,
    features,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

/** Serve one synthetic outline row; registered AFTER the fixture router so
 * it wins (Playwright matches routes newest-first). Pass `points` to give
 * the job a real TRACE — what "Pull from plans" reads. */
async function useOutline(
  page: import("@playwright/test").Page,
  features: Record<string, unknown>,
  points: { x: number; y: number }[] = [],
) {
  const row = outlineRow(features, points);
  await page.route("**/rest/v1/project_plan_outlines**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "content-range": "0-0/1" },
      body: JSON.stringify([row]),
    }),
  );
}

async function openStudio(page: import("@playwright/test").Page) {
  await page.goto(`/studio/j/${BLACK22.projectId}`);
  await page.waitForFunction(
    () => {
      const bp = (window as { __studio?: unknown }).__studio as
        | { model?: { floorplan?: { getWalls?: () => unknown[] } } }
        | undefined;
      return (bp?.model?.floorplan?.getWalls?.()?.length ?? 0) > 0;
    },
    undefined,
    { timeout: 60_000 },
  );
}

test("a unit on a twin-wall boundary cuts holes in BOTH walls", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "supervisor" });
  await useOutline(page, {
    fitview: { model: FITVIEW_MODEL },
    modelstudio: { serialized: twinWallPlan() },
  });
  await openStudio(page);

  // The saved plan carries the twins: 8 walls, two of them on x=1000.
  const wallCount = await page.evaluate(() => {
    const bp = (window as any).__studio;
    return bp.model.floorplan.getWalls().length;
  });
  expect(wallCount).toBe(8);

  // Drop a 2-panel unit onto the shared boundary the way the catalog does
  // (same addItem call; the page's itemLoaded hook attaches + rebuilds it).
  await page.evaluate(() => {
    const bp = (window as any).__studio;
    bp.model.scene.addItem(
      3,
      "/modelstudio/models/window.json",
      {
        itemName: "E2E twin-wall unit",
        itemType: 3,
        modelUrl: "/modelstudio/models/window.json",
        unitConfig: {
          kind: "window",
          heightMm: 2000,
          panels: [
            { widthMm: 1200, mechanism: "fixed" },
            { widthMm: 1200, mechanism: "slider", direction: "left" },
          ],
        },
      },
      { x: 1000, y: 150, z: 300 },
      0,
      undefined,
      false,
    );
  });
  await page.waitForFunction(() => {
    const bp = (window as any).__studio;
    const items = bp.model.scene.getItems();
    return items.length === 1 && Boolean(items[0].currentWallEdge);
  });

  // Every wall lying on the x=1000 line must have re-tessellated around a
  // hole: a plain quad face is 4 vertices, a holed one is 8+. The interior
  // and exterior faces (planes[0], planes[1]) both count — the outside view
  // is the one the owner's screenshot caught solid.
  const boundary = await page.evaluate(() => {
    const bp = (window as any).__studio;
    const onLine = (w: any) =>
      Math.abs(w.getStartX() - 1000) < 1 && Math.abs(w.getEndX() - 1000) < 1;
    const walls = bp.model.floorplan.getWalls().filter(onLine);
    const edges = bp.three.floorplan.edges.filter((e: any) =>
      onLine(e.wall),
    );
    return {
      walls: walls.length,
      itemCounts: walls.map((w: any) => w.items.length),
      faceVertexCounts: edges.flatMap((e: any) =>
        [e.planes[0], e.planes[1]].map(
          (m: any) => m.geometry.getAttribute("position").count,
        ),
      ),
    };
  });
  expect(boundary.walls).toBe(2);
  // The unit belongs to exactly one wall…
  expect(boundary.itemCounts.filter((n: number) => n > 0)).toHaveLength(1);
  // …but every face of every wall on the line tessellated around the hole.
  expect(boundary.faceVertexCounts.length).toBeGreaterThan(0);
  for (const count of boundary.faceVertexCounts) {
    expect(count).toBeGreaterThanOrEqual(8);
  }

  mkdirSync(SHOTS, { recursive: true });
  await page
    .locator("#studio-three canvas")
    .screenshot({ path: join(SHOTS, "twin-wall-hole.png") });
});

test("panels read left-to-right as seen from OUTSIDE", async ({ page }) => {
  // Spec drawings are always the Outside View (owner, window 16), so a unit
  // whose config is [wide, narrow] must show the wide panel on the LEFT to
  // someone standing outside the wall. On the building's east wall
  // (x = 1800, outside toward +x), an outside viewer looking -x has +z on
  // their left — so panel 0's world-z must exceed the last panel's.
  await useSupabaseFixtures(page, { role: "supervisor" });
  await useOutline(page, { fitview: { model: FITVIEW_MODEL } });
  await openStudio(page);

  await page.evaluate(() => {
    const bp = (window as any).__studio;
    bp.model.scene.addItem(
      3,
      "/modelstudio/models/window.json",
      {
        itemName: "E2E outside-view unit",
        itemType: 3,
        modelUrl: "/modelstudio/models/window.json",
        unitConfig: {
          kind: "window",
          heightMm: 1500,
          panels: [
            { widthMm: 1600, mechanism: "fixed" },
            { widthMm: 400, mechanism: "fixed" },
          ],
        },
      },
      { x: 1800, y: 120, z: 300 },
      0,
      undefined,
      false,
    );
  });
  await page.waitForFunction(() => {
    const bp = (window as any).__studio;
    const items = bp.model.scene.getItems();
    return items.length === 1 && Boolean(items[0].currentWallEdge);
  });

  // Measure the BUILT geometry, not the config: the two glass panes are the
  // last two merged boxes (24 vertices each — an all-fixed unit has no sash
  // bars). The wider slice is the wide panel; its world-z is where the
  // outside viewer sees it.
  const panels = await page.evaluate(() => {
    const bp = (window as any).__studio;
    const item = bp.model.scene.getItems()[0];
    const attr = item.geometry.getAttribute("position");
    const ry = item.rotation.y;
    const slice = (from: number) => {
      const xs: number[] = [];
      for (let i = from; i < from + 24; i++) xs.push(attr.getX(i));
      const mean = xs.reduce((t, v) => t + v, 0) / xs.length;
      return {
        extent: Math.max(...xs) - Math.min(...xs),
        worldZ: item.position.z - Math.sin(ry) * mean,
      };
    };
    return [slice(attr.count - 48), slice(attr.count - 24)];
  });
  const [a, b] = panels as { extent: number; worldZ: number }[];
  const wide = a.extent > b.extent ? a : b;
  const narrow = a.extent > b.extent ? b : a;
  // Sanity: the two panes really are the 1600 mm and 400 mm glass (cm).
  expect(wide.extent).toBeGreaterThan(100);
  expect(narrow.extent).toBeLessThan(50);
  expect(wide.worldZ).toBeGreaterThan(narrow.worldZ);
});

test("a 90° corner unit snaps to the building corner and cuts BOTH walls", async ({
  page,
}) => {
  // Window 16's shape: a long main run with a short first panel wrapping
  // the corner. The wrap reads at the drawing's LEFT, which on the east
  // wall is the +z end — the (1800, 600) corner. Dropped short of it, the
  // unit must seat itself AT that corner and open holes in the east wall
  // (x=1800, its own) AND the south wall (z=600, the neighbour it is not
  // attached to).
  await useSupabaseFixtures(page, { role: "supervisor" });
  await useOutline(page, { fitview: { model: FITVIEW_MODEL } });
  await openStudio(page);

  await page.evaluate(() => {
    const bp = (window as any).__studio;
    bp.model.scene.addItem(
      3,
      "/modelstudio/models/window.json",
      {
        itemName: "E2E corner unit",
        itemType: 3,
        modelUrl: "/modelstudio/models/window.json",
        unitConfig: {
          kind: "window",
          heightMm: 2000,
          panels: [
            { widthMm: 800, mechanism: "fixed" },
            { widthMm: 2400, mechanism: "fixed" },
            { widthMm: 2400, mechanism: "fixed" },
          ],
          cornerAfterPanel: 0, // the 800 mm first panel wraps
        },
      },
      // Near the corner but deliberately ~80 cm short of it: the snap has
      // to finish the job.
      { x: 1800, y: 120, z: 320 },
      0,
      undefined,
      false,
    );
  });
  await page.waitForFunction(() => {
    const bp = (window as any).__studio;
    const items = bp.model.scene.getItems();
    return items.length === 1 && Boolean(items[0].currentWallEdge);
  });

  const state = await page.evaluate(() => {
    const bp = (window as any).__studio;
    const item = bp.model.scene.getItems()[0];
    const holed = (predicate: (w: any) => boolean) =>
      bp.three.floorplan.edges
        .filter((e: any) => predicate(e.wall))
        .flatMap((e: any) =>
          [e.planes[0], e.planes[1]].map(
            (m: any) => m.geometry.getAttribute("position").count,
          ),
        );
    return {
      rects: typeof item.holeRects === "function" ? item.holeRects().length : 0,
      itemZ: item.position.z,
      east: holed(
        (w: any) =>
          Math.abs(w.getStartX() - 1800) < 1 && Math.abs(w.getEndX() - 1800) < 1,
      ),
      south: holed(
        (w: any) =>
          Math.abs(w.getStartY() - 600) < 1 &&
          Math.abs(w.getEndY() - 600) < 1 &&
          Math.min(w.getStartX(), w.getEndX()) >= 999,
      ),
    };
  });
  expect(state.rects).toBe(2);
  // Snap seated the wrap tip at the (1800, 600) corner: the main leg is
  // 480 cm + 5 cm half-post, so its centre lands at z ≈ 600 − 245 = 355.
  expect(Math.abs(state.itemZ - 355)).toBeLessThan(2);
  // Both walls' faces tessellated around a hole (a plain quad is 4 verts).
  expect(state.east.length).toBeGreaterThan(0);
  for (const c of state.east) expect(c).toBeGreaterThanOrEqual(8);
  expect(state.south.length).toBeGreaterThan(0);
  for (const c of state.south) expect(c).toBeGreaterThanOrEqual(8);

  // Aim the camera at the corner from outside before the eyeball shot.
  await page.evaluate(() => {
    const bp = (window as any).__studio;
    const controls = bp.three.controls;
    controls.object.position.set(2600, 500, 1200);
    controls.target?.set?.(1750, 120, 550);
    controls.update?.();
  });
  await page.waitForTimeout(300);
  mkdirSync(SHOTS, { recursive: true });
  await page
    .locator("#studio-three canvas")
    .screenshot({ path: join(SHOTS, "corner-unit.png") });
});

test("3D drag handles: pulling the top handle makes the unit taller", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "supervisor" });
  await useOutline(page, { fitview: { model: FITVIEW_MODEL } });
  await openStudio(page);

  await page.evaluate(() => {
    const bp = (window as any).__studio;
    bp.model.scene.addItem(
      3,
      "/modelstudio/models/window.json",
      {
        itemName: "E2E handle unit",
        itemType: 3,
        modelUrl: "/modelstudio/models/window.json",
        unitConfig: {
          kind: "window",
          heightMm: 1500,
          panels: [
            { widthMm: 1200, mechanism: "fixed" },
            { widthMm: 1200, mechanism: "slider", direction: "left" },
          ],
        },
      },
      { x: 900, y: 150, z: 600 },
      0,
      undefined,
      false,
    );
  });
  await page.waitForFunction(() => {
    const bp = (window as any).__studio;
    const items = bp.model.scene.getItems();
    return items.length === 1 && Boolean(items[0].currentWallEdge);
  });

  /** World → CSS pixels inside the 3D pane, via the live camera. */
  const project = `((wx, wy, wz) => {
    const bp = window.__studio;
    const cam = bp.three.camera;
    cam.updateMatrixWorld();
    const v = bp.model.scene.getItems()[0].position.clone();
    v.set(wx, wy, wz);
    v.project(cam);
    const r = bp.three.element.getBoundingClientRect();
    return {
      x: r.left + ((v.x + 1) / 2) * r.width,
      y: r.top + ((1 - v.y) / 2) * r.height,
    };
  })`;

  // Tap-select the unit: a real click at its projected centre.
  const centre = await page.evaluate(`(() => {
    const bp = window.__studio;
    const p = bp.model.scene.getItems()[0].position;
    return ${project}(p.x, p.y, p.z);
  })()`);
  const { x: cx, y: cy } = centre as { x: number; y: number };
  await page.mouse.click(cx, cy);
  await page.waitForFunction(() => {
    const bp = (window as any).__studio;
    const scene = bp.model.scene.getScene();
    // The handles group: four spheres drawn on top of everything.
    return scene.children.some(
      (g: any) => g.isGroup && g.children.length === 4 && g.renderOrder === 999,
    );
  });

  const before = await page.evaluate(() => {
    const bp = (window as any).__studio;
    return bp.model.scene.getItems()[0].metadata.unitConfig.heightMm;
  });

  // Grab the TOP handle sphere and pull it up 60 px.
  const top = await page.evaluate(`(() => {
    const bp = window.__studio;
    const scene = bp.model.scene.getScene();
    const group = scene.children.find(
      (g) => g.isGroup && g.children.length === 4 && g.renderOrder === 999,
    );
    // Highest sphere = the height handle.
    const h = [...group.children].sort((a, b) => b.position.y - a.position.y)[0];
    return ${project}(h.position.x, h.position.y, h.position.z);
  })()`);
  const { x: hx, y: hy } = top as { x: number; y: number };
  await page.mouse.move(hx, hy);
  await page.mouse.down();
  await page.mouse.move(hx, hy - 60, { steps: 6 });
  await page.mouse.up();

  const after = await page.evaluate(() => {
    const bp = (window as any).__studio;
    return bp.model.scene.getItems()[0].metadata.unitConfig.heightMm;
  });
  expect(after).toBeGreaterThan(before + 50); // meaningfully taller, in mm
});

test("pane grid: split, type a pane size, corner-by-pane, wall auto-grows", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "supervisor" });
  await useOutline(page, { fitview: { model: FITVIEW_MODEL } });
  await openStudio(page);

  // A 2-column unit TALLER than the 3 m wall: the wall must auto-grow.
  await page.evaluate(() => {
    const bp = (window as any).__studio;
    bp.model.scene.addItem(
      3,
      "/modelstudio/models/window.json",
      {
        itemName: "E2E grid unit",
        itemType: 3,
        modelUrl: "/modelstudio/models/window.json",
        unitConfig: {
          kind: "window",
          heightMm: 3200,
          panels: [
            { widthMm: 1200, mechanism: "fixed" },
            { widthMm: 1200, mechanism: "fixed" },
          ],
        },
      },
      { x: 900, y: 170, z: 600 },
      0,
      undefined,
      false,
    );
  });
  await page.waitForFunction(() => {
    const bp = (window as any).__studio;
    const items = bp.model.scene.getItems();
    return items.length === 1 && Boolean(items[0].currentWallEdge);
  });

  // Wall auto-grew to fit the 320 cm unit (sill ~10 cm → ≥ 330 cm).
  const wallH = await page.evaluate(() => {
    const bp = (window as any).__studio;
    return bp.model.scene.getItems()[0].currentWallEdge.wall.height;
  });
  expect(wallH).toBeGreaterThanOrEqual(320);

  // Tap-select in 3D via the camera-projected click (same as handles spec).
  const centre = await page.evaluate(`(() => {
    const bp = window.__studio;
    const cam = bp.three.camera;
    cam.updateMatrixWorld();
    const p = bp.model.scene.getItems()[0].position;
    const v = p.clone();
    v.project(cam);
    const r = bp.three.element.getBoundingClientRect();
    return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
  })()`);
  const { x: cx, y: cy } = centre as { x: number; y: number };
  await page.mouse.click(cx, cy);
  await expect(page.getByText("Panes — tap one", { exact: false })).toBeVisible();

  // 1×2 grid → tap pane 1·1 → split its row → 2 rows → 4 cells.
  await page.locator(".studio-pane-cell").first().click();
  await page.getByRole("button", { name: "▭ Split" }).click();
  await expect(page.locator(".studio-pane-cell")).toHaveCount(4);

  // Type the top-left pane's height — the whole TOP ROW resizes and the
  // config's total height follows (bottom row keeps its size).
  await page.locator(".studio-pane-cell").first().click();
  await page.getByLabel("Pane height").fill('40"');
  await page.getByLabel("Pane height").blur();
  const cfgAfter = await page.evaluate(() => {
    const bp = (window as any).__studio;
    return bp.model.scene.getItems()[0].metadata.unitConfig;
  });
  expect((cfgAfter as any).rows).toHaveLength(2);
  expect((cfgAfter as any).rows[0].heightMm).toBeCloseTo(1016, 0);
  expect((cfgAfter as any).heightMm).toBeCloseTo(1016 + 1600, 0);

  // Corner-by-pane: mark the corner after column 1.
  await page.locator(".studio-pane-cell").first().click();
  await page.getByRole("button", { name: "⌐ Corner here" }).click();
  const corner = await page.evaluate(() => {
    const bp = (window as any).__studio;
    return bp.model.scene.getItems()[0].metadata.unitConfig.cornerAfterPanel;
  });
  expect(corner).toBe(0);
});

test("3D wall slide handle drags the whole wall perpendicular", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "supervisor" });
  await useOutline(page, { fitview: { model: FITVIEW_MODEL } });
  await openStudio(page);

  // Select the south wall of mass A (z=600, x 0..1000) through the SAME
  // emitter the vendor's own 3D raycast fires — a projected click can land
  // on a back-facing plane and select nothing.
  await page.evaluate(() => {
    const bp = (window as any).__studio;
    const wall = bp.model.floorplan
      .getWalls()
      .find(
        (w: any) =>
          Math.abs(w.getStartY() - 600) < 1 &&
          Math.abs(w.getEndY() - 600) < 1 &&
          Math.min(w.getStartX(), w.getEndX()) < 1100,
      );
    bp.three.wallClicked.fire(wall.frontEdge ?? wall.backEdge);
  });
  // The wall card + 4 handles (2 ends, height, slide) appear.
  await page.waitForFunction(() => {
    const bp = (window as any).__studio;
    const scene = bp.model.scene.getScene();
    return scene.children.some(
      (g: any) => g.isGroup && g.renderOrder === 999 && g.children.length === 4,
    );
  });

  const before = await page.evaluate(() => {
    const bp = (window as any).__studio;
    const wall = bp.model.floorplan
      .getWalls()
      .find((w: any) => Math.abs(w.getStartY() - 600) < 1 && Math.abs(w.getEndY() - 600) < 1);
    return wall ? wall.getStartY() : null;
  });
  expect(before).toBe(600);

  // Lowest sphere = the slide handle (it sits at 55% wall height).
  const slide = await page.evaluate(`(() => {
    const bp = window.__studio;
    const cam = bp.three.camera;
    cam.updateMatrixWorld();
    const scene = bp.model.scene.getScene();
    const group = scene.children.find(
      (g) => g.isGroup && g.renderOrder === 999 && g.children.length === 4,
    );
    const h = [...group.children].sort((a, b) => a.position.y - b.position.y)[0];
    const v = h.position.clone();
    v.project(cam);
    const r = bp.three.element.getBoundingClientRect();
    return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
  })()`);
  const { x: sx, y: sy } = slide as { x: number; y: number };
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move(sx, sy + 50, { steps: 6 });
  await page.mouse.up();

  const after = await page.evaluate(() => {
    const bp = (window as any).__studio;
    const walls = bp.model.floorplan.getWalls();
    // The dragged wall no longer sits on z=600; find where it went via the
    // wall whose endpoints moved together off that line.
    const moved = walls.find(
      (w: any) =>
        Math.abs(w.getStartY() - w.getEndY()) < 1 &&
        Math.abs(w.getStartY() - 600) > 5 &&
        Math.min(w.getStartX(), w.getEndX()) < 1100,
    );
    return moved ? moved.getStartY() : null;
  });
  expect(after).not.toBeNull();
  expect(Math.abs((after as number) - 600)).toBeGreaterThan(5);
});

test("polish: first tap selects (no hover), highlight appears, legacy windows heal", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "supervisor" });
  await useOutline(page, { fitview: { model: FITVIEW_MODEL } });
  await openStudio(page);

  // A LEGACY window: attached but saved without any unitConfig (the
  // pre-2026-08-13 format) — its card's Apply/pane tools used to be dead.
  // Real legacy saves DO carry their scale (the raw model is ~1 unit tall),
  // so the fixture passes one too.
  await page.evaluate(() => {
    const bp = (window as any).__studio;
    bp.model.scene.addItem(
      3,
      "/modelstudio/models/window.json",
      { itemName: "Legacy 12", itemType: 3, modelUrl: "/modelstudio/models/window.json" },
      { x: 900, y: 150, z: 600 },
      0,
      { x: 240, y: 150, z: 10 },
      false,
    );
  });
  await page.waitForFunction(() => {
    const bp = (window as any).__studio;
    const items = bp.model.scene.getItems();
    return items.length === 1 && Boolean(items[0].currentWallEdge);
  });

  // Tap WITHOUT any prior mousemove: synthetic mousedown+mouseup straight
  // at the projected centre. The vendor's hover-dependent path can't fire
  // here — only the new first-tap raycast can.
  await page.evaluate(() => {
    const bp = (window as any).__studio;
    const cam = bp.three.camera;
    cam.updateMatrixWorld();
    const v = bp.model.scene.getItems()[0].position.clone();
    v.project(cam);
    const r = bp.three.element.getBoundingClientRect();
    const x = r.left + ((v.x + 1) / 2) * r.width;
    const y = r.top + ((1 - v.y) / 2) * r.height;
    const opts = { bubbles: true, clientX: x, clientY: y, button: 0 };
    bp.three.element.dispatchEvent(new MouseEvent("mousedown", opts));
    bp.three.element.dispatchEvent(new MouseEvent("mouseup", opts));
  });

  // Selection landed: the palette's unit card is open…
  await expect(page.getByText("Selected unit")).toBeVisible();
  // …the bright outline is in the scene…
  const state = await page.evaluate(() => {
    const bp = (window as any).__studio;
    const scene = bp.model.scene.getScene();
    const item = bp.model.scene.getItems()[0];
    return {
      highlight: scene.children.some(
        (c: any) => c.name === "studio-select-highlight",
      ),
      // …and the legacy window healed: a config synthesized from its size,
      // parametric frame+glass geometry (2 material groups).
      cfg: item.metadata.unitConfig ?? null,
      groups: item.geometry.groups?.length ?? 0,
    };
  });
  expect(state.highlight).toBe(true);
  expect(state.cfg).not.toBeNull();
  expect((state.cfg as { panels: unknown[] }).panels).toHaveLength(1);
  expect(state.groups).toBe(2);
  // The pane picker renders for it — the card is fully live.
  await expect(page.getByText(/Panes — tap one/)).toBeVisible();
});

test("outside wall click selects the NEAR wall and glows it blue", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "supervisor" });
  await useOutline(page, { fitview: { model: FITVIEW_MODEL } });
  await openStudio(page);

  // Aim from OUTSIDE the south side at mass A's south wall (z=600): the
  // wall the camera faces. Pre-fix, its pick plane was backface-culled and
  // the click either selected the NORTH wall across the room or nothing.
  await page.evaluate(() => {
    const bp = (window as any).__studio;
    const c = bp.three.controls;
    c.object.position.set(500, 260, 1500);
    c.target?.set?.(500, 130, 300);
    c.update?.();
  });
  await page.waitForTimeout(250);

  const target = await page.evaluate(() => {
    const bp = (window as any).__studio;
    const cam = bp.three.camera;
    cam.updateMatrixWorld();
    // Project the south wall's midpoint at half height.
    const v = bp.model.scene.getItems === undefined ? null : null;
    void v;
    const p = new (bp.three.camera.position.constructor)(500, 125, 600);
    p.project(cam);
    const r = bp.three.element.getBoundingClientRect();
    return {
      x: r.left + ((p.x + 1) / 2) * r.width,
      y: r.top + ((1 - p.y) / 2) * r.height,
    };
  });
  const { x, y } = target as { x: number; y: number };
  // Synthetic still click (no hover needed for our fallback).
  await page.evaluate(
    ([px, py]) => {
      const el = (window as any).__studio.three.element;
      const opts = { bubbles: true, clientX: px, clientY: py, button: 0 };
      el.dispatchEvent(new MouseEvent("mousedown", opts));
      el.dispatchEvent(new MouseEvent("mouseup", opts));
    },
    [x, y] as [number, number],
  );

  const picked = await page.evaluate(() => {
    const bp = (window as any).__studio;
    const scene = bp.model.scene.getScene();
    const glow = scene.children.filter((c: any) => c.name === "studio-wall-highlight");
    return { glow: glow.length };
  });
  expect(picked.glow).toBeGreaterThan(0);
  // The selected wall is the SOUTH one (z=600 line), not the north.
  await expect(page.getByText("Selected wall")).toBeVisible();
  const wallLine = await page.evaluate(() => {
    const bp = (window as any).__studio;
    const scene = bp.model.scene.getScene();
    const glow = scene.children.find((c: any) => c.name === "studio-wall-highlight");
    if (!glow) return null;
    glow.geometry.computeBoundingBox();
    const b = glow.geometry.boundingBox;
    return (b.min.z + b.max.z) / 2;
  });
  expect(Math.abs((wallLine as number) - 600)).toBeLessThan(20);
});

test("dragging a window lands it on the wall under the mouse, not across the room", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "supervisor" });
  await useOutline(page, { fitview: { model: FITVIEW_MODEL } });
  await openStudio(page);

  // Unit starts on mass A's NORTH wall (z=0).
  await page.evaluate(() => {
    const bp = (window as any).__studio;
    bp.model.scene.addItem(
      3,
      "/modelstudio/models/window.json",
      {
        itemName: "E2E drag unit",
        itemType: 3,
        modelUrl: "/modelstudio/models/window.json",
        unitConfig: {
          kind: "window",
          heightMm: 1500,
          panels: [{ widthMm: 1200, mechanism: "fixed" }],
        },
      },
      { x: 500, y: 120, z: 0 },
      0,
      undefined,
      false,
    );
  });
  await page.waitForFunction(() => {
    const bp = (window as any).__studio;
    const items = bp.model.scene.getItems();
    return items.length === 1 && Boolean(items[0].currentWallEdge);
  });

  // Camera outside the SOUTH side, both walls in view; the south wall is
  // the near one under the mouse when we drop there.
  await page.evaluate(() => {
    const bp = (window as any).__studio;
    const c = bp.three.controls;
    c.object.position.set(500, 300, 1600);
    c.target?.set?.(500, 120, 300);
    c.update?.();
  });
  await page.waitForTimeout(250);

  const proj = async (wx: number, wy: number, wz: number) =>
    page.evaluate(
      ([a, b, cc]) => {
        const bp = (window as any).__studio;
        const cam = bp.three.camera;
        cam.updateMatrixWorld();
        const p = new (bp.three.camera.position.constructor)(a, b, cc);
        p.project(cam);
        const r = bp.three.element.getBoundingClientRect();
        return {
          x: r.left + ((p.x + 1) / 2) * r.width,
          y: r.top + ((1 - p.y) / 2) * r.height,
        };
      },
      [wx, wy, wz] as [number, number, number],
    );

  const from = (await proj(500, 120, 0)) as { x: number; y: number };
  const to = (await proj(430, 125, 600)) as { x: number; y: number };
  // Real mouse drag: hover establishes the vendor's intersected item, then
  // drag onto the SOUTH wall's face.
  await page.mouse.move(from.x, from.y);
  await page.mouse.move(from.x, from.y, { steps: 2 });
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 14 });
  await page.mouse.up();

  const landed = await page.evaluate(() => {
    const bp = (window as any).__studio;
    const item = bp.model.scene.getItems()[0];
    const w = item.currentWallEdge?.wall;
    return w
      ? { z1: w.getStartY(), z2: w.getEndY(), itemZ: item.position.z }
      : null;
  });
  expect(landed).not.toBeNull();
  // Attached to the SOUTH wall (z=600) — the one the mouse hovered — not
  // back on the north wall across the room.
  const l = landed as { z1: number; z2: number; itemZ: number };
  expect(Math.abs(l.z1 - 600)).toBeLessThan(20);
  expect(Math.abs(l.z2 - 600)).toBeLessThan(20);
});

test("glyph overlay: arrows/F always, dims on selection, pane-op flips it", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "supervisor" });
  await useOutline(page, { fitview: { model: FITVIEW_MODEL } });
  await openStudio(page);

  await page.evaluate(() => {
    const bp = (window as any).__studio;
    bp.model.scene.addItem(
      3,
      "/modelstudio/models/window.json",
      {
        itemName: "16",
        itemType: 3,
        modelUrl: "/modelstudio/models/window.json",
        unitConfig: {
          kind: "window",
          heightMm: 1800,
          panels: [
            { widthMm: 1200, mechanism: "slider", direction: "left" },
            { widthMm: 1200, mechanism: "fixed" },
          ],
        },
      },
      { x: 900, y: 150, z: 600 },
      0,
      undefined,
      false,
    );
  });
  await page.waitForFunction(() => {
    const bp = (window as any).__studio;
    const items = bp.model.scene.getItems();
    return items.length === 1 && Boolean(items[0].currentWallEdge);
  });

  const paintedPixels = () =>
    page.evaluate(() => {
      const bp = (window as any).__studio;
      const item = bp.model.scene.getItems()[0];
      const ann = item.children.find((c: any) => c.name === "unit-annotations");
      if (!ann) return -1;
      const canvas = ann.material.map.image as HTMLCanvasElement;
      const ctx = canvas.getContext("2d")!;
      const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let n = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 10) n++;
      return n;
    });

  // Unselected: glyphs + mark chip painted.
  const base = await paintedPixels();
  expect(base).toBeGreaterThan(100);

  // Select it (synthetic still tap) — measurement labels join the paint.
  await page.evaluate(() => {
    const bp = (window as any).__studio;
    const cam = bp.three.camera;
    cam.updateMatrixWorld();
    const v = bp.model.scene.getItems()[0].position.clone();
    v.project(cam);
    const r = bp.three.element.getBoundingClientRect();
    const opts = {
      bubbles: true,
      clientX: r.left + ((v.x + 1) / 2) * r.width,
      clientY: r.top + ((1 - v.y) / 2) * r.height,
      button: 0,
    };
    bp.three.element.dispatchEvent(new MouseEvent("mousedown", opts));
    bp.three.element.dispatchEvent(new MouseEvent("mouseup", opts));
  });
  await expect(page.getByText("Selected unit")).toBeVisible();
  const withDims = await paintedPixels();
  expect(withDims).toBeGreaterThan(base);

  // Pane options: tap pane 1·1 and make it Fixed — config + glyphs update.
  await page.locator(".studio-pane-cell").first().click();
  await page.getByRole("button", { name: "F Fixed" }).click();
  const cfg = await page.evaluate(() => {
    const bp = (window as any).__studio;
    return bp.model.scene.getItems()[0].metadata.unitConfig.panels[0];
  });
  expect((cfg as { mechanism: string }).mechanism).toBe("fixed");

  mkdirSync(SHOTS, { recursive: true });
  await page
    .locator("#studio-three canvas")
    .screenshot({ path: join(SHOTS, "glyph-overlay.png") });
});

test("Pull from plans reads the PLANS — a published model never caps it", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "supervisor" });
  // The BLACK22 bug, re-staged: a published (authored) model with ONE
  // window sits on the outline, while the TRACE + the job's 42 pinned
  // openings describe the real building. The pull must come from the
  // plans — every pinned opening — not echo the publish back.
  await useOutline(
    page,
    {
      fitview: {
        model: {
          ...FITVIEW_MODEL,
          windows: [{ id: "decoy", elev: "s0", x: 1, y: 1, w: 1000, h: 1000 }],
        },
      },
    },
    // A trace covering the fixture pins' page area (pins span roughly
    // x 0.13–0.65, y 0.20–0.82) so every opening lands on an edge.
    [
      { x: 0.1, y: 0.15 },
      { x: 0.7, y: 0.15 },
      { x: 0.7, y: 0.9 },
      { x: 0.1, y: 0.9 },
    ],
  );
  await openStudio(page);
  // The seed pre-places a handful of marks; this test wants the PULL to do
  // the work — clear the scene first.
  await page.evaluate(() => {
    const bp = (window as any).__studio;
    for (const it of [...bp.model.scene.getItems()]) bp.model.scene.removeItem(it);
  });

  await page.getByRole("button", { name: /Tools/ }).click();
  await page.getByRole("button", { name: "Pull from plans", exact: true }).click();
  // All 42 pinned BLACK22 openings arrive and attach — not the model's 1.
  await page.waitForFunction(
    () => {
      const bp = (window as any).__studio;
      const items = bp.model.scene.getItems();
      return (
        items.length === 42 &&
        items.every((it: any) => Boolean(it.currentWallEdge))
      );
    },
    undefined,
    { timeout: 60_000 },
  );

  const placed = await page.evaluate(() => {
    const bp = (window as any).__studio;
    return bp.model.scene.getItems().map((it: any) => ({
      name: it.metadata.itemName,
      widthMm: it.metadata.unitConfig.panels.reduce(
        (t: number, p: any) => t + p.widthMm,
        0,
      ),
    }));
  });
  const names = (placed as { name: string }[]).map((p) => p.name);
  expect(names).not.toContain("decoy"); // the publish is not a source
  // Mark 16 lands SPEC-exact (313.5in = 7962.9mm), parametric.
  const sixteen = (placed as { name: string; widthMm: number }[]).find((p) =>
    /^16([^0-9]|$)/.test(p.name),
  )!;
  expect(sixteen.widthMm).toBeGreaterThan(7900);
  expect(sixteen.widthMm).toBeLessThan(8000);

  // Re-pull: add-only — nothing new, nothing moved.
  await page.getByRole("button", { name: "Pull from plans", exact: true }).click();
  await expect(page.getByText(/42 already placed/)).toBeVisible({
    timeout: 15_000,
  });
  const count = await page.evaluate(() => {
    const bp = (window as any).__studio;
    return bp.model.scene.getItems().length;
  });
  expect(count).toBe(42);
});

test("animation: ▶ opens the slider, toggling closes it; dbl-click refocuses", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "supervisor" });
  await useOutline(page, { fitview: { model: FITVIEW_MODEL } });
  await openStudio(page);

  await page.evaluate(() => {
    const bp = (window as any).__studio;
    bp.model.scene.addItem(
      3,
      "/modelstudio/models/window.json",
      {
        itemName: "anim-1",
        itemType: 3,
        modelUrl: "/modelstudio/models/window.json",
        unitConfig: {
          kind: "window",
          heightMm: 1800,
          panels: [
            { widthMm: 1200, mechanism: "slider", direction: "left" },
            { widthMm: 1200, mechanism: "fixed" },
          ],
        },
      },
      { x: 900, y: 150, z: 600 },
      0,
      undefined,
      false,
    );
  });
  await page.waitForFunction(() => {
    const bp = (window as any).__studio;
    const items = bp.model.scene.getItems();
    return items.length === 1 && Boolean(items[0].currentWallEdge);
  });

  const moverX = () =>
    page.evaluate(() => {
      const bp = (window as any).__studio;
      const item = bp.model.scene.getItems()[0];
      const g = item.children.find((c: any) => c.name === "unit-mover");
      return g ? g.position.x - (g.userData.baseX ?? 0) : null;
    });

  // One mover exists (the slider), parked closed.
  expect(await moverX()).toBe(0);

  // Select via tap, then hit ▶ Open / close.
  await page.evaluate(() => {
    const bp = (window as any).__studio;
    const cam = bp.three.camera;
    cam.updateMatrixWorld();
    const v = bp.model.scene.getItems()[0].position.clone();
    v.project(cam);
    const r = bp.three.element.getBoundingClientRect();
    const opts = {
      bubbles: true,
      clientX: r.left + ((v.x + 1) / 2) * r.width,
      clientY: r.top + ((1 - v.y) / 2) * r.height,
      button: 0,
    };
    bp.three.element.dispatchEvent(new MouseEvent("mousedown", opts));
    bp.three.element.dispatchEvent(new MouseEvent("mouseup", opts));
  });
  await expect(page.getByText("Selected unit")).toBeVisible();
  await page.getByRole("button", { name: "▶ Open / close" }).click();
  // Opens-left slides toward local +x; settle past the ease.
  await expect.poll(moverX, { timeout: 3000 }).toBeGreaterThan(50);

  // Toggle again — closes back to the frame.
  await page.getByRole("button", { name: "▶ Open / close" }).click();
  await expect.poll(moverX, { timeout: 3000 }).toBeLessThan(2);

  // Camera: double-click near the unit moves the orbit target off centre.
  const before = await page.evaluate(() => {
    const bp = (window as any).__studio;
    const t = bp.three.controls.target;
    return { x: t.x, z: t.z };
  });
  await page.evaluate(() => {
    const bp = (window as any).__studio;
    const cam = bp.three.camera;
    cam.updateMatrixWorld();
    const v = bp.model.scene.getItems()[0].position.clone();
    v.project(cam);
    const r = bp.three.element.getBoundingClientRect();
    bp.three.element.dispatchEvent(
      new MouseEvent("dblclick", {
        bubbles: true,
        clientX: r.left + ((v.x + 1) / 2) * r.width,
        clientY: r.top + ((1 - v.y) / 2) * r.height,
      }),
    );
  });
  const after = await page.evaluate(() => {
    const bp = (window as any).__studio;
    const t = bp.three.controls.target;
    return { x: t.x, z: t.z };
  });
  const moved =
    Math.hypot(after.x - before.x, after.z - before.z) > 50 ||
    Math.abs(after.z - 600) < 60; // target near the unit's wall
  expect(moved).toBe(true);

  // Recenter frames the building again.
  await page.getByRole("button", { name: "Recenter" }).click();
  const recentred = await page.evaluate(() => {
    const bp = (window as any).__studio;
    const t = bp.three.controls.target;
    return { x: t.x, z: t.z };
  });
  expect(Math.abs(recentred.x - 900)).toBeLessThan(120); // building centre ~ (900, 300)
});

test("a fresh seed never mints twin walls", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "supervisor" });
  // No saved Studio model: the tab seeds from the traced building.
  await useOutline(page, { fitview: { model: FITVIEW_MODEL } });
  await openStudio(page);

  const wallCount = await page.evaluate(() => {
    const bp = (window as any).__studio;
    return bp.model.floorplan.getWalls().length;
  });
  // 4 + 4 walls minus the shared boundary seeded once = 7.
  expect(wallCount).toBe(7);
});

/** A closed 4-wall rectangle from (0,0) to (w,d) cm, in the vendor's saved
 * shape — the smallest plan the Studio boots and publishes. */
function rectPlanCm(w: number, d: number): string {
  const corners: Record<string, { x: number; y: number }> = {
    a: { x: 0, y: 0 },
    b: { x: w, y: 0 },
    c: { x: w, y: d },
    d: { x: 0, y: d },
  };
  const ids = Object.keys(corners);
  return JSON.stringify({
    floorplan: {
      corners,
      walls: ids.map((id, i) => ({ corner1: id, corner2: ids[(i + 1) % 4] })),
      wallTextures: [],
      floorTextures: {},
      newFloorTextures: {},
    },
    items: [],
  });
}

// Publish used to hand-roll the saved-model body with no `floors` and the
// ACTIVE floor as the old-reader mirror — publishing a multi-story model
// from floor 2 silently threw away floor 1. floors.test.ts pins the shared
// builder both writers use now; this pins the WIRING: the mutation must
// flush the live floor and send the whole set, from whichever floor you're
// standing on.
test("Publish from floor 2 keeps every floor — floor 1 stays the mirror", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "supervisor" });
  // A saved TWO-floor model, BLACK22-shaped: big ground rect, small upper
  // rect — told apart below by their x-extent. The fitview model is what
  // builds the job seed the boot gate waits for.
  const floor1 = rectPlanCm(1000, 600);
  const floor2 = rectPlanCm(500, 300);
  const row = outlineRow({
    fitview: { model: FITVIEW_MODEL },
    modelstudio: {
      serialized: floor1,
      floors: [floor1, floor2],
      savedAt: "2026-08-19T00:00:00Z",
      roof: "none",
    },
  });
  const patches: { features: Record<string, unknown> }[] = [];
  await page.route("**/rest/v1/project_plan_outlines**", (route) => {
    if (route.request().method() === "PATCH") {
      const body = route.request().postDataJSON() as { features: Record<string, unknown> };
      patches.push(body);
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ...row, features: body.features }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "content-range": "0-0/1" },
      body: JSON.stringify([row]),
    });
  });
  await openStudio(page);

  // Stand ON floor 2 — the exact shape of the bug (the active floor became
  // the mirror and every other floor vanished).
  await page.getByRole("button", { name: /Tools/ }).click();
  await page.getByText("Building", { exact: true }).click();
  await page.getByRole("button", { name: "2", exact: true }).click();
  await page.waitForFunction(() => {
    const bp = (window as any).__studio;
    const walls = bp?.model?.floorplan?.getWalls?.() ?? [];
    return (
      walls.length === 4 &&
      walls.every((w: any) => w.getStartX() <= 500 && w.getEndX() <= 500)
    );
  });

  await page.getByRole("button", { name: "Submit final" }).click();
  // The preview modal already counts BOTH stories…
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText(/2 stories/)).toBeVisible();
  await dialog.getByRole("button", { name: "Submit final", exact: true }).click();
  await expect(page.getByText("this is now the job's live 3D map")).toBeVisible();

  // …and the outline write carries the WHOLE studio model, not a floor-2 copy.
  expect(patches).toHaveLength(1);
  const features = patches[0].features as {
    modelstudio: { serialized: string; floors: string[]; roof: string };
    fitview: { model: { building: { stories: unknown[] } } };
    fitview_backup?: { model: unknown };
  };
  const xs = (s: string) =>
    Object.values(
      (JSON.parse(s) as { floorplan: { corners: Record<string, { x: number }> } })
        .floorplan.corners,
    ).map((c) => c.x);
  expect(features.modelstudio.floors).toHaveLength(2);
  expect(Math.max(...xs(features.modelstudio.floors[0]))).toBe(1000); // floor 1 survived
  expect(Math.max(...xs(features.modelstudio.floors[1]))).toBe(500); // the live floor rode along
  // Old readers get floor 1 — NOT the floor that happened to be active.
  expect(features.modelstudio.serialized).toBe(features.modelstudio.floors[0]);
  expect(features.modelstudio.roof).toBe("none");
  // The map side got both stories, and the previous map model is kept for
  // the one-tap revert.
  expect(features.fitview.model.building.stories).toHaveLength(2);
  expect(features.fitview_backup?.model).toBeTruthy();
});

test("a HUMAN trace seeds every traced story as a studio floor", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "supervisor" });
  // A tracer-written model: building.trace marks it human (a Studio
  // publish never has it). Two stories → the studio must boot two floors.
  await useOutline(page, {
    fitview: {
      model: {
        ...FITVIEW_MODEL,
        building: {
          ...FITVIEW_MODEL.building,
          trace: { polys: [], dots: [], stories: [] },
          stories: [
            { n: 1, elevM: 0, heightM: 3, footprints: [MASS_A, MASS_B] },
            { n: 2, elevM: 3, heightM: 2.5, footprints: [MASS_A] },
          ],
        },
      },
    },
  });
  await openStudio(page);

  const info = await page.evaluate(() => {
    const bp = (window as any).__studio;
    return { activeWalls: bp.model.floorplan.getWalls().length };
  });
  // Ground floor: both masses, shared boundary deduped (7 walls, not 8).
  expect(info.activeWalls).toBeGreaterThanOrEqual(7);

  // Switch to floor 2 (chips are numbered): MASS_A alone → 4 walls.
  await page.getByRole("button", { name: /Tools/ }).click();
  await page.getByText("Building", { exact: true }).click();
  await page.getByRole("button", { name: "2", exact: true }).click();
  await page.waitForFunction(() => {
    const bp = (window as any).__studio;
    return bp.model.floorplan.getWalls().length === 4;
  });
});

test("Flat view: entering it renders every wall as a panel and a placed unit as a rect", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "supervisor" });
  await useOutline(page, { fitview: { model: FITVIEW_MODEL } });
  await openStudio(page);

  await page.evaluate(() => {
    const bp = (window as any).__studio;
    bp.model.scene.addItem(
      3,
      "/modelstudio/models/window.json",
      {
        itemName: "E2E flat-view unit",
        itemType: 3,
        modelUrl: "/modelstudio/models/window.json",
        unitConfig: {
          kind: "window",
          heightMm: 1500,
          panels: [{ widthMm: 1200, mechanism: "fixed" }],
        },
      },
      { x: 500, y: 120, z: 0 },
      0,
      undefined,
      false,
    );
  });
  await page.waitForFunction(() => {
    const bp = (window as any).__studio;
    const items = bp.model.scene.getItems();
    return items.length === 1 && Boolean(items[0].currentWallEdge);
  });

  await page.getByLabel("View").selectOption("flat");
  await expect(page.getByText("Flat elevations")).toBeVisible();

  // MASS_A + MASS_B share a deduped boundary: 7 walls, one panel each.
  await expect(page.locator(".studio-flat-wall")).toHaveCount(7);
  await expect(page.locator(".studio-flat-item")).toHaveCount(1);
  await expect(page.getByText("E2E flat-view unit")).toBeVisible();
});
