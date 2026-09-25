// Release 2 of the crew redesign on the real Ask page at iPhone width, with
// the Ask function and the clock RPCs answered from fixtures: the action
// cards get out of the way and come back (K2.2), every receipt shows its real
// status and a reply that only sounds done is contradicted (K2.5), All
// actions lists unshipped actions honestly (K2.1), and "going to lunch" ends
// in a Start break button whose tap uses the clock RPC (K2.4).
import { expect, test, type Page } from "@playwright/test";
import { useSupabaseFixtures } from "./support/supabaseFixtures";
import { json } from "./support/specHelpers";

const USER = "00000000-0000-4000-8000-0000000000e2";
const unit = { unit_id: "00000000-0000-4000-8000-000000000104", label: "4", type: "Bifold door", facts: {} };

/** Answer the Ask function from a queue of replies, recording each request. */
async function askAnswers(page: Page, replies: Record<string, unknown>[]) {
  const requests: Record<string, unknown>[] = [];
  await page.route("**/functions/v1/ask", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    requests.push(body);
    const reply = replies.shift() ?? { answer: "Which unit are you on?" };
    const field = body.field as Record<string, unknown> | undefined;
    // Receipts ride on the request's own id, as the function returns them.
    const withField = reply.receipts && field
      ? { ...reply, field: { request_id: field.request_id, receipts: reply.receipts, checklist: null } }
      : reply;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(withField) });
  });
  return requests;
}

const composer = (page: Page) => page.locator(".ask-input input");
const cards = (page: Page) => page.locator(".ask-cards .ask-card");

test("cards for an installer, gone while typing, back with Actions, and a card tap keeps the typed words", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "installer" });
  const requests = await askAnswers(page, []);
  await page.goto("/ask");
  await expect(cards(page)).toHaveText(["Build a unit", "Daily log", "My hours", "All actions"]);
  await expect(page.getByText("Take supplies")).toHaveCount(0);

  await composer(page).fill("Unit 7 is a slider");
  await expect(page.locator(".ask-cards")).toHaveCount(0);
  await page.getByRole("button", { name: "Actions", exact: true }).click();
  await expect(cards(page).first()).toHaveText("Build a unit");
  await cards(page).first().click();
  // The card sent its own words as a field request; the typed words stayed.
  await expect(page.locator(".ask-bubble.mine").last()).toHaveText("Set up the unit I'm working on");
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0].question).toBe("Set up the unit I'm working on");
  expect((requests[0].field as { actor_id: string }).actor_id).toBe(USER);
  await expect(composer(page)).toHaveValue("Unit 7 is a slider");
  await expect(page.locator(".ask-cards")).toHaveCount(0);
  // Every card is a real thumb target (K-X4).
  await composer(page).fill("");
  for (const card of await cards(page).all()) expect((await card.boundingBox())!.height).toBeGreaterThanOrEqual(56);
});

test("All actions says which actions still live on a screen, and what Forge AI never does", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "foreman" });
  await askAnswers(page, []);
  await page.goto("/ask");
  await expect(cards(page)).toHaveText(["Build a unit", "Daily log", "All actions"]);
  await page.getByRole("button", { name: "All actions" }).click();
  const all = page.locator(".ask-all-actions");
  await expect(all).toContainText("Crew status");
  await expect(all).toContainText("not in Ask yet (release 3)");
  await expect(all.getByRole("link", { name: "Use the Team timecards screen for this" })).toHaveAttribute("href", "/team-timecards");
  await expect(all).toContainText("Forge AI never:");
  await expect(all).toContainText("Publish a schedule");
  await expect(all).not.toContainText("Plan the schedule");
});

test("a reply that only sounds done gets Nothing was saved yet; a real receipt shows its status", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "installer" });
  await askAnswers(page, [
    { answer: "Done — I've saved unit 4 with those details." },
    { answer: "Unit 4 has been saved.", receipts: [{ action_id: "a1", action: "save_unit", status: "done", outcome: "created", unit }] },
    { answer: "I started your timer on unit 4.", receipts: [{ action_id: "a2", action: "start_unit", status: "needs_choice", reason: "on_break", preview_hash: "h", options: [{ id: "end_break_and_start", label: "x" }, { id: "cancel", label: "y" }], unit }] },
  ]);
  await page.goto("/ask");
  // "Build unit …" is field work to the phone's router, so the (mocked) model
  // answers rather than the free offline brain, which would have matched
  // "bifold door" in the glossary first.
  await composer(page).fill("Build unit 4 as a bifold door");
  await composer(page).press("Enter");
  await expect(page.locator(".field-nothing-saved")).toContainText("Nothing was saved yet");

  await composer(page).fill("Build unit 4 as a bifold door");
  await composer(page).press("Enter");
  const saved = page.locator(".field-receipt").first();
  await expect(saved).toContainText("Saved in Forge");
  await expect(saved).toContainText("Unit 4 saved.");
  await expect(page.locator(".field-nothing-saved")).toHaveCount(1);

  await composer(page).fill("Start unit 4");
  await composer(page).press("Enter");
  const waiting = page.locator(".field-receipt").nth(1);
  await expect(waiting).toContainText("Needs your choice");
  await expect(waiting).toContainText("nothing has changed yet");
  await expect(waiting.getByRole("button", { name: "End break and start" })).toBeVisible();
  await expect(page.locator(".field-nothing-saved")).toHaveCount(1);
});

test("going to lunch: a Start break button, and the tap uses the clock RPC", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "installer" });
  const shift = { id: "00000000-0000-4000-8000-000000000501", profile_id: USER, project_id: null, cost_code_id: null, clock_in_at: "2026-09-23T13:00:00Z", clock_out_at: null, break_seconds: 0, break_started_at: null, injured: null, time_confirmed: null, status: "open", created_at: "2026-09-23T13:00:00Z" };
  await page.route("**/rest/v1/time_shifts**", (r) => json(r, shift, 1));
  const breaks: Record<string, unknown>[] = [];
  await page.route("**/rest/v1/rpc/start_break", async (route) => {
    breaks.push(route.request().postDataJSON() as Record<string, unknown>);
    await json(route, { ...shift, break_started_at: "2026-09-23T17:00:00Z", break_type: "lunch" }, null);
  });
  await askAnswers(page, [{ answer: "Tap Start break below when you go.", buttons: [{ action: "start_break", break_type: "lunch" }] }]);
  await page.goto("/ask");
  await composer(page).fill("going to lunch");
  await composer(page).press("Enter");
  // The AI did not touch the clock; the button is offered.
  const start = page.getByRole("button", { name: "Start break", exact: true });
  await expect(start).toBeVisible();
  expect(breaks).toHaveLength(0);
  await start.click();
  await expect(page.locator(".field-buttons")).toContainText("On break — saved in Forge.");
  // One keyed punch (Release 0): the tap's one-time id and tap time ride along.
  expect(breaks).toHaveLength(1);
  expect(breaks[0]).toMatchObject({ p_shift_id: shift.id, p_break_type: "lunch" });
  expect(String(breaks[0].p_client_id)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(typeof breaks[0].p_tapped_at).toBe("string");
});

// Codex review of #641 (2026-09-25): the server saves the break and the reply
// is lost. The phone keeps the tap and sends it again — with the SAME id, so
// the server answers with the break it already started instead of a second.
test("a Start break whose reply is lost is sent again with the same id, and is one break", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "installer" });
  const shift = { id: "00000000-0000-4000-8000-000000000501", profile_id: USER, project_id: null, cost_code_id: null, clock_in_at: "2026-09-23T13:00:00Z", clock_out_at: null, break_seconds: 0, break_started_at: null, injured: null, time_confirmed: null, status: "open", created_at: "2026-09-23T13:00:00Z" };
  await page.route("**/rest/v1/time_shifts**", (r) => json(r, shift, 1));
  const sent: Record<string, unknown>[] = [];
  const started = new Set<string>();
  await page.route("**/rest/v1/rpc/start_break", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    sent.push(body);
    started.add(String(body.p_client_id));
    // The first one is saved, and its reply never reaches the phone.
    if (sent.length === 1) return route.abort("failed");
    await json(route, { ...shift, break_started_at: "2026-09-23T17:00:00Z", break_type: "lunch" }, null);
  });
  await askAnswers(page, [{ answer: "Tap Start break below when you go.", buttons: [{ action: "start_break", break_type: "lunch" }] }]);
  await page.goto("/ask");
  await composer(page).fill("going to lunch");
  await composer(page).press("Enter");
  await page.getByRole("button", { name: "Start break", exact: true }).click();
  // The phone could not know it was saved, so it says it kept it...
  await expect(page.locator(".field-buttons")).toContainText("On break — saved on this phone");
  // ...and the queue sends it again with the tap's own id.
  await expect.poll(() => sent.length).toBe(2);
  expect(sent[1].p_client_id).toBe(sent[0].p_client_id);
  expect(sent[1].p_tapped_at).toBe(sent[0].p_tapped_at);
  expect(started.size).toBe(1);
});
