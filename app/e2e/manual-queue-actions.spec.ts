import { expect, test } from "@playwright/test";
import { useSupabaseFixtures } from "./support/supabaseFixtures";

test("manual queue transactions preserve originals and reject stale or foreign actions", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "installer" });
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const load = (path: string) => import(/* @vite-ignore */ path);
    const auth = await load("/src/lib/signedIn.ts");
    const runtime = await load("/src/lib/offline/queueRuntime.ts");
    const installs = await load("/src/lib/install/installOutbox.ts");
    const { IndexedDbOutboxStore } = await load("/src/lib/offline/outboxStore.ts");
    runtime.queueCoordinator.stop(); await runtime.queueCoordinator.idle();
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    const login = (id: string) => auth.rememberSignedIn({ user: { id, email: `${id}@example.test` } });
    login("owner");
    const store = new IndexedDbOutboxStore();
    const entry = { id: "manual-fixture", op: "daily_log", ownerId: "owner", payload: {}, createdAt: 1, attemptCount: 8, lastError: "fixture", status: "failed", nextAttemptAt: 0, dependsOn: null, hasBlob: true };
    await store.put(entry, new Blob(["general original"]));
    // The identity guard is evaluated in the real IndexedDB write callback.
    const mark = auth.signInMark();
    const stale = store.swap(entry.id, entry, null, () => auth.stillSignedInAs(mark, "owner"));
    login("other");
    const staleChanged = await stale;
    const original = await (await store.getBlob(entry.id)).text();
    await store.swap(entry.id, entry, { ...entry, status: "queued" });
    const obsoleteChanged = await store.swap(entry.id, entry, null);

    const open = indexedDB.open("wops-install-outbox", 1);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      open.onupgradeneeded = () => open.result.createObjectStore("installs", { keyPath: "id" });
      open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error);
    });
    const record = { id: "install-fixture", step: "rpc_done", installEventId: "filed", attemptCount: 8, status: "failed", payload: { ownerId: "owner", clientKey: "stable", openingId: "opening", projectId: "project", openingCode: "W1", submitParams: {}, media: [], points: null } };
    const tx = db.transaction("installs", "readwrite");
    tx.objectStore("installs").put({ id: record.id, meta: installs.serializeInstallOutbox(record), blobs: [new Blob(["install original"])] });
    await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
    let foreignRejected = false;
    try { await installs.discardFailedInstall(record.id); } catch { foreignRejected = true; }
    login("owner");
    // Competing retries: only the first may transition failed -> pending.
    const retries = await Promise.allSettled([installs.retryFailedInstall(record.id), installs.retryFailedInstall(record.id)]);
    let pendingRejected = false;
    try { await installs.discardFailedInstall(record.id); } catch { pendingRejected = true; }
    const read = db.transaction("installs").objectStore("installs").get(record.id);
    const row = await new Promise<{ meta: string; blobs: Blob[] }>((resolve, reject) => { read.onsuccess = () => resolve(read.result); read.onerror = () => reject(read.error); });
    db.close();
    return { staleChanged, obsoleteChanged, original, foreignRejected, pendingRejected,
      retries: retries.map(r => r.status), saved: JSON.parse(row.meta), media: await row.blobs[0].text() };
  });
  expect(result).toMatchObject({ staleChanged: false, obsoleteChanged: false, original: "general original", foreignRejected: true, pendingRejected: true, media: "install original", saved: { step: "rpc_done", installEventId: "filed", status: "pending", attemptCount: 0, payload: { ownerId: "owner", clientKey: "stable" } } });
  expect(result.retries.sort()).toEqual(["fulfilled", "rejected"]);
});
