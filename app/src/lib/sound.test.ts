// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  playErrorTone,
  playSuccessTone,
  resetAudioContextForTests,
  setSoundsEnabled,
  soundsEnabled,
} from "./sound";

beforeEach(() => {
  localStorage.clear();
});

describe("the toggle", () => {
  it("is off by default", () => {
    expect(soundsEnabled()).toBe(false);
  });

  it("persists on, and off again", () => {
    setSoundsEnabled(true);
    expect(soundsEnabled()).toBe(true);
    setSoundsEnabled(false);
    expect(soundsEnabled()).toBe(false);
  });

  it("reads as off when storage is unreadable, never throws", () => {
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    expect(soundsEnabled()).toBe(false);
    spy.mockRestore();
  });

  it("swallows a write failure instead of crashing the toggle", () => {
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(() => setSoundsEnabled(true)).not.toThrow();
    spy.mockRestore();
  });
});

/**
 * A minimal Web Audio stand-in. Real AudioContext isn't implemented in
 * happy-dom, so these tests supply just enough of the surface
 * playSuccessTone/playErrorTone touch to prove the toggle actually gates
 * playback — "respect the toggle everywhere" (pick 29) is the one contract
 * worth more than a smoke test.
 */
class FakeAudioNode {
  connect = vi.fn((dest: unknown) => dest);
}
class FakeGainNode extends FakeAudioNode {
  gain = {
    setValueAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
  };
}
class FakeOscillatorNode extends FakeAudioNode {
  type = "";
  frequency = { setValueAtTime: vi.fn() };
  start = vi.fn();
  stop = vi.fn();
}
class FakeAudioContext {
  state: "running" | "suspended" = "running";
  currentTime = 0;
  destination = new FakeAudioNode();
  resume = vi.fn(async () => {
    this.state = "running";
  });
  createOscillator = vi.fn(() => new FakeOscillatorNode());
  createGain = vi.fn(() => new FakeGainNode());
}

let fakeCtx: FakeAudioContext;

beforeEach(() => {
  fakeCtx = new FakeAudioContext();
  // A plain function, not an arrow: sound.ts calls `new Ctor()`, and a
  // constructor function returning an object hands that object back as the
  // instance — which is what lets every test point `new AudioContext()` at
  // its own fresh fake.
  vi.stubGlobal(
    "AudioContext",
    vi.fn(function FakeAudioContextCtor() {
      return fakeCtx;
    }),
  );
  // The module caches one AudioContext per page load by design (there is
  // only ever one tab); without dropping it here every test after the first
  // would keep talking to test 1's fake instead of its own.
  resetAudioContextForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("playSuccessTone / playErrorTone", () => {
  it("never touches Web Audio while the toggle is off", () => {
    setSoundsEnabled(false);
    playSuccessTone();
    playErrorTone();
    expect(fakeCtx.createOscillator).not.toHaveBeenCalled();
  });

  it("schedules one tone for success once enabled", () => {
    setSoundsEnabled(true);
    playSuccessTone();
    expect(fakeCtx.createOscillator).toHaveBeenCalledTimes(1);
    const osc = fakeCtx.createOscillator.mock.results[0]!.value as FakeOscillatorNode;
    expect(osc.start).toHaveBeenCalledTimes(1);
  });

  it("schedules two tones for the refusal buzz", () => {
    setSoundsEnabled(true);
    playErrorTone();
    expect(fakeCtx.createOscillator).toHaveBeenCalledTimes(2);
  });

  it("resumes a suspended context before playing", () => {
    setSoundsEnabled(true);
    fakeCtx.state = "suspended";
    playSuccessTone();
    expect(fakeCtx.resume).toHaveBeenCalledTimes(1);
  });

  it("never throws even with no Web Audio support at all", () => {
    vi.unstubAllGlobals();
    setSoundsEnabled(true);
    expect(() => playSuccessTone()).not.toThrow();
    expect(() => playErrorTone()).not.toThrow();
  });
});
