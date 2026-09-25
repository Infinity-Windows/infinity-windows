// @vitest-environment happy-dom
//
// Receipts (K2.5) on the Ask page: a reply that reads as done with no receipt
// gets "Nothing was saved yet" automatically; a receipt shows its real
// status; a report card or a lesson draft counts as evidence.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetUnsavedWork } from "../lib/pwa/unsavedWork";

const USER = "crew-1";
const reply = vi.hoisted(() => ({ next: {} as Record<string, unknown> }));

vi.mock("../lib/queryClient", async () => {
  const { QueryClient } = await import("@tanstack/react-query");
  return { queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }) };
});
vi.mock("../lib/install/api", () => ({ getRealProfile: async () => ({ id: USER, name: "Crew One", role: "installer" }) }));
vi.mock("../lib/useEffectiveRole", () => ({
  useEffectiveRole: () => ({ effectiveRole: "installer", realRole: "installer", isPreviewing: false, isLoading: false, grants: {} }),
}));
vi.mock("../lib/customWork/api", () => ({ listWorkSessions: async () => [], listWorkUnits: async () => [] }));
vi.mock("../lib/useAskSessionActor", () => ({ useAskSessionActor: () => USER }));
vi.mock("../components/hexPortal/LearningPanel", () => ({ LearningPanel: () => null }));
vi.mock("../components/hexPortal/LearningCard", () => ({ LearningCard: () => null }));
vi.mock("../components/hexPortal/LearningReviewForm", () => ({ LearningReviewForm: () => null }));
vi.mock("../lib/hexPortal", () => ({ findPortalGuidance: async () => ({ items: [], enabled: false }) }));
vi.mock("../lib/knowledge", () => ({
  askInfinity: async () => ({ sources: [], ...reply.next }),
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
const mount = async () => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => { root!.render(<QueryClientProvider client={client}><MemoryRouter><AskInfinity /></MemoryRouter></QueryClientProvider>); });
  await settle();
};
const ask = async (text: string) => {
  const el = host!.querySelector<HTMLInputElement>(".ask-input input")!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => { setter.call(el, text); el.dispatchEvent(new Event("input", { bubbles: true })); });
  await act(async () => { el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  await settle();
};
const unit = { unit_id: "u4", label: "4", type: "Bifold door", facts: {} };

beforeEach(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; reply.next = {}; });
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null; resetUnsavedWork(); });

describe("receipts on the Ask page", () => {
  it("contradicts a reply that reads as done with nothing behind it", async () => {
    reply.next = { answer: "Done — I've saved unit 4 with those details." };
    await mount();
    await ask("Unit 4 is a bifold door, save it");
    expect(host!.textContent).toContain("Nothing was saved yet");
    expect(host!.querySelector(".field-receipt")).toBeNull();
  });

  it("shows the receipt's real status and no contradiction when a receipt backs the words", async () => {
    reply.next = { answer: "Unit 4 has been saved.", field: { request_id: "r1", receipts: [{ action_id: "a1", action: "save_unit", status: "done", outcome: "created", unit }], checklist: null } };
    await mount();
    await ask("Unit 4 is a bifold door, save it");
    expect(host!.textContent).toContain("Saved in Forge");
    expect(host!.textContent).toContain("Unit 4 saved.");
    expect(host!.textContent).not.toContain("Nothing was saved yet");
  });

  it("a waiting choice says Needs your choice, even when the prose claims it started", async () => {
    reply.next = { answer: "I started your timer on unit 4.", field: { request_id: "r1", receipts: [{ action_id: "a1", action: "start_unit", status: "needs_choice", reason: "on_break", preview_hash: "h", options: [{ id: "end_break_and_start", label: "x" }, { id: "cancel", label: "y" }], unit }], checklist: null } };
    await mount();
    await ask("Start unit 4");
    expect(host!.textContent).toContain("Needs your choice");
    expect(host!.textContent).toContain("nothing has changed yet");
    expect(host!.textContent).not.toContain("Nothing was saved yet");
  });

  it("a checklist alone is not a receipt: the answers are kept for the conversation, and a done-claim is still contradicted", async () => {
    reply.next = { answer: "I've recorded unit 4 as a bifold door.", field: { request_id: "r1", receipts: [], checklist: { job: null, unit: [{ key: "label", status: "captured", value: "4", required_before_timing: true }, { key: "type_label", status: "captured", value: "Bifold door", required_before_timing: true }] } } };
    await mount();
    await ask("Unit 4 is a bifold door");
    expect(host!.textContent).toContain("nothing saved to the job yet");
    expect(host!.textContent).toContain("Nothing was saved yet");
  });

  it("an honest question needs no contradiction", async () => {
    reply.next = { answer: "Which unit are you on?" };
    await mount();
    await ask("Start my unit");
    expect(host!.textContent).not.toContain("Nothing was saved yet");
  });
});
