// Does a dot land on the callout number it belongs to?
//
// This is the test that was missing. The map used to fan overlapping pins apart
// along their cluster's axis to keep a busy page countable, and on Black Desert
// every one of the 42 marks has a neighbour inside the spacing threshold — so
// all 42 were pushed the full cap, about a tenth of the sheet's width. Marks 1,
// 2 and 11 came to rest off the building entirely, out over the driveway. The
// readability harness next door was happy: the pins were beautifully spaced, and
// none of them were where the window was.
//
// So this checks the one thing that cannot be traded away. For every opening the
// database has placed, the centre of its dot must sit at pin_x / pin_y of the
// drawing, within a pixel or so. Checked on both views and at two zoom levels,
// because a wrong container, a stray border, a letterboxed page or a zoom
// transform applied to the sheet but not its pins all show up as exactly this.
//
// The error is also decomposed before it is asserted, so a failure names the
// shape of the bug rather than just its size:
//   offset  — every pin off by the same vector: wrong origin, padding, a border
//   scale   — error growing with distance from centre: wrong reference box
//   spread  — pins off by unrelated amounts: something is moving them one by one
//
// Coordinates come from the same committed production fixtures the readability
// harness uses, so "where it should be" is the real database value.

import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  jobFixtures,
  openingsFor,
  useSupabaseFixtures,
} from "./support/supabaseFixtures";

/**
 * How far a dot may sit from its coordinate, as a fraction of the drawing's
 * width. At 390px that is 1.2px — tight enough that the 0.117 the fan-out
 * introduced fails by a factor of 250, loose enough to absorb the half-pixel
 * rounding a browser does when it turns a percentage into a layout position.
 */
const TOLERANCE = 0.003;

interface Drawn {
  id: string;
  /** Centre of the dot, as a fraction of the drawing box. */
  x: number;
  y: number;
}

/**
 * Where every dot on this drawing actually is, measured off the page.
 *
 * Read from the drawing's own box rather than the viewport, so panning a zoomed
 * sheet cannot be mistaken for a misplaced pin, and taken from the dot's centre
 * rather than its top-left, because that is the point that has to be on the
 * number.
 */
async function drawnPins(sheet: Locator, pins: Locator): Promise<Drawn[]> {
  const box = await sheet.boundingBox();
  expect(box, "the drawing has no box to measure against").toBeTruthy();
  const raw = await pins.evaluateAll((nodes) =>
    nodes.map((node) => {
      const r = node.getBoundingClientRect();
      return {
        id: node.getAttribute("data-opening-id") ?? "",
        cx: r.left + r.width / 2,
        cy: r.top + r.height / 2,
      };
    }),
  );
  return raw.map((p) => ({
    id: p.id,
    x: (p.cx - box!.x) / box!.width,
    y: (p.cy - box!.y) / box!.height,
  }));
}

interface Error_ {
  mark: string;
  dx: number;
  dy: number;
  dist: number;
}

/** Median, so one bad pin cannot pass itself off as a systematic offset. */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
}

/**
 * Every placed opening's dot is on its coordinate. `where` names the view and
 * zoom so a failure says which picture was wrong.
 */
async function expectPinsOnTheirCoordinates(
  sheet: Locator,
  pins: Locator,
  projectId: string,
  where: string,
) {
  const stored = new Map(
    openingsFor(projectId)
      .filter((o) => o.pin_x !== null && o.pin_y !== null)
      .map((o) => [o.id, o]),
  );
  const drawn = await drawnPins(sheet, pins);

  const identified = drawn.filter((d) => d.id !== "");
  expect(
    identified.length,
    `${where}: pins are not carrying an opening id, so this cannot check them`,
  ).toBe(drawn.length);

  // Openings with no stored pin are auto-placed around the perimeter; there is
  // no coordinate to be right or wrong about, so they are not judged here.
  const checked = identified.filter((d) => stored.has(d.id));
  expect(
    checked.length,
    `${where}: none of the drawn pins matched a placed opening in the fixtures`,
  ).toBeGreaterThan(0);

  const errors: Error_[] = checked.map((d) => {
    const o = stored.get(d.id)!;
    const dx = d.x - o.pin_x!;
    const dy = d.y - o.pin_y!;
    return { mark: o.opening_code, dx, dy, dist: Math.hypot(dx, dy) };
  });

  /*
   * Is the whole set shifted, stretched, or scattered? Decomposed in that order,
   * because an offset masquerades as a scale error and both masquerade as noise.
   *
   * The scale term is the slope of error against distance from the middle of the
   * page: if the drawing is being mapped onto a box 5% too wide, a mark at the
   * edge is out by 2.5% and one in the centre is not out at all.
   */
  const offset = {
    x: median(errors.map((e) => e.dx)),
    y: median(errors.map((e) => e.dy)),
  };
  const slope = (axis: "x" | "y") => {
    const pairs = checked.map((d, i) => ({
      from: d[axis] - 0.5,
      err: (axis === "x" ? errors[i].dx : errors[i].dy) - offset[axis],
    }));
    const den = pairs.reduce((s, p) => s + p.from * p.from, 0);
    return den < 1e-9 ? 0 : pairs.reduce((s, p) => s + p.from * p.err, 0) / den;
  };
  const scale = { x: slope("x"), y: slope("y") };
  const residual = errors.map((e, i) =>
    Math.hypot(
      e.dx - offset.x - scale.x * (checked[i].x - 0.5),
      e.dy - offset.y - scale.y * (checked[i].y - 0.5),
    ),
  );
  const worst = [...errors].sort((a, b) => b.dist - a.dist);

  console.log(
    [
      `  ${where}`,
      `    marks checked      ${checked.length}`,
      `    worst error        ${worst[0].dist.toFixed(5)} of page width` +
        `  (mark ${worst[0].mark})`,
      `    median error       ${median(errors.map((e) => e.dist)).toFixed(5)}`,
      `    uniform offset     dx ${offset.x.toFixed(5)}, dy ${offset.y.toFixed(5)}`,
      `    scale error        x ${scale.x.toFixed(5)}, y ${scale.y.toFixed(5)}`,
      `    scatter after both ${median(residual).toFixed(5)} median`,
    ].join("\n"),
  );

  /*
   * Whichever term explains the most error wins, rather than testing them in a
   * fixed order — a 6% stretch also reads as a small offset, and reporting that
   * offset sends the next reader hunting for a padding that is not there. The
   * scale term is weighted by a typical distance from centre so the two are
   * compared in the same units.
   */
  const byOffset = Math.hypot(offset.x, offset.y);
  const byScale = Math.max(Math.abs(scale.x), Math.abs(scale.y)) * 0.25;
  const diagnosis =
    byScale > byOffset && byScale > TOLERANCE
      ? `The error grows with distance from the middle of the page ` +
        `(x ${scale.x.toFixed(4)}, y ${scale.y.toFixed(4)}), so the drawing is ` +
        `being mapped onto a box of the wrong size — a letterboxed page, an ` +
        `object-fit, or a zoom applied to the sheet but not to its pins.`
      : byOffset > TOLERANCE
        ? `Every mark is off by about the same amount (dx ${offset.x.toFixed(4)}, ` +
          `dy ${offset.y.toFixed(4)}), so this is one wrong origin — a padding, a ` +
          `border, or percentages measured against the wrong box — not 40 wrong ` +
          `coordinates.`
        : `The marks are off by unrelated amounts, so something is moving them ` +
          `one at a time rather than the drawing being mapped wrongly.`;

  expect(
    worst[0].dist,
    `${where}: mark ${worst[0].mark} is drawn ${worst[0].dist.toFixed(4)} of the ` +
      `sheet's width away from the coordinate stored for it ` +
      `(dx ${worst[0].dx.toFixed(4)}, dy ${worst[0].dy.toFixed(4)}). ` +
      `${diagnosis} ` +
      `The next worst are ${worst
        .slice(1, 6)
        .map((e) => `${e.mark} ${e.dist.toFixed(4)}`)
        .join(", ")}.`,
  ).toBeLessThan(TOLERANCE);
}

async function zoomTo(page: Page, clicks: number, expected: string) {
  for (let i = 0; i < clicks; i++) {
    await page.getByRole("button", { name: "Zoom in" }).first().click();
  }
  await expect(page.getByRole("button", { name: "Reset zoom" }).first()).toHaveText(
    expected,
  );
}

for (const job of jobFixtures()) {
  test(`${job.jobCode} marks land on their callouts`, async ({ page }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (e) => pageErrors.push(String(e)));
    await useSupabaseFixtures(page);
    // The bare /map route is a redirect now (picks 13); go straight to the
    // tab address it lands on rather than testing that hop here too.
    await page.goto(`/projects/${job.projectId}?tab=map`);
    console.log(`\n${job.jobCode}`);

    // --- The real architect's sheet, which is what the map opens on ---------
    const planSheet = page.locator(".plan-map--with-dots");
    await expect(planSheet.locator("img")).toBeVisible({ timeout: 150_000 });
    const planPins = planSheet.locator(".plan-dot");
    await expect
      .poll(async () => planPins.count(), { timeout: 60_000 })
      .toBeGreaterThan(0);
    await expectPinsOnTheirCoordinates(
      planSheet,
      planPins,
      job.projectId,
      "original plan at 100%",
    );

    // Zoomed in, where the sheet is wider than its viewport and has been panned.
    await zoomTo(page, 4, "200%");
    await page
      .locator(".plan-zoom-viewport")
      .first()
      .evaluate((el) => {
        el.scrollLeft = Math.min(el.scrollWidth - el.clientWidth, 120);
        el.scrollTop = Math.min(el.scrollHeight - el.clientHeight, 80);
      });
    await expectPinsOnTheirCoordinates(
      planSheet,
      planPins,
      job.projectId,
      "original plan at 200%, panned",
    );
    await page.getByRole("button", { name: "Reset zoom" }).first().click();

    // --- The derived building outline --------------------------------------
    await page.getByRole("button", { name: "Building outline" }).click();
    const status = page.locator(".cartoon-sheet__status");
    await expect
      .poll(async () => (await status.textContent())?.trim() ?? "", {
        timeout: 150_000,
      })
      .not.toBe("tracing plan…");
    const outlineSheet = page.locator(".plan-zoom-viewport--outline .cartoon-sheet");
    const outlinePins = outlineSheet.locator(".plan-dot");
    const outlineCount = await outlinePins.count();
    if (outlineCount === 0) {
      // Known and reported by the readability harness: this job's marks are on a
      // page the outline view cannot reach. Nothing to measure, and inventing a
      // pass here would be worse than saying so.
      console.log("  building outline: no marks on the page it opened — skipped");
    } else {
      await expectPinsOnTheirCoordinates(
        outlineSheet,
        outlinePins,
        job.projectId,
        "building outline at 100%",
      );
      await zoomTo(page, 4, "200%");
      await expectPinsOnTheirCoordinates(
        outlineSheet,
        outlinePins,
        job.projectId,
        "building outline at 200%",
      );
    }

    expect(pageErrors, "uncaught errors on the map page").toEqual([]);
  });
}
