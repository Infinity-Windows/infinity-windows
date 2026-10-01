// @vitest-environment happy-dom
//
// What this pins: on the Ask page, a live utterance is evidence first — the
// original audio is saved as a field memo BEFORE the words become an Ask
// request — and that request is an ordinary VOICE request bound to the
// signed-in account, answered through the same send() as push-to-talk. Words
// with no recording are never sent. The live conversation ends with the
// account or a real unmount, while same-app navigation keeps it alive.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { LiveOptions, LiveTurn } from "./liveAskSession";

const state = vi.hoisted(() => ({
  user: "crew-1",
  role: "owner",
  pilot: true,
  log: [] as string[],
  asked: [] as { q: string; meta: Record<string, unknown> | undefined }[],
  live: null as null | { options: LiveOptions; end: Mock },
  nav: false,
  shellNavigation: null as null | unknown,
}));

vi.mock("./queryClient", async () => {
  const { QueryClient } = await import("@tanstack/react-query");
  return { queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }) };
});
vi.mock("./install/api", () => ({ getRealProfile: async () => ({ id: state.user, name: "Crew", role: state.role }) }));
vi.mock("./useAskSessionActor", () => ({ useAskSessionActor: () => state.user }));
vi.mock("../components/hexPortal/LearningPanel", () => ({ LearningPanel: () => null }));
vi.mock("../components/hexPortal/LearningCard", () => ({ LearningCard: () => null }));
vi.mock("../components/hexPortal/LearningReviewForm", () => ({ LearningReviewForm: () => null }));
vi.mock("./hexPortal", () => ({ findPortalGuidance: async () => ({ items: [], enabled: false }) }));
vi.mock("./knowledge", () => ({
  askInfinity: async (q: string, _h: unknown, meta?: Record<string, unknown>) => {
    state.log.push(`ask:${String(meta?.audio_path)}`);
    state.asked.push({ q, meta });
    return { answer: "Your next unit is 5.", sources: [], navigation: state.nav ? { kind: "schedule" } : undefined, field: { request_id: meta?.request_id, receipts: [{ action_id: "a1", action: "start_unit", status: "needs_choice" }], checklist: null } };
  },
  liveAnswer: () => null,
  shouldUseLLM: () => true,
}));
vi.mock("./brain/answer", () => ({ askBrain: () => ({ kind: "none", hits: [] }), getBrainIndex: () => ({}) }));
vi.mock("./brain/catalogCache", () => ({ currentCatalog: () => ({ types: [] }), refreshCatalogCache: async () => ({ types: [] }) }));
vi.mock("./brain/askLog", () => ({ logAskedQuestion: () => {} }));
vi.mock("./offline/outbox", () => ({
  pendingClockWrites: async () => 0, MAX_BLOB_BYTES: 25 * 1024 * 1024,
  getPhotoUploadProgress: async () => ({ pending: 0, failed: 0, uploaded: 0 }), enqueueUpload: async () => "queued",
  listFailed: async () => [], retryFailed: async () => {}, subscribe: () => () => {}, subscribeSynced: () => () => {},
}));
vi.mock("./customWork/queue", () => ({ readWorkQueue: () => [] }));
vi.mock("./supabase", () => ({ supabaseConfigured: true, supabase: {} }));
vi.mock("./dictation", () => ({ transcribeDescription: async () => "what's my next unit" }));
vi.mock("../components/ask/FieldCards", () => ({ FieldChecklist: () => null, FieldReceiptCard: () => null }));
vi.mock("./fieldAsk", async (importOriginal) => {
  const real = await importOriginal<typeof import("./fieldAsk")>();
  return {
    // The real evidence order; only the phone store and the network are doubles.
    runVoiceSteps: real.runVoiceSteps,
    FIELD_QUERY_ROOTS: [],
    currentConversation: () => "conversation-1",
    startNewConversation: () => "conversation-2",
    dropUnsent: async () => {},
    keepUnsent: async (item: { text: string }) => { state.log.push(`keep:${item.text}`); },
    listUnsent: async () => [],
    loadConversation: async () => [],
    memoPlaybackUrl: async () => null,
    phoneTimingPending: async () => false,
    readClockVersion: async () => 7,
    sessionUserIs: async (id: string) => id === state.user,
    uploadMemo: async (uid: string, requestId: string) => { state.log.push("upload"); return `${uid}/${requestId}/memo.webm`; },
  };
});
vi.mock("./liveAskSession", () => ({
  startLiveSession: (options: LiveOptions) => {
    const end = vi.fn((reason: string) => options.onStatus("ended", reason));
    state.live = { options, end };
    return { end, status: "starting" };
  },
}));
vi.mock("./liveAskPilot", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./liveAskPilot")>()),
  liveAskPilotEnabled: () => state.pilot,
}));

import { AskInfinity } from "../pages/AskInfinity";

let root: Root | null = null;
let host: HTMLDivElement | null = null;
const settle = async () => { for (let i = 0; i < 8; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const render = (active = true) => root!.render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter><AskInfinity active={active} onLiveState={(next) => { state.shellNavigation = next.navigation; }} /></MemoryRouter>
  </QueryClientProvider>,
);
const mount = async () => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => render());
  await settle();
};
const button = (label: string) => host!.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
const startLive = async () => {
  await act(async () => button("Start live conversation")!.click());
  await act(async () => state.live!.options.onStatus("live"));
  await settle();
};
const turn = async (t: LiveTurn) => {
  let said = "";
  await act(async () => { said = await state.live!.options.handleTurn(t); });
  await settle();
  return said;
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.assign(state, { user: "crew-1", role: "owner", pilot: true, log: [], asked: [], live: null, nav: false, shellNavigation: null });
  vi.stubGlobal("URL", { ...URL, createObjectURL: () => "blob:held", revokeObjectURL: () => {} });
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null; host = null;
  vi.unstubAllGlobals();
});

describe("Live Ask on the Ask page", () => {
  it("keeps one live session when the shell hides Ask to show another screen", async () => {
    await mount();
    await startLive();
    const live = state.live!;
    await act(async () => render(false));
    await settle();
    expect(state.live).toBe(live);
    expect(live.end).not.toHaveBeenCalled();
    await act(async () => render(true));
    await settle();
    expect(state.live).toBe(live);
    expect(live.end).not.toHaveBeenCalled();
  });
  it("shows a verified route button and keeps it available to the live corner panel across screens", async () => {
    state.nav = true;
    await mount();
    await startLive();
    const live = state.live!;
    const said = await turn({ itemId: "n1", audio: new Blob(["pcm"], { type: "audio/webm" }) });
    expect(host!.querySelector('a[href="/my-schedule"]')?.textContent).toBe("Open my schedule");
    expect(state.shellNavigation).toEqual({ kind: "schedule" });
    expect(said).toContain("Take me there button");
    await act(async () => render(false));
    expect(live.end).not.toHaveBeenCalled();
    expect(state.shellNavigation).toEqual({ kind: "schedule" });
  });
  it("is not offered unless the pilot is on", async () => {
    state.pilot = false;
    await mount();
    expect(button("Start live conversation")).toBeNull();
    expect(button("Record a voice message")).not.toBeNull();
  });

  it("is hidden from installer accounts even in a pilot build", async () => {
    state.role = "installer";
    await mount();
    expect(button("Start live conversation")).toBeNull();
    expect(button("Record a voice message")).not.toBeNull();
  });

  it("saves the original audio BEFORE asking, as a voice request bound to this account", async () => {
    await mount();
    await startLive();
    const said = await turn({ itemId: "i1", audio: new Blob(["pcm"], { type: "audio/webm" }) });
    const upload = state.log.indexOf("upload");
    const ask = state.log.findIndex((l) => l.startsWith("ask:"));
    expect(state.log[0]).toBe("keep:"); // kept on the phone first
    expect(upload).toBeGreaterThan(0);
    expect(ask).toBeGreaterThan(upload);
    expect(state.asked).toHaveLength(1);
    const meta = state.asked[0].meta!;
    expect(meta).toMatchObject({ actor_id: "crew-1", input_kind: "voice", conversation_id: "conversation-1", clock_version: 7 });
    expect(meta.audio_path).toBe(`crew-1/${String(meta.request_id)}/memo.webm`);
    // The screen shows the words, the saved recording and the reply …
    expect(host!.textContent).toContain("what's my next unit");
    expect(host!.textContent).toContain("Your next unit is 5.");
    // … and the voice is told the choice is NOT done until it is tapped.
    expect(said).toMatch(/NOT done until they tap it/);
    expect(said).toContain("Your next unit is 5.");
  });

  it("never sends words that have no recording behind them", async () => {
    await mount();
    await startLive();
    const said = await turn({ itemId: "i1", audio: null });
    expect(state.asked).toHaveLength(0);
    expect(state.log).not.toContain("upload");
    expect(said).toMatch(/Not sent/);
  });

  it("keeps push-to-talk and typing out of the way while live, and back after End", async () => {
    await mount();
    await startLive();
    expect(button("Record a voice message")!.disabled).toBe(true);
    expect(host!.textContent).toContain("speak any time");
    await act(async () => button("End live conversation")!.click());
    await settle();
    expect(state.live!.end).toHaveBeenCalledWith("user");
    expect(button("Record a voice message")!.disabled).toBe(false);
    expect(host!.textContent).toContain("Live conversation ended.");
  });

  it("warns before the cap and continues the same Ask conversation on an explicit tap", async () => {
    await mount();
    await startLive();
    const first = state.live!;
    await act(async () => first.options.onTimeLimitSoon?.());
    expect(host!.textContent).toContain("About 30 seconds left");
    await act(async () => first.options.onStatus("ended", "cap"));
    expect(button("Continue live conversation")).not.toBeNull();
    await act(async () => button("Continue live conversation")!.click());
    expect(state.live).not.toBe(first);
    expect(state.live!.end).not.toHaveBeenCalled();
    expect(host!.textContent).not.toContain("About 30 seconds left");
  });

  it("ends when the signed-in account changes, and a late turn is not sent as the new person", async () => {
    state.nav = true;
    await mount();
    await startLive();
    const first = state.live!;
    await turn({ itemId: "n1", audio: new Blob(["pcm"], { type: "audio/webm" }) });
    expect(state.shellNavigation).toEqual({ kind: "schedule" });
    state.user = "crew-2";
    await act(async () => render());
    await settle();
    expect(first.end).toHaveBeenCalledWith("account");
    expect(state.shellNavigation).toBeNull();
    const askedBefore = state.asked.length;
    const said = await act(async () => first.options.handleTurn({ itemId: "i9", audio: new Blob(["pcm"]) }));
    await settle();
    expect(state.asked).toHaveLength(askedBefore);
    expect(said).toMatch(/different person|Not sent/);
  });

  it("ends when the person leaves Ask", async () => {
    await mount();
    await startLive();
    act(() => root!.unmount());
    root = null;
    expect(state.live!.end).toHaveBeenCalledWith("unmount");
  });
});
