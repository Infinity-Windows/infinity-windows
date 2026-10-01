import { expect, test, type Page } from "@playwright/test";
import { jobFixtures, useSupabaseFixtures } from "./support/supabaseFixtures";
import { hideWrongProjectBanner, json } from "./support/specHelpers";

const JOB = jobFixtures()[0];

test.use({ viewport: { width: 390, height: 844 } });

async function overviewRecords(page: Page, issuesFail = false) {
  const at = "2026-10-01T15:15:00Z";
  await page.route("**/rest/v1/**", (route) => {
    const url = new URL(route.request().url());
    const table = url.pathname.split("/").pop();
    const rows: Record<string, unknown[]> = {
      project_scope_counts: [{ project_id: JOB.projectId, openings: 10, installed: 4 }],
      custom_work_units: [
        { id: "custom1", project_id: JOB.projectId, opening_id: null, facts: { installation_complete: "Yes" } },
        { id: "custom2", project_id: JOB.projectId, opening_id: null, facts: { installation_complete: "No" } },
        { id: "linked", project_id: JOB.projectId, opening_id: "o1", facts: { installation_complete: "Yes" } },
      ],
      custom_work_sessions: [{ id: "cs1", project_id: JOB.projectId, started_at: at, ended_at: "2026-10-01T15:45:00Z", outcome: "partial" }],
      unit_sessions: [{ id: "s1", opening_id: "o1", started_at: at, ended_at: "2026-10-01T15:30:00Z", end_reason: "finish", role: "install", opening: { project_id: JOB.projectId } }],
      crew_work_records: [],
      daily_logs: [],
      schedule_assignments: [{
        id: "a1", project_id: JOB.projectId, kind: "install", status: "published",
        start_date: "2026-10-01", end_date: "2026-10-03", start_time: "07:00", end_time: null,
        published_at: "2026-09-30T18:00:00Z", updated_at: "2026-09-30T18:00:00Z", created_at: "2026-09-30T18:00:00Z",
        schedule_assignment_members: [{ profile_id: "p1", role: "foreman", profiles: { display_name: "Jordan" } }],
      }],
    };
    if (table === "list_issues") {
      if (issuesFail) return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ code: "XX000", message: "fixture issue failure" }) });
      return json(route, [{
        id: "attention1", project_id: JOB.projectId, opening_id: "o1", window_id: null,
        kind: "blocker", urgency: "urgent", status: "open", note: "Framing needs correction",
        assigned_to: null, created_by: null, created_at: "2026-09-30T18:00:00Z", resolved_at: null,
      }]);
    }
    if (table === "green_light_items") return json(route, [{ item_key: "plans", label_en: "Plans", answered: true, who: "supervisor" }]);
    if (table && table in rows) return json(route, rows[table], rows[table].length);
    return route.fallback();
  });
}

for (const display of [
  { label: "phone", width: 390, height: 844, lang: "en" as const },
  { label: "desktop", width: 1440, height: 900, lang: "en" as const },
  { label: "Spanish phone", width: 375, height: 667, lang: "es" as const },
]) {
  test(`overview represents mixed work and actionable concerns on ${display.label}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: display.width, height: display.height });
    await page.clock.install({ time: new Date("2026-10-01T16:00:00Z") });
    await useSupabaseFixtures(page, { role: "supervisor", language: display.lang });
    await hideWrongProjectBanner(page);
    await overviewRecords(page);
    await page.goto("/projects");
    const row = page.locator(`article.jo-row[data-job-id="${JOB.projectId}"]`);
    await expect(row).toBeVisible();
    await expect(row).toContainText("Jordan");
    await expect(row).toContainText(display.lang === "es" ? "4 de 10" : "4 of 10");
    await expect(row).toContainText(display.lang === "es" ? "1 de 2" : "1 of 2");
    await expect(page.locator(".jo-attention a[href='/issues?issue=attention1']")).toBeVisible();
    await expect(row.locator("a a")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    if (display.lang === "es") await expect(row).not.toContainText("Reported blocker");
    await page.screenshot({ path: testInfo.outputPath("overview.png"), fullPage: true });
  });
}

test("issue failure leaves recorded progress available and concerns unknown", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-10-01T16:00:00Z") });
  await useSupabaseFixtures(page, { role: "supervisor" });
  await hideWrongProjectBanner(page);
  await overviewRecords(page, true);
  await page.goto("/projects");
  const row = page.locator(`article.jo-row[data-job-id="${JOB.projectId}"]`);
  await expect(row).toContainText("4 of 10 openings installed");
  await expect(row).toContainText("Concern information incomplete");
  await expect(row).not.toContainText("No reported concern");
  await expect(page.getByText("Nothing flagged right now.")).toHaveCount(0);
});

test("Heartbeat bookmark opens Jobs with overview and existing list tools", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "supervisor" });
  await hideWrongProjectBanner(page);
  await page.goto("/heartbeat");
  await expect(page).toHaveURL(/\/projects$/);
  await expect(page.getByRole("heading", { name: "Jobs", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Overview", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("heading", { name: "Heartbeat", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Job list", exact: true }).click();
  await expect(page.locator("a.project-card").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "+ New project", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "Job list", exact: true })).toHaveAttribute("aria-pressed", "true");
});

test("foremen retain their job list without supervisor overview queries", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "foreman" });
  await hideWrongProjectBanner(page);
  let overviewReads = 0;
  page.on("request", (request) => {
    if (/custom_work_units|custom_work_sessions/.test(request.url())) overviewReads += 1;
  });
  await page.goto("/projects");
  await expect(page.locator("a.project-card").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Overview", exact: true })).toHaveCount(0);
  expect(overviewReads).toBe(0);
});

test("an overview issue link selects the exact resolved issue and can return to all issues", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "supervisor" });
  await hideWrongProjectBanner(page);
  const base = {
    project_id: JOB.projectId, opening_id: null, window_id: null,
    kind: "blocker", urgency: "urgent", created_by: null,
    created_at: "2026-09-30T15:00:00Z", resolved_by: null,
  };
  await page.route("**/rest/v1/rpc/list_issues*", (route) => json(route, [
    { ...base, id: "selected", note: "Selected framing concern", status: "resolved", resolved_at: "2026-10-01T15:00:00Z" },
    { ...base, id: "other", note: "Another open concern", status: "open", resolved_at: null },
  ]));
  const selectedRead = page.waitForRequest((request) => new URL(request.url()).searchParams.get("id") === "eq.selected");
  await page.goto("/issues?issue=selected");
  await selectedRead;
  await expect(page.locator(".issue-card")).toHaveCount(1);
  await expect(page.locator(".issue-card")).toContainText("Selected framing concern");
  await page.getByRole("button", { name: "Show all issues" }).click();
  await expect(page.locator(".issue-card")).toHaveCount(1);
  await expect(page.locator(".issue-card")).toContainText("Another open concern");
});

test("a missing selected issue is unavailable rather than an all-clear message", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "supervisor" });
  await hideWrongProjectBanner(page);
  await page.route("**/rest/v1/rpc/list_issues*", (route) => json(route, []));
  await page.goto("/issues?issue=missing");
  await expect(page.getByText("This issue is not available.", { exact: false })).toBeVisible();
  await expect(page.getByText("No open issues — everything's clean.")).toHaveCount(0);
});
