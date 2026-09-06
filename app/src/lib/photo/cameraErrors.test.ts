import { describe, it, expect } from "vitest";
import { isPermanentCameraFailure } from "./cameraErrors";

describe("isPermanentCameraFailure", () => {
  it("treats a refused permission as permanent", () => {
    expect(isPermanentCameraFailure(new DOMException("denied", "NotAllowedError"))).toBe(true);
    expect(isPermanentCameraFailure(new DOMException("blocked", "SecurityError"))).toBe(true);
  });

  it("treats a device with no camera as permanent", () => {
    expect(isPermanentCameraFailure(new DOMException("none", "NotFoundError"))).toBe(true);
  });

  it("accepts the old WebView spellings of the same two answers", () => {
    // An in-app WebView rejects with a plain object, not a DOMException.
    expect(isPermanentCameraFailure({ name: "PermissionDeniedError" })).toBe(true);
    expect(isPermanentCameraFailure({ name: "DevicesNotFoundError" })).toBe(true);
  });

  it("treats a camera another app is holding as worth another tap", () => {
    // The Android everyday case: the OS camera app is open behind us. Closing
    // it and tapping again works, so the sheet must not give the shutter away.
    expect(isPermanentCameraFailure(new DOMException("busy", "NotReadableError"))).toBe(false);
    expect(isPermanentCameraFailure(new DOMException("aborted", "AbortError"))).toBe(false);
  });

  it("treats anything it does not recognise as worth another tap", () => {
    expect(isPermanentCameraFailure(new Error("boom"))).toBe(false);
    expect(isPermanentCameraFailure("NotAllowedError")).toBe(false);
    expect(isPermanentCameraFailure(null)).toBe(false);
    expect(isPermanentCameraFailure(undefined)).toBe(false);
    expect(isPermanentCameraFailure({})).toBe(false);
  });
});
