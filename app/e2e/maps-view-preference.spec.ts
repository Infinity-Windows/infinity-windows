// Maps Interactive view preference (owner decision, 2026-08-21): the "3D
// (beta)" tab is cut — flat and Sheets are the only views left. A device
// that had earlier stored "3d" must land on flat instead of silently
// reopening a view that no longer exists, and the stored value itself gets
// corrected so it can't resurface on a later load either.
import { test, expect } from "@playwright/test";
import { jobFixtures, useSupabaseFixtures } from "./support/supabaseFixtures";

const BLACK22 = jobFixtures().find((j) => j.jobCode === "BLACK22")!;

/** A tiny authored fitview model: one 18×6 m mass, two windows on the
 * south elevation carrying REAL fixture mark codes so the host can map
 * them to opening UUIDs. Same fixture shape used by flat-minimap.spec.ts
 * and map-assign.spec.ts. */
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

test('a stored "3d" preference lands on flat, and the toggle never offers 3D', async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "foreman" });
  await useOutline(page);
  // Simulate a device that chose 3D back when it was still an option — the
  // init script runs before any app code, same as a real earlier visit would.
  await page.addInitScript(() => {
    localStorage.setItem("infinity.mapsView", "3d");
  });

  await page.goto(`/projects/${BLACK22.projectId}?tab=maps-interactive`);
  await expect(page.locator("button.win").first()).toBeVisible({ timeout: 60_000 });

  // The Map (flat) pill reads as selected, and there is no "3D" pill to
  // select in the first place — it's gone, not just skipped.
  await expect(page.getByRole("button", { name: "Map", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByRole("button", { name: "3D (beta)" })).toHaveCount(0);

  // Sanitized in storage too, not just on this one read — a later load (or
  // another tab reading the same key) must never see "3d" again.
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("infinity.mapsView")))
    .toBe("flat");
});
