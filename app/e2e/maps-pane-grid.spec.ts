// Wave G (2026-09-01): a mark's real CAD cell (spec.extra.pane_grid) draws
// as the actual storefront in the elevations view instead of a flat
// single-row guess. This end-to-ends the parser (paneGrid.ts) + the adapter
// plumbing (adapter.ts) + the vendored renderer's new drawPaneGrid branch
// (fitviewRenderer.ts) through the real page, using the SAME canonical
// madMooseMark7Grid fixture the unit tests pin against — 8 fixed lites
// around a center double swing-door pair.
import { expect, test, type Route } from "@playwright/test";
import { jobFixtures, useSupabaseFixtures } from "./support/supabaseFixtures";
import { madMooseMark7Grid } from "../src/lib/fitview/paneGrid";

const BLACK22 = jobFixtures().find((j) => j.jobCode === "BLACK22")!;

/** One placed window ("7", mark 7's real order size) on an 18x6m mass. */
const MODEL = {
  building: {
    width: 18,
    depth: 6,
    height: 4,
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
  windows: [{ id: "7", elev: "s0", x: 2, y: 0, w: 4254, h: 3645 }],
};

function json(route: Route, body: unknown, rows = 0) {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    headers: { "content-range": `0-${Math.max(0, rows - 1)}/${rows}` },
    body: JSON.stringify(body),
  });
}

async function stageOutline(page: import("@playwright/test").Page) {
  await page.route("**/rest/v1/project_plan_outlines**", (route) =>
    json(
      route,
      [
        {
          id: "00000000-0000-4000-8000-0000000b7777",
          project_id: BLACK22.projectId,
          planset_id: null,
          page_number: 1,
          points: [],
          page_aspect: 0.7,
          features: { fitview: { model: MODEL } },
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
        },
      ],
      1,
    ),
  );
}

test("a mark with pane_grid draws the real storefront - mullions, F glyphs, and 2 door leaves", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "supervisor" });
  await stageOutline(page);
  await page.route("**/rest/v1/project_mark_specs**", (route) =>
    json(
      route,
      [
        {
          id: "00000000-0000-4000-8000-0000000ba001",
          project_id: BLACK22.projectId,
          mark_code: "7",
          extra: { pane_grid: madMooseMark7Grid },
        },
      ],
      1,
    ),
  );

  await page.goto(`/projects/${BLACK22.projectId}?tab=maps-interactive`);
  const win = page.locator('.win[data-id="7"]');
  await expect(win).toBeVisible({ timeout: 60_000 });

  // 4 columns -> 3 interior column mullions; 6 interior segment breaks (2 in
  // each F-stack column, 1 in each door column) - the shape only a real
  // grid produces, never the flat single-row fallback.
  await expect(win.locator(".mull")).toHaveCount(3);
  await expect(win.locator(".gmull")).toHaveCount(6);
  // 8 fixed lites, each its own "F" glyph.
  const fglyphs = win.locator(".fglyph");
  await expect(fglyphs).toHaveCount(8);
  await expect(fglyphs.first()).toHaveText("F");
  // 2 door leaves, each its own hinge-diagonal svg + kick plate.
  await expect(win.locator("svg")).toHaveCount(2);
  await expect(win.locator(".kick")).toHaveCount(2);
  // SIZE/ID overlays keep working regardless of the grid underneath.
  await expect(win.locator(".chip")).toHaveText("7");
  await expect(win.locator(".dim")).toBeVisible();
});

test("fallback law: the same mark with no pane_grid draws the old flat layout", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "supervisor" });
  await stageOutline(page);
  // No project_mark_specs override at all here - mark 7 has no spec, so no
  // pane_grid ever reaches the window. This is the control: today's drawing,
  // untouched, right next to the grid case above.

  await page.goto(`/projects/${BLACK22.projectId}?tab=maps-interactive`);
  const win = page.locator('.win[data-id="7"]');
  await expect(win).toBeVisible({ timeout: 60_000 });

  await expect(win.locator(".gmull")).toHaveCount(0);
  await expect(win.locator(".fglyph")).toHaveCount(0);
  // No panes/lights info at all on this bare window -> the equal-division
  // fallback draws a single light, so there is no interior mullion either.
  await expect(win.locator(".mull")).toHaveCount(0);
});
