// @vitest-environment happy-dom
//
// The toolbox gate as every screen reads it (offline toolbox signing,
// 2026-09-25). Mounted for real over the real outbox (its in-memory store
// under vitest), with the server stubbed, so this proves what a screen sees
// for each state the phone can be in:
//   * a talk signed on this phone with no signal counts as signed — waiting to
//     send — and, once Forge refuses it, as signed and refused;
//   * yesterday's cached signature does NOT count for today, and neither does
//     yesterday's signature still on the phone;
//   * today's talk comes from the days fetched ahead when the live read is
//     from yesterday.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolboxSignPayload } from "./toolboxSign";

const rpc = vi.fn();
const upload = vi.fn();
vi.mock("./supabase", () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpc(...args),
    storage: { from: () => ({ upload: (...args: unknown[]) => upload(...args) }) },
    from: () => {
      throw new Error("no table reads in this test");
    },
  },
  supabaseConfigured: true,
}));
vi.mock("./signedIn", () => ({ signedInEmail: () => "e2e@example.test" }));
vi.mock("./offline/telemetry", () => ({ logOfflineEvent: () => {} }));

const outbox = await import("./offline/outbox");
const { todayTalkKey, useTodayTalk, useToolboxToday } = await import("./useToolboxGate");
const { forgetConfirmedSignatures } = outbox;
const { localDateOf } = await import("./toolboxSign");

const ME = "me";
const DAY = 24 * 3600_000;
const TALK_TODAY = { id: "t-today", title: "Glass ✓", body: "b", talk_date: localDateOf(new Date()) };
const TALK_YESTERDAY = { id: "t-yesterday", title: "Ladders", body: "b", talk_date: localDateOf(new Date(Date.now() - DAY)) };

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let seen: { talk: ReturnType<typeof useTodayTalk>; done: ReturnType<typeof useToolboxToday> } | null = null;

function Probe() {
  seen = { talk: useTodayTalk(), done: useToolboxToday(ME) };
  return null;
}

function client(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity, staleTime: Infinity, refetchOnMount: false, refetchOnWindowFocus: false, refetchOnReconnect: false },
    },
  });
}

function mount(qc: QueryClient) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <QueryClientProvider client={qc}>
        <Probe />
      </QueryClientProvider>,
    );
  });
}

let n = 0;
function signature(over: Partial<ToolboxSignPayload> = {}): ToolboxSignPayload {
  n += 1;
  const clientId = `0e9b8c7d-3333-4c4d-8e5f-${String(n).padStart(12, "0")}`;
  return {
    clientId,
    profileId: ME,
    talkId: TALK_TODAY.id,
    talkDate: TALK_TODAY.talk_date,
    typedName: "Dana Reyes",
    signedAt: new Date().toISOString(),
    talkSnapshot: "{}",
    signaturePath: `${ME}/t/${clientId}-signature.png`,
    signatureDataUrl: "data:image/png;base64,iVBORw0KGgo=",
    pdfPath: null,
    ...over,
  };
}

const offline = () => Object.defineProperty(navigator, "onLine", { value: false, configurable: true });
const online = () => Object.defineProperty(navigator, "onLine", { value: true, configurable: true });

beforeEach(() => {
  rpc.mockReset();
  upload.mockReset();
  upload.mockResolvedValue({ data: {}, error: null });
  offline();
});

afterEach(async () => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  seen = null;
  vi.useRealTimers();
  online();
  for (const e of await outbox.listAll()) await outbox.discardFailed(e.id);
  // What Forge confirmed in one test must not sign the next one in.
  forgetConfirmedSignatures();
});

describe("has this person signed today's talk?", () => {
  it("no — and the gates know it — when Forge says so today", () => {
    const qc = client();
    qc.setQueryData(["toolboxToday", ME], null);
    mount(qc);
    expect(seen!.done).toMatchObject({ data: null, isSuccess: true, pending: false });
  });

  it("yes, waiting to send, the moment it is signed on a phone with no signal", async () => {
    const qc = client();
    qc.setQueryData(["toolboxToday", ME], null);
    mount(qc);
    const sig = signature();
    await act(async () => {
      await outbox.enqueueToolboxSign(sig, null);
    });
    expect(seen!.done.isSuccess).toBe(true);
    expect(seen!.done.pending).toBe(true);
    expect(seen!.done.refused).toBe(false);
    expect(seen!.done.data).toMatchObject({ id: `pending:${sig.clientId}`, signed_at: sig.signedAt, pending: true });
  });

  it("yes, and Forge's own row — not the phone's copy — once it has been sent", async () => {
    const qc = client();
    qc.setQueryData(["toolboxToday", ME], null);
    mount(qc);
    const sig = signature();
    await act(async () => {
      await outbox.enqueueToolboxSign(sig, null);
    });
    const row = { id: "completion-1", profile_id: ME, client_id: sig.clientId, signed_at: sig.signedAt, typed_name: "Dana Reyes" };
    rpc.mockResolvedValue({ data: row, error: null });
    online();
    await act(async () => {
      await outbox.drain();
    });
    expect(seen!.done).toMatchObject({ isSuccess: true, pending: false, refused: false, data: row });
    expect(qc.getQueryData(["toolboxToday", ME])).toEqual(row);
  });

  it("signed and REFUSED, with Forge's reason, when Forge would not take it", async () => {
    const qc = client();
    qc.setQueryData(["toolboxToday", ME], null);
    mount(qc);
    await act(async () => {
      await outbox.enqueueToolboxSign(signature(), null);
    });
    rpc.mockResolvedValue({ data: null, error: { code: "42501", message: "This toolbox talk signature belongs to someone else on this phone." } });
    online();
    await act(async () => {
      await outbox.drain();
    });
    expect(seen!.done.pending).toBe(true);
    expect(seen!.done.refused).toBe(true);
    expect(seen!.done.data?.sendError).toContain("belongs to someone else");
  });

  it("no, this morning, on a phone whose last signal was yesterday — yesterday's signature is not today's", () => {
    const qc = client();
    const yesterday = Date.now() - DAY;
    qc.setQueryData(
      ["toolboxToday", ME],
      { id: "row-yesterday", profile_id: ME, signed_at: new Date(yesterday).toISOString() },
      { updatedAt: yesterday },
    );
    mount(qc);
    expect(seen!.done).toMatchObject({ data: null, isSuccess: true, pending: false });
  });

  it("no, when the only signature still on the phone was made yesterday", async () => {
    const qc = client();
    qc.setQueryData(["toolboxToday", ME], null);
    mount(qc);
    await act(async () => {
      await outbox.enqueueToolboxSign(signature({ signedAt: new Date(Date.now() - DAY).toISOString() }), null);
    });
    expect(seen!.done).toMatchObject({ data: null, pending: false });
  });

  it("not somebody else's signature on the same phone", async () => {
    const qc = client();
    qc.setQueryData(["toolboxToday", ME], null);
    mount(qc);
    await act(async () => {
      await outbox.enqueueToolboxSign(signature({ profileId: "someone-else" }), null);
    });
    expect(seen!.done).toMatchObject({ data: null, pending: false });
  });
});

describe("what is today's talk?", () => {
  const today = () => localDateOf(new Date());
  const yesterday = () => localDateOf(new Date(Date.now() - DAY));

  it("the live read for today — and it says which day it was handed out for", () => {
    const qc = client();
    qc.setQueryData(todayTalkKey(today()), TALK_TODAY);
    mount(qc);
    expect(seen!.talk).toEqual({ data: { ...TALK_TODAY, for_day: today() }, isSuccess: true });
  });

  it("the one fetched ahead for today, when the phone's live read is yesterday's", () => {
    const qc = client();
    const at = Date.now() - DAY;
    qc.setQueryData(todayTalkKey(yesterday()), TALK_YESTERDAY, { updatedAt: at });
    qc.setQueryData(["toolboxTalk", today()], TALK_TODAY, { updatedAt: at });
    mount(qc);
    expect(seen!.talk).toEqual({ data: { ...TALK_TODAY, for_day: today() }, isSuccess: true });
  });

  it("no talk today, when the day fetched ahead has none", () => {
    const qc = client();
    const at = Date.now() - DAY;
    qc.setQueryData(todayTalkKey(yesterday()), TALK_YESTERDAY, { updatedAt: at });
    qc.setQueryData(["toolboxTalk", today()], null, { updatedAt: at });
    mount(qc);
    expect(seen!.talk).toEqual({ data: null, isSuccess: true });
  });

  it("unknown — never yesterday's talk — when nothing for today is on the phone", () => {
    const qc = client();
    qc.setQueryData(todayTalkKey(yesterday()), TALK_YESTERDAY, { updatedAt: Date.now() - DAY });
    mount(qc);
    expect(seen!.talk).toEqual({ data: undefined, isSuccess: false });
  });

  it("a talk handed out for today is today's even when its own date is older (a database with no talk of its own for today)", () => {
    const qc = client();
    const old = { ...TALK_YESTERDAY, id: "t-newest", talk_date: "2026-08-01" };
    qc.setQueryData(todayTalkKey(today()), old);
    mount(qc);
    expect(seen!.talk.data).toMatchObject({ id: "t-newest", for_day: today() });
  });
});

// Codex review of #666 (2026-09-27), finding 2: `dataUpdatedAt` is when a
// read FINISHED, not the day it asked about. A read that asked for Sep 27's
// talk at 23:59:59 and finished at 00:00:01 used to be taken as Sep 28's
// talk, over the Sep 28 talk the phone had fetched ahead — and signing it
// after midnight stamped today's time on yesterday's talk. The live read is
// now keyed by the day it asks for, so its answer can only ever be that day's.
describe("a read that crosses midnight", () => {
  it("does not hand out yesterday's talk over today's fetched-ahead one (Codex's case, as written)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 8, 27, 23, 59, 59));
    const qc = client();
    const yesterdayTalk = { ...TALK_YESTERDAY, talk_date: "2026-09-27" };
    const todayTalk = { ...TALK_TODAY, talk_date: "2026-09-28" };
    let resolveRead!: (v: typeof yesterdayTalk) => void;
    const delayed = new Promise<typeof yesterdayTalk>((r) => (resolveRead = r));
    const read = qc.fetchQuery({ queryKey: ["todayTalk"], queryFn: () => delayed });
    qc.setQueryData(["toolboxTalk", todayTalk.talk_date], todayTalk);
    vi.setSystemTime(new Date(2026, 8, 28, 0, 0, 1));
    resolveRead(yesterdayTalk);
    await read;
    mount(qc);
    expect(seen!.talk.data?.id).toBe(todayTalk.id);
  });

  it("does not hand out yesterday's talk when the read was for yesterday's day and finished after midnight", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 8, 27, 23, 59, 59));
    const qc = client();
    const yesterdayTalk = { ...TALK_YESTERDAY, talk_date: "2026-09-27" };
    const todayTalk = { ...TALK_TODAY, talk_date: "2026-09-28" };
    let resolveRead!: (v: typeof yesterdayTalk) => void;
    const delayed = new Promise<typeof yesterdayTalk>((r) => (resolveRead = r));
    const read = qc.fetchQuery({ queryKey: todayTalkKey("2026-09-27"), queryFn: () => delayed });
    qc.setQueryData(["toolboxTalk", "2026-09-28"], todayTalk);
    vi.setSystemTime(new Date(2026, 8, 28, 0, 0, 1));
    resolveRead(yesterdayTalk);
    await read;
    mount(qc);
    expect(seen!.talk.data).toMatchObject({ id: todayTalk.id, for_day: "2026-09-28" });
  });

  it("moves an open screen to the new day's talk by itself at midnight", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(new Date(2026, 8, 27, 23, 59, 0));
    const qc = client();
    const sep27 = { ...TALK_YESTERDAY, id: "t-27", talk_date: "2026-09-27" };
    const sep28 = { ...TALK_TODAY, id: "t-28", talk_date: "2026-09-28" };
    qc.setQueryData(todayTalkKey("2026-09-27"), sep27);
    qc.setQueryData(["toolboxTalk", "2026-09-28"], sep28);
    mount(qc);
    expect(seen!.talk.data).toMatchObject({ id: "t-27", for_day: "2026-09-27" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2 * 60_000);
    });
    expect(seen!.talk.data).toMatchObject({ id: "t-28", for_day: "2026-09-28" });
  });
});

// Codex review of #666 (2026-09-27), finding 1: the confirmed row was written
// into the cache without stopping a read that had asked Forge before the
// signature was filed. That read then landed "unsigned" over the
// confirmation — and with the signature gone from the phone's queue, the gate
// asked for a second signature (a new client id).
describe("a signature Forge has confirmed", () => {
  it("is not erased by a read that asked before it was filed (Codex's case, as written)", async () => {
    const qc = client();
    qc.setQueryData(["toolboxToday", ME], null);
    mount(qc);
    let resolveRead!: (v: null) => void;
    const delayed = new Promise<null>((r) => (resolveRead = r));
    const read = qc.fetchQuery({ queryKey: ["toolboxToday", ME], queryFn: () => delayed, staleTime: 0 });
    const sig = signature();
    await act(async () => {
      await outbox.enqueueToolboxSign(sig, null);
    });
    const row = { id: "confirmed", profile_id: ME, signed_at: sig.signedAt };
    rpc.mockResolvedValue({ data: row, error: null });
    online();
    await act(async () => {
      await outbox.drain();
    });
    expect(seen!.done.data?.id).toBe("confirmed");
    await act(async () => {
      resolveRead(null);
      await read;
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(seen!.done.data?.id).toBe("confirmed");
    expect(seen!.done).toMatchObject({ isSuccess: true, pending: false });
    // The cache itself still holds the confirmation, not the late answer.
    expect((qc.getQueryData(["toolboxToday", ME]) as { id?: string } | null)?.id).toBe("confirmed");
  });

  it("counts when no gate was on screen as it was sent, and after a reload", async () => {
    const qc = client();
    // What the phone read this morning, before signing: not signed.
    qc.setQueryData(["toolboxToday", ME], null);
    const sig = signature();
    await outbox.enqueueToolboxSign(sig, null);
    rpc.mockResolvedValue({ data: { id: "confirmed-2", profile_id: ME, signed_at: sig.signedAt }, error: null });
    online();
    await outbox.drain();
    expect(await outbox.listAll()).toEqual([]);
    // A gate opens afterwards, over the stale "not signed" read.
    mount(qc);
    expect(seen!.done).toMatchObject({ isSuccess: true, pending: false, data: { id: "confirmed-2" } });
    // The app is reloaded: memory is gone, the phone's storage is not.
    act(() => root?.unmount());
    forgetConfirmedSignatures({ memoryOnly: true });
    const again = client();
    again.setQueryData(["toolboxToday", ME], null);
    mount(again);
    expect(seen!.done).toMatchObject({ isSuccess: true, pending: false, data: { id: "confirmed-2" } });
  });

  it("counts only for the day it was signed, and only for its signer", async () => {
    const sig = signature({ signedAt: new Date(Date.now() - DAY).toISOString() });
    await outbox.enqueueToolboxSign(sig, null);
    rpc.mockResolvedValue({ data: { id: "confirmed-old", profile_id: ME, signed_at: sig.signedAt }, error: null });
    online();
    await outbox.drain();
    const qc = client();
    qc.setQueryData(["toolboxToday", ME], null);
    qc.setQueryData(["toolboxToday", "someone-else"], null);
    mount(qc);
    expect(seen!.done).toMatchObject({ data: null, isSuccess: true, pending: false });
  });
});
