import { afterEach, describe, expect, it, vi } from "vitest";
import {
  claimUnsavedWork,
  hasUnsavedWork,
  resetUnsavedWork,
  subscribeUnsavedWork,
  unsavedWorkClaims,
} from "./unsavedWork";

/**
 * This registry is the only thing standing between a housekeeping reload and an
 * installer's unsubmitted photos, so the edges matter more than the happy path:
 * two screens claiming at once, a release running twice from a React effect
 * cleanup, and an unmount that forgets to release.
 */

afterEach(() => {
  resetUnsavedWork();
});

describe("claimUnsavedWork", () => {
  it("starts with nothing claimed", () => {
    expect(hasUnsavedWork()).toBe(false);
  });

  it("reports unsaved work while a claim is held", () => {
    claimUnsavedWork();
    expect(hasUnsavedWork()).toBe(true);
  });

  it("clears once the claim is released", () => {
    const release = claimUnsavedWork();
    release();
    expect(hasUnsavedWork()).toBe(false);
  });

  it("keeps reporting unsaved work while any claim remains", () => {
    // Two screens can hold capture at once; the first to finish must not clear
    // the other's claim.
    const releaseA = claimUnsavedWork();
    claimUnsavedWork();
    releaseA();
    expect(hasUnsavedWork()).toBe(true);
    expect(unsavedWorkClaims()).toBe(1);
  });

  it("ignores a release called more than once", () => {
    // React can run an effect cleanup twice in StrictMode. Double-counting the
    // release would drop somebody else's claim and make a reload look safe.
    const releaseA = claimUnsavedWork();
    claimUnsavedWork();
    releaseA();
    releaseA();
    releaseA();
    expect(unsavedWorkClaims()).toBe(1);
    expect(hasUnsavedWork()).toBe(true);
  });

  it("never goes negative", () => {
    const release = claimUnsavedWork();
    release();
    release();
    expect(unsavedWorkClaims()).toBe(0);
    expect(hasUnsavedWork()).toBe(false);
  });
});

describe("subscribeUnsavedWork", () => {
  it("notifies on claim and on release", () => {
    const seen = vi.fn();
    subscribeUnsavedWork(seen);
    const release = claimUnsavedWork();
    expect(seen).toHaveBeenCalledTimes(1);
    release();
    expect(seen).toHaveBeenCalledTimes(2);
  });

  it("stops notifying after unsubscribe", () => {
    const seen = vi.fn();
    const off = subscribeUnsavedWork(seen);
    off();
    claimUnsavedWork();
    expect(seen).not.toHaveBeenCalled();
  });

  it("keeps notifying the other listeners when one throws", () => {
    const good = vi.fn();
    subscribeUnsavedWork(() => {
      throw new Error("bad listener");
    });
    subscribeUnsavedWork(good);
    expect(() => claimUnsavedWork()).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);
  });
});
