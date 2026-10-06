// One daily log, filed through the classic job Logs tab, keeps the identity,
// revision and payload the server returned across the person's own design
// choice and the owner's master switch (saved-record continuity, 2026-10-05):
//
//   classic save → own choice new → classic → new (a settled hard reload each)
//   → owner master off → reload: classic, own choice still new
//   → owner master on  → reload: new
//
// The id is minted inside the file_daily_log route handler (the UI sends none)
// and read back from what the browser actually received and what the daily_logs
// route actually served — never seeded into app state, cache or storage. Every
// fixture change happens inside a route handler (designContinuityFixtures.ts,
// designRecordContinuityFixtures.ts, designDailyLogContinuityFixtures.ts).
// Classic readback: the Logs tab card and its Edit dialog. New readback: the
// /daily-logs card, its detail (/daily-logs?log=<id>) and the same
// DailyLogDialog opened from that detail.
//
// Limits: one synthetic OWNER (TEST_USER) in ONE disposable browser context;
// fixture routes, not file_daily_log SQL, PostgREST, RLS or auth; revision
// = expected + 1 is a fixture convention; not an installed PWA, not a physical
// phone, not field or QC proof.

import { expect, test, type Page } from "@playwright/test";
import { readMark, shiftReadsSince } from "./support/designContinuityFixtures";
import {
  DAILY_LOG_RPC_KEYS,
  FILER,
  PROJECT_JOIN,
  createDailyLogContinuityServer,
  openDailyLogContinuityPage,
  savedRow,
  type DailyLogContinuityServer,
} from "./support/designDailyLogContinuityFixtures";
import { OAKRIDGE } from "./support/release1Fixtures";

test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
test.setTimeout(180_000);

const SESSION = "owner-phone";
const HEADLINE = "Continuity check: 4 sliders set on the west side.";
const NOTES = "Set four sliders on the west elevation and sealed the sills. Staging cleaned before leaving.";
type Row = Record<string, unknown>;

function effectiveDesign(server: DailyLogContinuityServer): "classic" | "new" {
  const b = server.record.base;
  return b.company.new_design_r1_enabled === true && b.profile.ui_design === "new" ? "new" : "classic";
}

async function chooseDesign(page: Page, server: DailyLogContinuityServer, design: "classic" | "new") {
  const base = server.record.base;
  await page.goto("/settings");
  const button = page.getByRole("button", { name: design === "new" ? "Use the new design" : "Use the classic design" });
  await expect(button).toBeEnabled();
  const before = base.log.designRpc.length;
  await button.click();
  await expect.poll(() => base.log.designRpc.slice(before)).toEqual([{ p_design: design }]);
  expect(base.profile.ui_design).toBe(design);
}

async function setMaster(page: Page, server: DailyLogContinuityServer, on: boolean) {
  const base = server.record.base;
  await page.goto("/settings");
  const card = page.getByRole("region", { name: "New design master switch" });
  const before = base.log.masterRpc.length;
  const button = card.getByRole("button", { name: on ? "Turn on" : "Turn off for everyone" });
  await expect(button).toBeEnabled();
  await button.click();
  await expect.poll(() => base.log.masterRpc.slice(before)).toEqual([{ p_release: "r1", p_enabled: on }]);
  expect(base.company.new_design_r1_enabled).toBe(on);
  await expect(card).toContainText(on ? "On — people can choose it" : "Off for everyone");
}

async function expectLandingReady(page: Page, server: DailyLogContinuityServer) {
  const design = effectiveDesign(server);
  await expect(page.locator("html")).toHaveAttribute("data-design", design);
  if (design === "new") {
    await expect(page.getByTestId("work-screen")).toBeVisible();
    await expect(page.getByTestId("ws-clock")).toContainText("Clocked in");
    await expect(page.getByTestId("ws-clock")).toContainText("· OAKRIDGE");
  } else {
    await expect(page.getByRole("heading", { name: "Current Work", exact: true })).toBeVisible();
    await expect(page.locator(".cw-heading").filter({
      has: page.getByRole("heading", { name: "Current Work", exact: true }),
    })).toContainText("Oakridge Apartments Bldg C");
    await expect(page.getByTestId("work-screen")).toHaveCount(0);
  }
}

/** A settled landing (with its clock) of the effective design, then a hard reload that read the server again. */
async function settledReload(page: Page, server: DailyLogContinuityServer) {
  await page.goto("/");
  await expectLandingReady(page, server);
  const mark = readMark(server.record.base);
  await page.reload();
  await expectLandingReady(page, server);
  await expect.poll(() => shiftReadsSince(server.record.base, mark, SESSION).length).toBeGreaterThan(0);
}

/** The shared DailyLogDialog, read back from whatever opened it. */
async function expectDialogValues(page: Page) {
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Headline", { exact: true })).toHaveValue(HEADLINE);
  await expect(dialog.getByLabel("Notes", { exact: true })).toHaveValue(NOTES);
}

async function readBackClassic(page: Page) {
  await page.goto(`/projects/${OAKRIDGE}?tab=logs`);
  await expect(page.locator("html")).toHaveAttribute("data-design", "classic");
  const report = page.locator(".daily-log-report");
  await expect(report).toHaveCount(1);
  await expect(report.locator(".daily-log-headline")).toHaveText(HEADLINE);
  await expect(report.locator(".daily-log-description")).toHaveText(NOTES);
  await report.getByRole("button", { name: "Edit the log", exact: true }).click();
  await expectDialogValues(page);
}

async function readBackNew(page: Page, saved: Row) {
  await page.goto("/daily-logs");
  await expect(page.locator("html")).toHaveAttribute("data-design", "new");
  const card = page.locator(".daily-log-card");
  await expect(card).toHaveCount(1);
  await expect(card.locator(".daily-log-card-notes")).toHaveText(NOTES);
  await card.locator(".daily-log-card-job").click();
  // The detail route is addressed by the served id, and its receipt code is built from it.
  await expect(page).toHaveURL(new RegExp(`[?&]log=${saved.id as string}(&|$)`));
  const receipt = page.locator(".daily-log-receipt");
  const code = `DL-${(saved.log_date as string).replace(/-/g, "")}-${(saved.id as string).slice(0, 6).toUpperCase()}`;
  await expect(receipt.locator(".daily-log-receipt-code")).toContainText(code);
  await expect(receipt.locator("section").filter({ has: page.getByRole("heading", { name: "Notes — what did the crew get done today?", exact: true }) })
    .locator(".daily-log-description")).toHaveText(NOTES);
  await page.locator(".daily-log-detail-actions").getByRole("button", { name: "Edit the log", exact: true }).click();
  // The new card and receipt do not render headline; its readback is the dialog.
  await expectDialogValues(page);
}

test("a daily log filed in classic keeps its server-returned id, revision and payload through new → classic → new and master off → on, with no resend", async ({ page }) => {
  const server = createDailyLogContinuityServer();
  const { ledgers } = server;
  await openDailyLogContinuityPage(page, server, { session: SESSION });
  await settledReload(page, server);

  // Classic: the real job Logs tab and its dialog. Nothing is served before the save.
  await page.goto(`/projects/${OAKRIDGE}?tab=logs`);
  await expect(page.locator("html")).toHaveAttribute("data-design", "classic");
  await expect(page.getByRole("heading", { name: "Daily logs" })).toBeVisible();
  await expect(page.locator(".daily-log-report")).toHaveCount(0);
  await page.getByRole("button", { name: "+ Log today" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Headline", { exact: true }).fill(HEADLINE);
  await dialog.getByLabel("Notes", { exact: true }).fill(NOTES);
  await dialog.getByRole("button", { name: "Smooth" }).click();
  const answered = page.waitForResponse((r) => r.request().method() === "POST" && /\/rest\/v1\/rpc\/file_daily_log(\?|$)/.test(r.url()));
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  const response = await answered;
  expect(response.status()).toBe(200);
  const received = (await response.json()) as Row;
  const sentBody = response.request().postDataJSON() as Row;
  await expect(dialog).toHaveCount(0);

  // The one body the UI sent, and the one row the server minted and the browser received.
  expect(ledgers.saves).toEqual([sentBody]);
  expect(Object.keys(sentBody).sort()).toEqual([...DAILY_LOG_RPC_KEYS].sort());
  expect(Object.keys(sentBody)).not.toContain("id");
  expect(sentBody).toMatchObject({
    p_project_id: OAKRIDGE, p_expected_revision: 0, p_headline: HEADLINE, p_notes: NOTES,
    p_day_flow: "smooth", p_reflection: null, p_progress_provided: true,
  });
  expect(ledgers.answers).toHaveLength(1);
  const saved = ledgers.answers[0];
  expect(received).toEqual(saved);
  expect(typeof saved.id).toBe("string");
  expect(saved).toMatchObject({ project_id: OAKRIDGE, log_date: sentBody.p_log_date, revision: 1, headline: HEADLINE, notes: NOTES, day_flow: "smooth" });
  const savedJson = JSON.stringify(saved);
  const bodyJson = JSON.stringify(sentBody);
  const receipts: { leg: string; design: string; reads: number }[] = [];

  /** Same one row, same one body, nothing resent; every read since `mark` served only that row. */
  function expectSameSavedRecord(leg: string, mark: number) {
    expect(ledgers.saves.map((b) => JSON.stringify(b))).toEqual([bodyJson]);
    expect(server.logs.map((r) => JSON.stringify(savedRow(r)))).toEqual([savedJson]);
    expect(ledgers.refusedSaves).toEqual([]);
    expect(ledgers.attempted).toHaveLength(1);
    expect(ledgers.completed).toHaveLength(1);
    expect(ledgers.unsupportedReads).toEqual([]);
    const reads = ledgers.reads.slice(mark);
    expect(reads.length).toBeGreaterThan(0);
    for (const read of reads) {
      expect(read.rows.map((r) => JSON.stringify(savedRow(r)))).toEqual([savedJson]);
      for (const r of read.rows) {
        if (read.select.includes("filer:")) expect(r.filer).toEqual(FILER);
        else expect(r).not.toHaveProperty("filer");
        if (read.select.includes("project:projects")) expect(r.project).toEqual(PROJECT_JOIN);
        else expect(r).not.toHaveProperty("project");
      }
    }
    const { base, ledgers: record } = server.record;
    expect(base.log.unexpectedWrites).toEqual([]);
    expect(base.log.otherWrites).toEqual([]);
    expect(record.forbiddenAttempts).toEqual([]);
    expect(record.transportCompletedWrites).toEqual([]);
    receipts.push({ leg, design: effectiveDesign(server), reads: reads.length });
  }

  async function leg(name: string) {
    const mark = ledgers.reads.length;
    if (effectiveDesign(server) === "new") await readBackNew(page, saved);
    else await readBackClassic(page);
    expectSameSavedRecord(name, mark);
  }

  await settledReload(page, server);
  await leg("classic after save");

  await chooseDesign(page, server, "new");
  await settledReload(page, server);
  await leg("own choice new");

  await chooseDesign(page, server, "classic");
  await settledReload(page, server);
  await leg("own choice classic");

  await chooseDesign(page, server, "new");
  await settledReload(page, server);
  await leg("own choice new again");

  await setMaster(page, server, false);
  await settledReload(page, server);
  expect(server.record.base.profile.ui_design).toBe("new");
  expect(effectiveDesign(server)).toBe("classic");
  await leg("master off, own choice still new");

  await setMaster(page, server, true);
  await settledReload(page, server);
  expect(effectiveDesign(server)).toBe("new");
  await leg("master on, own choice new");

  const base = server.record.base;
  expect(base.log.designRpc).toEqual([{ p_design: "new" }, { p_design: "classic" }, { p_design: "new" }]);
  expect(base.log.masterRpc).toEqual([{ p_release: "r1", p_enabled: false }, { p_release: "r1", p_enabled: true }]);
  test.info().annotations.push(
    { type: "saved daily log (server-minted, browser-received)", description: savedJson },
    { type: "daily-log original wire payload", description: bodyJson },
    { type: "daily-log save ledgers", description: JSON.stringify({ attempted: ledgers.attempted, completed: ledgers.completed, refused: ledgers.refusedSaves }) },
    { type: "daily-log reads by leg", description: JSON.stringify(receipts) },
    { type: "limit", description: "Synthetic owner in one browser context; fixture file_daily_log handler (revision = expected + 1 is a mock rule), not SQL, RLS, auth, PWA, physical phone, field or QC proof." },
  );
});
