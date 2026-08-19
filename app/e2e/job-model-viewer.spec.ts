// The phone-friendly job model viewer (Studio 100x #27): an installer's
// door into a job's 3D Studio model from the Maps Interactive tab, and the
// plain-words empty state when a job has never had one saved. Fine-grained
// 3D interaction (tap-to-inspect, orbit) is left to manual/visual checks —
// same call the Studio's own e2e suite makes (studio-standalone.spec.ts
// never simulates a click on a rendered 3D object either); this spec covers
// the door, the route and the load, which is where a real regression would
// actually strand an installer.

import { expect, test } from "@playwright/test";
import { jobFixtures, useSupabaseFixtures } from "./support/supabaseFixtures";

const BLACK22 = jobFixtures().find((j) => j.jobCode === "BLACK22")!;
const PECAN14 = jobFixtures().find((j) => j.jobCode === "PECAN14")!;

/** A minimal but valid blueprint3d-modern floorplan — the exact shape
 * ModelStudio.tsx boots a blank project from (BLANK_SERIALIZED). Empty is
 * fine: this spec proves the load/mount pipeline works, not any particular
 * geometry. */
const BLANK_MODEL_SERIALIZED = JSON.stringify({
  floorplan: {
    corners: {},
    walls: [],
    wallTextures: [],
    floorTextures: {},
    newFloorTextures: {},
  },
  items: [],
});

async function useModelOutline(page: import("@playwright/test").Page, projectId: string) {
  await page.route("**/rest/v1/project_plan_outlines**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "content-range": "0-0/1" },
      body: JSON.stringify([
        {
          id: "00000000-0000-4000-8000-0000000b3327",
          project_id: projectId,
          planset_id: null,
          page_number: 1,
          points: [],
          page_aspect: 0.7,
          features: {
            modelstudio: {
              serialized: BLANK_MODEL_SERIALIZED,
              savedAt: "2026-08-18T00:00:00Z",
            },
          },
          created_at: "2026-08-18T00:00:00Z",
          updated_at: "2026-08-18T00:00:00Z",
        },
      ]),
    }),
  );
}

test("an installer walks a job's saved model from Maps Interactive", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "installer" });
  await useModelOutline(page, BLACK22.projectId);
  await page.goto(`/projects/${BLACK22.projectId}?tab=maps-interactive`);

  const door = page.getByRole("link", { name: "Walk the 3D model" });
  await expect(door).toBeVisible({ timeout: 60_000 });
  await door.click();

  await expect(page).toHaveURL(new RegExp(`/projects/${BLACK22.projectId}/model$`));
  await expect(page.getByText("BLACK22")).toBeVisible();
  // The loaded-model UI, not the empty state — proves the fetch, the
  // offline-cache write and the Blueprint3d mount all completed.
  await expect(page.getByText(/Drag to orbit/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("No 3D model yet")).not.toBeVisible();
});

test("no door, and a plain-words empty state, for a job with no saved model", async ({
  page,
}) => {
  // No outline route override — the fixture default is an empty
  // project_plan_outlines table, the real production state for a job that
  // has never had a Studio model saved.
  await useSupabaseFixtures(page, { role: "installer" });
  await page.goto(`/projects/${PECAN14.projectId}?tab=maps-interactive`);

  await expect(page.getByText("No building model yet")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("link", { name: "Walk the 3D model" })).not.toBeVisible();

  // A direct deep link (e.g. a stale bookmark) must read as "nothing here
  // yet" in plain words, never as a crash or an error screen.
  await page.goto(`/projects/${PECAN14.projectId}/model`);
  await expect(page.getByText("No 3D model yet")).toBeVisible();
  await expect(page.getByText(/doesn't have a saved Studio model yet/)).toBeVisible();
});
