import { expect, test } from "@playwright/test";
import { TEST_USER, useSupabaseFixtures } from "./support/supabaseFixtures";
import { hideWrongProjectBanner } from "./support/specHelpers";

test("loads earlier activities without clearing the table or shifting its columns", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "foreman", uiDesign: "new" });
  await hideWrongProjectBanner(page);
  const now = new Date("2026-11-20T12:00:00");
  await page.clock.setFixedTime(now);
  const records = [
    { id: "recent-setup", description: "Setup", started_at: "2026-11-20T15:00:00Z", ended_at: "2026-11-20T16:00:00Z" },
    { id: "recent-loading", description: "Loading product", started_at: "2026-11-18T15:00:00Z", ended_at: "2026-11-18T16:30:00Z" },
    { id: "earlier-travel", description: "Travel", started_at: "2026-11-02T15:00:00Z", ended_at: "2026-11-02T16:00:00Z" },
  ].map(row => ({ ...row, profile_id: TEST_USER.id, kind: "idle", stage: "", revision: 1 }));
  const earlierRequest = Promise.withResolvers<void>();
  const releaseHistory = Promise.withResolvers<void>();
  const counted = (rows: unknown[]) => ({
    json: rows,
    headers: { "content-range": rows.length ? `0-${rows.length - 1}/${rows.length}` : "*/0",
      "access-control-expose-headers": "content-range" },
  });
  await page.route("**/rest/v1/custom_work_units?*", route => route.fulfill(counted([])));
  await page.route("**/rest/v1/custom_work_types?*", route => route.fulfill(counted([])));
  await page.route("**/rest/v1/custom_work_sessions?*", async route => {
    const lower = new URL(route.request().url()).searchParams.get("or")?.match(/ended_at\.gt\.([^)]*)/)?.[1];
    const scopeIncludesEarlier = lower && Date.parse(lower) < Date.parse(records[2].ended_at);
    if (scopeIncludesEarlier) {
      earlierRequest.resolve();
      await releaseHistory.promise;
    }
    await route.fulfill(counted(scopeIncludesEarlier ? records : records.slice(0, 2)));
  });

  try {
    await page.goto("/activities");
    const table = page.getByRole("table", { name: "Recent activities" });
    const setup = table.getByRole("button", { name: /^Setup for/ });
    const loading = table.getByRole("button", { name: /^Loading product for/ });
    const travel = table.getByRole("button", { name: /^Travel for/ });
    await expect(setup).toBeVisible();
    await expect(loading).toBeVisible();
    await expect(travel).toHaveCount(0);
    const period = page.getByRole("combobox", { name: "Period" });
    await expect(period).toHaveValue("recent");
    await expect(period.getByRole("option", { name: "Pay period Nov 1 – Nov 15" })).toHaveCount(1);
    await page.getByRole("button", { name: "Load earlier activities" }).click();
    await earlierRequest.promise;
    await expect(page.getByRole("button", { name: "Loading earlier activities…" })).toBeDisabled();
    await expect(setup).toBeVisible();
    await expect(loading).toBeVisible();
    releaseHistory.resolve();
    await expect(travel).toBeVisible();
    await expect(table.getByRole("rowheader", { name: /Pay period Nov 1 – Nov 15/ })).toBeVisible();
    await period.selectOption({ label: "Pay period Nov 1 – Nov 15" });
    await expect(travel).toBeVisible();
    await expect(setup).toHaveCount(0);
    await period.selectOption("recent");
    await expect(setup).toBeVisible();
    await expect(travel).toHaveCount(0);
    await period.selectOption("loaded");
    await expect(travel).toBeVisible();
    const columns = () => table.locator("thead th").evaluateAll(cells =>
      cells.map(cell => ({ left: cell.getBoundingClientRect().left, width: cell.getBoundingClientRect().width })));
    for (const width of [390, 1100]) {
      await page.setViewportSize({ width, height: 844 });
      const original = await columns();
      await page.getByRole("group", { name: "Activity", exact: true }).getByRole("button", { name: "Setup", exact: true }).click();
      await expect(loading).toHaveCount(0);
      expect(await columns()).toEqual(original);
      await page.getByRole("button", { name: "All activities" }).click();
      await expect(loading).toBeVisible();
      expect(await columns()).toEqual(original);
    }
  } finally {
    releaseHistory.resolve();
  }
});
