// @vitest-environment happy-dom
//
// The update rule itself is unit-tested in lib/pwa/updateCore.test.ts. What
// this pins is the wiring the owner actually felt on 2026-09-23: a phone that
// opens with an update already downloaded must switch to it, a dismissed banner
// must not strand the update until the app is force-closed, signing in counts
// as a fresh moment, and none of that may ever reload over unsaved work or a
// field someone is typing in.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { claimUnsavedWork, resetUnsavedWork } from "../../lib/pwa/unsavedWork";

const pwa = vi.hoisted(() => ({
  setNeedRefresh: null as null | ((value: boolean) => void),
  updateServiceWorker: (() => Promise.resolve()) as (reload?: boolean) => Promise<void>,
}));
vi.mock("virtual:pwa-register/react", async () => {
  const React = await import("react");
  return {
    useRegisterSW: () => {
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

import { PwaBanners } from "./PwaBanners";

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
  // Several awaits deep: version fetch, registration lookup, state updates.
  for (let i = 0; i < 5; i += 1) {
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

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-23T15:00:00Z"));
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  updateServiceWorker.mockClear();
  pwa.updateServiceWorker = updateServiceWorker;
  registration.waiting = null;
  registration.installing = null;
  registration.update.mockClear();
  auth.listener = null;
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
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("PwaBanners update", () => {
  it("switches to an update that was already downloaded when the app opens", async () => {
    registration.waiting = {};
    await mount();
    expect(updateServiceWorker).toHaveBeenCalledWith(true);
    expect(text()).toContain("Updating Forge Windows");
  });

  it("never reloads over unsaved work, even right after opening", async () => {
    claimUnsavedWork();
    registration.waiting = {};
    await mount();
    expect(updateServiceWorker).not.toHaveBeenCalled();
    expect(text()).toContain("A new version is available");
  });

  it("does not reload while someone is typing", async () => {
    const field = document.createElement("input");
    document.body.appendChild(field);
    field.focus();
    registration.waiting = {};
    await mount();
    expect(updateServiceWorker).not.toHaveBeenCalled();
  });

  it("asks, rather than reloading, once the app has been open a while", async () => {
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
