import { test, expect, type Locator, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * The foreman-only mark controls, exercised for real.
 *
 * Signs in as the foreman test login, opens the automation sandbox job, and does
 * the four things that had never been seen working: drags a mark, reads the Undo
 * button (including who moved it and when), puts one mark back, and puts every
 * mark back. Screenshots at each step, because "it works" from an agent is worth
 * nothing without a picture — a previous run cited screenshots that did not
 * exist.
 *
 * WHY THIS IS SAFE. Two independent reasons, and it relies on both:
 *
 *  1. It asserts the job on screen is the sandbox before it drags anything, and
 *     fails outright otherwise. No real job can be reached by fixing a typo.
 *  2. The login itself cannot write anywhere else. The database refuses any
 *     write by a test account outside the sandbox job, so even this file
 *     rewritten to aim at Black Desert would change nothing there.
 *
 * Skipped unless the credential is in the environment, so an ordinary CI run and
 * an ordinary `npm test` are unaffected. See docs/test-account.md.
 */

const EMAIL = process.env.TEST_FOREMAN_EMAIL ?? "";
const PASSWORD = process.env.TEST_FOREMAN_PASSWORD ?? "";

/** The one job this test is allowed anywhere near. */
const SANDBOX_JOB_CODE = "ZZTEST";
const SANDBOX_JOB_NAME = "TEST — automation sandbox";

const SHOTS =
  process.env.IW_FOREMAN_SHOTS ??
  join(process.cwd(), "e2e", "__screenshots__", "foreman");

test.skip(
  !EMAIL || !PASSWORD,
  "Needs TEST_FOREMAN_EMAIL and TEST_FOREMAN_PASSWORD. See docs/test-account.md.",
);

/**
 * Quiet the first-run overlays before the app boots. Same keys the fixture
 * harness uses. Not cosmetic: the "Tip: Jobs" card sits over the plan and ate
 * the click that changes drawing view on the first attempt at this.
 */
async function calmFirstRun(page: Page) {
  await page.addInitScript(() => {
    window.localStorage.setItem("infinity-perm-wizard-choice", "completed");
    window.localStorage.setItem(
      "infinity:dismissed-tips",
      JSON.stringify([
        "home",
        "home_installer",
        "my_work",
        "projects",
        "photos",
        "chat",
        "schedule",
        "travel",
      ]),
    );
  });
}

async function signIn(page: Page) {
  await page.goto("/");

  // The landing screen shows a Sign in button; a returning visitor may get the
  // form straight away. Handle both rather than assuming.
  const landingButton = page.getByRole("button", { name: "Sign in", exact: true });
  const emailField = page.locator('input[type="email"]');
  await expect(landingButton.or(emailField).first()).toBeVisible();
  if (!(await emailField.isVisible().catch(() => false))) {
    await landingButton.first().click();
  }

  await emailField.fill(EMAIL);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.getByRole("button", { name: /^Sign in/ }).click();

  // Signed in when the form is gone. The landing route differs by role, so
  // waiting on a particular screen would be brittle.
  await expect(emailField).toBeHidden({ timeout: 60_000 });

  // The test account has no quick-unlock PIN. A PIN gate here is a real problem
  // to report, not something to work around.
  await expect(page.locator(".pin-gate")).toBeHidden();
}

/** Open the sandbox job's plan, the way a person would. */
async function openSandboxPlan(page: Page) {
  await page.goto("/projects");

  const card = page.locator("a.project-card", { hasText: SANDBOX_JOB_CODE });
  await expect(
    card,
    `the foreman should see the ${SANDBOX_JOB_CODE} sandbox job in its job list`,
  ).toHaveCount(1);
  await expect(card).toContainText(SANDBOX_JOB_NAME);
  await card.click();

  // THE SAFETY ASSERTION. Everything below drags marks and presses buttons that
  // write to the database, and it happens only once the job on screen has been
  // confirmed to be the sandbox.
  await expect(
    page.getByRole("heading", { name: SANDBOX_JOB_CODE, level: 1 }),
    "refusing to touch marks: the job on screen is not the sandbox",
  ).toBeVisible({ timeout: 60_000 });

  await page.getByRole("button", { name: "Map", exact: true }).click();

  // The view a foreman lands on, and where the marks are. Reading the plan set
  // is the slow part of opening a job, so wait for a mark rather than for a
  // spinner to disappear.
  await expect(page.locator(".cartoon-sheet")).toBeVisible({ timeout: 120_000 });
  await expect(marksOn(page).first()).toBeVisible({ timeout: 180_000 });
}

/**
 * Every mark on the drawing, however it happens to be drawn.
 *
 * A mark close to a wall is cut into that wall as an opening; the rest are free
 * dots. Both are draggable and both are "a mark on the plan", so a check that
 * only knew about dots would silently pass on a job that has none — which is
 * exactly what the sandbox turned out to be.
 */
function marksOn(page: Page): Locator {
  return page.locator(".cartoon-sheet .plan-dot, .cartoon-sheet [data-wall-opening]");
}

/** The same, minus any mark already showing the moved ring. */
function unmovedMarksOn(page: Page): Locator {
  return page.locator(
    ".cartoon-sheet .plan-dot:not(.plan-dot--moved), .cartoon-sheet [data-wall-opening]",
  );
}

/** Centre of an element, in page coordinates. */
async function centre(target: Locator): Promise<{ x: number; y: number }> {
  const box = await target.boundingBox();
  if (!box) throw new Error("the element has no box, so it cannot be dragged");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/**
 * Drag with the real mouse rather than dispatched events. The drag only begins
 * after 5px of movement and listens on the document, so a synthetic
 * pointerdown/pointerup pair would prove nothing about whether a thumb on a
 * phone can move a mark.
 */
async function dragBy(page: Page, mark: Locator, dx: number, dy: number) {
  const from = await centre(mark);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 14 });
  await page.mouse.up();
}

test.describe("foreman mark controls, on the sandbox job only", () => {
  test.beforeAll(() => {
    mkdirSync(SHOTS, { recursive: true });
  });

  test("drag, undo with attribution, put one back, put every one back", async ({
    page,
  }) => {
    await calmFirstRun(page);
    await signIn(page);
    await openSandboxPlan(page);

    const sheet = page.locator(".cartoon-sheet");
    // Two classes, one thing. With nothing moved the bar collapses to a single
    // sentence with its own class rather than rendering an empty bar, so a
    // locator that only knew the busy one would report the foreman-only bar
    // missing on the very state it is supposed to start in.
    const undoBar = page.locator(".mark-undo, .mark-undo__clear");
    const rings = page.locator(".cartoon-sheet .plan-dot--moved");

    await expect(
      undoBar,
      "the undo bar is foreman-only, and this login is a foreman",
    ).toBeVisible();

    // Start from a known state. A mark left moved by an earlier run would make
    // "the ring appeared because I dragged it" unprovable.
    await putEveryMarkBack(page, { allowNothingToDo: true });
    await expect(rings).toHaveCount(0);
    await expect(undoBar).toContainText("Every mark is where the plan put it");
    const markCount = await marksOn(page).count();
    expect(markCount, "the sandbox plan should have marks on it").toBeGreaterThan(1);
    await sheet.screenshot({ path: join(SHOTS, "01-plan-before-any-move.png") });

    // ---- 1. Drag a mark ---------------------------------------------------
    // Toward the middle of the drawing, and far. A mark sitting in a wall is
    // drawn as part of that wall, and a nudge would leave it there; a real move
    // takes it off the wall, which is the case worth proving anyway.
    const first = marksOn(page).first();
    const mark = await gripMark(page, first);
    const sheetBox = await sheet.boundingBox();
    const from = await centre(mark.locator);
    const toward = {
      dx: (sheetBox!.x + sheetBox!.width / 2 - from.x) * 0.55,
      dy: (sheetBox!.y + sheetBox!.height / 2 - from.y) * 0.55,
    };

    await dragBy(page, mark.locator, toward.dx, toward.dy);

    // ---- 2. The moved-mark ring -------------------------------------------
    await expect(
      rings,
      "the mark it moved should be ringed as moved off the plan",
    ).toHaveCount(1, { timeout: 60_000 });
    await sheet.screenshot({ path: join(SHOTS, "02-mark-dragged-and-ringed.png") });
    // Close up, because a 4px ring is invisible in a phone-sized shot.
    await rings.first().screenshot({ path: join(SHOTS, "03-moved-ring-closeup.png") });

    // ---- 3. The undo bar, and who moved it --------------------------------
    const undoButton = page.getByRole("button", { name: /^Undo moving mark / });
    await expect(undoButton).toBeVisible();
    const attribution = ((await undoButton.textContent()) ?? "").trim();
    // "Undo moving mark 5 — you, just now". The name and the time are the whole
    // point: the next thing on the stack may be a correction somebody made on
    // purpose out on site, and that has to be readable before pressing, not
    // after.
    expect(attribution).toMatch(/^Undo moving mark \S+ — you, just now$/);
    expect(attribution).toContain(mark.label);
    await expect(undoBar).toContainText("mark has been moved off the plan");
    await undoBar.screenshot({ path: join(SHOTS, "04-undo-bar-attribution.png") });

    // ---- 4. Undo it -------------------------------------------------------
    await undoButton.click();
    await expect(rings).toHaveCount(0, { timeout: 60_000 });
    await expect(undoBar).toContainText("Every mark is where the plan put it");
    await expect(page.getByRole("button", { name: /^Undo moving mark / })).toHaveCount(0);
    await sheet.screenshot({ path: join(SHOTS, "05-plan-after-undo.png") });

    // ---- 5. Put one mark back ---------------------------------------------
    // A different button doing a different thing: Undo walks back one step,
    // this goes straight to where the plan put that one mark.
    const again = await gripMark(page, marksOn(page).first());
    await dragBy(page, again.locator, toward.dx, toward.dy);
    await expect(rings).toHaveCount(1, { timeout: 60_000 });
    await rings.first().click();

    const putOneBack = page.getByRole("button", {
      name: /^Put mark \S+ back on the plan$/,
    });
    await expect(putOneBack).toBeVisible();
    await undoBar.screenshot({ path: join(SHOTS, "06-put-one-mark-back.png") });
    await putOneBack.click();
    await expect(rings).toHaveCount(0, { timeout: 60_000 });

    // ---- 6. Put every mark back -------------------------------------------
    // Two marks this time, so the button has to count and the confirmation has
    // to say "2 marks" rather than "1 mark".
    const a = await gripMark(page, marksOn(page).first());
    await dragBy(page, a.locator, toward.dx, toward.dy);
    await expect(rings).toHaveCount(1, { timeout: 60_000 });
    // Explicitly one that has NOT been moved yet. The mark just dragged is no
    // longer where it was in the drawing's order, so "the second one" could pick
    // it up again and move the same mark twice.
    const b = await gripMark(page, unmovedMarksOn(page).first());
    await dragBy(page, b.locator, toward.dx * 0.6, toward.dy * 0.6);
    await expect(rings).toHaveCount(2, { timeout: 60_000 });
    await expect(undoBar).toContainText("2 marks have been moved off the plan");
    await sheet.screenshot({ path: join(SHOTS, "07-two-marks-moved.png") });
    await undoBar.screenshot({ path: join(SHOTS, "08-undo-bar-two-moved.png") });

    const confirmText = await putEveryMarkBack(page);
    expect(
      confirmText,
      "the put-everything-back confirmation should warn about deliberate moves",
    ).toContain("back where the plan put them?");
    expect(confirmText).toContain("moved on purpose to match the building");

    await expect(rings).toHaveCount(0, { timeout: 60_000 });
    await expect(undoBar).toContainText("Every mark is where the plan put it");
    await sheet.screenshot({ path: join(SHOTS, "09-plan-after-every-mark-back.png") });
    await undoBar.screenshot({ path: join(SHOTS, "10-undo-bar-nothing-moved.png") });
  });
});

/**
 * Take hold of a mark: a locator that keeps pointing at it after it moves, plus
 * the number printed on it.
 *
 * Held by identity rather than by position in the list, because moving a mark
 * can reorder the drawing and can change what kind of element it is — a mark
 * dragged out of a wall stops being part of that wall and becomes a free dot.
 * "The first one" would quietly become a different mark halfway through.
 */
async function gripMark(
  page: Page,
  from: Locator,
): Promise<{ locator: Locator; label: string }> {
  const wallId = await from.getAttribute("data-wall-opening");
  if (wallId) {
    const label =
      (await page
        .locator(`.cartoon-sheet [data-opening-label="${wallId}"]`)
        .textContent()
        .catch(() => null)) ?? "";
    return {
      locator: page.locator(
        `.cartoon-sheet [data-wall-opening="${wallId}"], .cartoon-sheet .plan-dot[data-opening="${wallId}"]`,
      ),
      label: label.trim().replace(/^#/, ""),
    };
  }
  const aria = await from.getAttribute("aria-label");
  const label = ((await from.locator(".plan-dot__mark").textContent()) ?? "").trim();
  return {
    locator: page.locator(`.cartoon-sheet .plan-dot[aria-label="${aria}"]`),
    label,
  };
}

/**
 * Press "put every mark back", accept the confirmation, and return what the
 * confirmation actually said. Returns "" when there was nothing to put back.
 */
async function putEveryMarkBack(
  page: Page,
  opts: { allowNothingToDo?: boolean } = {},
): Promise<string> {
  const all = page.locator(".mark-undo__all");
  if ((await all.count()) === 0) {
    if (opts.allowNothingToDo) return "";
    throw new Error("expected a put-every-mark-back button and found none");
  }

  let said = "";
  page.once("dialog", (dialog) => {
    said = dialog.message();
    void dialog.accept();
  });
  await all.first().click();
  await expect(all).toHaveCount(0, { timeout: 60_000 });
  return said;
}
