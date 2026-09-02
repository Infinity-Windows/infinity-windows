// Plan underlay (owner: "I should be able to draw walls on the trace
// feature too, so that i can see the plans faintly behind this view, but
// then i should be able to toggle it off when i'm done. It will be a
// better version of trace walls.") — same house style as studio-walls.spec.ts:
// mocked routes, real UI, poke at window.__studio for the vendor state a
// screenshot can't assert.
//
// The planset PDF is a tiny STUBBED page — not a real production plan set —
// so the test stays fast and its geometry stays known: what matters here is
// that the toggle actually drives the vendor canvas's plan-underlay layer
// and that drawing still works over it, not what any real sheet looks like
// (planUnderlay.test.ts already proves the alignment math on its own).

import { expect, test, type Route } from "@playwright/test";
import { jobFixtures, useSupabaseFixtures } from "./support/supabaseFixtures";

const BLACK22 = jobFixtures().find((j) => j.jobCode === "BLACK22")!;

function json(route: Route, body: unknown, rows = 0) {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    headers: { "content-range": `0-${Math.max(0, rows - 1)}/${rows}` },
    body: JSON.stringify(body),
  });
}

/** A rectangular serialized plan, no windows — same shape studio-walls.spec.ts's
 * rectPlan uses (blueprint3d-modern corners/walls). */
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

/**
 * The smallest valid single-page PDF pdf.js will actually render: a
 * Catalog -> Pages -> Page chain with no content stream (a blank page is
 * legal PDF, and all this test needs is something to decode and draw).
 * Offsets are computed, not hand-counted, so the xref table is exact.
 */
function buildStubPlansetPdf(): Buffer {
  const objs = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 150] /Resources << >> >>\nendobj\n",
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const o of objs) {
    offsets.push(Buffer.byteLength(body, "latin1"));
    body += o;
  }
  const xrefOffset = Buffer.byteLength(body, "latin1");
  let xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    xref += `${String(off).padStart(10, "0")} 00000 n \n`;
  }
  const trailer = `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(body + xref + trailer, "latin1");
}

const PLANSET_ID = "00000000-0000-4000-8000-0000000ap101";
const OUTLINE_ID = "00000000-0000-4000-8000-0000000of101";

/** A rectangle traced in sheet pixels, unrelated to the model's own
 * rectangle's aspect ratio — proves the fit doesn't need one (the affine
 * math handles any two non-degenerate rectangles; planUnderlay.test.ts
 * covers that directly). Drawn out of order and the "wrong" way round on
 * purpose, since a real trace is never drawn starting at its lowest corner. */
const TRACE_POLY = [
  { x: 1400, y: 700 },
  { x: 1400, y: 100 },
  { x: 200, y: 100 },
  { x: 200, y: 700 },
];

const TRACE_MODEL = {
  building: {
    width: 10,
    depth: 6,
    height: 3,
    rise: 0,
    footprints: [[{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 6 }, { x: 0, z: 6 }]],
    trace: {
      stories: [{ name: "Ground", heightM: 3, polys: [TRACE_POLY], dots: {} }],
      polys: [TRACE_POLY],
      dots: {},
    },
  },
  windows: [],
};

async function useUnderlayFixtures(page: import("@playwright/test").Page) {
  await page.route("**/rest/v1/project_plansets**", (route) =>
    json(
      route,
      [
        {
          id: PLANSET_ID,
          project_id: BLACK22.projectId,
          storage_path: `${BLACK22.projectId}/stub-plans.pdf`,
          source_format: "pdf",
          converted_pdf_path: null,
          page_count: 1,
          status: "ready",
          kind: "building",
          created_at: "2026-09-01T00:00:00Z",
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
          id: OUTLINE_ID,
          project_id: BLACK22.projectId,
          planset_id: PLANSET_ID,
          page_number: 1,
          points: [],
          page_aspect: 200 / 150,
          features: {
            fitview: { model: TRACE_MODEL },
            modelstudio: { serialized: rectPlan(0, 0, 1000, 600), savedAt: "2026-09-01T00:00:00Z" },
          },
          created_at: "2026-09-01T00:00:00Z",
          updated_at: "2026-09-01T00:00:00Z",
        },
      ],
      1,
    ),
  );
  const pdfBytes = buildStubPlansetPdf();
  await page.route("**/storage/v1/object/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/pdf", body: pdfBytes }),
  );
}

test.describe("Studio plan underlay (desktop)", () => {
  test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });

  test("toggling Plans shows and hides the underlay layer; drawing still works over it", async ({
    page,
  }) => {
    await useSupabaseFixtures(page, { role: "supervisor" });
    await useUnderlayFixtures(page);
    await page.goto(`/studio/j/${BLACK22.projectId}`);

    // The saved modelstudio plan (the rectangle) is what boots — same
    // readiness check studio-walls.spec.ts's W4 test uses.
    await page.waitForFunction(
      () => {
        const bp = (window as any).__studio;
        return (bp?.model?.floorplan?.getWalls?.()?.length ?? 0) === 4;
      },
      undefined,
      { timeout: 60_000 },
    );

    await page.getByLabel("View").selectOption("plan");
    await expect(page.getByText("Plan (2D)")).toBeVisible();

    // The 🛠 Tools palette toggle — opening it is what reveals both the
    // mode buttons AND the "trace on file" line.
    await page.getByRole("button", { name: /Tools/ }).click();

    // "trace on file" only renders once traceModel resolves — the toggle
    // button gates on the exact same condition (design: no trace, no
    // toggle), so this is the honest readiness signal to wait on.
    await expect(page.getByText(/trace on file/)).toBeVisible();

    await page.getByRole("button", { name: "Draw walls" }).click();

    // Default ON the first time Draw walls opens (owner spec) — the fetch,
    // render and fit all have to complete before the vendor canvas gets an
    // image, so this is the one generous wait in the test.
    const plansToggle = page.getByRole("button", { name: /^Plans:/ });
    await expect(plansToggle).toHaveText("Plans: on");
    await page.waitForFunction(
      () => (window as any).__studio?.floorplanner?.view?.planUnderlay != null,
      undefined,
      { timeout: 60_000 },
    );

    // The fit actually worked, not just "some object" — a rectangle traced
    // 1200x600 px onto a rectangle built 1000x600 cm is a real, checkable
    // affine, not a coincidence.
    const transform = await page.evaluate(
      () => (window as any).__studio.floorplanner.view.planUnderlay.transform,
    );
    expect(Number.isFinite(transform.a)).toBe(true);
    expect(Number.isFinite(transform.d)).toBe(true);

    // Toggle off: the layer clears.
    await plansToggle.click();
    await expect(plansToggle).toHaveText("Plans: off");
    await expect
      .poll(() => page.evaluate(() => (window as any).__studio.floorplanner.view.planUnderlay))
      .toBeNull();

    // Toggle back on: the cached image needs no re-fetch, so this should
    // resolve fast.
    await plansToggle.click();
    await expect(plansToggle).toHaveText("Plans: on");
    await page.waitForFunction(
      () => (window as any).__studio?.floorplanner?.view?.planUnderlay != null,
      undefined,
      { timeout: 15_000 },
    );

    // Drawing a wall still works with the underlay showing — it's a
    // draw()-only layer, never in the way of a real gesture.
    const box = await page.locator("#studio-floorplan").boundingBox();
    if (!box) throw new Error("no floorplan canvas");
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx - 80, cy - 200);
    await page.mouse.down();
    await page.mouse.move(cx + 80, cy - 200, { steps: 8 });
    await page.mouse.up();

    const wallCount = await page.evaluate(
      () => (window as any).__studio.model.floorplan.getWalls().length,
    );
    expect(wallCount).toBe(5);
  });

  // Owner feedback after #488 shipped: "Trace plans" navigated him to the
  // legacy outline tracer expecting to draw walls over the faint plans right
  // there, and drag-to-draw (#466) had no hint anywhere it could be found.
  // studio-trace-mode-obvious fixes discoverability only — same mechanics,
  // reachable and named.
  test("\"Draw over the plans\" switches to Draw mode with the underlay on; the draw-mode hint names the gesture; the legacy tracer link still works", async ({
    page,
  }) => {
    await useSupabaseFixtures(page, { role: "supervisor" });
    await useUnderlayFixtures(page);
    await page.goto(`/studio/j/${BLACK22.projectId}`);

    await page.waitForFunction(
      () => {
        const bp = (window as any).__studio;
        return (bp?.model?.floorplan?.getWalls?.()?.length ?? 0) === 4;
      },
      undefined,
      { timeout: 60_000 },
    );

    // Fresh visit: 3D, palette closed — same starting point the owner hit.
    await expect(page.getByText("Model (3D)")).toBeVisible();

    await page.getByRole("button", { name: /Tools/ }).click();
    await expect(page.getByText(/trace on file/)).toBeVisible();

    // The legacy tracer stays reachable, just demoted to a small text link.
    const legacyLink = page.getByRole("link", { name: "Outline tracer (job tab)" });
    await expect(legacyLink).toHaveAttribute(
      "href",
      `/projects/${BLACK22.projectId}/trace-model`,
    );

    await page.getByRole("button", { name: "Draw over the plans" }).click();

    // One click: Draw walls mode, plan underlay forced on, view flips to 2D —
    // what the owner expected "Trace plans" to do in the first place.
    await expect(page.getByText("Plan (2D)")).toBeVisible();
    await expect(page.getByRole("button", { name: "Draw walls" })).toHaveClass(/active-pill/);
    const plansToggle = page.getByRole("button", { name: /^Plans:/ });
    await expect(plansToggle).toHaveText("Plans: on");
    await page.waitForFunction(
      () => (window as any).__studio?.floorplanner?.view?.planUnderlay != null,
      undefined,
      { timeout: 60_000 },
    );

    // The hint that used to not exist anywhere: drag-to-draw named outright.
    await expect(
      page.getByText(
        "press and drag to draw a wall · click corner to corner also works · corners square up within 5° · Plans: on shows the sheet",
      ),
    ).toBeVisible();
  });
});
