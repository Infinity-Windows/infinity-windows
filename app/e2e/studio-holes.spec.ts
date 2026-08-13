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

function outlineRow(features: Record<string, unknown>) {
  return {
    id: "00000000-0000-4000-8000-00000000531d",
    project_id: BLACK22.projectId,
    planset_id: null,
    page_number: 1,
    points: [],
    page_aspect: 0.7,
    features,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

/** Serve one synthetic outline row; registered AFTER the fixture router so
 * it wins (Playwright matches routes newest-first). */
async function useOutline(
  page: import("@playwright/test").Page,
  features: Record<string, unknown>,
) {
  const row = outlineRow(features);
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
  await page.goto(`/projects/${BLACK22.projectId}?tab=model-studio`);
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
