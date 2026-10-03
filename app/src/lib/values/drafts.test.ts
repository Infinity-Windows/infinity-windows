import { describe, expect, it } from "vitest";
import { allValuesScored, newValuesDraft } from "./drafts";
import { MemoryOutboxStore } from "../offline/outboxStore";
import { makeEntry, drainStore, type OutboxEntry } from "../offline/outbox-core";
import { VALUE_SLUGS } from "./rubric";

describe("values draft safety", () => {
  it("requires exactly eight valid integer scores", () => {
    const scores = Object.fromEntries(VALUE_SLUGS.map((slug) => [slug, 7]));
    expect(allValuesScored(scores)).toBe(true);
    expect(allValuesScored({ ...scores, extra: 7 })).toBe(false);
    expect(allValuesScored({ ...scores, safety: 7.5 })).toBe(false);
    expect(allValuesScored({ ...scores, safety: 11 })).toBe(false);
  });

  it("binds the same assignment to separate account drafts", () => {
    const a = newValuesDraft("owner-a", "assignment", 1);
    const b = newValuesDraft("owner-b", "assignment", 1);
    expect(a.id).not.toBe(b.id);
    expect(a.requestId).not.toBe(b.requestId);
  });

  it("keeps the exact queued write when the receipt cannot match its draft", async () => {
    const store = new MemoryOutboxStore();
    const draft = newValuesDraft("owner-a", "assignment", 1);
    await store.putValuesDraft(draft);
    const entry: OutboxEntry = makeEntry({ op: "values_submit", ownerId: "owner-b", payload: { assignmentId: "assignment", requestId: draft.requestId } }, draft.requestId, 1);
    await store.put(entry);
    expect(await store.acknowledgeValues(entry, { receipt: "accepted" })).toBe(false);
    expect((await store.getAll()).map((row) => row.id)).toEqual([entry.id]);
    expect((await store.getValuesDraft("owner-a", "assignment"))?.status).toBe("editing");
  });

  it("atomically records a matching receipt before removing the exact write", async () => {
    const store = new MemoryOutboxStore();
    const draft = newValuesDraft("owner-a", "assignment", 1);
    await store.putValuesDraft({ ...draft, status: "queued", digest: "digest-1" });
    const entry = makeEntry({ op: "values_submit", ownerId: draft.ownerId, payload: { assignmentId: draft.assignmentId, requestId: draft.requestId, rubricVersion: 1, digest: "digest-1" } }, draft.requestId, 1);
    await store.put(entry);
    const receipt = { receipt: { encodingVersion: "forge-values-submit/v1", assignmentId: draft.assignmentId, requestId: draft.requestId, rubricVersion: 1, digest: "digest-1" }, replay: true };
    const result = await drainStore(store, { values_submit: async () => receipt }, { now: 1 });
    expect(result.sent).toBe(1);
    expect(await store.getAll()).toEqual([]);
    expect((await store.getValuesDraft(draft.ownerId, draft.assignmentId))?.receipt).toEqual(receipt);
    expect((await store.getValuesDraft(draft.ownerId, draft.assignmentId))?.status).toBe("accepted");
  });

  it("refuses to clear a write when the saved draft digest differs", async () => {
    const store = new MemoryOutboxStore();
    const draft = newValuesDraft("owner-a", "assignment", 1);
    await store.putValuesDraft({ ...draft, status: "queued", digest: "original" });
    const entry = makeEntry({ op: "values_submit", ownerId: draft.ownerId, payload: { assignmentId: draft.assignmentId, requestId: draft.requestId, rubricVersion: 1, digest: "changed" } }, draft.requestId, 1);
    await store.put(entry);
    expect(await store.acknowledgeValues(entry, { receipt: true })).toBe(false);
    expect((await store.getAll()).map((row) => row.id)).toEqual([entry.id]);
  });

  it("retries the same request after a lost reply, then accepts its matching replay", async () => {
    const store = new MemoryOutboxStore();
    const draft = newValuesDraft("owner-a", "assignment", 1);
    await store.putValuesDraft({ ...draft, status: "queued", digest: "same-digest" });
    const entry = makeEntry({ op: "values_submit", ownerId: draft.ownerId, payload: { assignmentId: draft.assignmentId, requestId: draft.requestId, rubricVersion: 1, digest: "same-digest" } }, draft.requestId, 1);
    await store.put(entry);
    const requests: string[] = [];
    const receipt = { receipt: { encodingVersion: "forge-values-submit/v1", assignmentId: draft.assignmentId, requestId: draft.requestId, rubricVersion: 1, digest: "same-digest" }, replay: true };
    let lost = true;
    const handler = async (sent: OutboxEntry) => {
      requests.push(sent.payload.requestId as string);
      if (lost) { lost = false; throw new Error("connection lost after commit"); }
      return receipt;
    };
    await drainStore(store, { values_submit: handler }, { now: 1 });
    expect((await store.getAll())[0]?.id).toBe(draft.requestId);
    expect((await store.getValuesDraft(draft.ownerId, draft.assignmentId))?.status).toBe("queued");
    await drainStore(store, { values_submit: handler }, { now: 6000, forceDue: true });
    expect(requests).toEqual([draft.requestId, draft.requestId]);
    expect((await store.getValuesDraft(draft.ownerId, draft.assignmentId))?.status).toBe("accepted");
  });

  it("retains the queue when local receipt storage fails", async () => {
    class BrokenReceiptStore extends MemoryOutboxStore {
      override async acknowledgeValues(): Promise<boolean> { throw new Error("disk full"); }
    }
    const store = new BrokenReceiptStore();
    const draft = newValuesDraft("owner-a", "assignment", 1);
    await store.putValuesDraft({ ...draft, status: "queued", digest: "digest" });
    const entry = makeEntry({ op: "values_submit", ownerId: draft.ownerId, payload: { assignmentId: draft.assignmentId, requestId: draft.requestId, rubricVersion: 1, digest: "digest" } }, draft.requestId, 1);
    await store.put(entry);
    const result = await drainStore(store, { values_submit: async () => ({ receipt: true }) }, { now: 1 });
    expect(result.retried).toBe(1);
    expect((await store.getAll())[0]?.id).toBe(draft.requestId);
    expect((await store.getValuesDraft(draft.ownerId, draft.assignmentId))?.status).toBe("queued");
  });

  it("bounds a hung local receipt commit and sends the next photo", async () => {
    class HungReceiptStore extends MemoryOutboxStore {
      override async acknowledgeValues(): Promise<boolean> { return new Promise(() => undefined); }
    }
    const store = new HungReceiptStore();
    const draft = newValuesDraft("owner-a", "assignment", 1);
    await store.putValuesDraft({ ...draft, status: "queued", digest: "digest" });
    await store.put(makeEntry({ op: "values_submit", ownerId: draft.ownerId, payload: { assignmentId: draft.assignmentId, requestId: draft.requestId, rubricVersion: 1, digest: "digest" } }, draft.requestId, 1));
    await store.put(makeEntry({ op: "photo_upload", payload: { projectId: "job" } }, "photo-next", 2));
    let photoSent = false;
    const sent: string[] = [];
    const result = await drainStore(store, {
      values_submit: async () => ({ receipt: true }),
      photo_upload: async () => { photoSent = true; return null; },
    }, { now: 2, sendDeadlineMs: () => 10, onSent: (entry) => sent.push(entry.id) });
    expect(result.retried).toBe(1);
    expect(photoSent).toBe(true);
    expect(sent).toEqual(["photo-next"]);
    expect((await store.getAll()).map((row) => row.id)).toEqual([draft.requestId]);
  });

  it("a late commit after timeout cannot emit a sent event or overwrite a newer retry", async () => {
    let finish!: () => void;
    class DelayedReceiptStore extends MemoryOutboxStore {
      override async acknowledgeValues(entry: OutboxEntry, receipt: unknown, context?: { signal?: AbortSignal; canCommit?: () => boolean }): Promise<boolean> {
        await new Promise<void>((resolve) => { finish = resolve; });
        return super.acknowledgeValues(entry, receipt, context);
      }
    }
    const store = new DelayedReceiptStore();
    const draft = newValuesDraft("owner-a", "assignment", 1);
    await store.putValuesDraft({ ...draft, status: "queued", digest: "digest" });
    const entry = makeEntry({ op: "values_submit", ownerId: draft.ownerId, payload: { assignmentId: draft.assignmentId, requestId: draft.requestId, rubricVersion: 1, digest: "digest" } }, draft.requestId, 1);
    await store.put(entry);
    const receipt = { receipt: { encodingVersion: "forge-values-submit/v1", assignmentId: draft.assignmentId, requestId: draft.requestId, rubricVersion: 1, digest: "digest" }, replay: true };
    const sent: string[] = [];
    const result = await drainStore(store, { values_submit: async () => receipt }, { now: 1, sendDeadlineMs: () => 10, onSent: (row) => sent.push(row.id) });
    expect(result.retried).toBe(1);
    finish();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sent).toEqual([]);
    expect((await store.getAll())[0]?.id).toBe(entry.id); // timed-out attempt cannot clear the newer backoff state
  });

  it("holds a values receipt if the sign-in generation changed before acknowledgment", async () => {
    const store = new MemoryOutboxStore();
    const draft = newValuesDraft("owner-a", "assignment", 1);
    await store.putValuesDraft({ ...draft, status: "queued", digest: "digest" });
    const entry = makeEntry({ op: "values_submit", ownerId: draft.ownerId, payload: { assignmentId: draft.assignmentId, requestId: draft.requestId, rubricVersion: 1, digest: "digest" } }, draft.requestId, 1);
    await store.put(entry);
    let current = true;
    const result = await drainStore(store, { values_submit: async () => { current = false; return { receipt: true }; } }, {
      now: 1, beginValuesAttempt: () => () => current,
    });
    expect(result.sent).toBe(0);
    expect((await store.getAll())[0]?.id).toBe(entry.id);
    expect((await store.getValuesDraft(draft.ownerId, draft.assignmentId))?.status).toBe("queued");
  });

  it("account A to B to A during a delayed commit keeps A's queue and sends no false acknowledgment", async () => {
    let finish!: () => void;
    class DelayedReceiptStore extends MemoryOutboxStore {
      override async acknowledgeValues(entry: OutboxEntry, receipt: unknown, context?: { signal?: AbortSignal; canCommit?: () => boolean }): Promise<boolean> {
        await new Promise<void>((resolve) => { finish = resolve; });
        return super.acknowledgeValues(entry, receipt, context);
      }
    }
    const store = new DelayedReceiptStore();
    const draft = newValuesDraft("owner-a", "assignment", 1);
    await store.putValuesDraft({ ...draft, status: "queued", digest: "digest" });
    const entry = makeEntry({ op: "values_submit", ownerId: draft.ownerId, payload: { assignmentId: draft.assignmentId, requestId: draft.requestId, rubricVersion: 1, digest: "digest" } }, draft.requestId, 1);
    await store.put(entry);
    let generation = 1;
    const captured = generation;
    const receipt = { receipt: { encodingVersion: "forge-values-submit/v1", assignmentId: draft.assignmentId, requestId: draft.requestId, rubricVersion: 1, digest: "digest" }, replay: false };
    const sent: string[] = [];
    const running = drainStore(store, { values_submit: async () => receipt }, {
      now: 1, beginValuesAttempt: () => () => generation === captured, onSent: (row) => sent.push(row.id),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    generation = 2; // B signs in
    generation = 3; // then A signs in again: same id, different generation
    finish();
    await running;
    expect(sent).toEqual([]);
    expect((await store.getAll())[0]?.id).toBe(entry.id);
    expect((await store.getValuesDraft(draft.ownerId, draft.assignmentId))?.status).toBe("queued");
  });

  it("a clock arriving during a stalled receipt goes before the following photo", async () => {
    class HungReceiptStore extends MemoryOutboxStore {
      override async acknowledgeValues(): Promise<boolean> { return new Promise(() => undefined); }
    }
    const store = new HungReceiptStore();
    const draft = newValuesDraft("owner-a", "assignment", 1);
    await store.putValuesDraft({ ...draft, status: "queued", digest: "digest" });
    await store.put(makeEntry({ op: "values_submit", ownerId: draft.ownerId, payload: { assignmentId: draft.assignmentId, requestId: draft.requestId, rubricVersion: 1, digest: "digest" } }, draft.requestId, 1));
    await store.put(makeEntry({ op: "photo_upload", payload: { projectId: "job" } }, "photo", 2));
    const order: string[] = [];
    await drainStore(store, {
      values_submit: async () => {
        await store.put(makeEntry({ op: "clock_in", payload: { projectId: "job" } }, "clock", 3));
        return { receipt: true };
      },
      clock_in: async () => { order.push("clock"); return null; },
      photo_upload: async () => { order.push("photo"); return null; },
    }, { now: 3, sendDeadlineMs: () => 10 });
    expect(order).toEqual(["clock", "photo"]);
    expect((await store.getAll()).map((row) => row.id)).toEqual([draft.requestId]);
  });
});
