// Start day (crew redesign K1.3 + the owner's paid-time rule + Q69),
// walked through on the real landing with the real sign card.
//
// Three mornings, one button. The K-X3 numbers the PR states come from
// here: Start day → working in ONE tap when the talk is signed, TWO
// (Start day, Sign) when it is not — in either order the rule puts them.

import { expect, test, type Page } from "@playwright/test";
import { useSupabaseFixtures } from "./support/supabaseFixtures";
import { dayISO, hideWrongProjectBanner, json, stubGeolocationDenied } from "./support/specHelpers";
import { GENERAL, morningFixtures, OAKRIDGE, signTalk } from "./support/release1Fixtures";

test.use({ viewport: { width: 375, height: 667 }, deviceScaleFactor: 2 });

test("already signed: Start day is the clock-in — one tap, today's job, no second question", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "installer", uiDesign: "new" });
  await hideWrongProjectBanner(page);
  await stubGeolocationDenied(page);
  const world = await morningFixtures(page, { signed: true, myOpening: true });
  await page.goto("/");
  const clock = page.getByTestId("ws-clock");
  // Today's published job is preselected, not yesterday's BLACK22.
  await expect(clock).toContainText("OAKRIDGE · Oakridge Apartments Bldg C");
  await expect(clock).not.toContainText("BLACK22");
  // No punch on OAKRIDGE yet, so the cost code is the general one — said on
  // the strip before the tap, one tap to change.
  await expect(clock).toContainText("000 — General");
  await page.getByTestId("ws-start-day").click();
  await expect.poll(() => world.clockIns.length).toBe(1);
  expect(world.clockIns[0].p_project_id).toBe(OAKRIDGE);
  expect(world.clockIns[0].p_cost_code_id).toBe(GENERAL);
  // One keyed punch (Release 0): the tap's one-time id and tap time ride along.
  expect(String(world.clockIns[0].p_client_id)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(typeof world.clockIns[0].p_tapped_at).toBe("string");
  // Landed on Work, on the clock, with Next up filled from the plan (K1.4).
  await expect(page.getByTestId("work-screen")).toBeVisible();
  await expect(page.getByTestId("ws-clock")).toContainText("Clocked in");
  await expect(page.getByTestId("ws-unit")).toContainText("W7");
  await expect(page.getByTestId("ws-unit-start")).toBeEnabled();
  expect(world.clockIns).toHaveLength(1);
});

test("unsigned, rule off (today's timing): Start day opens the talk; signing it is the clock-in — two taps", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "installer", uiDesign: "new" });
  await hideWrongProjectBanner(page);
  await stubGeolocationDenied(page);
  const world = await morningFixtures(page, { signed: false, myOpening: true });
  await page.goto("/");
  const clock = page.getByTestId("ws-clock");
  await expect(clock).toContainText("Opens today's toolbox talk first.");
  await page.getByTestId("ws-start-day").click();
  // Tap 1: the talk, right here — no clock sheet, no second job list.
  await expect(page.locator(".clock-sheet")).toHaveCount(0);
  await expect(clock).toContainText("Ladders");
  expect(world.clockIns).toHaveLength(0);
  // Tap 2: sign it. The punch leaves on its own, once, with today's picks.
  await signTalk(page, clock);
  await expect.poll(() => world.clockIns.length).toBe(1);
  expect(world.clockIns[0].p_project_id).toBe(OAKRIDGE);
  await expect(page.getByTestId("ws-clock")).toContainText("Clocked in");
  await expect(page.getByTestId("ws-finish-talk")).toHaveCount(0);
  await expect(page.getByTestId("ws-unit-start")).toBeEnabled();
  expect(world.signatures).toBe(1);
  expect(world.clockIns).toHaveLength(1);
});

test("unsigned, rule ON: paid time starts at the tap; the talk waits on the clock and unit work is locked until signed", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "installer", uiDesign: "new" });
  await hideWrongProjectBanner(page);
  await stubGeolocationDenied(page);
  const world = await morningFixtures(page, { signed: false, myOpening: true, paidTimeFrom: dayISO(-1) });
  await page.goto("/");
  const clock = page.getByTestId("ws-clock");
  await expect(clock).toContainText("Paid time starts at this tap.");
  await page.getByTestId("ws-start-day").click();
  // Tap 1: the clock-in leaves first.
  await expect.poll(() => world.clockIns.length).toBe(1);
  await expect(page.getByTestId("ws-clock")).toContainText("Clocked in");
  // The clock keeps running; "Finish your toolbox talk" stays on Work; unit
  // work is locked in words; the heads-up says so.
  const finish = page.getByTestId("ws-finish-talk");
  await expect(finish).toContainText("Finish your toolbox talk");
  await expect(page.getByTestId("ws-unit")).toContainText("Sign today's toolbox talk to start a unit.");
  await expect(page.getByTestId("ws-unit-start")).toBeDisabled();
  await expect(page.getByTestId("ws-headsups")).toContainText("Toolbox talk not signed yet");
  // Tap 2: sign on the clock. No second punch; the lock lifts.
  await signTalk(page, finish);
  await expect(page.getByTestId("ws-finish-talk")).toHaveCount(0);
  await expect(page.getByTestId("ws-unit-start")).toBeEnabled();
  expect(world.clockIns).toHaveLength(1);
  expect(world.signatures).toBe(1);
});

test("the rule scheduled for a future day still runs today's timing", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "installer", uiDesign: "new" });
  await hideWrongProjectBanner(page);
  await stubGeolocationDenied(page);
  const world = await morningFixtures(page, { signed: false, paidTimeFrom: dayISO(7) });
  await page.goto("/");
  await expect(page.getByTestId("ws-clock")).toContainText("Opens today's toolbox talk first.");
  await page.getByTestId("ws-start-day").click();
  expect(world.clockIns).toHaveLength(0);
  await expect(page.getByTestId("ws-clock")).toContainText("Ladders");
});

// ---- Codex review of #642 (2026-09-25) --------------------------------------
// P1 2: a Start day tap is ONE punch through the live try, the queue and any
// hand-off. P1 3: no Start day until the clock is known.

const CLOCK_IN = (url: URL) => /\/rest\/v1\/rpc\/clock_in(\?|$)/.test(url.href);

test("a Start day whose reply is lost is sent again with the same id, mode and tap time, and is one shift", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "installer", uiDesign: "new" });
  await hideWrongProjectBanner(page);
  await stubGeolocationDenied(page);
  const world = await morningFixtures(page, { signed: true, myOpening: true });
  // The server saves the first clock-in and its reply never reaches the
  // phone. Registered after the fixtures, so it answers first; the resend
  // falls through to the fixture, which makes the shift.
  const sent: Record<string, unknown>[] = [];
  await page.route(CLOCK_IN, async (route) => {
    sent.push((route.request().postDataJSON() ?? {}) as Record<string, unknown>);
    if (sent.length === 1) return route.abort("failed");
    return route.fallback();
  });
  await page.goto("/");
  await page.getByTestId("ws-start-day").click();
  // The phone could not know it was saved, so it kept the punch — and the
  // queue sends it again with the tap's own id, mode and tap time.
  await expect.poll(() => sent.length).toBe(2);
  expect(sent[1].p_client_id).toBe(sent[0].p_client_id);
  expect(sent[1].p_tapped_at).toBe(sent[0].p_tapped_at);
  expect(sent[1].p_mode).toBe(sent[0].p_mode);
  expect(sent[1].p_project_id).toBe(OAKRIDGE);
  expect(new Set(sent.map((b) => b.p_client_id)).size).toBe(1);
  await expect(page.getByTestId("ws-clock")).toContainText("Clocked in");
  expect(world.clockIns).toHaveLength(1);
});

test("a cold open with a shift already on the server never offers Start day while the clock is still being read", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "installer", uiDesign: "new" });
  await hideWrongProjectBanner(page);
  await stubGeolocationDenied(page);
  const world = await morningFixtures(page, { signed: true, openShift: true, myOpening: true });
  // The open-shift read is slow: held until the screen has been looked at.
  let answer!: () => void;
  const held = new Promise<void>((resolve) => (answer = resolve));
  await page.route("**/rest/v1/time_shifts**", async (route) => {
    const url = new URL(route.request().url());
    if ((url.searchParams.get("status") ?? "").startsWith("in.")) await held;
    return route.fallback();
  });
  await page.goto("/");
  await expect(page.getByText(/Loading current work|Recovering your clock/)).toBeVisible();
  await expect(page.getByTestId("ws-start-day")).toHaveCount(0);
  answer();
  await expect(page.getByTestId("ws-clock")).toContainText("Clocked in");
  await expect(page.getByTestId("ws-start-day")).toHaveCount(0);
  expect(world.clockIns).toHaveLength(0);
});

/**
 * No signal: every Supabase call refused outright (a route answers before the
 * network, so setOffline alone would let the fixtures keep answering), the
 * app's own files passed through so a reload still works — the dead zone of
 * queued-clock.spec.ts.
 */
async function deadZone(page: Page) {
  const signal = { dead: false, refused: 0 };
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.host.startsWith("localhost")) {
      if (!signal.dead) return route.fallback();
      try {
        await route.fulfill({ response: await route.fetch() });
      } catch {
        await route.abort();
      }
      return;
    }
    if (signal.dead && /\/(rest|storage|functions)\/v1\//.test(url.pathname)) {
      signal.refused += 1;
      return route.abort("internetdisconnected");
    }
    return route.fallback();
  });
  return signal;
}

test("Start day with no signal stays on the phone; a reload with no signal shows you clocked in and never offers a second Start day", async ({ page, context }) => {
  await useSupabaseFixtures(page, { role: "installer", uiDesign: "new" });
  await hideWrongProjectBanner(page);
  await stubGeolocationDenied(page);
  const world = await morningFixtures(page, { signed: true, myOpening: true });
  await page.route((url) => /\/rest\/v1\/rpc\/server_now(\?|$)/.test(url.href), (r) => json(r, new Date().toISOString(), null));
  const signal = await deadZone(page);
  await page.goto("/");
  await expect(page.getByTestId("ws-start-day")).toBeVisible();

  signal.dead = true;
  await context.setOffline(true);
  const tappedAt = Date.now();
  await page.getByTestId("ws-start-day").click();
  const clock = page.getByTestId("ws-clock");
  await expect(clock).toContainText("Clocked in");
  await expect(clock).toContainText("Saved on this phone");
  expect(world.clockIns).toHaveLength(0);

  // A reload with no signal: the punch is on disk, so the person is still on
  // the clock, and nothing offers a clock-in.
  await page.reload();
  await expect(clock).toContainText("Clocked in", { timeout: 30_000 });
  await expect(clock).toContainText("Saved on this phone");
  await expect(page.getByTestId("ws-start-day")).toHaveCount(0);
  expect(world.clockIns).toHaveLength(0);
  expect(signal.refused, "the app really was cut off").toBeGreaterThan(0);

  // Signal returns: exactly one clock-in, carrying the tap's id and time.
  signal.dead = false;
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect.poll(() => world.clockIns.length).toBe(1);
  expect(String(world.clockIns[0].p_client_id)).toMatch(/^[0-9a-f-]{36}$/);
  const tapped = new Date(String(world.clockIns[0].p_tapped_at)).getTime();
  expect(Math.abs(tapped - tappedAt)).toBeLessThan(5_000);
  await expect(clock).not.toContainText("Saved on this phone");
  await expect(page.getByTestId("ws-start-day")).toHaveCount(0);
  await page.waitForTimeout(1_500);
  expect(world.clockIns).toHaveLength(1);
});
