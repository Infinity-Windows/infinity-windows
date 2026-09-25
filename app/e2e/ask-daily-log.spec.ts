// The daily log through the real Ask page (K2.7), with other contributors
// already on the day's log: Frank started it, Ben adds to it while this
// person is working. The first append is refused as stale and NOTHING is
// written; the card shows what the log says now; the second append saves
// against the new revision. Every append carries only this person's own
// words and the one Ask message they came from — never anyone else's text.
import { expect, test, type Locator, type Page } from "@playwright/test";
import { useSupabaseFixtures } from "./support/supabaseFixtures";
import { dayISO, json } from "./support/specHelpers";
import { useSyntheticMicrophone } from "./support/voiceFixture";

const USER = "00000000-0000-4000-8000-0000000000e2";
const BLACK22 = "ebf64f94-0413-4434-aeb3-1aff228fb5b3";
const today = dayISO(0);
const frank = (revision: number, notes: string) => ({
  id: "log-1", revision, notes, headline: null, day_flow: null, weather: null, reflection: null,
  filed_by: "00000000-0000-4000-8000-00000000f003", updated_at: `${today}T14:00:00Z`, filer: { display_name: "Frank" },
});

test("an installer's entry is added under Frank's and Ben's, never over them, and a stale save writes nothing", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "installer" });
  // The shared log as Frank left it, at revision 2.
  await page.route("**/rest/v1/daily_logs**", (r) => json(r, frank(2, "Frank: framed the north wall"), 1));
  const asks: Record<string, unknown>[] = [];
  await page.route("**/functions/v1/ask", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    asks.push(body);
    const field = body.field as Record<string, unknown>;
    const draft = body.daily_log as Record<string, unknown>;
    // What the function does with a daily-log turn: the tool's answers, tied
    // to this saved message and conversation.
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      answer: "Got it: six frames on the east wall with Ben. Which job is this for? Check the card and tap Save daily log.",
      field: { request_id: field.request_id, receipts: [], checklist: null },
      daily_log: { draft_id: draft.draft_id, actor_id: draft.actor_id, tool_inputs: [{ work_completed: "Set six frames on the east wall", people: "Ben", unknown: [] }], request_id: field.request_id, conversation_id: field.conversation_id },
    }) });
  });
  const appends: Record<string, unknown>[] = [];
  await page.route("**/rest/v1/rpc/append_daily_log_contribution", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    appends.push(body);
    if (appends.length === 1) {
      // Ben got there first: the log moved to revision 3. Nothing is written.
      return json(route, { status: "stale", expected_revision: body.p_expected_revision, current_revision: 3, log: { ...frank(3, "Frank: framed the north wall\n\nAdded by Ben with Forge AI:\nWork completed: Hung the door on unit 2"), filed_by_name: "Frank" } }, null);
    }
    return json(route, {
      status: "saved", contribution_id: body.p_id, log_id: "log-1", project_id: body.p_project_id, log_date: body.p_log_date, actor_id: USER, actor_name: "E2E Fixture",
      base_revision: body.p_expected_revision, saved_revision: 4, created_log: false, saved_at: new Date().toISOString(), photo_ids: [],
      log: { ...frank(4, "…"), filed_by_name: "Frank" },
    }, null);
  });

  await page.goto("/ask");
  const composer = page.locator(".ask-input input");
  await composer.fill("Build today's daily log — I set six frames on the east wall with Ben");
  await composer.press("Enter");
  // The first message already carried the draft, as a field request.
  await expect.poll(() => asks.length).toBe(1);
  expect((asks[0].field as { actor_id: string }).actor_id).toBe(USER);
  expect((asks[0].daily_log as { actor_id: string }).actor_id).toBe(USER);
  const card = page.locator(".ai-log-card");
  await expect(card.getByRole("textbox", { name: "Work completed" })).toHaveValue("Set six frames on the east wall");
  await expect(card.getByRole("textbox", { name: "People involved" })).toHaveValue("Ben");
  await expect(page.locator(".field-nothing-saved")).toHaveCount(0);

  // The job is the person's tap.
  await card.getByRole("button", { name: "Choose a job" }).click();
  await card.getByRole("button", { name: /BLACK22/ }).click();
  await expect(card).toContainText("Started by Frank");
  await expect(card).toContainText("Frank: framed the north wall");
  await expect(card.locator(".ai-log-preview")).toContainText("Added by E2E Fixture with Forge AI:");
  await expect(card.locator(".ai-log-preview")).toContainText("People: Ben");

  await card.getByRole("button", { name: "Save daily log" }).click();
  await expect(card).toContainText("Someone else added to this log while you were working. Nothing of yours was saved yet.");
  await expect(card).toContainText("Added by Ben with Forge AI");
  expect(appends).toHaveLength(1);
  expect(appends[0]).toMatchObject({ p_actor: USER, p_project_id: BLACK22, p_log_date: today, p_expected_revision: 2 });

  await card.getByRole("button", { name: "Save daily log" }).click();
  await expect(card).toContainText("Added to the log started by Frank.");
  expect(appends).toHaveLength(2);
  expect(appends[1]).toMatchObject({ p_expected_revision: 3, p_photo_ids: [] });
  for (const a of appends) {
    // Only this person's words and evidence: never Frank's or Ben's text.
    expect(a.p_body).toContain("Work completed: Set six frames on the east wall");
    expect(a.p_body).toContain("People: Ben");
    expect(a.p_body).not.toContain("Frank");
    expect(a.p_body).not.toContain("Hung the door");
    expect(a.p_source_request_ids).toEqual([(asks[0].field as { request_id: string }).request_id]);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

// The owner, dictating a daily log on an iPhone (2026-09-24): the recording
// bar should follow him so the pulsing Stop is always in reach; options he
// put away kept opening again every time he used the microphone; and the
// reply landed above those options, out of view — "it should be the most
// recent thing I see." Run at iPhone size and at laptop width.
const unit4 = { unit_id: "00000000-0000-4000-8000-000000000104", label: "4", type: "Bifold door", facts: {} };

/** Wholly on screen with no scrolling and nothing over it: inside the window,
 * under the phone's sync strip once it is stuck to the top, clear of the
 * fixed banners (this fixture always shows "Wrong database" at the top), and
 * above the phone tab bar. */
async function expectOnScreen(page: Page, target: Locator) {
  await expect.poll(async () => {
    const box = await target.boundingBox();
    const edges = await page.evaluate(() => {
      let top = 0, bottom = window.innerHeight;
      const strip = document.querySelector(".sync-strip")?.getBoundingClientRect();
      if (strip && strip.height > 0 && strip.top <= 1) top = strip.bottom;
      for (const el of document.querySelectorAll(".pwa-banner, .tabbar")) {
        const r = el.getBoundingClientRect();
        if (!r.height) continue;
        if ((r.top + r.bottom) / 2 < window.innerHeight / 2) top = Math.max(top, r.bottom);
        else bottom = Math.min(bottom, r.top);
      }
      return { top, bottom };
    });
    return !!box && box.y >= edges.top - 1 && box.y + box.height <= edges.bottom + 1;
  }).toBe(true);
}

for (const size of [{ width: 375, height: 812 }, { width: 1280, height: 800 }]) {
  test(`a daily log by voice at ${size.width}px: the recorder follows the scroll, put-away options stay away, the reply lands in view`, async ({ page }) => {
    await page.setViewportSize(size);
    await useSupabaseFixtures(page, { role: "installer" });
    await useSyntheticMicrophone(page);
    await page.route("**/rest/v1/daily_logs**", (r) => json(r, [], 0));
    // The recording goes to the speaker's own folder, then is written out —
    // held here so the "writing it out" moment can be looked at.
    await page.route("**/storage/v1/object/ai-field-memos/**", (r) => json(r, { Key: "ai-field-memos/memo" }));
    let writeOut: () => void = () => {};
    const written = new Promise<void>((resolve) => { writeOut = resolve; });
    await page.route("**/functions/v1/transcribe-description", async (r) => {
      await written;
      await json(r, { text: "I set six frames on the east wall with Ben and finished unit 4" });
    });
    const asks: Record<string, unknown>[] = [];
    await page.route("**/functions/v1/ask", async (route) => {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      asks.push(body);
      const field = body.field as Record<string, unknown>;
      const draft = body.daily_log as Record<string, unknown>;
      const spoken = asks.length > 1;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
        answer: spoken
          ? "Got it: six frames on the east wall with Ben, and unit 4 is saved. Check the card, then tap Save daily log."
          : "Tell me what you got done today. Tap Answer by voice and talk.",
        field: { request_id: field.request_id, checklist: null,
          receipts: spoken ? [{ action_id: "a1", action: "save_unit", status: "done", outcome: "created", unit: unit4 }] : [] },
        daily_log: { draft_id: draft.draft_id, actor_id: draft.actor_id, request_id: field.request_id, conversation_id: field.conversation_id,
          tool_inputs: spoken ? [{ work_completed: "Set six frames on the east wall", people: "Ben", unknown: [] }] : [] },
      }) });
    });

    await page.goto("/ask");
    const actionCards = page.locator(".ask-cards");
    await expect(actionCards.locator(".ask-card")).toHaveCount(4);
    // 1. The options, put away.
    await page.getByRole("button", { name: "Hide actions" }).click();
    await expect(actionCards).toHaveCount(0);

    // 2. The daily log is started by typing; the reply is on screen and the
    //    options stay away.
    const composer = page.locator(".ask-input input");
    await composer.fill("Build today's daily log");
    await composer.press("Enter");
    const card = page.locator(".ai-log-card");
    await expect(card).toBeVisible();
    const reply = page.locator(".ask-msg:not(.mine)").last();
    await expect(reply).toContainText("Tell me what you got done today");
    await expectOnScreen(page, reply.locator(".ask-bubble"));
    await expect(actionCards).toHaveCount(0);

    // 3. Answer by voice from the card, part-way down the page.
    await card.getByRole("button", { name: "Answer by voice" }).click();
    const stop = page.getByRole("button", { name: /^Stop and send/ });
    await expect(stop).toBeVisible();
    await expect.poll(() => page.evaluate(() => Reflect.get(window, "syntheticAudioBytes") as number)).toBeGreaterThan(1000);
    const status = page.locator(".ask-dock-status");
    await expect(status).toHaveText("Recording — tap the square to stop and send");
    // At the very top of the page the recorder is still on screen, clear of the tab bar…
    await page.evaluate(() => window.scrollTo(0, 0));
    await expectOnScreen(page, stop);
    await expectOnScreen(page, status);
    await page.screenshot({ path: `e2e/test-results/ask-recorder-top-${size.width}.png` });
    // …and in the middle of the daily log card.
    await card.getByRole("textbox", { name: "Work completed" }).scrollIntoViewIfNeeded();
    await expectOnScreen(page, stop);
    await page.screenshot({ path: `e2e/test-results/ask-recorder-card-${size.width}.png` });
    // Stop from right there; while it is written out the pinned bar says so.
    await stop.click();
    await expect(status).toHaveText("Writing out what you said…");
    await expectOnScreen(page, status);
    writeOut();

    // 4. Their words, then the reply and its receipt, on screen together
    //    above the card — without a scroll from the person.
    const spoken = page.locator(".ask-bubble.mine").last();
    await expect(spoken).toHaveText("I set six frames on the east wall with Ben and finished unit 4");
    await expect(reply).toContainText("unit 4 is saved");
    const receipt = reply.locator(".field-receipt");
    await expect(receipt).toContainText("Saved in Forge");
    await expectOnScreen(page, spoken);
    await expectOnScreen(page, reply.locator(".ask-bubble"));
    await expectOnScreen(page, receipt);
    await expect(page.locator(".ask-dock")).not.toHaveClass(/is-pinned/);
    await expect(card.getByRole("textbox", { name: "Work completed" })).toHaveValue("Set six frames on the east wall");
    await page.screenshot({ path: `e2e/test-results/ask-reply-in-view-${size.width}.png` });
    expect(asks).toHaveLength(2);
    expect(asks[1].field).toMatchObject({ input_kind: "voice" });

    // 5. The options stayed away through all of it; Actions brings them back.
    await expect(actionCards).toHaveCount(0);
    await page.getByRole("button", { name: "Actions", exact: true }).click();
    await expect(actionCards.locator(".ask-card")).toHaveCount(4);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(size.width);
  });
}
