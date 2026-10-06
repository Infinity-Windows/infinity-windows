// One QC Pass, made through the real classic /qc queue, keeps the decision id
// the app generated, its wire body and its saved history row across the
// person's own design choice and the owner's master switch (saved-record
// continuity, 2026-10-06):
//
//   classic Pass → own choice new → classic → new (a settled hard reload each)
//   → owner master off → reload: classic, own choice still new
//   → owner master on  → reload: new
//
// The decision id is the APP's (Qc.tsx decisionIdFor, crypto.randomUUID), sent
// as p_decision_id; the fixture stores and returns it the way migration
// 20261041000000 record_qc_decision does. It is not a server-minted id and the
// legacy decision has no revision. Every QC state change happens inside that
// RPC's route handler (designQcContinuityFixtures.ts); this spec never edits
// fixture state, app cache or storage. Readback at every stage is the same
// shared /qc screen: the queue (emptied by the server's own filter) and the
// Review history article.
//
// Limits: one synthetic OWNER (TEST_USER) in ONE disposable browser context;
// fixture routes, not record_qc_decision SQL (dedupe, transaction, points),
// PostgREST, RLS or auth; the legacy QC history only, not the dormant unit
// final-QC authority; not an installed PWA, physical phone or field proof.

import { expect, test, type Page } from "@playwright/test";
import { readMark, shiftReadsSince } from "./support/designContinuityFixtures";
import {
  QC_OPENING_CODE,
  QC_OPENING_ID,
  QC_RPC_KEYS,
  REVIEWER_NAME,
  createQcContinuityServer,
  openQcContinuityPage,
  type QcContinuityServer,
} from "./support/designQcContinuityFixtures";
import { OAKRIDGE } from "./support/release1Fixtures";
import { TEST_USER } from "./support/supabaseFixtures";

test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
test.setTimeout(180_000);

const SESSION = "owner-phone";
const UNIT_LABEL = `OAKRIDGE · ${QC_OPENING_CODE}`;
type Row = Record<string, unknown>;

function effectiveDesign(server: QcContinuityServer): "classic" | "new" {
  const b = server.base;
  return b.company.new_design_r1_enabled === true && b.profile.ui_design === "new" ? "new" : "classic";
}

async function chooseDesign(page: Page, server: QcContinuityServer, design: "classic" | "new") {
  const base = server.base;
  await page.goto("/settings");
  const button = page.getByRole("button", { name: design === "new" ? "Use the new design" : "Use the classic design" });
  await expect(button).toBeEnabled();
  const before = base.log.designRpc.length;
  await button.click();
  await expect.poll(() => base.log.designRpc.slice(before)).toEqual([{ p_design: design }]);
  expect(base.profile.ui_design).toBe(design);
}

async function setMaster(page: Page, server: QcContinuityServer, on: boolean) {
  const base = server.base;
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

async function expectLandingReady(page: Page, server: QcContinuityServer) {
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
async function settledReload(page: Page, server: QcContinuityServer) {
  await page.goto("/");
  await expectLandingReady(page, server);
  const mark = readMark(server.base);
  await page.reload();
  await expectLandingReady(page, server);
  await expect.poll(() => shiftReadsSince(server.base, mark, SESSION).length).toBeGreaterThan(0);
}

/** The shared /qc screen: the queue is empty by the server's filter, and history shows the one decision. */
async function readBack(page: Page, server: QcContinuityServer, decisionId: string) {
  await page.goto("/qc");
  await expect(page.locator("html")).toHaveAttribute("data-design", effectiveDesign(server));
  await expect(page.getByRole("heading", { name: "Quality", exact: true })).toBeVisible();
  await expect(page.getByText("No installed openings to review.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Pass ✓", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Review history", exact: true }).click();
  const history = page.getByRole("region", { name: "QC review history", exact: true });
  const article = history.locator("article");
  await expect(article).toHaveCount(1);
  const link = article.getByRole("link", { name: UNIT_LABEL, exact: true });
  await expect(link).toHaveAttribute("href", `/projects/${OAKRIDGE}/opening/${QC_OPENING_ID}`);
  await expect(article.getByText("Passed", { exact: true })).toBeVisible();
  await expect(article).toContainText(REVIEWER_NAME);
  await expect(article).not.toContainText("Saved from an older app version");
  await expect(article).not.toContainText("Previous status saved before review history began");
  // The article is keyed by the decision id; the served row carried it.
  expect(server.events.map((e) => e.id)).toEqual([decisionId]);
}

test("a QC Pass made in classic keeps its app-generated decision id, wire body and history row through new → classic → new and master off → on, with no resend", async ({ page }) => {
  const server = createQcContinuityServer();
  const { ledgers } = server;
  await openQcContinuityPage(page, server, { session: SESSION });
  await settledReload(page, server);

  // Classic: the real /qc queue starts with one installed opening and no decision.
  expect(server.events).toEqual([]);
  expect(server.checks).toEqual([]);
  await page.goto("/qc");
  await expect(page.locator("html")).toHaveAttribute("data-design", "classic");
  const row = page.locator("li.find-row").filter({ hasText: QC_OPENING_CODE });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("OAKRIDGE");
  const answered = page.waitForResponse((r) => r.request().method() === "POST" && /\/rest\/v1\/rpc\/record_qc_decision(\?|$)/.test(r.url()));
  await row.getByRole("button", { name: "Pass ✓", exact: true }).click();
  const response = await answered;
  expect(response.status()).toBe(200);
  const received = (await response.json()) as unknown;
  const wire = response.request().postDataJSON() as Row;
  // The queue empties because the server's qc_checks read now excludes it.
  await expect(page.getByText("No installed openings to review.", { exact: true })).toBeVisible();

  // The one body the UI sent, carrying the app's own id, and that same id back.
  expect(Object.keys(wire).sort()).toEqual([...QC_RPC_KEYS]);
  expect(wire).toMatchObject({ p_opening_id: QC_OPENING_ID, p_status: "passed", p_note: null });
  const decisionId = wire.p_decision_id as string;
  expect(received).toBe(decisionId);
  expect(ledgers.saves).toEqual([wire]);
  expect(server.events).toHaveLength(1);
  const saved = server.events[0];
  expect(saved).toMatchObject({
    id: decisionId, project_opening_id: QC_OPENING_ID, status: "passed", note: null,
    reviewer_id: TEST_USER.id, decided_at: expect.any(String), source: "review",
  });
  expect(new Date(saved.decided_at as string).toISOString()).toBe(saved.decided_at);
  const wireJson = JSON.stringify(wire);
  const savedJson = JSON.stringify(saved);
  const checksJson = JSON.stringify(server.checks);
  const receipts: { leg: string; design: string; historyReads: number; reads: number }[] = [];

  /** Same one body, same one row, nothing resent; every history read since `mark` served only that row. */
  function expectSameDecision(leg: string, mark: number) {
    expect(ledgers.saves.map((b) => JSON.stringify(b))).toEqual([wireJson]);
    expect(server.events.map((e) => JSON.stringify(e))).toEqual([savedJson]);
    expect(JSON.stringify(server.checks)).toBe(checksJson);
    expect(ledgers.refusedSaves).toEqual([]);
    expect(ledgers.attempted).toHaveLength(1);
    expect(ledgers.completed).toHaveLength(1);
    expect(ledgers.unsupportedReads).toEqual([]);
    const reads = ledgers.reads.slice(mark);
    const historyReads = reads.filter((r) => r.table === "qc_decision_events");
    expect(historyReads.length).toBeGreaterThan(0);
    for (const read of historyReads) expect(read.rows.map((r) => JSON.stringify(r))).toEqual([savedJson]);
    const queueReads = reads.filter((r) => r.table === "project_openings" && r.select.includes("qc:qc_checks"));
    expect(queueReads.length).toBeGreaterThan(0);
    for (const read of queueReads) expect(read.rows).toEqual([]);
    const checkReads = reads.filter((r) => r.table === "qc_checks");
    expect(checkReads.length).toBeGreaterThan(0);
    for (const read of checkReads) expect(JSON.stringify(read.rows)).toBe(checksJson);
    const openingJoins = reads.filter((r) => r.table === "project_openings" && !r.select.includes("qc:qc_checks"));
    expect(openingJoins.length).toBeGreaterThan(0);
    for (const read of openingJoins) expect(read.rows).toEqual([{
      id: QC_OPENING_ID, opening_code: QC_OPENING_CODE, project_id: OAKRIDGE, projects: { job_code: "OAKRIDGE" },
    }]);
    const reviewerJoins = reads.filter((r) => r.table === "profiles");
    expect(reviewerJoins.length).toBeGreaterThan(0);
    for (const read of reviewerJoins) expect(read.rows).toEqual([{ id: TEST_USER.id, display_name: REVIEWER_NAME }]);
    expect(server.base.log.unexpectedWrites).toEqual([]);
    expect(server.base.log.otherWrites).toEqual([]);
    receipts.push({ leg, design: effectiveDesign(server), historyReads: historyReads.length, reads: reads.length });
  }

  async function leg(name: string) {
    const mark = ledgers.reads.length;
    await readBack(page, server, decisionId);
    expectSameDecision(name, mark);
  }

  await settledReload(page, server);
  await leg("classic after Pass");

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
  expect(server.base.profile.ui_design).toBe("new");
  expect(effectiveDesign(server)).toBe("classic");
  await leg("master off, own choice still new");

  await setMaster(page, server, true);
  await settledReload(page, server);
  expect(effectiveDesign(server)).toBe("new");
  await leg("master on, own choice new");

  expect(server.base.log.designRpc).toEqual([{ p_design: "new" }, { p_design: "classic" }, { p_design: "new" }]);
  expect(server.base.log.masterRpc).toEqual([{ p_release: "r1", p_enabled: false }, { p_release: "r1", p_enabled: true }]);
  test.info().annotations.push(
    { type: "app-generated decision id (wire) and browser-received id", description: JSON.stringify({ wire: decisionId, received }) },
    { type: "saved history row", description: savedJson },
    { type: "original wire body", description: wireJson },
    { type: "QC save ledgers", description: JSON.stringify({ attempted: ledgers.attempted, completed: ledgers.completed, refused: ledgers.refusedSaves }) },
    { type: "QC reads by leg", description: JSON.stringify(receipts) },
    { type: "limit", description: "Synthetic owner in one browser context; fixture record_qc_decision handler returning the app's own id (no server-minted id, no revision); no SQL dedupe/transaction/points, RLS or auth; legacy QC history only, not unit final-QC authority, PWA, physical phone or field proof." },
  );
});
