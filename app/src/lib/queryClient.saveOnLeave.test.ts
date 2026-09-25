// @vitest-environment happy-dom
import { dehydrate, QueryClient } from "@tanstack/react-query";
import type { PersistedClient } from "@tanstack/react-query-persist-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// api.ts reaches for supabase at import time; nothing here calls the network.
vi.mock("./supabase", () => ({ supabase: {} }));
import {
  installSaveOnLeave,
  leaveSafePersister,
  persister,
  type LeaveEvents,
} from "./queryClient";

/**
 * The phone's copy of the cache has to be on disk when the page goes away, not
 * up to a second later.
 *
 * e2e/queued-clock.spec.ts reloads with no signal about 0.8 s after the landing
 * appears. In half its runs nothing had been written yet: the reopened app had
 * no profile to restore and sat on "Checking device lock…" for good
 * (2026-09-24). These pin the two halves of the fix: the early write itself,
 * and the page events that trigger it.
 */

const KEY = "wops-query-cache";

function memoryStorage() {
  const items = new Map<string, string>();
  const writes: string[] = [];
  return {
    items,
    writes,
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, value: string) => {
      writes.push(k);
      items.set(k, value);
    },
    removeItem: (k: string) => {
      items.delete(k);
    },
  };
}

/** What the persister is handed on every cache change: a real dehydrated cache. */
function snapshot(name: string): PersistedClient {
  const client = new QueryClient();
  client.setQueryData(["myProfile"], { id: "u-1", display_name: name });
  return { timestamp: Date.now(), buster: "", clientState: dehydrate(client) };
}

describe("leaveSafePersister", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("writes the snapshot the timer is holding the moment it is asked, not a second later", async () => {
    const storage = memoryStorage();
    const { persister: p, saveNow } = leaveSafePersister(storage, KEY);
    const a = snapshot("Ana");
    await p.persistClient(a);
    // The old behaviour, and the whole bug: inside the first second, nothing.
    expect(storage.items.get(KEY)).toBeUndefined();

    saveNow();
    expect(storage.items.get(KEY)).toBe(JSON.stringify(a));
    // …and it reads back the way the next launch will read it.
    expect(await p.restoreClient()).toEqual(JSON.parse(JSON.stringify(a)));
  });

  it("writes the newest snapshot when several changes land inside one second", async () => {
    const storage = memoryStorage();
    const { persister: p, saveNow } = leaveSafePersister(storage, KEY);
    await p.persistClient(snapshot("Ana"));
    const newest = snapshot("Ana Ruiz");
    await p.persistClient(newest);

    saveNow();
    expect(storage.items.get(KEY)).toBe(JSON.stringify(newest));
  });

  it("does nothing once the timer has written, and saves a change made after that", async () => {
    const storage = memoryStorage();
    const { persister: p, saveNow } = leaveSafePersister(storage, KEY);
    const a = snapshot("Ana");
    await p.persistClient(a);
    vi.advanceTimersByTime(1_000);
    expect(storage.writes).toHaveLength(1);
    expect(storage.items.get(KEY)).toBe(JSON.stringify(a));

    // Already on disk: leaving costs no second write of the whole cache.
    saveNow();
    expect(storage.writes).toHaveLength(1);

    const b = snapshot("Ana Ruiz");
    await p.persistClient(b);
    saveNow();
    expect(storage.writes).toHaveLength(2);
    expect(storage.items.get(KEY)).toBe(JSON.stringify(b));
  });

  it("never lets the timer's later write put an older copy back", async () => {
    const storage = memoryStorage();
    const { persister: p, saveNow } = leaveSafePersister(storage, KEY);
    await p.persistClient(snapshot("Ana"));
    saveNow();
    const b = snapshot("Ana Ruiz");
    await p.persistClient(b);
    // The timer started by the first change fires with the newest snapshot.
    vi.advanceTimersByTime(1_000);
    expect(storage.items.get(KEY)).toBe(JSON.stringify(b));
  });

  it("keeps the copy already on disk when storage is full, as the timer's own write does", async () => {
    const storage = memoryStorage();
    const { persister: p, saveNow } = leaveSafePersister(storage, KEY);
    const a = snapshot("Ana");
    await p.persistClient(a);
    vi.advanceTimersByTime(1_000);
    await p.persistClient(snapshot("Ana Ruiz"));
    storage.setItem = () => {
      throw new DOMException("full", "QuotaExceededError");
    };

    expect(() => saveNow()).not.toThrow();
    expect(storage.items.get(KEY)).toBe(JSON.stringify(a));
  });
});

describe("installSaveOnLeave", () => {
  function fakePage() {
    const document = Object.assign(new EventTarget(), {
      visibilityState: "visible" as DocumentVisibilityState,
    });
    return Object.assign(new EventTarget(), { document }) satisfies LeaveEvents;
  }

  it("saves on pagehide — a reload, a navigation, the app being closed", () => {
    const page = fakePage();
    const saveNow = vi.fn();
    installSaveOnLeave(page, saveNow);
    page.dispatchEvent(new Event("pagehide"));
    expect(saveNow).toHaveBeenCalledTimes(1);
  });

  it("saves when the page is hidden, and not when it comes back", () => {
    const page = fakePage();
    const saveNow = vi.fn();
    installSaveOnLeave(page, saveNow);

    page.document.visibilityState = "hidden";
    page.document.dispatchEvent(new Event("visibilitychange"));
    expect(saveNow).toHaveBeenCalledTimes(1);

    page.document.visibilityState = "visible";
    page.document.dispatchEvent(new Event("visibilitychange"));
    expect(saveNow).toHaveBeenCalledTimes(1);
  });

  it("wires the app's own persister: a change is in localStorage the moment the page is hidden", async () => {
    window.localStorage.removeItem(KEY);
    installSaveOnLeave();
    const a = snapshot("Ana");
    await persister!.persistClient(a);
    expect(window.localStorage.getItem(KEY)).toBeNull();

    window.dispatchEvent(new Event("pagehide"));
    expect(window.localStorage.getItem(KEY)).toBe(JSON.stringify(a));
  });
});
