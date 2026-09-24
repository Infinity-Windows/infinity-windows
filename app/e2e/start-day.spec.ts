// Start day (crew redesign K1.3 + the owner's paid-time rule + Q69),
// walked through on the real landing with the real sign card.
//
// Three mornings, one button. The K-X3 numbers the PR states come from
// here: Start day → working in ONE tap when the talk is signed, TWO
// (Start day, Sign) when it is not — in either order the rule puts them.

import { expect, test } from "@playwright/test";
import { useSupabaseFixtures } from "./support/supabaseFixtures";
import { dayISO, hideWrongProjectBanner, stubGeolocationDenied } from "./support/specHelpers";
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
