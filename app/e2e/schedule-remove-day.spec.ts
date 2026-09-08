import { expect, test } from "@playwright/test";
import { useSupabaseFixtures, TEST_USER } from "./support/supabaseFixtures";
import { json, hideWrongProjectBanner } from "./support/specHelpers";

for (const width of [375, 1280]) {
  test(`remove one scheduled day or explicitly choose all days at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await useSupabaseFixtures(page, { role: "supervisor" });
    await hideWrongProjectBanner(page);
    const day = new Date().toLocaleDateString("en-CA");
    const end = new Date(); end.setDate(end.getDate() + 2);
    const row = { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", project_id: "fixture-job", kind: "install", status: "published", start_date: day, end_date: end.toLocaleDateString("en-CA"), updated_at: "2026-09-08T12:00:00Z",
      projects: { id: "fixture-job", job_code: "DAY-TEST", name: "Fixture job" },
      schedule_assignment_members: [{ profile_id: TEST_USER.id, role: "installer", profiles: { display_name: "Fixture crew" } }] };
    const writes: { method: string; body: unknown }[] = [];
    await page.route("**/rest/v1/projects**", r => json(r, [{ id: "fixture-job", job_code: "DAY-TEST", name: "Fixture job" }]));
    await page.route("**/rest/v1/workflow_plan_assignments**", r => json(r, []));
    await page.route("**/rest/v1/workflow_plan_trips**", r => json(r, []));
    await page.route("**/rest/v1/workflow_plans**", r => json(r, []));
    await page.route("**/rest/v1/schedule_assignments**", r => {
      if (r.request().method() === "DELETE") { writes.push({ method: "DELETE", body: null }); return json(r, null); }
      return json(r, new URL(r.request().url()).searchParams.get("status") === "eq.draft" ? [] : [row]);
    });
    let fail = true;
    await page.route("**/rest/v1/rpc/schedule_remove_day", r => {
      writes.push({ method: "RPC", body: r.request().postDataJSON() });
      return fail ? r.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ message: "This assignment changed. Close and reopen it before removing a day." }) }) : json(r, null);
    });
    await page.goto("/scheduling");
    await page.getByRole("tab", { name: "Agenda", exact: true }).click();
    await page.locator(".sched-agenda-item").first().click();
    await page.getByRole("button", { name: "Remove", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Remove scheduled work?" });
    await expect(dialog.getByRole("combobox", { name: "Remove", exact: true })).toHaveValue("day");
    await expect(dialog.getByLabel("Day to remove")).toHaveValue(day);
    await expect(dialog).toContainText("Other days, crew details, and vehicle bookings will stay");
    await page.screenshot({ path: `/tmp/forge-remove-day-${width}.png` });
    await dialog.getByLabel("Day to remove").fill("");
    await expect(dialog.getByRole("button", { name: "Remove this day" })).toBeDisabled();
    await dialog.getByLabel("Day to remove").fill(day);
    await dialog.getByRole("button", { name: "Remove this day" }).click();
    await expect(dialog.getByRole("alert").filter({ hasText: "This assignment changed" })).toBeVisible();
    expect(writes).toEqual([{ method: "RPC", body: { p_assignment_id: row.id, p_day: day, p_expected_updated_at: row.updated_at } }]);
    fail = false;
    await dialog.getByRole("button", { name: "Remove this day" }).click();
    await expect(dialog).not.toBeVisible();
    await page.locator(".sched-agenda-item").first().click();
    await page.getByRole("button", { name: "Remove", exact: true }).click();
    await dialog.getByRole("combobox", { name: "Remove", exact: true }).selectOption("all");
    await expect(dialog.getByLabel("Day to remove")).not.toBeVisible();
    await expect(dialog).toContainText(`from ${day} through ${row.end_date}`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await dialog.getByRole("button", { name: "Remove all days" }).click();
    await expect(dialog).not.toBeVisible();
    expect(writes.map(w => w.method)).toEqual(["RPC", "RPC", "DELETE"]);
  });
}
