import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  WEAK_SIGNAL_WINDOW_MS,
  PHOTO_UPLOAD_TIMEOUT_MS,
  isWeakSignalRecent,
  lastSuccessfulRequestAt,
  markRequestOk,
  markWeakSignal,
  resetWeakSignal,
  shouldTime,
  subscribeWeakSignal,
  timedFetch,
} from "./weakSignal";
import { clearOfflineEvents, getOfflineEvents } from "./telemetry";

const ok = () => new Response("[]", { status: 200 });
const never = (signal?: AbortSignal | null) =>
  new Promise<Response>((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  });

describe("the weak-signal mark", () => {
  beforeEach(() => { resetWeakSignal(); clearOfflineEvents(); });

  it("lasts twenty seconds, then lapses", () => {
    markWeakSignal(1_000);
    expect(isWeakSignalRecent(1_000)).toBe(true);
    expect(isWeakSignalRecent(1_000 + WEAK_SIGNAL_WINDOW_MS - 1)).toBe(true);
    expect(isWeakSignalRecent(1_000 + WEAK_SIGNAL_WINDOW_MS)).toBe(false);
  });

  it("a good request clears it and is remembered", () => {
    markWeakSignal(1_000);
    markRequestOk(2_000);
    expect(isWeakSignalRecent(2_000)).toBe(false);
    expect(lastSuccessfulRequestAt()).toBe(2_000);
  });

  it("writes a timeout event and tells subscribers", () => {
    let calls = 0;
    const off = subscribeWeakSignal(() => { calls += 1; });
    markWeakSignal(5);
    expect(calls).toBe(1);
    expect(getOfflineEvents()[0]).toMatchObject({ type: "timeout", scope: "supabase", at: 5 });
    off();
  });

  it("bounds database, auth and signed-link calls without cutting off large downloads", () => {
    expect(shouldTime("https://x.supabase.co/rest/v1/projects?select=*")).toBe(true);
    expect(shouldTime("https://x.supabase.co/auth/v1/token")).toBe(true);
    expect(shouldTime("https://x.supabase.co/storage/v1/object/sign/install-media/photo.jpg")).toBe(true);
    expect(shouldTime("https://x.supabase.co/storage/v1/object/plansets/a.pdf")).toBe(false);
    expect(shouldTime("https://x.supabase.co/functions/v1/ask")).toBe(false);
  });
});

describe("timedFetch", () => {
  beforeEach(() => { resetWeakSignal(); clearOfflineEvents(); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it.each(["install-media/job/photo.jpg", "service-media/job/memo.mp4"])("bounds a stalled evidence upload: %s", async (path) => {
    const onTimeout = vi.fn();
    const result = timedFetch(`https://x.supabase.co/storage/v1/object/${path}`, {method:"POST"}, {
      fetch: (_input, init) => never(init?.signal), now: () => 42, onTimeout, onOk: () => undefined,
    }).catch(error => error);
    await vi.advanceTimersByTimeAsync(15_001);
    expect(onTimeout).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(PHOTO_UPLOAD_TIMEOUT_MS);
    expect(await result).toBeInstanceOf(TypeError);
    expect(onTimeout).toHaveBeenCalledWith(42);
  });

  it("aborts a stalled gallery signing request so one image cannot hold the gallery forever", async () => {
    const onTimeout = vi.fn();
    const result = timedFetch("https://x.supabase.co/storage/v1/object/sign/install-media/photo.jpg", {method:"POST"}, {
      fetch: (_input, init) => never(init?.signal), timeoutMs: 100, now: () => 42, onTimeout, onOk: () => undefined,
    }).catch(error => error);
    await vi.advanceTimersByTimeAsync(101);
    expect(await result).toBeInstanceOf(TypeError);
    expect(onTimeout).toHaveBeenCalledWith(42);
  });

  it("a database call that hangs is aborted, marked weak, and fails like a dropped connection", async () => {
    const onTimeout = vi.fn();
    const onOk = vi.fn();
    const p = timedFetch("https://x.supabase.co/rest/v1/projects", undefined, {
      fetch: (_i, init) => never(init?.signal),
      timeoutMs: 100, now: () => 42, onTimeout, onOk,
    });
    const settled = p.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(101);
    const err = await settled;
    expect(err).toBeInstanceOf(TypeError);
    expect(String((err as Error).message)).toMatch(/weak signal/);
    expect(onTimeout).toHaveBeenCalledWith(42);
    expect(onOk).not.toHaveBeenCalled();
  });

  it("a database call that answers in time is recorded as ok", async () => {
    const onTimeout = vi.fn();
    const onOk = vi.fn();
    const res = await timedFetch("https://x.supabase.co/rest/v1/projects", undefined, {
      fetch: async () => ok(), timeoutMs: 100, now: () => 7, onTimeout, onOk,
    });
    expect(res.status).toBe(200);
    expect(onOk).toHaveBeenCalledWith(7);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("a storage download gets no deadline, however long it takes", async () => {
    const onTimeout = vi.fn();
    let resolve!: (r: Response) => void;
    const slow = new Promise<Response>((r) => { resolve = r; });
    const p = timedFetch("https://x.supabase.co/storage/v1/object/plansets/a.pdf", undefined, {
      fetch: () => slow, timeoutMs: 100, now: () => 1, onTimeout, onOk: () => undefined,
    });
    await vi.advanceTimersByTimeAsync(10_000);
    resolve(ok());
    expect((await p).status).toBe(200);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("a caller's own abort is not a timeout", async () => {
    const onTimeout = vi.fn();
    const outer = new AbortController();
    const p = timedFetch("https://x.supabase.co/rest/v1/projects", { signal: outer.signal }, {
      fetch: (_i, init) => never(init?.signal), timeoutMs: 1_000, now: () => 1, onTimeout, onOk: () => undefined,
    });
    const settled = p.catch((e: unknown) => e);
    outer.abort();
    await vi.advanceTimersByTimeAsync(1);
    const err = await settled;
    expect((err as Error).name).toBe("AbortError");
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("a genuine network failure is passed through and not marked weak", async () => {
    const onTimeout = vi.fn();
    await expect(
      timedFetch("https://x.supabase.co/rest/v1/projects", undefined, {
        fetch: async () => { throw new TypeError("Failed to fetch"); },
        timeoutMs: 100, now: () => 1, onTimeout, onOk: () => undefined,
      }),
    ).rejects.toThrow("Failed to fetch");
    expect(onTimeout).not.toHaveBeenCalled();
  });
});
