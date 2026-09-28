// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { Scanner } from "./Scanner";

vi.mock("html5-qrcode", () => {
  throw new Error("Failed to fetch dynamically imported module: https://forge.example/assets/html5-qrcode-abcd1234.js");
});

it("keeps typed ID entry usable without showing a failed decoder asset URL", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const onScan = vi.fn();
  try {
    await act(async () => root.render(<Scanner onScan={onScan} />));
    await act(async () => {});
    const errorText = host.querySelector(".error")?.textContent ?? "";
    expect(errorText).toBe("Camera unavailable. Type the ID below instead.");
    expect(errorText).not.toMatch(/https?:|\.js/);

    const input = host.querySelector("input") as HTMLInputElement;
    const button = host.querySelector(".manual-entry button") as HTMLButtonElement;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setValue.call(input, "W-CAS3050-0042");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onScan).toHaveBeenCalledWith({ kind: "window", windowId: "W-CAS3050-0042" });
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
