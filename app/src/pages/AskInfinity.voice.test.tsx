// @vitest-environment happy-dom
//
// What this pins: Ask's voice message counts as unsaved work from the moment
// the microphone is asked for until the recording is kept somewhere durable —
// and a recording the phone could NOT keep (the "held" card) counts for as
// long as it is on screen. The update banner reads the same registry
// (PwaBanners.test.tsx proves a claim stops every automatic reload), so this
// is the half that proves Ask makes the claim (independent review,
// 2026-09-23).
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hasUnsavedWork, resetUnsavedWork, unsavedWorkClaims } from "../lib/pwa/unsavedWork";

const USER = "crew-1";

vi.mock("../lib/queryClient", async () => {
  const { QueryClient } = await import("@tanstack/react-query");
  return { queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }) };
});
vi.mock("../lib/install/api", () => ({
  getRealProfile: async () => ({ id: USER, name: "Crew One", role: "installer" }),
}));
vi.mock("../lib/useAskSessionActor", () => ({ useAskSessionActor: () => USER }));
vi.mock("../components/hexPortal/LearningPanel", () => ({ LearningPanel: () => null }));
vi.mock("../components/hexPortal/LearningCard", () => ({ LearningCard: () => null }));
vi.mock("../components/hexPortal/LearningReviewForm", () => ({ LearningReviewForm: () => null }));
vi.mock("../lib/hexPortal", () => ({ findPortalGuidance: async () => ({ items: [], enabled: false }) }));
vi.mock("../lib/knowledge", () => ({
  askInfinity: async () => ({ answer: "", sources: [] }),
  liveAnswer: () => null,
  shouldUseLLM: () => false,
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
vi.mock("../lib/supabase", () => ({ supabaseConfigured: false, supabase: {} }));

// The phone's own storage for a message the server did not get. Whether it
// works is the whole difference between "held in memory" and "kept".
const phone = vi.hoisted(() => ({ canKeep: false, transcribe: false, transcribedWith: null as null | string }));
vi.mock("../lib/fieldAsk", () => ({
  FIELD_QUERY_ROOTS: [],
  currentConversation: () => "conversation-1",
  startNewConversation: () => "conversation-2",
  dropUnsent: async () => {},
  keepUnsent: async () => {
    if (!phone.canKeep) throw new Error("no storage");
  },
  listUnsent: async () => [],
  loadConversation: async () => [],
  memoPlaybackUrl: async () => null,
  phoneTimingPending: async () => false,
  readClockVersion: async () => 1,
  // The real runVoiceSteps tries keep() first and carries on from there; this
  // double runs Ask's own keep() — which is what clears the held card — and
  // then reports that the rest did not get through (no signal).
  runVoiceSteps: async (steps: { keep: (text: string, error: string) => Promise<boolean>; transcribe: () => Promise<string>; send: (words: string, path: string) => void }) => {
    // K2.6: with `transcribe` on, the double runs the real order — words
    // first, then send — so the transcript bubble is on screen at once.
    if (phone.transcribe) {
      const kept = await steps.keep("", "pending");
      const words = await steps.transcribe();
      steps.send(words, "memo/path");
      return { outcome: "sent", keptOnPhone: kept };
    }
    return {
      outcome: "failed",
      keptOnPhone: await steps.keep("", "offline"),
      error: "offline",
    };
  },
  sessionUserIs: async () => true,
  uploadMemo: async () => "memo/path",
}));

const mic = vi.hoisted(() => ({
  onComplete: null as null | ((blob: Blob) => void),
  resolveStart: null as null | (() => void),
}));
vi.mock("../lib/voiceRecording", () => ({
  startVoiceRecording: (options: { onComplete: (blob: Blob) => void }) =>
    new Promise<{ stop: () => void; cancel: () => void }>((resolve) => {
      mic.onComplete = options.onComplete;
      mic.resolveStart = () => resolve({ stop: () => {}, cancel: () => {} });
    }),
}));
vi.mock("../lib/dictation", () => ({
  transcribeDescription: (_blob: Blob, lang: string) => {
    phone.transcribedWith = lang;
    return phone.transcribe ? Promise.resolve("Unidad cuatro is a bifold, dos paneles") : new Promise<string>(() => {});
  },
}));

import { AskInfinity } from "./AskInfinity";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

const settle = async () => {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

const mount = async () => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root!.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <AskInfinity />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await settle();
};

const micButton = () =>
  host!.querySelector<HTMLButtonElement>('button[aria-label="Record a voice message"]');

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mic.onComplete = null;
  mic.resolveStart = null;
  phone.canKeep = false;
  phone.transcribe = false;
  phone.transcribedWith = null;
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: () => "blob:held",
    revokeObjectURL: () => {},
  });
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  resetUnsavedWork();
  vi.unstubAllGlobals();
});

describe("Ask's voice message and unsaved work", () => {
  it("shows the mic with nothing claimed", async () => {
    await mount();
    expect(micButton()).not.toBeNull();
    expect(hasUnsavedWork()).toBe(false);
  });

  it("claims while the microphone is being opened, and while recording", async () => {
    await mount();
    await act(async () => micButton()!.click());
    await settle();
    // Still waiting on the permission dialog: the button is out of action
    // and the claim is already held.
    expect(micButton()!.disabled).toBe(true);
    expect(unsavedWorkClaims()).toBe(1);

    await act(async () => mic.resolveStart?.());
    await settle();
    expect(host!.querySelector('button[aria-label^="Stop and send"]')).not.toBeNull();
    expect(unsavedWorkClaims()).toBe(1);
  });

  it("keeps the claim for a recording the phone could not keep", async () => {
    await mount();
    await act(async () => micButton()!.click());
    await act(async () => mic.resolveStart?.());
    await settle();
    await act(async () => mic.onComplete?.(new Blob(["audio"], { type: "audio/webm" })));
    await settle();
    // Not kept on the phone, not on the server: the held card is the only
    // copy, and it says so.
    expect(host!.textContent).toContain("NOT saved yet");
    expect(host!.textContent).toContain("Send now");
    expect(unsavedWorkClaims()).toBe(1);
  });

  it("releases once the recording is kept on the phone, even though it was not sent", async () => {
    phone.canKeep = true;
    await mount();
    await act(async () => micButton()!.click());
    await act(async () => mic.resolveStart?.());
    await settle();
    await act(async () => mic.onComplete?.(new Blob(["audio"], { type: "audio/webm" })));
    await settle();
    // Kept in the phone's own store: no held card, nothing only in memory.
    expect(host!.textContent).not.toContain("NOT saved yet");
    expect(host!.textContent).toContain("connection");
    expect(hasUnsavedWork()).toBe(false);
  });

  it("hears English, Spanish or a mix, and shows the transcript the moment it is written out (K2.6)", async () => {
    phone.canKeep = true;
    phone.transcribe = true;
    await mount();
    await act(async () => micButton()!.click());
    await act(async () => mic.resolveStart?.());
    await settle();
    await act(async () => mic.onComplete?.(new Blob(["audio"], { type: "audio/webm" })));
    await settle();
    // No forced language: the provider hears what was said.
    expect(phone.transcribedWith).toBe("auto");
    // The person's own words are on screen as their bubble, ahead of any reply.
    const mine = [...host!.querySelectorAll(".ask-bubble.mine")].map((b) => b.textContent);
    expect(mine).toContain("Unidad cuatro is a bifold, dos paneles");
  });

  it("releases on unmount", async () => {
    await mount();
    await act(async () => micButton()!.click());
    await act(async () => mic.resolveStart?.());
    await settle();
    expect(unsavedWorkClaims()).toBe(1);
    await act(async () => root?.unmount());
    root = null;
    expect(unsavedWorkClaims()).toBe(0);
  });
});
