// @vitest-environment happy-dom
//
// The warm-fix holder: the piece that decides whether a shutter stamps at once
// or waits. Every case here is a real one from a phone at a window — a fix
// already in hand, a fix from ten minutes ago, no fix at all indoors, a phone
// whose owner tapped Deny — plus the promise that the watch dies with the
// screen. The hook is mounted for real at the bottom, because "we stop the
// watch on unmount" is a claim about React, not about this module.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import {
  createFixHolder,
  FIX_MAX_AGE_MS,
  SHUTTER_FIX_WAIT_MS,
  useWarmGeoFix,
  warmGeoFix,
  type GeoWatchSource,
} from "./geoWatch";

function position(lat: number, lng: number, accuracy = 12): GeolocationPosition {
  return {
    coords: { latitude: lat, longitude: lng, accuracy },
    timestamp: 0,
  } as GeolocationPosition;
}

function error(code: number): GeolocationPositionError {
  return {
    code,
    message: "",
    PERMISSION_DENIED: 1,
    POSITION_UNAVAILABLE: 2,
    TIMEOUT: 3,
  } as GeolocationPositionError;
}

function fakeSource() {
  const watchers: { ok: PositionCallback; err?: PositionErrorCallback | null }[] = [];
  const cleared: number[] = [];
  let nextId = 1;
  const source: GeoWatchSource = {
    watchPosition(ok, err) {
      watchers.push({ ok, err });
      return nextId++;
    },
    clearWatch(id) {
      cleared.push(id);
    },
  };
  return {
    source,
    cleared,
    watchCount: () => watchers.length,
    fire: (lat: number, lng: number, accuracy?: number) => {
      for (const w of watchers) w.ok(position(lat, lng, accuracy));
    },
    fail: (code: number) => {
      for (const w of watchers) w.err?.(error(code));
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("the warm fix the shutter reads", () => {
  it("hands back a fix it already holds, with no wait at all", async () => {
    const s = fakeSource();
    const cold = vi.fn(async () => ({}));
    const holder = createFixHolder(() => s.source, cold);
    holder.start();
    s.fire(30.2672, -97.7431, 8);

    expect(holder.peek()).toEqual({ lat: 30.2672, lng: -97.7431, accuracyM: 8 });
    await expect(holder.waitFor()).resolves.toEqual({
      lat: 30.2672,
      lng: -97.7431,
      accuracyM: 8,
    });
    // The warm path must never fall through to a lookup of its own.
    expect(cold).not.toHaveBeenCalled();
  });

  it("keeps the newest fix as the phone moves", () => {
    const s = fakeSource();
    const holder = createFixHolder(() => s.source, async () => ({}));
    holder.start();
    s.fire(30.1, -97.1);
    s.fire(30.9, -97.9, 5);
    expect(holder.peek()).toEqual({ lat: 30.9, lng: -97.9, accuracyM: 5 });
  });

  it("refuses a fix older than the staleness cutoff", async () => {
    vi.useFakeTimers();
    const s = fakeSource();
    let clock = 1_000_000;
    const holder = createFixHolder(() => s.source, async () => ({}), () => clock);
    holder.start();
    s.fire(30.2672, -97.7431);

    clock += FIX_MAX_AGE_MS;
    expect(holder.peek()).toEqual({ lat: 30.2672, lng: -97.7431, accuracyM: 12 });

    clock += 1;
    expect(holder.peek()).toEqual({});
    // And a stale fix is never stamped: the shutter waits for a new one and
    // then gives up, rather than burning last hour's coordinates in.
    const waiting = holder.waitFor();
    await vi.advanceTimersByTimeAsync(SHUTTER_FIX_WAIT_MS);
    await expect(waiting).resolves.toEqual({});
  });

  it("caps the cold-start wait and then stamps time-only", async () => {
    vi.useFakeTimers();
    const s = fakeSource();
    const holder = createFixHolder(() => s.source, async () => ({}));
    holder.start();

    const waiting = holder.waitFor();
    await vi.advanceTimersByTimeAsync(SHUTTER_FIX_WAIT_MS - 1);
    let settled = false;
    void waiting.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(waiting).resolves.toEqual({});
  });

  it("answers the moment a fix lands mid-wait", async () => {
    vi.useFakeTimers();
    const s = fakeSource();
    const holder = createFixHolder(() => s.source, async () => ({}));
    holder.start();

    const waiting = holder.waitFor();
    await vi.advanceTimersByTimeAsync(400);
    s.fire(30.5, -97.5, 20);
    await expect(waiting).resolves.toEqual({ lat: 30.5, lng: -97.5, accuracyM: 20 });
  });

  it("stops waiting at all once the phone has said no", async () => {
    const s = fakeSource();
    const holder = createFixHolder(() => s.source, async () => ({}));
    holder.start();
    s.fail(1); // PERMISSION_DENIED
    // No fake timers here on purpose: a denied phone must resolve without one.
    await expect(holder.waitFor()).resolves.toEqual({});
  });

  it("treats a timeout as passing weather, not a refusal", async () => {
    vi.useFakeTimers();
    const s = fakeSource();
    const holder = createFixHolder(() => s.source, async () => ({}));
    holder.start();
    s.fail(3); // TIMEOUT — the watch keeps running

    const waiting = holder.waitFor();
    await vi.advanceTimersByTimeAsync(500);
    s.fire(30.4, -97.4, 30);
    await expect(waiting).resolves.toEqual({ lat: 30.4, lng: -97.4, accuracyM: 30 });
  });

  it("falls back to a one-shot lookup when nobody warmed it up", async () => {
    const s = fakeSource();
    const cold = vi.fn(async () => ({ lat: 1, lng: 2, accuracyM: 3 }));
    const holder = createFixHolder(() => s.source, cold);
    await expect(holder.waitFor()).resolves.toEqual({ lat: 1, lng: 2, accuracyM: 3 });
    expect(cold).toHaveBeenCalledWith(SHUTTER_FIX_WAIT_MS);
    expect(s.watchCount()).toBe(0);
  });

  it("stamps time-only on a device with no geolocation at all", async () => {
    const cold = vi.fn(async () => ({}));
    const holder = createFixHolder(() => null, cold);
    holder.start();
    expect(holder.watching()).toBe(false);
    await expect(holder.waitFor()).resolves.toEqual({});
  });
});

describe("the watch ends with the screen", () => {
  it("runs one watch for several screens and clears it with the last", () => {
    const s = fakeSource();
    const holder = createFixHolder(() => s.source, async () => ({}));
    const stopA = holder.start();
    const stopB = holder.start();
    expect(s.watchCount()).toBe(1);

    stopA();
    expect(s.cleared).toEqual([]);
    expect(holder.watching()).toBe(true);

    stopB();
    expect(s.cleared).toEqual([1]);
    expect(holder.watching()).toBe(false);
  });

  it("ignores a stop called twice, so the next screen keeps its watch", () => {
    const s = fakeSource();
    const holder = createFixHolder(() => s.source, async () => ({}));
    const stopA = holder.start();
    const stopB = holder.start();
    stopA();
    stopA();
    expect(s.cleared).toEqual([]);
    stopB();
    expect(s.cleared).toEqual([1]);
  });

  it("starts a fresh watch when a screen opens again", () => {
    const s = fakeSource();
    const holder = createFixHolder(() => s.source, async () => ({}));
    holder.start()();
    expect(s.cleared).toEqual([1]);
    holder.start();
    expect(s.watchCount()).toBe(2);
  });
});

describe("useWarmGeoFix", () => {
  it("starts a watch on mount and clears it on unmount", () => {
    const s = fakeSource();
    Object.defineProperty(navigator, "geolocation", {
      value: s.source,
      configurable: true,
    });

    function Probe() {
      useWarmGeoFix();
      return null;
    }

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(<Probe />);
    });
    expect(warmGeoFix.watching()).toBe(true);
    expect(s.watchCount()).toBe(1);

    act(() => {
      root.unmount();
    });
    // The battery cost ends with the screen.
    expect(warmGeoFix.watching()).toBe(false);
    expect(s.cleared).toEqual([1]);
    container.remove();
  });
});
