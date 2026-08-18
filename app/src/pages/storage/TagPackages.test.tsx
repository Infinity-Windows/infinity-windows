// @vitest-environment happy-dom
//
// The tag screen, driven the way somebody standing at a truck drives it.
//
// The roll of blank stickers on this screen is the only answer the app has to
// "which stickers are still free". It is drawn from the server's blank list,
// and a tag made inside a conex never reaches the server — so the sticker
// somebody had just stuck on a crate stayed in the roll, offered as free, for
// the rest of the session. The screen said "assigned" in a toast and went on
// listing it. Worse: the same sticker could be tagged twice, to two different
// packages, and which tap won was decided by the order the queue drained.
// Binding is permanent; there is no way back.
//
// So this test does not call a helper. It mounts the real page, lets the real
// offline write path queue a tag through the real outbox, and reads the roll
// off the real DOM. Only the server is a fake — a tiny one that holds the
// blank list and refuses to answer while the phone is in the box.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoragePackage } from "../../lib/storage";
import { TagPackages } from "./TagPackages";

/** The fake warehouse: what is blank, what has been bound, and whether the
 * phone has bars. Shared with the module mock below through vi.hoisted. */
const server = vi.hoisted(() => ({
  offline: true,
  bound: new Set<string>(),
}));

const BLANKS: StoragePackage[] = [
  blankRow("blk-1", "PKG-000001", "K4T9QP"),
  blankRow("blk-2", "PKG-000002", "M7X2LR"),
];

function blankRow(id: string, serial: string, code: string): StoragePackage {
  return {
    id,
    serial,
    short_code: code,
    status: "blank",
    project_id: null,
    category: null,
    note: null,
    delivery_id: null,
    container_id: null,
    location_id: null,
    bound_at: null,
    bound_by: null,
    created_at: "2026-08-18T00:00:00Z",
  };
}

vi.mock("../../lib/storage", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../lib/storage")>();
  return {
    ...real,
    // The server's blank list. A bound sticker stops being blank, which is the
    // only way this screen ever hears that a tag landed.
    listBlankPackages: async () =>
      BLANKS.filter((b) => !server.bound.has(b.id)),
    // Delivery grouping is a nice-to-have and the page already survives it
    // failing; held still so nothing reaches for a network.
    ensureDelivery: async () => {
      throw new TypeError("Failed to fetch");
    },
    bindPackage: async (input: { packageId: string }) => {
      // Exactly what supabase-js does with no bars, which is what the offline
      // write path reads to decide "queue" instead of "tell them they're wrong".
      if (server.offline) throw new TypeError("Failed to fetch");
      server.bound.add(input.packageId);
      return { ...BLANKS[0], id: input.packageId, status: "received" };
    },
  };
});

/**
 * The real outbox, with a handle on the one notification that matters here.
 *
 * `subscribeSynced` is how the drainer tells the app "that went up" — it fires
 * after a drain that actually sent something, and it is what the clock and the
 * photo feed listen to before refetching the server's version. Everything else
 * in the module is the real thing, enqueue included, so the tag below still
 * queues for real; this only lets the test be the drainer.
 */
const synced = vi.hoisted(() => ({ listeners: new Set<() => void>() }));

vi.mock("../../lib/offline/outbox", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../lib/offline/outbox")>();
  return {
    ...real,
    subscribeSynced: (cb: () => void) => {
      synced.listeners.add(cb);
      const off = real.subscribeSynced(cb);
      return () => {
        synced.listeners.delete(cb);
        off();
      };
    },
  };
});

const JOBS = [{ id: "job-1", job_code: "BLACK22", name: "Black Desert" }];

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  server.offline = true;
  server.bound.clear();
  synced.listeners.clear();
  localStorage.clear();
  // Inside the conex, for real: the outbox asks this before it tries to send,
  // so without it the queued tag chases a server the moment it is written.
  Object.defineProperty(window.navigator, "onLine", {
    get: () => false,
    configurable: true,
  });
  // The job the phone was last used on. The page remembers it by itself; this
  // is only here so the Assign button is reachable without a second tap.
  localStorage.setItem("infinity.storage.lastJob", "job-1");
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

interface Mounted {
  el: HTMLElement;
  qc: QueryClient;
}

async function mount(): Promise<Mounted> {
  const qc = new QueryClient({
    defaultOptions: {
      queries: {
        // What lib/queryClient.ts ships: a read is attempted even with no
        // bars, because the cache is the fallback, not the gate. The rest of
        // this block is the test holding the world still — nothing refetches
        // unless this file asks it to.
        networkMode: "offlineFirst",
        retry: false,
        gcTime: Infinity,
        staleTime: Infinity,
        refetchOnMount: false,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
      },
      // What the app itself runs (lib/queryClient.ts): a write is attempted
      // once even with no bars, because deciding to queue REQUIRES trying.
      mutations: { networkMode: "offlineFirst", retry: 0 },
    },
  });
  qc.setQueryData(["projects"], JOBS);
  qc.setQueryData(["markSpecs", "job-1"], []);

  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/storage/tag"]}>
          <TagPackages />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await settle();
  return { el: host, qc };
}

/** Let the queries, the write and the outbox finish what they started. */
async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

/** The stickers the screen is offering as still free. */
function freeRoll(el: HTMLElement): string[] {
  return [...el.querySelectorAll('[data-roll="free"] button')].map((b) =>
    (b.textContent ?? "").trim(),
  );
}

/** The stickers the screen says are spent but not sent. */
function waitingPills(el: HTMLElement): HTMLButtonElement[] {
  return [...el.querySelectorAll<HTMLButtonElement>('[data-roll="waiting"] button')];
}

/** Anything anywhere on the page a thumb could still press to pick a sticker. */
function tappable(el: HTMLElement, code: string): HTMLButtonElement[] {
  return [...el.querySelectorAll("button")].filter(
    (b) => (b.textContent ?? "").trim() === code && !b.disabled,
  );
}

function click(node: Element | null | undefined) {
  if (!node) throw new Error("nothing to click");
  act(() => {
    node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

/** Tap a sticker in the roll, then tap Assign, the way the screen is used. */
async function tag(el: HTMLElement, code: string) {
  click(tappable(el, code)[0]);
  const assign = [...el.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").startsWith("Assign"),
  );
  click(assign);
  await settle();
}

describe("a sticker tagged with no signal", () => {
  it("leaves the roll of free stickers", async () => {
    const { el } = await mount();
    expect(freeRoll(el)).toEqual(["K4T9QP", "M7X2LR"]);

    await tag(el, "K4T9QP");

    expect(freeRoll(el)).toEqual(["M7X2LR"]);
  });

  it("cannot be picked a second time from anywhere on the page", async () => {
    // The whole reason this matters: two taps on one sticker bind it to two
    // packages, and the queue's drain order decides which one wins.
    const { el } = await mount();
    await tag(el, "K4T9QP");

    expect(tappable(el, "K4T9QP")).toHaveLength(0);
  });

  it("still reads as spoken for, and says the write is not up yet", async () => {
    const { el } = await mount();
    await tag(el, "K4T9QP");

    const pills = waitingPills(el);
    expect(pills.map((b) => b.textContent?.trim())).toContain("K4T9QP");
    expect(pills.every((b) => b.disabled)).toBe(true);
    expect(el.textContent).toContain(
      "1 sticker is assigned and saved on this phone, not sent yet",
    );
    expect(el.textContent).toContain("It goes up on its own when you have signal");
  });

  it("is still gone from the roll after the screen is closed and reopened", async () => {
    // A conex is a metal box. The app gets closed and reopened in there, and
    // the server still calls this sticker blank the whole time.
    const first = await mount();
    await tag(first.el, "K4T9QP");
    act(() => root?.unmount());
    host?.remove();

    const { el } = await mount();

    expect(freeRoll(el)).toEqual(["M7X2LR"]);
    expect(tappable(el, "K4T9QP")).toHaveLength(0);
    expect(el.textContent).toContain("saved on this phone, not sent yet");
  });

  it("stops being called waiting once its write goes up — and never comes back", async () => {
    const { el, qc } = await mount();
    await tag(el, "K4T9QP");

    // The bars come back, the queue drains, the sticker stops being blank.
    server.bound.add("blk-1");
    await act(async () => {
      await qc.refetchQueries({ queryKey: ["storageBlanks"] });
    });
    await settle();

    expect(el.textContent).not.toContain("not sent yet");
    expect(freeRoll(el)).toEqual(["M7X2LR"]);
    expect(tappable(el, "K4T9QP")).toHaveLength(0);
  });

  it("stops being called waiting the moment the queue reports it sent, with nobody touching the screen", async () => {
    // The one thing nothing else on this page does: ask again. Somebody walks
    // out of the conex still holding the screen — they do not tap, they do not
    // leave the tab and come back. The drainer sends the tag and says so. If
    // the page is not listening, "saved on this phone, not sent yet" sits there
    // being false about a write that already landed.
    const { el } = await mount();
    await tag(el, "K4T9QP");
    expect(el.textContent).toContain("not sent yet");

    server.offline = false;
    server.bound.add("blk-1");
    await act(async () => {
      for (const cb of synced.listeners) cb();
    });
    await settle();

    expect(el.textContent).not.toContain("not sent yet");
    expect(freeRoll(el)).toEqual(["M7X2LR"]);
    expect(tappable(el, "K4T9QP")).toHaveLength(0);
  });
});

describe("a sticker tagged with bars", () => {
  it("leaves the roll without ever claiming to be waiting", async () => {
    server.offline = false;
    const { el } = await mount();

    await tag(el, "K4T9QP");
    await settle();

    expect(freeRoll(el)).toEqual(["M7X2LR"]);
    expect(el.textContent).not.toContain("not sent yet");
  });
});
