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

// A saved headline must never replace the report's description, and neither
// the card nor editor may hide the end of a long report on a crew phone.
for (const width of [390, 1280]) {
  test(`a long saved report is fully readable and editable at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: width === 390 ? "dark" : "light" });
    await useSupabaseFixtures(page, { role: "installer" });
    await useProjectFixture(page);
    const headline = "6 units installed: one frame, four sliding doors and two windows, with hardware checked and the work area cleaned.";
    const notes = "Everything went smoothly today. We set the frame on the second floor, installed four sliding doors, and finished both windows on the west side.\n\nAll doors and windows were checked for operation, alignment, and sealant coverage. The crew protected the finished surfaces and moved the remaining material to the staging area.\n\nTomorrow: complete the exterior trim, verify the final measurements with the foreman, and walk the finished openings with the customer. Final detail: the spare hardware is labeled and stored by the west entrance.";
    const log = {
      id: "readable-log", project_id: BLACK22.projectId, log_date: "2026-09-15",
      headline, notes, day_flow: "smooth", reflection: null, weather: "Clear, 88°, breezy",
      customer_visible: false, filer: { display_name: "Test installer" },
    };
    await page.route("**/rest/v1/daily_logs**", route => json(route, [log]));
    const calls: Record<string, unknown>[] = [];
    await page.route("**/rest/v1/rpc/file_daily_log", route => {
      calls.push(route.request().postDataJSON());
      return json(route, log);
    });
    await page.goto(`/projects/${BLACK22.projectId}?tab=logs`);
    const report = page.locator(".daily-log-report");
    await expect(report.getByText(headline, { exact: true })).toBeVisible();
    await expect(report.locator(".daily-log-description")).toHaveText(notes);
    expect(await report.locator(".daily-log-description").evaluate(el => ({
      unclipped: el.scrollHeight <= el.clientHeight + 1,
      wraps: getComputedStyle(el).whiteSpace === "pre-wrap",
    }))).toEqual({ unclipped: true, wraps: true });
    // The fixture database warning is not part of the production layout.
    const screenshotStyle = ".pwa-banner-wrong-project { visibility: hidden; }";
    await report.screenshot({ path: testInfo.outputPath(`report-${width}.png`), style: screenshotStyle });
    await report.getByRole("button", { name: "Edit the log", exact: true }).click();
    const dialog = page.getByRole("dialog");
    const noteField = dialog.getByLabel("Notes", { exact: true });
    await expect(noteField).toHaveValue(notes);
    await expect(dialog.getByLabel("Headline", { exact: true })).toHaveValue(headline);
    const assertFits = async () => {
      for (const name of ["Headline", "Notes"]) {
        const field = dialog.getByLabel(name, { exact: true });
        expect(await field.evaluate(el => el.scrollHeight <= el.clientHeight + 1)).toBe(true);
      }
      expect(await dialog.locator(".daily-log-editor-body").evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      await expect(dialog.getByRole("button", { name: "Save", exact: true })).toBeInViewport();
    };
    await assertFits();
    await page.screenshot({ path: testInfo.outputPath(`editor-${width}.png`), style: screenshotStyle });
    const moreNotes = `${notes}\n\n${notes}`;
    await noteField.fill(moreNotes);
    await assertFits();
    // Rotation/reflow should resize existing text without requiring another keystroke.
    await page.setViewportSize({ width: 320, height: 740 });
    await expect.poll(() => noteField.evaluate(el => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1);
    await assertFits();
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(() => calls.length).toBe(1);
    expect(calls[0]).toMatchObject({ p_headline: headline, p_notes: moreNotes, p_weather: log.weather });
  });
}
