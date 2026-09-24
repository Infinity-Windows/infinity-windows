// @vitest-environment happy-dom
//
// K0.7: a lazily-loaded screen that never gets its code must say so instead of
// spinning forever, and "Try again" has to mean it — a genuinely fresh
// import(), not React.lazy's memoized promise replayed. Mounts the real
// lazyRoute() output and reads the real DOM (same style as ErrorBoundary.test
// and StuckWrites.test) rather than unit-testing the timing logic alone: the
// thing that has to be true is what a person waiting on one bar of signal
// actually sees.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lazyRoute, LAZY_ROUTE_TIMEOUT_MS } from "./lazyRoute";

function Loaded() {
  return <p>Loaded!</p>;
}

/** A promise this test can resolve/reject from the outside, on its own clock. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function mount(node: React.ReactElement) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(<MemoryRouter>{node}</MemoryRouter>);
  });
  return host;
}

function click(el: HTMLElement, text: string) {
  const btn = [...el.querySelectorAll("button")].find((b) => b.textContent === text);
  if (!btn) throw new Error(`no button reading "${text}"`);
  act(() => btn.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.useRealTimers();
});

describe("lazyRoute()", () => {
  it("shows the loading fallback, then the real screen once the import resolves", async () => {
    const d = deferred<{ default: typeof Loaded }>();
    const Screen = lazyRoute(() => d.promise);
    const el = mount(<Screen />);

    expect(el.textContent).not.toContain("Loaded!");
    expect(el.querySelector(".skeleton-block")).not.toBeNull();

    await act(async () => {
      d.resolve({ default: Loaded });
      await d.promise;
    });
    expect(el.textContent).toContain("Loaded!");
  });

  it("replaces the skeleton with the hung-route message after 20 seconds, not before", async () => {
    const pending = deferred<{ default: typeof Loaded }>();
    const Screen = lazyRoute(() => pending.promise);
    const el = mount(<Screen />);

    act(() => {
      vi.advanceTimersByTime(LAZY_ROUTE_TIMEOUT_MS - 1);
    });
    expect(el.textContent).not.toContain("This didn't load on this signal.");

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(el.textContent).toContain("This didn't load on this signal.");
    expect(el.querySelector("button")?.textContent).toBe("Try again");
    const goToWork = [...el.querySelectorAll("a")].find((a) => a.textContent === "Go to Work");
    expect(goToWork?.getAttribute("href")).toBe("/");
  });

  it("Try again makes a genuinely fresh import() call, not React.lazy's cached one", async () => {
    const attempts: Array<ReturnType<typeof deferred<{ default: typeof Loaded }>>> = [];
    const factory = vi.fn(() => {
      const d = deferred<{ default: typeof Loaded }>();
      attempts.push(d);
      return d.promise;
    });
    const Screen = lazyRoute(factory);
    const el = mount(<Screen />);
    expect(factory).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(LAZY_ROUTE_TIMEOUT_MS);
    });
    expect(el.textContent).toContain("This didn't load on this signal.");

    click(el, "Try again");
    expect(factory).toHaveBeenCalledTimes(2);
    // The retry gets its OWN fresh 20-second clock — it does not reappear
    // instantly just because the last fallback instance never unmounted.
    expect(el.textContent).not.toContain("This didn't load on this signal.");

    await act(async () => {
      attempts[1].resolve({ default: Loaded });
      await attempts[1].promise;
    });
    expect(el.textContent).toContain("Loaded!");
  });

  it("uses a caller's own loadingFallback before the deadline instead of the default skeleton", () => {
    const pending = deferred<{ default: typeof Loaded }>();
    const Screen = lazyRoute(() => pending.promise, {
      loadingFallback: <p>Connecting…</p>,
    });
    const el = mount(<Screen />);
    expect(el.textContent).toContain("Connecting…");
    expect(el.querySelector(".skeleton-block")).toBeNull();
  });
});
