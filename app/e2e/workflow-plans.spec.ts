import { expect, test, type Page } from "@playwright/test";
import { useSupabaseFixtures as seedSupabaseFixtures, TEST_USER } from "./support/supabaseFixtures";
import { json, hideWrongProjectBanner } from "./support/specHelpers";

const PLAN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TRIP = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const WORK = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const today = () => new Date().toLocaleDateString("en-CA");
function initialPlan() {
  return { id: PLAN, project_id: "fixture-job", name: "Fixture connected plan", revision: 1, published_revision: null as number | null, state: "active", review_token: "review-1", conflicts: [], conflict_assignments: [], notices: [] as { state: string; count: number }[],
    draft: { assignments: [{ id: WORK, project_id: "fixture-job", kind: "install", status: "draft", start_date: today(), end_date: today(), start_time: "07:00", note: "Bring the ladder", members: [{ profile_id: TEST_USER.id, role: "installer" }] }],
      trips: [{ trip: { id: TRIP, project_id: "fixture-job", name: "Rotation A", start_date: today(), end_date: today(), destination: "Fixture site", timezone: "America/Denver", notes: "Leave the shop first", status: "draft" }, crew: [{ profile_id: TEST_USER.id, role: "crew" }], flights: [], lodging: [{ id: "house", name: "Fixture house", door_code: "fixture-code", entry_steps: "Use the side door" }], ground: [], procedures: [], contacts: [], attachments: [] }], vehicles: [] } };
}
async function planFixture(page: Page, role: "supervisor" | "installer" = "supervisor") {
  await seedSupabaseFixtures(page, { role });
  await hideWrongProjectBanner(page);
  let plan = initialPlan();
  const writes: { url: string; body: Record<string, unknown> }[] = [];
  await page.route("**/rest/v1/workflow_plan_assignments**", r => json(r, [{ plan_id: PLAN, assignment_id: WORK }]));
  await page.route("**/rest/v1/workflow_plan_trips**", r => json(r, [{ plan_id: PLAN, trip_id: TRIP }]));
  await page.route("**/rest/v1/workflow_plans**", r => json(r, [plan]));
  await page.route("**/rest/v1/projects**", r => json(r, [{ id: "fixture-job", job_code: "TEST", name: "Fixture job", status: "active" }]));
  await page.route("**/rest/v1/schedule_assignments**", r => json(r, [{ ...plan.draft.assignments[0], projects: { id: "fixture-job", job_code: "TEST", name: "Fixture job" }, schedule_assignment_members: [{ profile_id: TEST_USER.id, role: "installer", profiles: { display_name: "Fixture crew" } }] }]));
  await page.route("**/rest/v1/trips**", r => json(r, { ...plan.draft.trips[0].trip, trip_crew: [{ profile_id: TEST_USER.id, role: "crew" }] }));
  await page.route("**/rest/v1/rpc/workflow_review_plan", r => json(r, plan));
  await page.route("**/rest/v1/rpc/workflow_save_draft", r => {
    const body = r.request().postDataJSON(); writes.push({ url: r.request().url(), body });
    plan = { ...plan, draft: body.p_draft, revision: plan.revision + 1, review_token: "review-2" };
    return json(r, plan.revision);
  });
  await page.route("**/rest/v1/rpc/workflow_publish_plan", r => {
    const body = r.request().postDataJSON(); writes.push({ url: r.request().url(), body });
    plan = { ...plan, published_revision: plan.revision, notices: [{ state: "pending", count: 1 }] };
    return json(r, { plan_id: PLAN, revision: plan.revision, notifications: "pending" });
  });
  return { writes, getPlan: () => plan };
}
async function openReview(page: Page, route = "/scheduling") {
  await page.goto(route); await hideWrongProjectBanner(page);
  await page.getByRole("button", { name: /Fixture connected plan/ }).click();
  const dialog = page.getByRole("dialog", { name: "Review plan" });
  await expect(dialog.getByRole("heading", { name: "Fixture connected plan" })).toBeVisible();
  return dialog;
}

test("phone draft survives layout change and publishes only after save with honest pending notices", async ({ page }) => {
  const f = await planFixture(page); const dialog = await openReview(page);
  await expect(page.locator(".sched-publishbar")).toHaveCount(0);
  await dialog.getByLabel("Work start time", { exact: true }).fill("08:30");
  await expect(dialog.getByRole("button", { name: "Publish this plan", exact: true })).toBeDisabled();
  await page.evaluate(() => { window.dispatchEvent(new StorageEvent("storage", { key: "infinity.display-mode", newValue: "desktop" })); });
  await expect(dialog.getByLabel("Work start time", { exact: true })).toHaveValue("08:30");
  await dialog.getByRole("button", { name: "Save working draft" }).click();
  await expect(dialog.getByText("Draft saved. Review it before publishing.")).toBeVisible();
  expect(f.writes[0].body.p_expected).toBe(1);
  await dialog.getByRole("button", { name: "Publish this plan", exact: true }).click();
  await expect(dialog.getByText("Notifications: 0 sent · 1 pending or failed")).toBeVisible();
  expect(f.writes[1].body).toMatchObject({ p_plan: PLAN, p_expected: 2, p_review_token: "review-2", p_cancel: false });
  await expect(dialog.getByRole("button", { name: "Publish this plan", exact: true })).toBeDisabled();
});

test("a lost publish response retries the identical request, keeping edits locked", async ({ page }) => {
  await planFixture(page); const requests: unknown[] = [];
  await page.route("**/rest/v1/rpc/workflow_publish_plan", async r => { requests.push(r.request().postDataJSON()); if (requests.length === 1) return r.abort("failed"); return json(r, { plan_id: PLAN, revision: 1 }); });
  const dialog = await openReview(page);
  await dialog.getByRole("button", { name: "Publish this plan", exact: true }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(dialog.getByLabel("Work start time", { exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "Retry the same action" }).click();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1]).toEqual(requests[0]);
});

test("Travel opens the same review, protects details and fits an iPhone", async ({ page }) => {
  await planFixture(page); const dialog = await openReview(page, `/travel/${TRIP}`);
  await expect(page.locator("#trip-publish")).toHaveCount(0);
  await dialog.getByText("Review flights, lodging, instructions and files", { exact: true }).click();
  await expect(dialog.getByText("Use the side door", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: /edit lodging/i })).toHaveCount(0);
  expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.locator(".workflow-review").evaluate(el => { el.scrollTop = 0; });
  await page.screenshot({ path: "e2e/test-results/workflow-review-phone.png", fullPage: false });
});

test("My Schedule has separate accessible links for two rotations", async ({ page }) => {
  await planFixture(page, "installer");
  await page.route("**/rest/v1/rpc/workflow_my_trip_links", r => json(r, [
    { assignment_id: WORK, trip_id: TRIP, name: "Rotation A", start_date: today(), end_date: today() },
    { assignment_id: WORK, trip_id: "rotation-b", name: "Rotation B", start_date: today(), end_date: today() },
  ]));
  await page.route("**/rest/v1/trips**", r => json(r, []));
  await page.route("**/rest/v1/schedule_assignment_members**", r => json(r, [{ assignment_id: WORK }]));
  await page.goto("/my-schedule"); await hideWrongProjectBanner(page);
  await expect(page.getByRole("link", { name: /Rotation A/ })).toHaveAttribute("href", `/travel/${TRIP}`);
  await expect(page.getByRole("link", { name: /Rotation B/ })).toHaveAttribute("href", "/travel/rotation-b");
  await expect(page.locator("a a")).toHaveCount(0);
});

test("an unapplied migration leaves standalone scheduling available", async ({ page }) => {
  await planFixture(page);
  await page.route("**/rest/v1/workflow_plan_*", r => r.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ code: "PGRST205", message: "Could not find the table" }) }));
  await page.goto("/scheduling"); await hideWrongProjectBanner(page);
  await expect(page.getByRole("heading", { name: "Connected work and travel" })).toHaveCount(0);
  await expect(page.locator(".sched-publishbar")).toBeVisible();
});

test("connecting selects only the chosen drafts for one job", async ({ page }) => {
  await planFixture(page);
  await page.route("**/rest/v1/workflow_plan_assignments**", r => json(r, []));
  await page.route("**/rest/v1/workflow_plan_trips**", r => json(r, []));
  await page.route("**/rest/v1/workflow_plans**", r => json(r, []));
  const initial = initialPlan();
  await page.route("**/rest/v1/trips**", r => json(r, [
    { ...initial.draft.trips[0].trip, trip_crew: [] },
    { ...initial.draft.trips[0].trip, id: "unrelated-trip", project_id: "other-job", name: "Unrelated destination", trip_crew: [] },
  ]));
  let request: Record<string, unknown> | undefined;
  await page.route("**/rest/v1/rpc/workflow_create_plan", r => { request = r.request().postDataJSON(); return json(r, PLAN); });
  await page.goto("/scheduling"); await hideWrongProjectBanner(page);
  await page.getByRole("button", { name: "Connect a plan", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Selected plan");
  await page.getByRole("combobox", { name: "Job", exact: true }).selectOption("fixture-job");
  await page.getByRole("group", { name: "Select unpublished work blocks" }).getByRole("checkbox").check();
  await page.getByRole("group", { name: "Select unpublished trips" }).getByRole("checkbox", { name: /Rotation A/ }).check();
  await expect(page.getByText("Unrelated destination", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Connect and review" }).click();
  await expect.poll(() => request).toMatchObject({ p_name: "Selected plan", p_assignments: [WORK], p_trips: [TRIP] });
  await expect(page.getByRole("dialog", { name: "Review plan" })).toBeVisible();
});

test("a lost cancellation response retries cancellation without republishing", async ({ page }) => {
  await planFixture(page);
  let plan = { ...initialPlan(), published_revision: 1 };
  await page.route("**/rest/v1/rpc/workflow_review_plan", r => json(r, plan));
  const requests: Record<string, unknown>[] = [];
  await page.route("**/rest/v1/rpc/workflow_publish_plan", r => {
    requests.push(r.request().postDataJSON());
    if (requests.length === 1) return r.abort("failed");
    plan = { ...plan, state: "canceled", revision: 2, published_revision: 2 };
    return json(r, { plan_id: PLAN, revision: 2, state: "canceled" });
  });
  const dialog = await openReview(page);
  await dialog.getByText("Plan actions", { exact: true }).click();
  await dialog.getByRole("checkbox", { name: /Cancel all work/ }).check();
  await dialog.getByRole("button", { name: "Cancel published plan", exact: true }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await dialog.getByRole("button", { name: "Retry the same action", exact: true }).click();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1]).toEqual(requests[0]); expect(requests[1].p_cancel).toBe(true);
  await expect(dialog.getByText("Version 2 · Canceled", { exact: true })).toBeVisible();
});
