import { describe, expect, it } from "vitest";
import {
  applyFailure,
  BACKOFF_BASE_MS,
  BACKOFF_CAP_MS,
  computeBackoffMs,
  countsByOp,
  dedupe,
  deserializeEntry,
  drainStore,
  dueEntries,
  isDeadLetter,
  isNetworkError,
  isRetryableError,
  makeEntry,
  markSending,
  MAX_ATTEMPTS,
  pillSummary,
  requeueStranded,
  serializeEntry,
  totalPending,
  type OpHandlers,
  type OutboxEntry,
  type OutboxInput,
} from "./outbox-core";
import { MemoryOutboxStore } from "./outboxStore";

const T0 = 1_000_000;

function entry(over: Partial<OutboxEntry> = {}): OutboxEntry {
  return {
    id: over.id ?? "id-1",
    op: over.op ?? "clock_in",
    payload: over.payload ?? { projectId: "p1" },
    createdAt: over.createdAt ?? T0,
    attemptCount: over.attemptCount ?? 0,
    lastError: over.lastError ?? null,
    status: over.status ?? "queued",
    nextAttemptAt: over.nextAttemptAt ?? T0,
    dependsOn: over.dependsOn ?? null,
    hasBlob: over.hasBlob ?? false,
  };
}

describe("makeEntry", () => {
  it("creates a queued entry using the client id as the idempotency key", () => {
    const input: OutboxInput = { op: "clock_in", payload: { projectId: "p1" } };
    const e = makeEntry(input, "client-123", T0);
    expect(e.id).toBe("client-123");
    expect(e.status).toBe("queued");
    expect(e.attemptCount).toBe(0);
    expect(e.createdAt).toBe(T0);
    expect(e.nextAttemptAt).toBe(T0);
  });
});

describe("serialize / deserialize (persistence round-trip)", () => {
  it("round-trips an entry", () => {
    const e = entry({ op: "photo_upload", hasBlob: true, dependsOn: "dep-1" });
    expect(deserializeEntry(serializeEntry(e))).toEqual(e);
  });

  it("rejects corrupt JSON and unknown ops", () => {
    expect(deserializeEntry("not json")).toBeNull();
    expect(
      deserializeEntry(JSON.stringify({ id: "x", op: "nope", payload: {} })),
    ).toBeNull();
  });

  it("recovers a mid-flight 'sending' entry as queued (crash-safe replay)", () => {
    const e = entry({ status: "sending" });
    const back = deserializeEntry(serializeEntry(e));
    expect(back?.status).toBe("queued");
  });
});

describe("computeBackoffMs (exponential backoff schedule)", () => {
  it("doubles each attempt and caps", () => {
    expect(computeBackoffMs(0)).toBe(BACKOFF_BASE_MS);
    expect(computeBackoffMs(1)).toBe(BACKOFF_BASE_MS * 2);
    expect(computeBackoffMs(2)).toBe(BACKOFF_BASE_MS * 4);
    expect(computeBackoffMs(50)).toBe(BACKOFF_CAP_MS);
  });
});

describe("error classification", () => {
  it("treats network/unknown errors as retryable", () => {
    expect(isRetryableError(new Error("Failed to fetch"))).toBe(true);
    expect(isRetryableError(new Error("something odd"))).toBe(true);
  });

  it("treats validation/permission/duplicate errors as permanent", () => {
    expect(isRetryableError(new Error("duplicate key value"))).toBe(false);
    expect(isRetryableError(new Error("permission denied"))).toBe(false);
    expect(isRetryableError({ permanent: true })).toBe(false);
  });

  it("treats a fetch TypeError and network messages as a network error", () => {
    expect(isNetworkError(new TypeError("Failed to fetch"))).toBe(true);
    expect(isNetworkError(new Error("NetworkError when attempting to fetch"))).toBe(true);
    expect(isNetworkError(new Error("duplicate key value"))).toBe(false);
  });
});

describe("applyFailure (retry with backoff → dead-letter)", () => {
  it("re-queues with backoff on a retryable failure", () => {
    const next = applyFailure(entry({ attemptCount: 0 }), new Error("Failed to fetch"), T0);
    expect(next.status).toBe("queued");
    expect(next.attemptCount).toBe(1);
    expect(next.lastError).toContain("Failed to fetch");
    expect(next.nextAttemptAt).toBe(T0 + computeBackoffMs(1));
  });

  it("dead-letters after max attempts", () => {
    const next = applyFailure(
      entry({ attemptCount: MAX_ATTEMPTS - 1 }),
      new Error("Failed to fetch"),
      T0,
    );
    expect(next.status).toBe("failed");
    expect(isDeadLetter(next)).toBe(true);
  });

  it("dead-letters immediately on a permanent error", () => {
    const next = applyFailure(entry(), new Error("duplicate key value"), T0);
    expect(next.status).toBe("failed");
    expect(next.attemptCount).toBe(1);
  });
});

describe("dedupe by client id", () => {
  it("keeps the first occurrence (FIFO)", () => {
    const list = [
      entry({ id: "a", createdAt: 1 }),
      entry({ id: "a", createdAt: 2 }),
      entry({ id: "b", createdAt: 3 }),
    ];
    expect(dedupe(list).map((e) => e.id)).toEqual(["a", "b"]);
  });
});

describe("dueEntries (FIFO drain ordering + backoff + dependencies)", () => {
  it("returns only queued, past-backoff entries in createdAt order", () => {
    const list = [
      entry({ id: "c", createdAt: 30 }),
      entry({ id: "a", createdAt: 10 }),
      entry({ id: "b", createdAt: 20, nextAttemptAt: T0 + 999 }), // not due yet
      entry({ id: "d", createdAt: 40, status: "failed" }), // dead-letter
    ];
    expect(dueEntries(list, T0).map((e) => e.id)).toEqual(["a", "c"]);
  });

  it("holds an entry behind an unresolved dependency, releasing it once the dependency leaves the queue", () => {
    const withDep = [
      entry({ id: "clockin", createdAt: 10 }),
      entry({ id: "clockout", createdAt: 20, op: "clock_out", dependsOn: "clockin" }),
    ];
    expect(dueEntries(withDep, T0).map((e) => e.id)).toEqual(["clockin"]);

    // clock-in has synced and been removed → clock-out becomes due.
    const afterSync = [entry({ id: "clockout", createdAt: 20, op: "clock_out", dependsOn: "clockin" })];
    expect(dueEntries(afterSync, T0).map((e) => e.id)).toEqual(["clockout"]);
  });
});

describe("requeueStranded", () => {
  it("flips a 'sending' entry back to queued", () => {
    expect(requeueStranded(entry({ status: "sending" }), T0).status).toBe("queued");
    const q = entry({ status: "queued" });
    expect(requeueStranded(q, T0)).toBe(q);
  });
});

describe("countsByOp + pillSummary (p1-12 status pill)", () => {
  it("rolls ops into categories and a dead-letter bucket", () => {
    const c = countsByOp([
      entry({ id: "1", op: "clock_in" }),
      entry({ id: "2", op: "photo_upload" }),
      entry({ id: "3", op: "photo_upload" }),
      entry({ id: "4", op: "receipt_upload" }),
      entry({ id: "5", op: "daily_log" }),
      entry({ id: "6", op: "clock_out", status: "failed" }),
    ]);
    expect(c.clock).toBe(1);
    expect(c.photos).toBe(2);
    expect(c.receipts).toBe(1);
    expect(c.logs).toBe(1);
    expect(c.deadLetter).toBe(1);
    expect(totalPending(c)).toBe(5);
  });

  it("shows a calm all-synced resting state", () => {
    const s = pillSummary(countsByOp([]));
    expect(s.tone).toBe("synced");
    expect(s.label).toBe("All synced");
  });

  it("summarizes pending work as text", () => {
    const s = pillSummary(
      countsByOp([
        entry({ id: "1", op: "clock_in" }),
        entry({ id: "2", op: "photo_upload" }),
        entry({ id: "3", op: "photo_upload" }),
        entry({ id: "4", op: "photo_upload" }),
        entry({ id: "5", op: "daily_log" }),
        entry({ id: "6", op: "daily_log" }),
      ]),
    );
    expect(s.tone).toBe("syncing");
    expect(s.label).toBe("Clock 1 · Photos 3 · 2 logs queued");
  });

  it("prioritizes 'needs attention' when items dead-letter", () => {
    const s = pillSummary(countsByOp([entry({ id: "1", op: "clock_in", status: "failed" })]));
    expect(s.tone).toBe("attention");
    expect(s.label).toContain("Needs attention");
  });
});

// --- drainStore integration over an in-memory store + fake handlers ------

function recordingHandlers(order: string[], fail?: (id: string) => unknown): OpHandlers {
  const h = async (e: OutboxEntry) => {
    const err = fail?.(e.id);
    if (err) throw err;
    order.push(e.id);
  };
  return {
    clock_in: h,
    clock_out: h,
    break_start: h,
    break_stop: h,
    photo_upload: h,
    receipt_upload: h,
    daily_log: h,
  };
}

describe("drainStore", () => {
  it("enqueues + persists, then sends FIFO and deletes on success", async () => {
    const store = new MemoryOutboxStore();
    await store.put(entry({ id: "b", createdAt: 20 }));
    await store.put(entry({ id: "a", createdAt: 10 }));
    await store.put(entry({ id: "c", createdAt: 30 }));

    const order: string[] = [];
    const res = await drainStore(store, recordingHandlers(order), { now: T0 });

    expect(order).toEqual(["a", "b", "c"]); // FIFO by createdAt
    expect(res.sent).toBe(3);
    expect(res.remaining).toBe(0);
    expect(await store.count()).toBe(0);
  });

  it("is idempotent: the same client id persisted twice sends once", async () => {
    const store = new MemoryOutboxStore();
    await store.put(entry({ id: "dupe", createdAt: 10 }));
    await store.put(entry({ id: "dupe", createdAt: 10 })); // replace, not add
    expect(await store.count()).toBe(1);

    const order: string[] = [];
    await drainStore(store, recordingHandlers(order), { now: T0 });
    expect(order).toEqual(["dupe"]);
  });

  it("retries with backoff on network failure (entry survives, not sent)", async () => {
    const store = new MemoryOutboxStore();
    await store.put(entry({ id: "a", createdAt: 10 }));

    const res = await drainStore(
      store,
      recordingHandlers([], () => new Error("Failed to fetch")),
      { now: T0 },
    );
    expect(res.sent).toBe(0);
    expect(res.retried).toBe(1);

    const [after] = await store.getAll();
    expect(after.status).toBe("queued");
    expect(after.attemptCount).toBe(1);
    expect(after.nextAttemptAt).toBeGreaterThan(T0); // backed off
  });

  it("keeps a failed optimistic write as a dead-letter for rollback (never silently dropped)", async () => {
    const store = new MemoryOutboxStore();
    await store.put(entry({ id: "a", createdAt: 10 }));

    const res = await drainStore(
      store,
      recordingHandlers([], () => new Error("duplicate key value")), // permanent
      { now: T0 },
    );
    expect(res.sent).toBe(0);
    expect(res.deadLettered).toBe(1);

    const [after] = await store.getAll();
    expect(after.status).toBe("failed"); // surfaced as "needs attention"
    expect(await store.count()).toBe(1); // retained, not lost
  });

  it("replays a persisted queue on startup (simulated reboot)", async () => {
    // Simulate a queue that was persisted before a reboot.
    const persisted = new MemoryOutboxStore();
    await persisted.put(entry({ id: "x", createdAt: 10 }));
    await persisted.put(entry({ id: "y", createdAt: 20 }));

    // "Reboot": a fresh drain over the same durable store sends everything.
    const order: string[] = [];
    const res = await drainStore(persisted, recordingHandlers(order), { now: T0 });
    expect(order).toEqual(["x", "y"]);
    expect(res.remaining).toBe(0);
  });

  it("dead-letters an op with no registered handler instead of looping", async () => {
    const store = new MemoryOutboxStore();
    await store.put(entry({ id: "a", op: "daily_log", createdAt: 10 }));
    const res = await drainStore(store, { clock_in: async () => {} }, { now: T0 });
    expect(res.deadLettered).toBe(1);
    const [after] = await store.getAll();
    expect(after.status).toBe("failed");
  });

  it("persists a 'sending' marker before attempting an entry", async () => {
    const store = new MemoryOutboxStore();
    await store.put(entry({ id: "a", createdAt: 10 }));
    const persistedStatuses: string[] = [];
    const origPut = store.put.bind(store);
    store.put = async (e, b) => {
      persistedStatuses.push(e.status);
      return origPut(e, b);
    };
    await drainStore(
      store,
      { clock_in: async () => void 0 },
      { now: T0 },
    );
    // sending is written before the successful send deletes the entry.
    expect(persistedStatuses).toContain("sending");
  });
});

describe("markSending", () => {
  it("sets status to sending", () => {
    expect(markSending(entry()).status).toBe("sending");
  });
});

describe("MemoryOutboxStore blob handling", () => {
  it("stores and retrieves a blob beside an entry", async () => {
    const store = new MemoryOutboxStore();
    const blob = new Blob(["hello"], { type: "text/plain" });
    await store.put(entry({ id: "a", hasBlob: true }), blob);
    const got = await store.getBlob("a");
    expect(got).not.toBeNull();
    await store.delete("a");
    expect(await store.getBlob("a")).toBeNull();
  });
});
