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
const { useTodayTalk, useToolboxToday } = await import("./useToolboxGate");
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
  online();
  for (const e of await outbox.listAll()) await outbox.discardFailed(e.id);
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
  it("the live read, when it was made today", () => {
    const qc = client();
    qc.setQueryData(["todayTalk"], TALK_TODAY);
    mount(qc);
    expect(seen!.talk).toEqual({ data: TALK_TODAY, isSuccess: true });
  });

  it("the one fetched ahead for today, when the live read is yesterday's", () => {
    const qc = client();
    const yesterday = Date.now() - DAY;
    qc.setQueryData(["todayTalk"], TALK_YESTERDAY, { updatedAt: yesterday });
    qc.setQueryData(["toolboxTalk", TALK_TODAY.talk_date], TALK_TODAY, { updatedAt: yesterday });
    mount(qc);
    expect(seen!.talk).toEqual({ data: TALK_TODAY, isSuccess: true });
  });

  it("no talk today, when the day fetched ahead has none", () => {
    const qc = client();
    const yesterday = Date.now() - DAY;
    qc.setQueryData(["todayTalk"], TALK_YESTERDAY, { updatedAt: yesterday });
    qc.setQueryData(["toolboxTalk", TALK_TODAY.talk_date], null, { updatedAt: yesterday });
    mount(qc);
    expect(seen!.talk).toEqual({ data: null, isSuccess: true });
  });

  it("unknown — never yesterday's talk — when nothing was fetched ahead for today", () => {
    const qc = client();
    qc.setQueryData(["todayTalk"], TALK_YESTERDAY, { updatedAt: Date.now() - DAY });
    mount(qc);
    expect(seen!.talk).toEqual({ data: undefined, isSuccess: false });
  });
});
