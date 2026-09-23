import { afterEach, describe, expect, it, vi } from "vitest";

const rows: { value: unknown[] } = { value: [] };
const calls: { order?: { ascending: boolean }; limit?: number } = {};
vi.mock("./supabase", () => {
  const chain = {
    select: () => chain, eq: () => chain, in: () => chain,
    order: (_c: string, o: { ascending: boolean }) => { calls.order ??= o; return chain; },
    limit: (n: number) => { calls.limit = n; return Promise.resolve({ data: rows.value, error: null }); },
    then: (resolve: (v: unknown) => void) => resolve({ data: [], error: null }),
  };
  return { supabase: { from: () => chain, rpc: vi.fn(), storage: { from: () => ({}) } } };
});

import { guardedResolve, keepUnsent, loadConversation, phoneTimingPending, RESTORE_TURNS, runVoiceSteps, TimingPendingError, tx, type FieldReceipt } from "./fieldAsk";
import { fieldActorMatches } from "../../../supabase/functions/_shared/fieldTools";

describe("a tap on a timing choice re-checks the phone's queues at the moment of the tap", () => {
  const card = { action_id: "a", action: "start_unit", status: "needs_choice", preview_hash: "h" } as FieldReceipt;
  const resolve = vi.fn(async () => ({ ...card, status: "running" }) as FieldReceipt);
  it("a break or clock-out queued after the card appeared refuses start/join/end-break without calling the server", async () => {
    for (const choice of ["start_now", "join_helper", "end_break_and_start"]) {
      resolve.mockClear();
      await expect(guardedResolve(card, choice, { timingPending: async () => true, resolve })).rejects.toBeInstanceOf(TimingPendingError);
      await expect(guardedResolve(card, choice, { timingPending: async () => { throw new Error("idb"); }, resolve })).rejects.toBeInstanceOf(TimingPendingError);
      expect(resolve).not.toHaveBeenCalled();
    }
  });
  it("corrections, duplicates and cancel are never blocked by the queue", async () => {
    for (const choice of ["keep_original", "correct_record", "send_for_review", "create_new", "use_plans", "cancel"]) {
      await expect(guardedResolve(card, choice, { timingPending: async () => true, resolve })).resolves.toMatchObject({ status: "running" });
    }
  });
  it("a clear queue lets the timing tap through", async () => {
    await expect(guardedResolve(card, "start_now", { timingPending: async () => false, resolve })).resolves.toMatchObject({ status: "running" });
  });
});

describe("a voice message's steps", () => {
  const steps = (owner: boolean[], over: Partial<Parameters<typeof runVoiceSteps>[0]> = {}) => {
    const log: string[] = [];
    let i = 0;
    return {
      log,
      steps: {
        stillOwner: async () => { const v = owner[Math.min(i, owner.length - 1)]; i++; log.push(`owner:${v}`); return v; },
        keep: async (text: string, error: string) => { log.push(`keep:${text}:${error}`); return true; },
        upload: async () => { log.push("upload"); return "a/r/memo.webm"; },
        transcribe: async () => { log.push("transcribe"); return "start unit four"; },
        send: (w: string, p: string) => { log.push(`send:${w}:${p}`); },
        ...over,
      },
    };
  };
  it("keeps, uploads, transcribes and sends in that order when nothing changes", async () => {
    const { log, steps: s } = steps([true]);
    expect(await runVoiceSteps(s)).toEqual({ outcome: "sent", keptOnPhone: true });
    expect(log).toEqual(["keep::pending", "owner:true", "upload", "owner:true", "transcribe", "keep:start unit four:pending", "owner:true", "send:start unit four:a/r/memo.webm"]);
  });
  it("a switch to another account while uploading stops before transcription (nobody else pays or sends)", async () => {
    const { log, steps: s } = steps([true, false]);
    expect((await runVoiceSteps(s)).outcome).toBe("not_owner");
    expect(log).toContain("upload");
    expect(log).not.toContain("transcribe");
    expect(log.some((l) => l.startsWith("send:"))).toBe(false);
  });
  it("a switch before upload sends nothing at all; the recording stays kept for its speaker", async () => {
    const { log, steps: s } = steps([false]);
    expect(await runVoiceSteps(s)).toEqual({ outcome: "not_owner", keptOnPhone: true });
    expect(log).toEqual(["keep::pending", "owner:false"]);
  });
  it("a switch during transcription never sends", async () => {
    const { log, steps: s } = steps([true, true, false]);
    expect((await runVoiceSteps(s)).outcome).toBe("not_owner");
    expect(log.some((l) => l.startsWith("send:"))).toBe(false);
  });
  it("a failed transcription after a successful upload is reported with whether the phone kept it", async () => {
    const { steps: s } = steps([true], { keep: async () => false, transcribe: async () => { throw new Error("transcription_failed"); } });
    expect(await runVoiceSteps(s)).toEqual({ outcome: "failed", keptOnPhone: false, error: "transcription_failed" });
  });
});

describe("a field message belongs to the account it was captured under", () => {
  const A = "00000000-0000-4000-8000-00000000000a", B = "00000000-0000-4000-8000-00000000000b";
  it("the server accepts it only from that verified caller", () => {
    expect(fieldActorMatches(A, A)).toBe(true);
    expect(fieldActorMatches(A.toUpperCase(), A)).toBe(true);
    expect(fieldActorMatches(A, B)).toBe(false);
    for (const missing of [undefined, null, "", "service_role"]) expect(fieldActorMatches(missing, A)).toBe(false);
  });
});

/** A fake IndexedDB database whose transaction fires the given events in order. */
function fakeDb(events: ("success" | "complete" | "abort")[]) {
  return async () => ({
    close: vi.fn(),
    transaction: () => {
      const t: Record<string, unknown> = { error: null };
      const request: Record<string, unknown> = { result: "ok", error: null };
      t.objectStore = () => ({ put: () => request });
      queueMicrotask(() => {
        for (const e of events) {
          if (e === "success") (request.onsuccess as () => void)?.();
          if (e === "complete") (t.oncomplete as () => void)?.();
          if (e === "abort") { t.error = new Error("QuotaExceededError"); (t.onabort as () => void)?.(); }
        }
      });
      return t;
    },
  }) as unknown as IDBDatabase;
}

afterEach(() => { rows.value = []; delete calls.order; delete calls.limit; });

describe("keeping a recording on the phone", () => {
  it("is saved only when the transaction commits", async () => {
    await expect(tx("readwrite", (s) => s.put({}), fakeDb(["success", "complete"]))).resolves.toBe("ok");
  });
  it("a request that succeeded inside an aborted transaction is NOT saved", async () => {
    await expect(tx("readwrite", (s) => s.put({}), fakeDb(["success", "abort"]))).rejects.toThrow(/Quota/);
  });
  it("a phone without IndexedDB says so instead of pretending", async () => {
    const saved = globalThis.indexedDB;
    // @ts-expect-error simulate a browser without IndexedDB
    delete globalThis.indexedDB;
    try {
      await expect(keepUnsent({ userId: "u", meta: { request_id: "r" } as never, text: "", audio: new Blob(["x"]), error: "" })).rejects.toThrow("storage_unavailable");
    } finally {
      if (saved) globalThis.indexedDB = saved;
    }
  });
});

describe("restoring a long conversation", () => {
  it("loads the newest messages and shows them oldest-first", async () => {
    // The server returns newest first; the page shows the latest 60 in order.
    rows.value = Array.from({ length: RESTORE_TURNS }, (_, i) => ({ id: `t${61 - i}`, transcript: `turn ${61 - i}` }));
    const turns = await loadConversation("u", "c");
    expect(calls).toEqual({ order: { ascending: false }, limit: RESTORE_TURNS });
    expect(turns[0].id).toBe("t2");
    expect(turns.at(-1)?.id).toBe("t61");
  });
});

describe("timing the phone has not sent yet", () => {
  const none = { clockWrites: async () => 0, workQueue: () => [], shiftId: "real-shift" };
  it("is clear only when nothing is queued", async () => {
    expect(await phoneTimingPending("u", none)).toBe(false);
  });
  it("a queued break or clock-out on a REAL shift id still counts", async () => {
    expect(await phoneTimingPending("u", { ...none, clockWrites: async () => 1 })).toBe(true);
  });
  it("queued custom unit work counts; a queued unit edit alone does not", async () => {
    expect(await phoneTimingPending("u", { ...none, workQueue: () => [{ action: "start" }] })).toBe(true);
    expect(await phoneTimingPending("u", { ...none, workQueue: () => [{ action: "unit" }] })).toBe(false);
  });
  it("a pending shift or an unreadable queue counts as pending", async () => {
    expect(await phoneTimingPending("u", { ...none, shiftId: "pending:abc" })).toBe(true);
    expect(await phoneTimingPending("u", { ...none, clockWrites: async () => { throw new Error("blocked"); } })).toBe(true);
    expect(await phoneTimingPending("u", { ...none, workQueue: () => { throw new Error("locked"); } })).toBe(true);
  });
});
