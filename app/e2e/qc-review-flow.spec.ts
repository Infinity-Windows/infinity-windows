import { expect, test, type Page } from "@playwright/test";
import { useSupabaseFixtures as installSupabaseFixtures, TEST_USER } from "./support/supabaseFixtures";
import { installQcReviewFixtures, type QcFixtureOpening } from "./support/qcReviewFixtures";
import { hideWrongProjectBanner, json } from "./support/specHelpers";

const JOB = "21000000-0000-4000-8000-000000000001";
const id = (n: number) => `22000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function opening(n: number, overrides: Partial<QcFixtureOpening> = {}): QcFixtureOpening {
  return { id: id(n), project_id: JOB, opening_code: `U-${String(n).padStart(3, "0")}`,
    projects: { job_code: "QC-ALPHA", name: "Alpha test job" }, ...overrides };
}
async function fixtures(page: Page, units: QcFixtureOpening[], language: "en" | "es" = "en", uiDesign: "classic" | "new" = "classic") {
  await installSupabaseFixtures(page, { role: "foreman", language, uiDesign });
  await page.route("**/rest/v1/qc_checks**", route => json(route, []));
  await page.route("**/rest/v1/qc_decision_events**", route => json(route, []));
  await page.route("**/rest/v1/install_events**", route => json(route, []));
  await page.route("**/rest/v1/attachments**", route => json(route, []));
  await page.route("**/rest/v1/opening_phases**", route => json(route, []));
  await page.route("**/rest/v1/project_openings**", route => {
    const key = new URL(route.request().url()).searchParams.get("id")?.replace("eq.", "");
    return json(route, key ? (units.find(u => u.id === key) ?? units[0]) : units);
  });
  return installQcReviewFixtures(page, units);
}
const pass = (page: Page) => page.getByRole("button", { name: "Pass ✓", exact: true }).first();
const next = (page: Page) => page.getByRole("button", { name: "Next", exact: true });
const previous = (page: Page) => page.getByRole("button", { name: "Previous", exact: true });
const search = (page: Page) => page.getByPlaceholder("Search this job's units", { exact: true });

// The SQL suite separately proves authority/counts/atomicity. Browser checks
// exercise what the foreman actually does across server pages and failed sends.
test("unit search reaches a match beyond the first 50 and retains the selected UUID on reload", async ({ page }) => {
  const state = await fixtures(page, Array.from({ length: 63 }, (_, i) => opening(i + 1)));
  await page.goto("/qc");
  await search(page).fill("U-063");
  await expect(page.getByText("U-063", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "View unit details", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`sel=${id(63)}`));
  await page.reload();
  await expect(search(page)).toHaveValue("U-063");
  await expect(page.getByText("U-063", { exact: true }).first()).toBeVisible();
  expect(state.reads.some(r => r.p_search === "U-063" && r.p_project_id === JOB)).toBe(true);
  expect(state.commits).toBe(0);
});

test("explicit navigation crosses page 50 and can return to the same unit", async ({ page }) => {
  const state = await fixtures(page, Array.from({ length: 53 }, (_, i) => opening(i + 1)));
  await page.goto(`/qc?job=${JOB}&sel=${id(50)}`);
  await expect(page.getByRole("link", { name: "U-050", exact: true })).toBeVisible();
  await next(page).click();
  await expect(page).toHaveURL(new RegExp(`sel=${id(51)}`));
  await expect(page.getByRole("link", { name: "U-051", exact: true })).toBeVisible();
  expect(state.reads.some(r => r.p_after != null)).toBe(true);
  await previous(page).click();
  await expect(page).toHaveURL(new RegExp(`sel=${id(50)}`));
  expect(state.reads.some(r => r.p_before != null)).toBe(true);
  expect(state.commits).toBe(0);
});

test("new and callback filters use server counts across the whole job", async ({ page }) => {
  const state = await fixtures(page, [opening(1), opening(2, { qc: { status: "callback" } }), opening(3, { qc: { status: "passed" } })]);
  await page.goto("/qc");
  await page.getByRole("button", { name: "Callbacks", exact: true }).click();
  await expect(page.getByText("U-002", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("U-001", { exact: true }).first()).toHaveCount(0);
  await page.getByRole("button", { name: "New", exact: true }).click();
  await expect(page.getByText("U-001", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("U-003", { exact: true }).first()).toHaveCount(0);
  expect(state.reads.some(r => r.p_filter === "callbacks")).toBe(true);
  expect(state.reads.some(r => r.p_filter === "new")).toBe(true);
});

test("a failed save keeps its unit and retries the exact command once", async ({ page }) => {
  const state = await fixtures(page, [opening(1), opening(2)]);
  state.failSave = true;
  await page.goto(`/qc?job=${JOB}&sel=${id(1)}`);
  await pass(page).click();
  await expect.poll(() => state.writes.length).toBe(1);
  await expect(page.getByRole("alert").first()).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`sel=${id(1)}`));
  await expect(page.getByText("private_fixture_failure", { exact: false })).toHaveCount(0);
  state.failSave = false;
  await page.getByRole("button", { name: "Retry save", exact: true }).click();
  await expect.poll(() => state.commits).toBe(1);
  expect(state.writes[1]).toEqual(state.writes[0]);
  await expect(page).toHaveURL(new RegExp(`sel=${id(1)}`));
  await next(page).click();
  await expect(page).toHaveURL(new RegExp(`sel=${id(2)}`));
});

test("a lost receipt retries its immutable ID without a second commit", async ({ page }) => {
  const state = await fixtures(page, [opening(1), opening(2)]);
  state.loseNextReceipt = true;
  await page.goto(`/qc?job=${JOB}&sel=${id(1)}`);
  await pass(page).click();
  await expect(page.getByRole("alert").first()).toBeVisible();
  expect(state.commits).toBe(1);
  await page.getByRole("button", { name: "Retry save", exact: true }).click();
  await expect.poll(() => state.writes.length).toBe(2);
  expect(state.writes[1]).toEqual(state.writes[0]);
  expect(state.commits).toBe(1);
  await expect(page).toHaveURL(new RegExp(`sel=${id(1)}`));
});

test("double tap cannot send two competing commands", async ({ page }) => {
  const state = await fixtures(page, [opening(1), opening(2)]);
  await page.goto(`/qc?job=${JOB}&sel=${id(1)}`);
  await pass(page).evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
  await expect.poll(() => state.commits).toBe(1);
  expect(state.writes).toHaveLength(1);
});

test("a changed review refuses stale save until refresh and a new explicit decision", async ({ page }) => {
  const state = await fixtures(page, [opening(1)]);
  state.staleNextSave = true;
  await page.goto(`/qc?job=${JOB}&sel=${id(1)}`);
  await pass(page).click();
  await expect(page.getByText("This unit changed since you loaded it. Refresh the list and review it again.", { exact: true })).toBeVisible();
  expect(state.commits).toBe(0);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await pass(page).click();
  await expect.poll(() => state.commits).toBe(1);
  expect(state.writes[1].p_decision_id).not.toBe(state.writes[0].p_decision_id);
  expect(state.writes[1].p_expected_review_version).not.toBe("none");
});

test("failed queue reads are unavailable instead of an empty or zero-count queue", async ({ page }) => {
  const state = await fixtures(page, [opening(1)]);
  state.failQueue = true;
  await page.goto(`/qc?job=${JOB}`);
  await expect(page.getByText("This list could not load.", { exact: false })).toBeVisible();
  await expect(page.getByText("No units match this search and filter.", { exact: true })).toHaveCount(0);
  await expect(pass(page)).toHaveCount(0);
  state.failQueue = false;
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(pass(page)).toBeVisible();
  expect(state.commits).toBe(0);
});

test("corrupt restored state cannot authorize or send a decision", async ({ page }) => {
  await fixtures(page, [opening(1)]);
  await page.addInitScript(({ viewer }) => {
    sessionStorage.setItem(`qcReview:v1:${viewer}`, "{corrupt");
  }, { viewer: TEST_USER.id });
  await page.goto("/qc?job=not-a-job&sel=wrong&filter=unknown&after=bad");
  await expect(search(page)).toBeVisible();
  await expect(page.getByText("private_fixture_failure", { exact: false })).toHaveCount(0);
  await expect(page.getByText("U-001", { exact: true }).first()).toBeVisible();
});

for (const variant of [{ language: "en" as const, width: 1280, label: "Next" }, { language: "es" as const, width: 375, label: "Siguiente" }]) {
  test(`review controls fit ${variant.language} ${variant.width}px and keyboard navigation keeps selection`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: variant.width, height: 844 });
    await fixtures(page, [opening(1), opening(2)], variant.language);
    await hideWrongProjectBanner(page);
    await page.goto(`/qc?job=${JOB}&sel=${id(1)}`);
    const control = page.getByRole("button", { name: variant.label, exact: true });
    await control.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`sel=${id(2)}`));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`qc-flow-${variant.language}-${variant.width}.png`), fullPage: true });
  });
}

test("duplicate unit codes stay scoped to the chosen job", async ({ page }) => {
  const other = "21000000-0000-4000-8000-000000000002";
  const state = await fixtures(page, [opening(1, { opening_code: "A1", label: "Alpha unit" }),
    opening(2, { project_id: other, opening_code: "A1", label: "Beta unit", projects: { job_code: "QC-BETA", name: "Beta test job" } })]);
  await page.goto("/qc");
  await expect(page.getByText("Choose a job", { exact: true })).toBeVisible();
  expect(state.reads).toHaveLength(0);
  await page.getByRole("button", { name: /QC-BETA/ }).click();
  await expect(page.getByText("Beta unit", { exact: true })).toBeVisible();
  await expect(page.getByText("Alpha unit", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "View unit details", exact: true }).click();
  await pass(page).click();
  await expect.poll(() => state.commits).toBe(1);
  expect(state.writes[0].p_project_id).toBe(other);
  expect(state.writes[0].p_opening_id).toBe(id(2));
});

test("a restored job beyond the first 50 displays canonical identity without scanning", async ({ page }) => {
  const units = Array.from({ length: 55 }, (_, i) => opening(i + 1, {
    project_id: `23000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
    projects: { job_code: `JOB-${i + 1}`, name: `Job ${String(i + 1).padStart(3, "0")}` },
  }));
  const state = await fixtures(page, units);
  await page.goto(`/qc?job=${units[54].project_id}&sel=${id(55)}`);
  await expect(page.getByText(/JOB-55 · Job 055/).first()).toBeVisible();
  expect(state.jobsReads.some(r => r.p_selected_project_id === units[54].project_id)).toBe(true);
  expect(state.jobsReads.every(r => r.p_after == null)).toBe(true);
});

test("job search reaches jobs beyond the first page", async ({ page }) => {
  const units = Array.from({ length: 55 }, (_, i) => opening(i + 1, {
    project_id: `23000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
    projects: { job_code: `JOB-${i + 1}`, name: `Job ${String(i + 1).padStart(3, "0")}` },
  }));
  await fixtures(page, units);
  await page.goto("/qc");
  await page.getByPlaceholder("Search jobs by code or name").fill("JOB-55");
  await page.getByRole("button", { name: /JOB-55/ }).click();
  await expect(page.getByText("U-055", { exact: true })).toBeVisible();
});

test("callback draft blocks history and movement until explicit cancel", async ({ page }) => {
  const state = await fixtures(page, [opening(1), opening(2)]);
  await page.goto(`/qc?job=${JOB}&sel=${id(1)}`);
  await page.getByRole("button", { name: "Callback", exact: true }).first().click();
  await page.getByLabel("Callback note", { exact: true }).fill("Sill needs another check");
  await expect(page.getByRole("button", { name: "Review history", exact: true })).toBeDisabled();
  await expect(next(page)).toBeDisabled();
  await expect(search(page)).toBeDisabled();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await next(page).click();
  await expect(page).toHaveURL(new RegExp(`sel=${id(2)}`));
  expect(state.commits).toBe(0);
});

test("a saved callback with failed learning retries learning alone and preserves the service offer", async ({ page }) => {
  const state = await fixtures(page, [opening(1, { assigned_window_id: "24000000-0000-4000-8000-000000000001" }), opening(2)]);
  let failLearning = true;
  let learningWrites = 0;
  await page.route("**/rest/v1/learn_priority_terms**", route => {
    learningWrites++;
    return failLearning ? route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "private_learning_failed" }) }) : json(route, null);
  });
  await page.goto(`/qc?job=${JOB}&sel=${id(1)}`);
  await page.getByRole("button", { name: "Callback", exact: true }).first().click();
  const terms = page.getByLabel("Root-cause term", { exact: true });
  const value = await terms.locator("option").nth(1).getAttribute("value");
  await terms.selectOption(value!);
  await page.getByRole("button", { name: "Log callback", exact: true }).click();
  await expect(page.getByText("The QC decision was already recorded. Only the learning update failed — retry just that.", { exact: false })).toBeVisible();
  expect(state.commits).toBe(1);
  await expect(next(page)).toBeDisabled();
  failLearning = false;
  await page.getByRole("button", { name: "Retry learning update", exact: true }).click();
  await expect.poll(() => learningWrites).toBe(2);
  expect(state.writes).toHaveLength(1);
  await expect(next(page)).toBeDisabled();
  await page.getByRole("button", { name: "Not now", exact: true }).click();
  await next(page).click();
  await expect(page).toHaveURL(new RegExp(`sel=${id(2)}`));
});

test("the full unit record and browser Back preserve the QC job, search and selected unit", async ({ page }) => {
  await fixtures(page, [opening(1), opening(2)]);
  await page.goto(`/qc?job=${JOB}&q=U-002&sel=${id(2)}`);
  await page.getByRole("link", { name: "U-002", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${JOB}/opening/${id(2)}`));
  await page.goBack();
  await expect(search(page)).toHaveValue("U-002");
  await expect(page).toHaveURL(new RegExp(`sel=${id(2)}`));
  await expect(page.getByRole("region", { name: "Unit details", exact: true })).toBeVisible();
});

test("a committed save stays visible when the refreshed queue fails", async ({ page }) => {
  const state = await fixtures(page, [opening(1), opening(2)]);
  await page.goto(`/qc?job=${JOB}&sel=${id(1)}`);
  await expect(page.getByRole("region", { name: "Unit details", exact: true })).toBeVisible();
  state.failQueue = true;
  await pass(page).click();
  await expect.poll(() => state.commits).toBe(1);
  await expect(page.getByText(/You passed this unit/)).toBeVisible();
  await expect(page.getByRole("region", { name: "Unit details", exact: true })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`sel=${id(1)}`));
});

test("ending the auth generation removes unit media and rejects a late AI result", async ({ page }) => {
  await fixtures(page, [opening(1)]);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let arrived = false;
  await page.route("**/functions/v1/review-qc-photo", async route => {
    arrived = true;
    await held;
    await json(route, { openingId: id(1), photoId: "fixture", photoCreatedAt: "2026-10-01T12:00:00Z",
      review: { summary: "Previous login's delayed AI review", visible_checks: [], questions_for_foreman: [], limitation: "Fixture" } });
  });
  await page.goto(`/qc?job=${JOB}&sel=${id(1)}`);
  await page.getByRole("button", { name: "AI photo review", exact: true }).click();
  await expect.poll(() => arrived).toBe(true);
  // Exercise the application's auth-subject store, with no real login/write.
  await page.evaluate(async () => {
    const path = "/src/lib/signedIn.ts";
    const auth = await import(/* @vite-ignore */ path);
    auth.rememberSignedIn(null);
  });
  await expect(page.getByRole("region", { name: "Unit details", exact: true })).toHaveCount(0);
  release();
  await page.evaluate(async (viewer) => {
    const path = "/src/lib/signedIn.ts";
    const auth = await import(/* @vite-ignore */ path);
    auth.rememberSignedIn({ user: { id: viewer } });
  }, TEST_USER.id);
  await expect(search(page)).toBeVisible();
  await expect(page.getByText("Previous login's delayed AI review", { exact: true })).toHaveCount(0);
});

test("an uncertain committed save recovers the exact request after a deliberate reload", async ({ page }) => {
  const state = await fixtures(page, [opening(1)]);
  state.loseNextReceipt = true;
  await page.goto(`/qc?job=${JOB}&sel=${id(1)}`);
  await pass(page).click();
  await expect(page.getByRole("button", { name: "Retry save", exact: true })).toBeVisible();
  const original = { ...state.writes[0] };
  page.once("dialog", dialog => void dialog.accept());
  await page.reload();
  await page.getByRole("button", { name: "Retry save", exact: true }).click();
  await expect.poll(() => state.writes.length).toBe(2);
  expect(state.writes[1]).toEqual(original);
  expect(state.commits).toBe(1);
  await expect(page.getByText("You passed this unit.", { exact: true })).toBeVisible();
});

test("a failed stale-review refresh keeps the decision gate closed", async ({ page }) => {
  const state = await fixtures(page, [opening(1)]);
  state.staleNextSave = true;
  await page.goto(`/qc?job=${JOB}&sel=${id(1)}`);
  await pass(page).click();
  await expect(page.getByText("This unit changed since you loaded it. Refresh the list and review it again.", { exact: true })).toBeVisible();
  state.failQueue = true;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByText("This list could not load.", { exact: false })).toBeVisible();
  expect(state.writes).toHaveLength(1);
  expect(state.commits).toBe(0);
  // A failed fresh read cannot turn the cached unit into a new save target.
  if (await pass(page).count()) await expect(pass(page)).toBeDisabled();
  state.failQueue = false;
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(pass(page)).toBeEnabled();
  await pass(page).click();
  await expect.poll(() => state.commits).toBe(1);
  expect(state.writes[1].p_expected_review_version).not.toBe("none");
});

test("a callback draft keeps its original version when a background read changes the unit", async ({ page }) => {
  const state = await fixtures(page, [opening(1), opening(2)]);
  await page.goto(`/qc?job=${JOB}&sel=${id(1)}`);
  await page.getByRole("button", { name: "Callback", exact: true }).first().click();
  await page.getByLabel("Callback note", { exact: true }).fill("Inspect sill again");
  state.units[0].qcStatus = "callback";
  state.units[0].reviewVersion = "30000000-0000-4000-8000-999999999998";
  const readsBefore = state.reads.length;
  await page.evaluate(async () => {
    const path = "/src/lib/queryClient.ts";
    const cache = await import(/* @vite-ignore */ path);
    await cache.queryClient.invalidateQueries({ queryKey: ["qcReviewPage"] });
  });
  await expect.poll(() => state.reads.length).toBeGreaterThan(readsBefore);
  await expect(page.getByLabel("Callback note", { exact: true })).toHaveValue("Inspect sill again");
  const log = page.getByRole("button", { name: "Log callback", exact: true });
  // Either reject before dispatch, or let the guarded original-version command
  // receive the server's stale refusal. Never silently send the new version.
  if (await log.isEnabled()) {
    await log.click();
    await expect.poll(() => state.writes.length).toBe(1);
    expect(state.writes[0].p_expected_review_version).toBe("none");
  }
  expect(state.commits).toBe(0);
});

test("loading another jobs page keeps earlier choices and reaches the last job", async ({ page }) => {
  const units = Array.from({ length: 55 }, (_, i) => opening(i + 1, {
    project_id: `23000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
    projects: { job_code: `JOB-${i + 1}`, name: `Job ${String(i + 1).padStart(3, "0")}` },
  }));
  const state = await fixtures(page, units);
  await page.goto("/qc");
  await page.getByRole("button", { name: "Load more jobs", exact: true }).click();
  await expect(page.getByRole("button", { name: /^JOB-1 Job 001/ })).toBeVisible();
  await page.getByRole("button", { name: /^JOB-55 Job 055/ }).click();
  await expect(page.getByText("U-055", { exact: true })).toBeVisible();
  expect(state.jobsReads.some(r => r.p_after != null)).toBe(true);
});

test("a jobs failure is unavailable rather than an empty job list", async ({ page }) => {
  const state = await fixtures(page, [opening(1), opening(2, {
    project_id: "21000000-0000-4000-8000-000000000002", projects: { job_code: "QC-BETA", name: "Beta" },
  })]);
  state.failJobs = true;
  await page.goto("/qc");
  await expect(page.getByText("Jobs could not load.", { exact: false })).toBeVisible();
  await expect(page.getByText("No jobs match that search.", { exact: true })).toHaveCount(0);
  await expect(pass(page)).toHaveCount(0);
  expect(state.reads).toHaveLength(0);
});

test("a callback draft remains cancellable when its unit disappears from a refreshed queue", async ({ page }) => {
  const state = await fixtures(page, [opening(1), opening(2)]);
  await page.goto(`/qc?job=${JOB}&sel=${id(1)}`);
  await page.getByRole("button", { name: "Callback", exact: true }).first().click();
  await page.getByLabel("Callback note", { exact: true }).fill("Keep this unfinished review");
  state.units.splice(0, 1);
  await page.evaluate(async () => {
    const path = "/src/lib/queryClient.ts";
    const cache = await import(/* @vite-ignore */ path);
    await cache.queryClient.invalidateQueries({ queryKey: ["qcReviewPage"] });
  });
  await expect(page.getByLabel("Callback note", { exact: true })).toHaveValue("Keep this unfinished review");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("button", { name: "Review history", exact: true })).toBeEnabled();
  expect(state.commits).toBe(0);
});

test("the selected review and navigation stay near the top of a phone with a large queue", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 844 });
  await fixtures(page, Array.from({ length: 63 }, (_, i) => opening(i + 1)));
  await page.goto(`/qc?job=${JOB}&sel=${id(63)}`);
  await expect(next(page)).toBeVisible();
  const nav = await next(page).boundingBox();
  expect(nav).not.toBeNull();
  expect(nav!.y + nav!.height).toBeLessThan(844);
  await expect(page.getByRole("region", { name: "Unit details", exact: true })).toBeVisible();
  const details = await page.getByRole("region", { name: "Unit details", exact: true }).boundingBox();
  expect(details!.y).toBeLessThan(844);
});


test("a callback draft survives blocked global navigation and browser Back until Cancel", async ({ page }) => {
  const state = await fixtures(page, [opening(1)]);
  await page.addInitScript(() => {
    (window as unknown as { qcPopSeen: number }).qcPopSeen = 0;
    // Observe before the app's capture guard can stop propagation in WebKit.
    window.addEventListener("popstate", () => { (window as unknown as { qcPopSeen: number }).qcPopSeen += 1; }, true);
  });
  await page.goto("/team");
  await page.getByRole("link", { name: /installs to QC/ }).click();
  await page.getByRole("button", { name: "Callback", exact: true }).first().click();
  await page.getByLabel("Callback note", { exact: true }).fill("Check the sill before leaving");
  const qcUrl = page.url();
  await page.getByRole("link", { name: "Ask", exact: true }).click();
  await expect(page).toHaveURL(qcUrl);
  await expect(page.getByLabel("Callback note", { exact: true })).toHaveValue("Check the sill before leaving");
  // The component reverses a real SPA POP and keeps its matching history entry.
  await page.evaluate(() => window.history.back());
  await expect.poll(() => page.evaluate(() => (window as unknown as { qcPopSeen: number }).qcPopSeen)).toBeGreaterThan(0);
  await expect(page.getByText("Finish or cancel the current review first. For a saved callback, retry or choose Not now for its follow-up.", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(qcUrl);
  await expect(page.getByLabel("Callback note", { exact: true })).toHaveValue("Check the sill before leaving");
  expect(state.commits).toBe(0);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.goBack();
  await expect(page).toHaveURL(/\/team$/);
});

test("an unavailable submitted-command store refuses the write and leaves the draft editable", async ({ page }) => {
  const state = await fixtures(page, [opening(1)]);
  await page.goto(`/qc?job=${JOB}&sel=${id(1)}`);
  await page.getByRole("button", { name: "Callback", exact: true }).first().click();
  await page.getByLabel("Callback note", { exact: true }).fill("Keep this note until saving is available");
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key.startsWith("qcReview:submitted:")) throw new DOMException("Fixture storage denied", "QuotaExceededError");
      return original.call(this, key, value);
    };
  });
  await page.getByRole("button", { name: "Log callback", exact: true }).click();
  await expect(page.getByText("No new save was sent. This phone could not retain the exact request for safe recovery. Restore session storage and try again, or reload to recover an earlier submission.", { exact: true })).toBeVisible();
  expect(state.writes).toHaveLength(0);
  await expect(page.getByLabel("Callback note", { exact: true })).toHaveValue("Keep this note until saving is available");
  await expect(page.getByRole("button", { name: "Log callback", exact: true })).toBeEnabled();
});


test("an uncertain saved command survives browser Back and retries its original receipt", async ({ page }) => {
  const state = await fixtures(page, [opening(1)]);
  state.loseNextReceipt = true;
  await page.addInitScript(() => {
    (window as unknown as { qcPopSeen: number }).qcPopSeen = 0;
    window.addEventListener("popstate", () => { (window as unknown as { qcPopSeen: number }).qcPopSeen += 1; }, true);
  });
  await page.goto("/team");
  await page.getByRole("link", { name: /installs to QC/ }).click();
  await pass(page).click();
  await expect(page.getByRole("button", { name: "Retry save", exact: true })).toBeVisible();
  const original = { ...state.writes[0] };
  const qcUrl = page.url();
  await page.evaluate(() => window.history.back());
  await expect.poll(() => page.evaluate(() => (window as unknown as { qcPopSeen: number }).qcPopSeen)).toBeGreaterThan(0);
  await expect(page).toHaveURL(qcUrl);
  await page.getByRole("button", { name: "Retry save", exact: true }).click();
  await expect.poll(() => state.writes.length).toBe(2);
  expect(state.writes[1]).toEqual(original);
  expect(state.commits).toBe(1);
  await expect(page.getByText("You passed this unit.", { exact: true })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/team$/);
});

test("Back during the selected-unit history write keeps the complete entry and original save", async ({ page }) => {
  const state = await fixtures(page, [opening(1)]);
  state.loseNextReceipt = true;
  await page.addInitScript(() => {
    const probe = { triggered: false, selectedUrl: "", pops: 0 };
    (window as unknown as { qcEagerBack: typeof probe }).qcEagerBack = probe;
    window.addEventListener("popstate", () => { probe.pops += 1; }, true);
    const replace = History.prototype.replaceState;
    History.prototype.replaceState = function (data, unused, url) {
      replace.call(this, data, unused, url);
      if (!probe.triggered && new URL(window.location.href).searchParams.has("sel")) {
        probe.triggered = true;
        probe.selectedUrl = window.location.href;
        // Real native navigation before React's delayed location effect settles.
        queueMicrotask(() => window.history.back());
      }
    };
  });
  await page.goto("/team");
  await page.getByRole("link", { name: /installs to QC/ }).click();
  await pass(page).click();
  await expect(page.getByRole("button", { name: "Retry save", exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as unknown as { qcEagerBack: { pops: number } }).qcEagerBack.pops)).toBeGreaterThanOrEqual(2);
  const selectedUrl = await page.evaluate(() => (window as unknown as { qcEagerBack: { selectedUrl: string } }).qcEagerBack.selectedUrl);
  expect(new URL(selectedUrl).searchParams.get("sel")).toBe(id(1));
  await expect(page).toHaveURL(selectedUrl);
  const original = { ...state.writes[0] };
  await page.getByRole("button", { name: "Retry save", exact: true }).click();
  await expect.poll(() => state.writes.length).toBe(2);
  expect(state.writes[1]).toEqual(original);
  expect(state.commits).toBe(1);
  await expect(page.getByText("You passed this unit.", { exact: true })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/team$/);
});


test.describe("new phone design QC review", () => {
  test.use({ hasTouch: true });
  for (const variant of [{ language: "en" as const, width: 390, nextLabel: "Next", details: "Unit details" },
    { language: "es" as const, width: 375, nextLabel: "Siguiente", details: "Detalles de la unidad" }]) {
    test(`selected evidence and touch review work in ${variant.language} at ${variant.width}px`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width: variant.width, height: 844 });
      const state = await fixtures(page, [opening(1), opening(2)], variant.language, "new");
      await hideWrongProjectBanner(page);
      await page.goto(`/qc?job=${JOB}&sel=${id(1)}`);
      await expect(page.locator("html")).toHaveAttribute("data-design", "new");
      const control = page.getByRole("button", { name: variant.nextLabel, exact: true });
      await control.tap();
      await expect(page).toHaveURL(new RegExp(`sel=${id(2)}`));
      await expect(page.getByRole("region", { name: variant.details, exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(state.commits).toBe(0);
      await page.screenshot({ path: testInfo.outputPath(`qc-new-flow-${variant.language}-${variant.width}.png`), fullPage: true });
    });
  }
});
