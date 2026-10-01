import { expect, test } from "@playwright/test";
import { useSupabaseFixtures } from "./support/supabaseFixtures";
import { hideWrongProjectBanner, json } from "./support/specHelpers";

const jobs = [
  { id: "00000000-0000-4000-8000-000000000003", job_code: "ZEBRA", name: "South site", status: "active" },
  { id: "00000000-0000-4000-8000-000000000001", job_code: "ALPHA", name: "North site", status: "active" },
  { id: "00000000-0000-4000-8000-000000000002", job_code: "PECAN-VALLEY-BLD-QK99", name: "Long project name ".repeat(6), status: "active" },
];

for (const width of [320, 390, 1280]) {
  test(`supplies jobs search and dropdown fit at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    await useSupabaseFixtures(page, { role: "installer", uiDesign: width === 390 ? "new" : "classic" });
    await page.route("**/rest/v1/company_settings**", r => json(r, { id: 1, new_design_r1_enabled: true }, 1));
    await page.addInitScript(() => localStorage.setItem("infinity.theme", "dark"));
    await hideWrongProjectBanner(page);
    await page.route("**/rest/v1/projects**", r => json(r, jobs, jobs.length));
    await page.route("**/rest/v1/supplies**", r => json(r, [{ id: "supply1", name: "Caulk", unit: "tube", on_hand: 10 }], 1));
    await page.route("**/rest/v1/supply_orders**", r => json(r, []));
    await page.goto(`/supplies?job=${jobs[0].id}`);
    const picker = page.getByRole("combobox", { name: "Search jobs" });
    await expect(picker).toHaveValue("ZEBRA · South site");
    await expect(page.locator(".job-chip-row")).toHaveCount(0);
    await expect(page.getByRole("listbox")).toHaveCount(0);
    await picker.click();
    const options = page.getByRole("listbox").getByRole("option");
    await expect(options.locator("strong")).toHaveText(["ALPHA", "PECAN-VALLEY-BLD-QK99", "ZEBRA"]);
    const listBox = await page.getByRole("listbox").boundingBox();
    expect(listBox!.height).toBeLessThanOrEqual(280);
    await picker.fill("north");
    await expect(options).toHaveCount(1);
    await expect(options.locator("strong")).toHaveText("ALPHA");
    await picker.press("Escape");
    await expect(picker).toHaveValue("ZEBRA · South site");
    await expect(page.getByRole("listbox")).toHaveCount(0);
    await picker.fill("does not exist");
    await expect(page.getByText("No matching jobs.", { exact: true })).toBeVisible();
    await picker.fill("alpha");
    if (width !== 390) await picker.press("ArrowDown");
    await picker.press("Enter");
    await expect(picker).toHaveValue("ALPHA · North site");
    await expect(page.getByRole("listbox")).toHaveCount(0);
    await picker.click();
    await options.filter({ hasText: "PECAN-VALLEY" }).click();
    await expect(picker).toHaveValue(/^PECAN-VALLEY/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
    await page.getByRole("button", { name: "Take", exact: true }).click();
    const takeJob = page.getByRole("combobox", { name: "For which job" });
    await takeJob.click();
    await takeJob.fill("south");
    await page.getByRole("listbox").getByRole("option").filter({ hasText: "ZEBRA" }).click();
    await expect(takeJob).toHaveValue("ZEBRA · South site");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await picker.scrollIntoViewIfNeeded();
    await picker.click();
    await page.screenshot({ path: testInfo.outputPath(`supplies-job-dropdown-${width}.png`) });
  });
}

test("Spanish job search has alphabetic results and clear empty feedback", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "installer", language: "es" });
  await hideWrongProjectBanner(page);
  await page.route("**/rest/v1/projects**", r => json(r, jobs, jobs.length));
  await page.goto("/supplies");
  const picker = page.getByRole("combobox", { name: "Buscar trabajos" });
  await picker.click();
  await expect(page.getByRole("listbox").getByRole("option").locator("strong")).toHaveText(["ALPHA", "PECAN-VALLEY-BLD-QK99", "ZEBRA"]);
  await picker.fill("missing");
  await expect(page.getByText("No hay trabajos que coincidan.")).toBeVisible();
});


test("Job Costing uses the same A–Z dropdown and keeps table selection", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "owner" });
  await hideWrongProjectBanner(page);
  await page.route("**/rest/v1/projects**", r => json(r, jobs, jobs.length));
  for (const table of ["time_shifts", "project_financials", "job_costs", "change_orders", "pay_rates"]) {
    await page.route(`**/rest/v1/${table}**`, r => json(r, [], 0));
  }
  await page.goto("/costing");
  const picker = page.getByRole("combobox", { name: "Search jobs" });
  await picker.click();
  await expect(page.getByRole("listbox").getByRole("option").locator("strong")).toHaveText(["ALPHA", "PECAN-VALLEY-BLD-QK99", "ZEBRA"]);
  await picker.fill("zebra");
  await page.getByRole("listbox").getByRole("option").click();
  await expect(page.locator(".cost-hero-top > strong")).toHaveText("ZEBRA");
  await page.locator(".analytics-table tbody tr").filter({ hasText: "ALPHA" }).click();
  await expect(picker).toHaveValue("ALPHA");
  await expect(page.locator(".job-chip-row")).toHaveCount(0);
});

test("a long job list scrolls inside the dropdown and Escape can reopen", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "installer" });
  await hideWrongProjectBanner(page);
  const many = Array.from({ length: 45 }, (_, n) => ({ id: `job-${n}`, job_code: `JOB${String(n).padStart(2, "0")}`, name: `Site ${n}` })).reverse();
  await page.route("**/rest/v1/projects**", r => json(r, many, many.length));
  await page.goto("/supplies");
  const picker = page.getByRole("combobox", { name: "Search jobs" });
  await picker.click();
  await expect(page.getByRole("listbox").getByRole("option")).toHaveCount(45);
  const sizes = await page.getByRole("listbox").evaluate(el => ({ height: el.clientHeight, scroll: el.scrollHeight }));
  expect(sizes.height).toBeLessThanOrEqual(280);
  expect(sizes.scroll).toBeGreaterThan(sizes.height);
  await picker.press("Escape");
  await picker.click();
  await expect(page.getByRole("listbox")).toBeVisible();
  await picker.press("ArrowUp");
  await expect(picker).toHaveAttribute("aria-activedescendant", /option-44$/);
  await picker.press("Enter");
  await expect(picker).toHaveValue("JOB44 · Site 44");
});
