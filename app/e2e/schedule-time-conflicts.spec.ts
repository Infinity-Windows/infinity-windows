import { expect, test, type Page } from "@playwright/test";
import { useSupabaseFixtures, TEST_USER } from "./support/supabaseFixtures";
import { json, hideWrongProjectBanner } from "./support/specHelpers";

async function useTimeConflictFixtures(page: Page, secondStart: string, secondEnd: string | null = "17:00:00") {
  await useSupabaseFixtures(page, { role: "supervisor" });
  await hideWrongProjectBanner(page);
  const day = new Date().toLocaleDateString("en-CA");
  const project = { id: "fixture-job", job_code: "TIME-TEST", name: "Fixture job" };
  const row = (id: string, start: string, end: string | null) => ({
    id, project_id: project.id, kind: "install", status: "draft", start_date: day, end_date: day,
    start_time: start, end_time: end, created_at: "2026-09-30T12:00:00Z", updated_at: "2026-09-30T12:00:00Z",
    projects: project,
    schedule_assignment_members: [{ profile_id: TEST_USER.id, role: "installer", profiles: { display_name: "Fixture crew" } }],
  });
  const rows = [row("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", "07:00:00", "12:00:00"), row("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2", secondStart, secondEnd)];
  await page.route("**/rest/v1/projects**", r => json(r, [project]));
  for (const table of ["workflow_plan_assignments", "workflow_plan_trips", "workflow_plans", "schedule_ai_reasons"]) {
    await page.route(`**/rest/v1/${table}**`, r => json(r, []));
  }
  await page.route("**/rest/v1/schedule_assignments**", r => json(r, rows));
  await page.goto("/scheduling");
  await expect(page.getByRole("heading", { name: "Scheduling", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Agenda", exact: true }).click();
  await expect(page.locator(".sched-agenda-item")).toHaveCount(2);
}

for (const start of ["13:00:00", "12:00:00"]) {
  test(`same-day shifts beginning ${start} after a noon finish have no conflict banner or publish warning`, async ({ page }) => {
    await useTimeConflictFixtures(page, start);
    await expect(page.locator(".sched-conflict-banner")).toHaveCount(0);
    await page.getByRole("button", { name: /Review & publish/i }).click();
    await expect(page.getByText(/Heads-up: .*double-booked/)).toHaveCount(0);
    await expect(page.getByText(/No conflicts detected/)).toBeVisible();
  });
}

test("overlapping shifts warn; changing the editor time to the boundary clears its warning", async ({ page }) => {
  await useTimeConflictFixtures(page, "11:00:00");
  await expect(page.locator(".sched-conflict-banner")).toContainText("1 double-booking");
  await page.locator(".sched-conflict-banner").getByRole("button", { name: "Fix", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText(/Double-booked:/)).toBeVisible();
  await dialog.getByLabel("Crew end time (optional)").fill("11:00");
  await expect(dialog.getByText(/Double-booked:/)).toHaveCount(0);
  await dialog.getByLabel("Crew end time (optional)").fill("11:30");
  await expect(dialog.getByText(/Double-booked:/)).toBeVisible();
});
