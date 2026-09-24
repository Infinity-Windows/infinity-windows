// The runtime half of K0.1: the outbox keeps a synchronous snapshot of the
// clock punches on this phone, says when it has read its store at least once,
// and announces a confirmed punch with the server's row BEFORE it tells the
// world the entry is gone. Runs the real module on its in-memory store (no
// IndexedDB under vitest) with the server stubbed.

import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
vi.mock("../supabase", () => ({
  supabase: { rpc: (...args: unknown[]) => rpc(...args) },
  supabaseConfigured: true,
}));
vi.mock("../signedIn", () => ({ signedInEmail: () => "e2e@example.test" }));
vi.mock("./telemetry", () => ({ logOfflineEvent: () => {} }));

const outbox = await import("./outbox");

const PUNCH = {
  clientId: "9b2f0c14-7d3a-4e51-8a06-3f2c9d1e4b77",
  tappedAt: "2026-09-23T13:02:11.000Z",
  clockCheckedAt: null,
  clockSkewMs: null,
};

beforeEach(() => {
  rpc.mockReset();
});

describe("the clock queue snapshot", () => {
  it("is not ready until the store has been read once, then lists the punches on the phone", async () => {
    // Nothing has read the store yet this session.
    expect(outbox.getClockQueueSnapshot().ready).toBe(false);
    await outbox.recoverAndDrain();
    expect(outbox.getClockQueueSnapshot()).toEqual({ entries: [], ready: true });
  });

  it("holds a queued clock-in the moment it is queued, and tells subscribers", async () => {
    // A phone with no network: the punch stays on the phone.
    Object.defineProperty(navigator, "onLine", { value: false, configurable: true });
    const heard = vi.fn();
    const stop = outbox.subscribe(heard);
    try {
      const id = await outbox.enqueueClockIn({ projectId: "p1", costCodeId: "cc1", punch: PUNCH });
      const snap = outbox.getClockQueueSnapshot();
      expect(snap.ready).toBe(true);
      expect(snap.entries.map((e) => e.id)).toEqual([id]);
      expect(snap.entries[0]).toMatchObject({ op: "clock_in", status: "queued", payload: { clientId: PUNCH.clientId } });
      expect(heard).toHaveBeenCalled();
      expect(rpc).not.toHaveBeenCalled();
    } finally {
      stop();
      Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
    }
  });

  it("announces a confirmed punch with the server's row, and only then drops it from the snapshot", async () => {
    const row = { id: "shift-1", profile_id: "me", clock_in_at: PUNCH.tappedAt, clock_out_at: null, status: "open" };
    rpc.mockResolvedValue({ data: row, error: null });
    const order: string[] = [];
    const stopSent = outbox.subscribeClockSent((entry, result) => {
      order.push(`sent:${entry.op}`);
      expect(result).toBe(row);
      // At this instant the queue still says the punch is on the phone.
      expect(outbox.getClockQueueSnapshot().entries.some((e) => e.id === entry.id)).toBe(true);
    });
    const stopQueue = outbox.subscribe(() => {
      if (outbox.getClockQueueSnapshot().entries.length === 0) order.push("queue-empty");
    });
    try {
      await outbox.drain();
      expect(rpc).toHaveBeenCalledTimes(1);
      expect(order[0]).toBe("sent:clock_in");
      expect(order).toContain("queue-empty");
      expect(outbox.getClockQueueSnapshot().entries).toEqual([]);
    } finally {
      stopSent();
      stopQueue();
    }
  });

  it("does not announce a photo as a punch", async () => {
    rpc.mockResolvedValue({ data: {}, error: null });
    const heard = vi.fn();
    const stop = outbox.subscribeClockSent(heard);
    try {
      await outbox.enqueuePinUndo("move-1");
      await outbox.drain();
      expect(heard).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });
});
