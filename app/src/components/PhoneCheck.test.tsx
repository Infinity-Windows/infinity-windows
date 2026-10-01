// @vitest-environment happy-dom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PhoneCheck } from "./PhoneCheck";

let container: HTMLDivElement;
let root: Root | null;
const originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, "srcObject", "set").mockImplementation(() => undefined);
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  container.remove();
  if (originalMediaDevices) Object.defineProperty(navigator, "mediaDevices", originalMediaDevices);
  else Reflect.deleteProperty(navigator, "mediaDevices");
  vi.restoreAllMocks();
});

function render() {
  const onResult = vi.fn();
  act(() => root!.render(<StrictMode><PhoneCheck onResult={onResult} /></StrictMode>));
  return onResult;
}

function cameraButton() {
  return container.querySelector('[data-testid="phone-check-camera"] button') as HTMLButtonElement;
}

describe("PhoneCheck camera preview", () => {
  it("can run another check after the StrictMode mount cycle", async () => {
    const onResult = render();
    const button = container.querySelector('[data-testid="phone-check-storage"] button') as HTMLButtonElement;
    await act(async () => button.click());
    expect(button.disabled).toBe(false);
    expect(onResult).toHaveBeenCalledWith("storage", expect.objectContaining({ status: "unsupported" }));
    await act(async () => button.click());
    expect(button.disabled).toBe(false);
    expect(onResult).toHaveBeenCalledTimes(4); // clear + result for each run
  });

  it("stops the camera after the user confirms a picture", async () => {
    const stop = vi.fn();
    const getUserMedia = vi.fn().mockResolvedValue({ getTracks: () => [{ stop }] });
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
    const onResult = render();

    await act(async () => cameraButton().click());
    expect(getUserMedia).toHaveBeenCalledWith({ audio: false, video: { facingMode: { ideal: "environment" } } });
    expect(container.querySelector("video")).not.toBeNull();
    await act(async () => {
      (container.querySelector('[data-testid="phone-check-camera"] button:last-child') as HTMLButtonElement).click();
    });
    expect(stop).toHaveBeenCalledOnce();
    expect(onResult).toHaveBeenCalledWith("camera", expect.objectContaining({ status: "fail", reason: "not_working" }));
  });

  it("releases a camera granted after leaving Diagnostics", async () => {
    const stop = vi.fn();
    let grant!: (stream: MediaStream) => void;
    const getUserMedia = vi.fn().mockReturnValue(new Promise<MediaStream>(resolve => { grant = resolve; }));
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
    render();

    act(() => cameraButton().click());
    act(() => root!.unmount());
    root = null;
    await act(async () => grant({ getTracks: () => [{ stop }] } as unknown as MediaStream));
    expect(stop).toHaveBeenCalledOnce();
  });
});
