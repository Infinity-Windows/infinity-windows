// A photo handed to the queue under an id its caller minted (the Forge AI daily
// log does this, because its Save can be retried after a lost response) is the
// same entry however many times it is handed over — and ONLY if it is the same
// photo: same account, same job, same stored file. That id is what the upload
// writes as attachments.client_id.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryOutboxStore } from "./outboxStore";

const store = new MemoryOutboxStore();
vi.mock("./outboxStore", async (original) => ({
  ...(await original<typeof import("./outboxStore")>()),
  createDefaultStore: () => store,
}));
vi.mock("./outboxHandlers", () => ({
  createShiftResolver: () => ({ record: () => {}, resolve: () => null }),
  createSupabaseHandlers: () => ({}),
  pendingShiftRef: (id: string) => `pending:${id}`,
}));

const { enqueueUpload, StableIdConflictError } = await import("./outbox");
const { UnreadableOutboxEntryError } = await import("./outboxStore");
const ID = "11111111-2222-4333-8444-555555555555";
const input = (over: Record<string, unknown> = {}) => ({
  kind: "photo" as const, path: `job/feed/ai-daily-log-${ID}.jpg`, contentType: "image/jpeg",
  projectId: "job", createdBy: "ana@example.test", caption: "first", blob: new Blob(["jpeg"], { type: "image/jpeg" }), clientId: ID,
  ...over,
});

beforeEach(async () => { for (const e of await store.getAll()) await store.delete(e.id); });

describe("enqueueUpload with a caller's stable id", () => {
  it("queues once under that id; the same photo handed over again leaves the first untouched", async () => {
    expect(await enqueueUpload(input())).toBe(ID);
    expect(await enqueueUpload(input({ caption: "second", createdBy: "ANA@example.test" }))).toBe(ID);
    const all = await store.getAll();
    expect(all).toHaveLength(1);
    expect(all[0].payload.caption).toBe("first");
  });

  it("refuses the id for another account, another job or another stored file", async () => {
    await enqueueUpload(input());
    for (const over of [{ createdBy: "ben@example.test" }, { projectId: "other-job" }, { path: "other-job/feed/x.jpg" }]) {
      await expect(enqueueUpload(input(over))).rejects.toBeInstanceOf(StableIdConflictError);
    }
    const [entry] = await store.getAll();
    expect(entry.payload).toMatchObject({ createdBy: "ana@example.test", projectId: "job" });
  });

  it("two hand-offs at the same moment make one entry, and neither overwrites it", async () => {
    const results = await Promise.allSettled([
      enqueueUpload(input({ caption: "a" })),
      enqueueUpload(input({ caption: "b" })),
      enqueueUpload(input({ createdBy: "ben@example.test", caption: "c" })),
    ]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled", "rejected"]);
    const all = await store.getAll();
    expect(all).toHaveLength(1);
    expect(all[0].payload.caption).toBe("a");
  });

  it("an entry that is uploading right now is not replaced by a later hand-off", async () => {
    // Offline, so no drain touches the entry while this looks at it.
    Object.defineProperty(globalThis.navigator, "onLine", { value: false, configurable: true });
    await enqueueUpload(input());
    const [entry] = await store.getAll();
    // Mid-upload: the drainer has already made an attempt on it. (Reading an
    // entry back reports "sending" as "queued" by design, so the attempt count
    // and payload are what show it was not replaced.)
    await store.put({ ...entry, status: "sending", attemptCount: 1, lastError: "in flight" });
    await enqueueUpload(input({ caption: "later" }));
    const [after] = await store.getAll();
    expect(after.attemptCount).toBe(1);
    expect(after.lastError).toBe("in flight");
    expect(after.payload.caption).toBe("first");
    Object.defineProperty(globalThis.navigator, "onLine", { value: true, configurable: true });
  });

  it("an unreadable row already under the id is an error, not \"queued\" — and it is left as it was", async () => {
    // A row that deserialises to nothing (damaged storage, an older build).
    const rows = (store as unknown as { entries: Map<string, string> }).entries;
    rows.set(ID, "{not json");
    await expect(enqueueUpload(input())).rejects.toBeInstanceOf(UnreadableOutboxEntryError);
    expect(rows.get(ID)).toBe("{not json");
    rows.delete(ID);
  });

  it("without one, every photo still gets its own id (existing callers unchanged)", async () => {
    const { clientId: _omit, ...rest } = input();
    void _omit;
    const a = await enqueueUpload(rest);
    const b = await enqueueUpload(rest);
    expect(a).not.toBe(b);
    expect(await store.getAll()).toHaveLength(2);
  });
});
