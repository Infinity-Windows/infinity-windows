import { expect, test } from "@playwright/test";
import { jobFixtures, useSupabaseFixtures } from "./support/supabaseFixtures";
import { hideWrongProjectBanner, json } from "./support/specHelpers";

test("supervisor saves independent labor targets and records the named job stages", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "supervisor" });
  await hideWrongProjectBanner(page);
  const projectId = jobFixtures()[0].projectId;
  let targets: Record<string, unknown>[] = [];
  let stages: Record<string, unknown>[] = [];
  let saved: Record<string, unknown> | null = null;
  const counted = (rows: unknown[]) => ({ status: 200, contentType: "application/json", headers: {
    "content-range": `0-${Math.max(0, rows.length - 1)}/${rows.length}`, "access-control-expose-headers": "content-range",
  }, body: JSON.stringify(rows) });
  await page.route("**/rest/v1/time_shifts**", (route) => route.fulfill(counted([])));
  await page.route("**/rest/v1/project_labor_targets**", (route) => route.fulfill(counted(targets)));
  await page.route("**/rest/v1/project_stage_progress**", (route) => json(route, stages));
  await page.route("**/rest/v1/rpc/set_project_labor_targets", async (route) => {
    saved = route.request().postDataJSON();
    targets = [{ project_id: projectId, projected_hours: saved!.p_projected_hours, goal_hours: saved!.p_goal_hours, square_feet: saved!.p_square_feet, revision: 1 }];
    await json(route, targets[0]);
  });
  await page.route("**/rest/v1/rpc/set_project_stage", async (route) => {
    const body = route.request().postDataJSON();
    expect(body.p_project_id).toBe(projectId);
    expect(body.p_stage_key).toBe("material_delivered");
    expect(body.p_revision).toBe(0);
    stages = [{ project_id: projectId, stage_key: body.p_stage_key, completed: body.p_completed, note: body.p_note, revision: 1 }];
    await json(route, stages[0]);
  });
  await page.goto(`/projects/${projectId}`);
  const labor = page.getByRole("region", { name: "Job labor target" });
  await labor.getByRole("button", { name: "Set / edit labor targets" }).click();
  await labor.getByLabel("Projected man-hours").fill("200");
  await labor.getByLabel("Foreman goal hours").fill("180");
  await labor.getByLabel("Reason for setting or changing the target").fill("Initial approved estimate");
  await labor.getByRole("button", { name: "Save labor targets" }).click();
  await expect(labor.getByText("200.0h", { exact: true })).toBeVisible();
  await expect(labor.getByText("180.0h", { exact: true })).toBeVisible();
  expect(saved).toMatchObject({ p_project_id: projectId, p_projected_hours: 200, p_goal_hours: 180, p_revision: 0 });
  const progress = page.getByRole("region", { name: "Job stages" });
  await expect(progress.getByText("0 of 10 stages complete")).toBeVisible();
  await progress.getByRole("button", { name: /Material Delivered/ }).click();
  await progress.getByLabel("Completion note / evidence reference").fill("Delivery checked at warehouse");
  await progress.getByRole("button", { name: "Mark stage complete" }).click();
  await expect(progress.getByText("1 of 10 stages complete")).toBeVisible();
  await progress.scrollIntoViewIfNeeded();
  await page.screenshot({ path: "e2e/test-results/job-execution-phone.png", fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: "e2e/test-results/job-execution-desktop.png", fullPage: true });
});
