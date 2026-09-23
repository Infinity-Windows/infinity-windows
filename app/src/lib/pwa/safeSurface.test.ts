import { afterEach, describe, expect, it, vi } from "vitest";
import {
  claimOverlay,
  claimSafeSurface,
  onSafeSurface,
  resetSafeSurface,
  safeSurfaceClaims,
  subscribeSafeSurface,
} from "./safeSurface";

/**
 * A screen is a safe surface because it said so, and only while nothing is
 * open on top of it. The default — nobody has claimed anything — is NOT safe:
 * the first version of the opening window treated silence as safety and
 * reloaded over a live voice memo (independent review, 2026-09-23).
 */
describe("safeSurface", () => {
  afterEach(() => resetSafeSurface());

  it("is not safe until a screen claims it", () => {
    expect(onSafeSurface()).toBe(false);
  });

  it("is safe while a screen holds a claim, and not after it releases", () => {
    const release = claimSafeSurface();
    expect(onSafeSurface()).toBe(true);
    release();
    expect(onSafeSurface()).toBe(false);
  });

  it("stops being safe while a sheet or dialog is open on top", () => {
    claimSafeSurface();
    const close = claimOverlay();
    expect(onSafeSurface()).toBe(false);
    close();
    expect(onSafeSurface()).toBe(true);
  });

  it("counts overlays, so closing one sheet under another is not enough", () => {
    claimSafeSurface();
    const closeFirst = claimOverlay();
    const closeSecond = claimOverlay();
    closeFirst();
    expect(onSafeSurface()).toBe(false);
    closeSecond();
    expect(onSafeSurface()).toBe(true);
  });

  it("tolerates a double release without dropping another claim", () => {
    const release = claimSafeSurface();
    claimSafeSurface();
    release();
    release();
    expect(safeSurfaceClaims()).toEqual({ safe: 1, overlays: 0 });
    expect(onSafeSurface()).toBe(true);
  });

  it("tells listeners about every change, and stops after unsubscribe", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSafeSurface(listener);
    const release = claimSafeSurface();
    const close = claimOverlay();
    close();
    release();
    expect(listener).toHaveBeenCalledTimes(4);
    unsubscribe();
    claimSafeSurface();
    expect(listener).toHaveBeenCalledTimes(4);
  });

  it("keeps notifying the others when one listener throws", () => {
    subscribeSafeSurface(() => {
      throw new Error("bad listener");
    });
    const listener = vi.fn();
    subscribeSafeSurface(listener);
    expect(() => claimSafeSurface()).not.toThrow();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
