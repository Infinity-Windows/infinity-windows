// Is the job map readable on a phone?
//
// Three real jobs, at 390 px, with their real pin geometry:
//   BLACK22   42 marks on one sheet — the crowded case
//   PECAN14   two sheets, 57 and 48 marks — the crowded case, twice
//   OAKRIDGE  3 marks — the sparse case, where nothing should look broken
//
// Two things are checked, and the first one outranks the second.
//
// WHAT A MARK SAYS. Every mark is a pin carrying its own number, filled blue for
// a window or green for a door and ringed in its install status. This is not a
// style preference. The map once encoded status as the pin's fill and hid numbers
// above fourteen marks on a page, which on every real job — where every opening
// is `planned` — drew 42 identical unlabelled marks; the owner rejected it on
// sight. So it is asserted here, per view, rather than left to a screenshot.
//
// HOW BADLY PINS PILE UP. Two pins "badly overlap" when the smaller is more than
// half buried, i.e. their centres are closer than half its diameter. A page of
// perfectly stacked pins scores 1.0, so the thresholds are not vacuous. The
// reading at 100% is printed for every job — 42 numbered pins on a 390 px phone
// genuinely are crowded, and pretending otherwise is what cost the numbers last
// time — but the limits are held at 200%, because zoom is the remedy a crew has
// on a busy sheet and the point is that using it actually works.
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

/** What one pin is saying, read off the rendered element. */
interface PinVoice {
  label: string | null;
  fill: string;
  ring: string;
  door: boolean;
}

/** From lib/install/types — the two colours a pin may be filled with. */
const KIND_FILL = { window: "rgb(74, 157, 255)", door: "rgb(62, 207, 110)" };
/** …and the rings, per install status. */
const STATUS_RINGS = [
  "rgb(251, 191, 36)", // planned
  "rgb(148, 163, 184)", // assigned
  "rgb(52, 211, 153)", // installed
  "rgb(248, 113, 113)", // install undone
];

async function pinVoices(pins: Locator): Promise<PinVoice[]> {
  return pins.evaluateAll((nodes) =>
    nodes.map((node) => {
      const style = getComputedStyle(node);
      return {
        label:
          node.querySelector(".plan-dot__mark")?.textContent?.trim() ?? null,
        fill: style.backgroundColor,
        ring: style.borderTopColor,
        door: node.classList.contains("plan-dot--door"),
      };
    }),
  );
}

/**
 * Every mark on this view carries its number and is coloured window-or-door,
 * ringed in a real status. `where` names the view so a failure says which one.
 */
async function expectPinsSpeak(pins: Locator, where: string, expected: number) {
  const voices = await pinVoices(pins);
  expect(voices, `${where}: expected ${expected} pins`).toHaveLength(expected);

  const unlabelled = voices.filter((v) => !v.label);
  expect(
    unlabelled.length,
    `${where}: ${unlabelled.length} of ${voices.length} pins are drawn with no ` +
      `mark number. The number is the only thing telling two identical windows ` +
      `apart, and nobody should have to find a chip to switch it on.`,
  ).toBe(0);

  const wrongFill = voices.filter(
    (v) => v.fill !== KIND_FILL.window && v.fill !== KIND_FILL.door,
  );
  expect(
    wrongFill.length,
    `${where}: ${wrongFill.length} pins are neither window-blue nor door-green ` +
      `(saw ${[...new Set(wrongFill.map((v) => v.fill))].join(", ")}). Window ` +
      `vs door has to be readable without tapping anything.`,
  ).toBe(0);

  const wrongRing = voices.filter((v) => !STATUS_RINGS.includes(v.ring));
  expect(
    wrongRing.length,
    `${where}: ${wrongRing.length} pins have no install-status ring ` +
      `(saw ${[...new Set(wrongRing.map((v) => v.ring))].join(", ")})`,
  ).toBe(0);

  // A green pin is also a square one, so the distinction survives a colour-blind
  // reader and a bleached phone screen in the sun.
  const mismatched = voices.filter((v) => v.door !== (v.fill === KIND_FILL.door));
  expect(
    mismatched.length,
    `${where}: ${mismatched.length} pins are square without being green, or the ` +
      `other way round`,
  ).toBe(0);

  return {
    doors: voices.filter((v) => v.fill === KIND_FILL.door).length,
    windows: voices.filter((v) => v.fill === KIND_FILL.window).length,
  };
}

/**
 * A sheet at the zoom a crew would read it at has to be countable. Skipped when
 * nothing is drawn as a pin, because dividing by no pins reports a NaN as a pass.
 */
function expectCountable(overlap: Overlap, where: string) {
  if (overlap.pins === 0) return;
  expect(
    overlap.badPairFraction,
    `${where}: ${overlap.badPairs} of ${overlap.pairs} pin pairs cover more than ` +
      `half of each other`,
  ).toBeLessThan(MAX_BAD_PAIR_FRACTION);
  expect(
    overlap.pinsInvolvedFraction,
    `${where}: ${overlap.pinsInvolved} of ${overlap.pins} pins are more than half ` +
      `buried under another pin`,
  ).toBeLessThan(MAX_PINS_INVOLVED_FRACTION);
}

/** Zoom to 200%, where a crowded sheet is meant to become countable. */
async function zoomTo200(page: import("@playwright/test").Page) {
  const label = page.getByRole("button", { name: "Reset zoom" }).first();
  for (let i = 0; i < 4; i++) {
    await page.getByRole("button", { name: "Zoom in" }).first().click();
  }
  await expect(label).toHaveText("200%");
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

    /*
     * The map opens on the real architectural sheet. That is the drawing the
     * marks were read off, and the one the owner asked to land on; the derived
     * cartoon is a rectangle on every job nobody has traced by hand.
     */
    const planSheet = page.locator(".plan-map--with-dots");
    await expect(
      planSheet.locator("img"),
      `${job.jobCode}: the map did not open on the original plan`,
    ).toBeVisible({ timeout: 150_000 });
    const planPins = planSheet.locator(".plan-dot");
    const planCount = await settledPinCount(planPins, true);
    const planKinds = await expectPinsSpeak(
      planPins,
      `${job.jobCode} original plan`,
      planCount,
    );
    const planAt100 = measureOverlap(await pinBoxes(planPins));
    await zoomTo200(page);
    const planAt200 = measureOverlap(await pinBoxes(planPins));
    console.log(
      `\n${job.jobCode} — Original plan, ${planCount} pins ` +
        `(${planKinds.windows} window, ${planKinds.doors} door), all numbered\n` +
        `  pins in any overlap  ${planAt100.pinsInvolved}/${planAt100.pins} at 100%` +
        `  →  ${planAt200.pinsInvolved}/${planAt200.pins} at 200%`,
    );
    expectCountable(planAt200, `${job.jobCode} original plan at 200%`);
    await page.getByRole("button", { name: "Reset zoom" }).first().click();

    await page.getByRole("button", { name: "Building outline" }).click();

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
    let marks = pins;
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
       * Nothing is cut into this shape. It is a derived rectangle on every job
       * nobody has traced, so cutting 42 window and door symbols into it stated
       * a wall position the data does not have — and cost every mark its number
       * and its window/door colour, because a hole in a wall cannot carry
       * either. Marks belong on top of it, as pins.
       */
      const holes = await page.locator("[data-wall-opening]").count();
      expect(
        holes,
        `${job.jobCode}: ${holes} marks are drawn as gaps cut into a derived ` +
          `building outline instead of as numbered pins on top of it`,
      ).toBe(0);

      /*
       * The whole floor is visible on opening — zoom is for inspecting a
       * corner, not for un-cramming the drawing.
       */
      const zoomViewport = page.locator(".plan-zoom-viewport--outline");
      const outlineSheet = page.locator(
        ".plan-zoom-viewport--outline .cartoon-sheet",
      );
      await expect(zoomViewport).toBeVisible();
      const viewportBox = await zoomViewport.boundingBox();
      const sheetBox = await outlineSheet.boundingBox();
      expect(viewportBox, `${job.jobCode}: missing outline viewport`).toBeTruthy();
      expect(sheetBox, `${job.jobCode}: missing outline sheet`).toBeTruthy();
      expect(
        (sheetBox?.width ?? 0) / (viewportBox?.width ?? 1),
        `${job.jobCode}: the whole floor should fit without panning`,
      ).toBeLessThanOrEqual(1.02);

      const zoomLabel = page.getByRole("button", { name: "Reset zoom" });
      await expect(zoomLabel).toHaveText("100%");
      // Zoom is still there for a closer look, and panning works once the
      // drawing is bigger than its viewport.
      for (let i = 0; i < 4; i++) {
        await page.getByRole("button", { name: "Zoom in" }).click();
      }
      await expect(zoomLabel).toHaveText("200%");
      await expect
        .poll(async () => {
          const next = await outlineSheet.boundingBox();
          return next?.width ?? 0;
        })
        .toBeGreaterThan((sheetBox?.width ?? 0) * 1.5);

      const beforeScroll = await zoomViewport.evaluate((el) => el.scrollLeft);
      await zoomViewport.evaluate((el) => {
        el.scrollLeft = Math.min(el.scrollWidth - el.clientWidth, 80);
      });
      const afterScroll = await zoomViewport.evaluate((el) => el.scrollLeft);
      expect(
        afterScroll,
        `${job.jobCode}: outline viewport should pan once zoomed in`,
      ).toBeGreaterThan(beforeScroll);

      // Marks stay interactive after zoom/pan — tap one and its row links.
      // Also the zoom at which a crowded sheet has to become countable.
      expectCountable(
        measureOverlap(await pinBoxes(pins)),
        `${job.jobCode} building outline at 200%`,
      );
      const firstPin = pins.first();
      if ((await firstPin.count()) > 0) {
        await firstPin.click({ force: true });
        await expect(
          page.locator(".find-row--linked").first(),
          `${job.jobCode}: tapping a mark after zoom/pan did not select it`,
        ).toBeVisible({ timeout: 5_000 });
      }

      // Back to the whole floor, which is what the screenshots record.
      await zoomLabel.click();
      await expect(zoomLabel).toHaveText("100%");
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
    const kinds = await expectPinsSpeak(pins, `${job.jobCode} ${view}`, rendered);
    measured[job.jobCode] = {
      ...overlap,
      snapped: 0,
      doors: kinds.doors,
      page: matched!.pageNumber,
      view,
      note,
    };

    console.log(
      [
        `\n${job.jobCode} — ${view}, page ${matched!.pageNumber}, ${rendered} marks drawn`,
        `  window / door        ${kinds.windows} blue, ${kinds.doors} green`,
        `  bad pin pairs        ${overlap.badPairs} / ${overlap.pairs}` +
          `  = ${overlap.badPairFraction.toFixed(5)} at 100%`,
        `  pins in any overlap  ${overlap.pinsInvolved} / ${overlap.pins}` +
          `  = ${overlap.pinsInvolvedFraction.toFixed(3)} at 100%` +
          ` (the limit is held at 200%, where zoom has done its job)`,
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

    // How readable this page's numbering is with all of it drawn at once, which
    // is now the normal state rather than something a chip has to be found for.
    // The Numbers chip is asserted to already be on, and to still turn them off.
    const numbers = page.getByRole("button", { name: "Numbers", exact: true });
    await expect(
      numbers,
      `${job.jobCode}: mark numbers should be on without anyone asking`,
    ).toHaveAttribute("aria-pressed", "true");
    const numberLabels = pins.locator(".plan-dot__mark");
    await expect.poll(async () => numberLabels.count()).toBe(rendered);
    const box = await sheet.boundingBox();
    const fit = measureLabelFit(
      await labelBoxes(numberLabels),
      box ? box.width * box.height : 0,
    );
    await sheet.screenshot({
      path: join(SHOTS, `${job.jobCode}-numbers-390.png`),
    });
    labelFits[job.jobCode] = { ...fit, page: matched!.pageNumber };

    /*
     * The escape hatch still works: tapping Numbers takes the labels off. The
     * pin the crew last tapped keeps its number either way — that is the whole
     * point of selecting one — so a bare page is "only the selected pin".
     */
    await numbers.click();
    await expect
      .poll(async () => numberLabels.count(), {
        message:
          `${job.jobCode}: turning Numbers off should leave at most the one pin ` +
          `the crew last tapped labelled`,
      })
      .toBeLessThanOrEqual(1);
    await numbers.click();
    await expect.poll(async () => numberLabels.count()).toBe(rendered);

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
      ].join("\n"),
    );

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
        `${m.labelled} / ${m.pins} | ${m.doors} | ` +
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
    "Overlap is read at 100%; the limits are held at 200%.\n\n" +
      "| job | view | page | pins | numbered | doors | bad pairs | fraction | " +
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
