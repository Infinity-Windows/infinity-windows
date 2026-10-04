import { expect, test as base, chromium, webkit, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TINY_PNG_BASE64 } from "./support/specHelpers";

const test = base.extend<{ journalPage: Page }>({
  journalPage: async ({ browserName }, runFixture) => {
    let browser: Browser | undefined;
    let context: BrowserContext | undefined;
    let profileDir: string | undefined;
    try {
      if (browserName === "webkit") {
        profileDir = mkdtempSync(join(tmpdir(), "work-capture-journal-webkit-"));
        context = await webkit.launchPersistentContext(profileDir, { headless: true, viewport: { width: 390, height: 844 } });
      } else {
        browser = await chromium.launch({ headless: true });
        context = await browser.newContext({ viewport: { width: 390, height: 844 } });
      }
      const page = context.pages()[0] ?? await context.newPage();
      await runFixture(page);
    } finally {
      try {
        await context?.close();
      } finally {
        await browser?.close();
        if (profileDir) rmSync(profileDir, { recursive: true, force: true });
      }
    }
  },
});

const OWNER = "10000000-0000-4000-8000-000000000001";
const OTHER_OWNER = "10000000-0000-4000-8000-000000000002";
const DEVICE = "20000000-0000-4000-8000-000000000001";
const OTHER_DEVICE = "20000000-0000-4000-8000-000000000002";

async function openFixture(page: Page) {
  await page.route("**/work-capture-journal-fixture", (route) => route.fulfill({
    status: 200,
    contentType: "text/html",
    body: "<!doctype html><html><head><meta charset=utf-8></head><body>native IndexedDB fixture</body></html>",
  }));
  await page.goto("/work-capture-journal-fixture");
}

test("native journal transactions serialize appends, scope owners, and preserve the photo outbox", async ({ journalPage: page }) => {
  await openFixture(page);
  const result = await page.evaluate(async ({ pngBase64, owner, otherOwner, device, otherDevice }) => {
    // @ts-expect-error Vite resolves this browser URL at runtime; tsc has no declaration for it.
    const journal = await import("/src/lib/workCapture/journal.ts");
    const bytes = Uint8Array.from(atob(pngBase64), (char) => char.charCodeAt(0));
    const outboxName = "wops-write-outbox";
    const openOutbox = () => new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(outboxName, 2);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("entries")) db.createObjectStore("entries", { keyPath: "id" });
        if (!db.objectStoreNames.contains("metadata")) db.createObjectStore("metadata", { keyPath: "id" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const seedOutbox = async () => {
      const db = await openOutbox();
      const tx = db.transaction(["entries", "metadata"], "readwrite");
      tx.objectStore("entries").put({
        id: "fixture-photo-1",
        meta: JSON.stringify({ id: "fixture-photo-1", status: "queued", createdAt: "2026-10-03T12:00:00.000Z" }),
        blob: new Blob([bytes], { type: "image/png" }),
      });
      tx.objectStore("metadata").put({ id: "fixture-meta-1", meta: "fixture metadata stays intact" });
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
        tx.onerror = () => reject(tx.error);
      });
      const version = db.version;
      const stores = Array.from(db.objectStoreNames).sort();
      db.close();
      return { version, stores };
    };
    const readOutbox = async () => {
      const db = await openOutbox();
      const tx = db.transaction(["entries", "metadata"], "readonly");
      const rows = await Promise.all([
        new Promise<any[]>((resolve, reject) => {
          const req = tx.objectStore("entries").getAll();
          req.onsuccess = async () => {
            const all = req.result;
            const normalized = [];
            for (const row of all) normalized.push({
              id: row.id,
              meta: row.meta,
              blobType: row.blob?.type ?? null,
              blobBytes: row.blob ? Array.from(new Uint8Array(await row.blob.arrayBuffer())) : null,
            });
            resolve(normalized);
          };
          req.onerror = () => reject(req.error);
        }),
        new Promise<any[]>((resolve, reject) => {
          const req = tx.objectStore("metadata").getAll();
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        }),
      ]);
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
      });
      const result = { version: db.version, stores: Array.from(db.objectStoreNames).sort(), entries: rows[0], metadata: rows[1] };
      db.close();
      return result;
    };
    const outboxBeforeHeader = await seedOutbox();
    const outboxBefore = await readOutbox();
    const uuid = (n: number) => `30000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    const input = (n: number, o = owner, d = device) => ({
      requestId: uuid(n), ownerId: o, deviceId: d, expectedRevision: 17,
      shiftRef: "shift-fixture-1", tapAt: "2026-10-03T12:30:00.000Z",
      observedServerEvidence: "shift-revision-17",
      intent: { scope: "general" as const, projectRef: "project-fixture-1", activityRef: "activity-fixture-1", menuRevision: "menu-r4", unitRef: null },
    });

    // Two independent API calls race through native readwrite transactions.
    const [firstRace, secondRace] = await Promise.all([
      journal.appendSwitchCommand(input(1)), journal.appendSwitchCommand(input(2)),
    ]);
    const raceRows: Array<any> = [firstRace, secondRace].sort((a, b) => a.command.sequence - b.command.sequence);
    const headAfterRace = await journal.getStreamHead(owner, device);

    // Exact request retries reuse the immutable envelope; conflicting reuse is rejected.
    const duplicate = await journal.appendSwitchCommand(input(1));
    let conflictingRetry = "none";
    try {
      const conflict = input(1);
      conflict.intent.activityRef = "different-activity";
      await journal.appendSwitchCommand(conflict);
    } catch (error) { conflictingRetry = (error as Error).name; }

    // A sent-but-unconfirmed command remains retryable and blocks its successor.
    const sentId = uuid(3);
    const childId = uuid(4);
    await journal.appendSwitchCommand(input(3));
    await journal.appendSwitchCommand(input(4));
    const beforeReceiptPending = await journal.listPending(owner, device);
    const sent = await journal.recordReceipt(owner, device, sentId, { status: "sent" });
    const afterSentPending = await journal.listPending(owner, device);
    const blockedAfterSent = await journal.checkReadiness(owner, device, childId);
    const sentRetry = await journal.recordReceipt(owner, device, sentId, { status: "sent" });
    const confirmed = await journal.recordReceipt(owner, device, sentId, {
      status: "confirmed", serverRevision: 18, resultRef: "server-result-18",
    });
    const readyAfterConfirmed = await journal.checkReadiness(owner, device, childId);

    // A rejected predecessor is terminal for readiness; its dependent stays blocked.
    const reviewParentId = uuid(5);
    const reviewChildId = uuid(6);
    await journal.appendSwitchCommand(input(5));
    await journal.appendSwitchCommand(input(6));
    await journal.recordReceipt(owner, device, reviewParentId, { status: "needsReview", reason: "fixture rejection" });
    const blockedAfterReview = await journal.checkReadiness(owner, device, reviewChildId);

    // A separate owner's stream starts independently and is invisible to the first owner.
    const other = await journal.appendSwitchCommand(input(7, otherOwner, device));
    const otherDeviceRow = await journal.appendSwitchCommand(input(8, owner, otherDevice));
    const mutableInput = input(9);
    const mutationPending = journal.appendSwitchCommand(mutableInput);
    mutableInput.intent.activityRef = "caller-mutated-after-call";
    const mutationRecord = await mutationPending;
    const ownerScopedPending = await journal.listPending(owner, device);
    const foreignLookup = await journal.getCommand(otherOwner, device, sentId);

    // Reload the page and read back the committed receipt from a fresh module instance.
    const storedBeforeReload = await journal.getCommand(owner, device, sentId);
    const outboxAfter = await readOutbox();
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(journal.JOURNAL_DB_NAME);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("Journal fixture database unexpectedly remained open during reset."));
    });
    const resetCommand = await journal.appendSwitchCommand(input(10));
    const resetHead = await journal.getStreamHead(owner, device);
    const outboxAfterReset = await readOutbox();
    return {
      outboxBeforeHeader, outboxBefore, outboxAfter, outboxAfterReset,
      raceSequences: raceRows.map((record) => record.command.sequence),
      racePredecessors: raceRows.map((record) => record.command.predecessorRequestId),
      raceGenerations: raceRows.map((record) => record.command.clientGeneration),
      headAfterRace,
      duplicateSameEnvelope: JSON.stringify(duplicate) === JSON.stringify(firstRace),
      clonedBeforeFirstAwait: mutationRecord.command.intent.activityRef === "activity-fixture-1",
      laterAppendGeneration: mutationRecord.command.clientGeneration,
      conflictingRetry,
      beforeReceiptPending: beforeReceiptPending.map((record: any) => record.command.requestId),
      afterSentPending: afterSentPending.map((record: any) => ({ id: record.command.requestId, status: record.receipt?.status ?? null })),
      sentReceipt: sent.receipt?.status,
      sentRetrySameReceipt: sentRetry.receipt?.recordedAt === sent.receipt?.recordedAt,
      blockedAfterSent,
      confirmedReceipt: confirmed.receipt?.status,
      readyAfterConfirmed,
      blockedAfterReview,
      otherOwner: { id: other.command.requestId, sequence: other.command.sequence },
      otherDevice: { id: otherDeviceRow.command.requestId, sequence: otherDeviceRow.command.sequence },
      ownerScopedPendingIds: ownerScopedPending.map((record: any) => record.command.requestId),
      foreignLookup,
      storedBeforeReload,
      resetSequence: resetCommand.command.sequence,
      resetGeneration: resetCommand.command.clientGeneration,
      resetHeadGeneration: resetHead?.clientGeneration,
    };
  }, { pngBase64: TINY_PNG_BASE64, owner: OWNER, otherOwner: OTHER_OWNER, device: DEVICE, otherDevice: OTHER_DEVICE });

  expect(result.outboxBeforeHeader).toEqual({ version: 2, stores: ["entries", "metadata"] });
  expect(result.outboxAfter).toEqual(result.outboxBefore);
  expect(result.outboxAfterReset).toEqual(result.outboxBefore);
  expect(result.outboxAfter.entries[0].blobType).toBe("image/png");
  expect(result.outboxAfter.entries[0].blobBytes).toEqual(Array.from(Buffer.from(TINY_PNG_BASE64, "base64")));
  expect(result.raceSequences).toEqual([0, 1]);
  expect(result.racePredecessors).toEqual([null, expect.any(String)]);
  expect(result.raceGenerations[0]).toMatch(/^[0-9a-f-]{36}$/i);
  expect(result.raceGenerations[1]).toBe(result.raceGenerations[0]);
  expect(result.headAfterRace).toMatchObject({ ownerId: OWNER, deviceId: DEVICE, sequence: 1 });
  expect(result.headAfterRace.clientGeneration).toBe(result.raceGenerations[0]);
  expect(result.duplicateSameEnvelope).toBe(true);
  expect(result.clonedBeforeFirstAwait).toBe(true);
  expect(result.laterAppendGeneration).toBe(result.raceGenerations[0]);
  expect(result.resetSequence).toBe(0);
  expect(result.resetGeneration).toMatch(/^[0-9a-f-]{36}$/i);
  expect(result.resetGeneration).not.toBe(result.raceGenerations[0]);
  expect(result.resetHeadGeneration).toBe(result.resetGeneration);
  expect(result.conflictingRetry).toBe("JournalConflictError");
  expect(result.beforeReceiptPending).toContain("30000000-0000-4000-8000-000000000003");
  expect(result.afterSentPending).toContainEqual({ id: "30000000-0000-4000-8000-000000000003", status: "sent" });
  expect(result.sentReceipt).toBe("sent");
  expect(result.sentRetrySameReceipt).toBe(true);
  expect(result.blockedAfterSent).toEqual({ ready: false, reason: "needsPredecessor", blockingRequestId: "30000000-0000-4000-8000-000000000003" });
  expect(result.confirmedReceipt).toBe("confirmed");
  expect(result.readyAfterConfirmed).toEqual({ ready: true });
  expect(result.blockedAfterReview).toEqual({ ready: false, reason: "needsPredecessor", blockingRequestId: "30000000-0000-4000-8000-000000000005" });
  expect(result.otherOwner.sequence).toBe(0);
  expect(result.otherDevice.sequence).toBe(0);
  expect(result.ownerScopedPendingIds).not.toContain(result.otherOwner.id);
  expect(result.ownerScopedPendingIds).not.toContain(result.otherDevice.id);
  expect(result.foreignLookup).toBeNull();
  expect(result.storedBeforeReload?.receipt?.status).toBe("confirmed");
});

test("native transaction abort after the command add rejects and leaves no durable row or head", async ({ journalPage: page }) => {
  await openFixture(page);
  const aborted = await page.evaluate(async ({ owner, device }) => {
    // @ts-expect-error Vite resolves this browser URL at runtime; tsc has no declaration for it.
    const journal = await import("/src/lib/workCapture/journal.ts");
    const uuid = "40000000-0000-4000-8000-000000000001";
    const originalAdd = IDBObjectStore.prototype.add;
    let armed = true;
    IDBObjectStore.prototype.add = function (...args: Parameters<IDBObjectStore["add"]>) {
      const request = originalAdd.apply(this, args);
      if (armed && this.transaction.db.name === journal.JOURNAL_DB_NAME && this.name === "commands") {
        armed = false;
        // Abort the actual browser transaction after the journal queued its command row.
        this.transaction.abort();
      }
      return request;
    };
    let rejection: { name: string; message: string } | null = null;
    try {
      await journal.appendSwitchCommand({
        requestId: uuid, ownerId: owner, deviceId: device, expectedRevision: 1,
        shiftRef: "shift-fixture-abort", tapAt: "2026-10-03T12:31:00.000Z",
        observedServerEvidence: "shift-revision-1",
        intent: { scope: "general", projectRef: "project-fixture-1", activityRef: "activity-fixture-1", menuRevision: "menu-r4", unitRef: null },
      });
    } catch (error) {
      rejection = { name: (error as Error).name, message: (error as Error).message };
    } finally {
      IDBObjectStore.prototype.add = originalAdd;
    }
    return {
      armed,
      rejection,
      record: await journal.getCommand(owner, device, uuid),
      head: await journal.getStreamHead(owner, device),
      pending: await journal.listPending(owner, device),
    };
  }, { owner: OWNER, device: DEVICE });

  expect(aborted.armed).toBe(false);
  expect(aborted.rejection).not.toBeNull();
  expect(aborted.rejection?.name).toBe("JournalUnavailableError");
  expect(aborted.record).toBeNull();
  expect(aborted.head).toBeNull();
  expect(aborted.pending).toEqual([]);
});

test("journal records and receipts survive a real page reload", async ({ journalPage: page }) => {
  await openFixture(page);
  const commandId = "50000000-0000-4000-8000-000000000001";
  await page.evaluate(async ({ owner, device, requestId }) => {
    // @ts-expect-error Vite resolves this browser URL at runtime; tsc has no declaration for it.
    const journal = await import("/src/lib/workCapture/journal.ts");
    await journal.appendSwitchCommand({
      requestId, ownerId: owner, deviceId: device, expectedRevision: 6,
      shiftRef: "shift-fixture-reload", tapAt: "2026-10-03T12:32:00.000Z",
      observedServerEvidence: "shift-revision-6",
      intent: { scope: "general", projectRef: "project-fixture-1", activityRef: "activity-fixture-2", menuRevision: "menu-r5", unitRef: null },
    });
    await journal.recordReceipt(owner, device, requestId, { status: "confirmed", serverRevision: 7, resultRef: "result-fixture-7" });
  }, { owner: OWNER, device: DEVICE, requestId: commandId });

  await page.reload();
  const persisted = await page.evaluate(async ({ owner, device, requestId }) => {
    // @ts-expect-error Vite resolves this browser URL at runtime; tsc has no declaration for it.
    const journal = await import("/src/lib/workCapture/journal.ts");
    const record = await journal.getCommand(owner, device, requestId);
    return {
      record,
      head: await journal.getStreamHead(owner, device),
      readiness: await journal.checkReadiness(owner, device, requestId),
      clientGeneration: record?.command.clientGeneration,
      headGeneration: (await journal.getStreamHead(owner, device))?.clientGeneration,
    };
  }, { owner: OWNER, device: DEVICE, requestId: commandId });
  expect(persisted.record?.command.requestId).toBe(commandId);
  expect(persisted.record?.receipt?.status).toBe("confirmed");
  expect(persisted.head?.headRequestId).toBe(commandId);
  expect(persisted.clientGeneration).toMatch(/^[0-9a-f-]{36}$/i);
  expect(persisted.headGeneration).toBe(persisted.clientGeneration);
  expect(persisted.readiness).toEqual({ ready: true });
});

test("append refuses corrupt, foreign-pointing, generation-mismatched or missing tails without advancing", async ({ journalPage: page }) => {
  await openFixture(page);
  const result = await page.evaluate(async ({ owner, device, otherOwner, otherDevice }) => {
    // @ts-expect-error Vite resolves this browser URL at runtime; tsc has no declaration for it.
    const journal = await import("/src/lib/workCapture/journal.ts");
    const corruptHeadRequestId = "60000000-0000-4000-8000-000000000001";
    const corruptNextRequestId = "60000000-0000-4000-8000-000000000002";
    const missingTailRequestId = "60000000-0000-4000-8000-000000000003";
    const missingNextRequestId = "60000000-0000-4000-8000-000000000004";
    const foreignStreamTailId = "60000000-0000-4000-8000-000000000005";
    const foreignStreamNextId = "60000000-0000-4000-8000-000000000006";
    const generationTailId = "60000000-0000-4000-8000-000000000007";
    const generationNextId = "60000000-0000-4000-8000-000000000008";
    const mismatchedGeneration = "70000000-0000-4000-8000-000000000001";
    const makeInput = (requestId: string, streamOwner: string, streamDevice: string) => ({
      requestId, ownerId: streamOwner, deviceId: streamDevice, expectedRevision: 4,
      shiftRef: "shift-fixture-integrity", tapAt: "2026-10-03T12:33:00.000Z",
      observedServerEvidence: "shift-revision-4",
      intent: { scope: "general" as const, projectRef: "project-fixture-1", activityRef: "activity-fixture-3", menuRevision: "menu-r5", unitRef: null },
    });
    await journal.appendSwitchCommand(makeInput(corruptHeadRequestId, owner, device));
    await journal.appendSwitchCommand(makeInput(missingTailRequestId, otherOwner, otherDevice));
    await journal.appendSwitchCommand(makeInput(foreignStreamTailId, otherOwner, device));
    await journal.appendSwitchCommand(makeInput(generationTailId, owner, otherDevice));

    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(journal.JOURNAL_DB_NAME, journal.JOURNAL_DB_VERSION);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const edit = db.transaction(["heads", "commands"], "readwrite");
    const heads = edit.objectStore("heads");
    const commands = edit.objectStore("commands");
    const headKey = `${owner}:${device}`;
    const missingHeadKey = `${otherOwner}:${otherDevice}`;
    const foreignHeadKey = `${otherOwner}:${device}`;
    const generationHeadKey = `${owner}:${otherDevice}`;
    const badHeadRequest = heads.get(headKey);
    badHeadRequest.onsuccess = () => {
      const head = badHeadRequest.result;
      heads.put({ ...head, sequence: head.sequence + 3 });
    };
    const foreignHeadRequest = heads.get(foreignHeadKey);
    foreignHeadRequest.onsuccess = () => {
      const head = foreignHeadRequest.result;
      heads.put({ ...head, headRequestId: corruptHeadRequestId });
    };
    const generationHeadRequest = heads.get(generationHeadKey);
    generationHeadRequest.onsuccess = () => {
      const head = generationHeadRequest.result;
      heads.put({ ...head, clientGeneration: mismatchedGeneration });
    };
    commands.delete(missingTailRequestId);
    await new Promise<void>((resolve, reject) => {
      edit.oncomplete = () => resolve();
      edit.onabort = () => reject(edit.error);
      edit.onerror = () => reject(edit.error);
    });

    const rejected = [] as Array<{ name: string; message: string }>;
    for (const input of [
      makeInput(corruptNextRequestId, owner, device),
      makeInput(missingNextRequestId, otherOwner, otherDevice),
      makeInput(foreignStreamNextId, otherOwner, device),
      makeInput(generationNextId, owner, otherDevice),
    ]) {
      try { await journal.appendSwitchCommand(input); }
      catch (error) { rejected.push({ name: (error as Error).name, message: (error as Error).message }); }
    }
    const inspect = await new Promise<any>((resolve, reject) => {
      const tx = db.transaction(["heads", "commands"], "readonly");
      const headRows = tx.objectStore("heads");
      const commandRows = tx.objectStore("commands");
      const bad = headRows.get(headKey);
      const missing = headRows.get(missingHeadKey);
      const foreign = headRows.get(foreignHeadKey);
      const generation = headRows.get(generationHeadKey);
      const corruptNext = commandRows.get(corruptNextRequestId);
      const missingNext = commandRows.get(missingNextRequestId);
      const foreignNext = commandRows.get(foreignStreamNextId);
      const generationNext = commandRows.get(generationNextId);
      const values: any = {};
      for (const [key, request] of [
        ["badHead", bad], ["missingTailHead", missing], ["foreignHead", foreign], ["generationHead", generation],
        ["corruptNext", corruptNext], ["missingNext", missingNext], ["foreignNext", foreignNext], ["generationNext", generationNext],
      ] as const) {
        request.onsuccess = () => { values[key] = request.result ?? null; };
      }
      tx.oncomplete = () => resolve(values);
      tx.onabort = () => reject(tx.error);
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    return { rejected, inspect };
  }, { owner: OWNER, device: DEVICE, otherOwner: OTHER_OWNER, otherDevice: OTHER_DEVICE });

  expect(result.rejected).toHaveLength(4);
  expect(result.rejected.map((error: { name: string }) => error.name)).toEqual(Array(4).fill("JournalValidationError"));
  expect(result.inspect.badHead.sequence).toBe(3);
  expect(result.inspect.missingTailHead.sequence).toBe(0);
  expect(result.inspect.foreignHead.headRequestId).toBe("60000000-0000-4000-8000-000000000001");
  expect(result.inspect.generationHead.clientGeneration).toBe("70000000-0000-4000-8000-000000000001");
  expect(result.inspect.corruptNext).toBeNull();
  expect(result.inspect.missingNext).toBeNull();
  expect(result.inspect.foreignNext).toBeNull();
  expect(result.inspect.generationNext).toBeNull();
});

test("independent same-origin tabs serialize appends through native IndexedDB", async ({ journalPage: firstPage }) => {
  await openFixture(firstPage);
  const secondPage = await firstPage.context().newPage();
  try {
    await openFixture(secondPage);
    const stream = await firstPage.evaluate(async ({ owner, device }) => {
      // @ts-expect-error Vite resolves this browser URL at runtime; tsc has no declaration for it.
      const journal = await import("/src/lib/workCapture/journal.ts");
      // Initialize the schema before the cross-tab readwrite race so this case
      // measures transaction serialization rather than competing DB upgrades.
      await journal.getStreamHead(owner, device);
      return { ownerId: owner, deviceId: device };
    }, { owner: OWNER, device: DEVICE });
    const inputs = [
      { requestId: "71000000-0000-4000-8000-000000000001", ownerId: stream.ownerId, deviceId: stream.deviceId },
      { requestId: "71000000-0000-4000-8000-000000000002", ownerId: stream.ownerId, deviceId: stream.deviceId },
    ];
    const appendFromTab = (target: Page, input: typeof inputs[number]) => target.evaluate(async (data) => {
      // @ts-expect-error Vite resolves this browser URL at runtime; tsc has no declaration for it.
      const journal = await import("/src/lib/workCapture/journal.ts");
      return journal.appendSwitchCommand({
        ...data, expectedRevision: 23, shiftRef: "shift-cross-tab", tapAt: "2026-10-03T12:34:00.000Z",
        observedServerEvidence: "shift-revision-23",
        intent: { scope: "general", projectRef: "project-fixture-1", activityRef: data.requestId, menuRevision: "menu-r6", unitRef: null },
      });
    }, input);
    const [a, b] = await Promise.all([
      appendFromTab(firstPage, inputs[0]),
      appendFromTab(secondPage, inputs[1]),
    ]);
    const sorted = [a, b].sort((left, right) => left.command.sequence - right.command.sequence);
    const visibleFromSecondTab = await secondPage.evaluate(async ({ ownerId, deviceId, requestIds }) => {
      // @ts-expect-error Vite resolves this browser URL at runtime; tsc has no declaration for it.
      const journal = await import("/src/lib/workCapture/journal.ts");
      return {
        records: await Promise.all(requestIds.map((id) => journal.getCommand(ownerId, deviceId, id))),
        head: await journal.getStreamHead(ownerId, deviceId),
      };
    }, { ownerId: stream.ownerId, deviceId: stream.deviceId, requestIds: inputs.map((input) => input.requestId) });
    expect(sorted.map((record) => record.command.sequence)).toEqual([0, 1]);
    expect(sorted[0].command.predecessorRequestId).toBeNull();
    expect(sorted[1].command.predecessorRequestId).toBe(sorted[0].command.requestId);
    expect(sorted[0].command.clientGeneration).toMatch(/^[0-9a-f-]{36}$/i);
    expect(sorted[1].command.clientGeneration).toBe(sorted[0].command.clientGeneration);
    expect(visibleFromSecondTab.records.map((record: any) => record?.command.requestId).sort()).toEqual(inputs.map((input) => input.requestId).sort());
    expect(visibleFromSecondTab.head).toMatchObject({ sequence: 1, headRequestId: sorted[1].command.requestId, clientGeneration: sorted[0].command.clientGeneration });
  } finally {
    await secondPage.close();
  }
});

test("a confirmed predecessor from another client generation does not unblock its child", async ({ journalPage: page }) => {
  await openFixture(page);
  const result = await page.evaluate(async ({ owner, device }) => {
    // @ts-expect-error Vite resolves this browser URL at runtime; tsc has no declaration for it.
    const journal = await import("/src/lib/workCapture/journal.ts");
    const parentId = "72000000-0000-4000-8000-000000000001";
    const childId = "72000000-0000-4000-8000-000000000002";
    const input = (requestId: string) => ({
      requestId, ownerId: owner, deviceId: device, expectedRevision: 30,
      shiftRef: "shift-generation-mismatch", tapAt: "2026-10-03T12:35:00.000Z",
      observedServerEvidence: "shift-revision-30",
      intent: { scope: "general" as const, projectRef: "project-fixture-1", activityRef: requestId, menuRevision: "menu-r6", unitRef: null },
    });
    const parent = await journal.appendSwitchCommand(input(parentId));
    const child = await journal.appendSwitchCommand(input(childId));
    await journal.recordReceipt(owner, device, parentId, { status: "confirmed", serverRevision: 31, resultRef: "confirmed-from-old-generation" });
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(journal.JOURNAL_DB_NAME, journal.JOURNAL_DB_VERSION);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const tx = db.transaction("commands", "readwrite");
    const store = tx.objectStore("commands");
    const read = store.get(parentId);
    read.onsuccess = () => store.put({ ...read.result, command: { ...read.result.command, clientGeneration: "82000000-0000-4000-8000-000000000001" } });
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
      tx.onerror = () => reject(tx.error);
    });
    const readiness = await journal.checkReadiness(owner, device, childId);
    db.close();
    return { parentGeneration: parent.command.clientGeneration, childGeneration: child.command.clientGeneration, readiness };
  }, { owner: OWNER, device: DEVICE });
  expect(result.parentGeneration).toBe(result.childGeneration);
  expect(result.readiness).toEqual({ ready: false, reason: "needsPredecessor", blockingRequestId: "72000000-0000-4000-8000-000000000001" });
});

test("foreign malformed duplicate rows reject without exposing their sentinel contents", async ({ journalPage: page }) => {
  await openFixture(page);
  const result = await page.evaluate(async ({ owner, otherOwner, device }) => {
    // @ts-expect-error Vite resolves this browser URL at runtime; tsc has no declaration for it.
    const journal = await import("/src/lib/workCapture/journal.ts");
    const requestId = "73000000-0000-4000-8000-000000000001";
    const sentinel = "PRIVATE-FOREIGN-ROW-SENTINEL";
    await journal.getStreamHead(owner, device);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(journal.JOURNAL_DB_NAME, journal.JOURNAL_DB_VERSION);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const tx = db.transaction("commands", "readwrite");
    tx.objectStore("commands").add({
      command: {
        encodingVersion: 1, requestId, ownerId: otherOwner, deviceId: device,
        clientGeneration: "83000000-0000-4000-8000-000000000001", sequence: 0, predecessorRequestId: null,
        expectedRevision: 1, shiftRef: "foreign-shift", tapAt: "2026-10-03T12:36:00.000Z",
        observedServerEvidence: "foreign-evidence", secretSentinel: sentinel,
        intent: { scope: "general", projectRef: "foreign-project", activityRef: "foreign-activity", menuRevision: "foreign-menu", unitRef: null },
      },
      receipt: null,
    });
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
      tx.onerror = () => reject(tx.error);
    });
    const ownerLookup = await journal.getCommand(owner, device, requestId);
    let rejection: { name: string; message: string } | null = null;
    try {
      await journal.appendSwitchCommand({
        requestId, ownerId: owner, deviceId: device, expectedRevision: 1,
        shiftRef: "owner-shift", tapAt: "2026-10-03T12:36:01.000Z", observedServerEvidence: "owner-evidence",
        intent: { scope: "general", projectRef: "owner-project", activityRef: "owner-activity", menuRevision: "owner-menu", unitRef: null },
      });
    } catch (error) { rejection = { name: (error as Error).name, message: (error as Error).message }; }
    const ownerPending = await journal.listPending(owner, device);
    db.close();
    return { ownerLookup, rejection, ownerPendingCount: ownerPending.length, sentinel };
  }, { owner: OWNER, otherOwner: OTHER_OWNER, device: DEVICE });
  expect(result.ownerLookup).toBeNull();
  expect(result.rejection?.name).toBe("JournalConflictError");
  expect(result.rejection?.message).not.toContain(result.sentinel);
  expect(result.ownerPendingCount).toBe(0);
});
