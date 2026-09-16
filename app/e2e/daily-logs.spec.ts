// Wave L: the filing dialog end to end, with mocked routes — pins
// file_daily_log's payload (the notes gate, day_flow, reflections cleared
// on Smooth) and installer access. Real database permissions are verified
// separately in verify-daily-reporting.mjs. Same fixture idiom as:
// override `projects` to mix a real fixture job into the fetch, registered
// after useSupabaseFixtures so it wins; daily_logs/time_shifts/
// unit_sessions/unit_redos all fall through to the shared fixture router's
// own empty-array default — an empty draft is exactly right here, since
// these tests are about the DIALOG's own behavior, not the draft's.
import { expect, test, type Page } from "@playwright/test";
import { jobFixtures, useSupabaseFixtures } from "./support/supabaseFixtures";
import { json } from "./support/specHelpers";

const BLACK22 = jobFixtures().find((j) => j.jobCode === "BLACK22")!;

const PROJECT = {
  id: BLACK22.projectId,
  job_code: "BLACK22",
  name: "Black Desert",
  address: null,
  status: "active",
};

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

for (const width of [390, 1280]) {
  test(`an installer opens and saves the shared job log at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await useSupabaseFixtures(page, { role: "installer" });
    await useProjectFixture(page);
    const calls: Record<string, unknown>[] = [];
    await page.route("**/rest/v1/rpc/file_daily_log", async route => {
      calls.push(route.request().postDataJSON());
      await route.fulfill({ status: 200, contentType: "application/json", body: "null" });
    });
    await page.goto(`/projects/${BLACK22.projectId}?tab=logs`);
    await expect(page.getByRole("button", { name: "Logs", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Daily logs" })).toBeVisible();
    await page.getByRole("button", { name: "+ Log today" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText(/One shared report per job per day/)).toBeVisible();
    await dialog.getByLabel("Notes", { exact: true }).fill("Installed frames and cleaned the job.");
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(() => calls.length).toBe(1);
    expect(calls[0]).toMatchObject({ p_project_id: BLACK22.projectId, p_notes: "Installed frames and cleaned the job." });
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText(/Share with builder/)).toHaveCount(0);
  });
}
