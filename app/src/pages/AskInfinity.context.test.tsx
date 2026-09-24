// @vitest-environment happy-dom
//
// The context tag (crew redesign K2.3): opening Ask from a job/unit screen
// shows a clearable tag, every message carries it to the server, a card
// starts with it filled, and an account change on this phone drops it.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetUnsavedWork } from "../lib/pwa/unsavedWork";

const JOB = "00000000-0000-4000-8000-000000000100";
const OPENING = "00000000-0000-4000-8000-000000000200";
const who = vi.hoisted(() => ({ actor: "crew-1" as string | null }));
const sent = vi.hoisted(() => ({ calls: [] as { question: string; field: unknown; extra: unknown }[] }));

vi.mock("../lib/queryClient", async () => {
  const { QueryClient } = await import("@tanstack/react-query");
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(["projects"], [{ id: "00000000-0000-4000-8000-000000000100", job_code: "BLACK22", name: "Black Desert" }]);
  return { queryClient };
});
vi.mock("../lib/install/api", () => ({
  getRealProfile: async () => ({ id: who.actor, name: "Crew One", role: "installer" }),
}));
vi.mock("../lib/useEffectiveRole", () => ({
  useEffectiveRole: () => ({ effectiveRole: "installer", realRole: "installer", isPreviewing: false, isLoading: false, grants: {} }),
}));
vi.mock("../lib/customWork/api", () => ({ listWorkSessions: async () => [], listWorkUnits: async () => [] }));
vi.mock("../lib/useAskSessionActor", () => ({ useAskSessionActor: () => who.actor }));
vi.mock("../components/hexPortal/LearningPanel", () => ({ LearningPanel: () => null }));
vi.mock("../components/hexPortal/LearningCard", () => ({ LearningCard: () => null }));
vi.mock("../components/hexPortal/LearningReviewForm", () => ({ LearningReviewForm: () => null }));
vi.mock("../lib/hexPortal", () => ({ findPortalGuidance: async () => ({ items: [], enabled: false }) }));
vi.mock("../lib/knowledge", () => ({
  askInfinity: async (question: string, _history: unknown, field: unknown, extra: unknown) => {
    sent.calls.push({ question, field: field ?? null, extra });
    return { answer: "For BLACK22 · Black Desert, unit W-12 — what type is it?", sources: [] };
  },
  liveAnswer: () => null,
  shouldUseLLM: () => true,
}));
vi.mock("../lib/brain/answer", () => ({ askBrain: () => ({ kind: "none", hits: [] }), getBrainIndex: () => ({}) }));
vi.mock("../lib/brain/catalogCache", () => ({ currentCatalog: () => ({ types: [] }), refreshCatalogCache: async () => ({ types: [] }) }));
vi.mock("../lib/brain/askLog", () => ({ logAskedQuestion: () => {} }));
vi.mock("../lib/offline/outbox", () => ({
  pendingClockWrites: async () => 0,
  // The daily-log controller behind the Ask page reads the upload queue too.
  MAX_BLOB_BYTES: 25 * 1024 * 1024,
  getPhotoUploadProgress: async () => ({ pending: 0, failed: 0, uploaded: 0 }),
  enqueueUpload: async () => "queued",
  listFailed: async () => [],
  retryFailed: async () => {},
  subscribe: () => () => {},
  subscribeSynced: () => () => {},
}));
vi.mock("../lib/customWork/queue", () => ({ readWorkQueue: () => [] }));
vi.mock("../lib/supabase", () => ({ supabaseConfigured: true, supabase: {} }));
vi.mock("../lib/fieldAsk", () => ({
  FIELD_QUERY_ROOTS: [],
  currentConversation: () => "conversation-1",
  startNewConversation: () => "conversation-2",
  dropUnsent: async () => {},
  keepUnsent: async () => {},
  listUnsent: async () => [],
  loadConversation: async () => [],
  memoPlaybackUrl: async () => null,
  phoneTimingPending: async () => false,
  readClockVersion: async () => 1,
  runVoiceSteps: async () => ({ outcome: "failed", keptOnPhone: true, error: "offline" }),
  sessionUserIs: async () => true,
  uploadMemo: async () => "memo/path",
}));
vi.mock("../lib/voiceRecording", () => ({ startVoiceRecording: () => new Promise(() => {}) }));
vi.mock("../lib/dictation", () => ({ transcribeDescription: () => new Promise<string>(() => {}) }));

import { AskInfinity } from "./AskInfinity";

let root: Root | null = null;
let host: HTMLDivElement | null = null;
const settle = async () => { for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const tagState = { askContext: { project_id: JOB, project_label: null, unit_id: null, opening_id: OPENING, unit_label: "W-12" } };
const mount = async (state: unknown = tagState) => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root!.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[{ pathname: "/ask", state }]}><AskInfinity /></MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await settle();
};
const button = (text: string) => [...host!.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === text) ?? null;
const tagText = () => host!.querySelector(".ask-tag")?.textContent ?? null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  who.actor = "crew-1";
  sent.calls = [];
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove(); root = null; host = null;
  resetUnsavedWork();
});

describe("the context tag", () => {
  it("shows the job and unit Ask was opened from, naming the job from the cached jobs list", async () => {
    await mount();
    expect(tagText()).toContain("Asking about");
    expect(tagText()).toContain("BLACK22 · Black Desert · Unit W-12");
  });

  it("goes with every message and a card starts with it filled", async () => {
    await mount();
    await act(async () => button("Build a unit")!.click());
    await settle();
    expect(sent.calls).toHaveLength(1);
    expect(sent.calls[0].field).toMatchObject({ context: { project_id: JOB, opening_id: OPENING, unit_label: "W-12" } });
    expect(sent.calls[0].extra).toMatchObject({ contextTag: { project_id: JOB } });
    // Still there afterwards: it is confirmed by the reply, not consumed.
    expect(tagText()).toContain("Unit W-12");
  });

  it("is cleared with one tap, and then no message carries it", async () => {
    await mount();
    await act(async () => host!.querySelector<HTMLButtonElement>('button[aria-label="Clear the job tag"]')!.click());
    await settle();
    expect(host!.querySelector(".ask-tag")).toBeNull();
    await act(async () => button("Build a unit")!.click());
    await settle();
    expect((sent.calls[0].field as { context: unknown }).context).toBeNull();
    expect((sent.calls[0].extra as { contextTag: unknown }).contextTag).toBeNull();
  });

  it("is ignored when the screen that opened Ask sent something that is not a job", async () => {
    await mount({ askContext: { project_id: "not-a-uuid", unit_label: "4" } });
    expect(host!.querySelector(".ask-tag")).toBeNull();
  });

  it("is dropped when another account signs in on this phone", async () => {
    await mount();
    expect(tagText()).toContain("Unit W-12");
    who.actor = "crew-2";
    // Any re-render re-reads the (mocked) session actor: the same thing the
    // auth listener does when a different token lands.
    await act(async () => button("All actions")!.click());
    await settle();
    expect(host!.querySelector(".ask-tag")).toBeNull();
  });
});
