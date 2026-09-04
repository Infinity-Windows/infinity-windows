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
  /** Package ids the fake server has marked received (ticket 15). */
  received: [] as string[][],
  /** Totals set_mark_part_total was asked for (the late package). */
  grown: [] as number[],
  /** Marks add_project_mark put on a schedule (the door in the wall). */
  scheduled: [] as string[],
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

vi.mock("../../lib/warehouse/warehouseCards", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../lib/warehouse/warehouseCards")>();
  return {
    ...real,
    addProjectMark: async (projectId: string, mark: string) => {
      if (server.offline) throw new TypeError("Failed to fetch");
      server.scheduled.push(`${projectId}:${mark}`);
    },
  };
});

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
    // The truck-side confirm (ticket 15). Records what arrived; the offline
    // path is already proven for every op by the round-trip suite, so this
    // test runs it with bars.
    receiveMintedPackages: async (ids: string[]) => {
      if (server.offline) throw new TypeError("Failed to fetch");
      server.received.push(ids);
      return ids.length;
    },
    // Growing a window's count (the late package). Online-only by design.
    setMarkPartTotal: async (input: { total: number }) => {
      if (server.offline) throw new TypeError("Failed to fetch");
      server.grown.push(input.total);
      return 3;
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

/** Pre-labeled packages the arrival section shows; tests set this. */
let seedMinted: unknown[] = [];

/** The job's schedule; window 16 is on it so the plain tag flow just works. */
let seedSchedule: { project_id: string; mark_code: string }[] = [
  { project_id: "job-1", mark_code: "16" },
];
let seedRole = "installer";

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
  qc.setQueryData(["storagePackages"], seedMinted);
  qc.setQueryData(["scheduledMarks", ["job-1"]], seedSchedule);
  qc.setQueryData(["myRealProfile"], { id: "me", role: seedRole });

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

/** The sticker codes the worksheet's lines are currently holding. In the
 * batch flow this IS the observable "free roll": lines auto-draw the next
 * free stickers, so what they show is what the screen still believes is
 * offerable. */
function lineCodes(el: HTMLElement): string[] {
  return [...el.querySelectorAll("[data-worksheet] [data-line]")].map((b) => {
    const code = b.querySelector("span.muted + span, span[style*='monospace']");
    return (code?.textContent ?? "").trim();
  });
}

/** The stickers the screen says are spent but not sent. */
function waitingPills(el: HTMLElement): HTMLButtonElement[] {
  return [...el.querySelectorAll<HTMLButtonElement>('[data-roll="waiting"] button')];
}

/** Anywhere on the page this code is still offered as usable: on a live
 * worksheet line, or as an enabled pill. Disabled waiting pills don't count —
 * they exist to say "spoken for". */
function offered(el: HTMLElement, code: string): number {
  const onLines = lineCodes(el).filter((c) => c === code).length;
  const asButtons = [...el.querySelectorAll("button")].filter(
    (b) => (b.textContent ?? "").trim() === code && !b.disabled,
  ).length;
  return onLines + asButtons;
}

function click(node: Element | null | undefined) {
  if (!node) throw new Error("nothing to click");
  act(() => {
    node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

/** Drive the worksheet the way a thumb does: the line already holds the next
 * free sticker, so tagging is typing the window number and hitting Submit. */
async function tag(el: HTMLElement, expectCode?: string) {
  if (expectCode) {
    expect(lineCodes(el)[0], "the line is not holding the expected sticker").toBe(
      expectCode,
    );
  }
  const mark = el.querySelector<HTMLInputElement>('input[aria-label="Window number"]');
  if (!mark) throw new Error("no window-number input on the page");
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!;
    setter.call(mark, "16");
    mark.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const go = [...el.querySelectorAll("button")].find((b) =>
    /^Tag \d+ package/.test((b.textContent ?? "").trim()),
  );
  if (!go) throw new Error("no submit button in a taggable state");
  click(go);
  await settle();
}

describe("a sticker tagged with no signal", () => {
  it("leaves the roll of free stickers", async () => {
    const { el } = await mount();
    // The single line auto-drew the first free sticker.
    expect(lineCodes(el)).toEqual(["K4T9QP"]);

    await tag(el, "K4T9QP");

    // The next worksheet draws the NEXT free sticker — the spent one is gone.
    expect(lineCodes(el)).toEqual(["M7X2LR"]);
  });

  it("cannot be picked a second time from anywhere on the page", async () => {
    // The whole reason this matters: two taps on one sticker bind it to two
    // packages, and the queue's drain order decides which one wins.
    const { el } = await mount();
    await tag(el, "K4T9QP");

    expect(offered(el, "K4T9QP")).toBe(0);
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

    expect(lineCodes(el)).toEqual(["M7X2LR"]);
    expect(offered(el, "K4T9QP")).toBe(0);
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
    expect(lineCodes(el)).toEqual(["M7X2LR"]);
    expect(offered(el, "K4T9QP")).toBe(0);
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
    expect(lineCodes(el)).toEqual(["M7X2LR"]);
    expect(offered(el, "K4T9QP")).toBe(0);
  });
});

describe("a sticker tagged with bars", () => {
  it("leaves the roll without ever claiming to be waiting", async () => {
    server.offline = false;
    const { el } = await mount();

    await tag(el, "K4T9QP");
    await settle();

    expect(lineCodes(el)).toEqual(["M7X2LR"]);
    expect(el.textContent).not.toContain("not sent yet");
  });
});

describe("pre-labeled packages at the truck (ticket 15)", () => {
  it("shows the expected labels and receives the tapped ones", async () => {
    seedMinted = [
      {
        id: "m1",
        serial: "PKG-000201",
        short_code: "AAAAAA",
        status: "minted",
        project_id: "job-1",
        part_index: 1,
        part_total: 2,
        package_marks: [{ mark_code: "16" }],
      },
      {
        id: "m2",
        serial: "PKG-000202",
        short_code: "BBBBBB",
        status: "minted",
        project_id: "job-1",
        part_index: 2,
        part_total: 2,
        package_marks: [{ mark_code: "16" }],
      },
    ];
    server.offline = false;
    try {
      const m = await mount();
      const pills = [...m.el.querySelectorAll("button")].filter((b) =>
        /W16 · [12] of 2/.test(b.textContent ?? ""),
      );
      expect(pills.length).toBe(2);

      click(pills[0]);
      const go = [...m.el.querySelectorAll("button")].find((b) =>
        (b.textContent ?? "").startsWith("Arrived — receive 1"),
      );
      expect(go, "no Arrived button after picking a package").toBeTruthy();
      click(go!);
      // The mutation resolves a tick later; let the write reach the fake server.
      await act(async () => {
        await Promise.resolve();
      });
      expect(
        server.received.some((ids) => JSON.stringify(ids) === JSON.stringify(["m1"])),
        "the receive never reached the server",
      ).toBe(true);
    } finally {
      seedMinted = [];
      server.offline = true;
      server.received = [];
    }
  });

  it("shows nothing when nothing is expected — the blank roll is the whole screen", async () => {
    const m = await mount();
    expect(m.el.textContent).not.toContain("Pre-labeled");
  });
});

describe("the worksheet (owner spec, 2026-08-18)", () => {
  it("three pieces make three lines that all rename when the window is typed", async () => {
    const { el } = await mount();
    const count = el.querySelector<HTMLInputElement>('input[aria-label="How many pieces"]')!;
    act(() => {
      const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
      set.call(count, "3");
      count.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await settle();
    // Two blanks on the roll, three lines: the third says the roll is dry
    // instead of silently tagging fewer than asked.
    expect(el.querySelectorAll("[data-worksheet] [data-line]").length).toBe(3);
    expect(el.textContent).toContain("no sticker — roll is dry");

    const mark = el.querySelector<HTMLInputElement>('input[aria-label="Window number"]')!;
    act(() => {
      const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
      set.call(mark, "16");
      mark.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await settle();
    expect(el.textContent).toContain("#16 1/3");
    expect(el.textContent).toContain("#16 2/3");
    expect(el.textContent).toContain("#16 3/3");
    // A dry line blocks submit in words rather than shrinking the batch.
    expect(el.textContent).toContain("A line has no sticker");
  });

  it("a tapped line glows and takes the piece pick", async () => {
    const { el } = await mount();
    const line = el.querySelector<HTMLButtonElement>('[data-line="1"]')!;
    click(line);
    expect(line.getAttribute("style") ?? "").toContain("var(--accent-line)");
    const glass = [...el.querySelectorAll("button")].find(
      (b) => (b.textContent ?? "").trim() === "Glass",
    );
    expect(glass, "no piece pills for the glowing line").toBeTruthy();
    click(glass!);
    expect(el.textContent).toContain("· Glass");
  });

  it("the late package: typing a window that exists continues its numbering and grows the count", async () => {
    // Window 16 is already tagged as 3-of-3 on this job; one more box shows up.
    seedMinted = [1, 2, 3].map((i) => ({
      id: `old-${i}`,
      serial: `PKG-0009${i}`,
      status: "received",
      project_id: "job-1",
      part_index: i,
      part_total: 3,
      package_marks: [{ mark_code: "16" }],
    }));
    server.offline = false;
    try {
      const { el } = await mount();
      await tag(el, "K4T9QP");
      expect(el.textContent ?? "").not.toContain("already has"); // reset after submit
      // The growth ran first, to 4, then the bind carried 4/4.
      expect(server.grown).toEqual([4]);
    } finally {
      seedMinted = [];
      server.offline = true;
      server.grown = [];
    }
  });
});

describe("the schedule's door (owner report, 2026-08-18)", () => {
  it("a foreman typing an unscheduled window gets the one-tap add", async () => {
    seedRole = "foreman";
    server.offline = false;
    try {
      const { el } = await mount();
      const mark = el.querySelector<HTMLInputElement>('input[aria-label="Window number"]')!;
      act(() => {
        const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
        set.call(mark, "6");
        mark.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await settle();
      expect(el.textContent).toContain("Window 6 isn’t on this job’s schedule yet");
      const add = [...el.querySelectorAll("button")].find((b) =>
        (b.textContent ?? "").includes("Add window 6"),
      );
      expect(add, "no add-to-schedule button for a foreman").toBeTruthy();
      click(add!);
      await settle();
      expect(server.scheduled).toEqual(["job-1:6"]);
    } finally {
      seedRole = "installer";
      server.offline = true;
      server.scheduled = [];
    }
  });

  // Inverted with ADR-0007 (owner call, 2026-09-04). This used to assert that
  // an installer got a sentence naming a foreman instead of the button. The
  // person at the truck holding a package for a window the plans missed is
  // exactly who should add it, so they get the handle now — and
  // add_project_mark was opened in the same migration so the button works.
  it("an installer gets the handle too, not a note about who holds it", async () => {
    const { el } = await mount();
    const mark = el.querySelector<HTMLInputElement>('input[aria-label="Window number"]')!;
    act(() => {
      const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
      set.call(mark, "6");
      mark.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await settle();
    expect(el.textContent).not.toContain("A foreman can add it");
    expect(
      [...el.querySelectorAll("button")].some((b) =>
        (b.textContent ?? "").includes("Add window 6"),
      ),
    ).toBe(true);
  });

  it("a scheduled window says nothing — the door only shows at the wall", async () => {
    const { el } = await mount();
    const mark = el.querySelector<HTMLInputElement>('input[aria-label="Window number"]')!;
    act(() => {
      const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
      set.call(mark, "16");
      mark.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await settle();
    expect(el.textContent).not.toContain("isn’t on this job’s schedule");
  });
});
