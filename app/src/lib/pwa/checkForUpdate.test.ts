import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createActivityClock,
  createHiddenClock,
  createVersionCheck,
  fetchPublishedVersion,
  isEditingText,
  withDeadline,
} from "./checkForUpdate";

describe("createHiddenClock", () => {
  it("reports nothing when the app has been visible all along", () => {
    const clock = createHiddenClock(() => 1_000);
    expect(clock.takeHiddenDuration()).toBeNull();
  });

  it("measures how long the app was out of sight", () => {
    let now = 1_000;
    const clock = createHiddenClock(() => now);
    clock.markHidden();
    now = 61_000;
    expect(clock.takeHiddenDuration()).toBe(60_000);
  });

  it("consumes the reading so a past absence cannot be reused", () => {
    // Without this, a phone that spent ten minutes in a pocket would keep
    // looking safe to reload for the rest of the session — and an update that
    // arrived while somebody was working would reload under their thumb.
    let now = 0;
    const clock = createHiddenClock(() => now);
    clock.markHidden();
    now = 600_000;
    expect(clock.takeHiddenDuration()).toBe(600_000);
    expect(clock.takeHiddenDuration()).toBeNull();
  });

  it("measures each absence separately", () => {
    let now = 0;
    const clock = createHiddenClock(() => now);
    clock.markHidden();
    now = 5_000;
    expect(clock.takeHiddenDuration()).toBe(5_000);
    clock.markHidden();
    now = 100_000;
    expect(clock.takeHiddenDuration()).toBe(95_000);
  });
});

describe("fetchPublishedVersion", () => {
  const ok = (body: unknown) =>
    vi.fn().mockResolvedValue({ ok: true, json: async () => body });

  it("returns the published build", async () => {
    const fetchImpl = ok({ buildId: "abc123", builtAt: "2026-07-29T00:00:00Z" });
    await expect(fetchPublishedVersion(fetchImpl as never)).resolves.toEqual({
      buildId: "abc123",
      builtAt: "2026-07-29T00:00:00Z",
    });
  });

  it("bypasses the HTTP cache", async () => {
    // GitHub Pages serves assets with a max-age, so without no-store the
    // browser would answer from its own cache and the app would never learn
    // about a new build — the exact staleness this exists to defeat.
    const fetchImpl = ok({ buildId: "abc123" });
    await fetchPublishedVersion(fetchImpl as never);
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining("version.json"),
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  it("asks past the CDN with an address it has never seen", async () => {
    // no-store only reaches the browser's cache; GitHub's CDN holds version.json
    // for up to ten minutes after a deploy unless the address is new to it.
    const fetchImpl = ok({ buildId: "abc123" });
    await fetchPublishedVersion(fetchImpl as never, () => 1234);
    await fetchPublishedVersion(fetchImpl as never, () => 5678);
    expect(fetchImpl.mock.calls[0][0]).toMatch(/version\.json\?t=1234$/);
    expect(fetchImpl.mock.calls[1][0]).toMatch(/version\.json\?t=5678$/);
  });

  it("reads a non-200 as unknown", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) });
    await expect(fetchPublishedVersion(fetchImpl as never)).resolves.toBeNull();
  });

  it("reads a network failure as unknown rather than throwing", async () => {
    // Offline is normal on a job site.
    const fetchImpl = vi.fn().mockRejectedValue(new Error("offline"));
    await expect(fetchPublishedVersion(fetchImpl as never)).resolves.toBeNull();
  });

  it("reads an unparseable body as unknown", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => {
        throw new Error("not json");
      },
    });
    await expect(fetchPublishedVersion(fetchImpl as never)).resolves.toBeNull();
  });

  it("reads a body that is not a version file as unknown", async () => {
    const fetchImpl = ok({ nope: true });
    await expect(fetchPublishedVersion(fetchImpl as never)).resolves.toBeNull();
  });

  it("hands the abort signal to the request", async () => {
    const fetchImpl = ok({ buildId: "abc123" });
    const controller = new AbortController();
    await fetchPublishedVersion(fetchImpl as never, () => 1, controller.signal);
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ signal: controller.signal }),
    );
  });
});

describe("createVersionCheck", () => {
  // The banner checks on a timer, on every return to the app, on sign-in and
  // whenever a registration or queue changes. On a stalled connection each
  // of those used to open another request that never closed (independent
  // review, 2026-09-23). One at a time, with a deadline.
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shares one request between callers that overlap", async () => {
    let resolve!: (value: unknown) => void;
    const fetchImpl = vi.fn(() => new Promise((r) => (resolve = r)));
    const check = createVersionCheck({ fetchImpl: fetchImpl as never });
    const first = check.run();
    const second = check.run();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    resolve({ ok: true, json: async () => ({ buildId: "b1" }) });
    await expect(first).resolves.toEqual({ buildId: "b1", builtAt: "" });
    await expect(second).resolves.toEqual({ buildId: "b1", builtAt: "" });
  });

  it("asks again once the previous request has answered", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ buildId: "b1" }) });
    const check = createVersionCheck({ fetchImpl: fetchImpl as never });
    await check.run();
    await check.run();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("gives up on a request that never answers, and reads it as unknown", async () => {
    vi.useFakeTimers();
    const seen: AbortSignal[] = [];
    const fetchImpl = vi.fn((_url: string, init: { signal: AbortSignal }) => {
      seen.push(init.signal);
      return new Promise(() => {});
    });
    const check = createVersionCheck({ fetchImpl: fetchImpl as never, timeoutMs: 8_000 });
    const pending = check.run();
    await vi.advanceTimersByTimeAsync(7_999);
    expect(seen[0].aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBeNull();
    expect(seen[0].aborted).toBe(true);
    // The line is clear for the next check, even though the old request's
    // promise itself never settled.
    void check.run();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("can be told to stop, for a banner that is unmounting", async () => {
    const seen: AbortSignal[] = [];
    const fetchImpl = vi.fn((_url: string, init: { signal: AbortSignal }) => {
      seen.push(init.signal);
      return Promise.reject(new Error("aborted"));
    });
    const check = createVersionCheck({ fetchImpl: fetchImpl as never });
    const pending = check.run();
    check.abort();
    expect(seen[0].aborted).toBe(true);
    await expect(pending).resolves.toBeNull();
  });
});

describe("withDeadline", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("passes a prompt answer through", async () => {
    await expect(withDeadline(Promise.resolve(7), 1_000)).resolves.toBe(7);
  });

  it("answers undefined when the deadline passes first", async () => {
    vi.useFakeTimers();
    const pending = withDeadline(new Promise<number>(() => {}), 30_000);
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(pending).resolves.toBeUndefined();
  });

  it("still rejects when the work rejects", async () => {
    await expect(withDeadline(Promise.reject(new Error("offline")), 1_000)).rejects.toThrow(
      "offline",
    );
  });
});

describe("createActivityClock", () => {
  it("starts fresh, because creating it is the app opening", () => {
    let t = 1_000;
    const clock = createActivityClock(() => t);
    t = 31_000;
    expect(clock.read()).toEqual({
      freshForMs: 30_000,
      typedSinceFresh: false,
      msSinceInteraction: null,
    });
  });

  it("measures time since the last tap", () => {
    let t = 0;
    const clock = createActivityClock(() => t);
    t = 10_000;
    clock.noteInteraction();
    t = 12_500;
    expect(clock.read().msSinceInteraction).toBe(2_500);
  });

  it("remembers typing until the next fresh moment", () => {
    // A half-typed note is what a reload would silently eat, so typing ends
    // the fresh window — until someone signs in, which starts a new one.
    let t = 0;
    const clock = createActivityClock(() => t);
    clock.noteTyped();
    expect(clock.read().typedSinceFresh).toBe(true);
    t = 50_000;
    clock.markFresh();
    expect(clock.read()).toMatchObject({ freshForMs: 0, typedSinceFresh: false });
  });

  it("counts typing as an interaction too", () => {
    let t = 0;
    const clock = createActivityClock(() => t);
    t = 5_000;
    clock.noteTyped();
    t = 6_000;
    expect(clock.read().msSinceInteraction).toBe(1_000);
  });
});

describe("isEditingText", () => {
  const el = (
    tagName: string,
    attrs: Record<string, string> = {},
    isContentEditable = false,
  ) =>
    ({
      tagName,
      isContentEditable,
      getAttribute: (name: string) => attrs[name] ?? null,
    }) as unknown as Element;

  it("is false when nothing has focus", () => {
    expect(isEditingText(null)).toBe(false);
  });

  it("is true for text boxes, including ones with no type", () => {
    expect(isEditingText(el("TEXTAREA"))).toBe(true);
    expect(isEditingText(el("INPUT"))).toBe(true);
    for (const type of ["text", "email", "number", "search", "tel", "date", "password"]) {
      expect(isEditingText(el("INPUT", { type }))).toBe(true);
    }
  });

  it("is false for controls that hold no typed text", () => {
    for (const type of ["checkbox", "radio", "button", "submit", "file", "range"]) {
      expect(isEditingText(el("INPUT", { type }))).toBe(false);
    }
    expect(isEditingText(el("BUTTON"))).toBe(false);
    expect(isEditingText(el("DIV"))).toBe(false);
  });

  it("is true for editable regions", () => {
    expect(isEditingText(el("DIV", {}, true))).toBe(true);
    expect(isEditingText(el("DIV", { contenteditable: "true" }))).toBe(true);
    expect(isEditingText(el("DIV", { contenteditable: "" }))).toBe(true);
    expect(isEditingText(el("DIV", { contenteditable: "false" }))).toBe(false);
  });
});
