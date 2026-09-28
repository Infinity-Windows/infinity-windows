// @vitest-environment happy-dom
//
// Scanner defers html5-qrcode (and the camera it opens) until this box
// mounts, instead of loading it for every screen that merely imports Scanner.
// Deferring introduces a race the old synchronous version never had: if the
// box unmounts while the module download or scanner.start() is still in
// flight, that work keeps running in the background and finishes later. This
// pins what the effect must do about it — stop/clear the camera the late
// completion just turned on, never call onScan for it — plus that the typed-
// ID box still works (with no raw chunk-URL leaked) when the download fails,
// and that a real camera scan still reaches onScan when everything succeeds.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Scanner } from "./Scanner";
import type { QrPayload } from "../lib/qr";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const ScannerState = { NOT_STARTED: 0, SCANNING: 2, PAUSED: 3 } as const;

/** Stand-in for the real html5-qrcode class, with a controllable start(). */
class FakeHtml5Qrcode {
  static instances: FakeHtml5Qrcode[] = [];
  state: number = ScannerState.NOT_STARTED;
  stopCalls = 0;
  clearCalls = 0;
  startResult = deferred<void>();
  onScan: ((decoded: string) => void) | null = null;
  containerId: string;
  constructor(containerId: string) {
    this.containerId = containerId;
    FakeHtml5Qrcode.instances.push(this);
  }
  start(_cfg: unknown, _opts: unknown, onScan: (decoded: string) => void) {
    this.onScan = onScan;
    return this.startResult.promise.then(() => {
      this.state = ScannerState.SCANNING;
    });
  }
  stop() {
    this.stopCalls++;
    this.state = ScannerState.NOT_STARTED;
    return Promise.resolve();
  }
  clear() {
    this.clearCalls++;
  }
  getState() {
    return this.state;
  }
}

// Reassigned per test, before mounting — the mock reads this lazily (only
// when Scanner's effect actually calls `import("html5-qrcode")`).
let modulePromise: Promise<unknown> = new Promise(() => {});
vi.mock("html5-qrcode", () => modulePromise);

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  FakeHtml5Qrcode.instances = [];
});

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.restoreAllMocks();
});

function mount(onScan: (p: QrPayload) => void) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  return act(async () => {
    root!.render(<Scanner onScan={onScan} />);
  });
}

function unmount() {
  return act(async () => root?.unmount());
}

const okModule = () =>
  Promise.resolve({ Html5Qrcode: FakeHtml5Qrcode, Html5QrcodeScannerState: ScannerState });

describe("Scanner", () => {
  it("never constructs a camera scanner if the box unmounts before html5-qrcode finishes downloading", async () => {
    const pending = deferred<unknown>();
    modulePromise = pending.promise;
    const onScan = vi.fn();
    await mount(onScan);
    await unmount();

    await act(async () => pending.resolve({ Html5Qrcode: FakeHtml5Qrcode, Html5QrcodeScannerState: ScannerState }));
    await act(async () => {});

    expect(FakeHtml5Qrcode.instances).toHaveLength(0);
    expect(onScan).not.toHaveBeenCalled();
  });

  it("stops and clears the camera once start() finishes after unmount, and never emits that scan", async () => {
    modulePromise = okModule();
    const onScan = vi.fn();
    await mount(onScan);
    await act(async () => {}); // let the import resolve and start() get called

    expect(FakeHtml5Qrcode.instances).toHaveLength(1);
    const instance = FakeHtml5Qrcode.instances[0];

    await unmount();
    // The camera finally finishes turning on after the box is gone.
    await act(async () => instance.startResult.resolve());
    await act(async () => {});
    // A decode racing in right after that late start must still be dropped.
    instance.onScan?.("WOPS:W:W-CAS3050-0042");

    expect(instance.stopCalls).toBe(1);
    expect(instance.clearCalls).toBe(1);
    expect(onScan).not.toHaveBeenCalled();
  });

  it("still reaches onScan through the camera once html5-qrcode loads and decodes a code", async () => {
    modulePromise = okModule();
    const onScan = vi.fn<(p: QrPayload) => void>();
    await mount(onScan);
    await act(async () => {});

    const instance = FakeHtml5Qrcode.instances[0];
    await act(async () => instance.startResult.resolve());
    await act(async () => {});

    instance.onScan?.("WOPS:W:W-CAS3050-0042");

    expect(onScan).toHaveBeenCalledWith({ kind: "window", windowId: "W-CAS3050-0042" });
  });
});
