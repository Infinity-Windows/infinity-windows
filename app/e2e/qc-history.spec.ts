import { expect, test } from "@playwright/test";
import { TEST_USER, useSupabaseFixtures } from "./support/supabaseFixtures";
import { json } from "./support/specHelpers";

test("foreman can open past QC decisions, including an older record with no reviewer", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "foreman" });
  const openingId = "20000000-0000-4000-8000-000000000051";
  const projectId = "20000000-0000-4000-8000-000000000052";
  const opening = {
    id: openingId, project_id: projectId, opening_code: "B14", status: "installed",
    assigned_window_id: null, window_types: { type_code: "W-1" },
    qc: null, projects: { job_code: "DEMO-01" },
  };
  await page.route("**/rest/v1/qc_checks**", (route) => json(route, []));
  await page.route("**/rest/v1/project_openings**", (route) => json(route, [opening], 1));
  await page.route("**/rest/v1/profiles**", (route) => {
    const profile = {
      id: TEST_USER.id, display_name: "E2E Fixture", role: "foreman",
      skill_level: 3, active: true, can_see_costs: false, can_see_pay: false,
    };
    const single = (route.request().headers()["accept"] ?? "").includes("pgrst.object");
    return json(route, single ? profile : [profile], 1);
  });
  let historyRequests = 0;
  await page.route("**/rest/v1/qc_decision_events**", (route) => {
    historyRequests++;
    return json(route, [
      {
        id: "20000000-0000-4000-8000-000000000053",
        project_opening_id: openingId, status: "passed", note: "Sill and seal checked",
        reviewer_id: TEST_USER.id, decided_at: "2026-09-30T16:00:00Z", source: "review",
      },
      {
        id: "20000000-0000-4000-8000-000000000054",
        project_opening_id: openingId, status: "callback", note: "Earlier issue",
        reviewer_id: null, decided_at: "2026-09-29T16:00:00Z", source: "legacy_snapshot",
      },
      {
        id: "20000000-0000-4000-8000-000000000055",
        project_opening_id: openingId, status: "passed", note: null,
        reviewer_id: "20000000-0000-4000-8000-000000000056",
        decided_at: "2026-09-28T16:00:00Z", source: "review",
      },
    ]);
  });

  await page.goto("/qc");
  await expect(page.getByText("B14")).toBeVisible();
  expect(historyRequests).toBe(0);
  await page.getByRole("button", { name: "Review history" }).click();
  await expect(page.getByText("DEMO-01 · B14")).toHaveCount(3);
  await expect(page.getByText("E2E Fixture", { exact: false })).toBeVisible();
  await expect(page.getByText("Reviewer not recorded in older data")).toBeVisible();
  await expect(page.getByText("Reviewer unavailable")).toBeVisible();
  await expect(page.getByText("Sill and seal checked")).toBeVisible();
  await expect(page.getByText("B14", { exact: true })).toBeHidden();
  expect(historyRequests).toBe(1);
  await page.getByRole("button", { name: "Needs review" }).click();
  await expect(page.getByText("B14", { exact: true })).toBeVisible();
});

test("a failed history query shows a safe message, not database details", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "foreman" });
  await page.route("**/rest/v1/qc_checks**", (route) => json(route, []));
  await page.route("**/rest/v1/project_openings**", (route) => json(route, []));
  await page.route("**/rest/v1/qc_decision_events**", (route) => route.fulfill({
    status: 400,
    contentType: "application/json",
    body: JSON.stringify({ code: "PGRST200", message: "could not find a relationship in schema cache: secret_table" }),
  }));

  await page.goto("/qc");
  await page.getByRole("button", { name: "Review history" }).click();
  await expect(page.getByRole("region", { name: "QC review history" }).getByRole("alert")).toContainText("fault on our side");
  await expect(page.getByText("secret_table")).toHaveCount(0);
});
