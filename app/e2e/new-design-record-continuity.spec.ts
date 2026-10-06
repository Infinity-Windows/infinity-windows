// Saved-record continuity across the person's own design choice and the
// owner's master switch (saved-record continuity, 2026-10-05).
//
// new-design-continuity.spec.ts holds a shift, a schedule row and an opening
// across switches. These hold two things a person SAVED: a photo waiting on
// the phone with no signal (native IndexedDB, wops-write-outbox), and one crew
// unit record filed through the classic "Build unit details" form. Both are
// created by the app itself during the test; every id compared is the one the
// app generated. The transitions are the same for both:
//
//   classic save → own choice new → classic → new (a settled hard reload each)
//   → owner master off → reload: classic, own choice still new
//   → owner master on  → reload: new
//
// Every server-side change happens inside a route handler
// (designContinuityFixtures.ts + designRecordContinuityFixtures.ts); this spec
// never edits fixture state after a click.
//
// Limits, stated so nobody counts this as more: one synthetic OWNER identity
// (TEST_USER, role owner) in ONE browser context throughout — the owner's own
// master switch and own preference, not a second person. Disposable Playwright
// Chromium/WebKit storage: not an installed PWA, not a service-worker relaunch,
// not iOS eviction, not a physical phone. Fixture routes, not PostgREST, RLS,
// real SQL or real Storage. The crew record is read back in the classic UI
// only; the new legs prove the saved record was not resent, rewritten or
// deleted — they make no claim that a classic crew record maps into the new
// design's contributors summary.

import { expect, type Page } from "@playwright/test";
import { test } from "./support/nativeBlobTest";
import { readMark, shiftReadsSince } from "./support/designContinuityFixtures";
import {
  createRecordContinuityServer,
  openRecordContinuityPage,
  outboxIdentity,
  readWriteOutbox,
  type RecordContinuityServer,
} from "./support/designRecordContinuityFixtures";
import { TEST_USER } from "./support/supabaseFixtures";
import { pngFile } from "./support/specHelpers";
import { OAKRIDGE } from "./support/release1Fixtures";
import { installNativePhotoOutboxRecorder, readNativePhotoOutboxRecorder } from "./support/nativePhotoOutboxRecorder";

const PHONE = { width: 390, height: 844 };
test.use({ viewport: PHONE, deviceScaleFactor: 2 });
// Six settled hard reloads plus two save flows: one bounded budget per test.
test.setTimeout(180_000);

const SESSION = "owner-phone";

function effectiveDesign(server: RecordContinuityServer): "classic" | "new" {
  const b = server.base;
  return b.company.new_design_r1_enabled === true && b.profile.ui_design === "new" ? "new" : "classic";
}

/** Settings → own design button; the saved row moves inside the RPC handler. */
async function chooseDesign(page: Page, server: RecordContinuityServer, design: "classic" | "new") {
  await page.goto("/settings");
  const button = page.getByRole("button", { name: design === "new" ? "Use the new design" : "Use the classic design" });
  await expect(button).toBeEnabled();
  const before = server.base.log.designRpc.length;
  await button.click();
  await expect.poll(() => server.base.log.designRpc.slice(before)).toEqual([{ p_design: design }]);
  expect(server.base.profile.ui_design).toBe(design);
}

/** Settings → the owner's master switch card; the company row moves inside the handler. */
async function setMaster(page: Page, server: RecordContinuityServer, on: boolean) {
  await page.goto("/settings");
  const card = page.getByRole("region", { name: "New design master switch" });
  const before = server.base.log.masterRpc.length;
  const button = card.getByRole("button", { name: on ? "Turn on" : "Turn off for everyone" });
  await expect(button).toBeEnabled();
  await button.click();
  await expect.poll(() => server.base.log.masterRpc.slice(before)).toEqual([{ p_release: "r1", p_enabled: on }]);
  expect(server.base.company.new_design_r1_enabled).toBe(on);
  await expect(card).toContainText(on ? "On — people can choose it" : "Off for everyone");
}

async function expectLandingReady(page: Page, server: RecordContinuityServer) {
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

/** A settled load of the effective design, then a hard reload that read the server again. */
async function settledReload(page: Page, server: RecordContinuityServer) {
  await page.goto("/");
  await expectLandingReady(page, server);
  const mark = readMark(server.base);
  await page.reload();
  await expectLandingReady(page, server);
  await expect.poll(() => shiftReadsSince(server.base, mark, SESSION).length).toBeGreaterThan(0);
}

function expectNoOperationalWrites(server: RecordContinuityServer) {
  expect(server.base.log.unexpectedWrites).toEqual([]);
  expect(server.base.log.otherWrites).toEqual([]);
  expect(server.ledgers.forbiddenAttempts).toEqual([]);
  // Browser-observed (requestfinished): no storage/attachments write completed
  // with any response at all, in either test.
  expect(server.ledgers.transportCompletedWrites).toEqual([]);
}

function expectFinalPreferenceAndMaster(server: RecordContinuityServer) {
  expect(server.base.log.designRpc).toEqual([{ p_design: "new" }, { p_design: "classic" }, { p_design: "new" }]);
  expect(server.base.log.masterRpc).toEqual([{ p_release: "r1", p_enabled: false }, { p_release: "r1", p_enabled: true }]);
  expect(server.base.profile.ui_design).toBe("new");
  expect(server.base.company.new_design_r1_enabled).toBe(true);
}

// Keep the native photo and all identity checks; only WebKit uses a fresh normal profile.
test.describe("normal-profile native Blob storage", () => {
  test.use({ nativeBlobProfile: true });

test("a photo saved on the phone with no signal stays the same queued photo through classic → new → classic → new and master off → on, and nothing is sent", async ({ page }) => {
  await page.addInitScript(installNativePhotoOutboxRecorder);
  try {
  const server = createRecordContinuityServer();
  await openRecordContinuityPage(page, server, { session: SESSION, photo: true });
  await settledReload(page, server);

  // Classic: the real job photo sheet.
  await page.goto(`/photos?project=${OAKRIDGE}`);
  await page.getByRole("button", { name: "Add photo" }).click();
  await expect(page.getByRole("dialog", { name: "Add job photos" })).toBeVisible();
  // The dead zone begins once the sheet is open and is never lifted.
  server.transport.down = true;
  await page.locator('.jobphoto-actions input[type="file"]:not([capture])').setInputFiles(pngFile("record-continuity.png"));
  await expect(page.getByText("1 photo waiting to upload", { exact: true })).toBeVisible();
  await expect(page.locator(".sync-pill-text:visible").first()).toContainText("Photos 1");

  // The entry the app wrote, read back from the device's own store.
  await expect.poll(async () => {
    const rows = await readWriteOutbox(page);
    return rows.length === 1 && rows[0].blobSha256 !== null ? "one stored photo" : JSON.stringify(rows.map(outboxIdentity));
  }).toBe("one stored photo");
  const [first] = await readWriteOutbox(page);
  expect(first.problems).toEqual([]);
  // makeEntry writes dependsOn as null when the caller gives none; a
  // standalone job photo must keep it that way on every read.
  expect(first).toMatchObject({ op: "photo_upload", ownerId: TEST_USER.id, hasBlob: true, blobPresent: true, dependsOnRaw: "null" });
  expect(first.blobSize).toBeGreaterThan(0);
  expect(JSON.parse(first.payloadJson)).toMatchObject({ kind: "photo", projectId: OAKRIDGE, createdBy: TEST_USER.email });
  const baseline = outboxIdentity(first);
  const identityReceipts: { leg: string; identity: ReturnType<typeof outboxIdentity> }[] = [];
  const states: { leg: string; status: unknown; attemptCount: unknown; nextAttemptAt: unknown; lastError: unknown; overlay: boolean }[] = [];

  /** Same single item, still waiting on this phone; its state reported as it is. */
  async function expectStillPending(leg: string) {
    await page.goto("/stuck");
    await expect(page.locator("html")).toHaveAttribute("data-design", effectiveDesign(server));
    await expect(page.getByRole("heading", { name: "Waiting to send" })).toBeVisible();
    await expect(page.getByText("Photo", { exact: true })).toHaveCount(1);
    await expect(page.getByText("Saved on this phone", { exact: true })).toBeVisible();
    // A transport failure must keep it waiting, not hand it to the person.
    // If it ever reaches "needs you", this fails and says so — it is not hidden.
    await expect(page.getByRole("heading", { name: "Needs you" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Throw away" })).toHaveCount(0);
    const rows = await readWriteOutbox(page);
    expect(rows).toHaveLength(1);
    // Raw schema check on every read, retry metadata included; raw status is
    // reported as stored (sending stays sending).
    expect(rows[0].problems).toEqual([]);
    expect(rows.map(outboxIdentity)).toEqual([baseline]);
    identityReceipts.push({ leg, identity: outboxIdentity(rows[0]) });
    states.push({ leg, status: rows[0].status, attemptCount: rows[0].attemptCount, nextAttemptAt: rows[0].nextAttemptAt, lastError: rows[0].lastError, overlay: rows[0].overlayPresent });
    expect(rows[0].status).not.toBe("failed");
    expect(server.ledgers.transportCompletedWrites).toEqual([]);
    expectNoOperationalWrites(server);
  }

  await expectStillPending("classic after capture");

  await chooseDesign(page, server, "new");
  await settledReload(page, server);
  await expectStillPending("own choice new");

  await chooseDesign(page, server, "classic");
  await settledReload(page, server);
  await expectStillPending("own choice classic");

  await chooseDesign(page, server, "new");
  await settledReload(page, server);
  await expectStillPending("own choice new again");

  await setMaster(page, server, false);
  await settledReload(page, server);
  expect(server.base.profile.ui_design).toBe("new");
  await expectStillPending("master off, own choice still new");

  await setMaster(page, server, true);
  await settledReload(page, server);
  await expectStillPending("master on, own choice new");

  // Never sent, never purged; Send now / Throw away were never pressed. Every
  // write the app tried was aborted, and the browser saw none complete.
  expect(server.ledgers.transportCompletedWrites).toEqual([]);
  expectFinalPreferenceAndMaster(server);
  expectNoOperationalWrites(server);
  test.info().annotations.push(
    { type: "native photo identity by leg", description: JSON.stringify({ baseline, legs: identityReceipts }) },
    { type: "raw queue state by leg (schema-checked, not compared)", description: JSON.stringify(states) },
    { type: "aborted transport write attempts", description: JSON.stringify(server.ledgers.transportWriteAttempts) },
    { type: "list_my_worked_jobs reads", description: String(server.ledgers.workedJobsReads) },
    { type: "limit", description: "Synthetic owner in one disposable browser context; not installed PWA, auth, Storage or physical-phone proof." },
  );
  } finally {
    // The buffer belongs to this document. A before-navigation failure keeps
    // its initial request observations; a later reload starts a new buffer.
    // No readback request is added, and evidence collection cannot replace
    // the original test failure if this page or artifact channel is closed.
    try {
      const snapshot = await page.evaluate(readNativePhotoOutboxRecorder).catch(() => ({
        version: 1, installed: false, dropped: 0, events: [], snapshotUnavailable: true,
      }));
      await test.info().attach("native-photo-outbox-events", {
        contentType: "application/json",
        body: Buffer.from(JSON.stringify({ documentBufferOnly: true, ...snapshot })),
      });
    } catch { /* Preserve the test's original outcome. */ }
  }
});
});

async function buildCrewRecord(page: Page) {
  await page.goto(`/current-work?job=${OAKRIDGE}`);
  await page.getByRole("button", { name: /Record crew work/ }).click();
  const form = page.locator(".cw-crew-records");
  await form.getByRole("combobox", { name: "Unit", exact: true }).selectOption("new");
  await form.getByRole("button", { name: "Build unit details" }).click();
  await form.getByLabel("Unit number / name").fill("Crew-16");
  await form.getByLabel("Type", { exact: true }).fill("Bifold door");
  await form.getByRole("combobox", { name: "Frame material", exact: true }).selectOption("Aluminum");
  await form.getByRole("button", { name: "Continue to crew & work date" }).click();
  await form.getByLabel("Work / assignment date").fill("2026-09-18");
  const people = form.locator(".cw-crew-picker input[type=checkbox]");
  await people.nth(0).check();
  await people.nth(1).check();
  await form.getByLabel("Work completed / instructions").fill("Crew installed together Friday. Filed from owner notes.");
  return form;
}

/** Classic UI readback of the saved record; every served list holds only that id. */
async function expectClassicCrewRecord(page: Page, server: RecordContinuityServer, recordId: string) {
  await page.goto(`/current-work?job=${OAKRIDGE}`);
  await expect(page.locator("html")).toHaveAttribute("data-design", "classic");
  await page.getByText(/Crew assignments & filed work/).click();
  await expect(page.locator(".cw-crew-history")).toContainText("Crew-16");
  await expect(page.locator(".cw-crew-history")).toContainText("Filed by");
  for (const ids of server.ledgers.crewRecordReads) expect(ids.every((id) => id === recordId)).toBe(true);
}


test("a crew record saved in classic keeps its one id through new → classic → new and master off → on, with no resend", async ({ page }) => {
  const server = createRecordContinuityServer();
  await openRecordContinuityPage(page, server, { session: SESSION, crew: true });
  await settledReload(page, server);

  const form = await buildCrewRecord(page);
  await form.getByRole("button", { name: "Save crew record", exact: true }).click();
  await expect.poll(() => server.crewRecords.length).toBe(1);
  expect(server.ledgers.crewSaves).toHaveLength(1);
  const sent = server.ledgers.crewSaves[0];
  const recordId = sent.p_id as string;
  expect(typeof recordId).toBe("string");
  expect(recordId.length).toBeGreaterThan(0);
  const sentData = sent.p_data as Record<string, unknown>;
  expect(sentData).toMatchObject({ work_date: "2026-09-18" });
  expect(sentData.people).toHaveLength(2);
  expect(server.crewRecords[0]).toMatchObject({ id: recordId, unit_id: (sentData.unit as Record<string, unknown>).id });
  const savedRecords = structuredClone(server.crewRecords);
  const savedUnits = structuredClone(server.crewUnits);

  function expectSameSavedRecord() {
    expect(server.ledgers.crewSaves).toHaveLength(1);
    expect(server.crewRecords).toEqual(savedRecords);
    expect(server.crewUnits).toEqual(savedUnits);
    expectNoOperationalWrites(server);
  }

  await settledReload(page, server);
  await expectClassicCrewRecord(page, server, recordId);
  expectSameSavedRecord();

  // New legs: fixture identity and no resend only — no new-design UI mapping claim.
  await chooseDesign(page, server, "new");
  await settledReload(page, server);
  expectSameSavedRecord();

  await chooseDesign(page, server, "classic");
  await settledReload(page, server);
  await expectClassicCrewRecord(page, server, recordId);
  expectSameSavedRecord();

  await chooseDesign(page, server, "new");
  await settledReload(page, server);
  expectSameSavedRecord();

  await setMaster(page, server, false);
  await settledReload(page, server);
  expect(server.base.profile.ui_design).toBe("new");
  await expectClassicCrewRecord(page, server, recordId);
  expectSameSavedRecord();

  await setMaster(page, server, true);
  await settledReload(page, server);
  expectSameSavedRecord();

  expect(server.ledgers.crewRecordReads.length).toBeGreaterThan(0);
  expectFinalPreferenceAndMaster(server);
  test.info().annotations.push(
    { type: "saved record id (app-generated)", description: recordId },
    { type: "limit", description: "Synthetic owner in one browser context; classic UI readback only; fixture handlers, not record_crew_work SQL, RLS or server authorization." },
  );
});
