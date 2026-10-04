import { expect, test as base, webkit, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { fixture } from "./support/unitReviewNativeHarness";
// Retain the fixture's global type without importing its browser side effects.
type NativeFixture = typeof fixture;
const test = base.extend({
  context: async ({ browserName, context: inherited }, provideContext) => {
    if (browserName !== "webkit") { await provideContext(inherited); return; }
    const directory = mkdtempSync(join(tmpdir(), "unit-review-webkit-"));
    const persistent = await webkit.launchPersistentContext(directory, { headless: true, viewport: { width: 390, height: 844 } });
    try { await provideContext(persistent); } finally { await persistent.close(); rmSync(directory, { recursive: true, force: true }); }
  },
});
async function open(page: Page) {
  await page.route("**/*", route => new URL(route.request().url()).hostname === "localhost" ? route.continue() : route.abort());
  await page.goto("/e2e/support/unit-review-native.html");
  await page.waitForFunction(() => !!window.unitReviewFixture);
}
const reserve = (page: Page, n: number) => page.evaluate(async number => {
  const f: NativeFixture = window.unitReviewFixture;
  try { return { ok: true, saved: await f.storage.reserveReviewOriginal(f.auth.signInMark(), f.storage.freezeReviewOriginal(f.id(number), f.payload()), null, () => true) }; }
  catch { return { ok: false, saved: null }; }
}, n);

test("native atomic owner/unit reservation serializes two tabs, survives reload, and preserves existing photo bytes", async ({ page, context }) => {
  await open(page); const other = await context.newPage(); await open(other);
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open("wops-write-outbox", 2);
      r.onupgradeneeded = () => { r.result.createObjectStore("entries", { keyPath: "id" }); r.result.createObjectStore("metadata", { keyPath: "id" }); };
      r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
    });
    const tx = db.transaction("entries", "readwrite");
    tx.objectStore("entries").add({ id: "original-photo", photoBlob: new Blob([new Uint8Array([11, 29, 53])]), note: "Keep original" });
    await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); }); db.close();
  });
  const raced = await Promise.all([reserve(page, 10), reserve(other, 11)]);
  expect(raced.filter(r => r.ok)).toHaveLength(1); const winner = raced.find(r => r.ok)!.saved!.record;
  expect(winner.payload).toMatchObject({ data: { widthDecimal: "1.000000000000000001" } });
  await page.reload(); await page.waitForFunction(() => !!window.unitReviewFixture);
  const result = await page.evaluate(async () => {
    const f = window.unitReviewFixture, rows = await f.storage.readReviewJournal(f.auth.signInMark(), f.UNIT, () => true);
    const db = await new Promise<IDBDatabase>(resolve => { const r = indexedDB.open("wops-write-outbox"); r.onsuccess = () => resolve(r.result); });
    const version = db.version, stores = [...db.objectStoreNames];
    const entry = await new Promise<{ photoBlob: Blob; note: string }>(resolve => { const r = db.transaction("entries").objectStore("entries").get("original-photo"); r.onsuccess = () => resolve(r.result); });
    const bytes = [...new Uint8Array(await entry.photoBlob.arrayBuffer())]; db.close(); return { rows, version, stores, bytes, note: entry.note };
  });
  expect(result).toEqual({ rows: [winner], version: 2, stores: ["entries", "metadata"], bytes: [11, 29, 53], note: "Keep original" });
  expect((await reserve(page, winner.commandId.endsWith("10") ? 10 : 11)).saved?.created).toBe(false);
});

test("native competing leases, expiry, stale settlement and later refusal preserve prior uncertainty", async ({ page, context }) => {
  await open(page); const other = await context.newPage(); await open(other); await reserve(page, 10);
  const claim = (tab: Page, token: number) => tab.evaluate(async n => {
    const f = window.unitReviewFixture;
    try { return await f.storage.claimReviewAttempt(f.auth.signInMark(), f.UNIT, f.id(10), 0, f.id(n), 100, () => true); } catch { return null; }
  }, token);
  const raced = await Promise.all([claim(page, 20), claim(other, 21)]);
  expect(raced.filter(Boolean)).toHaveLength(1);
  const result = await page.evaluate(async () => {
    const f = window.unitReviewFixture, login = f.auth.signInMark(), read = () => f.storage.readReviewJournal(login, f.UNIT, () => true);
    const first = (await read())[0]; let activeBlocked = false, staleBlocked = false, replacementBlocked = false;
    try { await f.storage.claimReviewAttempt(login, f.UNIT, f.id(10), first.revision, f.id(22), 101, () => true); } catch { activeBlocked = true; }
    const next = await f.storage.claimReviewAttempt(login, f.UNIT, f.id(10), first.revision, f.id(22), 100 + f.storage.REVIEW_LEASE_MS, () => true);
    try { await f.storage.settleReviewAttempt(login, f.UNIT, f.id(10), first.revision, first.attempts[0].token, { kind: "applied", receipt: f.receipt(f.id(10)) }, () => true); } catch { staleBlocked = true; }
    const refused = await f.storage.settleReviewAttempt(login, f.UNIT, f.id(10), next.revision, f.id(22), { kind: "attempt_refused", sqlState: "23514" }, () => true);
    try { await f.storage.reserveReviewOriginal(login, f.storage.freezeReviewOriginal(f.id(12), f.payload()), f.id(10), () => true); } catch { replacementBlocked = true; }
    return { activeBlocked, staleBlocked, replacementBlocked, state: f.storage.reviewDeliveryState(refused), attempts: refused.attempts.map(a => a.outcome) };
  });
  expect(result).toEqual({ activeBlocked: true, staleBlocked: true, replacementBlocked: true, state: "unknown", attempts: ["unknown", "refused"] });
});

test("native failed save and owner ABA abort both original and head atomically", async ({ page }) => {
  await open(page);
  const result = await page.evaluate(async () => {
    const f = window.unitReviewFixture, add = IDBObjectStore.prototype.add; let injected = false, blocked = false;
    IDBObjectStore.prototype.add = function (...args: Parameters<typeof add>) {
      const request = add.apply(this, args);
      if (this.name === "requests" && !injected) { injected = true; f.auth.rememberSignedIn(null); f.auth.rememberSignedIn({ user: { id: f.OWNER } }); }
      return request;
    };
    try { await f.storage.reserveReviewOriginal(f.auth.signInMark(), f.storage.freezeReviewOriginal(f.id(10), f.payload()), null, () => true); } catch { blocked = true; }
    finally { IDBObjectStore.prototype.add = add; }
    const afterABA = await f.storage.readReviewJournal(f.auth.signInMark(), f.UNIT, () => true);
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) {
      if (this.name === "heads") throw new DOMException("Fixture storage full", "QuotaExceededError");
      return put.apply(this, args);
    };
    let quotaBlocked = false;
    try { await f.storage.reserveReviewOriginal(f.auth.signInMark(), f.storage.freezeReviewOriginal(f.id(11), f.payload()), null, () => true); } catch { quotaBlocked = true; }
    finally { IDBObjectStore.prototype.put = put; }
    const afterQuota = await f.storage.readReviewJournal(f.auth.signInMark(), f.UNIT, () => true);
    const saved = await f.storage.reserveReviewOriginal(f.auth.signInMark(), f.storage.freezeReviewOriginal(f.id(12), f.payload()), null, () => true);
    return { blocked, afterABA, quotaBlocked, afterQuota, saved: saved.record.commandId };
  });
  expect(result).toMatchObject({ blocked: true, afterABA: [], quotaBlocked: true, afterQuota: [], saved: "00000000-0000-4000-8000-000000000012" });
});

test("native retained requests stay hidden from another owner and bind exact receipt before advancing the head", async ({ page }) => {
  await open(page); await reserve(page, 10);
  const result = await page.evaluate(async () => {
    const f = window.unitReviewFixture, oldLogin = f.auth.signInMark();
    f.auth.rememberSignedIn({ user: { id: f.id(99) } });
    const other = await f.storage.readReviewJournal(f.auth.signInMark(), f.UNIT, () => true); let oldBlocked = false;
    try { await f.storage.readReviewJournal(oldLogin, f.UNIT, () => true); } catch { oldBlocked = true; }
    f.auth.rememberSignedIn({ user: { id: f.OWNER } }); const login = f.auth.signInMark();
    let wrongReceiptBlocked = false, staleHeadBlocked = false;
    try { await f.storage.recordReviewReceipt(login, f.UNIT, f.id(10), 0, { ...f.receipt(f.id(10)), generation: 99 }, () => true); } catch { wrongReceiptBlocked = true; }
    await f.storage.recordReviewReceipt(login, f.UNIT, f.id(10), 0, f.receipt(f.id(10)), () => true);
    try { await f.storage.reserveReviewOriginal(login, f.storage.freezeReviewOriginal(f.id(11), f.payload()), null, () => true); } catch { staleHeadBlocked = true; }
    await f.storage.reserveReviewOriginal(login, f.storage.freezeReviewOriginal(f.id(11), f.payload()), f.id(10), () => true);
    return { other, oldBlocked, wrongReceiptBlocked, staleHeadBlocked, rows: await f.storage.readReviewJournal(login, f.UNIT, () => true) };
  });
  expect(result).toMatchObject({ other: [], oldBlocked: true, wrongReceiptBlocked: true, staleHeadBlocked: true });
  expect(result.rows).toHaveLength(2); expect(result.rows[0].receipt).toBeTruthy(); expect(result.rows[1].predecessorId).toBe(result.rows[0].commandId);
});

test("native coordinator reload checks never resend saved or crash-before-send originals", async ({ page }) => {
  await open(page);
  const before = await page.evaluate(async () => {
    const f = window.unitReviewFixture; await f.coordinator.refresh(); const saved = await f.coordinator.reserve(f.id(10), f.payload());
    const row = (await f.storage.readReviewJournal(f.auth.signInMark(), f.UNIT, () => true))[0];
    await f.storage.claimReviewAttempt(f.auth.signInMark(), f.UNIT, row.commandId, row.revision, f.id(20), 0, () => true);
    return { saved, sends: f.sends() };
  });
  expect(before).toMatchObject({ saved: { kind: "saved" }, sends: 0 });
  await page.reload(); await page.waitForFunction(() => !!window.unitReviewFixture);
  const after = await page.evaluate(async () => {
    const f = window.unitReviewFixture; await f.coordinator.refresh(); await f.coordinator.refresh();
    return { inspection: f.coordinator.inspection(), sends: f.sends() };
  });
  expect(after).toMatchObject({ sends: 0, inspection: { history: [{ delivery: "unknown" }] } });
});

test("native local acknowledgement failure retains uncertainty after server applied", async ({ page }) => {
  await open(page); await reserve(page, 10);
  const result = await page.evaluate(async () => {
    const f = window.unitReviewFixture, login = f.auth.signInMark(), claimed = await f.storage.claimReviewAttempt(login, f.UNIT, f.id(10), 0, f.id(20), 100, () => true);
    const put = IDBObjectStore.prototype.put; let blocked = false;
    IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) {
      if (this.name === "requests") throw new DOMException("Fixture acknowledgement failure", "QuotaExceededError");
      return put.apply(this, args);
    };
    try { await f.storage.settleReviewAttempt(login, f.UNIT, f.id(10), claimed.revision, f.id(20), { kind: "applied", receipt: f.receipt(f.id(10)) }, () => true); } catch { blocked = true; }
    finally { IDBObjectStore.prototype.put = put; }
    const row = (await f.storage.readReviewJournal(login, f.UNIT, () => true))[0];
    const repaired = await f.storage.recordReviewReceipt(login, f.UNIT, f.id(10), row.revision, f.receipt(f.id(10)), () => true);
    return { blocked, before: f.storage.reviewDeliveryState(row), beforeReceipt: row.receipt, after: f.storage.reviewDeliveryState(repaired), attempts: repaired.attempts };
  });
  expect(result).toMatchObject({ blocked: true, before: "unknown", beforeReceipt: null, after: "recorded", attempts: [{ outcome: "pending" }] });
});

test("native frozen defects and significant dimensions cannot be replaced under an existing command UUID", async ({ page }) => {
  await open(page);
  const first = await page.evaluate(async () => {
    const f = window.unitReviewFixture, data = { note: "Check the original defects", defects: [{ id: f.id(31), summary: "Seal" }, { id: f.id(30), summary: "Frame" }] };
    const original = f.storage.freezeReviewOriginal(f.id(10), { action: "fail", basis: f.payload().basis, data });
    const pending = f.storage.reserveReviewOriginal(f.auth.signInMark(), original, null, () => true);
    data.defects[0].id = f.id(99); data.defects[0].summary = "Edited after tap";
    const saved = await pending; let replacementBlocked = false;
    try { await f.storage.reserveReviewOriginal(f.auth.signInMark(), f.storage.freezeReviewOriginal(f.id(10), { action: "fail", basis: f.payload().basis, data }), null, () => true); } catch { replacementBlocked = true; }
    return { replacementBlocked, record: saved.record };
  });
  expect(first.replacementBlocked).toBe(true);
  expect(first.record.payload).toMatchObject({ data: { defects: [{ id: "00000000-0000-4000-8000-000000000030", summary: "Frame" },
    { id: "00000000-0000-4000-8000-000000000031", summary: "Seal" }] } });
  await page.reload(); await page.waitForFunction(() => !!window.unitReviewFixture);
  expect(await page.evaluate(async () => { const f = window.unitReviewFixture; return f.storage.readReviewJournal(f.auth.signInMark(), f.UNIT, () => true); })).toEqual([first.record]);
});

test("native late receipt repair cannot overwrite a newer lease and context failure cannot send", async ({ page }) => {
  await open(page); await reserve(page, 10);
  const result = await page.evaluate(async () => {
    const f = window.unitReviewFixture, login = f.auth.signInMark();
    const first = await f.storage.claimReviewAttempt(login, f.UNIT, f.id(10), 0, f.id(20), 0, () => true);
    await f.storage.claimReviewAttempt(login, f.UNIT, f.id(10), first.revision, f.id(21), f.storage.REVIEW_LEASE_MS, () => true);
    let staleBlocked = false;
    try { await f.storage.recordReviewReceipt(login, f.UNIT, f.id(10), first.revision, f.receipt(f.id(10)), () => true); } catch { staleBlocked = true; }
    f.coordinator.dispose(); const result = await f.coordinator.deliverOriginal(f.id(10));
    return { staleBlocked, result, sends: f.sends(), rows: await f.storage.readReviewJournal(login, f.UNIT, () => true) };
  });
  expect(result).toMatchObject({ staleBlocked: true, result: { kind: "held", reason: "context_changed" }, sends: 0,
    rows: [{ receipt: null, attempts: [{ outcome: "unknown" }, { outcome: "pending" }] }] });
});

test("native case variants of one UUID share one unit head and original identity", async ({ page }) => {
  await open(page);
  const result = await page.evaluate(async () => {
    const f = window.unitReviewFixture, login = f.auth.signInMark(), unit = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const command = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const a = f.payload(); a.basis.unitId = unit.toUpperCase();
    const b = f.payload(); b.basis.unitId = unit;
    const first = await f.storage.reserveReviewOriginal(login, f.storage.freezeReviewOriginal(command.toUpperCase(), a), null, () => true);
    const same = await f.storage.reserveReviewOriginal(login, f.storage.freezeReviewOriginal(command, b), null, () => true);
    let differentBlocked = false;
    try { await f.storage.reserveReviewOriginal(login, f.storage.freezeReviewOriginal(f.id(10), b), null, () => true); } catch { differentBlocked = true; }
    return { first: first.record.commandId, createdAgain: same.created, differentBlocked,
      records: await f.storage.readReviewJournal(login, unit.toUpperCase(), () => true) };
  });
  expect(result).toMatchObject({ first: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", createdAgain: false, differentBlocked: true });
  expect(result.records).toHaveLength(1); expect(result.records[0].unitId).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
});


test("native strict durability is required on every write and ignored or unsupported options hold delivery", async ({ page }) => {
  await open(page);
  const result = await page.evaluate(async () => {
    const f = window.unitReviewFixture, transaction = IDBDatabase.prototype.transaction;
    const modes: string[] = [], failures: string[] = [];
    for (const mode of ["unsupported", "ignored"]) {
      IDBDatabase.prototype.transaction = function (...args: Parameters<typeof transaction>) {
        if (this.name === f.storage.UNIT_REVIEW_DB && args[1] === "readwrite") {
          modes.push(args[2]?.durability ?? "missing");
          if (mode === "unsupported") throw new TypeError("Fixture browser lacks strict transactions");
          const tx = transaction.call(this, args[0], args[1]);
          Object.defineProperty(tx, "durability", { value: "relaxed" }); return tx;
        }
        return transaction.apply(this, args);
      };
      await f.coordinator.refresh(); const saved = await f.coordinator.reserve(f.id(10), f.payload());
      failures.push(saved.kind === "held" ? saved.reason : "incorrectly saved");
    }
    IDBDatabase.prototype.transaction = transaction;
    const rows = await f.storage.readReviewJournal(f.auth.signInMark(), f.UNIT, () => true);
    await f.coordinator.refresh(); const saved = await f.coordinator.reserve(f.id(10), f.payload());
    const strictRows = await f.storage.readReviewJournal(f.auth.signInMark(), f.UNIT, () => true);
    return { modes, failures, rows, saved, strict: strictRows[0].durability, sends: f.sends() };
  });
  expect(result).toMatchObject({ modes: ["strict", "strict"], failures: ["storage_unavailable", "storage_unavailable"], rows: [],
    saved: { kind: "saved" }, strict: "strict", sends: 0 });
});

test("native older unmarked records stay retained and cannot become a false first refusal", async ({ page }) => {
  await open(page); await reserve(page, 10);
  const result = await page.evaluate(async () => {
    const f = window.unitReviewFixture;
    const db = await new Promise<IDBDatabase>(resolve => { const r = indexedDB.open(f.storage.UNIT_REVIEW_DB); r.onsuccess = () => resolve(r.result); });
    const tx = db.transaction("requests", "readwrite", { durability: "strict" }), store = tx.objectStore("requests");
    const row = await new Promise<Record<string, unknown>>(resolve => { const r = store.get(f.id(10)); r.onsuccess = () => resolve(r.result); });
    delete row.durability; store.put(row);
    await new Promise<void>(resolve => { tx.oncomplete = () => resolve(); });
    const delivery = await f.coordinator.deliverOriginal(f.id(10));
    const retained = await new Promise<Record<string, unknown>>(resolve => { const r = db.transaction("requests").objectStore("requests").get(f.id(10)); r.onsuccess = () => resolve(r.result); });
    db.close(); return { delivery, sends: f.sends(), retained };
  });
  expect(result).toMatchObject({ delivery: { kind: "held", reason: "storage_unavailable" }, sends: 0, retained: { commandId: "00000000-0000-4000-8000-000000000010", attempts: [] } });
  expect(result.retained).not.toHaveProperty("durability");
});

test("native owner UUID spellings share a retained head without bypassing login generation", async ({ page }) => {
  await open(page);
  const result = await page.evaluate(async () => {
    const f = window.unitReviewFixture, owner = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    f.auth.rememberSignedIn({ user: { id: owner.toUpperCase() } }); const prior = f.auth.signInMark();
    await f.storage.reserveReviewOriginal(prior, f.storage.freezeReviewOriginal(f.id(10), f.payload()), null, () => true);
    f.auth.rememberSignedIn({ user: { id: owner } }); const rows = await f.storage.readReviewJournal(f.auth.signInMark(), f.UNIT, () => true);
    let staleBlocked = false; try { await f.storage.readReviewJournal(prior, f.UNIT, () => true); } catch { staleBlocked = true; }
    let replacementBlocked = false; try { await f.storage.reserveReviewOriginal(f.auth.signInMark(), f.storage.freezeReviewOriginal(f.id(11), f.payload()), null, () => true); } catch { replacementBlocked = true; }
    return { rows, staleBlocked, replacementBlocked };
  });
  expect(result).toMatchObject({ rows: [{ ownerId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }], staleBlocked: true, replacementBlocked: true });
  expect(result.rows).toHaveLength(1);
});

test("native explicit cancellation recovers a stale hidden original after lease expiry and retains uncertainty history", async ({ page }) => {
  await open(page); await reserve(page, 10);
  const result = await page.evaluate(async () => {
    const f = window.unitReviewFixture, login = f.auth.signInMark(); let cancels = 0, sends = 0, serverReceipt: ReturnType<typeof f.cancellation> | null = null;
    await f.storage.claimReviewAttempt(login, f.UNIT, f.id(10), 0, f.id(20), 0, () => true);
    const current = f.view(); if (current.availability !== "available") throw Error();
    current.review.basis!.scopeToken = `ur1:${"b".repeat(64)}`; current.review.basis!.reviewRevision++;
    const c = new f.UnitReviewCoordinator({ login, unitId: f.UNIT, contextKey: "reopened-job", admission: () => true }, {
      read: async () => current,
      receipt: async () => serverReceipt ? { protocolVersion: 1, availability: "available", receipt: serverReceipt } : { protocolVersion: 1, availability: "unavailable", receipt: null },
      send: async () => { sends++; return { kind: "unknown" }; },
      cancel: async (command, original) => { cancels++; serverReceipt = f.cancellation(command, original); return { kind: "cancelled", receipt: serverReceipt }; },
      wallNow: () => f.storage.REVIEW_LEASE_MS + 1,
    });
    const before = await c.refresh(); const closed = await c.cancelRetainedHead();
    const after = await c.refresh(); const next = await c.reserve(f.id(11), { ...f.payload(), basis: current.review.basis! });
    const rows = await f.storage.readReviewJournal(login, f.UNIT, () => true);
    return { before, closed, after, next, cancels, sends, attempts: rows[0].attempts, oldOriginal: rows[0].payload, count: rows.length };
  });
  expect(result).toMatchObject({ before: { hasHiddenOriginal: true, history: [] }, closed: { kind: "cancelled" }, after: { history: [{ delivery: "cancelled" }] }, next: { kind: "saved" },
    cancels: 1, sends: 0, attempts: [{ purpose: "deliver", outcome: "unknown" }, { purpose: "cancel", outcome: "cancelled" }], count: 2 });
  expect(result.oldOriginal.basis.reviewRevision).toBe(0);
});

test("native cancellation refuses a live lease and receipt-only reads never close it", async ({ page }) => {
  await open(page); await reserve(page, 10);
  const result = await page.evaluate(async () => {
    const f = window.unitReviewFixture, login = f.auth.signInMark(); let cancels = 0;
    await f.storage.claimReviewAttempt(login, f.UNIT, f.id(10), 0, f.id(20), Date.now(), () => true);
    const c = new f.UnitReviewCoordinator({ login, unitId: f.UNIT, contextKey: "same-job", admission: () => true }, {
      read: async () => f.view(), receipt: async () => ({ protocolVersion: 1, availability: "unavailable", receipt: null }),
      cancel: async () => { cancels++; return { kind: "unknown" }; },
    });
    await c.refresh(); const result = await c.cancelRetainedHead();
    return { result, cancels, rows: await f.storage.readReviewJournal(login, f.UNIT, () => true) };
  });
  expect(result).toMatchObject({ result: { kind: "held" }, cancels: 0, rows: [{ receipt: null, attempts: [{ outcome: "pending", purpose: "deliver" }] }] });
});

test("native cancellation permission loss or owner ABA cannot release an uncertain original", async ({ page }) => {
  await open(page); await reserve(page, 10);
  const result = await page.evaluate(async () => {
    const f = window.unitReviewFixture, login = f.auth.signInMark();
    await f.storage.claimReviewAttempt(login, f.UNIT, f.id(10), 0, f.id(20), 0, () => true);
    const current = f.view(); if (current.availability !== "available") throw Error();
    current.review.basis!.scopeToken = `ur1:${"b".repeat(64)}`;
    const deps = { read: async () => current, receipt: async () => ({ protocolVersion: 1 as const, availability: "unavailable" as const, receipt: null }),
      wallNow: () => 2 * f.storage.REVIEW_LEASE_MS };
    const c = new f.UnitReviewCoordinator({ login, unitId: f.UNIT, contextKey: "permission-lost", admission: () => true }, {
      ...deps, cancel: async () => ({ kind: "attempt_refused", sqlState: "42501" }),
    });
    const refused = await c.cancelRetainedHead(); await c.refresh();
    const replacement = await c.reserve(f.id(11), { ...f.payload(), basis: current.review.basis! });
    const c2 = new f.UnitReviewCoordinator({ login, unitId: f.UNIT, contextKey: "owner-changes", admission: () => true }, {
      ...deps, cancel: async () => { f.auth.rememberSignedIn(null); f.auth.rememberSignedIn({ user: { id: f.OWNER } }); return { kind: "cancelled", receipt: f.cancellation(f.id(10)) }; },
    });
    const aba = await c2.cancelRetainedHead();
    const rows = await f.storage.readReviewJournal(f.auth.signInMark(), f.UNIT, () => true);
    return { refused, replacement, aba, state: f.storage.reviewDeliveryState(rows[0]), attempts: rows[0].attempts, receipt: rows[0].receipt };
  });
  expect(result).toMatchObject({ refused: { kind: "unknown" }, replacement: { kind: "held", reason: "original_hidden" }, aba: { kind: "held", reason: "context_changed" },
    state: "unknown", receipt: null, attempts: [{ outcome: "unknown" }, { outcome: "refused", sqlState: "42501" }, { outcome: "pending", purpose: "cancel" }] });
});

test("native legacy owner-key aliases are held instead of mistaken for an empty queue", async ({ page }) => {
  await open(page);
  const result = await page.evaluate(async () => {
    const f = window.unitReviewFixture, owner = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    f.auth.rememberSignedIn({ user: { id: owner } });
    await f.storage.reserveReviewOriginal(f.auth.signInMark(), f.storage.freezeReviewOriginal(f.id(10), f.payload()), null, () => true);
    const db = await new Promise<IDBDatabase>(resolve => { const r = indexedDB.open(f.storage.UNIT_REVIEW_DB); r.onsuccess = () => resolve(r.result); });
    const tx = db.transaction(["requests", "heads"], "readwrite", { durability: "strict" });
    const row = await new Promise<Record<string, unknown>>(resolve => { const r = tx.objectStore("requests").get(f.id(10)); r.onsuccess = () => resolve(r.result); });
    row.ownerId = owner.toUpperCase(); delete row.durability; tx.objectStore("requests").put(row);
    tx.objectStore("heads").delete(`${owner}:${f.UNIT}`);
    tx.objectStore("heads").put({ key: `${owner.toUpperCase()}:${f.UNIT}`, ownerId: owner.toUpperCase(), unitId: f.UNIT, commandId: f.id(10), sequence: 0 });
    await new Promise<void>(resolve => { tx.oncomplete = () => resolve(); }); db.close();
    let readBlocked = false, replacementBlocked = false;
    try { await f.storage.readReviewJournal(f.auth.signInMark(), f.UNIT, () => true); } catch { readBlocked = true; }
    try { await f.storage.reserveReviewOriginal(f.auth.signInMark(), f.storage.freezeReviewOriginal(f.id(11), f.payload()), null, () => true); } catch { replacementBlocked = true; }
    return { readBlocked, replacementBlocked };
  });
  expect(result).toEqual({ readBlocked: true, replacementBlocked: true });
});
