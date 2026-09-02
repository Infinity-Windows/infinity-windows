// Flat map minimap (owner report, 2026-08-19: "this map doesn't move
// with me when I scroll"): the you-are-here edge must follow the scroll.
// The sync is frame-driven (scrollLeft watched per animation frame), so
// this holds regardless of which element the platform fires scroll on.
import { test, expect } from "@playwright/test";
import { jobFixtures, useSupabaseFixtures } from "./support/supabaseFixtures";

const BLACK22 = jobFixtures().find((j) => j.jobCode === "BLACK22")!;

/** A tiny authored fitview model: one 18×6 m mass, two windows on the
 * south elevation carrying REAL fixture mark codes so the host can map
 * them to opening UUIDs. */
const MODEL = {
  building: {
    width: 18,
    depth: 6,
    height: 3,
    rise: 0,
    footprints: [
      [
        { x: 0, z: 0 },
        { x: 18, z: 0 },
        { x: 18, z: 6 },
        { x: 0, z: 6 },
      ],
    ],
  },
  windows: [
    { id: "10", elev: "s0", x: 3, y: 0.9, w: 1500, h: 1200 },
    { id: "11", elev: "s0", x: 8, y: 0.9, w: 1500, h: 1200 },
  ],
};

/** The one authored outline the map reads its model out of. */
async function useOutline(page: import("@playwright/test").Page) {
  await page.route("**/rest/v1/project_plan_outlines**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "content-range": "0-0/1" },
      body: JSON.stringify([
        {
          id: "00000000-0000-4000-8000-0000000a5519",
          project_id: BLACK22.projectId,
          planset_id: null,
          page_number: 1,
          points: [],
          page_aspect: 0.7,
          features: { fitview: { model: MODEL } },
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
        },
      ]),
    }),
  );
}


test("the minimap's you-are-here edge follows the scroll", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "foreman" });
  await useOutline(page);
  await page.goto(`/projects/${BLACK22.projectId}?tab=maps-interactive`);
  await expect(page.locator("button.win").first()).toBeVisible({ timeout: 60_000 });
  const firstGeo = await page
    .locator(".flat-wall")
    .first()
    .getAttribute("data-geo");
  const lastGeo = await page.locator(".flat-wall").last().getAttribute("data-geo");
  await expect(page.locator(".flat-minimap line.on")).toHaveAttribute(
    "data-geo",
    firstGeo!,
  );

  await page.evaluate(() => {
    const stage = document.querySelector(".stage.flat")!;
    stage.scrollLeft = stage.scrollWidth;
  });
  // Frame-driven sync: the highlight lands on the LAST wall's edge.
  await expect(page.locator(".flat-minimap line.on")).toHaveAttribute(
    "data-geo",
    lastGeo!,
    { timeout: 5_000 },
  );

  await page.evaluate(() => {
    const stage = document.querySelector(".stage.flat")!;
    stage.scrollLeft = 0;
  });
  await expect(page.locator(".flat-minimap line.on")).toHaveAttribute(
    "data-geo",
    firstGeo!,
    { timeout: 5_000 },
  );
});

test("the minimap stays locked in the corner while the walls scroll", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "foreman" });
  await useOutline(page);
  await page.goto(`/projects/${BLACK22.projectId}?tab=maps-interactive`);
  await expect(page.locator("button.win").first()).toBeVisible({ timeout: 60_000 });

  const map = page.locator(".flat-minimap");
  const before = (await map.boundingBox())!;
  await page.evaluate(() => {
    const stage = document.querySelector(".stage.flat")!;
    stage.scrollLeft = stage.scrollWidth;
  });
  // The frame-driven pin walks it back by exactly the scroll — on screen it
  // must not move more than a hair.
  await expect
    .poll(async () => Math.abs(((await map.boundingBox())!.x - before.x)), {
      timeout: 5_000,
    })
    .toBeLessThan(2);
});

/** Same outline route, different model — for the multi-building and
 * multi-story cases below. */
async function useModel(page: import("@playwright/test").Page, model: unknown) {
  await page.route("**/rest/v1/project_plan_outlines**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "content-range": "0-0/1" },
      body: JSON.stringify([
        {
          id: "00000000-0000-4000-8000-0000000a5520",
          project_id: BLACK22.projectId,
          planset_id: null,
          page_number: 1,
          points: [],
          page_aspect: 0.7,
          features: { fitview: { model } },
          created_at: "2026-08-14T00:00:00Z",
        },
      ]),
    }),
  );
}

const TWO_BUILDINGS = {
  building: {
    width: 30, depth: 6, height: 3, rise: 0,
    footprints: [
      [ { x: 0, z: 0 }, { x: 12, z: 0 }, { x: 12, z: 6 }, { x: 0, z: 6 } ],
      [ { x: 18, z: 0 }, { x: 30, z: 0 }, { x: 30, z: 6 }, { x: 18, z: 6 } ],
    ],
  },
  windows: [
    { id: "10", elev: "s0", x: 3, y: 0.9, w: 1500, h: 1200 },
    { id: "11", elev: "s4", x: 2, y: 0.9, w: 1500, h: 1200 },
  ],
};

const TWO_STORIES = {
  building: {
    width: 12, depth: 6, height: 6, rise: 0,
    footprints: [[ { x: 0, z: 0 }, { x: 12, z: 0 }, { x: 12, z: 6 }, { x: 0, z: 6 } ]],
    stories: [
      { n: 1, elevM: 0, heightM: 3, footprints: [[ { x: 0, z: 0 }, { x: 12, z: 0 }, { x: 12, z: 6 }, { x: 0, z: 6 } ]] },
      { n: 2, elevM: 3, heightM: 3, footprints: [[ { x: 0, z: 0 }, { x: 12, z: 0 }, { x: 12, z: 6 }, { x: 0, z: 6 } ]] },
    ],
  },
  windows: [
    { id: "10", elev: "s0", x: 3, y: 0.9, w: 1500, h: 1200, story: 1 },
    { id: "11", elev: "s4", x: 6, y: 0.9, w: 1500, h: 1200, story: 2 },
  ],
};

test("two buildings never interleave, and the minimap knows both", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "foreman" });
  await useModel(page, TWO_BUILDINGS);
  await page.goto(`/projects/${BLACK22.projectId}?tab=maps-interactive`);
  await expect(page.locator("button.win").first()).toBeVisible({ timeout: 60_000 });

  // Walls come building-by-building: 4 for building 1, then the break, then 4.
  const polys = await page.$$eval(".flat-wall", (els) =>
    els.map((el) => (el as HTMLElement).dataset.geo!.split("|")[0]),
  );
  expect(polys).toEqual(["0", "0", "0", "0", "1", "1", "1", "1"]);
  // Both buildings get named dividers — the first one too, so the row
  // reads "BUILDING 1 · walls · BUILDING 2 · walls".
  await expect(page.locator(".flat-building-break")).toHaveCount(2);
  await expect(page.locator(".flat-building-break").first()).toContainText("Building 1");
  await expect(page.locator(".flat-building-break").last()).toContainText("Building 2");
  // Both outlines drawn: 8 edges total on the minimap.
  await expect(page.locator(".flat-minimap svg line")).toHaveCount(8);

  // Scroll to the far end: the lit edge belongs to BUILDING 2.
  await page.evaluate(() => {
    const stage = document.querySelector(".stage.flat")!;
    stage.scrollLeft = stage.scrollWidth;
  });
  await expect
    .poll(async () =>
      page
        .locator(".flat-minimap line.on")
        .getAttribute("data-geo")
        .then((g) => g?.split("|")[0]),
    )
    .toBe("1");
  // And the label says which building.
  await expect(page.locator(".flat-minimap-label")).toContainText("B2");
});

test("a two-story wall is ONE panel with both stories stacked", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "foreman" });
  await useModel(page, TWO_STORIES);
  await page.goto(`/projects/${BLACK22.projectId}?tab=maps-interactive`);
  await expect(page.locator("button.win").first()).toBeVisible({ timeout: 60_000 });

  // 4 physical walls — not 8 story-bands.
  await expect(page.locator(".flat-wall")).toHaveCount(4);
  // The south wall carries both stories' faces, and both windows live in it.
  const south = page.locator(".flat-wall").first();
  await expect(south.locator(".face")).toHaveCount(2);
  await expect(south.locator("button.win")).toHaveCount(2);
  // No building break for a single building.
  await expect(page.locator(".flat-building-break")).toHaveCount(0);
});

// Owner report, 2026-09-01: a wall much narrower than its neighbours, at the
// tail of the walk, could never be scrolled to centre — native
// overflow-x:auto clamps at the row's own content edge, short of where a
// wall this thin needs the row to reach, so the minimap's you-are-here edge
// (which follows the centred wall) could never land on it. A plain 18x6m
// rectangle with one extra vertex splits its west side into two panels — a
// normal-width one, then a sliver that closes back to the origin and is
// walked LAST — the shape of the owner's actual job (a narrow tail wall
// next to an ordinary one), without needing an interior wall (whose own
// minimap line — once a separate, pre-existing gap — is the next case
// below).
const NARROW_LAST_WALL = {
  building: {
    width: 18, depth: 6, height: 3, rise: 0,
    footprints: [[
      { x: 0, z: 0 }, { x: 18, z: 0 }, { x: 18, z: 6 }, { x: 0, z: 6 }, { x: 0, z: 0.5 },
    ]],
  },
  windows: [
    { id: "10", elev: "s0", x: 3, y: 0.9, w: 1500, h: 1200 },
    { id: "11", elev: "s4", x: 0.05, y: 0.9, w: 300, h: 400 },
  ],
};

test("scrolled to the max, a narrow LAST wall still centres and highlights", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "foreman" });
  await useModel(page, NARROW_LAST_WALL);
  await page.goto(`/projects/${BLACK22.projectId}?tab=maps-interactive`);
  await expect(page.locator("button.win").first()).toBeVisible({ timeout: 60_000 });

  const lastGeo = await page.locator(".flat-wall").last().getAttribute("data-geo");

  await page.evaluate(() => {
    const stage = document.querySelector(".stage.flat")!;
    stage.scrollLeft = stage.scrollWidth;
  });
  // Frame-driven sync, same as the other cases above: the highlight lands
  // on the LAST wall's edge, even though it is far narrower than the rest.
  await expect(page.locator(".flat-minimap line.on")).toHaveAttribute(
    "data-geo",
    lastGeo!,
    { timeout: 5_000 },
  );
});

// The gap the case above deliberately stepped around (2026-09-01): a
// published interior wall (wave W) is an ordinary panel in the strip — it
// can centre, and its chip and label light — but the minimap outline drew
// exterior polygon edges only, so no line on the map ever lit for it. The
// map now draws interior walls too (dashed, so the solid silhouette still
// reads as the outside of the building) and the you-are-here highlight
// lands on them like any other wall.
const ONE_INTERIOR_WALL = {
  building: {
    width: 18, depth: 6, height: 3, rise: 0,
    footprints: [[ { x: 0, z: 0 }, { x: 18, z: 0 }, { x: 18, z: 6 }, { x: 0, z: 6 } ]],
    interiorWalls: [
      { x1: 9, z1: 0, x2: 9, z2: 6, heightM: 3, elevM: 0, story: 1, name: "Interior 1", interior: true },
    ],
  },
  windows: [
    { id: "10", elev: "s0", x: 3, y: 0.9, w: 1500, h: 1200 },
    { id: "11", elev: "s4", x: 2, y: 0.9, w: 1500, h: 1200 },
  ],
};

test("an interior wall centred in the strip lights its own minimap line", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "foreman" });
  await useModel(page, ONE_INTERIOR_WALL);
  await page.goto(`/projects/${BLACK22.projectId}?tab=maps-interactive`);
  await expect(page.locator("button.win").first()).toBeVisible({ timeout: 60_000 });

  // Interior walls walk in after every exterior edge: last panel, key s4.
  const wall = page.locator(".flat-wall").last();
  await expect(wall).toHaveAttribute("data-elev", "s4");
  const geo = await wall.getAttribute("data-geo");

  // The outline carries a line for it: 4 exterior edges + 1 interior.
  await expect(page.locator(".flat-minimap svg line")).toHaveCount(5);
  await expect(page.locator(".flat-minimap svg line.interior")).toHaveCount(1);

  await page.evaluate(() => {
    const stage = document.querySelector(".stage.flat")!;
    stage.scrollLeft = stage.scrollWidth;
  });
  // Same frame-driven sync as every case above — but now the lit line is
  // the interior wall's own.
  await expect(page.locator(".flat-minimap line.on")).toHaveAttribute(
    "data-geo",
    geo!,
    { timeout: 5_000 },
  );
});
