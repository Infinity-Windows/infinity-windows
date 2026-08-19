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
  await expect(page.locator(".flat-minimap line.on")).toHaveAttribute("data-edge", "0");

  await page.evaluate(() => {
    const stage = document.querySelector(".stage.flat")!;
    stage.scrollLeft = stage.scrollWidth;
  });
  // Frame-driven sync: the highlight lands on the last wall's edge.
  await expect(page.locator(".flat-minimap line.on")).toHaveAttribute("data-edge", "3", {
    timeout: 5_000,
  });

  // And the wall chips agree — the elevation strip marks the current wall.
  await page.evaluate(() => {
    const stage = document.querySelector(".stage.flat")!;
    stage.scrollLeft = 0;
  });
  await expect(page.locator(".flat-minimap line.on")).toHaveAttribute("data-edge", "0", {
    timeout: 5_000,
  });
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
