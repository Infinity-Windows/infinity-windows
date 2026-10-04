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
