// @vitest-environment happy-dom
//
// The camera decoder (html5-qrcode) loads when a scanner opens, not with the
// app (2026-09-25, see Scanner.tsx's header). What that must not change: the
// typed box works from the first frame, the camera starts once the decoder
// arrives and stops when the scanner closes, and a scanner closed before the
// decoder arrived never turns a camera on. A decoder that cannot load at all
// is Scanner.decoderMissing.test.tsx.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const decoder = vi.hoisted(() => ({
  constructed: [] as string[],
  start: vi.fn(),
  stop: vi.fn(),
  clear: vi.fn(),
  getState: vi.fn(),
}));

vi.mock("html5-qrcode", () => ({
  // The real enum's values (html5-qrcode/esm/state-manager.js).
  Html5QrcodeScannerState: { UNKNOWN: 0, NOT_STARTED: 1, SCANNING: 2, PAUSED: 3 },
  Html5Qrcode: class {
    constructor(elementId: string) {
      decoder.constructed.push(elementId);
    }
    start = decoder.start;
    stop = decoder.stop;
    clear = decoder.clear;
    getState = decoder.getState;
  },
}));

import { Scanner } from "./Scanner";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  decoder.constructed.length = 0;
  decoder.start.mockReset().mockResolvedValue(null);
  decoder.stop.mockReset().mockResolvedValue(undefined);
  decoder.clear.mockReset();
  decoder.getState.mockReset().mockReturnValue(2); // SCANNING
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function mount(onScan = vi.fn()) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<Scanner onScan={onScan} />));
  return { el: host, onScan };
}

function typeAndGo(el: HTMLElement, text: string) {
  const input = el.querySelector("input")!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const go = [...el.querySelectorAll("button")].find((b) => b.textContent === "Go")!;
  act(() => go.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

describe("Scanner, with its camera decoder loaded on demand", () => {
  it("takes a typed ID before the decoder has even arrived", () => {
    const { el, onScan } = mount();
    // Nothing has been awaited: the decoder's import cannot have resolved.
    expect(decoder.constructed).toEqual([]);
    typeAndGo(el, "S-03-B");
    expect(onScan).toHaveBeenCalledWith({ kind: "location", address: "S-03-B" });
  });

  it("starts the back camera once the decoder arrives, in the box it rendered", async () => {
    const { el } = mount();
    await act(() => vi.dynamicImportSettled());
    const viewport = el.querySelector(".scanner-viewport")!;
    expect(decoder.constructed).toEqual([viewport.id]);
    expect(decoder.start).toHaveBeenCalledOnce();
    expect(decoder.start.mock.calls[0][0]).toEqual({ facingMode: "environment" });
  });

  it("hands a decoded label to onScan", async () => {
    const { onScan } = mount();
    await act(() => vi.dynamicImportSettled());
    const onDecoded = decoder.start.mock.calls[0][2] as (text: string) => void;
    act(() => onDecoded("WOPS:PS:PKG-000123"));
    expect(onScan).toHaveBeenCalledWith({ kind: "packageSerial", serial: "PKG-000123" });
  });

  it("stops and clears the camera when the scanner closes", async () => {
    mount();
    await act(() => vi.dynamicImportSettled());
    act(() => root!.unmount());
    root = null;
    await vi.waitFor(() => expect(decoder.clear).toHaveBeenCalledOnce());
    expect(decoder.stop).toHaveBeenCalledOnce();
  });

  it("never turns a camera on for a scanner closed before its decoder arrived", async () => {
    mount();
    act(() => root!.unmount());
    root = null;
    await vi.dynamicImportSettled();
    expect(decoder.constructed).toEqual([]);
    expect(decoder.start).not.toHaveBeenCalled();
  });

  it("still shows a camera that will not start as the reason, as before", async () => {
    decoder.start.mockRejectedValue(new Error("Permission denied"));
    const { el } = mount();
    await act(() => vi.dynamicImportSettled());
    await vi.waitFor(() => expect(el.textContent).toContain("Permission denied"));
  });
});
