// @vitest-environment happy-dom
//
// The owner's three notes from the live Ask screen (2026-09-24), dictating a
// daily log on an iPhone:
//  1. "the chat bar that shows that it's recording should follow me so that I
//     can scroll with it and click the square pulsing button to end it";
//  2. "Every time I click the microphone, a lot of other options open up when
//     I previously minimized them";
//  3. "the chat goes through above those options so I have to scroll up to see
//     the response … it should be the most recent thing I see."
// happy-dom has no layout, so where each message sits is stubbed per test; the
// phone-size run in e2e/ask-daily-log.spec.ts proves the real positions.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetUnsavedWork } from "../lib/pwa/unsavedWork";
import { REVEAL_GAP } from "../lib/askLatest";

const who = vi.hoisted(() => ({ id: "crew-1" }));
const server = vi.hoisted(() => ({ questions: [] as string[], hold: null as null | Promise<void> }));
const words = vi.hoisted(() => ({ held: false, release: null as null | ((text: string) => void) }));
const mic = vi.hoisted(() => ({
  onComplete: null as null | ((blob: Blob) => void),
  resolveStart: null as null | (() => void),
  stops: 0,
}));
/** Where each message row is on screen: data-msg index → [top, bottom]. */
const layout = vi.hoisted(() => ({ rows: new Map<number, [number, number]>() }));

vi.mock("../lib/queryClient", async () => {
  const { QueryClient } = await import("@tanstack/react-query");
  return { queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }) };
});
vi.mock("../lib/install/api", () => ({
  getRealProfile: async () => ({ id: who.id, name: "Crew One", role: "installer" }),
}));
vi.mock("../lib/useEffectiveRole", () => ({
  useEffectiveRole: () => ({ effectiveRole: "installer", realRole: "installer", isPreviewing: false, isLoading: false, grants: {} }),
}));
vi.mock("../lib/customWork/api", () => ({ listWorkSessions: async () => [], listWorkUnits: async () => [] }));
vi.mock("../lib/useAskSessionActor", () => ({ useAskSessionActor: () => who.id }));
vi.mock("../components/hexPortal/LearningPanel", () => ({ LearningPanel: () => null }));
vi.mock("../components/hexPortal/LearningCard", () => ({ LearningCard: () => null }));
vi.mock("../components/hexPortal/LearningReviewForm", () => ({ LearningReviewForm: () => null }));
vi.mock("../lib/hexPortal", () => ({ findPortalGuidance: async () => ({ items: [], enabled: false }) }));
vi.mock("../lib/knowledge", () => ({
  askInfinity: async (question: string) => {
    server.questions.push(question);
    if (server.hold) await server.hold;
    return { answer: `Got it: ${question}`, sources: [] };
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
  // The real order: kept on the phone, written out, then sent.
  runVoiceSteps: async (steps: { keep: (t: string, e: string) => Promise<boolean>; transcribe: () => Promise<string>; send: (w: string, p: string) => void }) => {
    const kept = await steps.keep("", "pending");
    const text = await steps.transcribe();
    steps.send(text, "memo/path");
    return { outcome: "sent", keptOnPhone: kept };
  },
  sessionUserIs: async () => true,
  uploadMemo: async () => "memo/path",
}));
vi.mock("../lib/voiceRecording", () => ({
  startVoiceRecording: (options: { onComplete: (blob: Blob) => void }) =>
    new Promise<{ stop: () => void; cancel: () => void }>((resolve) => {
      mic.onComplete = options.onComplete;
      mic.resolveStart = () => resolve({ stop: () => { mic.stops += 1; }, cancel: () => {} });
    }),
}));
vi.mock("../lib/dictation", () => ({
  transcribeDescription: () => words.held
    ? new Promise<string>((resolve) => { words.release = resolve; })
    : Promise.resolve("Set six frames on the east wall with Ben"),
}));

import { AskInfinity } from "./AskInfinity";

let root: Root | null = null;
let host: HTMLDivElement | null = null;
const scrollBy = vi.fn();
const settle = async (n = 8) => {
  for (let i = 0; i < n; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};
/** `state` is what the screen that opened Ask handed over (a Plan with AI prompt). */
const mount = async (state?: unknown) => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root!.render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[{ pathname: "/ask", state }]}><AskInfinity /></MemoryRouter></QueryClientProvider>);
  });
  await settle();
};
const unmount = () => {
  act(() => root?.unmount());
  host?.remove(); root = null; host = null;
};
const cardNames = () => [...host!.querySelectorAll<HTMLButtonElement>(".ask-cards .ask-card")].map((b) => b.textContent?.trim());
const input = () => host!.querySelector<HTMLInputElement>(".ask-input input")!;
const button = (text: string) => [...host!.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === text) ?? null;
const micButton = () => host!.querySelector<HTMLButtonElement>('button[aria-label="Record a voice message"]')!;
const dock = () => host!.querySelector<HTMLDivElement>(".ask-dock")!;
const click = async (el: HTMLElement | null) => {
  expect(el).not.toBeNull();
  await act(async () => el!.click());
  await settle();
};
const type = async (value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => { setter.call(input(), value); input().dispatchEvent(new Event("input", { bubbles: true })); });
  await settle();
};
const send = async (text: string) => {
  await type(text);
  await act(async () => { input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  await settle();
};
/** Record, stop, and let the recording be written out, sent and answered. */
const speak = async () => {
  await click(micButton());
  await act(async () => mic.resolveStart?.());
  await settle();
  await act(async () => mic.onComplete?.(new Blob(["audio"], { type: "audio/webm" })));
  await settle(12);
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  who.id = "crew-1";
  server.questions = []; server.hold = null;
  words.held = false; words.release = null;
  mic.onComplete = null; mic.resolveStart = null; mic.stops = 0;
  layout.rows.clear();
  scrollBy.mockReset();
  window.scrollBy = scrollBy as unknown as typeof window.scrollBy;
  vi.spyOn(window, "innerHeight", "get").mockReturnValue(800);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const i = this.getAttribute("data-msg");
    const [top, bottom] = (i === null ? undefined : layout.rows.get(Number(i))) ?? [0, 0];
    return { top, bottom, height: bottom - top, left: 0, right: 375, width: 375, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
  });
  vi.stubGlobal("URL", { ...URL, createObjectURL: () => "blob:held", revokeObjectURL: () => {} });
});
afterEach(() => {
  unmount();
  resetUnsavedWork();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// With no tab bar or sync strip in a unit test, the band is the window less
// the gap: 12 … 788 on an 800-pixel screen.
const BAND = { top: REVEAL_GAP, bottom: 800 - REVEAL_GAP };

describe("minimized stays minimized (note 2)", () => {
  it("after Hide, a recording, its reply and a typed send all leave the cards away; only Actions brings them back", async () => {
    await mount();
    expect(cardNames()).toEqual(["Build a unit", "Daily log", "My hours", "All actions"]);
    await click(button("Hide actions"));
    expect(host!.querySelector(".ask-cards")).toBeNull();

    await speak();
    // The recording was written out, sent and answered…
    expect(server.questions).toEqual(["Set six frames on the east wall with Ben"]);
    expect(host!.textContent).toContain("Got it: Set six frames on the east wall with Ben");
    // …and the cards did not come back with it.
    expect(host!.querySelector(".ask-cards")).toBeNull();

    await send("What is flashing?");
    expect(server.questions).toHaveLength(2);
    expect(input().value).toBe("");
    expect(host!.querySelector(".ask-cards")).toBeNull();

    await click(button("Actions"));
    expect(cardNames()).toEqual(["Build a unit", "Daily log", "My hours", "All actions"]);
  });

  it("a recording puts the cards away on its own, and finishing it does not bring them back", async () => {
    await mount();
    expect(host!.querySelector(".ask-cards")).not.toBeNull();
    await speak();
    expect(host!.textContent).toContain("Got it: Set six frames on the east wall with Ben");
    expect(host!.querySelector(".ask-cards")).toBeNull();
    expect(button("Actions")).not.toBeNull();
  });

  it("typing puts them away and sending does not bring them back — the box emptying is not an Actions tap", async () => {
    await mount();
    await send("What is flashing?");
    expect(host!.textContent).toContain("Got it: What is flashing?");
    expect(host!.querySelector(".ask-cards")).toBeNull();
  });

  it("a card tap puts them away too, and All actions closes with the microphone", async () => {
    await mount();
    await click(button("My hours"));
    expect(server.questions).toHaveLength(1);
    expect(host!.querySelector(".ask-cards")).toBeNull();
    await click(button("Actions"));
    await click(button("All actions"));
    expect(host!.querySelector(".ask-all-actions")).not.toBeNull();
    await click(micButton());
    expect(host!.querySelector(".ask-all-actions")).toBeNull();
    expect(host!.querySelector(".ask-cards")).toBeNull();
  });

  it("a Plan with AI prompt in the box keeps the cards away once the account resolves (#656)", async () => {
    // The prompt is typed in on arrival and kept when the account resolves a
    // moment later (#656); that reset must not bring the cards back over it.
    await mount({ seed: "Plan the week of Sep 28 — here's what I want: " });
    expect(input().value).toBe("Plan the week of Sep 28 — here's what I want: ");
    expect(host!.querySelector(".ask-cards")).toBeNull();
    expect(button("Actions")).not.toBeNull();
    expect(server.questions).toEqual([]);
  });

  it("Hide is remembered on this phone for that person only; Actions forgets it; typing is not remembered", async () => {
    await mount();
    await click(button("Hide actions"));
    unmount();
    await mount();
    expect(host!.querySelector(".ask-cards")).toBeNull();
    expect(button("Actions")).not.toBeNull();
    unmount();
    // Someone else on the same phone gets their own cards.
    who.id = "crew-2";
    await mount();
    expect(cardNames()).toHaveLength(4);
    await type("Unit 7 is a slider");
    expect(host!.querySelector(".ask-cards")).toBeNull();
    unmount();
    // Typing put them away for that conversation, not for next time.
    await mount();
    expect(cardNames()).toHaveLength(4);
    unmount();
    who.id = "crew-1";
    await mount();
    await click(button("Actions"));
    unmount();
    await mount();
    expect(cardNames()).toHaveLength(4);
  });
});

describe("the recorder follows the scroll (note 1)", () => {
  it("is pinned from the moment the microphone is asked for until the words are out, with a Stop that works", async () => {
    await mount();
    input().focus();
    expect(dock().classList.contains("is-pinned")).toBe(false);
    words.held = true;

    await click(micButton());
    // The keyboard goes: an open one would sit over the pinned bar on iOS.
    expect(document.activeElement).not.toBe(input());
    expect(dock().classList.contains("is-pinned")).toBe(true);
    expect(dock().textContent).toContain("Opening the microphone…");

    await act(async () => mic.resolveStart?.());
    await settle();
    expect(dock().classList.contains("is-pinned")).toBe(true);
    expect(dock().querySelector('[role="status"]')?.textContent).toBe("Recording — tap the square to stop and send");
    // The page scrolled far from the composer's place changes nothing: the
    // Stop that shows is the one inside the pinned bar, and it works.
    window.scrollTo(0, 0);
    const stop = dock().querySelector<HTMLButtonElement>('button[aria-label^="Stop and send"]');
    await click(stop);
    expect(mic.stops).toBe(1);

    await act(async () => mic.onComplete?.(new Blob(["audio"], { type: "audio/webm" })));
    await settle();
    expect(dock().classList.contains("is-pinned")).toBe(true);
    expect(dock().textContent).toContain("Writing out what you said…");

    await act(async () => words.release?.("Set six frames on the east wall with Ben"));
    await settle(12);
    expect(dock().classList.contains("is-pinned")).toBe(false);
    expect(dock().querySelector('[role="status"]')).toBeNull();
  });

  it("says it in Spanish too", async () => {
    const { translate } = await import("../lib/i18n/translate");
    const { FIELD_CATALOG } = await import("../components/ask/fieldCatalog");
    expect(translate(FIELD_CATALOG, "es", "field.recordingNow")).toBe("Grabando: toca el cuadrado para detener y enviar");
    expect(translate(FIELD_CATALOG, "es", "field.cards.hide")).toBe("Ocultar acciones");
    expect(translate(FIELD_CATALOG, "es", "field.newMessage")).toBe("Mensaje nuevo");
  });
});

describe("the newest message comes into view (note 3)", () => {
  it("someone down at the cards and the daily log gets their message brought up above them, and the reply lands under it", async () => {
    await mount();
    // The thread is above the screen: the person is below it.
    layout.rows.set(0, [-700, -640]);
    layout.rows.set(1, [-600, -560]);
    let answer: () => void = () => {};
    server.hold = new Promise<void>((resolve) => { answer = resolve; });
    await send("What is flashing?");
    // Their own words to the top of the screen, the options still under them.
    expect(scrollBy.mock.calls.map(([arg]) => (arg as ScrollToOptions).top)).toEqual([-600 - BAND.top]);
    // The page moved; the reply then lands right under their words, on screen.
    layout.rows.set(0, [-88 + BAND.top, -28 + BAND.top]);
    layout.rows.set(1, [BAND.top, BAND.top + 40]);
    layout.rows.set(2, [BAND.top + 60, BAND.top + 200]);
    await act(async () => answer());
    await settle();
    expect(host!.textContent).toContain("Got it: What is flashing?");
    expect(scrollBy).toHaveBeenCalledTimes(1);
    expect(host!.querySelector(".ask-jump")).toBeNull();
  });

  it("a reply that arrives while the page is still gliding up brings their words and itself into view together", async () => {
    await mount();
    layout.rows.set(0, [-700, -640]);
    layout.rows.set(1, [-600, -560]);
    layout.rows.set(2, [-540, -400]);
    await send("What is flashing?");
    // Both moves aim at the person's own words: the question and its answer
    // show together, in the same place however fast the reply came.
    expect(scrollBy.mock.calls.map(([arg]) => (arg as ScrollToOptions).top)).toEqual([-600 - BAND.top, -600 - BAND.top]);
  });

  it("a reply too long to show with the question shows its own start", async () => {
    await mount();
    layout.rows.set(0, [-1700, -1640]);
    layout.rows.set(1, [-1600, -1560]);
    layout.rows.set(2, [-1540, -400]);
    await send("What is flashing?");
    expect(scrollBy.mock.calls.map(([arg]) => (arg as ScrollToOptions).top)).toEqual([-1600 - BAND.top, -1540 - BAND.top]);
  });

  it("a voice message's transcript comes into view the moment it is written out, and its reply under it", async () => {
    await mount();
    layout.rows.set(0, [-900, -840]);
    layout.rows.set(1, [-800, -760]);
    // The reply waits on the network, as it does on a phone.
    let answer: () => void = () => {};
    server.hold = new Promise<void>((resolve) => { answer = resolve; });
    await speak();
    expect(host!.querySelector(".ask-bubble.mine")?.textContent).toBe("Set six frames on the east wall with Ben");
    expect(scrollBy.mock.calls.map(([arg]) => (arg as ScrollToOptions).top)).toEqual([-800 - BAND.top]);
    layout.rows.set(1, [BAND.top, BAND.top + 40]);
    layout.rows.set(2, [BAND.top + 60, BAND.top + 260]);
    await act(async () => answer());
    await settle();
    expect(host!.textContent).toContain("Got it: Set six frames on the east wall with Ben");
    expect(scrollBy).toHaveBeenCalledTimes(1);
  });

  it("a message already on screen stays put", async () => {
    await mount();
    layout.rows.set(0, [100, 160]);
    layout.rows.set(1, [200, 240]);
    layout.rows.set(2, [260, 320]);
    await send("What is flashing?");
    expect(host!.textContent).toContain("Got it: What is flashing?");
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it("someone who scrolled up to read is not moved: New message ↓ takes them to it", async () => {
    await mount();
    layout.rows.set(0, [100, 160]);
    layout.rows.set(1, [200, 240]);
    layout.rows.set(2, [260, 320]);
    await send("What is flashing?");
    // They scroll up: the newest message is now well below the screen.
    layout.rows.set(0, [900, 960]);
    layout.rows.set(1, [1000, 1040]);
    layout.rows.set(2, [1300, 1360]);
    layout.rows.set(3, [1380, 1420]);
    layout.rows.set(4, [1440, 1500]);
    await send("Which side does the drain face?");
    expect(host!.textContent).toContain("Got it: Which side does the drain face?");
    expect(scrollBy).not.toHaveBeenCalled();
    const jump = host!.querySelector<HTMLButtonElement>(".ask-jump");
    expect(jump?.textContent).toBe("New message");
    expect(jump?.querySelector("svg")?.getAttribute("class")).toContain("arrow-down");
    await click(jump);
    expect(scrollBy).toHaveBeenCalledWith({ top: 1500 - BAND.bottom, behavior: "smooth" });
    expect(host!.querySelector(".ask-jump")).toBeNull();
  });

  it("someone typing a daily log answer when the reply lands keeps their place, with New message ↑ offered", async () => {
    await mount();
    layout.rows.set(0, [-500, -440]);
    layout.rows.set(1, [-420, -380]);
    layout.rows.set(2, [-360, -300]);
    let answer: () => void = () => {};
    server.hold = new Promise<void>((resolve) => { answer = resolve; });
    await send("What is flashing?");
    expect(scrollBy).toHaveBeenCalledTimes(1);
    // While the reply is on its way they go fix an answer on the card.
    const field = document.createElement("textarea");
    document.body.appendChild(field);
    field.focus();
    await act(async () => answer());
    await settle();
    expect(host!.textContent).toContain("Got it: What is flashing?");
    expect(scrollBy).toHaveBeenCalledTimes(1);
    const jump = host!.querySelector<HTMLButtonElement>(".ask-jump");
    expect(jump?.querySelector("svg")?.getAttribute("class")).toContain("arrow-up");
    expect(document.activeElement).toBe(field);
    field.remove();
  });
});
