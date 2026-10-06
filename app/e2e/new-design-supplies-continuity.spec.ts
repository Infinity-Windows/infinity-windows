// One Supplies Take, made through the real shared /supplies screen, keeps the
// client key the app generated, its wire body, the updated supply row it was
// answered with and its one saved history event across the person's own
// design choice and the owner's master switch (saved-record continuity,
// 2026-10-05):
//
//   classic Take → own choice new → classic → new (a settled hard reload each)
//   → owner master off → reload: classic, own choice still new
//   → owner master on  → reload: new
//
// The client key is the APP's (offlineWrites.ts takeSupplyOffline →
// newClientId), sent once as p_client_id. take_supply answers with the
// UPDATED SUPPLIES ROW (migration 20260830000000) — there is no movement id or
// revision on the wire, and this spec never calls the key one. The movement
// row's id is minted inside the fixture's take_supply handler when the one
// take lands (designSuppliesContinuityFixtures.ts); nothing is pre-seeded but
// the supply's starting count. This spec never edits fixture state, app cache
// or storage. Readback at every stage is the same shared /supplies screen:
// the shelf row's on-hand number and the History list.
//
// Limits: FIXTURE ONLY. One synthetic OWNER (TEST_USER) in ONE disposable
// browser context; fixture routes, not take_supply SQL (stock authority,
// idempotent replay, the pull-list tick), PostgREST, RLS or auth; the
// movement id/event and its correlation to the request key are the fixture's;
// not the offline outbox, an installed PWA, a physical phone or real inventory.

import { expect, test, type Page } from "@playwright/test";
import { readMark, shiftReadsSince } from "./support/designContinuityFixtures";
import {
  ACTOR_NAME,
  ON_HAND_AFTER,
  ON_HAND_BEFORE,
  SUPPLY_ID,
  SUPPLY_NAME,
  TAKE_PROJECT_ID,
  TAKE_QTY,
  TAKE_RPC_KEYS,
  createSuppliesContinuityServer,
  openSuppliesContinuityPage,
  takeProjection,
  type SuppliesContinuityServer,
} from "./support/designSuppliesContinuityFixtures";
import { TEST_USER } from "./support/supabaseFixtures";

test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
test.setTimeout(300_000);

const SESSION = "owner-phone";
const TAKE_PATH = /\/rest\/v1\/rpc\/take_supply(\?|$)/;
type Row = Record<string, unknown>;

function effectiveDesign(server: SuppliesContinuityServer): "classic" | "new" {
  const b = server.base;
  return b.company.new_design_r1_enabled === true && b.profile.ui_design === "new" ? "new" : "classic";
}

async function chooseDesign(page: Page, server: SuppliesContinuityServer, design: "classic" | "new") {
  const base = server.base;
  await page.goto("/settings");
  const button = page.getByRole("button", { name: design === "new" ? "Use the new design" : "Use the classic design" });
  await expect(button).toBeEnabled();
  const before = base.log.designRpc.length;
  await button.click();
  await expect.poll(() => base.log.designRpc.slice(before)).toEqual([{ p_design: design }]);
  expect(base.profile.ui_design).toBe(design);
}

async function setMaster(page: Page, server: SuppliesContinuityServer, on: boolean) {
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

async function expectLandingReady(page: Page, server: SuppliesContinuityServer) {
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
async function settledReload(page: Page, server: SuppliesContinuityServer) {
  await page.goto("/");
  await expectLandingReady(page, server);
  const mark = readMark(server.base);
  await page.reload();
  await expectLandingReady(page, server);
  await expect.poll(() => shiftReadsSince(server.base, mark, SESSION).length).toBeGreaterThan(0);
}

/** The one shelf row for the seeded supply. */
function shelfRow(page: Page) {
  return page.locator("li.find-row").filter({ hasText: SUPPLY_NAME });
}

/** The shared /supplies screen: the shelf shows the server's count, and History shows the one take. */
async function readBack(page: Page, server: SuppliesContinuityServer) {
  // Supplies is intentionally persisted offline with queryClient's 30-second
  // freshness window (queryClient.ts:34, queryKeys.ts supplies offline:true).
  // Observe the actual saved timestamp and wait for it to age before mounting
  // the shelf. Nothing clears/rewrites the cache or changes the browser clock.
  await page.waitForFunction((staleMs) => {
    const raw = localStorage.getItem("wops-query-cache");
    if (!raw) return false;
    const persisted = JSON.parse(raw) as {
      clientState?: { queries?: { queryKey?: unknown[]; state?: { status?: string; dataUpdatedAt?: number } }[] };
    };
    const query = persisted.clientState?.queries?.find((q) => q.queryKey?.length === 1 && q.queryKey[0] === "supplies");
    const updatedAt = query?.state?.dataUpdatedAt;
    return query?.state?.status === "success" && typeof updatedAt === "number" && updatedAt > 0
      && Date.now() - updatedAt > staleMs;
  }, 30_500, { timeout: 45_000, polling: 250 });
  await page.goto("/supplies");
  await expect(page.locator("html")).toHaveAttribute("data-design", effectiveDesign(server));
  const row = shelfRow(page);
  await expect(row).toHaveCount(1);
  await expect(row).toContainText(String(ON_HAND_AFTER));
  await expect(row).not.toContainText(String(ON_HAND_BEFORE));
  await row.getByRole("button", { name: "History", exact: true }).click();
  const modal = page.locator(".modal-card");
  await expect(modal).toHaveCount(1);
  const takes = modal.locator("li.find-row");
  await expect(takes).toHaveCount(1);
  const when = await page.evaluate((createdAt) => new Date(createdAt).toLocaleDateString("en-US", {
    month: "short", day: "numeric",
  }), server.movements[0].created_at as string);
  await expect(takes).toHaveText(`${ACTOR_NAME} took ${TAKE_QTY} · BLACK22 · ${when}`);
  await modal.getByRole("button", { name: "Close", exact: true }).click();
  await expect(modal).toHaveCount(0);
}

test("a Supplies Take made in classic keeps its app-generated client key, wire body, updated supply row and one history event through new → classic → new and master off → on, with no resend", async ({ page }) => {
  const server = createSuppliesContinuityServer();
  const { ledgers } = server;
  await openSuppliesContinuityPage(page, server, { session: SESSION });
  await settledReload(page, server);

  // Classic: the real shelf starts with the seeded count and no saved take.
  expect(server.movements).toEqual([]);
  await page.goto("/supplies");
  await expect(page.locator("html")).toHaveAttribute("data-design", "classic");
  const row = shelfRow(page);
  await expect(row).toHaveCount(1);
  await expect(row).toContainText(String(ON_HAND_BEFORE));

  // Take: how many, which job, go.
  await row.getByRole("button", { name: "Take", exact: true }).click();
  const modal = page.locator(".modal-card");
  await expect(modal).toHaveCount(1);
  await modal.locator('input[type="number"]').fill(String(TAKE_QTY));
  await modal.getByRole("combobox").click();
  await modal.getByRole("option", { name: /BLACK22/ }).click();
  const takeIt = modal.getByRole("button", { name: "Take it", exact: true });
  await expect(takeIt).toBeEnabled();
  const answered = page.waitForResponse((r) => r.request().method() === "POST" && TAKE_PATH.test(r.url()));
  await takeIt.click();
  const response = await answered;
  expect(response.status()).toBe(200);
  const received = (await response.json()) as Row;
  const wire = response.request().postDataJSON() as Row;
  // The form closes and the shelf re-reads the server's corrected count.
  await expect(modal).toHaveCount(0);
  await expect(row).toContainText(String(ON_HAND_AFTER));

  // The one body the UI sent, carrying the app's own key.
  expect(Object.keys(wire).sort()).toEqual([...TAKE_RPC_KEYS]);
  expect(wire).toMatchObject({ p_supply: SUPPLY_ID, p_project: TAKE_PROJECT_ID, p_qty: TAKE_QTY });
  const clientKey = wire.p_client_id as string;
  expect(clientKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  expect(ledgers.saves).toEqual([wire]);
  // The answer is the updated supply row — what the browser got is what the server holds.
  expect(received).toEqual(server.supply);
  expect(ledgers.answers).toEqual([received]);
  expect(server.supply).toMatchObject({ id: SUPPLY_ID, on_hand: ON_HAND_AFTER });
  expect(received).not.toHaveProperty("client_id");
  // The one movement the handler wrote: its own id, the app's key in client_id.
  expect(server.movements).toHaveLength(1);
  const saved = server.movements[0];
  expect(saved).toMatchObject({
    supply_id: SUPPLY_ID, event: "took", project_id: TAKE_PROJECT_ID, qty: TAKE_QTY,
    actor: TEST_USER.id, client_id: clientKey, id: expect.any(String), created_at: expect.any(String),
  });
  expect(saved.id).not.toBe(clientKey);
  expect(new Date(saved.created_at as string).toISOString()).toBe(saved.created_at);

  const wireJson = JSON.stringify(wire);
  const supplyJson = JSON.stringify(server.supply);
  const movementJson = JSON.stringify(saved);
  const historyJson = JSON.stringify([takeProjection(saved)]);
  const receipts: { leg: string; design: string; supplyReads: number; historyReads: number; nameReads: number }[] = [];

  /** Same one body, same one row and event, nothing resent; every read since `mark` served only that state. */
  async function expectSameTake(leg: string, mark: number) {
    await expect.poll(() => ledgers.reads.slice(mark).filter((r) => r.table === "supplies").length).toBeGreaterThan(0);
    expect(ledgers.saves.map((b) => JSON.stringify(b))).toEqual([wireJson]);
    expect(ledgers.answers.map((a) => JSON.stringify(a))).toEqual([supplyJson]);
    expect(server.movements.map((m) => JSON.stringify(m))).toEqual([movementJson]);
    expect(JSON.stringify(server.supply)).toBe(supplyJson);
    expect(ledgers.refusedSaves).toEqual([]);
    expect(ledgers.attempted).toHaveLength(1);
    expect(ledgers.completed).toHaveLength(1);
    expect(ledgers.unsupportedReads).toEqual([]);
    const reads = ledgers.reads.slice(mark);
    const supplyReads = reads.filter((r) => r.table === "supplies");
    for (const read of supplyReads) expect(JSON.stringify(read.rows)).toBe(`[${supplyJson}]`);
    const historyReads = reads.filter((r) => r.table === "movements");
    expect(historyReads.length).toBeGreaterThan(0);
    for (const read of historyReads) expect(JSON.stringify(read.rows)).toBe(historyJson);
    const nameReads = reads.filter((r) => r.table === "profiles");
    expect(nameReads.length).toBeGreaterThan(0);
    for (const read of nameReads) expect(read.rows).toEqual([{ id: TEST_USER.id, display_name: ACTOR_NAME }]);
    expect(server.base.log.unexpectedWrites).toEqual([]);
    expect(server.base.log.otherWrites).toEqual([]);
    receipts.push({
      leg, design: effectiveDesign(server),
      supplyReads: supplyReads.length, historyReads: historyReads.length, nameReads: nameReads.length,
    });
  }

  async function leg(name: string) {
    const mark = ledgers.reads.length;
    await readBack(page, server);
    await expectSameTake(name, mark);
  }

  await settledReload(page, server);
  await leg("classic after Take");

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
    { type: "app-generated client key (wire)", description: clientKey },
    { type: "original wire body", description: wireJson },
    { type: "updated supply row answered and received", description: JSON.stringify(received) },
    { type: "fixture movement row (synthetic id minted in the take_supply handler)", description: movementJson },
    { type: "take_supply ledgers", description: JSON.stringify({ attempted: ledgers.attempted, completed: ledgers.completed, refused: ledgers.refusedSaves }) },
    { type: "Supplies reads by leg", description: JSON.stringify(receipts) },
    { type: "limit", description: "Fixture only: synthetic owner in one browser context; fixture take_supply handler answering the updated supply row (no movement id or revision on the wire); the movement id/event and its key correlation are the fixture's. No SQL stock authority, idempotent replay, pull-list tick, RLS or auth; no offline outbox, PWA, physical phone or real inventory." },
  );
});
