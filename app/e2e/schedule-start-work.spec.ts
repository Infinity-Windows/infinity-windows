// Start work on the SECOND of today's two jobs must land Work on THAT job.
// Expected to FAIL on the unchanged app (link to "/" drops the row; the
// strip primes the first scheduled job). Do not weaken: this is the baseline.

import { expect, test, type Page } from "@playwright/test";
import { useSupabaseFixtures } from "./support/supabaseFixtures";
import { dayISO, hideWrongProjectBanner, stubGeolocationDenied } from "./support/specHelpers";
import { BLACK22, OAKRIDGE } from "./support/release1Fixtures";
import {
  BLACK22_ASSIGNMENT,
  OAKRIDGE_ASSIGNMENT,
  scheduleStartWorkFixtures,
  type ScheduleStartWorkWorld,
} from "./support/scheduleStartWorkFixtures";

test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });

test("Start work on today's second job (BLACK22) opens Work with BLACK22 picked, not OAKRIDGE", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "installer", uiDesign: "new" });
  await hideWrongProjectBanner(page);
  await stubGeolocationDenied(page);
  const world = await scheduleStartWorkFixtures(page);
  test.info().annotations.push(
    { type: "clicked-assignment", description: BLACK22_ASSIGNMENT },
    { type: "clicked-project", description: BLACK22 },
    { type: "first-assignment", description: `${OAKRIDGE_ASSIGNMENT} (${OAKRIDGE})` },
  );

  await page.goto("/my-schedule");
  const screen = page.getByTestId("schedule-screen");
  await expect(screen).toBeVisible();
  const entries = screen.locator('[data-testid="schedule-entry"]');
  await expect(entries).toHaveCount(2);
  await expect(entries.nth(0)).toContainText("OAKRIDGE · Oakridge Apartments Bldg C");
  await expect(entries.nth(1)).toContainText("BLACK22 · Black Desert");
  expect(world.scheduleReads.length).toBeGreaterThan(0);

  const black22 = entries.nth(1);
  await black22.getByRole("link", { name: "Start work ›", exact: true }).click();

  await expect(page.getByTestId("work-screen")).toBeVisible();
  const clock = page.getByTestId("ws-clock");
  await expect(page.getByTestId("ws-start-day")).toBeVisible(); // clock known, off the clock
  await expect(clock).not.toContainText("Clocked in");

  await expect(clock).toContainText(/OAKRIDGE|BLACK22/); // Primed, not a blank/loading strip.
  // Prove the fixture did not block an operational write before judging the job.
  test.info().annotations.push(
    { type: "refused-writes", description: JSON.stringify(world.refusedWrites) },
    { type: "browser-write-attempts", description: JSON.stringify(world.browserWriteAttempts) },
    { type: "allowed-read-posts", description: JSON.stringify(world.allowedReadPosts) },
  );
  expect(world.refusedWrites).toEqual([]);
  expect(world.browserWriteAttempts.filter((a) => !world.allowedReadPosts.some((r) => r.url === a.url))).toEqual([]);
  expect(world.morning.clockIns).toEqual([]);
  expect(world.morning.workCommands).toEqual([]);
  expect(world.morning.signatures).toBe(0);
  expect(world.morning.designWrites).toEqual([]);
  test.info().annotations.push({ type: "clock context before selected-job assertion", description: await clock.innerText() });
  // The finding under test.
  await expect(clock).toContainText("BLACK22");
  await expect(clock).not.toContainText("OAKRIDGE");
  expect(world.refusedWrites).toEqual([]);
  expect(world.browserWriteAttempts.filter((a) => !world.allowedReadPosts.some((r) => r.url === a.url))).toEqual([]);
  expect(world.morning.clockIns).toEqual([]);
  expect(world.morning.workCommands).toEqual([]);
  expect(world.morning.signatures).toBe(0);
});

// ---- The fix's acceptance (2026-10-05) --------------------------------------
// None of these taps Start day, signs or edits the clock: start-day.spec.ts
// covers what a punch does. These cover only which job Work lands on.

// This is Playwright fixture setup; its historical use-prefix is not a React hook.
const installSupabaseFixtures = useSupabaseFixtures;
async function openSchedule(page: Page, opts: Parameters<typeof scheduleStartWorkFixtures>[1] = {}) {
  await installSupabaseFixtures(page, { role: "installer", uiDesign: "new" });
  await hideWrongProjectBanner(page);
  await stubGeolocationDenied(page);
  const world = await scheduleStartWorkFixtures(page, opts);
  await page.goto("/my-schedule");
  const entries = page.getByTestId("schedule-screen").locator('[data-testid="schedule-entry"]');
  await expect(entries).toHaveCount(2);
  await expect(entries.nth(1)).toContainText("BLACK22 · Black Desert");
  return { world, startBlack22: () => entries.nth(1).getByRole("link", { name: "Start work ›", exact: true }).click() };
}

/** The verification's own read: listMyPublished for TODAY only (Work's own window runs a week). */
function verificationReads(world: ScheduleStartWorkWorld, after: number) {
  const today = dayISO(0);
  return world.reads.filter((r) => {
    if (r.seq < after || r.table !== "schedule_assignments") return false;
    const url = new URL(r.url);
    return url.searchParams.get("start_date") === `lte.${today}` && url.searchParams.get("end_date") === `gte.${today}`;
  });
}

function expectNoClockOrWorkWrites(world: ScheduleStartWorkWorld, foregroundAllowed = false) {
  expect(world.refusedWrites).toEqual([]);
  const admitted = [...world.allowedReadPosts, ...(foregroundAllowed ? world.foregroundTouches : [])];
  expect(world.browserWriteAttempts.filter((a) => !admitted.some((r) => r.url === a.url && r.method === a.method))).toEqual([]);
  if (!foregroundAllowed) expect(world.foregroundTouches).toEqual([]);
  else {
    const touches = world.browserWriteAttempts.filter((a) => new URL(a.url).pathname.endsWith("/rpc/touch_shift_location"));
    expect(touches.length).toBe(world.foregroundTouches.length);
    for (const touch of world.foregroundTouches) expect(touch.payload).toEqual({ p_lat: null, p_lng: null, p_accuracy_m: null });
    test.info().annotations.push({ type: "existing-shift-foreground-writes", description: JSON.stringify(world.foregroundTouches) });
  }
  expect(world.morning.clockIns).toEqual([]);
  expect(world.morning.workCommands).toEqual([]);
  expect(world.morning.signatures).toBe(0);
  expect(world.morning.designWrites).toEqual([]);
}

test("the tapped job is confirmed by FRESH reads after the tap, and the tap cannot be replayed by reload or Back", async ({ page }) => {
  const { world, startBlack22 } = await openSchedule(page);
  const mark = world.reads.length;
  await startBlack22();
  const clock = page.getByTestId("ws-clock");
  await expect(clock.locator(".ws-clock-pick-job")).toContainText("BLACK22");
  await expect(clock).not.toContainText("OAKRIDGE");
  await expect(page.getByTestId("ws-schedule-intent")).toHaveCount(0);
  // Positive receipts: a today-only schedule read and a job-list read, both after the tap.
  expect(verificationReads(world, mark).length).toBeGreaterThan(0);
  expect(world.reads.some((r) => r.seq >= mark && r.table === "projects")).toBe(true);
  test.info().annotations.push({ type: "verification-reads", description: JSON.stringify(verificationReads(world, mark).map((r) => r.url)) });
  // Only our key left history.
  expect(await page.evaluate(() => JSON.stringify(window.history.state))).not.toContain("forgeScheduleStartWork");

  // Reload: an ordinary visit to Work — the first job primes again, as before.
  await page.reload();
  await expect(page.getByTestId("ws-start-day")).toBeVisible();
  await expect(clock.locator(".ws-clock-pick-job")).toContainText("OAKRIDGE");
  await expect(page.getByTestId("ws-schedule-intent")).toHaveCount(0);

  // Back from Schedule onto the same entry: still nothing to replay.
  await page.getByRole("navigation", { name: "Main" }).getByText("Schedule").click();
  await expect(page.getByTestId("schedule-screen")).toBeVisible();
  await page.goBack();
  await expect(page.getByTestId("ws-start-day")).toBeVisible();
  await expect(clock.locator(".ws-clock-pick-job")).toContainText("OAKRIDGE");
  expectNoClockOrWorkWrites(world);
});

test("an open OAKRIDGE shift wins over a BLACK22 tap: Work stays on it and nothing switches", async ({ page }) => {
  const { world, startBlack22 } = await openSchedule(page, { openShift: true });
  await startBlack22();
  const clock = page.getByTestId("ws-clock");
  await expect(clock).toContainText("Clocked in");
  await expect(clock).toContainText("OAKRIDGE");
  await expect(clock).not.toContainText("BLACK22");
  await expect(page.getByTestId("ws-start-day")).toHaveCount(0);
  await expect(page.getByTestId("ws-schedule-intent")).toHaveCount(0);
  expectNoClockOrWorkWrites(world, true);
});

test("a fresh check that fails asks the person to choose — the first job is never put on the button", async ({ page }) => {
  const { world, startBlack22 } = await openSchedule(page);
  world.scheduleMode = "fail";
  await startBlack22();
  const clock = page.getByTestId("ws-clock");
  await expect(page.getByTestId("ws-schedule-intent")).toContainText("We couldn’t confirm that scheduled job. Choose your job.");
  await expect(clock.locator(".ws-clock-pick-job")).not.toContainText(/OAKRIDGE|BLACK22/);
  // Start day here opens the job picker; it does not punch.
  await page.getByTestId("ws-start-day").click();
  await page.locator(".ws-list-item", { hasText: "BLACK22" }).click();
  await expect(clock.locator(".ws-clock-pick-job")).toContainText("BLACK22");
  await expect(page.getByTestId("ws-schedule-intent")).toHaveCount(0);
  expectNoClockOrWorkWrites(world);
});

/** Schedule reads made since `after` that are held (members is the first step of listMyPublished). */
function heldMemberReads(world: ScheduleStartWorkWorld, after: number) {
  return world.reads.filter((r) => r.seq >= after && r.table === "schedule_assignment_members").length;
}

/**
 * Release the held schedule reads with the canonical rows, then wait for the
 * POSITIVE receipt that every one of them came all the way back: one finished
 * time-off read (listMyPublished's last step) per held chain, and the
 * verification's own today-only assignments read among them. Then let the
 * page run the tasks queued behind those answers. No fixed sleep.
 */
async function releaseAndAwaitAnswers(page: Page, world: ScheduleStartWorkWorld, mark: number) {
  const held = heldMemberReads(world, mark);
  expect(held).toBeGreaterThan(0);
  const before = world.timeOffAnswered.length;
  world.scheduleMode = "pass";
  world.release();
  await expect.poll(() => world.timeOffAnswered.length - before).toBeGreaterThanOrEqual(held);
  expect(verificationReads(world, mark).length).toBeGreaterThan(0);
  await page.evaluate(() => new Promise<void>((done) => setTimeout(() => requestAnimationFrame(() => setTimeout(done, 0)), 0)));
}

test("a hand pick of a third job made while the check is held beats the late BLACK22 answer", async ({ page }) => {
  const { world, startBlack22 } = await openSchedule(page);
  world.scheduleMode = "hold";
  const mark = world.reads.length;
  await startBlack22();
  const clock = page.getByTestId("ws-clock");
  await expect(page.getByTestId("ws-schedule-intent")).toContainText("Checking your scheduled job");
  await expect(page.getByTestId("ws-start-day")).toBeDisabled();
  // The check is in flight and held at its first read.
  await expect.poll(() => heldMemberReads(world, mark)).toBeGreaterThan(0);
  await clock.getByRole("button", { name: "Change" }).click();
  // PECAN14 is in the canonical projects fixture (active), neither of today's jobs.
  await page.locator(".ws-list-item", { hasText: "PECAN14" }).click();
  await expect(clock.locator(".ws-clock-pick-job")).toContainText("PECAN14");
  await expect(page.getByTestId("ws-schedule-intent")).toHaveCount(0);
  await releaseAndAwaitAnswers(page, world, mark);
  // The answer that would have said BLACK22 has landed; the hand pick stands.
  await expect(clock.locator(".ws-clock-pick-job")).toContainText("PECAN14");
  await expect(clock.locator(".ws-clock-pick-job")).not.toContainText("BLACK22");
  await expect(page.getByTestId("ws-schedule-intent")).toHaveCount(0);
  expectNoClockOrWorkWrites(world);
});

test("a note typed while the check is held is not a job choice: the confirmed BLACK22 still primes", async ({ page }) => {
  const { world, startBlack22 } = await openSchedule(page);
  world.scheduleMode = "hold";
  const mark = world.reads.length;
  await startBlack22();
  const clock = page.getByTestId("ws-clock");
  await expect(page.getByTestId("ws-schedule-intent")).toContainText("Checking your scheduled job");
  await expect.poll(() => heldMemberReads(world, mark)).toBeGreaterThan(0);
  await clock.getByRole("button", { name: "Change" }).click();
  // The picker's note box (JobPickSheet: VoiceTextarea id="ws-jobpick-note").
  const note = page.locator('textarea#ws-jobpick-note, .ws-sheet textarea').first();
  await note.fill("Gate code 1234");
  // Still checking, still nothing on the button.
  await expect(page.getByTestId("ws-schedule-intent")).toContainText("Checking your scheduled job");
  await expect(page.getByTestId("ws-start-day")).toBeDisabled();
  await expect(clock.locator(".ws-clock-pick-job")).not.toContainText(/OAKRIDGE|BLACK22/);
  await releaseAndAwaitAnswers(page, world, mark);
  await expect(clock.locator(".ws-clock-pick-job")).toContainText("BLACK22");
  await expect(clock.locator(".ws-clock-pick-job")).not.toContainText("OAKRIDGE");
  await expect(page.getByTestId("ws-schedule-intent")).toHaveCount(0);
  await expect(note).toHaveValue("Gate code 1234");
  expectNoClockOrWorkWrites(world);
});
