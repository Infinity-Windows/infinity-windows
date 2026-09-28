// Offline toolbox signing, the queue half (2026-09-25). A toolbox talk signed
// with no signal waits in the outbox as a `toolbox_sign` entry, and the
// clock-in the person taps next waits behind it. The server refuses the day's
// first clock-in without today's signature on record, so the one thing the
// queue must never do is let that clock-in reach the server first — and when
// the signature itself is refused, the clock-in has to wait with it, not go
// out and fail on "complete today's toolbox talk".

import { describe, expect, it } from "vitest";
import {
  cascadeFailure,
  countsByOp,
  drainStore,
  dueEntries,
  isClockLaneOp,
  makeEntry,
  pillSummary,
  totalPending,
  type OpHandlers,
  type OutboxEntry,
} from "./outbox-core";
import { MemoryOutboxStore } from "./outboxStore";

const T0 = 1_000_000;

function entry(over: Partial<OutboxEntry> & Pick<OutboxEntry, "id" | "op">): OutboxEntry {
  return {
    payload: {},
    createdAt: T0,
    attemptCount: 0,
    lastError: null,
    status: "queued",
    nextAttemptAt: T0,
    dependsOn: null,
    hasBlob: false,
    ...over,
  };
}

const sign = (id: string, createdAt: number, over: Partial<OutboxEntry> = {}) =>
  entry({ id, op: "toolbox_sign", createdAt, hasBlob: true, ...over });
const photo = (id: string, createdAt: number) =>
  entry({ id, op: "photo_upload", createdAt, hasBlob: true, payload: { path: `${id}.jpg` } });

function recordingHandlers(order: string[]): OpHandlers {
  const record = async (e: OutboxEntry) => {
    order.push(e.id);
  };
  return {
    toolbox_sign: record,
    clock_in: record,
    clock_out: record,
    break_start: record,
    break_stop: record,
    photo_upload: record,
  };
}

describe("a signature rides the clock lane, ahead of the punches", () => {
  it("is a clock-lane write, and a clock punch still is", () => {
    expect(isClockLaneOp("toolbox_sign")).toBe(true);
    expect(isClockLaneOp("clock_in")).toBe(true);
    expect(isClockLaneOp("photo_upload")).toBe(false);
  });

  it("is planned before a clock-in queued EARLIER, and before the photos", () => {
    const list = [
      photo("photo", 5),
      entry({ id: "in", op: "clock_in", createdAt: 10 }),
      sign("sign", 20),
    ];
    expect(dueEntries(list, T0).map((e) => e.id)).toEqual(["sign", "in", "photo"]);
  });

  it("keeps signatures in the order they were made", () => {
    const list = [sign("today", 30), entry({ id: "in", op: "clock_in", createdAt: 5 }), sign("yesterday", 10)];
    expect(dueEntries(list, T0).map((e) => e.id)).toEqual(["yesterday", "today", "in"]);
  });

  it("sends the signature, then the clock-in behind it, then the photos, in one pass", async () => {
    const store = new MemoryOutboxStore();
    await store.put(photo("photo-1", 1));
    await store.put(sign("sign", 10));
    await store.put(entry({ id: "in", op: "clock_in", createdAt: 11, dependsOn: "sign" }));
    await store.put(photo("photo-2", 12));
    const order: string[] = [];
    const res = await drainStore(store, recordingHandlers(order), { now: T0 });
    expect(order).toEqual(["sign", "in", "photo-1", "photo-2"]);
    expect(res.sent).toBe(4);
  });

  it("a signature made while a photo was uploading goes out right after that photo", async () => {
    const store = new MemoryOutboxStore();
    await store.put(photo("photo-1", 1));
    await store.put(photo("photo-2", 2));
    const order: string[] = [];
    const handlers: OpHandlers = {
      ...recordingHandlers(order),
      photo_upload: async (e) => {
        order.push(e.id);
        if (e.id === "photo-1") await store.put(sign("sign", 3));
      },
    };
    await drainStore(store, handlers, { now: T0 });
    expect(order).toEqual(["photo-1", "sign", "photo-2"]);
  });
});

describe("a clock-in waits for the signature it hangs off", () => {
  it("is not attempted while the signature is still retrying", async () => {
    const store = new MemoryOutboxStore();
    await store.put(sign("sign", 10));
    await store.put(entry({ id: "in", op: "clock_in", createdAt: 11, dependsOn: "sign" }));
    const attempts: string[] = [];
    const handlers: OpHandlers = {
      toolbox_sign: async (e) => {
        attempts.push(e.id);
        throw new TypeError("Failed to fetch");
      },
      clock_in: async (e) => {
        attempts.push(e.id);
      },
    };
    const res = await drainStore(store, handlers, { now: T0 });
    expect(attempts).toEqual(["sign"]);
    expect(res.retried).toBe(1);
    const left = await store.getAll();
    expect(left.find((e) => e.id === "in")?.status).toBe("queued");
  });

  it("is HELD, not failed, when the signature is refused — and so is everything behind it", async () => {
    const store = new MemoryOutboxStore();
    await store.put(sign("sign", 10));
    await store.put(entry({ id: "in", op: "clock_in", createdAt: 11, dependsOn: "sign" }));
    await store.put(entry({ id: "out", op: "clock_out", createdAt: 12, dependsOn: "in" }));
    const attempts: string[] = [];
    const handlers: OpHandlers = {
      ...recordingHandlers(attempts),
      toolbox_sign: async (e) => {
        attempts.push(e.id);
        throw Object.assign(new Error("This toolbox talk signature belongs to someone else on this phone."), {
          code: "42501",
        });
      },
    };
    const res = await drainStore(store, handlers, { now: T0 });
    // Only the signature went out, and it is the only thing that "needs you".
    expect(attempts).toEqual(["sign"]);
    expect(res.deadLettered).toBe(1);
    const byId = new Map((await store.getAll()).map((e) => [e.id, e]));
    expect(byId.get("sign")?.status).toBe("failed");
    // Never sent, so never refused on the toolbox gate: still waiting behind it.
    expect(byId.get("in")?.status).toBe("queued");
    expect(byId.get("in")?.lastError).toBeNull();
    expect(byId.get("out")?.status).toBe("queued");
    // And a second pass still sends nothing: the signature is in the way.
    const again = await drainStore(store, handlers, { now: T0 + 10 * 60_000 });
    expect(again.attempted).toBe(0);
  });

  it("does not spread a refused signature to what waits on it", () => {
    const refused = { ...sign("sign", 1), status: "failed" as const };
    const clockIn = entry({ id: "in", op: "clock_in", createdAt: 2, dependsOn: "sign" });
    expect(cascadeFailure([refused, clockIn], "sign")).toEqual([]);
  });

  it("still spreads a refused CLOCK-IN to the clock-out behind it, as before", () => {
    const clockIn = { ...entry({ id: "in", op: "clock_in", createdAt: 2, dependsOn: "sign" }), status: "failed" as const };
    const clockOut = entry({ id: "out", op: "clock_out", createdAt: 3, dependsOn: "in" });
    expect(cascadeFailure([sign("sign", 1), clockIn, clockOut], "in").map((e) => e.id)).toEqual(["out"]);
  });
});

describe("the sync pill counts a signature still on the phone", () => {
  it("in its own bucket, named on the pill face", () => {
    const c = countsByOp([sign("sign", 1), entry({ id: "in", op: "clock_in", createdAt: 2 })]);
    expect(c.toolbox).toBe(1);
    expect(c.clock).toBe(1);
    expect(totalPending(c)).toBe(2);
    expect(pillSummary(c).label).toBe("Clock 1 · Toolbox talk 1");
  });

  it("as needing attention once it was refused", () => {
    const c = countsByOp([{ ...sign("sign", 1), status: "failed" }]);
    expect(c.toolbox).toBe(0);
    expect(c.deadLetter).toBe(1);
    expect(pillSummary(c).tone).toBe("attention");
  });

  it("survives the trip to disk", () => {
    const e = makeEntry({ op: "toolbox_sign", payload: { clientId: "c1" }, hasBlob: true }, "sign-1", T0);
    expect(countsByOp([e]).toolbox).toBe(1);
  });
});
