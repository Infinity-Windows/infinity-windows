// Classic ↔ new continuity (reveal switch-back review, 2026-10-05).
//
// new-design-switch.spec.ts proves the front door changes. These prove the
// accounting fields do not: one saved open shift in both designs; the new
// design reads saved assignment/opening rows, then keeps showing those cards
// or the owner's real master switch, on a 390×844 phone. Every state change
// happens inside a request handler in designContinuityFixtures.ts — never by
// the spec editing fixture data after a click — and every assertion is about
// what the app read and rendered after a reload. Foreground last-seen stamps
// are separately expected; classic unit/schedule UI is outside this test.
//
// Limits, stated so nobody counts this as more: fixture browsers, one
// TEST_USER identity throughout (a second context is a second phone for the
// same person, not a second person), no server authorization, no realtime
// propagation, no offline or unknown-master policy, no installed PWA.

import { expect, test, type Page } from "@playwright/test";
import {
  CONTINUITY_SCHEDULE_ID,
  CONTINUITY_OPENING_ID,
  CONTINUITY_SHIFT_ID,
  PRIOR_BREAK_SECONDS,
  createContinuityServer,
  openContinuityPage,
  readMark,
  shiftIdentity,
  shiftReadsSince,
  type ContinuityServer,
} from "./support/designContinuityFixtures";
import { INSTALL, OAKRIDGE } from "./support/release1Fixtures";

const PHONE = { width: 390, height: 844 };
test.use({ viewport: PHONE, deviceScaleFactor: 2 });

const JOB_LINE = "OAKRIDGE · Oakridge Apartments Bldg C";

/** Settings → the person's own design button, and wait for the saved row to move. */
async function chooseDesign(page: Page, server: ContinuityServer, design: "classic" | "new") {
  await page.goto("/settings");
  const name = design === "new" ? "Use the new design" : "Use the classic design";
  const button = page.getByRole("button", { name });
  await expect(button).toBeEnabled();
  const before = server.log.designRpc.length;
  await button.click();
  await expect.poll(() => server.log.designRpc.slice(before)).toEqual([{ p_design: design }]);
  // Moved by the RPC handler, not by this spec.
  expect(server.profile.ui_design).toBe(design);
}

/** A fresh load of the landing, and proof the saved shift was served to it. */
async function reloadLanding(page: Page, server: ContinuityServer, session: string) {
  const mark = readMark(server);
  await page.goto("/");
  await page.reload();
  await expect.poll(() => shiftReadsSince(server, mark, session).length).toBeGreaterThan(0);
  return shiftReadsSince(server, mark, session);
}

async function expectClassicOnClock(page: Page, onBreak = false) {
  await expect(page.getByRole("heading", { name: "Current Work", exact: true })).toBeVisible();
  await expect(page.locator(".cw-heading")).toContainText("Oakridge Apartments Bldg C");
  await expect(page.locator(".cw-heading").getByRole("button", {
    name: onBreak ? "Clock in / resume" : "Job clock / break", exact: true,
  })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Main", exact: true }).getByRole("button", {
    name: onBreak ? "On break — open time tracking" : "On the clock", exact: true,
  })).toBeVisible();
  await expect(page.getByTestId("work-screen")).toHaveCount(0);
  await expect(page.locator(".clockin-block")).toHaveCount(0);
}

async function expectNewWork(page: Page, clockText: string) {
  await expect(page.getByTestId("work-screen")).toBeVisible();
  const clock = page.getByTestId("ws-clock");
  await expect(clock).toContainText(clockText);
  await expect(clock).toContainText("· OAKRIDGE");
  await expect(clock.locator(".ws-clock-label")).toHaveAttribute("title", JOB_LINE);
  // Same schedule assignment and same assigned opening, read back.
  const today = page.getByTestId("ws-today");
  await expect(today).toContainText("Oakridge Apartments Bldg C");
  await expect(today).toContainText("Starts 7:00 AM");
  await expect(today).toContainText("With Sam");
  await expect(page.getByTestId("ws-unit")).toContainText("W7");
  await expect(page.locator(".clockin-bar")).toHaveCount(0);
}

function expectSameSavedShift(reads: ReturnType<typeof shiftReadsSince>, server: ContinuityServer) {
  for (const r of reads) {
    expect(r).toMatchObject({
      id: CONTINUITY_SHIFT_ID,
      project_id: OAKRIDGE,
      cost_code_id: INSTALL,
      clock_in_at: server.seededShift.clock_in_at,
    });
  }
}

test("own choice classic → new → classic → new keeps the same open shift and assigned work visible in new", async ({ page }) => {
  const server = createContinuityServer({ uiDesign: "classic" });
  await openContinuityPage(page, server, { session: "phone", role: "installer" });

  // Classic, on the clock, from the saved shift.
  let reads = await reloadLanding(page, server, "phone");
  expectSameSavedShift(reads, server);
  await expectClassicOnClock(page);

  await chooseDesign(page, server, "new");
  const scheduleMark = server.log.scheduleReads.length;
  const openingMark = server.log.openingReads.length;
  reads = await reloadLanding(page, server, "phone");
  expectSameSavedShift(reads, server);
  await expectNewWork(page, "Clocked in");
  await expect(page.getByTestId("clock-badge")).toContainText("Clocked in");
  expect(server.log.scheduleReads.length).toBeGreaterThan(scheduleMark);
  for (const read of server.log.scheduleReads.slice(scheduleMark)) {
    expect(read.rows).toHaveLength(1);
    expect(read.rows[0]).toMatchObject({ id: CONTINUITY_SCHEDULE_ID, project_id: OAKRIDGE });
  }
  await expect.poll(() => server.log.openingReads.slice(openingMark).length).toBeGreaterThan(0);
  for (const read of server.log.openingReads.slice(openingMark)) {
    expect(read.row).toMatchObject({ id: CONTINUITY_OPENING_ID, project_id: OAKRIDGE, opening_code: "W7" });
  }

  await chooseDesign(page, server, "classic");
  reads = await reloadLanding(page, server, "phone");
  expectSameSavedShift(reads, server);
  await expectClassicOnClock(page);

  await chooseDesign(page, server, "new");
  reads = await reloadLanding(page, server, "phone");
  expectSameSavedShift(reads, server);
  await expectNewWork(page, "Clocked in");
  // Returning within the 30-second query freshness window may render the
  // phone's persisted assignment/opening answers. The same cards must remain;
  // the first new load above proves the served IDs. Do not require a duplicate
  // network read or clear the owner's phone cache to manufacture one.

  // Three preference writes; foreground last-seen stamps are logged separately.
  // No clock-in, new shift, break or unrequested operational edit.
  expect(server.log.designRpc).toEqual([{ p_design: "new" }, { p_design: "classic" }, { p_design: "new" }]);
  expect(server.log.unexpectedWrites).toEqual([]);
  expect(server.log.otherWrites).toEqual([]);
  expect(server.log.breakStarts).toEqual([]);
  expect(server.log.breakEnds).toEqual([]);
  expect(shiftIdentity(server.shift)).toEqual(shiftIdentity(server.seededShift));
  expect(server.shift.break_seconds).toBe(PRIOR_BREAK_SECONDS);
  // The preference the app read back follows the RPC, never ahead of it.
  expect(server.log.profileReads.map((r) => r.ui_design)).toContain("classic");
  expect(server.log.profileReads.at(-1)?.ui_design).toBe("new");
  test.info().annotations.push({ type: "edge-function attempts", description: JSON.stringify(server.log.otherWrites) });
});

test("a break started on Work is the same break in classic, and Resume ends it on the same shift", async ({ page }) => {
  const server = createContinuityServer({ uiDesign: "new" });
  server.expected.add("start_break");
  server.expected.add("end_break");
  await openContinuityPage(page, server, { session: "phone", role: "installer" });

  let reads = await reloadLanding(page, server, "phone");
  expectSameSavedShift(reads, server);
  await expectNewWork(page, "Clocked in");

  // The real path: badge → clock sheet → Go on break → Rest.
  await page.getByTestId("clock-badge").click();
  const sheet = page.locator(".clock-sheet");
  await expect(sheet).toBeVisible();
  await sheet.getByRole("button", { name: "Go on break" }).click();
  await sheet.getByRole("button", { name: "Rest", exact: true }).click();
  await expect.poll(() => server.log.breakStarts.length).toBe(1);
  expect(server.log.breakStarts[0]).toMatchObject({ p_shift_id: CONTINUITY_SHIFT_ID, p_break_type: "rest" });
  const started = server.log.breakAnswers.find((a) => a.rpc === "start_break");
  expect(started).toBeTruthy();
  const breakStartedAt = started!.break_started_at as string;
  expect(typeof breakStartedAt).toBe("string");
  expect(started).toMatchObject({ id: CONTINUITY_SHIFT_ID, break_type: "rest", break_seconds: PRIOR_BREAK_SECONDS });
  await expect(sheet.locator(".clock-sheet-title")).toHaveText("On break");
  await expect(sheet.locator(".clock-status-pill")).toContainText("On rest break");
  await sheet.getByRole("button", { name: "Close" }).click();

  // Switch to classic and read it back fresh: the same break, on the same shift.
  await chooseDesign(page, server, "classic");
  reads = await reloadLanding(page, server, "phone");
  expectSameSavedShift(reads, server);
  for (const r of reads) expect(r).toMatchObject({ break_started_at: breakStartedAt, break_type: "rest" });
  await expectClassicOnClock(page, true);
  await page.getByRole("navigation", { name: "Main", exact: true }).getByRole("button", { name: "On break — open time tracking", exact: true }).click();
  await expect(sheet).toBeVisible();
  await expect(sheet.locator(".clock-sheet-title")).toHaveText("On break");
  await expect(sheet.locator(".clock-status-pill")).toContainText("On rest break");
  await expect(sheet.getByRole("button", { name: "Resume work" })).toBeVisible();
  await sheet.getByRole("button", { name: "Close" }).click();

  // Back to new: the strip says so, and Resume ends that break.
  await chooseDesign(page, server, "new");
  reads = await reloadLanding(page, server, "phone");
  for (const r of reads) expect(r).toMatchObject({ id: CONTINUITY_SHIFT_ID, break_started_at: breakStartedAt });
  await expectNewWork(page, "On break");
  await expect(page.getByTestId("ws-clock").getByRole("button", { name: "Resume work" })).toBeVisible();
  await page.getByTestId("clock-badge").click();
  await expect(sheet).toBeVisible();
  await sheet.getByRole("button", { name: "Resume work" }).click();
  await expect.poll(() => server.log.breakEnds.length).toBe(1);
  expect(server.log.breakEnds[0]).toMatchObject({ p_shift_id: CONTINUITY_SHIFT_ID });
  const ended = server.log.breakAnswers.find((a) => a.rpc === "end_break");
  expect(ended).toMatchObject({ id: CONTINUITY_SHIFT_ID, break_started_at: null, break_type: null });
  const totalBreak = ended!.break_seconds as number;
  expect(totalBreak).toBeGreaterThan(PRIOR_BREAK_SECONDS);
  await expect(sheet.locator(".clock-sheet-title")).toHaveText("On the clock");
  // Independent expected display, without importing the live Supabase client.
  const breakDisplay = `${Math.floor(totalBreak / 3600)}:${String(Math.floor(totalBreak % 3600 / 60)).padStart(2, "0")}:${String(totalBreak % 60).padStart(2, "0")}`;
  await expect(sheet.locator(".clock-hero-sub")).toContainText(`Breaks today ${breakDisplay}`);
  await sheet.getByRole("button", { name: "Close" }).click();

  // One more fresh read: the resumed shift, its accumulated break, no new shift.
  reads = await reloadLanding(page, server, "phone");
  for (const r of reads) {
    expect(r).toMatchObject({ id: CONTINUITY_SHIFT_ID, break_started_at: null, break_seconds: totalBreak });
  }
  await expectNewWork(page, "Clocked in");

  expect(server.log.breakStarts).toHaveLength(1);
  expect(server.log.breakEnds).toHaveLength(1);
  expect(server.log.unexpectedWrites).toEqual([]);
  expect(server.log.otherWrites).toEqual([]);
  expect(server.log.designRpc).toEqual([{ p_design: "classic" }, { p_design: "new" }]);
  expect(shiftIdentity(server.shift)).toMatchObject({
    id: CONTINUITY_SHIFT_ID,
    project_id: OAKRIDGE,
    cost_code_id: INSTALL,
    clock_in_at: server.seededShift.clock_in_at,
    clock_out_at: null,
    status: "open",
  });
});

test("owner master switch off then on: a second session follows on its next fresh read and keeps its own choice", async ({ page, browser }, testInfo) => {
  const server = createContinuityServer({ uiDesign: "new", masterOn: true });
  server.expected.add("set_new_design_switch");

  // Session A: the owner's phone. Owner Work mounts while the switch is on.
  await openContinuityPage(page, server, { session: "owner-a", role: "owner" });
  await reloadLanding(page, server, "owner-a");
  await expect(page.getByTestId("work-screen")).toBeVisible();

  // Session B: an independently initialized browser context, same fixture
  // person, same shared server.
  const other = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 2, baseURL: testInfo.project.use.baseURL });
  try {
    const second = await other.newPage();
    await openContinuityPage(second, server, { session: "owner-b", role: "owner" });
    let reads = await reloadLanding(second, server, "owner-b");
    expectSameSavedShift(reads, server);
    await expect(second.getByTestId("work-screen")).toBeVisible();

    // Off, from the owner's real button.
    await page.goto("/settings");
    const card = page.getByRole("region", { name: "New design master switch" });
    await expect(card).toContainText("On — people can choose it");
    await card.getByRole("button", { name: "Turn off for everyone" }).click();
    await expect.poll(() => server.log.masterRpc).toEqual([{ p_release: "r1", p_enabled: false }]);
    expect(server.company.new_design_r1_enabled).toBe(false);
    await expect(card).toContainText("Off for everyone");

    // B on its next fresh read: classic, while its own saved choice stays new.
    const companyMark = server.log.companyReads.length;
    reads = await reloadLanding(second, server, "owner-b");
    expectSameSavedShift(reads, server);
    expect(server.log.companyReads.slice(companyMark).some((r) => r.session === "owner-b" && r.new_design_r1_enabled === false)).toBe(true);
    await expect(second.getByTestId("work-screen")).toHaveCount(0);
    expect(server.profile.ui_design).toBe("new");
    await second.goto("/settings");
    await expect(second.getByText("turned the new design off for everyone")).toBeVisible();

    // On again.
    await expect(card.getByRole("button", { name: "Turn on" })).toBeEnabled();
    await card.getByRole("button", { name: "Turn on" }).click();
    await expect
      .poll(() => server.log.masterRpc)
      .toEqual([{ p_release: "r1", p_enabled: false }, { p_release: "r1", p_enabled: true }]);
    await expect(card).toContainText("On — people can choose it");

    // B's own choice is restored on its next fresh read, same saved shift.
    reads = await reloadLanding(second, server, "owner-b");
    expectSameSavedShift(reads, server);
    await expect(second.getByTestId("work-screen")).toBeVisible();

    // Nobody's preference or accounting fields were rewritten. Foreground
    // last-seen stamps are expected and separately logged.
    expect(server.log.designRpc).toEqual([]);
    expect(server.log.unexpectedWrites).toEqual([]);
    expect(server.log.otherWrites).toEqual([]);
    expect(shiftIdentity(server.shift)).toEqual(shiftIdentity(server.seededShift));
  } finally {
    await other.close();
  }
});
