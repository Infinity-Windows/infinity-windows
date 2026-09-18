import { describe, expect, it } from "vitest";
import { drainStore, makeEntry, type OutboxEntry } from "./outbox-core";
import { MemoryOutboxStore } from "./outboxStore";
import { PhotoUploadReceipts } from "./photoUploadProgress";

const email = "installer@example.test";
const photo = (id: string): OutboxEntry => makeEntry({
  op: "photo_upload", payload: { createdBy: email, projectId: "job" }, hasBlob: true,
}, id, 0);

describe("photo confirmation comes from the successful write, not an empty queue", () => {
  it("separates uploaded, failed and discarded photos in the same batch", async () => {
    const store = new MemoryOutboxStore();
    const receipts = new PhotoUploadReceipts();
    const ids = ["one", "two", "three"];
    for (const id of ids) await store.put(photo(id));
    expect(receipts.summarize(ids, await store.getAll(), email)).toEqual({ uploaded: 0, pending: 3, failed: 0, unconfirmed: 0 });
    await drainStore(store, { photo_upload: async entry => {
      if (entry.id === "three") throw { code: "42501", message: "Permission denied" };
    } }, { now: 0, onSent: entry => receipts.record(entry) });
    expect(receipts.summarize(ids, await store.getAll(), email)).toEqual({ uploaded: 2, pending: 0, failed: 1, unconfirmed: 0 });
    await store.delete("three");
    expect(receipts.summarize(ids, await store.getAll(), email)).toEqual({ uploaded: 2, pending: 0, failed: 0, unconfirmed: 1 });
  });

  it("remembers a fast upload that completed before the capture UI registered its id", async () => {
    const store = new MemoryOutboxStore();
    const receipts = new PhotoUploadReceipts();
    await store.put(photo("fast"));
    await drainStore(store, { photo_upload: async () => {} }, { now: 0, onSent: entry => receipts.record(entry) });
    expect(receipts.summarize(["fast"], [], email.toUpperCase()).uploaded).toBe(1);
    expect(receipts.summarize(["fast"], [], "someone-else@example.test").uploaded).toBe(0);
    expect(receipts.summarize(["missing"], [], email).unconfirmed).toBe(1);
  });

  it("an observer failure cannot retry a successful clock or leave a false failure", async () => {
    const store = new MemoryOutboxStore();
    await store.put(makeEntry({ op: "clock_in", payload: {} }, "clock", 0));
    const result = await drainStore(store, { clock_in: async () => {} }, {
      now: 0, onSent: () => { throw new Error("UI observer failed"); },
    });
    expect(result).toMatchObject({ sent: 1, retried: 0, deadLettered: 0, remaining: 0 });
  });
});
