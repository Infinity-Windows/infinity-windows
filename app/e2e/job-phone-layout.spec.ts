import { expect, test } from "@playwright/test";
import { jobFixtures, useSupabaseFixtures } from "./support/supabaseFixtures";
import { hideWrongProjectBanner, json } from "./support/specHelpers";

const job = jobFixtures().find((row) => row.jobCode === "BLACK22")!;

for (const width of [320, 375, 390, 430, 1280]) {
  test(`job overview stays centered and readable at ${width}px`, async ({ page, browserName }) => {
    await page.setViewportSize({ width, height: 844 });
    const newDesign = width === 375 || width === 390;
    await useSupabaseFixtures(page, { role: "owner", uiDesign: newDesign ? "new" : "classic" });
    await page.route("**/rest/v1/company_settings**", (route) => json(route, { id: 1, new_design_r1_enabled: true }, 1));
    await hideWrongProjectBanner(page);
    await page.addInitScript(() => localStorage.setItem("infinity.theme", "dark"));
    const project = {
      id: job.projectId,
      job_code: "BLACK22",
      name: "Black Desert",
      status: "active",
      allowed_modes: [width >= 430 ? "data" : "tracking"],
      is_test: false,
      start_date: "2026-08-05",
      end_date: "2026-08-26",
      customer_name: "Site office",
      contact_email: width === 390 ? "office@example.com" : `${"long-contact".repeat(12)}@example.com`,
      notes: width === 390 ? "Confirm access with the site office." : "LongJobReference".repeat(24),
    };
    await page.route("**/rest/v1/projects**", (route) => json(route, [project], 1));
    // Give the two lazy overview cards complete read-only server fixtures.
    // Their late insertion is the leading candidate in retained69e8's failed click.
    await page.route("**/rest/v1/rpc/work_job_menu_choices", (route) => json(route, {
      protocolVersion: 1, projectId: job.projectId, asOf: "2026-10-05T12:00:00Z",
      currentRevision: 0, currentSelection: null, choices: [],
    }, null));
    await page.route("**/rest/v1/rpc/work_job_capability_grants", (route) => json(route, {
      protocolVersion: 1, projectId: job.projectId, grants: [],
    }, null));
    await page.route("**/rest/v1/rpc/crew_goal_summary", (route) => json(route, {
      goal_hours: null, goal_revision: null, goal_updated_at: null,
      recorded_hours: 0, running_provisional_hours: 0, open_shifts: 0,
      unresolved_shifts: 0, allowance_hours: null, as_of: "2026-10-05T12:00:00Z",
    }, null));
    await page.goto(`/projects/${job.projectId}`);
    if (newDesign) await expect(page.getByRole("navigation", { name: "Main" }).getByText("Work", { exact: true })).toBeVisible();

    // Measure the complete overview, then retain the original single native
    // Edit click and mandatory editor/overflow assertions. Loading-time
    // interaction is a separate unresolved acceptance case.
    await expect(page.locator(".work-job-configuration").getByText("There are no eligible published menus.", { exact: true })).toBeVisible();
    await expect(page.locator(".work-job-configuration").getByText("No active foreman permissions.", { exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "Crew goal", exact: true }).getByRole("heading", { name: "Crew goal", exact: true })).toBeVisible();

    const testing = page.locator("section", { has: page.getByRole("heading", { name: "Testing", exact: true }) });
    const details = page.locator("section", { has: page.getByRole("heading", { name: /^(Edit )?job details$/i }) });
    await expect(testing).toBeVisible();
    const checkbox = testing.getByRole("checkbox", { name: /Testing project/ });
    await expect(checkbox).not.toBeChecked();
    const box = (await checkbox.boundingBox())!;
    expect(box.width).toBeLessThanOrEqual(24);
    expect(box.height).toBeLessThanOrEqual(24);
    expect((await testing.boundingBox())!.height).toBeLessThan(220);
    for (const card of [details, testing]) {
      const bounds = (await card.boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      expect(await card.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

    // Try the same diagonal scroll that displaced the screenshot. The document
    // can move down, but has no horizontal distance available to travel.
    await page.evaluate(() => window.scrollTo(100, 600));
    expect(await page.evaluate(() => scrollX)).toBe(0);
    expect(await page.evaluate(() => scrollY)).toBeGreaterThan(0);

    // Section tabs retain their own sideways scrolling inside the page.
    const tabs = page.locator(".hub-tabs");
    if (width < 500) {
      expect(await tabs.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
      await tabs.evaluate((el) => { el.scrollLeft = el.scrollWidth; });
      expect(await tabs.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
      expect(await page.evaluate(() => scrollX)).toBe(0);
    }

    // Finishing/cancelling still asks before changing a job.
    page.on("dialog", (dialog) => dialog.dismiss());
    await page.getByRole("button", { name: "Finish this job…", exact: true }).click();
    await expect(page.getByRole("button", { name: "Cancel this job…", exact: true })).toBeVisible();

    // The date editor must fit too, including Safari's native date inputs.
    await details.getByRole("button", { name: "Edit", exact: true }).click();
    await expect(details.getByRole("heading", { name: "Edit job details" })).toBeVisible();
    expect(await details.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await details.getByRole("button", { name: "Cancel", exact: true }).click();

    if (width === 390) {
      await details.evaluate((el) => window.scrollTo({ top: scrollY + el.getBoundingClientRect().top - 64, behavior: "instant" }));
      await page.screenshot({ path: `e2e/test-results/job-overview-${browserName}-390.png` });
    }
  });
}
