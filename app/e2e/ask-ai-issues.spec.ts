// Fixture-backed Ask report path. This spec does not send a real report.
import { expect, test } from "@playwright/test";
import { useSupabaseFixtures, TEST_USER } from "./support/supabaseFixtures";
import { hideWrongProjectBanner, json } from "./support/specHelpers";

test("saved setup stays closed after restored replies copy its checklist", async ({ page }) => {
  await hideWrongProjectBanner(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await useSupabaseFixtures(page, { role: "owner" });
  const checklist = { job: null, unit: [
    { key: "label", status: "captured", value: "42", required_before_timing: true },
    { key: "width", status: "captured", value: "72 in", required_before_timing: true },
  ] };
  const captured = { checklist, answers: { job: null, unit: { label: "42", width: 72 } } };
  // The REST history endpoint returns newest first. Later read-only replies
  // retain the saved answers, even though they have no new write receipt.
  await page.route("**/rest/v1/ai_field_requests**", (route) => json(route, [
    { id: "history-followup", transcript: "What next?", input_kind: "text", sent_at: "2026-10-01T12:01:00Z", reply: { answer: "Open My Work for your next unit." }, captured, finished_at: "2026-10-01T12:01:01Z" },
    { id: "history-save", transcript: "Save unit42", input_kind: "text", sent_at: "2026-10-01T12:00:00Z", reply: { answer: "Unit42 saved." }, captured, finished_at: "2026-10-01T12:00:01Z" },
  ]));
  await page.route("**/rest/v1/ai_field_actions**", (route) => json(route, [
    { id: "history-save-action", request_id: "history-save", action: "save_unit", status: "done", result: { status: "done", outcome: "created", unit: { unit_id: "fixture-unit42", label: "42", type: "Bifold", facts: {} } } },
  ]));
  await page.goto("/ask");
  await expect(page.getByText("Unit 42 saved.", { exact: true })).toBeVisible();
  await expect(page.getByText("Open My Work for your next unit.", { exact: true })).toBeVisible();
  await expect(page.getByRole("group", { name: "Setup checklist", exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByText("Unit 42 saved.", { exact: true })).toBeVisible();
  await expect(page.getByRole("group", { name: "Setup checklist", exact: true })).toHaveCount(0);
});

test("Ask reply offers an editable AI report and files only after Send", async ({ page }, testInfo) => {
  await hideWrongProjectBanner(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.addInitScript(() => localStorage.setItem("infinity.theme", "dark"));
  await useSupabaseFixtures(page, { role: "owner" });
  const writes: Record<string, unknown>[] = [];
  await page.route("**/rest/v1/app_feedback**", (route) => {
    if (route.request().method() === "POST") {
      writes.push(route.request().postDataJSON() as Record<string, unknown>);
      return json(route, null);
    }
    return json(route, [], 0);
  });
  await page.route("**/functions/v1/ask", (route) => json(route, { answer: "I could not complete the hours lookup.", sources: [] }));
  await page.goto("/ask");
  await page.locator(".ask-input input").fill("Show my hours for yesterday");
  await page.locator(".ask-input input").press("Enter");
  const report = page.getByRole("button", { name: "Report an AI issue" });
  await expect(report).toBeVisible();
  expect(writes).toHaveLength(0);
  await report.click();
  const preview = page.locator(".ai-issue-preview");
  await expect(preview).toContainText("Only this text is sent");
  const body = preview.locator("textarea");
  await expect(body).toHaveValue(/Show my hours for yesterday/);
  await expect(body).toHaveValue(/I could not complete the hours lookup/);
  expect(writes).toHaveLength(0);
  await body.fill("The AI could not find my hours. Please check the report tool.");
  await preview.getByRole("button", { name: "Send to App Issues" }).click();
  await expect(page.getByText("Sent to App Issues → AI.")).toBeVisible();
  expect(writes).toEqual([{ author: TEST_USER.id, kind: "bug", category: "ai", body: "The AI could not find my hours. Please check the report tool." }]);
  await expect(page.getByRole("button", { name: "Send to App Issues" })).toHaveCount(0);

  const live = page.getByRole("button", { name: "Start live conversation" });
  await expect(live).toHaveText("Start Live Chat");
  expect((await live.boundingBox())!.width).toBeLessThan(230);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("ask-phone.png") });
});


test("failed Live Chat offers a manual AI report without filing automatically", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "owner" });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: async () => { throw new Error("Microphone unavailable in test"); } } });
  });
  const writes: unknown[] = [];
  await page.route("**/rest/v1/app_feedback**", route => {
    if (route.request().method() === "POST") writes.push(route.request().postDataJSON());
    return json(route, []);
  });
  await page.goto("/ask");
  await page.getByRole("button", { name: "Start live conversation", exact: true }).click();
  const report = page.getByRole("button", { name: "Report an AI issue" });
  await expect(report).toBeVisible();
  expect(writes).toHaveLength(0);
  await report.click();
  await expect(page.locator(".ai-issue-preview textarea")).toHaveValue(/AI issue — Live Chat/);
  expect(writes).toHaveLength(0);
});


test("an Ask HTTP 500 keeps an editable AI report available without automatic filing", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "owner" });
  const writes: unknown[] = [];
  await page.route("**/rest/v1/app_feedback**", route => {
    if (route.request().method() === "POST") writes.push(route.request().postDataJSON());
    return json(route, []);
  });
  await page.route("**/functions/v1/ask", route => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "AI provider unavailable" }) }));
  await page.goto("/ask");
  await page.locator(".ask-input input").fill("Show my hours for yesterday");
  await page.locator(".ask-input input").press("Enter");
  const report = page.getByRole("button", { name: "Report an AI issue" });
  await expect(report).toBeVisible();
  expect(writes).toHaveLength(0);
  await report.click();
  const preview = page.locator(".ai-issue-preview textarea");
  await expect(preview).toHaveValue(/Show my hours for yesterday/);
  await preview.fill("AI request failed while its provider was unavailable.");
  await expect(preview).toHaveValue("AI request failed while its provider was unavailable.");
  expect(writes).toHaveLength(0);
  await expect(page.getByRole("button", { name: "Send to App Issues" })).toBeEnabled();
});
