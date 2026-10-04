import { expect, test } from "@playwright/test";
import { setupDataTotals, DATA_PROJECT, DATA_OTHER, DATA_UNIT } from "./support/dataTotalsFixture";
import type {} from "./support/dataTotalsHarness";

test("native Data preserves old reports, date filters and Summary while checking General only", async ({ page }, testInfo) => {
  const server = await setupDataTotals(page), panel = page.getByRole("region", { name: "Recorded timer totals" });
  await expect(panel).toBeVisible(); expect(server.totalsCalls).toEqual([]);
  await expect(panel.getByRole("group", { name: "Totals scope", exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "Check totals", exact: true }).click();
  await expect(panel.getByRole("heading", { name: "General activity labor" })).toBeVisible();
  expect(server.totalsCalls).toEqual([{ p_project_id: DATA_PROJECT, p_unit_id: null }]);
  await page.getByLabel("Start date", { exact: true }).fill("2026-09-01");
  await page.getByLabel("End date", { exact: true }).fill("2026-09-15");
  await expect.poll(() => server.reportCalls.at(-1)?.p_from.startsWith("2026-09-01")).toBe(true);
  await expect(panel.getByRole("heading", { name: "General activity labor" })).toBeVisible();
  await expect(panel).toContainText("Separate from the date-range report");
  expect(server.totalsCalls).toHaveLength(1);
  await expect(page.getByText("Legacy worker", { exact: false }).first()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("data-general-phone.png"), fullPage: true });
  await page.getByRole("link", { name: "Summary", exact: true }).click();
  await expect(page.getByText("Summary destination", { exact: false })).toBeVisible();
  expect(server.unexpected).toEqual([]); expect(server.pageErrors).toEqual([]);
});
test("Specific reads one canonical unit and preserves old unit filters without pretending their QC is trusted", async ({ page }, testInfo) => {
  const server = await setupDataTotals(page), panel = page.getByRole("region", { name: "Recorded timer totals" });
  await panel.getByRole("button", { name: "Specific", exact: true }).click();
  await expect(panel.getByRole("combobox", { name: "Choose a unit", exact: true })).toContainText("Unit 42");
  expect(server.totalsCalls).toEqual([]);
  await panel.getByRole("combobox", { name: "Choose a unit", exact: true }).selectOption(DATA_UNIT);
  await expect(panel.getByText("labor hours per 100 sq ft", { exact: false })).toBeVisible();
  expect(server.totalsCalls).toEqual([{ p_project_id: DATA_PROJECT, p_unit_id: DATA_UNIT }]);
  await expect(panel).toContainText("Floor area is unallocated");
  await page.evaluate(() => document.documentElement.dataset.theme = "dark");
  await panel.screenshot({ path: testInfo.outputPath("data-specific-phone.png") });
  await page.getByRole("combobox", { name: "Category", exact: true }).selectOption(JSON.stringify("Window"));
  await expect(page.getByText("No eligible cohort yet", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Legacy window", { exact: false }).first()).toBeVisible();
  expect(server.unexpected).toEqual([]); expect(server.pageErrors).toEqual([]);
});
test("partial and unavailable never look like complete zero; related shifts are separate", async ({ page }) => {
  const server = await setupDataTotals(page), panel = page.getByRole("region", { name: "Recorded timer totals" });
  await panel.getByRole("button", { name: "Specific", exact: true }).click();
  await expect(panel.getByRole("combobox")).toContainText("Unit 42"); server.mode = "partial";
  await panel.getByRole("combobox").selectOption(DATA_UNIT);
  await expect(panel.getByText(/Partial — recorded subtotal/).first()).toBeVisible();
  await expect(panel.getByText("labor hours per 100 sq ft", { exact: false })).toHaveCount(0);
  await panel.locator("summary").click();
  await expect(panel.getByText("Full related shifts, not additional unit or General labor.", { exact: false })).toBeVisible();
  server.mode = "unavailable"; await panel.getByRole("button", { name: "Check totals", exact: true }).click();
  await expect(panel.getByText("Totals are unavailable.", { exact: false })).toBeVisible();
  await expect(panel.locator("time")).toHaveCount(0); await expect(panel.getByText("0:00:00", { exact: true })).toHaveCount(0);
  expect(server.unexpected).toEqual([]); expect(server.pageErrors).toEqual([]);
});
test("profile preview ABA and pagehide require a fresh manual check; job changes clear old totals", async ({ page }) => {
  const server = await setupDataTotals(page), panel = page.getByRole("region", { name: "Recorded timer totals" });
  await panel.getByRole("button", { name: "Check totals", exact: true }).click(); await expect(panel.locator("time")).toBeVisible();
  await page.evaluate(() => { const p = window.dataTotalsFixture.preview(); p.setPreviewRole("installer"); p.setPreviewRole(null); });
  await expect(panel.locator("time")).toHaveCount(0);
  await panel.getByRole("button", { name: "Check totals", exact: true }).click(); await expect(panel.locator("time")).toBeVisible();
  await page.evaluate(() => { window.dispatchEvent(new Event("pagehide")); window.dispatchEvent(new Event("pageshow")); });
  await expect(panel.locator("time")).toHaveCount(0);
  await page.getByRole("combobox", { name: "Job", exact: true }).selectOption(DATA_OTHER);
  await expect(panel.locator("time")).toHaveCount(0); const calls = server.totalsCalls.length;
  await page.waitForTimeout(1100); expect(server.totalsCalls.length).toBe(calls); expect(server.unexpected).toEqual([]); expect(server.pageErrors).toEqual([]);
});
test("production OFF gate and foreman access never request new totals", async ({ page }) => {
  const server = await setupDataTotals(page, false);
  await expect(page.getByRole("region", { name: "Recorded timer totals" })).toHaveCount(0);
  await expect(page.getByText("Legacy measuring", { exact: true }).first()).toBeVisible(); expect(server.totalsCalls).toEqual([]);
});
for (const role of ["installer", "foreman"]) test(`native Data excludes ${role} even if the release is enabled`, async ({ page }) => {
  const server = await setupDataTotals(page, true, role);
  await expect(page.getByText("Work evidence is available to supervisors", { exact: false })).toBeVisible();
  await expect(page.getByRole("region", { name: "Recorded timer totals" })).toHaveCount(0); expect(server.totalsCalls).toEqual([]); expect(server.reportCalls).toEqual([]);
});
test("phone widths and Spanish keep readable totals without horizontal overflow", async ({ page }, testInfo) => {
  const server = await setupDataTotals(page), panel = page.getByRole("region", { name: "Recorded timer totals" });
  await panel.getByRole("button", { name: "Check totals", exact: true }).click(); await expect(panel.locator("time")).toBeVisible();
  for (const theme of ["light", "dark"]) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    expect(await panel.evaluate(element => { const css = getComputedStyle(element); return css.backgroundColor === getComputedStyle(document.body).backgroundColor || css.backgroundColor === "rgba(0, 0, 0, 0)"; })).toBe(false);
    expect(await panel.evaluate(element => getComputedStyle(element).color === getComputedStyle(document.body).color)).toBe(true);
    await panel.screenshot({ path: testInfo.outputPath(`data-general-${theme}.png`) });
  }
  for (const width of [320, 390, 430]) { await page.setViewportSize({ width, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true); }
  await page.getByRole("button", { name: "EN/ES" }).click();
  const spanish = page.getByRole("region", { name: "Totales de tiempo registrados" });
  await expect(spanish.getByRole("group", { name: "Alcance de los totales", exact: true })).toBeVisible();
  await expect(spanish).toContainText("Todo el trabajo conservado"); await expect(spanish).toContainText("Trabajo general por actividad");
  expect(server.unexpected).toEqual([]); expect(server.pageErrors).toEqual([]);
});
