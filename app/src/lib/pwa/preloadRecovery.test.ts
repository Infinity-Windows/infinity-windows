import { describe, expect, it, vi } from "vitest";
import {
  PRELOAD_RELOAD_AT_KEY,
  PRELOAD_RELOAD_LOOP_WINDOW_MS,
  decidePreloadRecovery,
  installPreloadRecovery,
} from "./preloadRecovery";

describe("decidePreloadRecovery", () => {
  it("reloads once when nothing is at stake", () => {
    expect(decidePreloadRecovery({ lastReloadAt: null, now: 10_000, unsavedWork: false })).toBe("reload");
  });
  it("never reloads over unsaved work", () => {
    expect(decidePreloadRecovery({ lastReloadAt: null, now: 10_000, unsavedWork: true })).toBe("notify");
  });
  it("does not loop: a second error within the window only notifies", () => {
    expect(decidePreloadRecovery({ lastReloadAt: 10_000, now: 10_000 + PRELOAD_RELOAD_LOOP_WINDOW_MS - 1, unsavedWork: false })).toBe("notify");
    expect(decidePreloadRecovery({ lastReloadAt: 10_000, now: 10_000 + PRELOAD_RELOAD_LOOP_WINDOW_MS, unsavedWork: false })).toBe("reload");
  });
  it("treats a garbage timestamp as never", () => {
    expect(decidePreloadRecovery({ lastReloadAt: Number.NaN, now: 5, unsavedWork: false })).toBe("reload");
  });
});

function memory() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, m };
}

function fire(target: EventTarget): boolean {
  const e = new Event("vite:preloadError", { cancelable: true });
  return target.dispatchEvent(e);
}

describe("installPreloadRecovery", () => {
  it("on the first stale chunk: stops Vite's throw, stamps the time, reloads", () => {
    const target = new EventTarget();
    const storage = memory();
    const reload = vi.fn();
    const notify = vi.fn();
    const log = vi.fn();
    installPreloadRecovery({ target, storage, reload, notify, log, now: () => 1_000, unsavedWork: () => false });
    const notCancelled = fire(target);
    expect(notCancelled).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(storage.m.get(PRELOAD_RELOAD_AT_KEY)).toBe("1000");
    expect(notify).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("reloaded once"));
  });

  it("a second stale chunk within a minute does not reload again; it tells the person", () => {
    const target = new EventTarget();
    const storage = memory();
    storage.setItem(PRELOAD_RELOAD_AT_KEY, "1000");
    const reload = vi.fn();
    const notify = vi.fn();
    installPreloadRecovery({ target, storage, reload, notify, log: () => undefined, now: () => 20_000, unsavedWork: () => false });
    fire(target);
    expect(reload).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toMatch(/updated|actualizó/);
  });

  it("unsaved work on screen means a sentence, not a reload", () => {
    const target = new EventTarget();
    const reload = vi.fn();
    const notify = vi.fn();
    installPreloadRecovery({ target, storage: memory(), reload, notify, log: () => undefined, now: () => 1, unsavedWork: () => true });
    fire(target);
    expect(reload).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("no session storage at all still reloads once (the guard is best effort)", () => {
    const target = new EventTarget();
    const reload = vi.fn();
    installPreloadRecovery({ target, storage: null, reload, notify: () => undefined, log: () => undefined, now: () => 1, unsavedWork: () => false });
    fire(target);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("uninstalls cleanly", () => {
    const target = new EventTarget();
    const reload = vi.fn();
    const off = installPreloadRecovery({ target, storage: memory(), reload, notify: () => undefined, log: () => undefined, now: () => 1, unsavedWork: () => false });
    off();
    fire(target);
    expect(reload).not.toHaveBeenCalled();
  });
});
