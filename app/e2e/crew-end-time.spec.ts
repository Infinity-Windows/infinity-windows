import { expect, test } from "@playwright/test";
import { useSupabaseFixtures, TEST_USER } from "./support/supabaseFixtures";
import { json, hideWrongProjectBanner } from "./support/specHelpers";

test("manager sets, validates and clears the crew end time", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 844 });
  await useSupabaseFixtures(page, { role: "supervisor" });
  await hideWrongProjectBanner(page);
  const day = new Date().toLocaleDateString("en-CA");
  let row = { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", project_id: "fixture-job", kind: "install", status: "published", start_date: day, end_date: day, start_time: "06:30", end_time: null as string | null,
    projects: { id: "fixture-job", job_code: "HOMESTEAD", name: "Fixture job" },
    schedule_assignment_members: [{ profile_id: TEST_USER.id, role: "installer", profiles: { display_name: "Fixture crew" } }] };
  const patches: Record<string, unknown>[] = [];
  await page.route("**/rest/v1/projects**", r => json(r, [{ id: "fixture-job", job_code: "HOMESTEAD", name: "Fixture job" }]));
  await page.route("**/rest/v1/workflow_plan_assignments**", r => json(r, []));
  await page.route("**/rest/v1/workflow_plan_trips**", r => json(r, []));
  await page.route("**/rest/v1/workflow_plans**", r => json(r, []));
  await page.route("**/rest/v1/schedule_assignments**", r => {
    if (r.request().method() === "PATCH") { const patch=r.request().postDataJSON(); patches.push(patch); row={...row,...patch}; }
    return json(r, new URL(r.request().url()).searchParams.get("status") === "eq.draft" ? [] : [row]);
  });
  await page.goto("/scheduling");
  await page.getByRole("tab", { name: "Agenda", exact: true }).click();
  await page.locator(".sched-agenda-item").first().click();
  const end=page.getByLabel("Crew end time (optional)");
  await expect(end).toHaveValue("");
  await end.fill("05:00");
  await expect(page.getByRole("button",{name:"Save changes"})).toBeDisabled();
  await end.fill("15:00");
  await page.screenshot({path:"/tmp/forge-end-time-phone.png"});
  await page.getByRole("button",{name:"Save changes"}).click();
  await expect(end).not.toBeVisible();
  expect(patches[0]).toMatchObject({start_time:"06:30",end_time:"15:00"});
  await expect(page.locator(".sched-agenda-item").first()).toContainText("6:30 AM–3:00 PM");
  await page.locator(".sched-agenda-item").first().click();
  await expect(end).toHaveValue("15:00");
  await end.fill("");
  await page.getByRole("button",{name:"Save changes"}).click();
  await expect(end).not.toBeVisible();
  expect(patches.at(-1)).toMatchObject({end_time:null});
});
