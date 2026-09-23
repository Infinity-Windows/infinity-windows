// @vitest-environment happy-dom
//
// The update rule itself is unit-tested in lib/pwa/updateCore.test.ts. What
// this pins is the wiring the owner actually felt on 2026-09-23: a phone that
// opens with an update already downloaded must switch to it, a dismissed banner
// must not strand the update until the app is force-closed, signing in counts
// as a fresh moment, and none of that may ever reload over unsaved work or a
// field someone is typing in.
//
// The second half pins what an independent review (Codex, 2026-09-23) found
// missing in that wiring: a live recording is unsaved work; a registration
// that finishes after the opening check still gets one; an update already on
// the phone does not wait for a version request that may never answer; and
// nothing switches over while a queue is still sending.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { claimUnsavedWork, resetUnsavedWork } from "../../lib/pwa/unsavedWork";
import { claimOverlay, claimSafeSurface, resetSafeSurface } from "../../lib/pwa/safeSurface";

const pwa = vi.hoisted(() => ({
  registered: null as null | ((url: string, reg: unknown) => void),
  setNeedRefresh: null as null | ((value: boolean) => void),
  updateServiceWorker: (() => Promise.resolve()) as (reload?: boolean) => Promise<void>,
}));
vi.mock("virtual:pwa-register/react", async () => {
  const React = await import("react");
  return {
    useRegisterSW: (options: { onRegisteredSW: (url: string, reg: unknown) => void }) => {
      pwa.registered = options.onRegisteredSW;
      const [needRefresh, setNeedRefresh] = React.useState(false);
      pwa.setNeedRefresh = setNeedRefresh;
      return {
        needRefresh: [needRefresh, setNeedRefresh],
        offlineReady: [false, () => {}],
        updateServiceWorker: (reload?: boolean) => pwa.updateServiceWorker(reload),
      };
    },
  };
});

type AuthListener = (event: string, session: { user: { id: string } } | null) => void;
const auth = vi.hoisted(() => ({ listener: null as AuthListener | null }));
vi.mock("../../lib/supabase", () => ({
  supabaseConfigured: true,
  supabase: {
    auth: {
      onAuthStateChange: (cb: AuthListener) => {
        auth.listener = cb;
        return { data: { subscription: { unsubscribe: () => {} } } };
      },
    },
  },
}));

// The queues are their own modules with their own stores (queuedWork.test.ts
// covers reading them); here they are one controllable reading.
const queue = vi.hoisted(() => ({
  waiting: 0,
  sending: false,
  /** What isSendingNow() answers at the instant of a tap, if it differs. */
  sendingNow: null as boolean | null,
  listeners: new Set<() => void>(),
  reads: 0,
}));
vi.mock("../../lib/pwa/queuedWork", () => ({
  blocksReload: (q: { waiting: number; sending: boolean }) => q.waiting > 0 || q.sending,
  isSendingNow: () => queue.sendingNow ?? queue.sending,
  readQueuedWork: async () => {
    queue.reads += 1;
    return { waiting: queue.waiting, sending: queue.sending };
  },
  subscribeQueuedWork: (cb: () => void) => {
    queue.listeners.add(cb);
    return () => queue.listeners.delete(cb);
  },
}));
const queuesChanged = async () => {
  await act(async () => {
    for (const cb of queue.listeners) cb();
  });
  await settle();
};

// The real DictationButton, with the microphone and the transcription service
// stubbed — its state machine is what matters here.
const mic = vi.hoisted(() => ({
  onComplete: null as null | ((blob: Blob) => void),
}));
vi.mock("../../lib/voiceRecording", () => ({
  startVoiceRecording: async (options: { onComplete: (blob: Blob) => void }) => {
    mic.onComplete = options.onComplete;
    return { stop: () => {}, cancel: () => {} };
  },
  voiceFilename: () => "voice.webm",
}));
vi.mock("../../lib/dictation", () => ({
  appendDictation: () => "",
  transcribeDescription: () => new Promise<string>(() => {}),
}));

import { PwaBanners } from "./PwaBanners";
import { DictationButton } from "../voice/DictationButton";

const updateServiceWorker = vi.fn(async (_reload?: boolean) => {});
const registration = {
  waiting: null as object | null,
  installing: null as object | null,
  update: vi.fn(async () => {}),
};

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let visibility: DocumentVisibilityState = "visible";

const settle = async () => {
  // Several awaits deep: registration lookup, version fetch, queue read,
  // state updates, and a coalesced second cycle behind the first.
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

const mount = async () => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<PwaBanners />);
  });
  await settle();
};

const text = () => host?.textContent ?? "";

const setVisibility = async (state: DocumentVisibilityState) => {
  visibility = state;
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await settle();
};

/** What the sign-in screen and the Work landing do in the app. */
const onSafeScreen = () => claimSafeSurface();

const tap = async (el: Element) => {
  await act(async () => {
    el.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    (el as HTMLElement).click();
  });
  await settle();
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-23T15:00:00Z"));
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  updateServiceWorker.mockClear();
  pwa.updateServiceWorker = updateServiceWorker;
  pwa.registered = null;
  registration.waiting = null;
  registration.installing = null;
  registration.update.mockClear();
  auth.listener = null;
  queue.waiting = 0;
  queue.sending = false;
  queue.sendingNow = null;
  queue.reads = 0;
  mic.onComplete = null;
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: { getRegistration: async () => registration },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => ({ buildId: "published-build" }) })),
  );
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  document.body.innerHTML = "";
  resetUnsavedWork();
  resetSafeSurface();
  queue.listeners.clear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("PwaBanners update", () => {
  it("switches to an update that was already downloaded when the app opens", async () => {
    onSafeScreen();
    registration.waiting = {};
    await mount();
    expect(updateServiceWorker).toHaveBeenCalledWith(true);
    expect(text()).toContain("Updating Forge Windows");
  });

  it("never reloads over unsaved work, even right after opening", async () => {
    onSafeScreen();
    claimUnsavedWork();
    registration.waiting = {};
    await mount();
    expect(updateServiceWorker).not.toHaveBeenCalled();
    expect(text()).toContain("A new version is available");
  });

  it("does not reload while someone is typing", async () => {
    onSafeScreen();
    const field = document.createElement("input");
    document.body.appendChild(field);
    field.focus();
    registration.waiting = {};
    await mount();
    expect(updateServiceWorker).not.toHaveBeenCalled();
  });

  it("asks, rather than reloading, once the app has been open a while", async () => {
    onSafeScreen();
    await mount();
    vi.setSystemTime(new Date("2026-09-23T15:05:00Z"));
    registration.waiting = {};
    await act(async () => pwa.setNeedRefresh?.(true));
    await settle();
    expect(updateServiceWorker).not.toHaveBeenCalled();
    expect(text()).toContain("A new version is available");
  });

  it("does not forget a dismissed update: coming back later applies it", async () => {
    await mount();
    vi.setSystemTime(new Date("2026-09-23T15:05:00Z"));
    registration.waiting = {};
    await act(async () => pwa.setNeedRefresh?.(true));
    await settle();

    const dismiss = host!.querySelector<HTMLButtonElement>(
      'button[aria-label="Dismiss update notice"]',
    );
    await act(async () => dismiss!.click());
    // The old banner cleared the only record of the waiting worker here, and
    // nothing brought the update back until the app was fully closed.
    await act(async () => pwa.setNeedRefresh?.(false));
    await settle();
    expect(text()).not.toContain("A new version is available");

    await setVisibility("hidden");
    vi.setSystemTime(new Date("2026-09-23T15:07:00Z"));
    await setVisibility("visible");
    expect(updateServiceWorker).toHaveBeenCalledWith(true);
  });

  it("applies an update on the sign-in screen", async () => {
    onSafeScreen();
    await mount();
    vi.setSystemTime(new Date("2026-09-23T15:05:00Z"));
    await act(async () => auth.listener?.("INITIAL_SESSION", null));
    await settle();
    registration.waiting = {};
    await act(async () => pwa.setNeedRefresh?.(true));
    await settle();
    expect(updateServiceWorker).toHaveBeenCalledWith(true);
  });

  it("treats signing in as a fresh moment", async () => {
    onSafeScreen();
    await mount();
    await act(async () => auth.listener?.("INITIAL_SESSION", null));
    await settle();
    vi.setSystemTime(new Date("2026-09-23T15:05:00Z"));
    await act(async () => auth.listener?.("SIGNED_IN", { user: { id: "crew-1" } }));
    await settle();
    registration.waiting = {};
    await act(async () => pwa.setNeedRefresh?.(true));
    await settle();
    expect(updateServiceWorker).toHaveBeenCalledWith(true);
  });

  it("asks the browser to download a newer build it learns about", async () => {
    await mount();
    expect(registration.update).toHaveBeenCalled();
  });
});

describe("only on a screen that said it is safe", () => {
  it("asks, right after opening, on a screen that has not claimed to be safe", async () => {
    // A unit sheet, a receipt, Ask: none of them claim. The first version of
    // the opening window reloaded here after four quiet seconds.
    registration.waiting = {};
    await mount();
    expect(updateServiceWorker).not.toHaveBeenCalled();
    expect(text()).toContain("A new version is available");
  });

  it("applies it the moment the landing mounts, if the update was already waiting", async () => {
    // The app opens, the check runs before any screen exists, then the Work
    // landing mounts a moment later: that is the owner's own "opened it and
    // it was still old" case, and it must not wait for the five-minute poll.
    registration.waiting = {};
    await mount();
    expect(updateServiceWorker).not.toHaveBeenCalled();
    await act(async () => {
      onSafeScreen();
    });
    await settle();
    expect(updateServiceWorker).toHaveBeenCalledWith(true);
  });

  it("asks while a sheet is open over the landing", async () => {
    onSafeScreen();
    claimOverlay();
    registration.waiting = {};
    await mount();
    expect(updateServiceWorker).not.toHaveBeenCalled();
    expect(text()).toContain("A new version is available");
  });

  it("asks on the sign-in path too, without the sign-in screen's claim", async () => {
    await mount();
    await act(async () => auth.listener?.("INITIAL_SESSION", null));
    await settle();
    registration.waiting = {};
    await act(async () => pwa.setNeedRefresh?.(true));
    await settle();
    expect(updateServiceWorker).not.toHaveBeenCalled();
  });

  it("honours a dismissal inside the opening window", async () => {
    // Someone is typing in the window, sees the banner, dismisses it. The
    // window must not then apply the update the moment they stop typing.
    onSafeScreen();
    const field = document.createElement("input");
    document.body.appendChild(field);
    field.focus();
    registration.waiting = {};
    await mount();
    expect(text()).toContain("A new version is available");
    const dismiss = host!.querySelector<HTMLButtonElement>(
      'button[aria-label="Dismiss update notice"]',
    );
    await act(async () => dismiss!.click());
    field.blur();
    vi.setSystemTime(new Date("2026-09-23T15:00:10Z"));
    await act(async () => pwa.setNeedRefresh?.(true));
    await settle();
    expect(updateServiceWorker).not.toHaveBeenCalled();
    expect(text()).toBe("");
  });
});

describe("a live recording is unsaved work", () => {
  it("never auto-reloads while the real dictation component is recording", async () => {
    // Ported from the independent review's harness (Codex, 2026-09-23). The
    // recorder holds its audio in memory, focuses no field and fires no
    // input event, so every other guard sees a quiet, safe screen.
    onSafeScreen();
    await mount();
    const field = document.createElement("textarea");
    document.body.appendChild(field);
    await act(async () => {
      root!.render(
        <>
          <PwaBanners />
          <DictationButton fieldRef={{ current: field }} />
        </>,
      );
    });
    await settle();
    const start = host!.querySelector<HTMLButtonElement>('button[aria-label="Dictate"]')!;
    expect(start).not.toBeNull();
    await tap(start);
    expect(text()).toContain("Stop & transcribe");
    vi.setSystemTime(new Date("2026-09-23T15:00:05Z"));
    registration.waiting = {};
    await act(async () => pwa.setNeedRefresh?.(true));
    await settle();
    expect(updateServiceWorker).not.toHaveBeenCalled();
    expect(text()).toContain("A new version is available");
  });

  it("keeps refusing while the clip is being transcribed, after the mic has stopped", async () => {
    // Stopping the microphone is not durability: the words are not in the
    // field yet and the audio exists nowhere but here.
    onSafeScreen();
    await mount();
    const field = document.createElement("textarea");
    document.body.appendChild(field);
    await act(async () => {
      root!.render(
        <>
          <PwaBanners />
          <DictationButton fieldRef={{ current: field }} />
        </>,
      );
    });
    await settle();
    await tap(host!.querySelector<HTMLButtonElement>('button[aria-label="Dictate"]')!);
    await act(async () => mic.onComplete?.(new Blob(["audio"], { type: "audio/webm" })));
    await settle();
    expect(text()).toContain("Transcribing");
    vi.setSystemTime(new Date("2026-09-23T15:00:05Z"));
    registration.waiting = {};
    await act(async () => pwa.setNeedRefresh?.(true));
    await settle();
    expect(updateServiceWorker).not.toHaveBeenCalled();
  });
});

describe("queued work", () => {
  it("waits for queued work, then applies once it has been sent", async () => {
    onSafeScreen();
    queue.waiting = 2;
    registration.waiting = {};
    await mount();
    expect(updateServiceWorker).not.toHaveBeenCalled();
    expect(text()).toContain("New version ready");
    expect(text()).toContain("once everything on this phone has been sent");

    queue.waiting = 0;
    await queuesChanged();
    expect(updateServiceWorker).toHaveBeenCalledWith(true);
  });

  it("waits for a drain in progress even when nothing is counted", async () => {
    // The last row is gone from the store while the server may still be
    // finishing the write it carried.
    onSafeScreen();
    queue.sending = true;
    registration.waiting = {};
    await mount();
    expect(updateServiceWorker).not.toHaveBeenCalled();
    queue.sending = false;
    await queuesChanged();
    expect(updateServiceWorker).toHaveBeenCalledWith(true);
  });

  it("holds a return to the app the same way, and still applies it when the drain ends soon after", async () => {
    await mount();
    queue.waiting = 1;
    registration.waiting = {};
    await act(async () => pwa.setNeedRefresh?.(true));
    await settle();
    await setVisibility("hidden");
    vi.setSystemTime(new Date("2026-09-23T15:07:00Z"));
    await setVisibility("visible");
    expect(updateServiceWorker).not.toHaveBeenCalled();
    expect(text()).toContain("New version ready");

    vi.setSystemTime(new Date("2026-09-23T15:07:20Z"));
    queue.waiting = 0;
    await queuesChanged();
    expect(updateServiceWorker).toHaveBeenCalledWith(true);
  });

  it("does not reuse that return once the person has picked the phone back up", async () => {
    await mount();
    queue.waiting = 1;
    registration.waiting = {};
    await act(async () => pwa.setNeedRefresh?.(true));
    await settle();
    await setVisibility("hidden");
    vi.setSystemTime(new Date("2026-09-23T15:07:00Z"));
    await setVisibility("visible");
    expect(updateServiceWorker).not.toHaveBeenCalled();

    // A tap after the return, then the drain finishes.
    vi.setSystemTime(new Date("2026-09-23T15:07:05Z"));
    await act(async () => {
      window.dispatchEvent(new Event("pointerdown"));
    });
    vi.setSystemTime(new Date("2026-09-23T15:07:20Z"));
    queue.waiting = 0;
    await queuesChanged();
    expect(updateServiceWorker).not.toHaveBeenCalled();
    expect(text()).toContain("A new version is available");
  });

  it("reads the queues only when there is something to apply", async () => {
    await mount();
    expect(queue.reads).toBe(0);
  });

  describe("the hold banner has a way out", () => {
    // A hold can last for good: the legacy upload queue is only flushed
    // while a unit sheet is open and retries a failing upload without a cap,
    // so a phone that left the sheet with unsent unit photos would otherwise
    // read "it switches over once everything has been sent" forever (review
    // of #634, 2026-09-23).
    const refreshButton = () =>
      Array.from(host!.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
        b.classList.contains("pwa-banner-action"),
      );
    const dismissButton = () =>
      host!.querySelector<HTMLButtonElement>('button[aria-label="Dismiss update notice"]');

    it("offers Refresh while items are merely waiting, and it applies", async () => {
      onSafeScreen();
      queue.waiting = 3;
      registration.waiting = {};
      await mount();
      expect(text()).toContain("New version ready");
      const refresh = refreshButton()!;
      expect(refresh.disabled).toBe(false);
      expect(refresh.textContent).toBe("Refresh");
      expect(dismissButton()).not.toBeNull();
      await tap(refresh);
      expect(updateServiceWorker).toHaveBeenCalledWith(true);
      expect(text()).toContain("Updating Forge Windows");
    });

    it("disables Refresh while a drain is in flight, and enables it when the drain ends", async () => {
      onSafeScreen();
      queue.waiting = 1;
      queue.sending = true;
      registration.waiting = {};
      await mount();
      let refresh = refreshButton()!;
      expect(refresh.disabled).toBe(true);
      expect(refresh.textContent).toBe("Sending… one moment");

      // The drain ends with one upload still waiting — a legacy queue with
      // nothing flushing it. Not safe to apply automatically; safe to offer.
      queue.sending = false;
      await queuesChanged();
      expect(updateServiceWorker).not.toHaveBeenCalled();
      refresh = refreshButton()!;
      expect(refresh.disabled).toBe(false);
      expect(refresh.textContent).toBe("Refresh");
    });

    it("refuses a Refresh tapped just as a drain starts", async () => {
      // The button reflects the last look at the queues; the tap asks again.
      onSafeScreen();
      queue.waiting = 1;
      registration.waiting = {};
      await mount();
      queue.sendingNow = true;
      await tap(refreshButton()!);
      expect(updateServiceWorker).not.toHaveBeenCalled();
      expect(refreshButton()!.disabled).toBe(true);
      expect(refreshButton()!.textContent).toBe("Sending… one moment");
    });

    it("can be dismissed until the app next comes back into view, without forgetting the update", async () => {
      onSafeScreen();
      queue.waiting = 1;
      registration.waiting = {};
      await mount();
      expect(text()).toContain("New version ready");
      await act(async () => dismissButton()!.click());
      expect(text()).toBe("");
      // A queue changing while dismissed does not bring it back.
      await queuesChanged();
      expect(text()).toBe("");
      expect(updateServiceWorker).not.toHaveBeenCalled();

      await setVisibility("hidden");
      vi.setSystemTime(new Date("2026-09-23T15:03:00Z"));
      await setVisibility("visible");
      // Back, re-evaluated: still held (the upload is still waiting), so the
      // banner is offered again — and the worker was never forgotten.
      expect(text()).toContain("New version ready");
      expect(updateServiceWorker).not.toHaveBeenCalled();
      vi.setSystemTime(new Date("2026-09-23T15:03:10Z"));
      queue.waiting = 0;
      await queuesChanged();
      expect(updateServiceWorker).toHaveBeenCalledWith(true);
    });
  });
});

describe("the service worker and the network", () => {
  it("checks when a service-worker registration arrives after the opening check", async () => {
    // Ported from the independent review's harness (Codex, 2026-09-23): the
    // registration callback only stored the registration, so a phone whose
    // worker registered late waited for the five-minute poll.
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { getRegistration: async () => undefined },
    });
    await mount();
    expect(registration.update).not.toHaveBeenCalled();
    await act(async () => pwa.registered?.("/sw.js", registration));
    await settle();
    expect(registration.update).toHaveBeenCalled();
  });

  it("can apply an already-downloaded worker even when the version request stalls", async () => {
    // Ported from the independent review's harness (Codex, 2026-09-23): the
    // check awaited version.json before looking at the worker, and that
    // request had no deadline.
    onSafeScreen();
    registration.waiting = {};
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    await mount();
    expect(updateServiceWorker).toHaveBeenCalledWith(true);
  });

  it("can still offer an already-downloaded worker when the version request stalls", async () => {
    registration.waiting = {};
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    await mount();
    expect(updateServiceWorker).not.toHaveBeenCalled();
    expect(text()).toContain("A new version is available");
  });

  it("does not ask the network about builds while an update is already waiting", async () => {
    registration.waiting = {};
    await mount();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps one version request in flight, however many triggers land on it", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    await mount();
    await setVisibility("hidden");
    await setVisibility("visible");
    await act(async () => auth.listener?.("INITIAL_SESSION", { user: { id: "crew-1" } }));
    await settle();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("decides about a worker that finished downloading before the check looked", async () => {
    // registration.update() resolves with the new worker already waiting and
    // nothing "installing": the old code returned and left it for the poll.
    onSafeScreen();
    registration.update.mockImplementation(async () => {
      registration.waiting = {};
    });
    await mount();
    expect(updateServiceWorker).toHaveBeenCalledWith(true);
  });
});
