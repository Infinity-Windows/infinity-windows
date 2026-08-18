import { describe, expect, it } from "vitest";
import {
  ALL_OPS,
  applyFailure,
  cascadeFailure,
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
  OPS,
  pillSummary,
  requeueStranded,
  retryEntry,
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

describe("every op survives the disk round-trip", () => {
  // The bug this exists to prevent, found live in ticket 10: an op added to
  // OutboxOp but not to the OPS allowlist serializes fine, lands in
  // IndexedDB, and deserializes to null forever — the drainer never sees it
  // and the write is silently lost, with no error anywhere.
  it("deserializes back to itself for every op the queue can carry", () => {
    for (const op of ALL_OPS) {
      const entry = makeEntry({ op, payload: { a: 1 } }, `id-${op}`, 1000);
      const back = deserializeEntry(serializeEntry(entry));
      expect(back, `${op} does not survive serialize -> deserialize`).not.toBeNull();
      expect(back!.op).toBe(op);
    }
  });

  it("the allowlist and the op list are the same set", () => {
    expect([...OPS].sort()).toEqual([...ALL_OPS].sort());
  });

  it("every op lands in exactly one count bucket", () => {
    for (const op of ALL_OPS) {
      const c = countsByOp([makeEntry({ op, payload: {} }, `id-${op}`, 0)]);
      expect(totalPending(c), `${op} is counted in no bucket`).toBe(1);
    }
  });
});

describe("a permanent failure travels to everything it strands", () => {
  // The bug: a clock-out waits on its clock-in, and dueEntries asks "is the
  // dependency still in the queue" — a PERMANENTLY FAILED clock-in still is.
  // So the clock-out waited forever: never attempted, never counted, never
  // shown, with no screen to clear it. A lost punch is a payroll dispute.
  const at = (id: string, createdAt: number, dependsOn?: string): OutboxEntry => ({
    ...makeEntry({ op: "clock_out", payload: {}, dependsOn: dependsOn ?? null }, id, createdAt),
  });

  it("fails the entry waiting on a dead one", () => {
    const clockIn = { ...at("in", 1), status: "failed" as const };
    const clockOut = at("out", 2, "in");
    const out = cascadeFailure([clockIn, clockOut], "in");
    expect(out.map((e) => e.id)).toEqual(["out"]);
    expect(out[0].status).toBe("failed");
    expect(out[0].lastError).toContain("could never be sent");
  });

  it("travels down a whole chain, not just one link", () => {
    const a = { ...at("a", 1), status: "failed" as const };
    const b = at("b", 2, "a");
    const c = at("c", 3, "b");
    expect(cascadeFailure([a, b, c], "a").map((e) => e.id)).toEqual(["b", "c"]);
  });

  it("leaves unrelated work alone", () => {
    const a = { ...at("a", 1), status: "failed" as const };
    const b = at("b", 2, "a");
    const unrelated = at("solo", 3);
    expect(cascadeFailure([a, b, unrelated], "a").map((e) => e.id)).toEqual(["b"]);
  });

  it("keeps an existing error rather than overwriting why it really died", () => {
    const a = { ...at("a", 1), status: "failed" as const };
    const b = { ...at("b", 2, "a"), lastError: "server said no" };
    expect(cascadeFailure([a, b], "a")[0].lastError).toBe("server said no");
  });

  it("does nothing when nothing was waiting", () => {
    expect(cascadeFailure([{ ...at("a", 1), status: "failed" as const }], "a")).toEqual([]);
  });
});

describe("retrying a dead-lettered entry", () => {
  it("gives it a clean run rather than dying on the next attempt", () => {
    const dead: OutboxEntry = {
      ...makeEntry({ op: "clock_in", payload: {} }, "x", 1),
      status: "failed",
      attemptCount: MAX_ATTEMPTS,
      lastError: "token expired",
      nextAttemptAt: 99999,
    };
    const again = retryEntry(dead, 500);
    expect(again.status).toBe("queued");
    expect(again.attemptCount).toBe(0);
    expect(again.lastError).toBeNull();
    expect(again.nextAttemptAt).toBe(500);
  });
});
