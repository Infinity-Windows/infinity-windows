// @vitest-environment happy-dom
//
// lazyOptional() is React.lazy for a part of a screen the rest can live
// without (crash report 8WEYC: a mic that could not download took the whole app
// down). What has to hold is what a person sees, so this mounts the real
// wrapper and reads the real DOM, the same style as lazyRoute.test.tsx:
//
//   - the part appears when its code arrives;
//   - when the code does not arrive, whether the import rejects or resolves to
//     nothing (what Vite hands back for a swallowed vite:preloadError), the
//     fallback renders and nothing reaches an error boundary;
//   - it tries again on a later mount, never on a re-render and never while
//     offline, so a failure cannot become a loop of downloads.

import { act, Component, lazy, Suspense, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lazyOptional, LAZY_OPTIONAL_RETRY_AFTER_MS } from "./lazyOptional";

function Mic({ label }: { label: string }) {
  return <button type="button">{label}</button>;
}

/** Records anything thrown into the tree instead of letting it escape. */
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
let clock = 1_000_000;

async function render(node: ReactNode) {
  if (!root) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  }
  await act(async () => {
    root!.render(
      <Boundary>
        <Suspense fallback={<p>loading</p>}>{node}</Suspense>
      </Boundary>,
    );
  });
  // Let a loader that has already settled finish resolving into the tree.
  await act(async () => {});
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Boundary.caught = [];
  clock = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => clock);
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.restoreAllMocks();
});

const text = () => host!.textContent;

describe("lazyOptional", () => {
  it("renders the part once its code arrives", async () => {
    const LazyMic = lazyOptional(async () => ({ default: Mic }));
    await render(
      <>
        <textarea defaultValue="notes" />
        <LazyMic label="Talk" />
      </>,
    );
    expect(host!.querySelector("button")?.textContent).toBe("Talk");
    expect(host!.querySelector("textarea")).not.toBeNull();
  });

  it("renders nothing, and crashes nothing, when the download is rejected", async () => {
    const LazyMic = lazyOptional<typeof Mic>(() =>
      Promise.reject(new TypeError("Failed to fetch dynamically imported module: /assets/Mic.js")),
    );
    await render(
      <>
        <textarea defaultValue="notes" />
        <LazyMic label="Talk" />
      </>,
    );
    expect(Boundary.caught).toEqual([]);
    expect(host!.querySelector("button")).toBeNull();
    expect(host!.querySelector("textarea")?.value).toBe("notes");
  });

  it("renders nothing, and crashes nothing, when the import resolves undefined", async () => {
    // Exactly what Vite's preload helper returns once vite:preloadError is
    // swallowed: the build wraps the whole import().then(...) in it.
    const LazyMic = lazyOptional<typeof Mic>(
      () => Promise.resolve(undefined) as unknown as Promise<{ default: typeof Mic }>,
    );
    await render(
      <>
        <textarea defaultValue="notes" />
        <LazyMic label="Talk" />
      </>,
    );
    expect(Boundary.caught).toEqual([]);
    expect(host!.querySelector("button")).toBeNull();
    expect(host!.querySelector("textarea")?.value).toBe("notes");
  });

  it("treats a module with nothing to render as not loaded", async () => {
    const LazyMic = lazyOptional<typeof Mic>(
      async () => ({ default: undefined }) as unknown as { default: typeof Mic },
    );
    await render(<LazyMic label="Talk" />);
    expect(Boundary.caught).toEqual([]);
    expect(text()).toBe("");
  });

  it("renders the fallback it was given in place of the part", async () => {
    const LazyMic = lazyOptional<typeof Mic>(
      () => Promise.reject(new Error("offline")),
      <p>This didn't load on this signal.</p>,
    );
    await render(<LazyMic label="Talk" />);
    expect(text()).toBe("This didn't load on this signal.");
  });

  it("shares one download between everything mounted at once", async () => {
    const load = vi.fn(async () => ({ default: Mic }));
    const LazyMic = lazyOptional(load);
    await render(
      <>
        <LazyMic label="one" />
        <LazyMic label="two" />
        <LazyMic label="three" />
      </>,
    );
    expect(load).toHaveBeenCalledTimes(1);
    expect([...host!.querySelectorAll("button")].map((b) => b.textContent)).toEqual([
      "one",
      "two",
      "three",
    ]);
  });

  it("tries again on a later mount once the failure is old enough, never sooner", async () => {
    const first = deferred<{ default: typeof Mic }>();
    const load = vi
      .fn<() => Promise<{ default: typeof Mic }>>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue({ default: Mic });
    const LazyMic = lazyOptional(load);

    await render(<LazyMic key="a" label="Talk" />);
    expect(text()).toBe("loading");
    await act(async () => first.reject(new Error("Failed to fetch dynamically imported module")));
    await act(async () => {});
    expect(text()).toBe("");
    expect(load).toHaveBeenCalledTimes(1);

    // The same mount re-rendering: no new download.
    await render(<LazyMic key="a" label="Talk again" />);
    expect(load).toHaveBeenCalledTimes(1);

    // A new mount straight away: still no new download.
    clock += LAZY_OPTIONAL_RETRY_AFTER_MS - 1;
    await render(<LazyMic key="b" label="Talk" />);
    expect(load).toHaveBeenCalledTimes(1);
    expect(text()).toBe("");

    // A new mount once the failure is old enough: one new download, and the
    // mic comes back.
    clock += 1;
    await render(<LazyMic key="c" label="Talk" />);
    expect(load).toHaveBeenCalledTimes(2);
    expect(host!.querySelector("button")?.textContent).toBe("Talk");
    expect(Boundary.caught).toEqual([]);
  });

  it("does not retry while the phone says it is offline", async () => {
    const load = vi
      .fn<() => Promise<{ default: typeof Mic }>>()
      .mockRejectedValueOnce(new Error("Failed to fetch dynamically imported module"))
      .mockResolvedValue({ default: Mic });
    const LazyMic = lazyOptional(load);
    await render(<LazyMic key="a" label="Talk" />);
    expect(load).toHaveBeenCalledTimes(1);

    const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    clock += LAZY_OPTIONAL_RETRY_AFTER_MS * 10;
    await render(<LazyMic key="b" label="Talk" />);
    expect(load).toHaveBeenCalledTimes(1);
    expect(text()).toBe("");

    online.mockReturnValue(true);
    await render(<LazyMic key="c" label="Talk" />);
    expect(load).toHaveBeenCalledTimes(2);
    expect(host!.querySelector("button")?.textContent).toBe("Talk");
  });

  it("is needed: plain React.lazy turns the same undefined into crash 8WEYC", async () => {
    // The control case. If React ever stops reading `default` off whatever the
    // import resolved to, this fails, and lazyOptional's undefined check can
    // be revisited. React's production build (the one that sent 8WEYC) says
    // "Cannot read properties of undefined (reading 'default')"; the
    // development build these tests run says "Cannot use 'in' operator to
    // search for 'default' in undefined". Same read, same crash.
    const PlainMic = lazy(
      () => Promise.resolve(undefined) as unknown as Promise<{ default: typeof Mic }>,
    );
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    await render(<PlainMic label="Talk" />);
    quiet.mockRestore();
    expect(text()).toBe("crash screen");
    expect(Boundary.caught[0]).toBeInstanceOf(TypeError);
    expect(Boundary.caught[0].message).toMatch(/'default'.*undefined|undefined.*'default'/);
  });
});
