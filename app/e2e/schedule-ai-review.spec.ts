// K2.8: a supervisor reviews what Forge AI drafted on Scheduling — reads the
// model's reason per draft, keeps one, drops one through the board's own
// delete, and publishes through the page's one Review & publish sheet.
// Fixture-backed like schedule-remove-day.spec.ts: no login, no database.
import { expect, test } from "@playwright/test";
import { useSupabaseFixtures, TEST_USER } from "./support/supabaseFixtures";
import { json, hideWrongProjectBanner } from "./support/specHelpers";

for (const width of [375, 1280]) {
  test(`review AI drafts: reason, keep, drop, then the usual publish sheet at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await useSupabaseFixtures(page, { role: "supervisor" });
    await hideWrongProjectBanner(page);
    const day = new Date().toLocaleDateString("en-CA");
    const project = { id: "fixture-job", job_code: "AI-TEST", name: "Fixture job", address: null };
    const base = { project_id: project.id, kind: "install", status: "draft", created_via: "ai", start_date: day, end_date: day, start_time: null, color: null, note: null, created_by: null, published_at: null, created_at: "2026-09-24T12:00:00Z", updated_at: "2026-09-24T12:00:00Z", projects: project };
    const withReason = { ...base, id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", schedule_assignment_members: [{ profile_id: TEST_USER.id, role: "installer", profiles: { display_name: "Fixture crew" } }] };
    const older = { ...base, id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2", schedule_assignment_members: [{ profile_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2", role: "installer", profiles: { display_name: "Ben Fixture" } }] };
    const deleted: string[] = [];
    const patches: unknown[] = [];
    await page.route("**/rest/v1/projects**", r => json(r, [project]));
    await page.route("**/rest/v1/workflow_plan_assignments**", r => json(r, []));
    await page.route("**/rest/v1/workflow_plan_trips**", r => json(r, []));
    await page.route("**/rest/v1/workflow_plans**", r => json(r, []));
    await page.route("**/rest/v1/schedule_assignments**", r => {
      const url = new URL(r.request().url());
      if (r.request().method() === "DELETE") { deleted.push(url.searchParams.get("id") ?? ""); return json(r, null); }
      if (r.request().method() === "PATCH") { patches.push({ ids: url.searchParams.get("id"), status: url.searchParams.get("status"), body: r.request().postDataJSON() }); return json(r, null); }
      return json(r, [withReason, older].filter(d => !deleted.includes(`eq.${d.id}`)));
    });
    // The model's reason lives on the draft's own 'created' audit event; the
    // second draft predates the reason field.
    await page.route("**/rest/v1/schedule_events**", r => {
      if (r.request().method() !== "GET") return json(r, null);
      return json(r, [{ assignment_id: withReason.id, payload: { ai: true, reason: "Lead with wet glazing; keeps Team 1 together" } }, { assignment_id: older.id, payload: { ai: true } }]);
    });

    await page.goto("/scheduling");
    const card = page.getByTestId("ai-draft-review");
    await expect(card).toContainText("Review AI drafts");
    await expect(card).toContainText("2 to review");
    await expect(card).toContainText("AI-TEST");
    await expect(card).toContainText("Lead with wet glazing; keeps Team 1 together");
    await expect(card).toContainText("No reason recorded");
    await expect(card).toContainText("nothing reaches the crew until you publish");
    await page.screenshot({ path: `/tmp/forge-ai-review-${width}.png` });

    // Keep is a mark on this screen only: nothing is written.
    await card.getByRole("button", { name: "Keep", exact: true }).first().click();
    await expect(card.getByRole("button", { name: "Kept", exact: true })).toHaveCount(1);
    expect(deleted).toEqual([]);
    expect(patches).toEqual([]);

    // Drop is the board's own delete of that one row.
    await card.getByRole("button", { name: "Drop", exact: true }).nth(1).click();
    await expect(card).toContainText("1 to review");
    expect(deleted).toEqual([`eq.${older.id}`]);

    // Publish hands off to the page's existing sheet, which flips the drafts
    // to published exactly as it always has — no second publish path.
    await card.getByRole("button", { name: "Review & publish" }).click();
    const sheet = page.locator(".sched-sheet");
    await expect(sheet).toContainText("Review & publish");
    await sheet.getByRole("button", { name: "Publish 1", exact: true }).click();
    await expect(sheet).not.toBeVisible();
    expect(patches).toEqual([{ ids: `in.(${withReason.id})`, status: "eq.draft", body: { status: "published", published_at: expect.any(String), updated_at: expect.any(String) } }]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}

test("a foreman reads the week without the review card", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 844 });
  await useSupabaseFixtures(page, { role: "foreman" });
  await hideWrongProjectBanner(page);
  const day = new Date().toLocaleDateString("en-CA");
  await page.route("**/rest/v1/projects**", r => json(r, [{ id: "fixture-job", job_code: "AI-TEST", name: "Fixture job" }]));
  await page.route("**/rest/v1/schedule_assignments**", r => json(r, [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", project_id: "fixture-job", kind: "install", status: "draft", created_via: "ai", start_date: day, end_date: day, updated_at: "2026-09-24T12:00:00Z", projects: { id: "fixture-job", job_code: "AI-TEST", name: "Fixture job" }, schedule_assignment_members: [] }]));
  await page.goto("/scheduling");
  await expect(page.getByRole("heading", { name: "Scheduling" })).toBeVisible();
  await expect(page.getByTestId("ai-draft-review")).toHaveCount(0);
});
