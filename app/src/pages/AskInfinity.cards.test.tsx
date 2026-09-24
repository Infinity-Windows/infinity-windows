// @vitest-environment happy-dom
//
// Action cards on the Ask page (crew redesign K2.2): four per role from the
// registry (an unshipped action is simply absent), gone the moment the
// composer has text or a recording starts, back with "Actions", and a card
// tap never discards what was typed. "All actions" lists the unshipped ones
// honestly with the screen to use instead (K2.1).
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetUnsavedWork } from "../lib/pwa/unsavedWork";

const USER = "crew-1";
const who = vi.hoisted(() => ({ role: "installer" as string, sessions: [] as unknown[], units: [] as unknown[] }));
const sent = vi.hoisted(() => ({ questions: [] as string[], fields: [] as unknown[] }));

vi.mock("../lib/queryClient", async () => {
  const { QueryClient } = await import("@tanstack/react-query");
  return { queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }) };
});
vi.mock("../lib/install/api", () => ({
  getRealProfile: async () => ({ id: USER, name: "Crew One", role: who.role }),
}));
vi.mock("../lib/useEffectiveRole", () => ({
  useEffectiveRole: () => ({ effectiveRole: who.role, realRole: who.role, isPreviewing: false, isLoading: false, grants: {} }),
}));
vi.mock("../lib/customWork/api", () => ({
  listWorkSessions: async () => who.sessions,
  listWorkUnits: async () => who.units,
}));
vi.mock("../lib/useAskSessionActor", () => ({ useAskSessionActor: () => USER }));
vi.mock("../components/hexPortal/LearningPanel", () => ({ LearningPanel: () => null }));
vi.mock("../components/hexPortal/LearningCard", () => ({ LearningCard: () => null }));
vi.mock("../components/hexPortal/LearningReviewForm", () => ({ LearningReviewForm: () => null }));
vi.mock("../lib/hexPortal", () => ({ findPortalGuidance: async () => ({ items: [], enabled: false }) }));
vi.mock("../lib/knowledge", () => ({
  askInfinity: async (question: string, _history: unknown, field: unknown) => {
    sent.questions.push(question);
    sent.fields.push(field ?? null);
    return { answer: "Which unit are you on?", sources: [] };
  },
  liveAnswer: () => null,
  shouldUseLLM: () => true,
}));
vi.mock("../lib/brain/answer", () => ({
  askBrain: () => ({ kind: "none", hits: [] }),
  getBrainIndex: () => ({}),
}));
vi.mock("../lib/brain/catalogCache", () => ({
  currentCatalog: () => ({ types: [] }),
  refreshCatalogCache: async () => ({ types: [] }),
}));
vi.mock("../lib/brain/askLog", () => ({ logAskedQuestion: () => {} }));
vi.mock("../lib/offline/outbox", () => ({ pendingClockWrites: async () => 0 }));
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
const mic = vi.hoisted(() => ({ resolveStart: null as null | (() => void) }));
vi.mock("../lib/voiceRecording", () => ({
  startVoiceRecording: () =>
    new Promise<{ stop: () => void; cancel: () => void }>((resolve) => {
      mic.resolveStart = () => resolve({ stop: () => {}, cancel: () => {} });
    }),
}));
vi.mock("../lib/dictation", () => ({ transcribeDescription: () => new Promise<string>(() => {}) }));

import { AskInfinity } from "./AskInfinity";

let root: Root | null = null;
let host: HTMLDivElement | null = null;
const settle = async () => {
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};
const mount = async () => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root!.render(<QueryClientProvider client={client}><MemoryRouter><AskInfinity /></MemoryRouter></QueryClientProvider>);
  });
  await settle();
};
const cardNames = () => [...host!.querySelectorAll<HTMLButtonElement>(".ask-cards .ask-card")].map((b) => b.textContent?.trim());
const input = () => host!.querySelector<HTMLInputElement>(".ask-input input")!;
const type = async (value: string) => {
  const el = input();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => { setter.call(el, value); el.dispatchEvent(new Event("input", { bubbles: true })); });
  await settle();
};
const button = (text: string) => [...host!.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === text) ?? null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  who.role = "installer"; who.sessions = []; who.units = [];
  sent.questions = []; sent.fields = [];
  mic.resolveStart = null;
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove(); root = null; host = null;
  resetUnsavedWork();
});

describe("action cards", () => {
  it("an installer sees Build a unit · Daily log · My hours · All actions, and no Take supplies", async () => {
    await mount();
    expect(cardNames()).toEqual(["Build a unit", "Daily log", "My hours", "All actions"]);
    expect(host!.textContent).not.toContain("Take supplies");
  });

  it("a supervisor sees Plan the schedule · Job summary · Hours report, and no Crew status", async () => {
    who.role = "supervisor";
    await mount();
    expect(cardNames()).toEqual(["Plan the schedule", "Job summary", "Hours report", "All actions"]);
  });

  it("a running unit puts Finish unit N first", async () => {
    who.sessions = [{ id: "s1", profile_id: USER, unit_id: "u4", ended_at: null, started_at: "2026-09-23T13:00:00Z" }];
    who.units = [{ id: "u4", label: "4", type_label: "Bifold door", project_id: "p1" }];
    await mount();
    expect(cardNames()[0]).toBe("Finish unit 4");
  });

  it("hides the cards as soon as the composer has text, brings them back with Actions, and a card tap keeps the typed text", async () => {
    await mount();
    await type("Unit 7 is a slider");
    expect(host!.querySelector(".ask-cards")).toBeNull();
    const reopen = button("Actions");
    expect(reopen).not.toBeNull();
    await act(async () => reopen!.click());
    await settle();
    expect(cardNames()).toContain("Build a unit");
    await act(async () => button("Build a unit")!.click());
    await settle();
    // The card sent its own words as a field request; the typed text stayed.
    expect(sent.questions).toEqual(["Set up the unit I'm working on"]);
    expect(sent.fields[0]).toMatchObject({ actor_id: USER, input_kind: "text" });
    expect(input().value).toBe("Unit 7 is a slider");
    expect(host!.querySelector(".ask-cards")).toBeNull();
  });

  it("hides the cards while a recording is starting or running", async () => {
    await mount();
    await act(async () => host!.querySelector<HTMLButtonElement>('button[aria-label="Record a voice message"]')!.click());
    await settle();
    expect(host!.querySelector(".ask-cards")).toBeNull();
    await act(async () => mic.resolveStart?.());
    await settle();
    expect(host!.querySelector(".ask-cards")).toBeNull();
  });

  it("All actions lists Take supplies as not in Ask yet, with the Supplies screen, and what the AI never does", async () => {
    await mount();
    await act(async () => button("All actions")!.click());
    await settle();
    const all = host!.querySelector(".ask-all-actions")!;
    expect(all.textContent).toContain("Take supplies");
    expect(all.textContent).toContain("not in Ask yet (release 4)");
    const link = [...all.querySelectorAll<HTMLAnchorElement>("a")].find((a) => a.textContent?.includes("Use the Supplies screen for this"));
    expect(link?.getAttribute("href")).toBe("/supplies");
    expect(all.textContent).toContain("Forge AI never:");
    expect(all.textContent).toContain("Sign a toolbox talk");
    expect(all.textContent).not.toContain("Plan the schedule");
    // A quick question from here is not an action: no field request.
    await act(async () => button("What is flashing?")!.click());
    await settle();
    expect(sent.questions).toEqual(["What is flashing?"]);
    expect(sent.fields[0]).toBeNull();
  });
});
