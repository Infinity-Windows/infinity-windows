import { expect, test } from "@playwright/test";
import { useSupabaseFixtures, TEST_USER } from "./support/supabaseFixtures";
import { json, hideWrongProjectBanner } from "./support/specHelpers";

for (const role of ["installer", "foreman", "supervisor"] as const) {
  test(`${role} sees the project and start time before clocking in`, async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 844 });
    await useSupabaseFixtures(page, { role });
    await hideWrongProjectBanner(page);
    const today = new Date().toLocaleDateString("en-CA");
    const row = (id: string, start_time: string | null, status = "published") => ({
      id, project_id: "fixture-job", kind: "install", status, start_date: today, end_date: today, start_time, end_time: "15:00",
      projects: { id: "fixture-job", job_code: id, name: "A long project name that must remain readable on an iPhone" },
      schedule_assignment_members: [{ profile_id: TEST_USER.id, role: "installer", profiles: { display_name: "Fixture crew" } }],
    });
    let start = "06:30";
    await page.route("**/rest/v1/schedule_assignment_members**", r => json(r, [{ assignment_id: "EARLY" }, { assignment_id: "LATE" }]));
    await page.route("**/rest/v1/schedule_assignments**", r => json(r, [row("LATE", "13:00"), row("EARLY", start), row("DRAFT", "05:00", "draft")]));
    await page.goto("/");
    const bar = page.getByRole("region", { name: "Your schedule" });
    await expect(bar).toBeVisible();
    await expect(bar.locator(".crew-start-row").first()).toContainText("Start 6:30 AM–3:00 PM");
    await expect(bar.locator(".crew-start-row").first()).toContainText("EARLY");
    await expect(bar.locator(".crew-start-row")).toHaveCount(2);
    await expect(bar).not.toContainText("DRAFT");
    expect((await bar.boundingBox())!.y).toBeLessThan(600);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (role === "installer") await page.screenshot({ path: "/tmp/forge-crew-start-phone.png" });
    start = "07:15";
    await expect(bar.locator(".crew-start-row").first()).toContainText("Start 7:15 AM–3:00 PM", { timeout: 22000 });
    await bar.getByRole("link", { name: /View schedule/ }).click();
    await expect(page).toHaveURL(/my-schedule/);
  });
}

test("Spanish crew sees next assignment and an honest missing start time", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "installer", language: "es" });
  await hideWrongProjectBanner(page);
  const d = new Date(); d.setDate(d.getDate() + 1); const tomorrow = d.toLocaleDateString("en-CA");
  await page.route("**/rest/v1/schedule_assignment_members**", r => json(r, [{ assignment_id: "NEXT" }]));
  await page.route("**/rest/v1/schedule_assignments**", r => json(r, [{ id: "NEXT", project_id: "fixture-job", kind: "install", status: "published", start_date: tomorrow, end_date: tomorrow, start_time: null,
    projects: { id: "fixture-job", job_code: "NEXT", name: "Next job" }, schedule_assignment_members: [{ profile_id: TEST_USER.id, role: "installer" }] }]));
  await page.goto("/");
  const bar = page.getByRole("region", { name: "Tu horario" });
  await expect(bar).toContainText("Hora sin definir");
  await expect(bar).toContainText("NEXT");
});
