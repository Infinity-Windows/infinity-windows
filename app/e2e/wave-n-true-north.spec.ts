// Wave N — true north. Two things worth proving end-to-end (real UI, real
// network shape, only the writes mocked so the assertions can see them):
//   1. Setting north in the tracer actually reaches the mini-map's rose.
//   2. The footgun this wave fixes stays fixed across BOTH writers in
//      sequence: a Plan Model save, then a trace re-submit, must each leave
//      a previously-set northDeg intact — the CLAUDE.md-documented bug this
//      PR closes (N4).
// Same house style as flat-minimap.spec.ts / vision-placement.spec.ts:
// override project_plan_outlines with a stateful mock, drive the real UI,
// assert the CAPTURED write payload rather than just that something rendered.
import { expect, test, type Route } from "@playwright/test";
import { jobFixtures, useSupabaseFixtures } from "./support/supabaseFixtures";

const BLACK22 = jobFixtures().find((j) => j.jobCode === "BLACK22")!;
const OUTLINE_ID = "30000000-0000-4000-8000-00000000ab01";

function json(route: Route, body: unknown, rows = 1) {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    headers: { "content-range": `0-${Math.max(0, rows - 1)}/${rows}` },
    body: JSON.stringify(body),
  });
}

/** A tiny closed footprint plus a raw trace (plan-pixel polys + calibration)
 * — the shape a real tracer Submit already produces, so both the flat map
 * and the tracer's own "restore a stored trace" path have something to
 * work with. No windows: this spec is about the building record only. */
function buildingWithTrace(northDeg?: number) {
  return {
    width: 12, depth: 12, height: 3, rise: 0,
    footprints: [[{ x: -6, z: -6 }, { x: 6, z: -6 }, { x: 6, z: 6 }, { x: -6, z: 6 }]],
    ...(northDeg != null ? { northDeg } : {}),
    trace: {
      cal: { ax: 0, ay: 0, bx: 100, by: 0, value: 10, unit: "m" },
      polys: [[{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 400 }, { x: 0, y: 400 }]],
      dots: {},
    },
  };
}

/** Stateful project_plan_outlines mock: GET returns the current row, PATCH
 * merges the write into it (same shape Postgres would apply) and records
 * every payload written so the test can inspect it afterward. */
function mockOutline(
  page: import("@playwright/test").Page,
  initialFeatures: Record<string, unknown>,
  points: { x: number; y: number }[],
) {
  let row: Record<string, unknown> = {
    id: OUTLINE_ID,
    project_id: BLACK22.projectId,
    planset_id: null,
    page_number: 1,
    points,
    page_aspect: 1,
    features: initialFeatures,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
  const writes: Record<string, unknown>[] = [];
  return {
    writes,
    async install() {
      await page.route("**/rest/v1/project_plan_outlines**", async (route) => {
        const req = route.request();
        if (req.method() === "PATCH" || req.method() === "POST") {
          const body = (req.postDataJSON() ?? {}) as Record<string, unknown>;
          writes.push(body);
          row = { ...row, ...body };
          return json(route, row);
        }
        return json(route, [row]);
      });
    },
  };
}

test("setting north in the tracer rotates the mini-map's compass rose", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "supervisor" });
  const mock = mockOutline(
    page,
    { fitview: { model: { building: buildingWithTrace(), windows: [] } } },
    [{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.1 }, { x: 0.9, y: 0.9 }, { x: 0.1, y: 0.9 }],
  );
  await mock.install();

  await page.goto(`/projects/${BLACK22.projectId}/trace-model`);
  await expect(page.getByRole("heading", { name: "Trace 3D model" })).toBeVisible();

  const northBtn = page.locator('[data-mode="north"]');
  await expect(northBtn).toBeVisible({ timeout: 30_000 });
  // A footprint must be drawn (restored from the stored trace above) before
  // the north anchor has anywhere sane to sit.
  await expect(page.locator("#ol path")).not.toHaveCount(0, { timeout: 15_000 });
  await northBtn.click();

  const anchor = page.locator("[data-north-anchor]");
  await expect(anchor).toBeVisible();
  const box = (await anchor.boundingBox())!;
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;

  // Drag purely horizontally, right of the anchor's REAL rendered position —
  // scale/pan-agnostic, since a pure screen-space horizontal offset stays
  // horizontal in plan space too (no rotation between the two). That is
  // exactly bearingFromAnchor's "right = 90°" convention.
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 120, cy, { steps: 10 });
  await page.mouse.up();

  await page.getByRole("button", { name: "Submit" }).click();
  await expect(page).toHaveURL(/tab=maps-interactive/, { timeout: 15_000 });

  // The write carried northDeg through — close to 90°, the drag's own math.
  await expect.poll(() => mock.writes.length, { timeout: 15_000 }).toBeGreaterThan(0);
  const written = mock.writes[0].features as { fitview?: { northDeg?: number } };
  expect(written.fitview?.northDeg).toBeGreaterThan(75);
  expect(written.fitview?.northDeg).toBeLessThan(105);

  // And the mini-map now shows a real, rotated rose — not the faded
  // "north not set" one a fresh job would show.
  const rose = page.locator(".flat-minimap-rose");
  await expect(rose).toBeVisible({ timeout: 15_000 });
  await expect(rose).not.toHaveClass(/unset/);
  const nLabel = rose.locator("text").first();
  const nx = Number(await nLabel.getAttribute("x"));
  // Unrotated, "N" sits at x=26 (dead center); rotated ~90°, it moves to
  // roughly x=46 (roseLabels' own geometry — see fitviewRenderer.test.ts).
  expect(nx).toBeGreaterThan(35);
});

test("a Plan Model save then a trace re-submit both keep northDeg (the footgun regression, end to end)", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "supervisor" });
  const NORTH = 55;
  const mock = mockOutline(
    page,
    { fitview: { northDeg: NORTH, model: { building: buildingWithTrace(NORTH), windows: [] } } },
    [{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.1 }, { x: 0.9, y: 0.9 }, { x: 0.1, y: 0.9 }],
  );
  await mock.install();

  // --- Part 1: a plain Plan Model re-save must not wipe northDeg ---------
  await page.goto(`/projects/${BLACK22.projectId}?tab=maps-interactive&mapview=sheets`);
  // Sheets opens on "Original plan" (the raw PDF); the outline editor — and
  // its Edit button — lives under "Building outline".
  await page.getByRole("button", { name: "Building outline" }).click();
  const editBtn = page.getByRole("button", { name: "Edit model" });
  await expect(editBtn).toBeVisible({ timeout: 30_000 });
  await editBtn.click();

  const saveBtn = page.getByRole("button", { name: "Save outline" });
  await expect(saveBtn).toBeEnabled({ timeout: 15_000 });
  await saveBtn.click();

  await expect.poll(() => mock.writes.length, { timeout: 15_000 }).toBeGreaterThan(0);
  const afterPlanModel = mock.writes.at(-1)!.features as { fitview?: { northDeg?: number } };
  expect(afterPlanModel.fitview?.northDeg).toBe(NORTH);

  // --- Part 2: a trace re-submit right after must ALSO keep it -----------
  await page.goto(`/projects/${BLACK22.projectId}/trace-model`);
  await expect(page.getByRole("heading", { name: "Trace 3D model" })).toBeVisible();
  await expect(page.locator("#ol path")).not.toHaveCount(0, { timeout: 15_000 });

  const writesBefore = mock.writes.length;
  await page.getByRole("button", { name: "Submit" }).click();
  await expect(page).toHaveURL(/tab=maps-interactive/, { timeout: 15_000 });

  await expect.poll(() => mock.writes.length, { timeout: 15_000 }).toBeGreaterThan(writesBefore);
  const afterTrace = mock.writes.at(-1)!.features as { fitview?: { northDeg?: number } };
  expect(afterTrace.fitview?.northDeg).toBe(NORTH);
});
