// @vitest-environment happy-dom
//
// The stuck-writes screen, read the way a person reads it.
//
// "Try again" replays a dead-lettered write exactly as it was written. The
// screen used to print a bare timestamp — "8/14/2026, 4:12 PM" — and left the
// person to work out in their head, standing in a warehouse, that the set-
// aside they are about to re-send was decided three days ago. Age is the one
// fact that changes the answer, so it has to be on the row, in words.
//
// Since K0.6 the screen also lists what is merely WAITING, from every queue,
// with the same age — the photo that has been "syncing" since Tuesday.
//
// This mounts the real page and reads the real DOM rather than unit-testing
// the label function alone: a formatter the screen never calls would pass a
// unit test and still leave a foreman with a timestamp.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OutboxEntry } from "../lib/offline/outbox-core";
import type { InstallOutboxRecord } from "../lib/install/installOutbox";
import type { WorkCommand } from "../lib/customWork/model";

// Every queue is held still. This test is about what the screen SAYS about
// a write, not about IndexedDB — and mocking the modules keeps the real ones
// (and their Supabase client) out of the test entirely.
const q = vi.hoisted(() => ({
  writes: [] as OutboxEntry[],
  installs: [] as InstallOutboxRecord[],
  sendingInstalls: new Set<string>(),
  work: [] as WorkCommand[],
  legacy: 0,
  sentWrites: [] as Array<{ entry: OutboxEntry; sentAt: number }>,
  /** Someone else's writes on this phone (2026-09-25). */
  held: [] as OutboxEntry[],
  sendNow: vi.fn(async () => {}),
  sendInstallsNow: vi.fn(async () => {}),
  retryWork: vi.fn(async () => true),
}));

vi.mock("../lib/offline/outbox", () => ({
  listMine: async () => q.writes,
  listHeld: async () => q.held,
  retryFailed: async () => {},
  discardFailed: async () => {},
  subscribe: () => () => {},
  sendNow: q.sendNow,
  recentlySent: () => q.sentWrites,
}));

vi.mock("../lib/install/installOutbox", () => ({
  listInstalls: async () => q.installs,
  retryFailedInstall: async () => {},
  discardFailedInstall: async () => {},
  subscribeSyncListeners: () => () => {},
  isInstallSending: (id: string) => q.sendingInstalls.has(id),
  recentlySentInstalls: () => [],
  sendInstallsNow: q.sendInstallsNow,
}));

vi.mock("../lib/install/legacyUploadQueue", () => ({
  pendingLegacyUploadCount: async () => q.legacy,
}));

vi.mock("../lib/customWork/queue", () => ({
  WORK_QUEUE_EVENT: "forge:custom-work-queue",
  readWorkQueue: () => q.work,
  retryWork: q.retryWork,
  syncWork: async () => true,
}));

vi.mock("../lib/servicing/queue", () => ({
  SERVICE_QUEUE_EVENT: "forge:service-queue",
  readServiceQueue: () => [],
  retryService: async () => {},
  syncService: async () => true,
}));

vi.mock("../lib/servicing/mediaQueue", () => ({
  pendingServiceMedia: async () => [],
  retryServiceMedia: async () => {},
  flushServiceMedia: async () => {},
}));

vi.mock("../lib/clockContext", () => ({
  useClock: () => ({ profileId: "crew-1" }),
}));

const { StuckWrites } = await import("./StuckWrites");
const { queuedAgoLabel: queuedAgo } = await import("../lib/offline/stuckRows");
const { CATALOG, translate } = await import("../lib/i18n");
const queuedAgoLabel = (when: number, now: number) =>
  queuedAgo(when, now, (key, vars) => translate(CATALOG, "en", key, vars));

const DAY = 24 * 60 * 60 * 1000;

function stuckWrite(over: Partial<OutboxEntry> = {}): OutboxEntry {
  return {
    id: "w-1",
    op: "stage_packages",
    payload: {},
    createdAt: Date.now() - 3 * DAY,
    attemptCount: 8,
    lastError: "Failed to fetch",
    status: "failed",
    nextAttemptAt: 0,
    dependsOn: null,
    hasBlob: false,
    ...over,
  };
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  q.writes = [];
  q.installs = [];
  q.sendingInstalls.clear();
  q.work = [];
  q.legacy = 0;
  q.sentWrites = [];
  q.held = [];
  q.sendNow.mockClear();
  q.sendInstallsNow.mockClear();
  q.retryWork.mockClear();
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

/** Mount the real page and return its live DOM node. */
async function mount(): Promise<HTMLElement> {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/stuck"]}>
          <StuckWrites />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  // The lists come back from promises — three queries, two of them behind
  // on-demand imports — so wait until the page has stopped saying it is
  // checking, rather than guessing at a number of ticks. Under a full-suite
  // run one tick was not enough, and the assertions read a half-loaded page.
  for (let i = 0; i < 50; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    if (!host.textContent?.includes("Checking for stuck writes")) break;
  }
  return host;
}

describe("the age wording itself", () => {
  const now = 1_800_000_000_000;

  it("says 'just now' rather than '0 min ago'", () => {
    expect(queuedAgoLabel(now - 20_000, now)).toBe("Queued just now");
  });

  it("never counts backwards when a phone's clock is behind the server's", () => {
    expect(queuedAgoLabel(now + 60_000, now)).toBe("Queued just now");
  });
});

describe("how old a stuck write is", () => {
  it("says how long a set-aside has been waiting, not just when it was made", async () => {
    q.writes = [stuckWrite({ createdAt: Date.now() - 3 * DAY })];
    const el = await mount();
    expect(el.textContent).toContain("Packages set aside");
    expect(el.textContent).toContain("Queued 3 days ago");
  });

  it("counts one day as a day, not as days", async () => {
    q.writes = [stuckWrite({ createdAt: Date.now() - 26 * 60 * 60 * 1000 })];
    const el = await mount();
    expect(el.textContent).toContain("Queued 1 day ago");
  });

  it("drops to hours and minutes for a fresh one", async () => {
    q.writes = [
      stuckWrite({ id: "w-1", createdAt: Date.now() - 3 * 60 * 60 * 1000 }),
      stuckWrite({ id: "w-2", op: "clock_in", createdAt: Date.now() - 7 * 60_000 }),
    ];
    const el = await mount();
    expect(el.textContent).toContain("Queued 3 hr ago");
    expect(el.textContent).toContain("Queued 7 min ago");
  });

  it("keeps the exact time beside the age, for a payroll argument", async () => {
    const when = Date.now() - 2 * DAY;
    q.writes = [stuckWrite({ op: "clock_in", createdAt: when })];
    const el = await mount();
    expect(el.textContent).toContain(new Date(when).toLocaleString());
  });

  // A queued install carries its time as TEXT, and the page turns it into a
  // number with `Date.parse(...) || 0` — so an unreadable stamp becomes 0, and
  // printing 0 as a date gives a confident "1/1/1970".
  //
  // Honest about what this covers: the real store cannot hand the page that
  // today. `enqueue` always stamps an ISO time, and `deserializeInstallOutbox`
  // fills a missing one in with `new Date().toISOString()`, so every record
  // that reaches this screen carries a readable stamp. The record below is
  // hand-built to reach the branch. It is a guard on the page's own
  // arithmetic, not a bug anyone has seen in the field.
  it("admits when an install has no time on it instead of claiming 1970", async () => {
    q.installs = [
      {
        id: "i-1",
        payload: { openingCode: "W1", createdAt: "" },
        step: "queued",
        installEventId: null,
        attemptCount: 8,
        lastError: "Failed to fetch",
        status: "failed",
      } as unknown as InstallOutboxRecord,
    ];
    const el = await mount();
    expect(el.textContent).toContain("Window W1 finished");
    expect(el.textContent).toContain("Queued — no time recorded");
    expect(el.textContent).not.toContain("1970");
  });

  // The screen reports the age; it does not refuse the write. Whether an old
  // write still matches the world is the server's call, where the world is.
  it("still offers Try again on an old write, and warns instead of blocking", async () => {
    q.writes = [stuckWrite({ createdAt: Date.now() - 9 * DAY })];
    const el = await mount();
    const buttons = [...el.querySelectorAll("button")].map((b) => b.textContent);
    expect(buttons).toContain("Try again");
    expect(el.textContent).toContain(
      "Try again sends a write exactly as it was written",
    );
  });
});

describe("what is merely waiting (K0.6)", () => {
  it("lists a photo that is waiting for signal, with its age and its state", async () => {
    q.writes = [
      stuckWrite({
        id: "p-1",
        op: "photo_upload",
        payload: { kind: "photo" },
        status: "queued",
        attemptCount: 0,
        lastError: null,
        createdAt: Date.now() - 2 * DAY,
      }),
    ];
    const el = await mount();
    expect(el.textContent).toContain("Waiting to send");
    expect(el.textContent).toContain("Photo");
    expect(el.textContent).toContain("Saved on this phone");
    expect(el.textContent).toContain("Queued 2 days ago");
    // Not stuck: no Try again, no Throw away — it is going to send itself.
    const buttons = [...el.querySelectorAll("button")].map((b) => b.textContent);
    expect(buttons).not.toContain("Try again");
    expect(buttons).not.toContain("Throw away");
    expect(el.textContent).not.toContain("Nothing stuck");
  });

  it("says Sending for the one a drain is attempting, and names a memo as a memo", async () => {
    q.writes = [
      stuckWrite({
        id: "m-1",
        op: "photo_upload",
        payload: { kind: "voice_memo" },
        status: "sending",
        attemptCount: 0,
        lastError: null,
        createdAt: Date.now() - 60_000,
      }),
    ];
    const el = await mount();
    expect(el.textContent).toContain("Voice memo");
    expect(el.textContent).toContain("Sending…");
  });

  it("lists a finished unit still waiting, and a work change with its review door", async () => {
    q.installs = [
      {
        id: "i-2",
        payload: { openingCode: "W7", createdAt: new Date(Date.now() - 3 * 60_000).toISOString() },
        step: "queued",
        installEventId: null,
        attemptCount: 1,
        lastError: "Failed to fetch",
        status: "pending",
      } as unknown as InstallOutboxRecord,
    ];
    q.work = [{ id: "c-1", userId: "crew-1", action: "start", data: {} }];
    const el = await mount();
    expect(el.textContent).toContain("Window W7 finished");
    expect(el.textContent).toContain("Queued 3 min ago");
    expect(el.textContent).toContain("Work change");
    const links = [...el.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(links).toContain("/current-work");
  });

  it("Send now gives every queue one attempt this instant", async () => {
    q.writes = [stuckWrite({ id: "p-1", op: "photo_upload", status: "queued", lastError: null })];
    const el = await mount();
    const button = [...el.querySelectorAll("button")].find((b) => b.textContent === "Send now");
    expect(button).toBeTruthy();
    await act(async () => {
      button!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(q.sendNow).toHaveBeenCalledTimes(1);
    expect(q.sendInstallsNow).toHaveBeenCalledTimes(1);
  });

  it("shows what reached the server this session as saved in Forge", async () => {
    q.sentWrites = [
      {
        entry: stuckWrite({ id: "done", op: "clock_in", status: "queued", lastError: null }),
        sentAt: Date.now() - 30_000,
      },
    ];
    const el = await mount();
    expect(el.textContent).toContain("Saved in Forge");
    expect(el.textContent).toContain("Clock in");
    // Nothing is waiting or stuck, and the page says so as well.
    expect(el.textContent).toContain("Nothing stuck");
  });

  it("shows what is still in the old upload store as waiting to move", async () => {
    q.legacy = 2;
    const el = await mount();
    expect(el.textContent).toContain("Old uploads still to move: 2");
    expect(el.textContent).toContain("Saved on this phone");
  });

  it("a refused work change offers Try again, which retries its own queue", async () => {
    q.work = [{ id: "c-1", userId: "crew-1", action: "stop", data: {}, error: "Shift already closed." }];
    const el = await mount();
    expect(el.textContent).toContain("Needs you");
    expect(el.textContent).toContain("Shift already closed.");
    const button = [...el.querySelectorAll("button")].find((b) => b.textContent === "Try again");
    await act(async () => {
      button!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(q.retryWork).toHaveBeenCalledWith("crew-1");
    // Never Throw away here: that queue exports before it removes.
    expect([...el.querySelectorAll("button")].map((b) => b.textContent)).not.toContain("Throw away");
  });
});

describe("someone else's work on this phone", () => {
  it("is shown as waiting for that person, with nothing to retry or throw away — and never as 'Nothing stuck'", async () => {
    q.held = [
      stuckWrite({ id: "h-1", op: "clock_in", status: "queued", attemptCount: 0, lastError: null, ownerId: "someone-else" }),
    ];
    const el = await mount();
    expect(el.textContent).toContain("Saved by someone else on this phone");
    expect(el.textContent).toContain("Waiting for the person who saved these to sign in");
    const held = el.querySelector('[data-testid="stuck-held"]')!;
    expect(held.textContent).toContain("Clock in");
    expect(held.querySelectorAll("button")).toHaveLength(0);
    expect(el.textContent).not.toContain("Nothing stuck");
  });
});
