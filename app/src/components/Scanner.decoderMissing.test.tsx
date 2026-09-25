// @vitest-environment happy-dom
//
// A camera decoder that never arrives — its chunk failed to load on a phone
// that had not finished saving the app, say. The scanner has to say so in a
// sentence and keep the typed box working; the import's own error is a file
// address and must never reach the screen. Its own file because the module
// mock that makes the import fail has to be in place before Scanner imports.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("html5-qrcode", () => {
  throw new Error(
    "Failed to fetch dynamically imported module: https://app.example/assets/Scanner-DYdUZuY5.js",
  );
});

import { Scanner } from "./Scanner";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
});

it("says the camera is unavailable in plain words and keeps the typed box working", async () => {
  const onScan = vi.fn();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<Scanner onScan={onScan} />));

  await vi.waitFor(() =>
    expect(host!.textContent).toContain("Camera unavailable. Type the ID below instead."),
  );
  expect(host.textContent).not.toContain("dynamically imported module");
  expect(host.textContent).not.toContain("assets/");

  const input = host.querySelector("input")!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "S-03-B");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const go = [...host.querySelectorAll("button")].find((b) => b.textContent === "Go")!;
  act(() => go.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  expect(onScan).toHaveBeenCalledWith({ kind: "location", address: "S-03-B" });
});
