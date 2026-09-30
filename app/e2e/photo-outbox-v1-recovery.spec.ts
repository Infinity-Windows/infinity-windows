import { expect, test } from "@playwright/test";

test("a v1 queued photo survives upgrade and metadata-only retries", async ({ page }) => {
  await page.route("**/photo-outbox-test", (route) => route.fulfill({ contentType: "text/html", body: "<html></html>" }));
  await page.goto("/photo-outbox-test");

  const result = await page.evaluate(async () => {
    const name = "wops-write-outbox";
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
    const legacy = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore("entries", { keyPath: "id" });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const original = {
      id: "saved-iphone-photo", op: "photo_upload", payload: {
        bucket: "install-media", path: "job/feed/saved-iphone-photo.jpg", createdBy: "crew@example.com",
      }, createdAt: 1, attemptCount: 0, lastError: null, status: "queued",
      nextAttemptAt: 0, hasBlob: true, ownerId: "crew-id",
    };
    const bytes = new Uint8Array([17, 29, 41, 53, 67]);
    await new Promise<void>((resolve, reject) => {
      const tx = legacy.transaction("entries", "readwrite");
      tx.objectStore("entries").add({ id: original.id, meta: JSON.stringify({ v: 1, ...original }), blob: new Blob([bytes], { type: "image/jpeg" }) });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    legacy.close();

    // @ts-ignore Vite serves this module path to the browser test.
    const { IndexedDbOutboxStore } = await import("/src/lib/offline/outboxStore.ts");
    // Reproduce the iPhone failure mode: an existing blob-bearing entry must
    // never be rewritten simply to update its queue status or retry time.
    const originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === "entries") throw new Error("blob-bearing row rewrite blocked");
      return originalPut.apply(this, args);
    };
    const store = new IndexedDbOutboxStore();
    const before = (await store.getAll())[0];
    const marked = await store.swap(before.id, before, { ...before, status: "sending" });
    const afterMark = (await store.getAll())[0];
    const failed = await store.swap(before.id, afterMark, { ...afterMark, status: "failed", attemptCount: 1, lastError: "temporary" });
    const afterFailure = (await store.getAll())[0];
    await store.put({ ...afterFailure, status: "queued", nextAttemptAt: 0 });
    const retry = (await store.getAll())[0];
    const duplicate = await store.insertIfAbsent(original as typeof retry, new Blob(["wrong bytes"]));
    await store.put({ ...retry, lastError: "null keeps the photo" }, null);
    const afterNull = (await store.getAll())[0];
    const afterNullBlob = await store.getBlob(before.id);
    const staleSwap = await store.swap(before.id, before, { ...before, attemptCount: 99 });
    const savedBlob = await store.getBlob(before.id);

    const upgraded = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const originalRow = await new Promise<{ meta: string; blob: Blob }>((resolve, reject) => {
      const request = upgraded.transaction("entries").objectStore("entries").get(original.id);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const version = upgraded.version;
    upgraded.close();
    const originalBytes = Array.from(new Uint8Array(await originalRow.blob.arrayBuffer()));
    const retrievedBytes = Array.from(new Uint8Array(await savedBlob!.arrayBuffer()));
    const stillOriginalMeta = JSON.parse(originalRow.meta).attemptCount === 0;
    const deleted = await store.swap(afterNull.id, afterNull, null);
    IDBObjectStore.prototype.put = originalPut;
    const afterDelete = await new Promise<{ entries: number; metadata: number }>((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onsuccess = async () => {
        const db = request.result;
        const tx = db.transaction(["entries", "metadata"]);
        const entriesRequest = tx.objectStore("entries").count();
        const metadataRequest = tx.objectStore("metadata").count();
        tx.oncomplete = () => { resolve({ entries: entriesRequest.result, metadata: metadataRequest.result }); db.close(); };
        tx.onerror = () => reject(tx.error);
      };
      request.onerror = () => reject(request.error);
    });
    return {
      version, marked, failed, staleSwap, deleted, stillOriginalMeta,
      originalBytes, retrievedBytes, blobType: savedBlob?.type,
      retryAttempts: retry.attemptCount, retryOwner: retry.ownerId,
      retryPath: retry.payload.path, duplicateAttempts: duplicate?.attemptCount,
      nullPreservedBlob: (await afterNullBlob?.arrayBuffer())?.byteLength,
      remaining: await store.count(), afterDelete,
    };
  });

  expect(result).toEqual({
    version: 2, marked: true, failed: true, staleSwap: false, deleted: true,
    stillOriginalMeta: true, originalBytes: [17, 29, 41, 53, 67],
    retrievedBytes: [17, 29, 41, 53, 67], blobType: "image/jpeg",
    retryAttempts: 1, retryOwner: "crew-id", retryPath: "job/feed/saved-iphone-photo.jpg",
    duplicateAttempts: 1, nullPreservedBlob: 5, remaining: 0,
    afterDelete: { entries: 0, metadata: 0 },
  });
});
