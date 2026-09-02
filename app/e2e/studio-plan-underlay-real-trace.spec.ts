// Plan underlay, real data (owner bug report, Mad Moose, 2026-09-01):
// "Plans: on" but nothing draws under the 2D canvas — bare model rectangle
// on a blank cream canvas, not even a faint sheet.
//
// studio-plan-underlay.spec.ts (#488) proves the toggle drives the vendor
// canvas at all, but its planset is a synthetic single-page PDF and its
// trace is a clean 4-point square — neither looks like a real building.
// This spec replays Mad Moose's ACTUAL outline row (features.fitview.model,
// captured live — see app/e2e/fixtures/madmoose-outline.json) against its
// ACTUAL 4-page planset (docs/backups/.../08c60cce-.../1788206016569-MMV2_-
// _LP.pdf, kind "building", page 1 = FLOOR PLAN - 1ST). The two things the
// synthetic fixture couldn't exercise:
//   - The Ground story's trace has TWO polys — the exterior rectangle and a
//     5-point interior partition — while the seeded Studio floor is a bare
//     one-mass rectangle. Real buildings have rooms; the synthetic trace
//     never did.
//   - The real PDF is a genuine multi-page architectural sheet pdf.js has
//     to decode and page-detect sheet titles on, not a blank stub page.
//
// Reuses BLACK22's already-wired project (openings/specs/profile routes)
// and overrides only project_plansets + project_plan_outlines — the exact
// pattern studio-plan-underlay.spec.ts's useUnderlayFixtures uses — so the
// only thing that's different from a real Model Studio visit is which rows
// come back for those two tables. The storage route mock is the DEFAULT one
// useSupabaseFixtures already installs (reads docs/backups/…/plansets/<path
// >): nothing to override there as long as the real PDF sits at the path
// the fixture planset row names.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Route } from "@playwright/test";
import { jobFixtures, useSupabaseFixtures } from "./support/supabaseFixtures";

const HERE = dirname(fileURLToPath(import.meta.url));
const BLACK22 = jobFixtures().find((j) => j.jobCode === "BLACK22")!;

function json(route: Route, body: unknown, rows = 0) {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    headers: { "content-range": `0-${Math.max(0, rows - 1)}/${rows}` },
    body: JSON.stringify(body),
  });
}

interface MadMooseRow {
  id: string;
  points: { x: number; y: number }[];
  features: unknown;
}

const [MADMOOSE]: MadMooseRow[] = JSON.parse(
  readFileSync(join(HERE, "fixtures/madmoose-outline.json"), "utf8"),
);

const PLANSET_ID = "38c9637c-da62-4d8f-969b-61e831c96dca"; // real Mad Moose planset id
// Real Mad Moose storage path — the backup this test's storage route mock
// (the DEFAULT one useSupabaseFixtures installs) serves from disk.
const STORAGE_PATH = "08c60cce-29f6-4b52-bd0c-2bc2c02a79a9/1788206016569-MMV2_-_LP.pdf";
// pdfinfo on the real sheet: all 4 pages are 2592x1728pt.
const PAGE_ASPECT = 2592 / 1728;

async function useMadMooseFixtures(
  page: import("@playwright/test").Page,
  opts: { storagePath?: string } = {},
) {
  await page.route("**/rest/v1/project_plansets**", (route) =>
    json(
      route,
      [
        {
          id: PLANSET_ID,
          project_id: BLACK22.projectId,
          storage_path: opts.storagePath ?? STORAGE_PATH,
          source_format: "pdf",
          converted_pdf_path: null,
          page_count: 4,
          status: "ready",
          kind: "building",
          created_at: "2026-06-29T00:00:00Z",
        },
      ],
      1,
    ),
  );
  await page.route("**/rest/v1/project_plan_outlines**", (route) =>
    json(
      route,
      [
        {
          id: MADMOOSE.id,
          project_id: BLACK22.projectId,
          planset_id: PLANSET_ID,
          page_number: 1,
          points: MADMOOSE.points,
          page_aspect: PAGE_ASPECT,
          features: MADMOOSE.features,
          created_at: "2026-06-29T00:00:00Z",
          updated_at: "2026-07-28T00:00:00Z",
        },
      ],
      1,
    ),
  );
}

/** Sum of every RGB byte on the floorplan canvas — cheap way to tell "the
 * plan-underlay draw call changed what's on screen" from "it didn't",
 * without predicting exact pixel colors on a real scanned/vector sheet. */
async function canvasChecksum(page: import("@playwright/test").Page): Promise<number> {
  return page.evaluate(() => {
    const canvas = document.getElementById("studio-floorplan") as HTMLCanvasElement;
    const ctx = canvas.getContext("2d")!;
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) sum += data[i] + data[i + 1] + data[i + 2];
    return sum;
  });
}

test.describe("Studio plan underlay, real Mad Moose trace (desktop)", () => {
  test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });

  test("the real trace's exterior ring fits and paints under the real plan sheet", async ({
    page,
  }) => {
    // Owner role: this is the owner's own bug report, on the owner's job.
    await useSupabaseFixtures(page, { role: "owner" });
    await useMadMooseFixtures(page);
    await page.goto(`/studio/j/${BLACK22.projectId}`);

    // The saved Mad Moose modelstudio model boots: ONE floor, a bare
    // rectangle (4 corners, 4 walls) — same readiness signal #488's own
    // spec uses.
    await page.waitForFunction(
      () => {
        const bp = (window as any).__studio;
        return (bp?.model?.floorplan?.getWalls?.()?.length ?? 0) === 4;
      },
      undefined,
      { timeout: 60_000 },
    );

    // Exact match: the owner role also renders a "View as a specific
    // person" select, which "View" alone matches too.
    await page.getByLabel("View", { exact: true }).selectOption("plan");
    await expect(page.getByText("Plan (2D)")).toBeVisible();

    await page.getByRole("button", { name: /Tools/ }).click();
    // Gates on traceModel resolving — the trace on this job carries stories
    // with no page number or title recorded, which is real: Mad Moose's
    // trace predates page-title detection, and the code has to re-detect
    // "FLOOR PLAN - 1ST" itself from the CURRENT render rather than trust a
    // stored value.
    await expect(page.getByText(/trace on file/)).toBeVisible();

    await page.getByRole("button", { name: "Draw walls" }).click();

    const plansToggle = page.getByRole("button", { name: /^Plans:/ });
    await expect(plansToggle).toHaveText("Plans: on");

    // Fetching + decoding a real 10MB, 4-page architectural PDF through
    // pdf.js is the dominant cost here, not the bug itself — generous but
    // bounded, same order as job-map.spec.ts's real-planset waits.
    const gotUnderlay = await page
      .waitForFunction(
        () => (window as any).__studio?.floorplanner?.view?.planUnderlay != null,
        undefined,
        { timeout: 90_000 },
      )
      .then(() => true)
      .catch(() => false);

    expect(
      gotUnderlay,
      "Plans: on, but window.__studio.floorplanner.view.planUnderlay stayed null for " +
        "the real Mad Moose trace — the owner's exact symptom (bare model rectangle, " +
        "no sheet, not even faint) reproduces here.",
    ).toBe(true);

    // Not just "some object" — a real, finite affine.
    const transform = await page.evaluate(
      () => (window as any).__studio.floorplanner.view.planUnderlay.transform,
    );
    for (const k of ["a", "b", "c", "d", "tx", "ty"] as const) {
      expect(Number.isFinite(transform[k]), `transform.${k} is finite`).toBe(true);
    }

    // The fit didn't just avoid NaN — it landed the sheet somewhere the
    // canvas can actually show. Map the plan image's four corners through
    // the SAME two-stage transform floorplanner_view.ts's drawPlanUnderlay
    // uses (image px -> plan cm via the affine, plan cm -> screen px via
    // the viewmodel) and check that box overlaps the visible canvas — a
    // degenerate or off-canvas fit (leading suspect #2) would land it
    // entirely outside these bounds even with every transform field finite.
    const bounds = await page.evaluate(() => {
      const bp = (window as any).__studio;
      const fp = bp.floorplanner;
      const u = fp.view.planUnderlay;
      const t = u.transform;
      // floorplanner_view.ts's drawPlanUnderlay calls convertX/convertY on
      // "viewmodel" — which is the Floorplanner instance itself (`fp`), the
      // second constructor arg FloorplannerView stores under that name; the
      // methods live directly on `fp`, not on some nested `fp.viewmodel`.
      const corners = [
        { x: 0, y: 0 },
        { x: u.image.naturalWidth, y: 0 },
        { x: u.image.naturalWidth, y: u.image.naturalHeight },
        { x: 0, y: u.image.naturalHeight },
      ].map((p) => {
        const cmX = t.a * p.x + t.b * p.y + t.tx;
        const cmY = t.c * p.x + t.d * p.y + t.ty;
        return { x: fp.convertX(cmX), y: fp.convertY(cmY) };
      });
      const canvas = document.getElementById("studio-floorplan") as HTMLCanvasElement;
      return {
        minX: Math.min(...corners.map((p) => p.x)),
        maxX: Math.max(...corners.map((p) => p.x)),
        minY: Math.min(...corners.map((p) => p.y)),
        maxY: Math.max(...corners.map((p) => p.y)),
        canvasW: canvas.width,
        canvasH: canvas.height,
      };
    });
    expect(bounds.maxX, "drawn image is entirely left of the canvas").toBeGreaterThan(0);
    expect(bounds.minX, "drawn image is entirely right of the canvas").toBeLessThan(
      bounds.canvasW,
    );
    expect(bounds.maxY, "drawn image is entirely above the canvas").toBeGreaterThan(0);
    expect(bounds.minY, "drawn image is entirely below the canvas").toBeLessThan(
      bounds.canvasH,
    );

    // Painted pixels, not just computed state: toggling the layer off then
    // back on at the SAME pan/zoom has to actually change what's on the
    // canvas. This is what would catch a transform that "fit" but drew at
    // opacity too low to read, or an image that never finished decoding.
    const withPlan = await canvasChecksum(page);
    await plansToggle.click();
    await expect(plansToggle).toHaveText("Plans: off");
    await expect
      .poll(() => page.evaluate(() => (window as any).__studio.floorplanner.view.planUnderlay))
      .toBeNull();
    const withoutPlan = await canvasChecksum(page);
    expect(
      Math.abs(withPlan - withoutPlan),
      "the canvas pixels are identical with the plan layer on vs off — nothing actually painted",
    ).toBeGreaterThan(1000);
  });

  test("says so honestly when the plan sheet can't be fetched, instead of drawing nothing silently", async ({
    page,
  }) => {
    // Same real trace, but the planset row points at a storage path with
    // nothing behind it — useSupabaseFixtures' default storage route 404s
    // anything it can't find on disk, same as a real fetch failure would.
    // Degrade-with-honesty (house style): the toggle used to just stay
    // "Plans: on" over a blank canvas with no signal anything had gone
    // wrong — that IS the bug on Mad Moose, independent of the fit math.
    await useSupabaseFixtures(page, { role: "owner" });
    await useMadMooseFixtures(page, {
      storagePath: "08c60cce-29f6-4b52-bd0c-2bc2c02a79a9/does-not-exist.pdf",
    });
    await page.goto(`/studio/j/${BLACK22.projectId}`);

    await page.waitForFunction(
      () => {
        const bp = (window as any).__studio;
        return (bp?.model?.floorplan?.getWalls?.()?.length ?? 0) === 4;
      },
      undefined,
      { timeout: 60_000 },
    );

    await page.getByLabel("View", { exact: true }).selectOption("plan");
    await page.getByRole("button", { name: /Tools/ }).click();
    await expect(page.getByText(/trace on file/)).toBeVisible();
    await page.getByRole("button", { name: "Draw walls" }).click();

    const plansToggle = page.getByRole("button", { name: /^Plans:/ });
    await expect(plansToggle).toHaveText("Plans: unavailable", { timeout: 30_000 });
    await expect(page.getByText("the plan sheet failed to load")).toBeVisible();

    // Never silently draws — the vendor canvas's layer stays null the
    // whole time, exactly like the real bug looked from the outside.
    const underlay = await page.evaluate(
      () => (window as any).__studio.floorplanner.view.planUnderlay,
    );
    expect(underlay).toBeNull();
  });
});
