// @vitest-environment happy-dom
//
// Crash report 8WEYC (2026-09-22): "Cannot read properties of undefined
// (reading 'default')" inside VoiceTextarea > VoiceControl > Lazy. The mic's
// code failed to download and the whole app was replaced by the crash screen,
// taking whatever had been typed with it.
//
// What has to hold, through the real VoiceTextarea > VoiceControl chain: when
// the mic's code does not arrive, the textarea is still there, still takes
// typing, and nothing reaches an error boundary; the mic is simply absent.
//
// Here the mic's module fails to load, or loads with nothing in it. The exact
// shape the production build produced cannot be made under the test runner:
// the build moves the whole import().then() inside Vite's preload helper, which
// resolves `undefined` once vite:preloadError is swallowed, so React.lazy is
// handed `undefined` itself. That case, with a textarea beside the mic, is
// pinned in lib/pwa/lazyOptional.test.tsx.

import { act, Component, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type MicMode = "loads" | "rejects" | "empty";

function FakeMic() {
  return <button type="button" aria-label="Dictate" />;
}

/**
 * What the mic's module does when the textarea asks for it. Registered per
 * test with doMock, after resetModules: a hoisted vi.mock keeps the first
 * module its factory returned and hands it to every later test.
 */
function micModule(mode: MicMode) {
  vi.doMock("./DictationButton", () => {
    if (mode === "rejects") {
      throw new TypeError(
        "Failed to fetch dynamically imported module: /assets/DictationButton-W7x5kOMx.js",
      );
    }
    return { DictationButton: mode === "empty" ? undefined : FakeMic };
  });
}

class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  static caught: Error[] = [];
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    Boundary.caught.push(error);
    return { error };
  }
  render() {
    return this.state.error ? <p>crash screen</p> : this.props.children;
  }
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function mountTextarea(mode: MicMode) {
  // A fresh copy of the voice modules per test: the mic's download is
  // remembered at module level, exactly as it is on a phone.
  vi.resetModules();
  micModule(mode);
  const { VoiceTextarea } = await import("./VoiceTextarea");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <Boundary>
        <VoiceTextarea aria-label="Notes" defaultValue="Bay 3 sill " />
      </Boundary>,
    );
  });
  await settled();
  return host.querySelector<HTMLTextAreaElement>("textarea");
}

/**
 * Wait until the mic's download has finished, one way or the other, and React
 * has rendered the result. Without this a missing mic would prove nothing: it
 * is also missing while the download is still under way.
 */
async function settled() {
  await import("./DictationButton").catch(() => undefined);
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Boundary.caught = [];
});

afterEach(() => {
  vi.doUnmock("./DictationButton");
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe("VoiceTextarea when the mic's code does not arrive", () => {
  for (const mode of ["rejects", "empty"] as const) {
    it(`keeps the textarea and drops the mic (${mode})`, async () => {
      const field = await mountTextarea(mode);

      expect(Boundary.caught).toEqual([]);
      expect(host!.textContent).not.toContain("crash screen");
      expect(field).not.toBeNull();
      expect(field!.value).toBe("Bay 3 sill ");
      expect(host!.querySelector('button[aria-label="Dictate"]')).toBeNull();

      // Still a working field: typing lands in it.
      field!.value += "cracked";
      field!.dispatchEvent(new Event("input", { bubbles: true }));
      expect(field!.value).toBe("Bay 3 sill cracked");
    });
  }

  it("shows the mic when its code does arrive", async () => {
    const field = await mountTextarea("loads");
    expect(Boundary.caught).toEqual([]);
    expect(field).not.toBeNull();
    expect(host!.querySelector('button[aria-label="Dictate"]')).not.toBeNull();
  });
});
