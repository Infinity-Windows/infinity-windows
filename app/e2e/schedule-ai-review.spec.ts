// K2.8: a supervisor reviews what Forge AI drafted on Scheduling — reads the
// model's reason per draft (from schedule_ai_reasons, the walled table),
// keeps one, drops one through the conditional delete, and publishes through
// the page's one Review & publish sheet. Then the two edges Codex's review of
// #646 named: a Drop that reaches a row another supervisor already published,
// and a publish whose reply is lost after the server committed.
// Fixture-backed like schedule-remove-day.spec.ts: no login, no database.
import { expect, test, type Page } from "@playwright/test";
import { useSupabaseFixtures, TEST_USER } from "./support/supabaseFixtures";
import { json, hideWrongProjectBanner } from "./support/specHelpers";

const day = () => new Date().toLocaleDateString("en-CA");
const project = { id: "fixture-job", job_code: "AI-TEST", name: "Fixture job", address: null };
const SEEN = "2026-09-24T12:00:00Z";
const base = () => ({ project_id: project.id, kind: "install", status: "draft", created_via: "ai", start_date: day(), end_date: day(), start_time: null, color: null, note: null, created_by: null, published_at: null, created_at: SEEN, updated_at: SEEN, projects: project });
const withReason = () => ({ ...base(), id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", schedule_assignment_members: [{ profile_id: TEST_USER.id, role: "installer", profiles: { display_name: "Fixture crew" } }] });
const older = () => ({ ...base(), id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2", schedule_assignment_members: [{ profile_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2", role: "installer", profiles: { display_name: "Ben Fixture" } }] });

interface Drop { id: string | null; status: string | null; updated_at: string | null }
interface Patch { ids: string | null; status: string | null; body: unknown }

/**
 * The schedule tables as the supervisor's phone sees them. `rows` is the
 * truth; a DELETE answers with the rows it matched (the app asks for them
 * back), a PATCH flips drafts to published, and a re-read of `id,status`
 * is what the page does after a lost reply.
 */
async function useScheduleFixtures(page: Page, rows: Record<string, unknown>[], opts: { onDelete?: (d: Drop) => Record<string, unknown>[] } = {}) {
  const deletes: Drop[] = [];
  const patches: Patch[] = [];
  await page.route("**/rest/v1/projects**", r => json(r, [project]));
  await page.route("**/rest/v1/workflow_plan_assignments**", r => json(r, []));
  await page.route("**/rest/v1/workflow_plan_trips**", r => json(r, []));
  await page.route("**/rest/v1/workflow_plans**", r => json(r, []));
  await page.route("**/rest/v1/schedule_events**", r => json(r, null));
  await page.route("**/rest/v1/schedule_assignments**", r => {
    const url = new URL(r.request().url());
    const method = r.request().method();
    if (method === "DELETE") {
      const d = { id: url.searchParams.get("id"), status: url.searchParams.get("status"), updated_at: url.searchParams.get("updated_at") };
      deletes.push(d);
      if (opts.onDelete) return json(r, opts.onDelete(d));
      const gone = rows.filter(x => `eq.${x.id}` === d.id && d.status === `eq.${x.status}` && d.updated_at === `eq.${x.updated_at}`);
      for (const g of gone) rows.splice(rows.indexOf(g), 1);
      return json(r, gone.map(x => ({ id: x.id })));
    }
    if (method === "PATCH") {
      patches.push({ ids: url.searchParams.get("id"), status: url.searchParams.get("status"), body: r.request().postDataJSON() });
      for (const x of rows) if (x.status === "draft") { x.status = "published"; x.updated_at = new Date().toISOString(); }
      return json(r, null);
    }
    if (url.searchParams.get("select") === "id,status") return json(r, rows.map(x => ({ id: x.id, status: x.status })));
    const wantDraft = url.searchParams.get("status") === "eq.draft";
    return json(r, rows.filter(x => !wantDraft || x.status === "draft"));
  });
  return { deletes, patches, rows };
}

for (const width of [375, 1280]) {
  test(`review AI drafts: reason, keep, drop, then the usual publish sheet at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await useSupabaseFixtures(page, { role: "supervisor" });
    await hideWrongProjectBanner(page);
    const a = withReason(), b = older();
    const { deletes, patches } = await useScheduleFixtures(page, [a, b]);
    // The reason lives in schedule_ai_reasons, readable above supervisor
    // rank only; the second draft predates the table.
    await page.route("**/rest/v1/schedule_ai_reasons**", r => json(r, [{ assignment_id: a.id, reason: "Lead with wet glazing; keeps Team 1 together" }]));

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
    expect(deletes).toEqual([]);
    expect(patches).toEqual([]);

    // Drop deletes that one row — and only while it is still the draft the
    // card showed: status and the revision it rendered from ride on the request.
    await card.getByRole("button", { name: "Drop", exact: true }).nth(1).click();
    await expect(card).toContainText("1 to review");
    expect(deletes).toEqual([{ id: `eq.${b.id}`, status: "eq.draft", updated_at: `eq.${SEEN}` }]);

    // Publish hands off to the page's existing sheet, which flips the drafts
    // to published exactly as it always has — no second publish path.
    await card.getByRole("button", { name: "Review & publish" }).click();
    const sheet = page.locator(".sched-sheet");
    await expect(sheet).toContainText("Review & publish");
    await sheet.getByRole("button", { name: "Publish 1", exact: true }).click();
    await expect(sheet).not.toBeVisible();
    expect(patches).toEqual([{ ids: `in.(${a.id})`, status: "eq.draft", body: { status: "published", published_at: expect.any(String), updated_at: expect.any(String) } }]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}

test("two supervisors: the other one published first, so a stale Drop deletes nothing and says the draft changed", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 844 });
  await useSupabaseFixtures(page, { role: "supervisor" });
  await hideWrongProjectBanner(page);
  const a = withReason();
  // The database answers the conditional delete with no rows: by the time it
  // arrives, the row is published with a newer updated_at (the other
  // supervisor's publish), and the truth the re-read finds says so.
  const { deletes, rows } = await useScheduleFixtures(page, [a], { onDelete: () => { rows[0].status = "published"; rows[0].updated_at = new Date().toISOString(); return []; } });
  await page.route("**/rest/v1/schedule_ai_reasons**", r => json(r, [{ assignment_id: a.id, reason: "Lead with wet glazing" }]));

  await page.goto("/scheduling");
  const card = page.getByTestId("ai-draft-review");
  await expect(card).toContainText("1 to review");
  await card.getByRole("button", { name: "Drop", exact: true }).click();
  await expect(card.getByRole("alert")).toContainText("This draft changed since you opened it — it may have been published. Nothing was dropped");
  expect(deletes).toEqual([{ id: `eq.${a.id}`, status: "eq.draft", updated_at: `eq.${SEEN}` }]);
  // The re-read shows it as it is now — published, so no longer up for review.
  await expect(card).toContainText("No AI drafts in these dates.");
  expect(rows[0].status).toBe("published");
});

test("a publish the server committed but whose reply was lost is confirmed by re-reading, not called a failure", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 844 });
  await useSupabaseFixtures(page, { role: "supervisor" });
  await hideWrongProjectBanner(page);
  const a = withReason();
  const { patches, rows } = await useScheduleFixtures(page, [a]);
  await page.route("**/rest/v1/schedule_ai_reasons**", r => json(r, [{ assignment_id: a.id, reason: "Lead with wet glazing" }]));
  // The PATCH goes out and the server does the work — then the connection
  // dies before the reply. The fixture flips the row first so the re-read
  // tells the truth: it IS published.
  const lost = await page.route("**/rest/v1/schedule_assignments**", async r => {
    if (r.request().method() !== "PATCH") return r.fallback();
    patches.push({ ids: null, status: null, body: r.request().postDataJSON() });
    for (const x of rows) if (x.status === "draft") { x.status = "published"; x.updated_at = new Date().toISOString(); }
    await r.abort("connectionclosed");
  });
  void lost;

  await page.goto("/scheduling");
  const card = page.getByTestId("ai-draft-review");
  await card.getByRole("button", { name: "Review & publish" }).click();
  const sheet = page.locator(".sched-sheet");
  await sheet.getByRole("button", { name: "Publish 1", exact: true }).click();
  // Re-read said "published": the sheet closes as on any good publish, and
  // never claims that nothing happened.
  await expect(sheet).not.toBeVisible();
  await expect(page.getByText("Nothing was published")).toHaveCount(0);
  expect(patches).toHaveLength(1);
  await expect(card).toHaveCount(0);
});

test("a publish the database refused says so, and that nothing was published", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 844 });
  await useSupabaseFixtures(page, { role: "supervisor" });
  await hideWrongProjectBanner(page);
  const a = withReason();
  const { rows } = await useScheduleFixtures(page, [a]);
  await page.route("**/rest/v1/schedule_ai_reasons**", r => json(r, []));
  await page.route("**/rest/v1/schedule_assignments**", async r => {
    if (r.request().method() !== "PATCH") return r.fallback();
    await r.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ code: "42501", message: "new row violates row-level security policy for table \"schedule_assignments\"", details: null, hint: null }) });
  });

  await page.goto("/scheduling");
  await page.getByTestId("ai-draft-review").getByRole("button", { name: "Review & publish" }).click();
  const sheet = page.locator(".sched-sheet");
  await sheet.getByRole("button", { name: "Publish 1", exact: true }).click();
  await expect(sheet.getByRole("alert")).toContainText("You don't have permission to do that. Nothing was published.");
  await expect(sheet).toBeVisible();
  expect(rows[0].status).toBe("draft");
});

test("a lost reply on the way out with nothing committed: the sheet says it could not confirm, never that it went", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 844 });
  await useSupabaseFixtures(page, { role: "supervisor" });
  await hideWrongProjectBanner(page);
  const a = withReason();
  const { rows } = await useScheduleFixtures(page, [a]);
  await page.route("**/rest/v1/schedule_ai_reasons**", r => json(r, []));
  // Both the PATCH and the re-read die — the connection closes with no reply,
  // which is what a lost reply looks like from the phone: the app knows nothing.
  await page.route("**/rest/v1/schedule_assignments**", async r => {
    const url = new URL(r.request().url());
    const isReread = url.searchParams.get("select") === "id,status";
    if (r.request().method() === "PATCH" || isReread) return r.abort("connectionclosed");
    return r.fallback();
  });

  await page.goto("/scheduling");
  await page.getByTestId("ai-draft-review").getByRole("button", { name: "Review & publish" }).click();
  const sheet = page.locator(".sched-sheet");
  await sheet.getByRole("button", { name: "Publish 1", exact: true }).click();
  await expect(sheet.getByRole("alert")).toContainText("We couldn't confirm whether this was published");
  await expect(sheet.getByRole("alert")).not.toContainText("Nothing was published");
  expect(rows[0].status).toBe("draft");
});

test("a foreman reads the week without the review card", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 844 });
  await useSupabaseFixtures(page, { role: "foreman" });
  await hideWrongProjectBanner(page);
  await page.route("**/rest/v1/projects**", r => json(r, [{ id: "fixture-job", job_code: "AI-TEST", name: "Fixture job" }]));
  await page.route("**/rest/v1/schedule_assignments**", r => json(r, [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", project_id: "fixture-job", kind: "install", status: "draft", created_via: "ai", start_date: day(), end_date: day(), updated_at: SEEN, projects: { id: "fixture-job", job_code: "AI-TEST", name: "Fixture job" }, schedule_assignment_members: [] }]));
  await page.goto("/scheduling");
  await expect(page.getByRole("heading", { name: "Scheduling" })).toBeVisible();
  await expect(page.getByTestId("ai-draft-review")).toHaveCount(0);
});
