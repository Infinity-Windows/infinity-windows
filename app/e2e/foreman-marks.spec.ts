import { test, expect, type Locator, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * The foreman-only mark controls, exercised for real.
 *
 * Signs in as the foreman test login, opens the automation sandbox job, and
 * does the four things that had never been seen working: drags a mark, reads
 * the Undo button (including who moved it and when), puts one mark back, and
 * puts every mark back. Screenshots at each step, because "it works" from an
 * agent is worth nothing without a picture — a previous run cited screenshots
 * that did not exist.
 *
 * WHY THIS IS SAFE. Two independent reasons, and the test relies on both:
 *
 *  1. It asserts the job code is the sandbox before it drags anything, and
 *     fails outright otherwise. No real job can be reached by fixing a typo.
 *  2. The login itself cannot write anywhere else. The database refuses any
 *     write by a test account outside the sandbox job, so even this file
 *     rewritten to aim at Black Desert would change nothing there.
 *
 * Skipped unless the credential is in the environment, so an ordinary CI run
 * and an ordinary `npm test` are unaffected. See docs/test-account.md.
 */

const EMAIL = process.env.TEST_FOREMAN_EMAIL ?? "";
const PASSWORD = process.env.TEST_FOREMAN_PASSWORD ?? "";

/** The one job this test is allowed anywhere near. */
const SANDBOX_JOB_CODE = "ZZTEST";
const SANDBOX_JOB_NAME = "TEST — automation sandbox";

const SHOTS = process.env.IW_FOREMAN_SHOTS
  ? process.env.IW_FOREMAN_SHOTS
  : join(process.cwd(), "e2e", "__screenshots__", "foreman");

test.skip(
  !EMAIL || !PASSWORD,
  "Needs TEST_FOREMAN_EMAIL and TEST_FOREMAN_PASSWORD. See docs/test-account.md.",
);

/**
 * Quiet the first-run overlays before the app boots. Same keys the fixture
 * harness uses. Not cosmetic: the "Tip: Jobs" card sits over the plan and ate
 * the click that switches to the original drawing on the first attempt at this.
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

  // Signed in when the sign-in form is gone. The landing route differs by role
  // (a foreman gets Home), so waiting on a specific screen would be brittle.
  await expect(emailField).toBeHidden({ timeout: 60_000 });

  // The test account has no quick-unlock PIN. If a PIN gate appears, that is a
  // real problem to report, not something to work around.
  await expect(page.locator(".pin-gate")).toBeHidden();
}

/** Open the sandbox job from the job list, the way a person would. */
async function openSandboxMap(page: Page): Promise<string> {
  await page.goto("/projects");

  const card = page.locator("a.project-card", { hasText: SANDBOX_JOB_CODE });
  await expect(
    card,
    `the foreman should see the ${SANDBOX_JOB_CODE} sandbox job in its job list`,
  ).toHaveCount(1);
  await expect(card).toContainText(SANDBOX_JOB_NAME);

  const href = await card.getAttribute("href");
  const projectId = (href ?? "").split("/").pop() ?? "";
  expect(projectId, "the sandbox job card should link to a project id").toMatch(
    /^[0-9a-f-]{36}$/,
  );

  await card.click();

  // THE SAFETY ASSERTION. Everything below drags marks and presses buttons that
  // write to the database, and it happens only once the job on screen has been
  // confirmed to be the sandbox.
  await expect(
    page.getByText(SANDBOX_JOB_CODE, { exact: false }).first(),
    "refusing to touch marks: the job on screen is not the sandbox",
  ).toBeVisible();

  await page.getByRole("button", { name: "Map", exact: true }).click();

  // The source plan with the marks drawn on it. That is what "dragging a mark
  // on the plan" means; the outline view is a model drawn from the marks rather
  // than the drawing itself.
  const originalPlan = page.getByRole("button", { name: "Original plan", exact: true });
  await expect(originalPlan).toBeVisible({ timeout: 120_000 });
  await originalPlan.click();
  // Confirm the view actually changed rather than assuming the click landed.
  await expect(originalPlan).toHaveClass(/active/);

  return projectId;
}

/** Centre of an element, in page coordinates. */
async function centre(target: Locator): Promise<{ x: number; y: number }> {
  const box = await target.boundingBox();
  if (!box) throw new Error("the element has no box, so it cannot be dragged");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/**
 * Drag with the real mouse rather than dispatched events. The drag only starts
 * after 5px of movement and listens on the document, so a synthetic
 * pointerdown/pointerup pair would prove nothing about whether a thumb on a
 * phone can move a mark.
 */
async function dragBy(page: Page, mark: Locator, dx: number, dy: number) {
  const from = await centre(mark);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 12 });
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
    await openSandboxMap(page);

    const plan = page.locator(".plan-map--with-dots");
    await expect(plan).toBeVisible({ timeout: 120_000 });

    const marks = plan.locator(".plan-dot");
    await expect(marks.first()).toBeVisible({ timeout: 120_000 });
    const markCount = await marks.count();
    expect(markCount, "the sandbox plan should have marks on it").toBeGreaterThan(0);

    const undoBar = page.locator(".mark-undo");
    await expect(
      undoBar,
      "the undo bar is foreman-only, and this login is a foreman",
    ).toBeVisible();

    // Start from a known state. Anything left moved by an earlier run would
    // make "the ring appeared because I dragged it" unprovable.
    await putEveryMarkBack(page, { allowNothingToDo: true });
    await expect(plan.locator(".plan-dot--moved")).toHaveCount(0);
    await expect(undoBar).toContainText("Every mark is where the plan put it");
    await page.screenshot({ path: join(SHOTS, "01-before-any-move.png") });

    // ---- 1. Drag a mark -----------------------------------------------------
    const mark = marks.first();
    const label = ((await mark.locator(".plan-dot__mark").textContent()) ?? "").trim();
    const before = await centre(mark);

    await dragBy(page, mark, 34, 26);

    const after = await centre(mark);
    expect(
      Math.abs(after.x - before.x) + Math.abs(after.y - before.y),
      "the mark should have actually moved on screen",
    ).toBeGreaterThan(10);
    await page.screenshot({ path: join(SHOTS, "02-mark-dragged.png") });

    // ---- 2. The moved-mark ring --------------------------------------------
    const moved = plan.locator(".plan-dot--moved");
    await expect(
      moved,
      "the mark it moved should be ringed as moved off the plan",
    ).toHaveCount(1);
    // Close up, because a 12px ring is invisible in a full-page phone shot.
    await moved.first().screenshot({ path: join(SHOTS, "03-moved-ring-closeup.png") });

    // ---- 3. The undo bar, and who moved it --------------------------------
    const undoButton = page.getByRole("button", { name: /^Undo moving mark / });
    await expect(undoButton).toBeVisible();
    const attribution = ((await undoButton.textContent()) ?? "").trim();
    // "Undo moving mark 3 — you, just now". The name and the time are the whole
    // point: the next thing on the stack may be a correction somebody made on
    // purpose, and that has to be readable before pressing, not after.
    expect(attribution).toMatch(/^Undo moving mark .+ — you, just now$/);
    if (label) expect(attribution).toContain(label);
    await expect(undoBar).toContainText("mark has been moved off the plan");
    await undoBar.screenshot({ path: join(SHOTS, "04-undo-bar-attribution.png") });

    // ---- 4. Undo it -------------------------------------------------------
    await undoButton.click();
    await expect(plan.locator(".plan-dot--moved")).toHaveCount(0, { timeout: 60_000 });
    await expect(undoBar).toContainText("Every mark is where the plan put it");
    const restored = await centre(marks.first());
    expect(
      Math.abs(restored.x - before.x) + Math.abs(restored.y - before.y),
      "Undo should put the mark back where it started",
    ).toBeLessThan(6);
    await page.screenshot({ path: join(SHOTS, "05-after-undo.png") });

    // ---- 5. Put one mark back ---------------------------------------------
    // Move it again, select it, and use the single-mark reset rather than Undo.
    // They are different buttons doing different things: Undo walks back one
    // step, this one goes straight to where the plan put it.
    await dragBy(page, marks.first(), -30, 34);
    await expect(plan.locator(".plan-dot--moved")).toHaveCount(1);
    await marks.first().click();

    const putOneBack = page.getByRole("button", { name: /^Put mark .+ back on the plan$/ });
    await expect(putOneBack).toBeVisible();
    await putOneBack.screenshot({ path: join(SHOTS, "06-put-one-mark-back.png") });
    await putOneBack.click();
    await expect(plan.locator(".plan-dot--moved")).toHaveCount(0, { timeout: 60_000 });

    // ---- 6. Put every mark back -------------------------------------------
    await dragBy(page, marks.first(), 40, -22);
    if (markCount > 1) await dragBy(page, marks.nth(1), -26, 30);
    const movedNow = await plan.locator(".plan-dot--moved").count();
    expect(movedNow).toBeGreaterThan(0);
    await page.screenshot({ path: join(SHOTS, "07-several-marks-moved.png") });

    const confirmText = await putEveryMarkBack(page);
    expect(
      confirmText,
      "the put-everything-back confirmation should name the job and warn about deliberate moves",
    ).toContain("back where the plan put them?");
    expect(confirmText).toContain("moved on purpose to match the building");

    await expect(plan.locator(".plan-dot--moved")).toHaveCount(0, { timeout: 60_000 });
    await expect(undoBar).toContainText("Every mark is where the plan put it");
    await page.screenshot({ path: join(SHOTS, "08-after-put-every-mark-back.png") });
  });
});

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
