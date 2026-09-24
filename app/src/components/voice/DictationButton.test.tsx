// @vitest-environment happy-dom
//
// What this pins: for as long as a dictation exists only in this component's
// memory, it counts as unsaved work — so the app's automatic update cannot
// reload over it (independent review, 2026-09-23). The claim is released by
// durability (the words in the field) or by the person cancelling, never by
// the microphone merely stopping.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hasUnsavedWork, resetUnsavedWork, unsavedWorkClaims } from "../../lib/pwa/unsavedWork";

const mic = vi.hoisted(() => ({
  onComplete: null as null | ((blob: Blob) => void),
  onError: null as null | ((error: Error) => void),
  cancelled: 0,
}));
vi.mock("../../lib/voiceRecording", () => ({
  startVoiceRecording: async (options: {
    onComplete: (blob: Blob) => void;
    onError: (error: Error) => void;
  }) => {
    mic.onComplete = options.onComplete;
    mic.onError = options.onError;
    return {
      stop: () => {},
      cancel: () => {
        mic.cancelled += 1;
      },
    };
  },
  voiceFilename: () => "voice.webm",
}));

const speech = vi.hoisted(() => ({
  resolve: null as null | ((text: string) => void),
  reject: null as null | ((err: Error) => void),
  append: (() => "") as (current: string, text: string) => string | null,
}));
vi.mock("../../lib/dictation", () => ({
  appendDictation: (current: string, text: string) => speech.append(current, text),
  transcribeDescription: () =>
    new Promise<string>((resolve, reject) => {
      speech.resolve = resolve;
      speech.reject = reject;
    }),
}));

import { DictationButton } from "./DictationButton";

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let field: HTMLTextAreaElement | null = null;

const settle = async () => {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

const mount = async () => {
  host = document.createElement("div");
  document.body.appendChild(host);
  field = document.createElement("textarea");
  document.body.appendChild(field);
  root = createRoot(host);
  await act(async () => {
    root!.render(<DictationButton fieldRef={{ current: field }} />);
  });
  await settle();
};

const button = (label: string) => host!.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
const buttonByText = (label: string) =>
  Array.from(host!.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
    b.textContent?.includes(label),
  );
const click = async (el: HTMLElement | undefined | null) => {
  expect(el).toBeTruthy();
  await act(async () => el!.click());
  await settle();
};
const record = async () => {
  await click(button("Dictate"));
  expect(host!.textContent).toContain("Stop & transcribe");
};
const stopWithAudio = async () => {
  await act(async () => mic.onComplete?.(new Blob(["audio"], { type: "audio/webm" })));
  await settle();
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mic.onComplete = null;
  mic.onError = null;
  mic.cancelled = 0;
  speech.resolve = null;
  speech.reject = null;
  speech.append = (current, text) => (current ? `${current} ${text}` : text);
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: () => "blob:preview",
    revokeObjectURL: () => {},
  });
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  field?.remove();
  root = null;
  host = null;
  field = null;
  resetUnsavedWork();
  vi.unstubAllGlobals();
});

describe("DictationButton and unsaved work", () => {
  it("holds nothing while idle", async () => {
    await mount();
    expect(hasUnsavedWork()).toBe(false);
  });

  it("claims from the moment the microphone is asked for", async () => {
    await mount();
    await record();
    expect(unsavedWorkClaims()).toBe(1);
  });

  it("keeps the claim through transcription — stopping the mic is not durability", async () => {
    await mount();
    await record();
    await stopWithAudio();
    expect(host!.textContent).toContain("Transcribing");
    expect(unsavedWorkClaims()).toBe(1);
  });

  it("releases once the words are in the field", async () => {
    await mount();
    await record();
    await stopWithAudio();
    await act(async () => speech.resolve?.("set the sill first"));
    await settle();
    expect(field!.value).toBe("set the sill first");
    expect(host!.textContent).toContain("Words added");
    expect(hasUnsavedWork()).toBe(false);
  });

  it("keeps the claim when transcription fails and Retry is offered", async () => {
    await mount();
    await record();
    await stopWithAudio();
    await act(async () => speech.reject?.(new Error("offline")));
    await settle();
    expect(buttonByText("Retry transcription")).toBeTruthy();
    expect(unsavedWorkClaims()).toBe(1);
  });

  it("keeps the claim when the words did not fit and are shown to copy", async () => {
    speech.append = () => null;
    await mount();
    await record();
    await stopWithAudio();
    await act(async () => speech.resolve?.("a very long dictation"));
    await settle();
    expect(host!.textContent).toContain("a very long dictation");
    expect(field!.value).toBe("");
    expect(unsavedWorkClaims()).toBe(1);
  });

  it("releases when the person cancels — a deliberate discard", async () => {
    await mount();
    await record();
    await click(button("Cancel recording"));
    expect(mic.cancelled).toBe(1);
    expect(hasUnsavedWork()).toBe(false);
  });

  it("releases on unmount, so a closed form cannot leave a claim behind", async () => {
    await mount();
    await record();
    expect(unsavedWorkClaims()).toBe(1);
    await act(async () => root?.unmount());
    root = null;
    expect(unsavedWorkClaims()).toBe(0);
  });
});
