// A send that never finishes must not hold the whole queue (2026-09-25).
//
// The owner's own drill, 2026-09-24: airplane mode, a clock-in and five photos
// through Capture, then back on Wi-Fi. Thirteen minutes later the pill still
// said "Photos 5", Stuck writes said "Nothing stuck", and the server had none
// of them. The drain sends one entry at a time (outbox.ts's `draining` flag),
// and three steps inside a send had no time limit at all:
//
//   - reading the server's reply once it has started to arrive — timedFetch's
//     deadline stops at the response headers, and the body is read after it;
//   - the sign-in check supabase-js makes before every request, which waits
//     on the auth lock with no timeout;
//   - opening the phone's own database (IndexedDB) to read the photo back.
//
// One of those never answering held every later send until the app was
// relaunched. These pin the watchdog around each send: the drain stops
// waiting, records an ordinary retryable failure, and moves on — and the
// abandoned attempt, should it ever wake up, changes nothing.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  computeBackoffMs,
  drainStore,
  isClockOp,
  makeEntry,
  SendTookTooLongError,
  type DrainOpts,
  type OpHandler,
  type OpHandlers,
  type OutboxEntry,
  type OutboxOp,
} from "./outbox-core";
import { MemoryOutboxStore } from "./outboxStore";

const DEADLINE = 60_000;

/** What the server has been sent, keyed the way the real tables are. */
class FakeServer {
  /** Storage objects by path: an upload with upsert overwrites, never adds. */
  objects = new Map<string, number>();
  /** attachments rows by client_id: an upsert on client_id, never a second row. */
  rows = new Map<string, Record<string, unknown>>();
  rowWrites = 0;
  punches: string[] = [];
  upload(path: string) {
    this.objects.set(path, (this.objects.get(path) ?? 0) + 1);
  }
  upsertRow(clientId: string, row: Record<string, unknown>) {
    this.rowWrites += 1;
    this.rows.set(clientId, row);
  }
}

type Step = "session" | "reply";

/**
 * One step of one entry's send that does not answer — until released, or
 * never. `times` is how many attempts it catches: a zombie connection holds
 * the first attempt, not every attempt after it.
 */
class Hold {
  private release_: (() => void) | null = null;
  private times: number;
  readonly step: Step;
  readonly id: string;
  caught = 0;
  constructor(step: Step, id: string, times = 1) {
    this.step = step;
    this.id = id;
    this.times = times;
  }
  at(step: Step, entry: OutboxEntry): Promise<void> {
    if (step !== this.step || entry.id !== this.id || this.times <= 0) return Promise.resolve();
    this.times -= 1;
    this.caught += 1;
    return new Promise<void>((resolve) => {
      this.release_ = resolve;
    });
  }
  /** The held step finally answers — the abandoned attempt wakes up. */
  release() {
    this.release_?.();
  }
}

/**
 * A photo send shaped like the real one (outboxHandlers.ts's `upload`): the
 * sign-in check, the file read back off the phone, the bytes to the bucket,
 * the reply to that upload, then the attachments row keyed by the entry id.
 */
function photoHandler(server: FakeServer, hold: Hold | null, calls: string[] = []): OpHandler {
  return async (entry, ctx) => {
    calls.push(entry.id);
    await (hold?.at("session", entry) ?? Promise.resolve());
    const blob = await ctx.getBlob();
    if (!blob) throw new Error("Upload is missing its file");
    server.upload(String(entry.payload.path));
    await (hold?.at("reply", entry) ?? Promise.resolve());
    // The real handler's guard: a send the drain has stopped waiting for does
    // not go on to write its row — the retry that replaced it does.
    if (ctx.signal?.aborted) throw new SendTookTooLongError();
    server.upsertRow(entry.id, { storage_path: String(entry.payload.path) });
  };
}

function punchHandler(server: FakeServer, calls: string[] = []): OpHandler {
  return async (entry) => {
    calls.push(entry.id);
    server.punches.push(entry.op);
    return { id: "shift-1" };
  };
}

/**
 * A store whose database can stop answering for one entry: the read of its
 * photo (the local-database open inside the send), or the write that marks
 * it as sending. Every other entry, and every later call, answers normally.
 */
class FlakyDiskStore extends MemoryOutboxStore {
  hangBlobFor: string | null = null;
  hangSendingMarkFor: string | null = null;
  /** Hold the write that records this entry's failed attempt. */
  hangFailureFor: string | null = null;
  private wake: (() => void)[] = [];
  /** Is this write one the test asked to hold? One-shot for each kind. */
  private holds(next: OutboxEntry | null, id: string): boolean {
    if (next && next.status === "sending" && id === this.hangSendingMarkFor) {
      this.hangSendingMarkFor = null;
      return true;
    }
    if (next && next.status !== "sending" && next.attemptCount > 0 && id === this.hangFailureFor) {
      this.hangFailureFor = null;
      return true;
    }
    return false;
  }
  getBlob(id: string): Promise<Blob | null> {
    if (id === this.hangBlobFor) {
      this.hangBlobFor = null;
      return new Promise((resolve) => {
        this.wake.push(() => void super.getBlob(id).then(resolve));
      });
    }
    return super.getBlob(id);
  }
  put(entry: OutboxEntry, blob?: Blob | null): Promise<void> {
    if (this.holds(entry, entry.id)) {
      return new Promise((resolve) => {
        this.wake.push(() => void super.put(entry, blob).then(resolve));
      });
    }
    return super.put(entry, blob);
  }
  // A held write runs when the database answers — like an IndexedDB request
  // queued behind an open that stalled — against whatever is stored THEN.
  swap(id: string, expected: OutboxEntry | null, next: OutboxEntry | null): Promise<boolean> {
    if (this.holds(next, id)) {
      return new Promise((resolve) => {
        this.wake.push(() => void super.swap(id, expected, next).then(resolve));
      });
    }
    return super.swap(id, expected, next);
  }
  /** The database answers the calls it was holding, late. */
  answerLate() {
    const pending = this.wake;
    this.wake = [];
    for (const w of pending) w();
  }
}

let seq = 0;
async function queue(store: MemoryOutboxStore, op: OutboxOp, extra: Partial<OutboxEntry> = {}) {
  seq += 1;
  const id = `${op}-${seq}`;
  const entry: OutboxEntry = {
    ...makeEntry(
      {
        op,
        hasBlob: op === "photo_upload",
        payload: op === "photo_upload" ? { bucket: "install-media", path: `job/feed/${id}.jpg` } : { shiftRef: "shift-1" },
      },
      id,
      Date.now() - 60_000 + seq,
    ),
    nextAttemptAt: 0,
    ...extra,
  };
  await store.put(entry, op === "photo_upload" ? new Blob([`bytes of ${id}`], { type: "image/jpeg" }) : null);
  return entry;
}

/** Start a drain pass without awaiting it, and report whether it finished. */
function start(store: MemoryOutboxStore, handlers: OpHandlers, opts: DrainOpts) {
  let settled = false;
  const pass = drainStore(store, handlers, opts).then((res) => {
    settled = true;
    return res;
  });
  return { pass, settled: () => settled };
}

const opts = (extra: Partial<DrainOpts> = {}): DrainOpts => ({
  sendDeadlineMs: () => DEADLINE,
  ...extra,
});

async function entryById(store: MemoryOutboxStore, id: string) {
  return (await store.getAll()).find((e) => e.id === id) ?? null;
}

beforeEach(() => {
  vi.useFakeTimers({ now: new Date("2026-09-25T06:00:00Z") });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("the send watchdog", () => {
  it.each<[string, Step]>([
    ["a reply that never finishes arriving", "reply"],
    ["a sign-in check that never answers", "session"],
  ])("%s holds one photo, not the queue: the others land, the held one is retried later and lands once", async (_name, step) => {
    const store = new MemoryOutboxStore();
    const server = new FakeServer();
    const a = await queue(store, "photo_upload");
    const b = await queue(store, "photo_upload");
    const c = await queue(store, "photo_upload");
    const hold = new Hold(step, a.id);
    const abandoned = vi.fn();
    const handlers = { photo_upload: photoHandler(server, hold) };

    const run = start(store, handlers, opts({ onAbandoned: abandoned }));
    await vi.advanceTimersByTimeAsync(DEADLINE + 1);

    // Without a relaunch: the pass finished, and the two behind it went.
    expect(run.settled()).toBe(true);
    expect(await run.pass).toMatchObject({ attempted: 3, sent: 2, retried: 1, deadLettered: 0 });
    expect([...server.rows.keys()].sort()).toEqual([b.id, c.id].sort());

    // The held one is still on the phone, waiting to try again — not lost,
    // not given up on, and it says why in words.
    const held = await entryById(store, a.id);
    expect(held).toMatchObject({ status: "queued", attemptCount: 1 });
    expect(held!.lastError).toMatch(/too long/i);
    expect(held!.nextAttemptAt).toBe(Date.now() - 1 + computeBackoffMs(1));
    expect(abandoned).toHaveBeenCalledTimes(1);
    expect(abandoned.mock.calls[0][0]).toMatchObject({ id: a.id });

    // Its backoff passes; the next pass sends it, and it lands once.
    await vi.advanceTimersByTimeAsync(computeBackoffMs(1));
    const retry = await drainStore(store, handlers, opts({ onAbandoned: abandoned }));
    expect(retry).toMatchObject({ attempted: 1, sent: 1, remaining: 0 });
    expect(server.rows.size).toBe(3);
    expect(server.rowWrites).toBe(3);
    expect(abandoned).toHaveBeenCalledTimes(1);
  });

  it("a local-database read that never answers holds one photo, not the queue", async () => {
    const store = new FlakyDiskStore();
    const server = new FakeServer();
    const a = await queue(store, "photo_upload");
    const b = await queue(store, "photo_upload");
    store.hangBlobFor = a.id;
    const calls: string[] = [];
    const handlers = { photo_upload: photoHandler(server, null, calls) };

    const run = start(store, handlers, opts());
    await vi.advanceTimersByTimeAsync(DEADLINE + 1);
    expect(run.settled()).toBe(true);
    expect([...server.rows.keys()]).toEqual([b.id]);
    expect(await entryById(store, a.id)).toMatchObject({ status: "queued", attemptCount: 1 });

    // The read answers late, after the drain gave up on it: that attempt must
    // not go on to upload — its retry will.
    store.answerLate();
    await vi.advanceTimersByTimeAsync(0);
    expect(server.objects.has(String(a.payload.path))).toBe(false);

    await vi.advanceTimersByTimeAsync(computeBackoffMs(1));
    await drainStore(store, handlers, opts());
    expect(server.rows.has(a.id)).toBe(true);
    expect(server.objects.get(String(a.payload.path))).toBe(1);
    expect(await store.count()).toBe(0);
  });

  it("a write that marks the send never landing holds one photo, and the late write starts nothing", async () => {
    const store = new FlakyDiskStore();
    const server = new FakeServer();
    const a = await queue(store, "photo_upload");
    const b = await queue(store, "photo_upload");
    store.hangSendingMarkFor = a.id;
    const calls: string[] = [];
    const handlers = { photo_upload: photoHandler(server, null, calls) };

    const run = start(store, handlers, opts());
    await vi.advanceTimersByTimeAsync(DEADLINE + 1);
    expect(run.settled()).toBe(true);
    expect(calls).toEqual([b.id]);
    expect([...server.rows.keys()]).toEqual([b.id]);

    // What the watchdog wrote down: attempt 1, why, and when to try again.
    const recorded = await entryById(store, a.id);
    expect(recorded).toMatchObject({ status: "queued", attemptCount: 1 });
    expect(recorded!.lastError).toMatch(/too long/i);
    expect(recorded!.nextAttemptAt).toBeGreaterThan(Date.now());

    // The database finally answers the old write. The abandoned attempt must
    // not start sending now, on its own, beside the queue — and its stale
    // "sending" copy must not wind the entry back to attempt 0 with no reason
    // and no backoff (Codex review of #658): what the watchdog recorded stands.
    store.answerLate();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual([b.id]);
    expect(await entryById(store, a.id)).toEqual(recorded);

    // ...until the retry: a pass before the backoff leaves it alone.
    await drainStore(store, handlers, opts());
    expect(calls).toEqual([b.id]);
    expect(await entryById(store, a.id)).toEqual(recorded);

    // Nothing is lost: once the backoff has passed, the next pass sends it.
    await vi.advanceTimersByTimeAsync(computeBackoffMs(1));
    await drainStore(store, handlers, opts());
    expect(server.rows.has(a.id)).toBe(true);
    expect(await store.count()).toBe(0);
  });

  it("an abandoned send that finishes late — after its retry landed — changes nothing and is not sent twice", async () => {
    const store = new MemoryOutboxStore();
    const server = new FakeServer();
    const a = await queue(store, "photo_upload");
    const hold = new Hold("reply", a.id);
    const sent = vi.fn();
    const handlers = { photo_upload: photoHandler(server, hold) };

    const run = start(store, handlers, opts({ onSent: sent }));
    await vi.advanceTimersByTimeAsync(DEADLINE + 1);
    await run.pass;
    await vi.advanceTimersByTimeAsync(computeBackoffMs(1));
    await drainStore(store, handlers, opts({ onSent: sent }));
    expect(await store.count()).toBe(0);
    expect(sent).toHaveBeenCalledTimes(1);

    // The first attempt's reply finally arrives.
    hold.release();
    await vi.advanceTimersByTimeAsync(0);

    // No second row, no second "sent", and the entry is not brought back.
    expect(server.rows.size).toBe(1);
    expect(server.rowWrites).toBe(1);
    expect(sent).toHaveBeenCalledTimes(1);
    expect(await store.count()).toBe(0);
  });

  it("an abandoned send that fails late does not overwrite the retry it was replaced by", async () => {
    const store = new MemoryOutboxStore();
    const server = new FakeServer();
    const a = await queue(store, "photo_upload");
    let fail!: (e: Error) => void;
    let first = true;
    const handlers: OpHandlers = {
      photo_upload: async (entry, ctx) => {
        if (first) {
          first = false;
          return new Promise((_resolve, reject) => {
            fail = reject;
          });
        }
        return photoHandler(server, null)(entry, ctx);
      },
    };
    const run = start(store, handlers, opts());
    await vi.advanceTimersByTimeAsync(DEADLINE + 1);
    await run.pass;
    const recorded = await entryById(store, a.id);

    fail(new Error("duplicate key value violates unique constraint"));
    await vi.advanceTimersByTimeAsync(0);

    // A permanent-looking error from the abandoned attempt would have
    // dead-lettered the photo. It is ignored: the watchdog's record stands.
    expect(await entryById(store, a.id)).toEqual(recorded);
    await vi.advanceTimersByTimeAsync(computeBackoffMs(1));
    await drainStore(store, handlers, opts());
    expect(server.rows.has(a.id)).toBe(true);
    expect(await store.count()).toBe(0);
  });

  it("clock punches still go first: a clock-out tapped during the hang goes before the next photo", async () => {
    const store = new MemoryOutboxStore();
    const server = new FakeServer();
    const a = await queue(store, "photo_upload");
    const b = await queue(store, "photo_upload");
    const hold = new Hold("reply", a.id);
    const order: string[] = [];
    const handlers: OpHandlers = {
      photo_upload: photoHandler(server, hold, order),
      clock_out: punchHandler(server, order),
    };
    const run = start(store, handlers, opts());
    await vi.advanceTimersByTimeAsync(1_000);
    // Tapped while photo A is stuck.
    const punch = await queue(store, "clock_out");
    await vi.advanceTimersByTimeAsync(DEADLINE);
    await run.pass;
    expect(order).toEqual([a.id, punch.id, b.id]);
    expect(isClockOp(punch.op)).toBe(true);
    expect(server.punches).toEqual(["clock_out"]);
  });

  it("gives a big file more time once its size is known, so a slow but healthy upload is not cut off", async () => {
    const store = new MemoryOutboxStore();
    const server = new FakeServer();
    const a = await queue(store, "photo_upload");
    const deadline = vi.fn((_entry: OutboxEntry, bytes: number | null) =>
      bytes == null ? DEADLINE : DEADLINE * 10,
    );
    // Four minutes of uploading: past the first deadline, inside the second.
    const handlers: OpHandlers = {
      photo_upload: async (entry, ctx) => {
        const blob = await ctx.getBlob();
        await new Promise((resolve) => setTimeout(resolve, 4 * DEADLINE));
        server.upload(String(entry.payload.path));
        server.upsertRow(entry.id, { size: blob?.size });
      },
    };
    const run = start(store, handlers, { sendDeadlineMs: deadline });
    await vi.advanceTimersByTimeAsync(4 * DEADLINE + 1);
    expect(run.settled()).toBe(true);
    expect(await run.pass).toMatchObject({ sent: 1, retried: 0 });
    expect(server.rows.has(a.id)).toBe(true);
    expect(deadline).toHaveBeenLastCalledWith(expect.objectContaining({ id: a.id }), expect.any(Number));
  });

  it("still cuts off an upload that outlasts even its size-scaled time", async () => {
    const store = new MemoryOutboxStore();
    const a = await queue(store, "photo_upload");
    const handlers: OpHandlers = {
      photo_upload: async (_entry, ctx) => {
        await ctx.getBlob();
        await new Promise(() => {});
      },
    };
    const run = start(store, handlers, {
      sendDeadlineMs: (_e, bytes) => (bytes == null ? DEADLINE : DEADLINE * 3),
    });
    await vi.advanceTimersByTimeAsync(DEADLINE * 3 + 1);
    expect(run.settled()).toBe(true);
    expect(await entryById(store, a.id)).toMatchObject({ status: "queued", attemptCount: 1 });
  });

  it("an entry that hangs every time gives up after the usual number of tries and says why", async () => {
    const store = new MemoryOutboxStore();
    const a = await queue(store, "photo_upload");
    const handlers: OpHandlers = { photo_upload: () => new Promise(() => {}) };
    for (let i = 0; i < 8; i++) {
      const run = start(store, handlers, opts());
      await vi.advanceTimersByTimeAsync(DEADLINE + 1);
      expect(run.settled()).toBe(true);
      await vi.advanceTimersByTimeAsync(5 * 60_000);
    }
    const dead = await entryById(store, a.id);
    expect(dead).toMatchObject({ status: "failed", attemptCount: 8 });
    expect(dead!.lastError).toMatch(/too long/i);
  });

  it("a stale 'sending' write that lands after the retry sent the photo does not bring it back", async () => {
    const store = new FlakyDiskStore();
    const server = new FakeServer();
    const a = await queue(store, "photo_upload");
    store.hangSendingMarkFor = a.id;
    const handlers = { photo_upload: photoHandler(server, null) };

    const run = start(store, handlers, opts());
    await vi.advanceTimersByTimeAsync(DEADLINE + 1);
    await run.pass;
    await vi.advanceTimersByTimeAsync(computeBackoffMs(1));
    await drainStore(store, handlers, opts());
    expect(server.rows.has(a.id)).toBe(true);
    expect(await store.count()).toBe(0);

    store.answerLate();
    await vi.advanceTimersByTimeAsync(0);
    expect(await store.count()).toBe(0);
    expect(server.rowWrites).toBe(1);
  });

  it("a failure record that lands after the entry was taken away does not bring it back", async () => {
    const store = new FlakyDiskStore();
    const a = await queue(store, "photo_upload");
    store.hangFailureFor = a.id;
    const handlers: OpHandlers = {
      photo_upload: async () => {
        throw new TypeError("Failed to fetch");
      },
    };
    const run = start(store, handlers, opts());
    await vi.advanceTimersByTimeAsync(0);
    // While the failure record waits on the phone's database, the entry is
    // taken away — sent by another tab, or thrown away by a person.
    await store.delete(a.id);
    store.answerLate();
    await vi.advanceTimersByTimeAsync(0);
    await run.pass;
    expect(await store.count()).toBe(0);
  });

  it("with no watchdog asked for, a drain waits for the send as it always has", async () => {
    const store = new MemoryOutboxStore();
    await queue(store, "photo_upload");
    let finish!: () => void;
    const handlers: OpHandlers = {
      photo_upload: () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    };
    const run = start(store, handlers, {});
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(run.settled()).toBe(false);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(run.settled()).toBe(true);
  });
});

describe("a write that only lands on the state it was based on (MemoryOutboxStore.swap)", () => {
  const photo = (over: Partial<OutboxEntry> = {}): OutboxEntry => ({
    ...makeEntry({ op: "photo_upload", hasBlob: true, payload: { path: "p.jpg" } }, "e1", 1_000),
    ...over,
  });

  it("writes when the stored entry is the one it read, keeping the photo beside it", async () => {
    const store = new MemoryOutboxStore();
    const blob = new Blob(["x"]);
    const read = photo();
    await store.put(read, blob);
    expect(await store.swap("e1", read, { ...read, attemptCount: 1, lastError: "x" })).toBe(true);
    expect((await store.getAll())[0]).toMatchObject({ attemptCount: 1, lastError: "x" });
    expect(await store.getBlob("e1")).toBe(blob);
  });

  it("counts a 'sending' mark as the entry it marked, the way every read does", async () => {
    const store = new MemoryOutboxStore();
    const read = photo();
    await store.put({ ...read, status: "sending" });
    expect(await store.swap("e1", read, null)).toBe(true);
    expect(await store.count()).toBe(0);
  });

  it("refuses when the entry has moved on, and when it is gone", async () => {
    const store = new MemoryOutboxStore();
    const read = photo();
    await store.put({ ...read, attemptCount: 1, lastError: "newer" });
    expect(await store.swap("e1", read, { ...read, status: "sending" })).toBe(false);
    expect((await store.getAll())[0]).toMatchObject({ attemptCount: 1, lastError: "newer" });
    await store.delete("e1");
    expect(await store.swap("e1", read, read)).toBe(false);
    expect(await store.count()).toBe(0);
  });
});
