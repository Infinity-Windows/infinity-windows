import { expect, test } from "@playwright/test";
import { jobFixtures, useSupabaseFixtures } from "./support/supabaseFixtures";
import { hideWrongProjectBanner, json } from "./support/specHelpers";

const job = jobFixtures().find((row) => row.jobCode === "BLACK22")!;

for (const width of [320, 375, 390, 430, 1280]) {
  test(`job overview stays centered and readable at ${width}px`, async ({ page, browserName }) => {
    await page.setViewportSize({ width, height: 844 });
    await useSupabaseFixtures(page, { role: "owner" });
    await hideWrongProjectBanner(page);
    await page.addInitScript(() => localStorage.setItem("infinity.theme", "dark"));
    const project = {
      id: job.projectId,
      job_code: "BLACK22",
      name: "Black Desert",
      status: "active",
      allowed_modes: ["tracking"],
      is_test: false,
      start_date: "2026-08-05",
      end_date: "2026-08-26",
      customer_name: "Site office",
      contact_email: width === 390 ? "office@example.com" : `${"long-contact".repeat(12)}@example.com`,
      notes: width === 390 ? "Confirm access with the site office." : "LongJobReference".repeat(24),
    };
    await page.route("**/rest/v1/projects**", (route) => json(route, [project], 1));
    await page.goto(`/projects/${job.projectId}`);

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
