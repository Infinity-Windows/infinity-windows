// Is the redesigned job map readable on a phone?
//
// Three real jobs, at 390 px, with their real pin geometry:
//   BLACK22   42 marks on one sheet — the crowded case
//   PECAN14   two sheets, 57 and 48 marks — the crowded case, twice
//   OAKRIDGE  3 marks — the sparse case, where nothing should look broken
//
// The test measures the thing a screenshot cannot argue about: how badly pins
// sit on top of each other. Two pins "badly overlap" when the smaller of the two
// is more than half buried, i.e. their centres are closer than half its
// diameter. A page of perfectly stacked pins scores 1.0 on both numbers below,
// so neither threshold is vacuous.
//
// It also refuses to pass on an empty picture. The pin count has to match a real
// page of the job, and when the drawing is the derived building outline the
// footprint path has to exist and the header has to name where the shape came
// from. A blank sheet fails loudly instead of scoring a perfect zero overlap.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator } from "@playwright/test";
import {
  buildingPlansetFor,
  jobFixtures,
  plansetPdfPath,
  useSupabaseFixtures,
  type JobFixture,
} from "./support/supabaseFixtures";

const SHOTS = join(dirname(fileURLToPath(import.meta.url)), "__screenshots__");

/**
 * Share of ALL pin pairs allowed to badly overlap. Stacked pins score 1.0.
 */
const MAX_BAD_PAIR_FRACTION = 0.02;
/**
 * Share of pins allowed to be in any bad overlap. This is the number a crew
 * would feel: 1.0 means every mark is buried, 0 means every mark is countable.
 */
const MAX_PINS_INVOLVED_FRACTION = 0.5;

/** What the outline header may say. "tracing plan…" means it never finished. */
const GOOD_FOOTPRINT_LABELS = [
  "traced by hand",
  "outline from CAD",
  "basic outline",
];

interface PinBox {
  cx: number;
  cy: number;
  /** Diameter of the DRAWN dot, not the (larger) tap target. */
  d: number;
  quiet: boolean;
}

interface WallOpenings {
  /** Marks drawn as a gap in a wall rather than a free-floating dot. */
  snapped: number;
  doors: number;
}

interface Overlap {
  pins: number;
  pairs: number;
  badPairs: number;
  badPairFraction: number;
  pinsInvolved: number;
  pinsInvolvedFraction: number;
  medianNearestGap: number;
  labelled: number;
}

/**
 * What happens when every mark number is switched on at once.
 *
 * The number is the only thing telling two pins apart while every opening in
 * the company is `planned`, so how many of them a page can carry before they
 * pile into each other decides where the auto-hide threshold belongs. Labels
 * are text boxes, so unlike the round pins they are measured as rectangles.
 */
interface LabelFit {
  labels: number;
  collidingPairs: number;
  labelsTouching: number;
  labelsTouchingFraction: number;
  /**
   * Labels with a quarter or more of their ink covered by another label. This
   * is the number that decides the threshold: two numbers brushing corners are
   * still both readable, one buried under a quarter of another number is not.
   */
  labelsBuried: number;
  labelsBuriedFraction: number;
  /** Marks per 100_000 px² of drawing, so two differently sized jobs compare. */
  density: number;
  drawingArea: number;
  labelW: number;
  labelH: number;
}

/**
 * Two circles of diameter d1, d2 whose centres are `s` apart overlap by
 * (d1 + d2) / 2 − s. "More than half a pin diameter" is judged against the
 * SMALLER pin, which is the one with less room to give.
 */
function measureOverlap(boxes: PinBox[]): Overlap {
  const involved = new Set<number>();
  const nearest = boxes.map(() => Number.POSITIVE_INFINITY);
  let badPairs = 0;
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      const centres = Math.hypot(a.cx - b.cx, a.cy - b.cy);
      const gap = centres - (a.d + b.d) / 2;
      if (gap < nearest[i]) nearest[i] = gap;
      if (gap < nearest[j]) nearest[j] = gap;
      if (-gap > Math.min(a.d, b.d) / 2) {
        badPairs++;
        involved.add(i);
        involved.add(j);
      }
    }
  }
  const pairs = (boxes.length * (boxes.length - 1)) / 2;
  const sortedGaps = [...nearest].sort((x, y) => x - y);
  return {
    pins: boxes.length,
    pairs,
    badPairs,
    badPairFraction: pairs === 0 ? 1 : badPairs / pairs,
    pinsInvolved: involved.size,
    pinsInvolvedFraction: boxes.length === 0 ? 1 : involved.size / boxes.length,
    medianNearestGap: sortedGaps.length
      ? sortedGaps[Math.floor(sortedGaps.length / 2)]
      : 0,
    labelled: boxes.filter((b) => !b.quiet).length,
  };
}

/**
 * Two labels collide when their boxes touch. A 1 px cushion counts as touching:
 * two numbers with no daylight between them read as one longer number.
 */
function measureLabelFit(
  boxes: { x: number; y: number; w: number; h: number }[],
  drawingArea: number,
): LabelFit {
  const PAD = 1;
  const BURIED = 0.25;
  const touching = new Set<number>();
  const buried = new Set<number>();
  let collidingPairs = 0;
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      const overlapW = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const overlapH = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (overlapW + PAD <= 0 || overlapH + PAD <= 0) continue;
      collidingPairs++;
      touching.add(i);
      touching.add(j);
      const covered = Math.max(0, overlapW) * Math.max(0, overlapH);
      if (covered >= BURIED * a.w * a.h) buried.add(i);
      if (covered >= BURIED * b.w * b.h) buried.add(j);
    }
  }
  const median = (values: number[]) =>
    values.length ? [...values].sort((x, y) => x - y)[values.length >> 1] : 0;
  const share = (n: number) => (boxes.length === 0 ? 0 : n / boxes.length);
  return {
    labels: boxes.length,
    collidingPairs,
    labelsTouching: touching.size,
    labelsTouchingFraction: share(touching.size),
    labelsBuried: buried.size,
    labelsBuriedFraction: share(buried.size),
    density: drawingArea === 0 ? 0 : (boxes.length * 100_000) / drawingArea,
    drawingArea,
    labelW: median(boxes.map((b) => b.w)),
    labelH: median(boxes.map((b) => b.h)),
  };
}

async function labelBoxes(marks: Locator) {
  return marks.evaluateAll((nodes) =>
    nodes.map((node) => {
      const rect = node.getBoundingClientRect();
      return { x: rect.left, y: rect.top, w: rect.width, h: rect.height };
    }),
  );
}

async function pinBoxes(pins: Locator): Promise<PinBox[]> {
  return pins.evaluateAll((nodes) =>
    nodes.map((node) => {
      const rect = node.getBoundingClientRect();
      const quiet = node.classList.contains("plan-dot--quiet");
      // A quiet pin keeps its full tap target but draws a smaller dot inside it,
      // so measure the ink that was actually drawn — the ::before box — rather
      // than assume a ratio that some later change could quietly falsify.
      // Measuring the tap target would invent overlap the eye cannot see.
      //
      // Its ring counts as ink, and getComputedStyle reports a content box, so
      // the border has to be added back. Leaving it off shrank every dot by 4px
      // on paper and made this whole page look 40% less crowded than it is.
      const ink = quiet
        ? (() => {
            const style = getComputedStyle(node, "::before");
            const px = (v: string) => Number.parseFloat(v) || 0;
            return (
              px(style.width) +
              px(style.borderLeftWidth) +
              px(style.borderRightWidth)
            );
          })()
        : Number.NaN;
      return {
        cx: rect.left + rect.width / 2,
        cy: rect.top + rect.height / 2,
        d: Number.isFinite(ink) && ink > 0 ? ink : rect.width,
        quiet,
      };
    }),
  );
}

/** Wait until the pin count stops changing (and is not zero, if required). */
async function settledPinCount(pins: Locator, requireSome: boolean) {
  let previous = -1;
  await expect
    .poll(
      async () => {
        const n = await pins.count();
        const settled = n === previous && (n > 0 || !requireSome);
        previous = n;
        return settled;
      },
      { timeout: 60_000, intervals: [500, 500, 750, 1000, 1500] },
    )
    .toBe(true);
  return previous;
}

/** Which pages of this job could the drawing legitimately be showing? */
function plausiblePages(job: JobFixture) {
  return [...job.marksByPage.entries()].map(([pageNumber, marks]) => ({
    pageNumber,
    marks,
    // Unpinned marks are auto-placed around the perimeter on every page.
    expected: marks + job.unpinned,
  }));
}

const measured: Record<
  string,
  Overlap & WallOpenings & { page: number; view: string; note?: string }
> = {};
const labelFits: Record<string, LabelFit & { page: number }> = {};

for (const job of jobFixtures()) {
  test(`${job.jobCode} job map is readable at 390px`, async ({ page }) => {
    const planset = buildingPlansetFor(job.projectId);
    expect(
      plansetPdfPath(planset),
      `The real planset PDF for ${job.jobCode} is missing from the storage ` +
        `backup (${planset.storage_path}). Without it the map cannot work out ` +
        `which pages are floor plans, and PECAN14 in particular would open on ` +
        `a page with no marks. Restore docs/backups/ before trusting this run.`,
    ).not.toBeNull();

    const { unmatched, missingStorage } = await useSupabaseFixtures(page);
    const pageErrors: string[] = [];
    page.on("pageerror", (e) => pageErrors.push(String(e)));

    await page.goto(`/projects/${job.projectId}/map`);

    // The drawing is done once the planset has been read and the footprint
    // resolved; "tracing plan…" is the in-between state.
    const status = page.locator(".cartoon-sheet__status");
    await expect(status).toBeVisible();
    await expect
      .poll(async () => (await status.textContent())?.trim() ?? "", {
        timeout: 150_000,
        message: `${job.jobCode}: the sheet header never settled on a shape source`,
      })
      .not.toBe("tracing plan…");

    let view = "Building outline";
    let note: string | undefined;
    let sheet = page.locator(".plan-sheet--cad");
    let pins = page.locator(".cartoon-sheet .plan-dot");
    /*
     * A mark on this drawing is either an opening cut into a wall or, where
     * there is no wall to cut, a pin. Counting only pins used to be enough;
     * now that every mark that can be an opening is one, a page of 42 openings
     * and no pins is the normal case, not an empty page.
     */
    let marks = page.locator(
      ".cartoon-sheet .plan-dot, .cartoon-sheet [data-wall-opening]",
    );
    await settledPinCount(marks, false);

    if ((await marks.count()) === 0) {
      // Loud on purpose. The outline view opens on the planset's first detected
      // floor sheet; this job's marks are recorded against a different page, so
      // the derived building is drawn with nothing on it and there is no page
      // control to reach the marks. Fall back to the original-plan view, which
      // pages by the sheets that actually carry pins, so the sparse case is
      // still measured on real geometry rather than reported as a clean zero.
      note =
        "outline view opened on a floor sheet with no marks — measured on the " +
        "original-plan view instead";
      console.warn(
        `\n!! ${job.jobCode}: the BUILDING OUTLINE view rendered 0 pins.\n` +
          `   Its marks are on page ${[...job.marksByPage.keys()].join(", ")}, ` +
          `but the planset's detected floor sheets are elsewhere and the page\n` +
          `   switcher cannot reach them. Falling back to "Original plan".\n`,
      );
      await page.getByRole("button", { name: "Original plan" }).click();
      view = "Original plan";
      sheet = page.locator(".plan-sheet").first();
      pins = page.locator(".plan-map--with-dots .plan-dot");
      marks = pins;
      await expect(page.locator(".plan-map--with-dots img")).toBeVisible();
      await settledPinCount(marks, true);
    } else {
      const headerText = (await status.textContent())?.trim() ?? "";
      expect(headerText).not.toContain("outline unavailable");
      expect(
        GOOD_FOOTPRINT_LABELS,
        `${job.jobCode}: header says "${headerText}"`,
      ).toContain(headerText);

      // The building itself. Without this the pins float on nothing.
      const outlinePaths = page.locator(".cartoon-sheet svg path");
      expect(
        await outlinePaths.count(),
        `${job.jobCode}: no building outline path was drawn`,
      ).toBeGreaterThan(0);
      expect(
        await outlinePaths.first().getAttribute("d"),
        `${job.jobCode}: the outline path has no geometry`,
      ).toMatch(/^M\s*[\d.-]/i);

      /*
       * The outline opens enlarged so openings are not crushed into the phone
       * width. The drawing must be wider than its scroll viewport, zoom must
       * change that size, and the viewport must be able to pan.
       */
      const zoomViewport = page.locator(".plan-zoom-viewport--outline");
      const outlineSheet = page.locator(
        ".plan-zoom-viewport--outline .cartoon-sheet",
      );
      await expect(zoomViewport).toBeVisible();
      const startZoom = await outlineSheet.getAttribute("data-outline-zoom");
      expect(
        Number(startZoom),
        `${job.jobCode}: outline should open enlarged (200%)`,
      ).toBeGreaterThan(1);
      const viewportBox = await zoomViewport.boundingBox();
      const sheetBox = await outlineSheet.boundingBox();
      expect(viewportBox, `${job.jobCode}: missing outline viewport`).toBeTruthy();
      expect(sheetBox, `${job.jobCode}: missing outline sheet`).toBeTruthy();
      expect(
        (sheetBox?.width ?? 0) / (viewportBox?.width ?? 1),
        `${job.jobCode}: drawing should overflow its viewport at the default zoom`,
      ).toBeGreaterThan(1.4);

      const zoomLabel = page.getByRole("button", { name: "Reset zoom" });
      await expect(zoomLabel).toHaveText("200%");
      await page.getByRole("button", { name: "Zoom in" }).click();
      await expect(zoomLabel).toHaveText("225%");
      await expect
        .poll(async () => {
          const next = await outlineSheet.boundingBox();
          return next?.width ?? 0;
        })
        .toBeGreaterThan((sheetBox?.width ?? 0) * 1.05);

      // Pan: scroll the viewport so the sheet moves under it.
      const beforeScroll = await zoomViewport.evaluate((el) => el.scrollLeft);
      await zoomViewport.evaluate((el) => {
        el.scrollLeft = Math.min(el.scrollWidth - el.clientWidth, 80);
      });
      const afterScroll = await zoomViewport.evaluate((el) => el.scrollLeft);
      expect(
        afterScroll,
        `${job.jobCode}: outline viewport should pan horizontally`,
      ).toBeGreaterThan(beforeScroll);

      // Openings stay interactive after zoom/pan — tap one and its row links.
      const firstOpening = page.locator("[data-wall-opening]").first();
      if ((await firstOpening.count()) > 0) {
        await firstOpening.click({ force: true });
        await expect(
          page.locator(".find-row--linked").first(),
          `${job.jobCode}: tapping an opening after zoom/pan did not select it`,
        ).toBeVisible({ timeout: 5_000 });
      }

      // Put zoom back so the later screenshots match the default enlarged view.
      await zoomLabel.click();
      await expect(zoomLabel).toHaveText("200%");
    }

    const rendered = await marks.count();
    const pages = plausiblePages(job);
    const matched = pages.find((p) => rendered === p.expected);
    expect(
      matched,
      `${job.jobCode}: rendered ${rendered} marks, which matches no page of this ` +
        `job (${pages
          .map((p) => `page ${p.pageNumber}: ${p.marks} marks + ${job.unpinned} unpinned`)
          .join("; ")}). A screenshot of the wrong page is worse than none.`,
    ).toBeDefined();

    const overlap = measureOverlap(await pinBoxes(pins));
    // Every mark that has a building to sit on should be an opening in it: a
    // window in the middle of a room is not a thing. Free pins are what is left
    // when there is no wall at all, so this is a target, not just a reading.
    const openings = page.locator("[data-wall-opening]");
    const snapped = await openings.count();
    const doors = await page
      .locator('[data-wall-opening][data-opening-kind="door"]')
      .count();
    if (view === "Building outline") {
      expect(
        snapped,
        `${job.jobCode}: ${rendered - snapped} of ${rendered} marks are drawn ` +
          `as dots floating inside the building instead of openings in its walls`,
      ).toBe(rendered);
    }
    /*
     * Two openings that overlap have merged into one hole. Checked from the
     * attributes the wall layer stamps on each opening — screen boxes of gap
     * lines are useless here, because a gap's axis-aligned box is the wall
     * segment it sits on and neighbours always "overlap" on paper.
     */
    const gapOverlap = await page.locator("[data-wall-opening]").evaluateAll(
      (nodes) => {
        type Gap = { center: number; width: number };
        const byEdge = new Map<number, Gap[]>();
        for (const node of nodes) {
          const edge = Number(node.getAttribute("data-opening-edge"));
          const center = Number(node.getAttribute("data-opening-center"));
          const width = Number(node.getAttribute("data-opening-width"));
          if (![edge, center, width].every(Number.isFinite)) continue;
          const list = byEdge.get(edge) ?? [];
          list.push({ center, width });
          byEdge.set(edge, list);
        }
        let overlapping = 0;
        let touchingPairs = 0;
        for (const list of byEdge.values()) {
          list.sort((a, b) => a.center - b.center || a.width - b.width);
          for (let i = 1; i < list.length; i++) {
            const prev = list[i - 1];
            const cur = list[i];
            const gap =
              cur.center - cur.width / 2 - (prev.center + prev.width / 2);
            if (gap < -0.5) overlapping += 2;
            if (gap < 1) touchingPairs += 1;
          }
        }
        return { overlapping, touchingPairs, edges: byEdge.size };
      },
    );
    measured[job.jobCode] = {
      ...overlap,
      snapped,
      doors,
      page: matched!.pageNumber,
      view,
      note,
    };

    console.log(
      [
        `\n${job.jobCode} — ${view}, page ${matched!.pageNumber}, ${rendered} marks drawn`,
        `  openings in walls    ${snapped} / ${rendered}` +
          `  (${doors} door${doors === 1 ? "" : "s"}),` +
          ` ${rendered - snapped} left as free dots`,
        `  openings overlapping ${gapOverlap.overlapping} / ${snapped}` +
          `  (${gapOverlap.touchingPairs} pairs touching)`,
        `  bad pin pairs        ${overlap.badPairs} / ${overlap.pairs}` +
          `  = ${overlap.badPairFraction.toFixed(5)} (limit ${MAX_BAD_PAIR_FRACTION})`,
        `  pins in any overlap  ${overlap.pinsInvolved} / ${overlap.pins}` +
          `  = ${overlap.pinsInvolvedFraction.toFixed(3)} (limit ${MAX_PINS_INVOLVED_FRACTION})`,
        `  median nearest gap   ${overlap.medianNearestGap.toFixed(1)} px edge-to-edge`,
        `  numbers shown on     ${overlap.labelled} / ${overlap.pins} pins`,
      ].join("\n"),
    );

    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({
      path: join(SHOTS, `${job.jobCode}-map-390.png`),
      fullPage: true,
    });
    await sheet.screenshot({
      path: join(SHOTS, `${job.jobCode}-sheet-390.png`),
    });

    // Now force every number on. This is the state the auto-hide threshold is
    // deciding about, so it is measured rather than assumed: how much of this
    // page's numbering is actually readable when all of it is drawn at once.
    const numbers = page.getByRole("button", { name: "Numbers", exact: true });
    if ((await numbers.getAttribute("aria-pressed")) !== "true") {
      await numbers.click();
    }
    const numberLabels = pins
      .locator(".plan-dot__mark")
      .or(page.locator("[data-opening-label]"));
    await expect.poll(async () => numberLabels.count()).toBe(rendered);
    const box = await sheet.boundingBox();
    const fit = measureLabelFit(
      await labelBoxes(numberLabels),
      box ? box.width * box.height : 0,
    );
    const loud = measureOverlap(await pinBoxes(pins));
    await sheet.screenshot({
      path: join(SHOTS, `${job.jobCode}-numbers-390.png`),
    });
    labelFits[job.jobCode] = { ...fit, page: matched!.pageNumber };

    /*
     * Full screen, which used to be a black screen. Everything inside the
     * drawing is absolutely positioned, so the box had nothing to shrink-wrap
     * and collapsed to 0x0 — with every pin stacked in one corner, invisible.
     * A zero-sized drawing is the one failure a screenshot comparison would
     * happily accept forever, so it is asserted rather than eyeballed.
     */
    if (view === "Building outline") {
      await page.getByRole("button", { name: "Full screen" }).first().click();
      const fullBox = await page.locator(".cartoon-sheet").boundingBox();
      expect(
        Math.min(fullBox?.width ?? 0, fullBox?.height ?? 0),
        `${job.jobCode}: the drawing collapsed in full screen`,
      ).toBeGreaterThan(100);
      await page.screenshot({
        path: join(SHOTS, `${job.jobCode}-fullscreen-390.png`),
      });
    }

    console.log(
      [
        `  — with every number forced on —`,
        `  labels touching      ${fit.labelsTouching} / ${fit.labels}` +
          `  = ${fit.labelsTouchingFraction.toFixed(3)}` +
          `  (${fit.collidingPairs} pairs)`,
        `  labels 1/4 buried    ${fit.labelsBuried} / ${fit.labels}` +
          `  = ${fit.labelsBuriedFraction.toFixed(3)}`,
        `  label size           ${fit.labelW.toFixed(1)} x ${fit.labelH.toFixed(1)} px`,
        `  mark density         ${fit.density.toFixed(1)} per 100k px²` +
          ` of ${Math.round(fit.drawingArea)} px² drawing`,
        `  pins in any overlap  ${loud.pinsInvolved} / ${loud.pins}` +
          `  = ${loud.pinsInvolvedFraction.toFixed(3)}`,
      ].join("\n"),
    );

    expect(
      gapOverlap.overlapping,
      `${job.jobCode}: ${gapOverlap.overlapping} openings are drawn over another ` +
        `one, so the wall between them has been erased`,
    ).toBe(0);
    // Only where marks are still drawn as pins. A page whose marks all became
    // openings has no pins to bury, and dividing by that would report a NaN as
    // a pass.
    if (overlap.pins > 0) {
      expect(
        overlap.badPairFraction,
        `${job.jobCode}: ${overlap.badPairs} of ${overlap.pairs} pin pairs cover ` +
          `more than half of each other`,
      ).toBeLessThan(MAX_BAD_PAIR_FRACTION);
      expect(
        overlap.pinsInvolvedFraction,
        `${job.jobCode}: ${overlap.pinsInvolved} of ${overlap.pins} pins are more ` +
          `than half buried under another pin`,
      ).toBeLessThan(MAX_PINS_INVOLVED_FRACTION);
    }

    expect(
      missingStorage,
      "planset objects the fixtures could not serve",
    ).toEqual([]);
    expect(pageErrors, "uncaught errors on the map page").toEqual([]);
    if (unmatched.length > 0) {
      console.log(
        `  (empty data served for ${[...new Set(unmatched)].join(", ")})`,
      );
    }
  });
}

test.afterAll(() => {
  const rows = Object.entries(measured);
  if (rows.length === 0) return;
  const table = rows
    .map(
      ([jobCode, m]) =>
        `| ${jobCode} | ${m.view} | ${m.page} | ${m.pins} | ` +
        `${m.snapped} / ${m.pins} | ${m.doors} | ` +
        `${m.badPairs} / ${m.pairs} | ${m.badPairFraction.toFixed(5)} | ` +
        `${m.pinsInvolved} / ${m.pins} | ${m.medianNearestGap.toFixed(1)} px | ` +
        `${m.note ?? ""} |`,
    )
    .join("\n");
  const labelTable = Object.entries(labelFits)
    .map(
      ([jobCode, f]) =>
        `| ${jobCode} | ${f.page} | ${f.labels} | ${f.labelsTouching} / ${f.labels} | ` +
        `${f.labelsBuried} / ${f.labels} | ${f.labelsBuriedFraction.toFixed(3)} | ` +
        `${f.labelW.toFixed(1)} x ${f.labelH.toFixed(1)} px | ` +
        `${f.density.toFixed(1)} |`,
    )
    .join("\n");
  mkdirSync(SHOTS, { recursive: true });
  writeFileSync(
    join(SHOTS, "overlap.md"),
    "| job | view | page | pins | in walls | doors | bad pairs | fraction | " +
      "pins involved | median gap | note |\n" +
      "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |\n" +
      `${table}\n` +
      "\nEvery mark number forced on:\n\n" +
      "| job | page | labels | touching | 1/4 buried | buried share | " +
      "label size | marks per 100k px² |\n" +
      "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n" +
      `${labelTable}\n`,
  );
  console.log(`\n${table}\n\n${labelTable}\n`);
});
