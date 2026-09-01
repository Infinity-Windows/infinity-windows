// Wave W (w-walls-spec.md, 2026-08-31) — Studio wall tools: drag-to-draw,
// auto-square, interior walls that publish, custom marks, and the
// laptop/PC-only gate. Desktop viewport for the editor tests (the Studio is
// a laptop tool, same call studio-holes.spec.ts makes); the narrow-viewport
// test and the crew-map elevations test use the suite's own phone default.

import { expect, test, type Route } from "@playwright/test";
import { jobFixtures, useSupabaseFixtures } from "./support/supabaseFixtures";

const BLACK22 = jobFixtures().find((j) => j.jobCode === "BLACK22")!;
const SP1 = "00000000-0000-4000-8000-00000000d001";

const STUDIO_ROWS = [
  {
    id: SP1,
    name: "Wall tools test project",
    project_id: null,
    model: null,
    archived: false,
    created_by: "e2e",
    created_at: "2026-08-13T00:00:00Z",
    updated_at: "2026-08-13T00:00:00Z",
  },
];

function json(route: Route, body: unknown, rows = 0) {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    headers: { "content-range": `0-${Math.max(0, rows - 1)}/${rows}` },
    body: JSON.stringify(body),
  });
}

async function useStudioFixtures(page: import("@playwright/test").Page) {
  await page.route("**/rest/v1/studio_projects**", (r) => {
    const single = (r.request().headers()["accept"] ?? "").includes("pgrst.object");
    return single ? json(r, STUDIO_ROWS[0], 1) : json(r, STUDIO_ROWS, STUDIO_ROWS.length);
  });
  await page.route("**/rest/v1/rpc/save_studio_project", (r) =>
    json(r, STUDIO_ROWS[0], 1),
  );
}

/** A rectangular serialized plan, no windows — the exact shape a saved
 * Studio floorplan takes (blueprint3d-modern), same corners/walls format
 * studio-holes.spec.ts's twinWallPlan uses. */
function rectPlan(x0: number, y0: number, x1: number, y1: number): string {
  const corners = {
    a: { x: x0, y: y0 },
    b: { x: x1, y: y0 },
    c: { x: x1, y: y1 },
    d: { x: x0, y: y1 },
  };
  const walls = [
    { corner1: "a", corner2: "b" },
    { corner1: "b", corner2: "c" },
    { corner1: "c", corner2: "d" },
    { corner1: "d", corner2: "a" },
  ];
  return JSON.stringify({
    floorplan: { corners, walls, wallTextures: [], floorTextures: {}, newFloorTextures: {} },
    items: [],
  });
}

/** A minimal authored fit-view model — a job source only boots its saved
 * modelstudio plan once it has a seed to boot FROM (ModelStudio.tsx's
 * `bootReady`/`seed`), same as studio-holes.spec.ts's FITVIEW_MODEL. The
 * shape itself is irrelevant here; the saved modelstudio.serialized plan
 * wins over it once booted (savedSerialized beats seedFloors). */
const SEED_MODEL = {
  building: {
    width: 10,
    depth: 6,
    height: 3,
    rise: 0,
    footprints: [
      [
        { x: 0, z: 0 },
        { x: 10, z: 0 },
        { x: 10, z: 6 },
        { x: 0, z: 6 },
      ],
    ],
  },
  windows: [],
};

async function useOutline(page: import("@playwright/test").Page, serialized: string) {
  await page.route("**/rest/v1/project_plan_outlines**", (route) =>
    json(
      route,
      [
        {
          id: "00000000-0000-4000-8000-00000000e011",
          project_id: BLACK22.projectId,
          planset_id: null,
          page_number: 1,
          points: [],
          page_aspect: 0.7,
          features: {
            fitview: { model: SEED_MODEL },
            modelstudio: { serialized, savedAt: "2026-08-31T00:00:00Z" },
          },
          created_at: "2026-08-31T00:00:00Z",
          updated_at: "2026-08-31T00:00:00Z",
        },
      ],
      1,
    ),
  );
}

// ---------- W1/W2: drag-to-draw and angle-snap ----------

test.describe("Studio editor (desktop)", () => {
  test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });

  test("W1: press-and-drag in Draw walls mode creates a wall", async ({ page }) => {
    await useSupabaseFixtures(page, { role: "supervisor" });
    await useStudioFixtures(page);
    await page.goto(`/studio/p/${SP1}`);
    await expect(page.getByText("Model (3D)")).toBeVisible();

    await page.getByLabel("View").selectOption("plan");
    await expect(page.getByText("Plan (2D)")).toBeVisible();
    await page.getByRole("button", { name: /Tools/ }).click();
    await page.getByRole("button", { name: "Draw walls" }).click();

    const box = await page.locator("#studio-floorplan").boundingBox();
    if (!box) throw new Error("no floorplan canvas");
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;

    // One press-and-drag, no second click: click-click still works
    // separately (studio-standalone.spec.ts's programmatic corners cover
    // that path), this proves the NEW gesture on its own.
    await page.mouse.move(cx - 80, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 80, cy, { steps: 8 });
    await page.mouse.up();

    const wallCount = await page.evaluate(() => {
      const bp = (window as any).__studio;
      return bp.model.floorplan.getWalls().length;
    });
    expect(wallCount).toBe(1);
  });

  test("W2: a near-square second wall snaps to exactly 90 degrees", async ({ page }) => {
    await useSupabaseFixtures(page, { role: "supervisor" });
    await useStudioFixtures(page);
    await page.goto(`/studio/p/${SP1}`);
    await expect(page.getByText("Model (3D)")).toBeVisible();
    await page.getByLabel("View").selectOption("plan");
    await page.getByRole("button", { name: /Tools/ }).click();
    await page.getByRole("button", { name: "Draw walls" }).click();

    const box = await page.locator("#studio-floorplan").boundingBox();
    if (!box) throw new Error("no floorplan canvas");
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;

    // Wall 1: a plain horizontal drag — the reference the second wall's
    // angle gets measured against.
    await page.mouse.move(cx - 80, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 80, cy, { steps: 8 });
    await page.mouse.up();

    // Wall 2: press right where wall 1 ended (continuing the chain — the
    // same 25cm tolerance click-click's own chaining already relies on),
    // then drag ~87° off wall 1's own line — within the 5° tolerance of a
    // true 90° corner, so it must snap exactly vertical.
    await page.mouse.move(cx + 80, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 87, cy + 148, { steps: 8 });
    await page.mouse.up();

    const walls = await page.evaluate(() => {
      const bp = (window as any).__studio;
      return bp.model.floorplan.getWalls().map((w: any) => ({
        x1: w.getStartX(), y1: w.getStartY(), x2: w.getEndX(), y2: w.getEndY(),
      }));
    });
    expect(walls).toHaveLength(2);
    const [wall1, wall2] = walls;
    // Sanity: wall 1 really is (close to) horizontal — the premise the
    // snap is measured against.
    expect(Math.abs(wall1.y2 - wall1.y1)).toBeLessThan(5);

    // Wall 2 shares its start with wall 1's end (the chain continued)…
    expect(Math.abs(wall2.x1 - wall1.x2)).toBeLessThan(1);
    expect(Math.abs(wall2.y1 - wall1.y2)).toBeLessThan(1);
    // …and its own angle is EXACTLY square to wall 1, not merely close.
    const angle = (Math.atan2(wall2.y2 - wall2.y1, wall2.x2 - wall2.x1) * 180) / Math.PI;
    expect(Math.abs(Math.abs(angle) - 90)).toBeLessThan(0.5);
    expect(Math.abs(wall2.x2 - wall2.x1)).toBeLessThan(0.5); // dead vertical
  });

  // ---------- W4: custom marks from Studio ----------

  test("W4: Submit final with a named custom mark shows the 'Adds 1 new mark' line", async ({
    page,
  }) => {
    await useSupabaseFixtures(page, { role: "supervisor" });
    await useOutline(page, rectPlan(0, 0, 1000, 600));
    await page.goto(`/studio/j/${BLACK22.projectId}`);
    await page.waitForFunction(
      () => {
        const bp = (window as any).__studio;
        return (bp?.model?.floorplan?.getWalls?.()?.length ?? 0) > 0;
      },
      undefined,
      { timeout: 60_000 },
    );
    await page.getByRole("button", { name: /Tools/ }).click();

    // A plain unit with a real size, placed on the front wall — same
    // addItem shape studio-holes.spec.ts uses to drop a catalog unit.
    await page.evaluate(() => {
      const bp = (window as any).__studio;
      bp.model.scene.addItem(
        3,
        "/modelstudio/models/window.json",
        {
          itemName: "New window",
          itemType: 3,
          modelUrl: "/modelstudio/models/window.json",
          unitConfig: {
            kind: "window",
            heightMm: 1200,
            panels: [{ widthMm: 900, mechanism: "fixed" }],
          },
        },
        { x: 500, y: 150, z: 0 },
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

    await page.evaluate(() => {
      const bp = (window as any).__studio;
      bp.three.itemSelectedCallbacks.fire(bp.model.scene.getItems()[0]);
    });
    await expect(page.getByText("Selected unit")).toBeVisible();

    await expect(page.getByText("Name this as a new mark (optional)")).toBeVisible();
    await page.getByLabel("Mark code").fill("D-11");
    await page.getByRole("button", { name: "Name it" }).click();
    await expect(page.getByText(/Named D-11/)).toBeVisible();

    await page.getByRole("button", { name: "Submit final" }).click();
    await expect(page.getByText("Submit this as the job's final model?")).toBeVisible();
    await expect(page.getByText("Adds 1 new mark to this job: D-11")).toBeVisible();
  });
});

// ---------- W3: interior walls publish (crew map, elevations) ----------

test("W3: an interior wall on the crew map shows an Interior chip and carries its window", async ({
  page,
}) => {
  const MODEL = {
    building: {
      width: 10,
      depth: 8,
      height: 3,
      rise: 0,
      footprints: [
        [
          { x: 0, z: 0 },
          { x: 10, z: 0 },
          { x: 10, z: 8 },
          { x: 0, z: 8 },
        ],
      ],
      interiorWalls: [
        { x1: 5, z1: 0, x2: 5, z2: 8, heightM: 3, elevM: 0, story: 1, name: "Interior 1" },
      ],
    },
    // s0-s3 are the exterior loop; s4 is the interior wall (elevationsOf
    // walks it right after the exterior edges — toFitview.test.ts and
    // fitviewRenderer.test.ts both pin this same index).
    // status: explicit — this mark has no matching project_openings row in
    // the fixture (unlike BLACK22's real "10"/"11" marks other specs use),
    // so buildAuthoredJob leaves it exactly as authored; the renderer needs
    // a real STATUS key to build the window's aria-label.
    windows: [{ id: "H1", elev: "s4", x: 1, y: 0.9, w: 900, h: 1200, status: "tofit" }],
  };

  await useSupabaseFixtures(page, { role: "supervisor" });
  await page.route("**/rest/v1/project_plan_outlines**", (route) =>
    json(
      route,
      [
        {
          id: "00000000-0000-4000-8000-00000000f011",
          project_id: BLACK22.projectId,
          planset_id: null,
          page_number: 1,
          points: [],
          page_aspect: 0.7,
          features: { fitview: { model: MODEL } },
          created_at: "2026-08-31T00:00:00Z",
          updated_at: "2026-08-31T00:00:00Z",
        },
      ],
      1,
    ),
  );

  await page.goto(`/projects/${BLACK22.projectId}?tab=maps-interactive`);
  await expect(page.locator("button.win").first()).toBeVisible({ timeout: 60_000 });

  // The elevation strip's chip — CSS uppercases it, so the raw text is
  // "Interior 1" (matching toFitview.ts's own naming).
  const chip = page.locator('.elev[data-elev="s4"]');
  await expect(chip).toBeVisible();
  await expect(chip).toContainText("Interior 1");

  // It highlights like any wall: tapping the chip focuses that elevation
  // and the chip goes pressed, same as Front/Right/Rear/Left do.
  await chip.click();
  await expect(chip).toHaveAttribute("aria-pressed", "true");
});

// ---------- W5: Studio is laptop/PC-only ----------

test("W5: a narrow viewport shows the laptop note instead of the editor, live", async ({
  page,
}) => {
  // The suite's own default viewport (390x844) is already narrow — no
  // override needed to prove the gate.
  await useSupabaseFixtures(page, { role: "supervisor" });
  await useStudioFixtures(page);
  await page.goto(`/studio/p/${SP1}`);

  await expect(
    page.getByText(/Studio needs a laptop or PC/),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /Tools/ })).not.toBeVisible();

  // Resize back up: the editor returns live, no reload.
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByText("Model (3D)")).toBeVisible();
  await expect(page.getByText(/Studio needs a laptop or PC/)).not.toBeVisible();
});
