// @vitest-environment happy-dom
//
// The boundary's job used to be only catching; the wave-M TDZ crash hid
// behind it for a whole wave. What this pins: a caught crash is REPORTED
// (reportCrash gets the error and the component stack), the screen shows a
// code the crew can read out loud, and Try again actually re-renders the
// children instead of forcing a full reload.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { crashDigest } from "../lib/crashReport";
import { ErrorBoundary } from "./ErrorBoundary";

const reportCrash = vi.fn();
vi.mock("../lib/crashReport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/crashReport")>();
  return { ...actual, reportCrash: (...args: unknown[]) => reportCrash(...args) };
});

// componentDidCatch calls recoverFromChunkLoadError() with no deps, so it
// would reach for real sessionStorage/window.location.reload — mocked here
// the same way the decision itself is unit-tested in preloadRecovery.test.ts.
// This file only has to prove ErrorBoundary reacts correctly to "reload" vs
// "notify", not re-prove the decision rule.
const recoverFromChunkLoadError = vi.fn();
vi.mock("../lib/pwa/preloadRecovery", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/pwa/preloadRecovery")>();
  return { ...actual, recoverFromChunkLoadError: (...args: unknown[]) => recoverFromChunkLoadError(...args) };
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  // React logs every caught render error in dev; keep the test output clean.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const bomb = new Error("Cannot access 'jobCodeMap' before initialization");
let exploding = true;

function Bomb() {
  if (exploding) throw bomb;
  return <p>screen is back</p>;
}

function mount() {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    );
  });
  return host;
}

function click(el: HTMLElement, text: string) {
  const btn = [...el.querySelectorAll("button")].find((b) => b.textContent === text);
  if (!btn) throw new Error(`no button reading "${text}"`);
  act(() => btn.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

describe("ErrorBoundary", () => {
  it("renders children untouched while nothing is wrong", () => {
    exploding = false;
    const el = mount();
    expect(el.textContent).toContain("screen is back");
    expect(reportCrash).not.toHaveBeenCalled();
  });

  it("reports a caught crash and shows the read-out-loud code", () => {
    exploding = true;
    const el = mount();
    expect(el.textContent).toContain("Something went wrong");
    expect(el.textContent).toContain(crashDigest(bomb));
    expect(reportCrash).toHaveBeenCalledTimes(1);
    const [error, componentStack] = reportCrash.mock.calls[0] as [Error, string];
    expect(error).toBe(bomb);
    expect(componentStack).toContain("Bomb");
  });

  it("speaks the phone's own language, with no provider left to ask", () => {
    // The crash unmounts LanguageProvider along with everything else, so the
    // screen reads the per-device language cache directly. A Spanish-reading
    // installer must not be handed English on the one screen with nothing
    // else on it.
    localStorage.setItem("infinity.language", "es");
    try {
      exploding = true;
      const el = mount();
      expect(el.textContent).toContain("Algo salió mal");
      expect(el.textContent).toContain("Intentar de nuevo");
      // The code itself is never translated — it is what gets read out loud.
      expect(el.textContent).toContain(crashDigest(bomb));
    } finally {
      localStorage.removeItem("infinity.language");
    }
  });

  it("Try again re-renders the children without a reload", () => {
    exploding = true;
    const el = mount();
    expect(el.textContent).toContain("Something went wrong");
    exploding = false;
    click(el, "Try again");
    expect(el.textContent).toContain("screen is back");
    expect(el.textContent).not.toContain("Something went wrong");
  });
});

// The Vite DEV server never raises `vite:preloadError` — a route's failed
// dynamic import propagates straight through React.lazy into this boundary
// instead (seen twice in e2e runs, 2026-09-07, StudioList.tsx). These pin
// that componentDidCatch hands a chunk-load error to the SAME reload rule
// production uses, instead of showing the crash screen.
function ChunkBomb(): never {
  throw new TypeError("Failed to fetch dynamically imported module: http://localhost:5187/src/pages/install/StudioList.tsx");
}

function mountChunkBomb() {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <ErrorBoundary>
        <ChunkBomb />
      </ErrorBoundary>,
    );
  });
  return host;
}

describe("ErrorBoundary and a failed chunk load", () => {
  it("a fresh chunk-load error triggers the reload and renders no crash screen", () => {
    recoverFromChunkLoadError.mockReturnValue("reload");
    const el = mountChunkBomb();
    expect(recoverFromChunkLoadError).toHaveBeenCalledTimes(1);
    expect(el.textContent).not.toContain("Something went wrong");
    expect(el.textContent).toBe("");
    // Reloading, not crashing: the offline telemetry path already logged
    // this one, so it must not also go to the crash monitor.
    expect(reportCrash).not.toHaveBeenCalled();
  });

  it("a second chunk-load error within the window renders the crash screen", () => {
    recoverFromChunkLoadError.mockReturnValue("notify");
    const el = mountChunkBomb();
    expect(el.textContent).toContain("Something went wrong");
    expect(reportCrash).toHaveBeenCalledTimes(1);
  });
});
