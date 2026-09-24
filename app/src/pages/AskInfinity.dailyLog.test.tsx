// @vitest-environment happy-dom
//
// The daily log through the real Ask page (crew redesign K2.7). The rules
// from docs/ai-daily-logs-integration.md, proven end to end on the page:
//  - the very FIRST message ("Build today's daily log — I set six frames with
//    Ben") already carries the draft (awaited fresh start(), not a stale
//    closure), goes as a field request, and its answers land on the card;
//  - a voice memo takes the same path with its recording behind it;
//  - photos attach to the job showing when picked, Save appends through
//    append_daily_log_contribution against the revision the person saw, and
//    each photo reports its own status after the receipt;
//  - a reply with no saved message behind it is refused and said so.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetUnsavedWork } from "../lib/pwa/unsavedWork";

const USER = "00000000-0000-4000-8000-00000000a001";
const JOB = "00000000-0000-4000-8000-000000000090";
const CONV = "conversation-1";
const asked = vi.hoisted(() => ({
  calls: [] as { question: string; field: Record<string, unknown> | null; dailyLog: Record<string, unknown> | null }[],
  /** How the fake server answers: with the tool inputs it "heard". */
  toolInputs: [] as unknown[],
  /** Drop the evidence ids from the reply (a malformed server) to prove refusal. */
  noEvidence: false,
}));
const phone = vi.hoisted(() => ({ transcribe: false, onFiles: null as null | ((files: File[]) => Promise<void>), saves: [] as Record<string, unknown>[], queued: [] as string[] }));

vi.mock("../lib/queryClient", async () => {
  const { QueryClient } = await import("@tanstack/react-query");
  return { queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }) };
});
vi.mock("../lib/install/api", () => ({ getRealProfile: async () => ({ id: USER, name: "Ana", display_name: "Ana", role: "installer" }) }));
vi.mock("../lib/useEffectiveRole", () => ({
  useEffectiveRole: () => ({ effectiveRole: "installer", realRole: "installer", isPreviewing: false, isLoading: false, grants: {} }),
}));
vi.mock("../lib/customWork/api", () => ({ listWorkSessions: async () => [], listWorkUnits: async () => [] }));
vi.mock("../lib/api", () => ({ listProjects: async () => [{ id: JOB, job_code: "SMITH", name: "Smith Residence" }] }));
vi.mock("../lib/signedIn", () => ({ signedInEmail: () => "ana@example.test", rememberSignedIn: () => {} }));
vi.mock("../lib/useAskSessionActor", () => ({ useAskSessionActor: () => USER }));
vi.mock("../components/hexPortal/LearningPanel", () => ({ LearningPanel: () => null }));
vi.mock("../components/hexPortal/LearningCard", () => ({ LearningCard: () => null }));
vi.mock("../components/hexPortal/LearningReviewForm", () => ({ LearningReviewForm: () => null }));
vi.mock("../lib/hexPortal", () => ({ findPortalGuidance: async () => ({ items: [], enabled: false }) }));
vi.mock("../lib/knowledge", () => ({
  // The fake Ask function: exactly what the edge function does with a
  // daily-log context — answers come back tied to the request and conversation.
  askInfinity: async (question: string, _history: unknown, field: Record<string, unknown> | undefined, extra: { dailyLog?: Record<string, unknown> | null }) => {
    const dailyLog = extra?.dailyLog ?? null;
    asked.calls.push({ question, field: field ?? null, dailyLog });
    if (!dailyLog || !field) return { answer: "Which unit are you on?", sources: [] };
    return {
      answer: "Got it. Which job is this log for?",
      sources: [],
      dailyLog: {
        draft_id: dailyLog.draft_id, actor_id: dailyLog.actor_id, tool_inputs: asked.toolInputs,
        request_id: asked.noEvidence ? null : field.request_id, conversation_id: asked.noEvidence ? null : field.conversation_id,
      },
    };
  },
  liveAnswer: () => null,
  shouldUseLLM: () => true,
}));
vi.mock("../lib/brain/answer", () => ({ askBrain: () => ({ kind: "none", hits: [] }), getBrainIndex: () => ({}) }));
vi.mock("../lib/brain/catalogCache", () => ({ currentCatalog: () => ({ types: [] }), refreshCatalogCache: async () => ({ types: [] }) }));
vi.mock("../lib/brain/askLog", () => ({ logAskedQuestion: () => {} }));
vi.mock("../lib/offline/outbox", () => ({
  pendingClockWrites: async () => 0,
  MAX_BLOB_BYTES: 25 * 1024 * 1024,
  getPhotoUploadProgress: async () => ({ pending: 0, failed: 0, uploaded: 0 }),
  enqueueUpload: async () => "queued",
  listFailed: async () => [],
  retryFailed: async () => {},
  subscribe: () => () => {},
  subscribeSynced: () => () => {},
}));
vi.mock("../lib/customWork/queue", () => ({ readWorkQueue: () => [] }));
vi.mock("../lib/supabase", () => ({ supabaseConfigured: true, supabase: { auth: { getSession: async () => ({ data: { session: { user: { id: USER } } } }) } } }));
vi.mock("../lib/fieldAsk", () => ({
  FIELD_QUERY_ROOTS: [],
  currentConversation: () => CONV,
  startNewConversation: () => "conversation-2",
  dropUnsent: async () => {},
  keepUnsent: async () => {},
  listUnsent: async () => [],
  loadConversation: async () => [],
  memoPlaybackUrl: async () => null,
  phoneTimingPending: async () => false,
  readClockVersion: async () => 1,
  runVoiceSteps: async (steps: { keep: (t: string, e: string) => Promise<boolean>; transcribe: () => Promise<string>; send: (w: string, p: string) => void }) => {
    const kept = await steps.keep("", "pending");
    const words = await steps.transcribe();
    steps.send(words, "memo/path");
    return { outcome: "sent", keptOnPhone: kept };
  },
  sessionUserIs: async () => true,
  uploadMemo: async () => "memo/path",
}));
const mic = vi.hoisted(() => ({ onComplete: null as null | ((b: Blob) => void), resolveStart: null as null | (() => void) }));
vi.mock("../lib/voiceRecording", () => ({
  startVoiceRecording: (o: { onComplete: (b: Blob) => void }) => new Promise<{ stop: () => void; cancel: () => void }>((resolve) => {
    mic.onComplete = o.onComplete;
    mic.resolveStart = () => resolve({ stop: () => {}, cancel: () => {} });
  }),
}));
vi.mock("../lib/dictation", () => ({ transcribeDescription: async () => "Build today's daily log. I flashed units 3 and 4 with Ben." }));
// The card's camera/library inputs: the test hands files straight to onFiles.
vi.mock("../lib/photo/usePhotoPicker", () => ({
  usePhotoPicker: ({ onFiles }: { onFiles: (files: File[]) => Promise<void> }) => { phone.onFiles = onFiles; return { openCamera: () => {}, openLibrary: () => {}, inputs: null }; },
}));
// Stamping needs a canvas; the photo is prepared as the pipeline would.
vi.mock("../lib/aiDailyLogs/photos", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/aiDailyLogs/photos")>();
  return {
    ...real,
    preparePhoto: async (file: File) => ({ ok: true, blob: file, photo: { id: `photo-${file.name}`, caption: null, takenAt: "2026-09-23T15:00:00Z", lat: null, lng: null, accuracyM: null, bytes: file.size } }),
  };
});
// The only writer, and the shared log as another person left it.
vi.mock("../lib/aiDailyLogs/save", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/aiDailyLogs/save")>();
  return {
    ...real,
    readSharedLog: async () => ({ id: "log-1", revision: 2, notes: "Frank: framed the north wall", headline: null, day_flow: null, weather: null, reflection: null, filed_by: "frank", filed_by_name: "Frank", updated_at: "2026-09-23T14:00:00Z" }),
    sendContribution: async (payload: Record<string, unknown>) => {
      phone.saves.push(payload);
      return { kind: "receipt", receipt: { status: "saved", contribution_id: payload.id, log_id: "log-1", project_id: payload.projectId, log_date: payload.logDate, actor_id: USER, actor_name: "Ana", base_revision: 2, saved_revision: 3, created_log: false, saved_at: "2026-09-23T16:00:00Z", photo_ids: payload.photoIds, log: { id: "log-1", revision: 3, notes: "…", headline: null, day_flow: null, weather: null, reflection: null, filed_by: "frank", filed_by_name: "Frank", updated_at: "2026-09-23T16:00:00Z" } } };
    },
    readServerPhotoStatus: async () => [],
    queueSavedPhotos: async (draft: { photos: { id: string }[] }, deps: { recordQueued: (id: string) => Promise<void> }) => {
      for (const p of draft.photos) { phone.queued.push(p.id); await deps.recordQueued(p.id); }
      return { draft, failed: [] };
    },
  };
});

import { AskInfinity } from "./AskInfinity";

let root: Root | null = null;
let host: HTMLDivElement | null = null;
const settle = async (n = 8) => { for (let i = 0; i < n; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
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
const button = (text: string) => [...host!.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === text) ?? null;
const field = (label: string) => host!.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${label}"]`);

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  asked.calls = []; asked.noEvidence = false;
  asked.toolInputs = [{ work_completed: "Set six frames on the east wall", people: "Ben", unknown: [] }];
  phone.transcribe = false; phone.onFiles = null; phone.saves = []; phone.queued = [];
  mic.onComplete = null; mic.resolveStart = null;
  vi.stubGlobal("URL", { ...URL, createObjectURL: () => "blob:photo", revokeObjectURL: () => {} });
});
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null; resetUnsavedWork(); vi.unstubAllGlobals(); });

describe("the daily log through Ask", () => {
  it("the first typed message carries the fresh draft as a field request, and its answers land on the card", async () => {
    await mount();
    expect(host!.querySelector(".ai-log-card")).toBeNull();
    await ask("Build today's daily log — I set six frames on the east wall with Ben");
    expect(asked.calls).toHaveLength(1);
    const call = asked.calls[0];
    // Evidence first: a field request under this account, in this conversation…
    expect(call.field).toMatchObject({ actor_id: USER, conversation_id: CONV, input_kind: "text" });
    // …carrying the draft the awaited start() returned — not a stale null.
    expect(call.dailyLog).toMatchObject({ actor_id: USER, log_date: expect.any(String), answers: {}, photo_count: 0 });
    expect(typeof call.dailyLog?.draft_id).toBe("string");
    // The card opened and took the answers, sourced to the model.
    expect(host!.querySelector(".ai-log-card")).not.toBeNull();
    expect(field("Work completed")?.value).toBe("Set six frames on the east wall");
    expect(field("People involved")?.value).toBe("Ben");
    // Nothing claims a save: the card says the log is shared and Save is the person's.
    expect(host!.textContent).not.toContain("Nothing was saved yet");
    expect(button("Save daily log")).not.toBeNull();
  });

  it("a voice memo takes the same path, with its recording behind the request", async () => {
    await mount();
    await act(async () => host!.querySelector<HTMLButtonElement>('button[aria-label="Record a voice message"]')!.click());
    await act(async () => mic.resolveStart?.());
    await settle();
    await act(async () => mic.onComplete?.(new Blob(["audio"], { type: "audio/webm" })));
    await settle(12);
    expect(asked.calls).toHaveLength(1);
    expect(asked.calls[0].question).toContain("flashed units 3 and 4");
    expect(asked.calls[0].field).toMatchObject({ input_kind: "voice", audio_path: "memo/path", conversation_id: CONV });
    expect(asked.calls[0].dailyLog).not.toBeNull();
    expect(field("Work completed")?.value).toBe("Set six frames on the east wall");
  });

  it("a reply with no saved message behind it adds nothing and says so", async () => {
    asked.noEvidence = true;
    await mount();
    await ask("Build today's daily log — I set six frames");
    expect(field("Work completed")?.value ?? "").toBe("");
    expect(host!.textContent).toContain("NOT added to your daily log draft");
  });

  it("photos go to the job showing when picked; Save appends against the revision the person saw; each photo then reports on its own", async () => {
    await mount();
    await ask("Build today's daily log — I set six frames on the east wall with Ben");
    // The job is the person's tap, never the chat's.
    await act(async () => button("Choose a job")!.click());
    await settle();
    await act(async () => button("SMITH · Smith Residence")!.click());
    await settle(12);
    expect(host!.textContent).toContain("Started by Frank");
    expect(host!.textContent).toContain("Frank: framed the north wall");
    // A photo, attached while SMITH is showing.
    await act(async () => { await phone.onFiles!([new File(["png"], "east-wall.png", { type: "image/png" })]); });
    await settle();
    expect(host!.textContent).toContain("Goes to SMITH · Smith Residence");
    // Save: the frozen payload names the job, the revision shown (2), the
    // answers, the photo and the ONE message the answers came from.
    await act(async () => button("Save daily log")!.click());
    await settle(12);
    expect(phone.saves).toHaveLength(1);
    expect(phone.saves[0]).toMatchObject({ actorId: USER, projectId: JOB, expectedRevision: 2, photoIds: ["photo-east-wall.png"] });
    expect((phone.saves[0].sourceRequestIds as string[]).length).toBe(1);
    expect((phone.saves[0].answers as Record<string, { value: string }>).work_completed.value).toBe("Set six frames on the east wall");
    expect(phone.saves[0].body).toContain("Photos: 1 attached");
    // The receipt is the server's, and the photo went to the queue on its own.
    expect(host!.textContent).toContain("Saved to the SMITH · Smith Residence log");
    expect(phone.queued).toEqual(["photo-east-wall.png"]);
    expect(host!.textContent).not.toContain("Nothing was saved yet");
  });
});
