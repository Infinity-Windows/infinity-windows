// Wave L: the filing dialog end to end, with mocked routes — pins
// file_daily_log's payload (the notes gate, day_flow, reflections cleared
// on Smooth) and proves an installer never even sees the Logs tab (the real
// enforcement is daily_logs' RLS policy, per Q7 — this only proves the UI
// honors it too). Same fixture idiom as testing-project-delete.spec.ts:
// override `projects` to mix a real fixture job into the fetch, registered
// after useSupabaseFixtures so it wins; daily_logs/time_shifts/
// unit_sessions/unit_redos all fall through to the shared fixture router's
// own empty-array default — an empty draft is exactly right here, since
// these tests are about the DIALOG's own behavior, not the draft's.
import { expect, test, type Page, type Route } from "@playwright/test";
import { jobFixtures, useSupabaseFixtures } from "./support/supabaseFixtures";

const BLACK22 = jobFixtures().find((j) => j.jobCode === "BLACK22")!;

const PROJECT = {
  id: BLACK22.projectId,
  job_code: "BLACK22",
  name: "Black Desert",
  address: null,
  status: "active",
};

function json(route: Route, body: unknown, rows = 0) {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    headers: { "content-range": `0-${Math.max(0, rows - 1)}/${rows}` },
    body: JSON.stringify(body),
  });
}

async function useProjectFixture(page: Page) {
  await page.route("**/rest/v1/projects**", (r) => json(r, [PROJECT], 1));
}

test("a foreman files a daily log: notes gate, then Smooth clears the reflection", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "foreman" });
  await useProjectFixture(page);

  const calls: Record<string, unknown>[] = [];
  await page.route("**/rest/v1/rpc/file_daily_log", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    calls.push(body);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ id: "new-log-id", ...body }),
    });
  });

  await page.goto(`/projects/${BLACK22.projectId}?tab=logs`);
  await expect(page.getByRole("heading", { name: "Daily logs" })).toBeVisible();

  await page.getByRole("button", { name: "+ Log today" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();

  // Notes is the one hard gate — Save starts disabled with a plain hint.
  const save = page.getByRole("dialog").getByRole("button", { name: "Save" });
  await expect(save).toBeDisabled();
  await expect(page.getByText("Add a few words about what got done before saving.")).toBeVisible();

  await page.getByLabel("Notes").fill("Installed 3 units, crew of 2.");
  await expect(save).toBeEnabled();

  // Stuck reveals the reflection inputs...
  await page.getByRole("dialog").getByRole("button", { name: "Stuck" }).click();
  await expect(page.getByLabel("What went well")).toBeVisible();
  await page.getByLabel("What went well").fill("Delivery showed up on time.");

  // ...switching to Smooth hides them again, and clears them at save.
  await page.getByRole("dialog").getByRole("button", { name: "Smooth" }).click();
  await expect(page.getByLabel("What went well")).toHaveCount(0);

  await save.click();
  await expect.poll(() => calls.length).toBe(1);
  expect(calls[0]).toMatchObject({
    p_project_id: BLACK22.projectId,
    p_notes: "Installed 3 units, crew of 2.",
    p_day_flow: "smooth",
    p_reflection: null,
  });
});

test("day-flow Stuck sends its reflection through — only Smooth clears it", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "foreman" });
  await useProjectFixture(page);

  const calls: Record<string, unknown>[] = [];
  await page.route("**/rest/v1/rpc/file_daily_log", async (route) => {
    calls.push(route.request().postDataJSON() as Record<string, unknown>);
    await route.fulfill({ status: 200, contentType: "application/json", body: "null" });
  });

  await page.goto(`/projects/${BLACK22.projectId}?tab=logs`);
  await page.getByRole("button", { name: "+ Log today" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();

  await page.getByLabel("Notes").fill("Rough day, glass arrived cracked.");
  await page.getByRole("dialog").getByRole("button", { name: "Stuck" }).click();
  await page.getByLabel("What went poorly").fill("Two panes cracked in transit.");
  await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();

  await expect.poll(() => calls.length).toBe(1);
  expect(calls[0]).toMatchObject({
    p_day_flow: "stuck",
    p_reflection: { went_poorly: "Two panes cracked in transit." },
  });
});

test("an installer never sees the Logs tab — RLS blocks the read, this proves the UI honors it too", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "installer" });
  await useProjectFixture(page);

  await page.goto(`/projects/${BLACK22.projectId}`);
  await expect(page.getByRole("heading", { name: "Overview" }).or(page.locator("h1"))).toBeVisible();
  await expect(page.getByRole("button", { name: "Logs" })).toHaveCount(0);

  // Even a direct deep link to ?tab=logs must not render the tab's content —
  // ProjectDetail.tsx only honors a lead-gated tabParam when isLead is true.
  await page.goto(`/projects/${BLACK22.projectId}?tab=logs`);
  await expect(page.getByRole("heading", { name: "Daily logs" })).toHaveCount(0);
});
