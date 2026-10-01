import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { useSupabaseFixtures as installSupabaseFixtures, TEST_USER } from "./support/supabaseFixtures";
import { json, hideWrongProjectBanner } from "./support/specHelpers";

interface FixtureOptions {
  firstStart?: string | null;
  firstEnd?: string | null;
  role?: "supervisor" | "foreman";
  language?: "en" | "es";
  canceled?: boolean;
  thirdUnknown?: boolean;
  longNames?: boolean;
}

async function installConflictFixtures(page: Page, secondStart: string | null, secondEnd: string | null = "17:00:00", options: FixtureOptions = {}) {
  await installSupabaseFixtures(page, { role: options.role ?? "supervisor", language: options.language ?? "en" });
  await hideWrongProjectBanner(page);
  const day = new Date().toLocaleDateString("en-CA");
  const projects = [
    { id: "fixture-job", job_code: "TIME-ONE", name: "First fixture job" },
    { id: "fixture-job-b", job_code: "TIME-TWO", name: "Second fixture job" },
    { id: "fixture-job-c", job_code: "TIME-THREE", name: "Third fixture job" },
  ];
  if (options.longNames) {
    projects[0].job_code = "TIME-ONE-WITH-A-LONG-JOB-CODE-FOR-PHONE-WRAPPING";
    projects[1].job_code = "TIME-TWO-WITH-A-LONG-JOB-CODE-FOR-PHONE-WRAPPING";
  }
  const row = (id: string, projectIndex: number, start: string | null, end: string | null, status = "draft") => ({
    id, project_id: projects[projectIndex].id, kind: "install", status, start_date: day, end_date: day,
    start_time: start, end_time: end, created_at: "2026-09-30T12:00:00Z", updated_at: "2026-09-30T12:00:00Z",
    projects: projects[projectIndex],
    schedule_assignment_members: [{ profile_id: TEST_USER.id, role: "installer", profiles: { display_name: "Fixture crew with a long name for phone scheduling" } }],
  });
  let rows = [
    row("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", 0, options.firstStart === undefined ? "07:00:00" : options.firstStart, options.firstEnd === undefined ? "12:00:00" : options.firstEnd),
    row("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2", 1, secondStart, secondEnd, options.canceled ? "canceled" : "draft"),
  ];
  if (options.thirdUnknown) rows.push(row("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3", 2, null, null));
  const patches: { id: string | null; body: Record<string, unknown> }[] = [];
  await page.route("**/rest/v1/projects**", r => json(r, projects));
  for (const table of ["workflow_plan_assignments", "workflow_plan_trips", "workflow_plans", "schedule_ai_reasons"]) {
    await page.route(`**/rest/v1/${table}**`, r => json(r, []));
  }
  await page.route("**/rest/v1/schedule_assignments**", r => {
    const request = r.request();
    const query = new URL(request.url()).searchParams;
    if (request.method() === "PATCH") {
      const id = query.get("id")?.replace(/^eq\./, "") ?? null;
      const body = request.postDataJSON();
      patches.push({ id, body });
      rows = rows.map(a => a.id === id ? { ...a, ...body } : a);
    }
    const idFilter = query.get("id");
    const statusFilter = query.get("status");
    const result = rows.filter(a => (!idFilter || idFilter.includes(a.id)) && (!statusFilter || statusFilter === `eq.${a.status}` || (statusFilter === "neq.canceled" && a.status !== "canceled")));
    return json(r, result);
  });
  await page.goto("/scheduling");
  await expect(page.getByRole("heading", { name: "Scheduling", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Agenda", exact: true }).click();
  await expect(page.locator(".sched-agenda-item")).toHaveCount(options.canceled ? 1 : rows.length);
  return { patches };
}

async function noHorizontalScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

async function screenshot(page: Page, testInfo: TestInfo, name: string) {
  await noHorizontalScroll(page);
  await page.screenshot({ path: testInfo.outputPath(name), fullPage: true });
}

for (const start of ["13:00:00", "12:00:00"]) {
  test(`same-day shifts beginning ${start} after a noon finish have no conflict banner or publish warning`, async ({ page }) => {
    await installConflictFixtures(page, start);
    await expect(page.locator(".sched-conflict-banner")).toHaveCount(0);
    await page.getByRole("button", { name: /Review & publish/i }).click();
    await expect(page.getByText(/Heads-up: .*double-booked/)).toHaveCount(0);
    await expect(page.getByText(/No conflicts detected/)).toBeVisible();
  });
}

test("overlapping shifts warn; changing the editor time to the boundary clears its warning", async ({ page }) => {
  await installConflictFixtures(page, "11:00:00");
  await expect(page.locator(".sched-conflict-banner")).toContainText("1 double-booking");
  await expect(page.locator(".sched-conflict-banner")).toContainText("Overlap each shared day: 11:00 AM–12:00 PM");
  await expect(page.locator(".sched-conflict-banner")).toContainText("TIME-ONE · 7:00 AM–12:00 PM");
  await expect(page.locator(".sched-conflict-banner")).toContainText("TIME-TWO · 11:00 AM–5:00 PM");
  await page.locator(".sched-conflict-banner").getByRole("button", { name: "Fix", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText(/Double-booked:/)).toBeVisible();
  await expect(dialog).toContainText("TIME-ONE · 7:00 AM–12:00 PM");
  await expect(dialog).toContainText("TIME-TWO · 11:00 AM–5:00 PM");
  await expect(dialog).toContainText("Overlap each shared day: 11:00 AM–12:00 PM");
  await dialog.getByLabel("Crew end time (optional)").fill("11:00");
  await expect(dialog.getByText(/Double-booked:/)).toHaveCount(0);
  await expect(dialog.locator(".sched-chip.is-clash")).toHaveCount(0);
  await dialog.getByLabel("Crew end time (optional)").fill("11:30");
  await expect(dialog.getByText(/Double-booked:/)).toBeVisible();
});

for (const width of [375, 1280]) {
  test(`adding missing hours updates editor, board and publish review at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    const { patches } = await installConflictFixtures(page, "13:00:00", "17:00:00", { firstStart: null, firstEnd: null, longNames: true });
    await expect(page.getByText(/double-book/i)).toHaveCount(0);
    await expect(page.getByText(/hours need review/i).first()).toBeVisible();
    await screenshot(page, testInfo, "hours-review.png");
    const fix = page.getByRole("button", { name: "Fix", exact: true }).first();
    const bounds = await fix.boundingBox();
    expect(bounds?.height).toBeGreaterThanOrEqual(44);
    expect(bounds?.width).toBeGreaterThanOrEqual(44);
    await fix.focus();
    await page.keyboard.press("Enter");
    const editor = page.getByRole("dialog");
    await expect(editor.getByText(/hours need review/i).first()).toBeVisible();
    await expect(editor.locator(".sched-chip.is-clash")).toHaveCount(0);
    await editor.getByLabel("Crew start time (optional)").fill("07:00");
    await expect(editor.getByText(/hours need review/i).first()).toBeVisible();
    await editor.getByLabel("Crew end time (optional)").fill("12:00");
    await expect(editor.getByText(/hours need review/i)).toHaveCount(0);
    await expect(editor.getByText(/double-book/i)).toHaveCount(0);
    await editor.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(editor).toHaveCount(0);
    expect(patches).toHaveLength(1);
    expect(patches[0]).toMatchObject({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", body: { start_time: "07:00", end_time: "12:00" } });
    await expect(page.getByText(/hours need review/i)).toHaveCount(0);
    await expect(page.getByText(/double-book/i)).toHaveCount(0);
    await page.getByRole("button", { name: /Review & publish/i }).click();
    await expect(page.getByText(/No conflicts detected/)).toBeVisible();
    await screenshot(page, testInfo, "resolved-publish-review.png");
  });
}

test("Spanish phone distinguishes incomplete hours from an overlap", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 375, height: 844 });
  await installConflictFixtures(page, "13:00:00", null, { language: "es" });
  await expect(page.getByText(/horas por revisar/i).first()).toBeVisible();
  await expect(page.getByText(/double-book|hours need review/i)).toHaveCount(0);
  await screenshot(page, testInfo, "spanish-hours-review.png");
});

test("foreman sees accurate hours without gaining assignment edit controls", async ({ page }) => {
  await installConflictFixtures(page, "11:00:00", "17:00:00", { role: "foreman" });
  await expect(page.locator(".sched-conflict-banner")).toContainText("TIME-ONE");
  await expect(page.locator(".sched-conflict-banner")).toContainText("TIME-TWO");
  await expect(page.getByRole("button", { name: "Fix", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Review & publish/i })).toHaveCount(0);
});

test("Fix opens the assignment whose hours are missing", async ({ page }) => {
  await installConflictFixtures(page, "13:00:00", null);
  await expect(page.getByText(/hours need review/i).first()).toBeVisible();
  await page.getByRole("button", { name: "Fix", exact: true }).first().click();
  const editor = page.getByRole("dialog");
  await expect(editor.getByLabel("Crew start time (optional)")).toHaveValue(/^13:00(?::00)?$/);
  await expect(editor.getByLabel("Crew end time (optional)")).toHaveValue("");
  await editor.getByLabel("Crew end time (optional)").fill("17:00");
  await expect(editor.getByText(/hours need review/i)).toHaveCount(0);
  await expect(editor.getByText(/double-book/i)).toHaveCount(0);
});

test("confirmed hours and a separate time review are both shown for the same person", async ({ page }) => {
  await installConflictFixtures(page, "11:00:00", "17:00:00", { thirdUnknown: true });
  await expect(page.getByText(/hours need review/i).first()).toBeVisible();
  await expect(page.locator(".sched-conflict-banner").first()).toContainText("TIME-ONE");
  await expect(page.locator(".sched-conflict-banner").first()).toContainText("TIME-TWO");
  await page.getByRole("button", { name: /Review & publish/i }).click();
  const publish = page.getByRole("dialog");
  await expect(publish.getByText("Hours need review: 1 crew member", { exact: true })).toBeVisible();
  const needsReview = publish.locator(".sched-conflict-inline.is-review");
  await expect(needsReview.locator("ul > li")).toHaveCount(1);
  await expect(needsReview.locator(".sched-pair-details")).toHaveCount(2);
  const confirmed = publish.locator(".sched-conflict-inline:not(.is-review)");
  await expect(confirmed.getByText("Heads-up: 1 crew member double-booked", { exact: true })).toBeVisible();
  await expect(confirmed.locator("ul > li")).toHaveCount(1);
  await expect(confirmed.locator(".sched-pair-details")).toHaveCount(1);
  await expect(publish).toContainText("TIME-THREE");
  await expect(publish).toContainText("TIME-ONE");
  await expect(publish).toContainText("TIME-TWO");
  await expect(publish).toContainText("Overlap each shared day: 11:00 AM–12:00 PM");
});

test("Notifications labels unknown hours as review rather than confirmed double booking", async ({ page }) => {
  await installConflictFixtures(page, "13:00:00", null);
  await page.goto("/notifications");
  await expect(page.getByText(/hours need review/i).first()).toBeVisible();
  await expect(page.getByText(/double-book/i)).toHaveCount(0);
});

test("saving resolved hours removes the Notifications time-review notice", async ({ page }) => {
  const { patches } = await installConflictFixtures(page, "13:00:00", "17:00:00", { firstStart: null, firstEnd: null });
  await page.getByRole("button", { name: "Fix", exact: true }).first().click();
  const editor = page.getByRole("dialog");
  await editor.getByLabel("Crew start time (optional)").fill("07:00");
  await editor.getByLabel("Crew end time (optional)").fill("12:00");
  await editor.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(editor).toHaveCount(0);
  expect(patches).toHaveLength(1);
  const loaded = page.waitForResponse(r => r.url().includes("/rest/v1/schedule_assignments") && r.status() === 200);
  await page.goto("/notifications");
  await loaded;
  await expect(page.getByRole("heading", { name: "What needs you", exact: true })).toBeVisible();
  await expect(page.getByText(/hours need review|double-book/i)).toHaveCount(0);
});


test.describe("touch correction", () => {
  test.use({ hasTouch: true });
  test("a phone tap on Fix opens the missing-hours assignment", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 844 });
    await installConflictFixtures(page, "13:00:00", null);
    await page.getByRole("button", { name: "Fix", exact: true }).tap();
    const editor = page.getByRole("dialog");
    await expect(editor.getByLabel("Crew start time (optional)")).toHaveValue(/^13:00(?::00)?$/);
    await expect(editor.getByLabel("Crew end time (optional)")).toHaveValue("");
    await expect(editor.locator(".sched-chip.is-clash")).toHaveCount(0);
  });
});
