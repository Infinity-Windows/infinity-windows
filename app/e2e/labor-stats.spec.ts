import { expect, test } from "@playwright/test";
import { useSupabaseFixtures } from "./support/supabaseFixtures";
import { hideWrongProjectBanner } from "./support/specHelpers";

test("foreman can inspect reconciled employee cost codes on a phone", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "foreman" });
  await hideWrongProjectBanner(page);
  await page.route("**/rest/v1/projects**", (route) => {
    if (!new URL(route.request().url()).searchParams.get("select")?.startsWith("id,name,job_code,status")) return route.fallback();
    return route.fulfill({ status: 200, contentType: "application/json", headers: { "content-range": "0-0/1", "access-control-expose-headers": "content-range" }, body: JSON.stringify([{ id: "stats-job", job_code: "A", name: "Labor comparison", status: "completed", is_test: false }]) });
  });
  await page.route("**/rest/v1/project_labor_targets**", (route) => route.fulfill({ status: 200, contentType: "application/json", headers: { "content-range": "0-0/1", "access-control-expose-headers": "content-range" }, body: JSON.stringify([{ project_id: "stats-job", projected_hours: 200, goal_hours: 180, square_feet: 1500, revision: 1 }]) }));
  await page.route("**/rest/v1/time_shifts**", (route) => route.fulfill({
    status: 200, contentType: "application/json", headers: { "content-range": "0-1/2", "access-control-expose-headers": "content-range" },
    body: JSON.stringify([0, 1].map((n) => ({
      id: `shift-${n}`, profile_id: "labor-worker", project_id: null,
      cost_code_id: n === 0 ? "install" : null,
      clock_in_at: "2026-09-01T14:00:00Z", clock_out_at: "2026-09-01T22:00:00Z",
      break_seconds: 1800, status: "approved", profiles: { display_name: "Labor test worker" },
      projects: null, cost_codes: n === 0 ? { code: "100", label: "Install" } : null,
    }))),
  }));
  await page.goto("/analytics");
  const stats = page.getByRole("region", { name: "Cost-code labor stats" });
  await expect(stats.getByText("50%", { exact: true })).toBeVisible();
  await stats.getByRole("button", { name: /Labor test worker/ }).click();
  await expect(stats.getByRole("heading", { name: "Labor test worker" })).toBeVisible();
  await expect(stats.getByText("No cost code", { exact: true })).toBeVisible();
  await expect(stats.getByText("100 — Install", { exact: true })).toBeVisible();
  await expect(stats.getByRole("cell", { name: "15.0h", exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "e2e/test-results/labor-stats-phone.png", fullPage: true });
  await stats.getByRole("button", { name: "← Everyone" }).click();
  await expect(stats.getByRole("button", { name: /Labor test worker/ })).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(stats.getByRole("button", { name: /Labor test worker/ })).toBeVisible();
  await page.screenshot({ path: "e2e/test-results/labor-stats-desktop.png", fullPage: true });
});

test("partner cannot enter the labor report", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "installer" });
  await hideWrongProjectBanner(page);
  await page.route("**/rest/v1/rpc/is_partner_user", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "true" }));
  let requested = false;
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.endsWith("/time_shifts") && url.searchParams.get("select")?.startsWith("id,profile_id,project_id")) requested = true;
  });
  await page.goto("/analytics");
  await expect(page).toHaveURL(/\/stg\/?$/);
  await expect(page.getByRole("region", { name: "Cost-code labor stats" })).toHaveCount(0);
  expect(requested).toBe(false);
});
