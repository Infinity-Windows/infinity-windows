// The runtime half of K0.1: the outbox keeps a synchronous snapshot of the
// clock punches on this phone, says when it has read its store at least once,
// and announces a confirmed punch with the server's row BEFORE it tells the
// world the entry is gone. Runs the real module on its in-memory store (no
// IndexedDB under vitest) with the server stubbed.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mergeClockQueue } from "../clockQueueView";
import type { TimeShift } from "../timeclock";

const rpc = vi.fn();
vi.mock("../supabase", () => {
  // The outbox sends a write only as the person who queued it, through a
  // client bound to that person's token (2026-09-25): here, the same stub.
  const supabase = { rpc: (...args: unknown[]) => rpc(...args), auth: { getSession: async () => ({ data: { session: { access_token: "test-token", user: { id: "test-user", email: "installer@example.com" } } }, error: null }) } };
  return { supabase, clientWithToken: () => supabase, supabaseConfigured: true };
});
vi.mock("../signedIn", () => ({
  signedInEmail: () => "e2e@example.test",
  signedInUserId: () => "test-user",
  launchUserId: () => "test-user",
  subscribeSignedIn: () => () => {},
}));
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

// Codex review of #644 (2026-09-24): the punches queued behind a clock-in
// keep its `pending:` ref for life. Once the clock-in has landed and left the
// queue, the sender places them through the map it wrote at that moment —
// and the clock screens have to read that same map, or they show "clocked
// in, clock-out on its way" over a shift the phone is about to close.
describe("the punches behind a clock-in that has landed", () => {
  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
  });

  it("are placed on the server's shift by the screens exactly as by the sender, after the clock-in has left the queue", async () => {
    // A whole day tapped with no signal — taps minutes apart, as on a phone;
    // the queue keeps tap order by the moment each was queued, and two taps
    // in one millisecond would be an order nobody made.
    vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] });
    const later = (minutes: number) => vi.setSystemTime(Date.now() + minutes * 60_000);
    Object.defineProperty(navigator, "onLine", { value: false, configurable: true });
    const inId = await outbox.enqueueClockIn({ projectId: "p1", costCodeId: "cc1", punch: PUNCH });
    const ref = outbox.pendingRefForShift(inId);
    later(240);
    await outbox.enqueueBreakStart(ref, "lunch", { ...PUNCH, clientId: "1b2f0c14-7d3a-4e51-8a06-3f2c9d1e4b72" });
    later(30);
    await outbox.enqueueBreakStop(ref, { ...PUNCH, clientId: "1b2f0c14-7d3a-4e51-8a06-3f2c9d1e4b73" });
    later(240);
    await outbox.enqueueClockOut({
      shiftRef: ref,
      injured: false,
      timeConfirmed: true,
      breakSeconds: 0,
      punch: { ...PUNCH, clientId: "1b2f0c14-7d3a-4e51-8a06-3f2c9d1e4b74" },
    });
    expect(outbox.resolveShiftRef(ref)).toBeNull();
    Object.defineProperty(navigator, "onLine", { value: true, configurable: true });

    // The signal holds for the clock-in and drops again: the server answers
    // the clock-in with its row, every later call fails to reach it.
    const row = {
      id: "shift-9",
      profile_id: "me",
      client_id: PUNCH.clientId,
      clock_in_at: PUNCH.tappedAt,
      clock_out_at: null,
      break_seconds: 0,
      break_started_at: null,
      break_type: null,
      status: "open",
    } as unknown as TimeShift;
    rpc.mockImplementation(async (fn: string) =>
      fn === "clock_in" ? { data: row, error: null } : Promise.reject(new TypeError("Failed to fetch")),
    );
    await outbox.drain();
    const snap = outbox.getClockQueueSnapshot();
    expect(snap.entries.map((e) => e.op)).toEqual(["break_start", "break_stop", "clock_out"]);
    expect(snap.entries.every((e) => e.status === "queued")).toBe(true);
    expect(outbox.resolveShiftRef(ref)).toBe("shift-9");

    // What every clock screen shows now — and after a relaunch that reads
    // this same queue and this same map back: off the clock, clock-out on
    // its way. Not "clocked in".
    const view = mergeClockQueue(row, snap.entries, { profileId: "me", resolveShiftRef: outbox.resolveShiftRef });
    expect(view.shift).toBeNull();
    expect(view.pending?.kind).toBe("clock_out");

    // Signal returns, past the backoff: the sender sends all three to that
    // same shift, in tap order, and the queue empties.
    const sentTo: string[] = [];
    rpc.mockImplementation(async (fn: string, args: Record<string, unknown>) => {
      sentTo.push(`${fn}:${String(args.p_shift_id)}`);
      return { data: fn === "end_break" ? { outcome: "ended", shift: row } : row, error: null };
    });
    later(1);
    await outbox.drain();
    expect(sentTo).toEqual(["start_break:shift-9", "end_break:shift-9", "clock_out:shift-9"]);
    expect(outbox.getClockQueueSnapshot().entries).toEqual([]);
  });
});
